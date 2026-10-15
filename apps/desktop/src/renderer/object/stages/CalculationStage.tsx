import React, { useEffect, useMemo, useState } from 'react';
import type { CalculationPayload, Revision } from '@omenflow/contracts';
import { cmd, errMsg } from '../../api';
import { useStore } from '../../store';
import { Block, Button, Notice, State, relativeTime, shortId } from '../../ui/kit';
import { useObjectRevisions } from '../revisions';
import { inputSource, rerunOutcome, type RerunResult } from './calculation';
import { ObjectLink, qty, useNavigate, type StageProps } from './shared';

/**
 * Revision numbers of the sources whose pinned revision is not their baseline, read from each
 * source's history once: a pin names `rN` like every other rail, never a guessed number.
 */
function usePinnedSeqs(sourceIds: string[]) {
  const projectId = useStore((s) => s.projectId);
  const [histories, setHistories] = useState<Record<string, Map<string, number> | 'failed'>>({});
  const key = sourceIds.join(' ');
  useEffect(() => {
    let live = true;
    for (const artifactId of key ? key.split(' ') : []) {
      if (histories[artifactId]) continue;
      cmd<{ revisions: Revision[] }>(
        'artifact.history',
        { artifactId },
        { projectId: projectId ?? undefined },
      ).then(
        (r) => {
          if (live)
            setHistories((h) => ({
              ...h,
              [artifactId]: new Map(r.revisions.map((rev) => [rev.id, rev.seq])),
            }));
        },
        () => {
          if (live) setHistories((h) => ({ ...h, [artifactId]: 'failed' }));
        },
      );
    }
    return () => {
      live = false;
    };
    // Each source's history is read once; the pinned revision's number never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, projectId]);
  return (artifactId: string, revisionId: string): number | 'loading' | null => {
    const history = histories[artifactId];
    if (!history) return 'loading';
    return history === 'failed' ? null : (history.get(revisionId) ?? null);
  };
}

export function CalculationStage({ view }: StageProps) {
  const readOnly = useStore((s) => s.readOnly);
  const artifacts = useStore((s) => s.artifacts);
  const toast = useStore((s) => s.toast);
  const revisions = useObjectRevisions(view);
  const { decide } = useNavigate();
  const p = (view.revision?.payload ?? {}) as Partial<CalculationPayload>;
  const [running, setRunning] = useState(false);
  const movedSources = useMemo(
    () =>
      [
        ...new Set(
          (p.inputs ?? []).flatMap((i) => {
            const ref = i.sourceRef;
            const source = ref && artifacts.find((v) => v.artifact.id === ref.artifactId);
            return source && source.artifact.selectedRevisionId !== ref.revisionId
              ? [ref.artifactId]
              : [];
          }),
        ),
      ].sort(),
    [p.inputs, artifacts],
  );
  const seqOf = usePinnedSeqs(movedSources);
  const inputs = (p.inputs ?? []).map((i) => ({ ...i, source: inputSource(i, artifacts, seqOf) }));
  const rerun = async () => {
    setRunning(true);
    try {
      const templates = p.templateId
        ? await cmd<{ templates: { id: string; assumptions?: string[] }[] }>(
            'calculation.templates',
            {},
          )
        : { templates: [] };
      const inherited = templates.templates.find((t) => t.id === p.templateId)?.assumptions ?? [];
      const r = await cmd<RerunResult>('calculation.run', {
        artifactId: view.artifact.id,
        templateId: p.templateId,
        expression: p.expression,
        inputs: (p.inputs ?? []).map((i) => ({
          name: i.name,
          quantity: i.quantity,
          sourceRef: i.sourceRef,
          literal: i.literal,
        })),
        assumptions: (p.assumptions ?? []).filter((a) => !inherited.includes(a)),
        title: view.artifact.title,
        submitForReview: true,
      });
      const outcome = rerunOutcome(r);
      if (outcome.kind === 'unchanged') {
        toast('info', outcome.message);
        return;
      }
      await revisions.reload();
      toast('ok', outcome.message);
      if (outcome.kind === 'proposed') decide(outcome.proposalId);
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setRunning(false);
    }
  };

  const result = p.result?.quantity;
  const anyMoved = inputs.some((i) => i.source?.moved);
  const rerunBlock = readOnly
    ? 'This project is read-only.'
    : !view.revision
      ? 'Nothing is recorded to re-run.'
      : revisions.role !== 'baseline'
        ? 'Re-running starts from the baseline. Show the baseline to re-run it.'
        : null;
  return (
    <div className="calc">
      <div className="calc-result">
        <span className="calc-label">Result</span>
        <output className="calc-value num">
          {result !== undefined ? qty(result) : p.result?.text || qty(result)}
        </output>
        {result !== undefined && p.result?.text && <p>{p.result.text}</p>}
        <span className="calc-meta">
          {p.evidenceKind} evidence
          {p.toolVersion ? ` · tool ${p.toolVersion}` : ''}
          {p.ranAt ? ` · ran ${relativeTime(p.ranAt)}` : ''}
        </span>
      </div>

      <Notice tone="warn">
        Experimental calculation. Referenced sources are labels, not resolved field values; derived
        units are incomplete. This result is not verified engineering evidence.
      </Notice>
      {anyMoved && (
        <Notice tone="warn">
          An input source has changed. This result uses the recorded values below — ask the agent to
          update the bindings before recalculating for the new design.
        </Notice>
      )}

      <Block title="Expression">
        <code className="calc-expr">
          <span className="dim">{p.templateId ?? 'expression'} ·</span> {p.expression ?? ''}
        </code>
      </Block>

      <Block title="Inputs" count={inputs.length}>
        {!inputs.length ? (
          <p className="dim">No recorded inputs.</p>
        ) : (
          <div className="calc-inputs">
            {inputs.map((i) => (
              <div key={i.name} className={`calc-input ${i.source?.moved ? 'moved' : ''}`}>
                <span className="mono calc-name">{i.name}</span>
                <span className="calc-eq">=</span>
                <span className="num calc-q">{qty(i.quantity)}</span>
                <span className="calc-src">
                  {i.sourceRef && i.source ? (
                    <>
                      <span className="calc-src-line">
                        {i.source.available ? (
                          <ObjectLink id={i.sourceRef.artifactId} glyph />
                        ) : (
                          <span className="unknown">
                            Unavailable · {shortId(i.sourceRef.artifactId)}
                          </span>
                        )}
                        {i.source.moved && <State state="stale" label="Source changed" quiet />}
                      </span>
                      <small className="calc-pin">{i.source.pin}</small>
                    </>
                  ) : (
                    <span className="calc-src-line">
                      <span className="dim">
                        {i.literal ? 'Literal value, no source' : 'No source recorded'}
                      </span>
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </Block>

      {(p.assumptions ?? []).length > 0 && (
        <Block title="Assumptions">
          <ul className="plain-list">
            {p.assumptions!.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </Block>
      )}
      {(p.limitations ?? []).length > 0 && (
        <Block title="Limitations">
          <ul className="plain-list tone-warn-text">
            {p.limitations!.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </Block>
      )}

      <div className="stage-actions">
        <p className="dim">
          {rerunBlock ??
            'Re-running uses the recorded input values above. A different result is proposed on this calculation; the same result records nothing new. It never rewrites bindings or certifies a changed design.'}
        </p>
        <Button
          variant="primary"
          busy={running}
          disabled={!!rerunBlock}
          onClick={() => void rerun()}
        >
          Re-run recorded inputs
        </Button>
      </div>
    </div>
  );
}
