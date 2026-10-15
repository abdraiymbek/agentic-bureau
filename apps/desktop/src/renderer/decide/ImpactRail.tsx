import React from 'react';
import { useStore } from '../store';
import { TypeGlyph, shortId } from '../ui/kit';
import { affectedIds, approvalEffects, type Phase, type ProposalDetail } from './model';

function Dependents({ ids }: { ids: string[] }) {
  const artifacts = useStore((s) => s.artifacts);
  const focus = useStore((s) => s.focus);
  return (
    <ul>
      {ids.map((id) => {
        const v = artifacts.find((a) => a.artifact.id === id);
        return (
          <li key={id}>
            <button
              type="button"
              className="link-node"
              onClick={() => focus(id)}
              disabled={!v}
              title={v ? undefined : 'Not in the current project list (it may be archived).'}
            >
              {v && <TypeGlyph type={v.artifact.type} size={14} />}
              <span className="link-copy">
                <span className="link-title">{v?.artifact.title ?? `Object ${shortId(id)}`}</span>
                <small>{v ? 'may be marked out of date' : 'not in the current list'}</small>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Right rail: consequences of approval, and what approval does not mean. With no proposal open
 * (the done state) only the standing note remains.
 */
export function ImpactRail({
  open,
  detail,
  phase,
  scopes,
}: {
  open: boolean;
  detail: ProposalDetail | null;
  phase: Phase | null;
  scopes: Record<string, string>;
}) {
  const artifacts = useStore((s) => s.artifacts);
  const ids = detail ? affectedIds(detail) : [];
  const decided = phase?.kind === 'decided';
  const approved = decided && phase.outcome === 'approved';
  const closed = !!phase && !['needs_you', 'base_moved', 'waiting_on_agent'].includes(phase.kind);
  const blocked =
    phase?.kind === 'base_moved' ||
    (phase?.kind === 'waiting_on_agent' && phase.artifactIds.length > 0);
  const heading = approved
    ? 'Affected by the approval'
    : closed
      ? 'Would have affected'
      : 'Would affect';
  const titleOf = (id: string) =>
    artifacts.find((a) => a.artifact.id === id)?.artifact.title ?? `object ${shortId(id)}`;
  return (
    <aside className="rail rail-down" aria-label="Impact">
      {open && (
        <section className="links links-down">
          <h2>
            {heading}
            {ids.length ? (
              <>
                {' '}
                <span className="count">{ids.length}</span>
              </>
            ) : null}
          </h2>
          {ids.length ? (
            <Dependents ids={ids} />
          ) : (
            <p className="rail-empty">{detail ? 'Nothing downstream is recorded.' : '—'}</p>
          )}
        </section>
      )}
      {detail && (
        <section className="decide-effects">
          <h2>
            {approved
              ? 'What the approval did'
              : closed
                ? 'Approval would have'
                : blocked
                  ? 'Approval is refused'
                  : 'Approving will'}
          </h2>
          {decided && !approved ? (
            <p className="rail-note">Nothing changed: the proposed revisions were rejected.</p>
          ) : (
            <ul>
              {approvalEffects(
                detail,
                titleOf,
                approved || closed ? {} : scopes,
                blocked && phase && 'artifactIds' in phase ? phase.artifactIds : [],
              ).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </section>
      )}
      <section className="record">
        <h2>What approval means</h2>
        <p className="rail-note">
          Approval makes the proposed revisions the baseline that other work builds on. It does not
          mean the design is validated, verified or fit to build: checks establish only their
          declared scope, and out-of-date dependents still need revisiting.
        </p>
        <p className="rail-note">
          Request changes sends it back to the agent with your rationale. Reject records that the
          change should not be made.
        </p>
      </section>
    </aside>
  );
}
