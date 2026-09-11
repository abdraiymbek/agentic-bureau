import React, { useEffect, useState } from 'react';
import { cmd } from '../api';
import { useStore } from '../store';
import type { Proposal, Revision, Artifact, ProposedChange } from '@stark/contracts';
import { formatQty, isUnknown } from '@stark/contracts';
import { EmptyBlock } from './OverviewView';

interface ProposalDetail {
  proposal: Proposal;
  changes: {
    change: ProposedChange;
    artifact: Artifact | null;
    base: Revision | null;
    next: Revision | null;
  }[];
}

/** Review surface: approve / request changes / reject with before-after + impact. */
export function ReviewsView() {
  const { proposals, refreshProposals, refreshArtifacts, toast, selectArtifact } = useStore();
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState(false);

  const open = async (id: string) => {
    const r = await cmd<ProposalDetail>('proposal.read', { proposalId: id });
    setDetail(r);
  };
  useEffect(() => {
    const pending = proposals.find((p) => p.state === 'pending');
    if (pending && !detail) void open(pending.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposals.length]);

  const act = async (
    op: 'proposal.approve' | 'proposal.reject' | 'proposal.request_changes',
    id: string,
  ) => {
    setBusy(true);
    try {
      await cmd(op, { proposalId: id, rationale });
      toast('ok', op.split('.')[1] ?? op);
      await refreshProposals();
      await refreshArtifacts();
      setDetail(null);
      setRationale('');
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div
        style={{
          width: 300,
          borderRight: '1px solid var(--border)',
          overflowY: 'auto',
          padding: 8,
        }}
      >
        <div className="dim" style={{ fontSize: 12, fontWeight: 600, padding: '4px 8px' }}>
          Proposals
        </div>
        {proposals.length === 0 && (
          <div className="faint" style={{ padding: 8, fontSize: 12 }}>
            No proposals yet.
          </div>
        )}
        {proposals.map((p) => (
          <div
            key={p.id}
            role="button"
            tabIndex={0}
            onClick={() => open(p.id)}
            onKeyDown={(e) => e.key === 'Enter' && open(p.id)}
            style={{
              padding: '6px 8px',
              borderRadius: 4,
              cursor: 'pointer',
              background: detail?.proposal.id === p.id ? 'var(--bg-raised)' : 'transparent',
            }}
          >
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {p.reason}
              </span>
              <span
                className={`pill ${p.state === 'pending' ? 'stale' : p.state === 'accepted' ? 'current' : 'missing'}`}
                style={{ height: 18, fontSize: 11 }}
              >
                {p.state}
              </span>
            </div>
            <div className="faint" style={{ fontSize: 11 }}>
              {p.createdBy} · {p.changes.length} change{p.changes.length > 1 ? 's' : ''} ·{' '}
              {p.createdAt.slice(0, 16).replace('T', ' ')}
            </div>
          </div>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {!detail ? (
          <EmptyBlock
            title="Select a proposal"
            body="Reviewable engineering changes appear here with before/after and downstream impact."
          />
        ) : (
          <ReviewDetail
            detail={detail}
            rationale={rationale}
            setRationale={setRationale}
            act={act}
            busy={busy}
            selectArtifact={selectArtifact}
          />
        )}
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
  selectArtifact: (id: string) => void;
}) {
  const { detail } = props;
  const p = detail.proposal;
  return (
    <div style={{ maxWidth: 720 }}>
      <h3 style={{ margin: '0 0 4px' }}>{p.reason}</h3>
      <div className="faint" style={{ fontSize: 12, marginBottom: 12 }}>
        proposed by {p.createdBy} · {p.createdAt.replace('T', ' ').slice(0, 16)}
      </div>

      {detail.changes.map(({ change, artifact, base, next }, i) => (
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
            <span
              style={{ fontWeight: 600, cursor: 'pointer' }}
              onClick={() => artifact && props.selectArtifact(artifact.id)}
            >
              {artifact?.title ?? change.artifactId.slice(0, 8)}
            </span>
            <span className="pill">{change.kind}</span>
          </div>
          <div className="faint" style={{ fontSize: 11, margin: '4px 0' }}>
            base {base ? `rev ${base.seq}` : 'none'} → proposed rev {next?.seq ?? '?'}
          </div>
          {base && next && <PayloadDiff from={base.payload} to={next.payload} />}
          {!base && next && (
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
          <div style={{ fontSize: 12 }}>{p.impact.summary}</div>
          <div className="faint" style={{ fontSize: 11 }}>
            {p.impact.affectedArtifactIds.length} artifact(s)
          </div>
        </div>
      )}

      {(p.state === 'pending' || p.state === 'changes_requested') && (
        <>
          <textarea
            rows={2}
            placeholder="Rationale (optional)"
            value={props.rationale}
            onChange={(e) => props.setRationale(e.target.value)}
            style={{ width: '100%', marginBottom: 8 }}
          />
          <div className="row">
            <button
              className="primary"
              disabled={props.busy}
              onClick={() => props.act('proposal.approve', p.id)}
            >
              Approve
            </button>
            <button
              disabled={props.busy}
              onClick={() => props.act('proposal.request_changes', p.id)}
            >
              Request changes
            </button>
            <button
              className="danger"
              disabled={props.busy}
              onClick={() => props.act('proposal.reject', p.id)}
            >
              Reject
            </button>
          </div>
        </>
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
  return JSON.stringify(payload).slice(0, 160);
}

function PayloadDiff({ from, to }: { from: unknown; to: unknown }) {
  const diffs: { path: string; from: unknown; to: unknown }[] = [];
  const walk = (a: unknown, b: unknown, path: string) => {
    if (a === b) return;
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
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.length > 80 ? s.slice(0, 80) + '…' : s;
  };
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 6 }}>
      <tbody>
        {diffs.slice(0, 30).map((d, i) => (
          <tr key={i}>
            <td
              className="mono faint"
              style={{ padding: '3px 8px 3px 0', verticalAlign: 'top', whiteSpace: 'nowrap' }}
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
