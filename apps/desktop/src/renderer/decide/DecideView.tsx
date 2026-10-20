import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { CaretLeft, CaretRight, CheckCircle, GitBranch } from '@phosphor-icons/react';
import { errMsg } from '../api';
import { useStore } from '../store';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { askAgent, askedWords, showAgent } from '../lib/actions';
import {
  Button,
  Disclosure,
  Empty,
  IconButton,
  Notice,
  Skeleton,
  State,
  relativeTime,
  shortId,
} from '../ui/kit';
import {
  changeBaseMoved,
  decidable,
  detailPhase,
  fingerprint,
  listVersion,
  needsYou,
  nextAfterDecision,
  phaseLabel,
  phaseTone,
  queueList,
  supersedes,
  waitingOnAgent,
  type Phase,
  type ProposalDetail,
  type QueueFilter,
  type ReviewProposal,
} from './model';
import {
  decisionVerdict,
  layerName,
  renderProblem,
  type DecisionContext,
  type DecisionOp,
  type ShownProposal,
} from './guard';
import { isLayerOpen, topmostLayer } from '../lib/layers';
import {
  clearHandoff,
  confirmRead,
  forgetNotes,
  notesFor,
  projectReview,
  readCheck,
  recordDecision,
  setQueue,
  updateNotes,
} from './memory';
import { handoffText, outcomeWords, rebaseText, recordOf, type DecisionOutcome } from './handoff';
import { quietCmd } from './io';
import { scopeRefusal, type ReviewStatus } from './CadReview';
import { forgetDetail, useProposalDetail } from './useProposalDetail';
import { ChangeSection } from './ChangeSection';
import { DecisionBar, type Feedback } from './DecisionBar';
import { ImpactRail } from './ImpactRail';
import { Queue } from './Queue';

const OP: Record<DecisionOp, string> = {
  approve: 'proposal.approve',
  reject: 'proposal.reject',
  request_changes: 'proposal.request_changes',
};
const OUTCOME: Record<DecisionOp, DecisionOutcome> = {
  approve: 'approved',
  reject: 'rejected',
  request_changes: 'changes_requested',
};
const BY: Record<string, string> = { agent: 'the agent', user: 'you', system: 'the system' };

function typing(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return (
    !!el &&
    (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) ||
      el.isContentEditable ||
      !!el.closest?.('.xterm'))
  );
}

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Scopes to send with an approval: only ones the core still reports, and still acceptable. */
function acceptedScopes(d: ProposalDetail, ticked: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const c of d.changes) {
    const hash = c.verification?.evidenceHash;
    if (hash && ticked[c.change.artifactId] === hash && !scopeRefusal(c.verification))
      out[c.change.artifactId] = hash;
  }
  return out;
}

function PhaseNotice({
  phase,
  detail,
  proposals,
  running,
  onSelect,
  onRebase,
}: {
  phase: Phase;
  detail: ProposalDetail;
  proposals: ReviewProposal[];
  running: boolean;
  onSelect: (id: string) => void;
  onRebase: () => void;
}) {
  switch (phase.kind) {
    case 'base_moved':
      return (
        <Notice
          tone="warn"
          action={
            running ? (
              <Button size="sm" onClick={onRebase}>
                Ask the agent to rebase
              </Button>
            ) : (
              <Button size="sm" onClick={showAgent}>
                Open the agent
              </Button>
            )
          }
        >
          <strong>Base moved.</strong> A baseline changed after this was proposed, so approving it
          would overwrite newer work. Ask the agent to rebuild it on the current baseline, or reject
          it.{running ? '' : ' Start the agent to ask it.'}
        </Notice>
      );
    case 'waiting_on_agent':
      return (
        <Notice>
          <strong>Waiting on the agent.</strong> You asked for changes
          {phase.request ? `: “${phase.request}”` : '.'} Its replacement arrives as a new proposal
          and retires this one.
        </Notice>
      );
    case 'superseded': {
      const replacement = phase.by ? proposals.find((p) => p.id === phase.by) : undefined;
      return (
        <Notice
          action={
            phase.by ? (
              <Button size="sm" onClick={() => onSelect(phase.by!)}>
                Open the replacement
              </Button>
            ) : undefined
          }
        >
          <strong>Superseded</strong>
          {replacement
            ? ` by “${replacement.reason}”`
            : phase.by
              ? ` by proposal ${shortId(phase.by)}`
              : ''}
          . It stays in the record and can no longer be decided.
        </Notice>
      );
    }
    case 'decided':
      return (
        <div className="decide-outcome">
          <State state={detail.proposal.state} label={phaseLabel(phase)} tone={phaseTone(phase)} />
          {phase.at && (
            <time dateTime={phase.at} title={new Date(phase.at).toLocaleString()}>
              {relativeTime(phase.at)}
            </time>
          )}
          <p>{phase.rationale ? `“${phase.rationale}”` : 'No rationale was recorded.'}</p>
        </div>
      );
    case 'conflicted':
      return (
        <Notice tone="warn">
          The core marked this proposal conflicted{phase.reason ? `: ${phase.reason}` : ''}. It can
          no longer be approved.
        </Notice>
      );
    case 'cancelled':
      return <Notice>Cancelled. It stays in the record.</Notice>;
    case 'other':
      return <Notice>The core reports this proposal as {phase.state.replaceAll('_', ' ')}.</Notice>;
    default:
      return null;
  }
}

/** Zoom level 2: one proposal, its evidence, its consequences, and the person's decision. */
export function DecideView() {
  const view = useStore((s) => s.view);
  const proposals: ReviewProposal[] = useStore((s) => s.proposals);
  const artifacts = useStore((s) => s.artifacts);
  const readOnly = useStore((s) => s.readOnly);
  const projectId = useStore((s) => s.projectId);
  const running = useStore((s) => s.session?.state === 'running');
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [busy, setBusy] = useState<DecisionOp | null>(null);
  const busyRef = useRef(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [done, setDone] = useState(false);
  const [showHandoff, setShowHandoff] = useState(false);
  const [geometry, setGeometry] = useState<Record<string, ReviewStatus>>({});

  const review = projectId ? projectReview(projectId) : null;
  const filter: QueueFilter = review?.filter ?? 'open';
  const list = useMemo(() => queueList(proposals, filter), [proposals, filter]);
  const selectedOf = useCallback(
    (id: string) => artifacts.find((a) => a.artifact.id === id)?.artifact.selectedRevisionId,
    [artifacts],
  );

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const doneRef = useRef<HTMLDivElement>(null);
  const sections = useRef<(HTMLElement | null)[]>([]);
  const pendingFocus = useRef<'heading' | 'done' | null>('heading');

  const select = useCallback(
    (id: string | null) => {
      if (!projectId) return;
      setQueue(projectId, { selected: id });
      setDone(false);
      setFeedback(null);
      rerender();
    },
    [projectId],
  );
  const setFilter = (f: QueueFilter) => {
    if (!projectId) return;
    const next = queueList(proposals, f);
    const current = review?.selected;
    setQueue(projectId, {
      filter: f,
      selected: current && next.some((p) => p.id === current) ? current : (next[0]?.id ?? null),
    });
    setDone(false);
    rerender();
  };

  // A deep link picks its proposal once, when it arrives. Deciding never flips the queue.
  const proposalsRef = useRef(proposals);
  proposalsRef.current = proposals;
  const requested = view.level === 'decide' ? view.proposalId : null;
  useEffect(() => {
    if (!projectId || !requested) return;
    const open = needsYou(proposalsRef.current).some((p) => p.id === requested);
    setQueue(projectId, { selected: requested, ...(open ? {} : { filter: 'all' }) });
    setDone(false);
    setFeedback(null);
    pendingFocus.current = 'heading';
    rerender();
  }, [projectId, requested]);

  const selected = review?.selected ?? null;
  const activeId = done
    ? null
    : selected && proposals.some((p) => p.id === selected)
      ? selected
      : (list[0]?.id ?? null);
  // Whatever is on screen stays on screen: a new arrival at the top of the queue never replaces it.
  useEffect(() => {
    if (!projectId || !activeId) return;
    const chosen = projectReview(projectId).selected;
    if (!chosen || !proposalsRef.current.some((p) => p.id === chosen))
      setQueue(projectId, { selected: activeId });
  }, [projectId, activeId]);
  const entry = proposals.find((p) => p.id === activeId);
  const evidenceVersion = useStore(
    (s) =>
      `${s.baselineVersion}:${entry?.changes.map((c) => s.evidenceVersions[c.artifactId] ?? 0).join(',') ?? ''}`,
  );
  const version = `${entry ? listVersion(entry, selectedOf) : 'absent'}:${evidenceVersion}`;
  const { detail, load, error, reload } = useProposalDetail(projectId, activeId, version);
  const fp = detail ? fingerprint(detail) : null;
  const phase = detail ? detailPhase(detail) : null;
  const notes = projectId && activeId ? notesFor(projectId, activeId) : null;
  // Compared on every render against the version the person read; the first read is recorded.
  // While a decision is in flight the screen is about to move on; nothing changed under the person.
  const changed =
    projectId && detail && !busy ? readCheck(projectId, detail, load === 'ready') : [];
  const patchNotes = (patch: Parameters<typeof updateNotes>[2]) => {
    if (!projectId || !activeId) return;
    updateNotes(projectId, activeId, patch);
    rerender();
  };

  // What the page shows right now, recorded after each commit. ⌘↵ acts only on this.
  const shownRef = useRef<ShownProposal | null>(null);
  useLayoutEffect(() => {
    if (!detail || !fp || detail.proposal.id !== activeId) {
      shownRef.current = null;
      return;
    }
    if (shownRef.current?.proposalId !== detail.proposal.id || shownRef.current.fingerprint !== fp)
      shownRef.current = { proposalId: detail.proposal.id, fingerprint: fp, at: Date.now() };
  });

  // Scroll position per proposal, restored when it comes back on screen.
  const restoredFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !detail || !projectId || restoredFor.current === detail.proposal.id) return;
    restoredFor.current = detail.proposal.id;
    el.scrollTop = notesFor(projectId, detail.proposal.id).scrollTop;
  });

  // Focus: the proposal's heading when it arrives, the done state when nothing is left.
  useLayoutEffect(() => {
    if (
      pendingFocus.current === 'heading' &&
      headingRef.current &&
      detail?.proposal.id === activeId
    ) {
      if (!typing(document.activeElement)) headingRef.current.focus({ preventScroll: true });
      pendingFocus.current = null;
    } else if (pendingFocus.current === 'done' && doneRef.current) {
      doneRef.current.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  });

  const onStatus = useCallback((revisionId: string, status: ReviewStatus) => {
    setGeometry((g) =>
      JSON.stringify(g[revisionId]) === JSON.stringify(status) ? g : { ...g, [revisionId]: status },
    );
  }, []);

  const context = (op: DecisionOp, via: 'pointer' | 'keyboard'): DecisionContext => ({
    op,
    via,
    readOnly,
    busy: busyRef.current || !!busy,
    shown: shownRef.current,
    loaded:
      detail && fp && phase ? { proposalId: detail.proposal.id, fingerprint: fp, phase } : null,
    load,
    renderProblem: detail ? renderProblem(detail, geometry) : 'The proposal is still loading.',
    unreadChange: changed.length > 0,
    rationale: notes?.rationale ?? '',
  });
  // The bar is drawn from this render, so its buttons judge what this render shows.
  const drawn = (op: DecisionOp) =>
    decisionVerdict({
      ...context(op, 'pointer'),
      shown: detail && fp ? { proposalId: detail.proposal.id, fingerprint: fp, at: 0 } : null,
    });
  const verdicts = {
    approve: drawn('approve'),
    reject: drawn('reject'),
    request_changes: drawn('request_changes'),
  };

  const act = async (
    op: DecisionOp,
    via: 'pointer' | 'keyboard',
    key?: Partial<DecisionContext>,
  ) => {
    if (!projectId || !detail) return;
    const verdict = decisionVerdict({ ...context(op, via), ...key, now: Date.now() });
    if (!verdict.ok) {
      if (!verdict.silent) setFeedback({ tone: 'warn', text: verdict.reason });
      return;
    }
    const target = detail;
    const id = target.proposal.id;
    const order = list.map((p) => p.id);
    const note = notesFor(projectId, id);
    const scopes = op === 'approve' ? acceptedScopes(target, note.scopes) : {};
    busyRef.current = true;
    setBusy(op);
    setFeedback(null);
    try {
      await quietCmd(
        OP[op],
        {
          proposalId: id,
          rationale: note.rationale.trim(),
          ...(Object.keys(scopes).length ? { verificationEvidence: scopes } : {}),
        },
        { projectId, idempotencyKey: crypto.randomUUID() },
      );
    } catch (e) {
      busyRef.current = false;
      setBusy(null);
      setFeedback({ tone: 'err', text: errMsg(e) });
      // The core may know something this screen does not (a moved base): read both again.
      void useStore
        .getState()
        .refreshProposals()
        .catch(() => {});
      reload();
      return;
    }
    const scopeTitles = target.changes
      .filter((c) => scopes[c.change.artifactId])
      .map((c) => c.artifact?.title ?? c.change.artifactId);
    recordDecision(projectId, recordOf(target, OUTCOME[op], note.rationale, scopeTitles));
    const store = useStore.getState();
    await Promise.all([store.refreshProposals(), store.refreshArtifacts()]).catch(() => {});
    busyRef.current = false;
    setBusy(null);
    if (useStore.getState().projectId !== projectId) return;
    const open = queueList(useStore.getState().proposals, 'open').map((p) => p.id);
    const next = nextAfterDecision(order, id, open);
    setQueue(projectId, { selected: next });
    // The draft became the record; renders before this point still showed the old version.
    forgetNotes(projectId, id);
    forgetDetail(projectId, id);
    setDone(!next);
    pendingFocus.current = next ? 'heading' : 'done';
    setFeedback({ tone: 'ok', text: `${outcomeWords(OUTCOME[op])}: “${target.proposal.reason}”.` });
    rerender();
  };

  const resume = () => {
    if (!projectId || !review?.handoff.length) return;
    const outcome = askAgent(handoffText(review.handoff));
    clearHandoff(projectId);
    setFeedback({ tone: 'ok', text: askedWords(outcome, 'The handoff') });
  };

  const rebase = () => {
    if (!detail) return;
    const moved = detail.changes.filter(changeBaseMoved).map((c) => ({
      title: c.artifact?.title ?? c.change.artifactId,
      artifactId: c.change.artifactId,
      baseSeq: c.base?.seq ?? null,
      currentSeq:
        artifacts.find((a) => a.artifact.id === c.change.artifactId)?.revision?.seq ?? null,
    }));
    const outcome = askAgent(rebaseText(detail, moved));
    setFeedback({ tone: 'ok', text: askedWords(outcome, 'The rebase request') });
  };

  const moveChange = (dir: 1 | -1) => {
    const els = sections.current.filter((el): el is HTMLElement => !!el);
    if (!els.length) return;
    const at = els.findIndex((el) => el.contains(document.activeElement));
    const top = scrollRef.current?.getBoundingClientRect().top ?? 0;
    const near = els.findIndex((el) => el.getBoundingClientRect().bottom > top + 8);
    const from = at >= 0 ? at : dir === 1 ? near - 1 : near + 1;
    const target = els[Math.min(els.length - 1, Math.max(0, from + dir))]!;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
  };

  const step = (dir: 1 | -1) => {
    const at = list.findIndex((p) => p.id === activeId);
    const next = list[at < 0 ? 0 : at + dir];
    if (!next) return;
    pendingFocus.current = 'heading';
    select(next.id);
  };

  // ⌘↵ with nothing focused never approves; with a proposal open, it says where focus must be.
  const decisionOpen = useRef(false);
  useEffect(() => {
    const hint = (e: KeyboardEvent) => {
      if (
        !(e.metaKey || e.ctrlKey) ||
        e.key !== 'Enter' ||
        document.activeElement !== document.body
      )
        return;
      if (!decisionOpen.current || isLayerOpen()) return;
      setFeedback({
        tone: 'warn',
        text: 'Nothing was approved: click the proposal or press Tab first. ⌘↵ acts only inside the decision.',
      });
    };
    window.addEventListener('keydown', hint);
    return () => window.removeEventListener('keydown', hint);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const layer = layerName(topmostLayer());
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void act('approve', 'keyboard', {
        repeat: e.repeat,
        layer,
        focusInside: !!rootRef.current?.contains(document.activeElement),
      });
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || layer || typing(e.target)) return;
    const onChange = (e.target as HTMLElement).matches?.('.change');
    if (
      e.key === 'j' ||
      e.key === 'k' ||
      (onChange && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))
    ) {
      e.preventDefault();
      moveChange(e.key === 'j' || e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === ']' || e.key === '[') {
      e.preventDefault();
      step(e.key === ']' ? 1 : -1);
    }
  };

  if (!projectId) return null;
  const index = list.findIndex((p) => p.id === activeId);
  const handoff = review?.handoff ?? [];
  const open = phase ? decidable(phase) : false;
  decisionOpen.current = !!activeId && open;
  const canDecide = open && !readOnly && !busy;
  const replaced = detail ? supersedes(detail.proposal) : [];
  const resumeButton =
    handoff.length === 0 ? null : running ? (
      <Button size="sm" onClick={resume}>
        Resume agent from decision
      </Button>
    ) : (
      <Button size="sm" variant="ghost" onClick={showAgent}>
        Open the agent to hand it back
      </Button>
    );

  let stage: React.ReactNode;
  if (!activeId) {
    const waiting = waitingOnAgent(proposals).length;
    const pending = needsYou(proposals);
    stage = (
      <div className="decide-scroll decide-done" ref={doneRef} tabIndex={-1}>
        {feedback && (
          <p
            className={`decide-done-feedback tone-${feedback.tone}`}
            role={feedback.tone === 'err' ? 'alert' : 'status'}
          >
            {feedback.text}
          </p>
        )}
        <Empty
          icon={<CheckCircle size={22} />}
          title={
            pending.length
              ? `${pending.length} ${pending.length === 1 ? 'proposal needs' : 'proposals need'} you`
              : 'Nothing needs you'
          }
          body={
            pending.length
              ? 'New work arrived while you were deciding.'
              : waiting
                ? `${waiting} ${waiting === 1 ? 'proposal is' : 'proposals are'} waiting on the agent. Proposals arrive here with before-and-after values and what they would affect.`
                : 'Proposals the agent submits arrive here with before-and-after values and what they would affect.'
          }
          action={
            pending.length ? (
              <Button variant="primary" onClick={() => select(pending[0]!.id)}>
                Review the next proposal
              </Button>
            ) : filter === 'open' && proposals.length ? (
              <Button variant="ghost" onClick={() => setFilter('all')}>
                See past decisions
              </Button>
            ) : undefined
          }
        />
        {handoff.length > 0 && (
          <section className="decide-handoff">
            <h2>Hand the {handoff.length === 1 ? 'decision' : 'decisions'} back to the agent</h2>
            <ul className="plain-list">
              {handoff.map((d) => (
                <li key={d.proposalId}>
                  {outcomeWords(d.outcome)}: “{d.reason}”
                </li>
              ))}
            </ul>
            <Disclosure
              label="What will be typed"
              open={showHandoff}
              onToggle={() => setShowHandoff((v) => !v)}
            >
              <pre className="code-block">{handoffText(handoff)}</pre>
            </Disclosure>
            <div className="decide-handoff-actions">
              <Button variant="primary" disabled={!running} onClick={resume}>
                Resume agent from decision
              </Button>
              {!running && (
                <>
                  <Button variant="ghost" onClick={showAgent}>
                    Open the agent
                  </Button>
                  <span className="review-muted">
                    Start the agent to hand this back. It is typed, not sent.
                  </span>
                </>
              )}
            </div>
          </section>
        )}
      </div>
    );
  } else if (!detail) {
    stage =
      load === 'error' ? (
        <div className="decide-scroll">
          <Notice
            tone="err"
            role="alert"
            action={
              <Button size="sm" onClick={reload}>
                Read again
              </Button>
            }
          >
            The proposal could not be read: {error}
          </Notice>
        </div>
      ) : (
        <div className="decide-scroll" aria-busy="true">
          <Skeleton lines={2} height={22} />
          <Skeleton lines={6} />
        </div>
      );
  } else {
    stage = (
      <>
        <div
          className="decide-scroll"
          ref={scrollRef}
          onScroll={(e) =>
            updateNotes(projectId, detail.proposal.id, { scrollTop: e.currentTarget.scrollTop })
          }
        >
          <header className="decide-head">
            <div className="decide-nav">
              <GitBranch size={14} />
              <span>
                {index >= 0 ? `Proposal ${index + 1} of ${list.length}` : 'Not in this list'}
              </span>
              <IconButton
                size="sm"
                label="Previous proposal ([)"
                disabled={index <= 0}
                onClick={() => step(-1)}
              >
                <CaretLeft size={12} />
              </IconButton>
              <IconButton
                size="sm"
                label="Next proposal (])"
                disabled={index < 0 || index >= list.length - 1}
                onClick={() => step(1)}
              >
                <CaretRight size={12} />
              </IconButton>
            </div>
            <h1 ref={headingRef} tabIndex={-1}>
              {detail.proposal.reason}
            </h1>
            <div className="stage-states">
              {phase && (
                <State
                  state={detail.proposal.state}
                  label={phaseLabel(phase)}
                  tone={phaseTone(phase)}
                />
              )}
              <span className="stage-rev">
                Proposed by {BY[detail.proposal.createdBy] ?? detail.proposal.createdBy} ·{' '}
                <time
                  dateTime={detail.proposal.createdAt}
                  title={new Date(detail.proposal.createdAt).toLocaleString()}
                >
                  {relativeTime(detail.proposal.createdAt)}
                </time>{' '}
                · {detail.changes.length} {detail.changes.length === 1 ? 'change' : 'changes'} ·{' '}
                <span className="mono" title={detail.proposal.id}>
                  {shortId(detail.proposal.id)}
                </span>
              </span>
            </div>
          </header>
          {changed.length > 0 && (
            <Notice
              tone="warn"
              role="alert"
              action={
                open ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      confirmRead(projectId, detail);
                      rerender();
                    }}
                  >
                    I have read the changes
                  </Button>
                ) : undefined
              }
            >
              <strong>This proposal changed while it was open.</strong>
              <ul className="plain-list">
                {changed.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </Notice>
          )}
          {load === 'refresh_failed' && (
            <Notice
              tone="warn"
              action={
                <Button size="sm" onClick={reload}>
                  Read again
                </Button>
              }
            >
              Could not read the latest version: {error}. Decisions wait until it is read again.
            </Notice>
          )}
          {phase && (
            <PhaseNotice
              phase={phase}
              detail={detail}
              proposals={proposals}
              running={running}
              onSelect={(id) => {
                pendingFocus.current = 'heading';
                select(id);
              }}
              onRebase={rebase}
            />
          )}
          {replaced.length > 0 && (
            <Notice>
              Replaces{' '}
              {replaced.length === 1
                ? 'an earlier proposal'
                : `${replaced.length} earlier proposals`}
              {': '}
              {replaced.map((id, i) => (
                <React.Fragment key={id}>
                  {i > 0 && ', '}
                  <button type="button" className="decide-link" onClick={() => select(id)}>
                    {proposals.find((p) => p.id === id)?.reason ?? `proposal ${shortId(id)}`}
                  </button>
                </React.Fragment>
              ))}
              . {replaced.length === 1 ? 'It stays' : 'They stay'} in the record and can no longer
              be decided.
            </Notice>
          )}
          {detail.changes.map((item, i) => (
            <ChangeSection
              key={`${item.change.artifactId}:${item.change.newRevisionId}`}
              index={i}
              total={detail.changes.length}
              item={item}
              projectId={projectId}
              open={open}
              notes={notes!}
              onToggle={(key) => patchNotes({ open: { ...notes!.open, [key]: !notes!.open[key] } })}
              onScope={(artifactId, hash) => {
                const scopes = { ...notes!.scopes };
                if (hash) scopes[artifactId] = hash;
                else delete scopes[artifactId];
                patchNotes({ scopes });
              }}
              canDecide={canDecide}
              onStatus={onStatus}
              sectionRef={(el) => {
                sections.current[i] = el;
              }}
            />
          ))}
        </div>
        {phase && open && (
          <DecisionBar
            phase={phase}
            rationale={notes?.rationale ?? ''}
            onRationale={(rationale) => patchNotes({ rationale })}
            verdicts={verdicts}
            busy={busy}
            readOnly={readOnly}
            feedback={feedback}
            feedbackAction={feedback?.tone === 'ok' ? resumeButton : undefined}
            onDecide={(op) => void act(op, 'pointer')}
          />
        )}
        {phase && !open && feedback && (
          <div className="decision decision-closed">
            <div className={`decision-feedback tone-${feedback.tone}`} role="status">
              <span className="grow">{feedback.text}</span>
              {feedback.tone === 'ok' && resumeButton}
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="decide" ref={rootRef} onKeyDown={onKeyDown}>
      <ErrorBoundary label="The proposal list">
        <Queue
          proposals={proposals}
          list={list}
          filter={filter}
          onFilter={setFilter}
          activeId={activeId}
          onSelect={(id) => select(id)}
          artifacts={artifacts}
        />
      </ErrorBoundary>
      {/* Focusable so that a click anywhere on the proposal puts the keyboard in the decision. */}
      <main className="decide-stage" tabIndex={-1}>
        {stage}
      </main>
      <ErrorBoundary label="The impact rail">
        <ImpactRail
          open={!!activeId}
          detail={activeId ? detail : null}
          phase={phase}
          scopes={notes?.scopes ?? {}}
        />
      </ErrorBoundary>
    </div>
  );
}
