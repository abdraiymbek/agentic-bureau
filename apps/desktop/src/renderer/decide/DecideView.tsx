import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, CaretLeft, CaretRight, CheckCircle, GitBranch } from '@phosphor-icons/react';
import type { Artifact, Proposal, ProposedChange, Revision } from '@omenflow/contracts';
import { cmd, errMsg } from '../api';
import { openProposals, useStore } from '../store';
import { sendToAgent } from '../lib/actions';
import {
  Button,
  Empty,
  IconButton,
  Kbd,
  Notice,
  Segmented,
  State,
  TypeGlyph,
  relativeTime,
  shortId,
} from '../ui/kit';
import { CadReview, type VerificationReview } from './CadReview';
import { PayloadDiff, summarize } from './PayloadDiff';

interface ProposalDetail {
  proposal: Proposal;
  changes: {
    change: ProposedChange;
    artifact: Artifact | null;
    base: Revision | null;
    next: Revision | null;
    verification?: VerificationReview;
  }[];
}

type Op = 'proposal.approve' | 'proposal.reject' | 'proposal.request_changes';

/** Zoom level 2: one proposed change, its evidence, its consequences, and your decision. */
export function DecideView() {
  const view = useStore((s) => s.view);
  const proposals = useStore((s) => s.proposals);
  const readOnly = useStore((s) => s.readOnly);
  const projectId = useStore((s) => s.projectId);
  const session = useStore((s) => s.session);
  const { set, toast, refreshProposals, refreshArtifacts, focus } = useStore.getState();
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [loadError, setLoadError] = useState('');
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState(false);
  const [scopes, setScopes] = useState<Record<string, string>>({});
  const [lastDecision, setLastDecision] = useState<{ id: string; op: Op } | null>(null);
  const requested = view.level === 'decide' ? view.proposalId : null;
  const [selected, setSelected] = useState<string | null>(requested);
  useEffect(() => setSelected(requested), [requested]);

  const visible = useMemo(
    () =>
      (filter === 'open' ? openProposals(proposals) : proposals)
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [proposals, filter],
  );
  useEffect(() => {
    if (
      requested &&
      !openProposals(proposals).some((p) => p.id === requested) &&
      proposals.some((p) => p.id === requested)
    )
      setFilter('all');
  }, [requested, proposals]);
  const activeId = visible.some((p) => p.id === selected) ? selected : (visible[0]?.id ?? null);
  const index = visible.findIndex((p) => p.id === activeId);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setLoadError('');
    setRationale('');
    setScopes({});
    if (activeId)
      void cmd<ProposalDetail>(
        'proposal.read',
        { proposalId: activeId },
        { projectId: projectId ?? undefined },
      )
        .then((r) => !cancelled && setDetail(r))
        .catch((e) => !cancelled && setLoadError(errMsg(e)));
    return () => {
      cancelled = true;
    };
  }, [activeId, proposals, projectId]);

  const act = async (op: Op) => {
    if (readOnly || !activeId || busy) return;
    const id = activeId;
    setBusy(true);
    try {
      await cmd(
        op,
        {
          proposalId: id,
          rationale,
          ...(op === 'proposal.approve' ? { verificationEvidence: scopes } : {}),
        },
        { projectId: projectId ?? undefined },
      );
      if (useStore.getState().projectId !== projectId) return;
      toast(
        'ok',
        op === 'proposal.approve'
          ? 'Approved. The baseline is updated.'
          : op === 'proposal.reject'
            ? 'Rejected.'
            : 'Changes requested.',
      );
      setLastDecision({ id, op });
      setRationale('');
      setSelected(null);
      await Promise.all([refreshProposals(), refreshArtifacts()]);
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const decidable = !!detail && ['pending', 'changes_requested'].includes(detail.proposal.state);
  const actRef = useRef(act);
  actRef.current = act;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && decidable) {
        e.preventDefault();
        void actRef.current('proposal.approve');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [decidable]);

  const resume = async () => {
    if (!lastDecision) return;
    try {
      await sendToAgent(
        `Read proposal ${lastDecision.id} and its saved review decision using proposal.read. Continue the engineering task from that decision; preserve the accepted baseline and verify any new candidate. If changes were requested, submit the corrected candidate as a replacement proposal for review.`,
      );
      setLastDecision(null);
      set({ consoleOpen: true });
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  return (
    <div className="decide">
      <aside className="rail rail-up decide-queue" aria-label="Proposals">
        <div className="decide-filter">
          <Segmented
            label="Which proposals"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'open', label: 'Needs you', count: openProposals(proposals).length },
              { value: 'all', label: 'All' },
            ]}
          />
        </div>
        <ul className="queue">
          {visible.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className={`queue-item ${p.id === activeId ? 'active' : ''}`}
                aria-current={p.id === activeId}
                onClick={() => setSelected(p.id)}
              >
                <span className="queue-title">{p.reason}</span>
                <span className="queue-meta">
                  <State state={p.state} quiet />
                  <span>{relativeTime(p.createdAt)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {!visible.length && (
          <p className="rail-empty">
            {filter === 'open' ? 'Nothing waiting.' : 'No proposals yet.'}
          </p>
        )}
      </aside>

      <main className="decide-stage">
        {lastDecision && (
          <div className="decide-after">
            <Notice
              tone="ok"
              action={
                <Button
                  size="sm"
                  disabled={readOnly || session?.state !== 'running'}
                  onClick={() => void resume()}
                >
                  Resume agent from decision
                </Button>
              }
            >
              Decision recorded.{' '}
              {session?.state === 'running'
                ? 'The agent can continue from it.'
                : 'Start the agent to continue from this decision.'}
            </Notice>
          </div>
        )}
        {loadError ? (
          <div className="decide-scroll">
            <Notice tone="err" role="alert">
              {loadError}
            </Notice>
          </div>
        ) : !activeId ? (
          <Empty
            icon={<CheckCircle size={22} />}
            title="You’re caught up"
            body="Proposed changes arrive here with before-and-after values and the objects they would affect."
            action={
              filter === 'open' && proposals.length > 0 ? (
                <Button variant="ghost" onClick={() => setFilter('all')}>
                  See past decisions
                </Button>
              ) : undefined
            }
          />
        ) : !detail ? (
          <p className="lens-muted" role="status">
            Loading the proposal…
          </p>
        ) : (
          <>
            <div className="decide-scroll">
              <header className="decide-head">
                <div className="decide-nav">
                  <GitBranch size={14} />
                  <span>
                    Proposal {index + 1} of {visible.length}
                  </span>
                  <IconButton
                    size="sm"
                    label="Previous proposal"
                    disabled={index <= 0}
                    onClick={() => setSelected(visible[index - 1]!.id)}
                  >
                    <CaretLeft size={12} />
                  </IconButton>
                  <IconButton
                    size="sm"
                    label="Next proposal"
                    disabled={index >= visible.length - 1}
                    onClick={() => setSelected(visible[index + 1]!.id)}
                  >
                    <CaretRight size={12} />
                  </IconButton>
                </div>
                <h1>{detail.proposal.reason}</h1>
                <div className="stage-states">
                  <State state={detail.proposal.state} />
                  <span className="stage-rev">
                    Proposed by {detail.proposal.createdBy} ·{' '}
                    {relativeTime(detail.proposal.createdAt)} · {detail.changes.length}{' '}
                    {detail.changes.length === 1 ? 'change' : 'changes'}
                  </span>
                </div>
              </header>
              {detail.proposal.impact?.supersedesProposalIds?.length ? (
                <Notice>
                  Replaces{' '}
                  {detail.proposal.impact.supersedesProposalIds.length === 1
                    ? 'an earlier review where changes were requested'
                    : `${detail.proposal.impact.supersedesProposalIds.length} earlier reviews`}
                  . Those stay in the record and are no longer actionable.
                </Notice>
              ) : null}
              {detail.proposal.state === 'superseded' && (
                <Notice>
                  Superseded by a later replacement
                  {detail.proposal.impact?.supersededByProposalId
                    ? ` (${shortId(detail.proposal.impact.supersededByProposalId)})`
                    : ''}
                  . It stays in history.
                </Notice>
              )}

              {detail.changes.map(({ change, artifact, base, next, verification }, i) => (
                <section className="change" key={i}>
                  <header className="change-head">
                    <button
                      type="button"
                      className="change-object"
                      disabled={!artifact}
                      onClick={() => artifact && focus(artifact.id)}
                    >
                      {artifact && <TypeGlyph type={artifact.type} size={14} />}
                      {artifact?.title ?? shortId(change.artifactId)}
                      <ArrowRight size={12} />
                    </button>
                    <span className="change-kind">{change.kind.replaceAll('_', ' ')}</span>
                    <span className="grow" />
                    <span className="change-revs num">
                      {base ? `r${base.seq}` : 'new'} → r{next?.seq ?? '?'}
                    </span>
                  </header>
                  {artifact?.type === 'mechanical' && next ? (
                    <CadReview
                      base={base}
                      next={next}
                      verification={verification}
                      accepted={
                        !!verification?.evidenceHash &&
                        scopes[artifact.id] === verification.evidenceHash
                      }
                      onAcceptScope={(accepted) =>
                        verification?.evidenceHash &&
                        setScopes((prev) => {
                          const n = { ...prev };
                          if (accepted) n[artifact.id] = verification.evidenceHash!;
                          else delete n[artifact.id];
                          return n;
                        })
                      }
                      disabled={busy || readOnly || !decidable}
                    />
                  ) : base && next ? (
                    <PayloadDiff from={base.payload} to={next.payload} />
                  ) : next ? (
                    <p className="change-new">New · {summarize(next.payload)}</p>
                  ) : null}
                  {change.bomLines && (
                    <div className="change-bom">
                      <span className="dim">Bill of materials lines</span>
                      {change.bomLines.map((l, j) => (
                        <div key={j} className="mono">
                          ×{l.quantity} {l.subsystem ?? ''} {l.location ?? ''} {l.notes}
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              ))}

              {!decidable && (
                <p className="resolved">
                  Resolved · {detail.proposal.state.replaceAll('_', ' ')}
                  {detail.proposal.resolutionRationale
                    ? ` — “${detail.proposal.resolutionRationale}”`
                    : ''}
                </p>
              )}
            </div>

            {decidable && (
              <div className="decision" role="group" aria-label="Decision">
                {detail.proposal.resolutionRationale && (
                  <p className="decision-prior">
                    Previous review: “{detail.proposal.resolutionRationale}”
                  </p>
                )}
                <textarea
                  aria-label="Decision rationale"
                  rows={1}
                  disabled={busy || readOnly}
                  placeholder="Why this is right for the design (optional, kept in the record)"
                  value={rationale}
                  onChange={(e) => setRationale(e.target.value)}
                />
                <div className="decision-actions">
                  <Button
                    variant="danger"
                    size="md"
                    disabled={busy || readOnly}
                    onClick={() => void act('proposal.reject')}
                  >
                    Reject
                  </Button>
                  <span className="grow" />
                  <Button
                    disabled={busy || readOnly}
                    onClick={() => void act('proposal.request_changes')}
                  >
                    Request changes
                  </Button>
                  <Button
                    variant="primary"
                    disabled={busy || readOnly}
                    onClick={() => void act('proposal.approve')}
                    trailing={<Kbd>⌘↵</Kbd>}
                  >
                    {busy ? 'Recording…' : 'Approve changes'}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </main>

      <aside className="rail rail-down" aria-label="Impact">
        <section className="links links-down">
          <h2>
            Would affect
            {detail?.proposal.impact?.affectedArtifactIds.length ? (
              <span className="count">{detail.proposal.impact.affectedArtifactIds.length}</span>
            ) : null}
          </h2>
          {detail?.proposal.impact?.affectedArtifactIds.length ? (
            <ImpactList ids={detail.proposal.impact.affectedArtifactIds} />
          ) : (
            <p className="rail-empty">{detail ? 'No recorded dependents.' : '—'}</p>
          )}
          {detail?.proposal.impact?.summary && (
            <p className="rail-note">{detail.proposal.impact.summary}</p>
          )}
        </section>
        <section className="record">
          <h2>What approval means</h2>
          <p className="rail-note">
            Approval updates the baseline and marks dependents for revisiting. It does not mean the
            design is validated or fit to build.
          </p>
        </section>
      </aside>
    </div>
  );
}

function ImpactList({ ids }: { ids: string[] }) {
  const artifacts = useStore((s) => s.artifacts);
  const focus = useStore((s) => s.focus);
  return (
    <ul>
      {ids.map((id) => {
        const v = artifacts.find((a) => a.artifact.id === id);
        return (
          <li key={id}>
            <button type="button" className="link-node" onClick={() => focus(id)} disabled={!v}>
              <TypeGlyph type={v?.artifact.type ?? 'note'} size={14} />
              <span className="link-copy">
                <span className="link-title">{v?.artifact.title ?? shortId(id)}</span>
                <small>may need revisiting</small>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
