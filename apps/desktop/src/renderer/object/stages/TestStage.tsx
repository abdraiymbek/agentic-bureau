import React, { useState } from 'react';
import type { EvidenceKind, Revision, TestPayload } from '@bureau/contracts';
import { cmd, errMsg } from '../../api';
import { useStore } from '../../store';
import { Block, Button, Facts, Field, Notice, State } from '../../ui/kit';
import { useObjectRevisions } from '../revisions';
import { useParkedForm } from '../useParkedForm';
import { Steps, type StageProps } from './shared';

type Outcome = 'passed' | 'failed' | 'inconclusive' | 'not_run';
type ResultForm = {
  observation: string;
  result: Outcome | '';
  evidence: EvidenceKind | '';
  revisionId: string | null;
  revisionSeq: number | null;
  conditions: string | undefined;
};
const EMPTY: ResultForm = {
  observation: '',
  result: '',
  evidence: '',
  revisionId: null,
  revisionSeq: null,
  conditions: undefined,
};
const EVIDENCE: EvidenceKind[] = ['measured', 'simulated', 'calculated', 'sourced', 'assumed'];

export function TestStage({ view }: StageProps) {
  const readOnly = useStore((s) => s.readOnly);
  const projectId = useStore((s) => s.projectId);
  const toast = useStore((s) => s.toast);
  const revisions = useObjectRevisions(view);
  const p = (view.revision?.payload ?? {}) as Partial<TestPayload>;
  const { form, edit, clear } = useParkedForm<ResultForm>(
    `${projectId}:${view.artifact.id}:result`,
    `unrecorded result for “${view.artifact.title}”`,
    EMPTY,
    (f) => !!(f.observation.trim() || f.result || f.evidence),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The core appends a result to the baseline, or to the newest revision when none is approved.
  const history = revisions.revisions ?? [];
  const recordsOnto =
    history.find((r) => r.id === revisions.baselineId) ??
    (revisions.baselineId
      ? null
      : history.reduce<Revision | null>((top, r) => (!top || r.seq > top.seq ? r : top), null));
  const block = readOnly
    ? 'This project is read-only.'
    : !view.revision
      ? 'Nothing is recorded to attach a result to.'
      : recordsOnto && recordsOnto.id !== view.revision.id
        ? `A result is recorded onto r${recordsOnto.seq}. Show r${recordsOnto.seq} to record one.`
        : null;
  const ready = !!form.result && !!form.evidence && !!form.observation.trim();
  const contextChanged = !!form.revisionId && form.revisionId !== recordsOnto?.id;
  const editResult = (patch: Partial<ResultForm>) => {
    edit(
      form.revisionId
        ? patch
        : {
            revisionId: view.revision?.id ?? null,
            revisionSeq: view.revision?.seq ?? null,
            conditions: p.conditions,
            ...patch,
          },
    );
  };

  const record = async () => {
    if (!ready || block || contextChanged || !form.revisionId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await cmd<{ revision: Revision }>('test.record_result', {
        artifactId: view.artifact.id,
        expectedRevisionId: form.revisionId,
        result: form.result,
        observation: form.observation.trim(),
        evidenceKind: form.evidence,
        conditions: form.conditions,
        attachments: [],
      });
      clear();
      // Whichever revision the core recorded the result on is the one to show.
      await revisions.saved(r.revision.id);
      toast('ok', `Result recorded on revision ${r.revision.seq}`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const results = p.results ?? [];
  return (
    <div className="doc">
      <Block title="Procedure" count={p.procedure?.length}>
        <Steps
          steps={(p.procedure ?? []).map((s) => ({
            n: s.step,
            key: s.step,
            body: (
              <>
                <p>{s.instruction}</p>
                {s.expected && <small>Expected · {s.expected}</small>}
              </>
            ),
          }))}
        />
      </Block>
      {p.conditions && <Facts rows={[['Conditions', p.conditions]]} />}

      <Block title="Results" count={results.length}>
        {results.length ? (
          <ul className="results">
            {results.map((r) => (
              <li key={r.id}>
                <div className="row">
                  <State state={r.result} />
                  <span className="dim">{r.evidenceKind}</span>
                  <span className="grow" />
                  <small className="dim">
                    {new Date(r.recordedAt).toLocaleString()} · {r.recordedBy}
                  </small>
                </div>
                <p>{r.observation}</p>
                <Facts
                  rows={[
                    ...(r.conditions
                      ? [['Conditions', r.conditions] as [string, React.ReactNode]]
                      : []),
                    ...(r.units ? [['Units', r.units] as [string, React.ReactNode]] : []),
                    ...(r.measurementOrigin
                      ? [['Measurement origin', r.measurementOrigin] as [string, React.ReactNode]]
                      : []),
                  ]}
                />
                {r.attachments?.length > 0 && (
                  <p className="mono">
                    Attachments · {r.attachments.map((f) => f.path).join(', ')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="dim">Not run yet. A plan is not evidence.</p>
        )}
      </Block>

      <Block title="Record a result" className="record-result">
        {block && <p className="footnote">{block}</p>}
        {contextChanged && (
          <Notice
            tone="warn"
            action={
              !block &&
              recordsOnto && (
                <Button
                  size="sm"
                  onClick={() =>
                    edit({
                      revisionId: recordsOnto.id,
                      revisionSeq: recordsOnto.seq,
                      conditions: p.conditions,
                    })
                  }
                >
                  I reviewed r{recordsOnto.seq}; use this procedure
                </Button>
              )
            }
          >
            This observation was entered against r{form.revisionSeq}. The test has changed. Your
            observation is kept; review the current procedure and conditions before recording it.
          </Notice>
        )}
        <fieldset disabled={!!block || busy} className="bare stack">
          <div className="field-row">
            <Field label="Outcome">
              <select
                value={form.result}
                onChange={(e) => editResult({ result: e.target.value as Outcome })}
              >
                <option value="" disabled>
                  Choose
                </option>
                <option value="passed">Passed</option>
                <option value="failed">Failed</option>
                <option value="inconclusive">Inconclusive</option>
                <option value="not_run">Not run</option>
              </select>
            </Field>
            <Field label="Evidence">
              <select
                value={form.evidence}
                onChange={(e) => editResult({ evidence: e.target.value as EvidenceKind })}
              >
                <option value="" disabled>
                  Choose
                </option>
                {EVIDENCE.map((k) => (
                  <option key={k} value={k}>
                    {k[0]!.toUpperCase() + k.slice(1)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field
            label="Observation"
            hint="What happened, with measurements, units, and conditions."
          >
            <textarea
              rows={3}
              value={form.observation}
              onChange={(e) => editResult({ observation: e.target.value })}
            />
          </Field>
          {error && (
            <Notice tone="err" role="alert">
              Not recorded: {error}
            </Notice>
          )}
          <div className="row">
            <Button
              variant="primary"
              busy={busy}
              onClick={() => void record()}
              disabled={!ready || contextChanged || !form.revisionId}
            >
              Record result
            </Button>
            <span className="footnote">
              Recording adds a revision that carries this result. It cannot be edited afterwards.
            </span>
          </div>
        </fieldset>
      </Block>
    </div>
  );
}
