import React, { useEffect, useState } from 'react';
import { cmd, errMsg } from '../api';
import { useStore } from '../store';
import type { Proposal, Revision, Artifact, ProposedChange } from '@omenflow/contracts';
import { formatQty, isUnknown } from '@omenflow/contracts';
import { ArtifactIcon, EmptyState, PageHeader, StatusBadge, SearchField } from '../components/ui';
import { GitBranch, CheckCircle } from '@phosphor-icons/react';
import { CadRevisionReview, type VerificationReview } from '../components/CadRevisionReview';

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

export function ReviewsView() {
  const { proposals, refreshProposals, refreshArtifacts, toast, selectArtifact, readOnly } =
    useStore();
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const [query, setQuery] = useState('');
  const [loadError, setLoadError] = useState('');
  const [acceptedScopes, setAcceptedScopes] = useState<Record<string, string>>({});
  const [resumeProposal, setResumeProposal] = useState<string | null>(null);
  const [sentDecision, setSentDecision] = useState<string | null>(null);
  const projectId = useStore((s) => s.project?.id);
  const session = useStore((s) => s.session);
  const decisionId =
    resumeProposal ??
    (detail &&
    ['changes_requested', 'accepted', 'rejected'].includes(detail.proposal.state) &&
    detail.proposal.id !== sentDecision
      ? detail.proposal.id
      : null);
  useEffect(() => {
    setResumeProposal(null);
    setSentDecision(null);
  }, [projectId]);
  const visible = proposals.filter(
    (p) =>
      (filter === 'all' || ['pending', 'changes_requested'].includes(p.state)) &&
      p.reason.toLowerCase().includes(query.toLowerCase()),
  );
  const activeId = visible.some((p) => p.id === selectedId) ? selectedId : visible[0]?.id;
  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setLoadError('');
    setRationale('');
    setAcceptedScopes({});
    if (activeId)
      void cmd<ProposalDetail>('proposal.read', { proposalId: activeId }, { projectId })
        .then((r) => {
          if (!cancelled) setDetail(r);
        })
        .catch((e) => {
          if (!cancelled) setLoadError(errMsg(e));
        });
    return () => {
      cancelled = true;
    };
  }, [activeId, proposals, projectId]);
  const act = async (
    op: 'proposal.approve' | 'proposal.reject' | 'proposal.request_changes',
    id: string,
  ) => {
    if (readOnly) return;
    setBusy(true);
    try {
      await cmd(
        op,
        {
          proposalId: id,
          rationale,
          ...(op === 'proposal.approve' ? { verificationEvidence: acceptedScopes } : {}),
        },
        { projectId },
      );
      if (useStore.getState().project?.id !== projectId) return;
      setResumeProposal(id);
      setSentDecision(null);
      toast(
        'ok',
        op === 'proposal.approve'
          ? 'Proposal approved. Baseline updated.'
          : op === 'proposal.reject'
            ? 'Proposal rejected.'
            : 'Changes requested.',
      );
      await Promise.all([refreshProposals(), refreshArtifacts()]);
      setSelectedId(null);
      setRationale('');
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page">
      <PageHeader
        title="Review queue"
        count={proposals.filter((p) => ['pending', 'changes_requested'].includes(p.state)).length}
        compact
      />
      <div className="toolbar">
        <div className="segmented">
          <button aria-pressed={filter === 'pending'} onClick={() => setFilter('pending')}>
            Needs review
          </button>
          <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            All proposals
          </button>
        </div>
        <span className="grow" />
        <SearchField value={query} onChange={setQuery} placeholder="Find a proposal" />
      </div>
      {decisionId && (
        <div className="inline-notice">
          <span>
            Decision recorded.{' '}
            {session?.state === 'running'
              ? 'Continue with the connected agent.'
              : 'Start the agent to continue from this decision.'}
          </span>{' '}
          <button
            disabled={readOnly || session?.state !== 'running'}
            onClick={() => {
              void cmd(
                'terminal.write',
                {
                  data: `\x1b[200~Read proposal ${decisionId} and its saved review decision using proposal.read. Continue the engineering task from that decision; preserve the accepted baseline and verify any new candidate. If changes were requested, submit the corrected candidate as a replacement proposal for review.\x1b[201~`,
                },
                { projectId },
              )
                .then(() => cmd('terminal.write', { data: '\r' }, { projectId }))
                .then(() => {
                  if (useStore.getState().project?.id !== projectId) return;
                  setResumeProposal(null);
                  setSentDecision(decisionId);
                  useStore.getState().set({ sidecarOpen: true, sidecarTab: 'agent' });
                })
                .catch((e) => toast('error', errMsg(e)));
            }}
          >
            Resume agent from decision
          </button>
        </div>
      )}
      <div className="object-layout">
        <aside className="object-browser review-browser" aria-label="Proposals">
          {visible.map((p) => (
            <button
              className={`proposal-row ${activeId === p.id ? 'selected' : ''}`}
              key={p.id}
              onClick={() => setSelectedId(p.id)}
            >
              <div className="row">
                <GitBranch size={15} />
                <StatusBadge state={p.state} />
              </div>
              <strong>{p.reason}</strong>
              <small>
                {p.changes.length} {p.changes.length === 1 ? 'change' : 'changes'} · {p.createdBy}
              </small>
            </button>
          ))}
          {!visible.length && <p className="browser-empty">No matching proposals.</p>}
        </aside>
        <div className="object-detail">
          {loadError ? (
            <div role="alert" className="inline-notice warning">
              {loadError}
            </div>
          ) : !activeId ? (
            <EmptyState
              title={query ? 'No matching proposals' : 'You’re all caught up'}
              body={
                query
                  ? 'Try another search or switch to all proposals.'
                  : 'New proposals will appear here with before-and-after changes and their downstream impact.'
              }
              icon={<CheckCircle size={25} />}
            />
          ) : !detail ? (
            <p className="dim" role="status">
              Loading proposal…
            </p>
          ) : (
            <ReviewDetail
              detail={detail}
              rationale={rationale}
              setRationale={setRationale}
              act={act}
              busy={busy || readOnly}
              acceptedScopes={acceptedScopes}
              setScope={(artifactId, hash, accepted) =>
                setAcceptedScopes((prev) => {
                  const next = { ...prev };
                  if (accepted) next[artifactId] = hash;
                  else delete next[artifactId];
                  return next;
                })
              }
              selectArtifact={(id) => {
                selectArtifact(id);
                useStore.getState().set({ sidecarOpen: true, sidecarTab: 'inspector' });
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ReviewDetail(props: {
  detail: ProposalDetail;
  rationale: string;
  setRationale: (s: string) => void;
  act: (
    op: 'proposal.approve' | 'proposal.reject' | 'proposal.request_changes',
    id: string,
  ) => Promise<void>;
  busy: boolean;
  acceptedScopes: Record<string, string>;
  setScope: (artifactId: string, hash: string, accepted: boolean) => void;
  selectArtifact: (id: string) => void;
}) {
  const { detail } = props;
  const artifacts = useStore((state) => state.artifacts);
  const p = detail.proposal;
  return (
    <div className="review-detail">
      <div className="review-author">
        <GitBranch size={16} />
        <span>Engineering proposal</span>
        <StatusBadge state={p.state} />
      </div>
      <h3 style={{ margin: '0 0 4px' }}>{p.reason}</h3>
      <div className="faint" style={{ fontSize: 12, marginBottom: 12 }}>
        proposed by {p.createdBy} · {p.createdAt.replace('T', ' ').slice(0, 16)}
      </div>
      {p.impact?.supersedesProposalIds?.length ? (
        <div className="inline-notice">
          This replacement supersedes {p.impact.supersedesProposalIds.length === 1
            ? 'an earlier changes-requested review'
            : `${p.impact.supersedesProposalIds.length} earlier changes-requested reviews`}
          . The earlier review stays in the record and is no longer actionable.
        </div>
      ) : null}
      {p.state === 'superseded' && (
        <div className="inline-notice">
          Superseded by a later replacement
          {p.impact?.supersededByProposalId
            ? ` (${p.impact.supersededByProposalId.slice(0, 8)})`
            : ''}
          . It remains in the project history and is no longer in the review queue.
        </div>
      )}

      {detail.changes.map(({ change, artifact, base, next, verification }, i) => (
        <div
          key={i}
          style={{
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <button
              className="table-title-button review-object"
              title="Inspect this object"
              disabled={!artifact}
              onClick={() => artifact && props.selectArtifact(artifact.id)}
            >
              {artifact && <ArtifactIcon type={artifact.type} size={14} />}
              {artifact?.title ?? change.artifactId.slice(0, 8)}
            </button>
            <span className="pill">{change.kind.replaceAll('_', ' ')}</span>
          </div>
          <div className="faint" style={{ fontSize: 11, margin: '4px 0' }}>
            base {base ? `rev ${base.seq}` : 'none'} → proposed rev {next?.seq ?? '?'}
          </div>
          {artifact?.type === 'mechanical' && next ? (
            <CadRevisionReview
              base={base}
              next={next}
              verification={verification}
              accepted={
                props.acceptedScopes[artifact.id] === verification?.evidenceHash &&
                !!verification?.evidenceHash
              }
              onAcceptScope={(accepted) =>
                verification?.evidenceHash &&
                props.setScope(artifact.id, verification.evidenceHash, accepted)
              }
              disabled={props.busy || !['pending', 'changes_requested'].includes(p.state)}
            />
          ) : (
            base && next && <PayloadDiff from={base.payload} to={next.payload} />
          )}
          {!base && next && artifact?.type !== 'mechanical' && (
            <div className="dim" style={{ fontSize: 12 }}>
              New artifact — {summarize(next.payload)}
            </div>
          )}
          {change.bomLines && (
            <div style={{ marginTop: 6, fontSize: 12 }}>
              <div className="dim">BOM lines:</div>
              {change.bomLines.map((l, j) => (
                <div key={j} className="mono" style={{ fontSize: 11 }}>
                  ×{l.quantity} {l.subsystem ?? ''} {l.location ?? ''} {l.notes}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      {p.impact && p.impact.affectedArtifactIds.length > 0 && (
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <div className="dim" style={{ fontSize: 12, marginBottom: 4 }}>
            Downstream impact
          </div>
          <p className="dim" style={{ fontSize: 12 }}>
            {p.impact.affectedArtifactIds.length} connected{' '}
            {p.impact.affectedArtifactIds.length === 1 ? 'object may' : 'objects may'} need to be
            revisited.
          </p>
          <div className="impact-objects">
            {p.impact.affectedArtifactIds.map((id) => (
              <button key={id} onClick={() => props.selectArtifact(id)}>
                <GitBranch size={13} />
                {artifacts.find((v) => v.artifact.id === id)?.artifact.title ?? id.slice(0, 8)}
              </button>
            ))}
          </div>
        </div>
      )}

      {(p.state === 'pending' || p.state === 'changes_requested') && (
        <div className="review-decision" role="group" aria-label="Decision">
          {p.resolutionRationale && <p>Latest review decision: {p.resolutionRationale}</p>}
          <label htmlFor="review-rationale">Decision rationale</label>
          <textarea
            id="review-rationale"
            disabled={props.busy}
            rows={2}
            placeholder="Why this decision is right for the design (optional, kept in the record)"
            value={props.rationale}
            onChange={(e) => props.setRationale(e.target.value)}
          />
          <div className="row">
            <button
              className="primary"
              disabled={props.busy}
              onClick={() => props.act('proposal.approve', p.id)}
            >
              {props.busy ? 'Recording decision…' : 'Approve changes'}
            </button>
            <button
              disabled={props.busy}
              onClick={() => props.act('proposal.request_changes', p.id)}
            >
              Request changes
            </button>
            <span className="grow" />
            <button
              className="danger ghost"
              disabled={props.busy}
              onClick={() => props.act('proposal.reject', p.id)}
            >
              Reject
            </button>
          </div>
        </div>
      )}
      {p.state !== 'pending' && p.state !== 'changes_requested' && (
        <div className="dim" style={{ marginTop: 8 }}>
          Resolved: {p.state} {p.resolutionRationale ? `— ${p.resolutionRationale}` : ''}
        </div>
      )}
    </div>
  );
}

function summarize(payload: unknown): string {
  const p = payload as Record<string, unknown>;
  if (p.statement) return String(p.statement).slice(0, 160);
  if (p.partNumber) return `${p.partNumber} (${p.manufacturer ?? p.vendor ?? ''})`;
  if (typeof p.markdown === 'string') return p.markdown.slice(0, 160);
  if (typeof p.text === 'string') return p.text.slice(0, 160);
  if (p.url) return String(p.url).slice(0, 160);
  return JSON.stringify(payload).slice(0, 160);
}

function PayloadDiff({ from, to }: { from: unknown; to: unknown }) {
  const diffs: { path: string; from: unknown; to: unknown }[] = [];
  const walk = (a: unknown, b: unknown, path: string) => {
    if (a === b) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const item = b[i] ?? a[i];
        const label =
          item && typeof item === 'object' && 'name' in item ? String(item.name) : String(i + 1);
        walk(a[i], b[i], `${path}[${label}]`);
      }
      return;
    }
    if (
      a &&
      b &&
      typeof a === 'object' &&
      typeof b === 'object' &&
      'value' in a &&
      'unit' in a &&
      'value' in b &&
      'unit' in b
    ) {
      if (a.value !== b.value || a.unit !== b.unit) diffs.push({ path, from: a, to: b });
      return;
    }
    if (
      a &&
      b &&
      typeof a === 'object' &&
      typeof b === 'object' &&
      !Array.isArray(a) &&
      !Array.isArray(b)
    ) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys)
        walk(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
          path ? `${path}.${k}` : k,
        );
      return;
    }
    diffs.push({ path: path || '(root)', from: a, to: b });
  };
  walk(from, to, '');
  if (diffs.length === 0)
    return (
      <div className="faint" style={{ fontSize: 12 }}>
        No payload diff
      </div>
    );
  const fmt = (v: unknown): string => {
    if (v && typeof v === 'object' && 'value' in v && 'unit' in v) {
      return formatQty(v as never);
    }
    if (v && typeof v === 'object' && isUnknown(v as never)) return 'unknown';
    if (v === undefined) return 'Not set';
    if (v === null) return 'None';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  };
  return (
    <table className="diff-table">
      <thead>
        <tr>
          <th>Changed field</th>
          <th>Baseline</th>
          <th>Proposed</th>
        </tr>
      </thead>
      <tbody>
        {diffs.map((d, i) => (
          <tr key={i}>
            <td
              className="mono faint"
              style={{ padding: '3px 8px 3px 0', verticalAlign: 'top', overflowWrap: 'anywhere' }}
            >
              {d.path}
            </td>
            <td style={{ padding: '3px 8px', color: 'var(--err)', wordBreak: 'break-word' }}>
              {fmt(d.from)}
            </td>
            <td style={{ padding: '3px 8px', color: 'var(--ok)', wordBreak: 'break-word' }}>
              {fmt(d.to)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
