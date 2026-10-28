import React from 'react';
import { ArrowRight, At, CaretRight } from '../ui/icons';
import type { ArtifactView, StaleRecord } from '@bureau/contracts';
import { openProposals, useStore } from '../store';
import { Button, Notice, Skeleton, State, TypeGlyph, stateLabel, typeMeta } from '../ui/kit';
import { otherDraftCount } from '../lib/mechanical-revisions';
import { freshnessLabel, inputProblem, type InputProblem } from '../lib/stage-forms';
import { useObjectRevisions } from './revisions';
import { ObjectLink, useNavigate } from './stages/shared';

/** Type, title and the labelled states of the revision that is on screen. */
export function StageHeader({ view }: { view: ArtifactView }) {
  const askAbout = useStore((s) => s.askAbout);
  const readOnly = useStore((s) => s.readOnly);
  const artifacts = useStore((s) => s.artifacts);
  const revisions = useObjectRevisions(view);
  const { decide } = useNavigate();
  const proposalId =
    useStore((s) =>
      openProposals(s.proposals).find((p) =>
        p.changes.some((c) => c.artifactId === view.artifact.id),
      ),
    )?.id ?? null;
  const meta = typeMeta(view.artifact.type);
  const rev = view.revision;
  const loading = !revisions.revisions;
  const isBaseline = revisions.role === 'baseline';
  const others = otherDraftCount(revisions.revisions ?? [], revisions.baselineId, rev?.id ?? null);
  const fresh = freshnessLabel(view.freshness, view.staleReasons, artifacts);
  const ask = () =>
    askAbout(
      `About the Bureau ${meta.label.toLowerCase()} "${view.artifact.title}" (artifact ${view.artifact.id}${rev ? `, revision ${rev.seq}` : ''}): `,
    );
  return (
    <header className="stage-head">
      <div className="stage-kind">
        <TypeGlyph type={view.artifact.type} size={14} />
        <span>{meta.label}</span>
        {view.artifact.subsystem && (
          <>
            <CaretRight size={10} />
            <span>{view.artifact.subsystem}</span>
          </>
        )}
      </div>
      <div className="stage-title-row">
        <h1 className="copyable">{view.artifact.title}</h1>
        <Button size="sm" variant="ghost" icon={<At size={13} />} onClick={ask}>
          Ask agent
        </Button>
      </div>
      <div className="stage-states">
        {loading ? (
          <Skeleton width={180} height={22} />
        ) : !rev ? (
          <State state="draft" label="Nothing recorded" />
        ) : (
          <>
            <State
              state={rev.reviewState}
              label={isBaseline ? `Baseline · ${stateLabel(rev.reviewState)}` : undefined}
            />
            {isBaseline ? (
              <State state={view.freshness} label={fresh} />
            ) : (
              revisions.baselineId &&
              view.freshness !== 'current' && (
                <State
                  state={view.freshness}
                  label={`Baseline: ${(fresh ?? stateLabel(view.freshness)).toLowerCase()}`}
                  quiet
                />
              )
            )}
            {view.pendingProposal && (
              <button type="button" className="state-link" onClick={() => decide(proposalId)}>
                <State state="pending" label="Change in review" />
              </button>
            )}
            {others > 0 && (
              <State state="draft" label={`${others} other draft${others > 1 ? 's' : ''}`} quiet />
            )}
            <span className="stage-rev">Revision {rev.seq}</span>
          </>
        )}
        {readOnly && <State state="read-only" label="Read-only project" tone="neutral" />}
      </div>
    </header>
  );
}

const PROBLEM: Record<InputProblem, { tone: 'warn' | 'err'; baseline: string; other: string }> = {
  changed: {
    tone: 'warn',
    baseline: 'An input changed after this was recorded.',
    other: 'An input changed after the baseline was recorded.',
  },
  'not-approved': {
    tone: 'warn',
    baseline: 'An input is not yet approved.',
    other: 'An input of the baseline is not yet approved.',
  },
  missing: {
    tone: 'err',
    baseline: 'An input is missing.',
    other: 'An input of the baseline is missing.',
  },
};

const NONE: StaleRecord[] = [];

/**
 * Why the baseline is not current, as a path from the input that moved. The store computes
 * freshness for the baseline, so the copy says so whenever another revision is on screen.
 */
export function StaleNotice({ view }: { view: ArtifactView }) {
  const stale = useStore((s) => s.stale[view.artifact.id]) ?? NONE;
  const artifacts = useStore((s) => s.artifacts);
  const revisions = useObjectRevisions(view);
  if (!stale.length) return null;
  const onBaseline = revisions.role === 'baseline' || revisions.role === null;
  return (
    <div className="stale-notices">
      {stale.map((record, i) => {
        const problem = inputProblem(record, artifacts);
        const copy = PROBLEM[problem];
        return (
          <Notice key={i} tone={copy.tone}>
            <strong>{onBaseline ? copy.baseline : copy.other}</strong>{' '}
            <span className="impact-path">
              {record.path.map((pid, n) => (
                <React.Fragment key={`${pid}-${n}`}>
                  {n > 0 && <ArrowRight size={11} />}
                  {pid === view.artifact.id ? (
                    <span className="impact-self">this</span>
                  ) : (
                    <ObjectLink id={pid} className="impact-step" />
                  )}
                </React.Fragment>
              ))}
            </span>
            {problem === 'not-approved' && (
              <span className="dim">
                {' '}
                It exists as a draft; accept or approve it to clear this.
              </span>
            )}
          </Notice>
        );
      })}
    </div>
  );
}
