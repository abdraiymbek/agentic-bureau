import { OfferDetails, ProductImage } from '../ui/PartCard';
import React, { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { ArrowRight, Quotes } from '@phosphor-icons/react';
import type {
  ArtifactView,
  AssemblyPayload,
  AssumptionPayload,
  CalculationPayload,
  ComponentPayload,
  ConceptPayload,
  EvidenceKind,
  ImpactReport,
  MaybeQuantity,
  RequirementPayload,
  Offer,
  Revision,
  SoftwarePayload,
  SourcePayload,
  TestPayload,
  WiringPayload,
} from '@omenflow/contracts';
import { formatQty, isUnknown } from '@omenflow/contracts';
import { cmd, errMsg } from '../api';
import { useStore } from '../store';
import {
  Block,
  Button,
  Empty,
  Facts,
  Field,
  Notice,
  Segmented,
  State,
  TypeGlyph,
  relativeTime,
  shortId,
} from '../ui/kit';
import { ArtifactFiles } from './ArtifactFiles';
import { ExternalLink } from '../ui/ExternalLink';
import { MechanicalStage } from './MechanicalStage';

export function ObjectStage({
  view,
  onRevisionChange,
}: {
  view: ArtifactView;
  onRevisionChange?: (revision: Revision | null) => void;
}) {
  switch (view.artifact.type) {
    case 'requirement':
    case 'assumption':
      return <IntentStage view={view} />;
    case 'mechanical':
      return <MechanicalStage view={view} onRevisionChange={onRevisionChange} />;
    case 'calculation':
      return <CalculationStage view={view} />;
    case 'test':
      return <TestStage view={view} />;
    case 'wiring':
      return <WiringStage view={view} />;
    case 'component':
      return <ComponentStage view={view} />;
    case 'source':
      return <SourceStage view={view} />;
    case 'assembly':
      return <AssemblyStage view={view} />;
    default:
      return <DocumentStage view={view} />;
  }
}

function qty(q: MaybeQuantity | null | undefined) {
  if (q == null) return <span className="unknown">Not set</span>;
  if (isUnknown(q))
    return <span className="unknown">Unknown{'reason' in q ? ` — ${q.reason}` : ''}</span>;
  return formatQty(q);
}

/** Save bar that appears only when there is something to save. */
function SaveBar({
  dirty,
  busy,
  label,
  onSave,
  onDiscard,
  extra,
}: {
  dirty: boolean;
  busy?: boolean;
  label: string;
  onSave: () => void;
  onDiscard: () => void;
  extra?: React.ReactNode;
}) {
  return (
    <div className={`save-bar ${dirty ? 'dirty' : ''}`}>
      <span className="save-bar-state">
        {dirty ? 'Unsaved changes' : 'Recorded in this revision'}
      </span>
      <span className="grow" />
      {extra}
      {dirty && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDiscard}>
          Discard
        </Button>
      )}
      <Button size="sm" variant="primary" disabled={!dirty || busy} onClick={onSave}>
        {busy ? 'Saving…' : label}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Requirements and assumptions                                          */
/* ------------------------------------------------------------------ */

function IntentStage({ view }: { view: ArtifactView }) {
  const readOnly = useStore((s) => s.readOnly);
  const baseline = view.revision?.id === view.artifact.selectedRevisionId;
  return (
    <fieldset disabled={readOnly || !baseline} className="bare">
      {view.artifact.type === 'requirement' ? (
        <RequirementEditor view={view} />
      ) : (
        <AssumptionEditor view={view} />
      )}
    </fieldset>
  );
}

const UNITS = [
  'g',
  'kg',
  'mm',
  'cm',
  'm',
  'V',
  'A',
  'mA',
  'W',
  'Wh',
  'mAh',
  's',
  'min',
  'h',
  'N',
  'N*m',
  'rpm',
  'deg',
  '1',
  '%',
];

function RequirementEditor({ view }: { view: ArtifactView }) {
  const { toast, refreshArtifacts, focus } = useStore.getState();
  const p = (view.revision?.payload ?? {}) as RequirementPayload;
  const initial = () => {
    const t = p.target;
    return {
      statement: p.statement ?? '',
      value: t && !('unknown' in t) ? String(t.value) : '',
      unit: t && !('unknown' in t) ? t.unit : 'g',
      acceptance: p.acceptanceCriterion ?? '',
      priority: (p.priority ?? 'should') as 'must' | 'should' | 'could',
    };
  };
  const [form, setForm] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [impact, setImpact] = useState<ImpactReport | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    setForm(initial());
    setDirty(false);
    setImpact(null);
    generation.current++;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.revision?.id, view.revision?.payload]);
  const edit = (patch: Partial<ReturnType<typeof initial>>) => {
    setForm((f) => ({ ...f, ...patch }));
    setDirty(true);
  };
  const unknownTarget = p.target && 'unknown' in p.target;

  const save = async () => {
    if (!view.revision) return;
    if (form.value.trim() && !Number.isFinite(Number(form.value))) {
      toast('error', `Target must be a number — got “${form.value}”`);
      return;
    }
    setBusy(true);
    try {
      await cmd('artifact.apply_edit', {
        artifactId: view.artifact.id,
        baseRevisionId: view.revision.id,
        payload: {
          statement: form.statement,
          target: form.value.trim()
            ? { value: Number(form.value), unit: form.unit }
            : unknownTarget
              ? p.target
              : undefined,
          acceptanceCriterion: form.acceptance,
          priority: form.priority,
          sourceId: p.sourceId,
          verification: p.verification,
        },
        rationale: 'edit requirement',
      });
      toast('ok', 'Requirement saved — impact propagated to dependents');
      await refreshArtifacts();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const preview = async (append = false) => {
    if (!view.revision) return;
    const g = ++generation.current;
    setImpactLoading(true);
    try {
      const r = await cmd<ImpactReport>(
        'graph.impact',
        {
          refs: [{ artifactId: view.artifact.id, revisionId: view.revision.id }],
          offset: append ? (impact?.affected.length ?? 0) : 0,
          includePaths: false,
        },
        { projectId: useStore.getState().projectId ?? undefined },
      );
      if (g === generation.current)
        setImpact(append && impact ? { ...r, affected: [...impact.affected, ...r.affected] } : r);
    } catch (e) {
      if (g === generation.current) toast('error', errMsg(e));
    } finally {
      if (g === generation.current) setImpactLoading(false);
    }
  };

  return (
    <div className="doc">
      <label className="doc-statement">
        <span className="sr-only">Statement</span>
        <textarea
          rows={2}
          value={form.statement}
          placeholder="The system shall…"
          onChange={(e) => edit({ statement: e.target.value })}
        />
      </label>

      <div className="target">
        <div className="target-value">
          <span className="target-label">Target</span>
          <div className="target-input">
            <input
              className="num"
              aria-label="Target value"
              value={form.value}
              placeholder={unknownTarget ? 'Unknown' : '—'}
              onChange={(e) => edit({ value: e.target.value })}
            />
            <select
              aria-label="Target unit"
              value={form.unit}
              onChange={(e) => edit({ unit: e.target.value })}
            >
              {[...new Set([...UNITS, form.unit])].map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </div>
          {unknownTarget && !form.value && (
            <small className="unknown">
              Recorded as unknown: {(p.target as { reason: string }).reason}
            </small>
          )}
        </div>
        <div className="target-priority">
          <span className="target-label">Priority</span>
          <Segmented
            label="Priority"
            value={form.priority}
            onChange={(v) => edit({ priority: v })}
            options={[
              { value: 'must', label: 'Must' },
              { value: 'should', label: 'Should' },
              { value: 'could', label: 'Could' },
            ]}
          />
        </div>
      </div>

      <Field label="Accepted when">
        <textarea
          rows={2}
          value={form.acceptance}
          onChange={(e) => edit({ acceptance: e.target.value })}
        />
      </Field>
      {p.verification && <Facts rows={[['Verification', p.verification]]} />}

      <SaveBar
        dirty={dirty}
        busy={busy}
        label="Save requirement"
        onSave={() => void save()}
        onDiscard={() => {
          setForm(initial());
          setDirty(false);
        }}
        extra={
          <Button size="sm" variant="ghost" disabled={impactLoading} onClick={() => void preview()}>
            {impactLoading ? 'Tracing…' : 'Trace impact'}
          </Button>
        }
      />

      {impact && (
        <Block title="If this changes" count={impact.totalAffected ?? impact.affected.length}>
          {impact.affected.length === 0 ? (
            <p className="dim">No recorded dependents.</p>
          ) : (
            <ul className="impact-list">
              {impact.affected.map((a) => (
                <li key={a.artifactId}>
                  <button type="button" onClick={() => focus(a.artifactId)}>
                    <TypeGlyph type={a.type} size={13} />
                    {a.title}
                  </button>
                  <span className="dim">{a.reason}</span>
                </li>
              ))}
            </ul>
          )}
          {impact.hasMore && (
            <Button
              size="sm"
              variant="ghost"
              disabled={impactLoading}
              onClick={() => void preview(true)}
            >
              Show more ({impact.affected.length} of {impact.totalAffected})
            </Button>
          )}
        </Block>
      )}
    </div>
  );
}

function AssumptionEditor({ view }: { view: ArtifactView }) {
  const { toast, refreshArtifacts } = useStore.getState();
  const p = (view.revision?.payload ?? {}) as AssumptionPayload;
  const initial = () => ({
    statement: p.statement ?? '',
    reason: p.reason ?? '',
    owner: p.owner ?? '',
    needsValidation: p.needsValidation ?? true,
  });
  const [form, setForm] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setForm(initial());
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.revision?.id, view.revision?.payload]);
  const edit = (patch: Partial<ReturnType<typeof initial>>) => {
    setForm((f) => ({ ...f, ...patch }));
    setDirty(true);
  };
  const save = async () => {
    if (!view.revision) return;
    setBusy(true);
    try {
      await cmd('artifact.apply_edit', {
        artifactId: view.artifact.id,
        baseRevisionId: view.revision.id,
        payload: { ...form, value: p.value, uncertainty: p.uncertainty },
        rationale: 'edit assumption',
      });
      toast('ok', 'Assumption saved');
      await refreshArtifacts();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="doc">
      <Notice tone={form.needsValidation ? 'warn' : 'neutral'}>
        An assumption is not an established fact.{' '}
        {form.needsValidation ? 'It still needs validation.' : 'Marked as not needing validation.'}
      </Notice>
      <label className="doc-statement">
        <span className="sr-only">Assumption</span>
        <textarea
          rows={2}
          value={form.statement}
          onChange={(e) => edit({ statement: e.target.value })}
        />
      </label>
      {p.uncertainty && <Notice tone="warn">{p.uncertainty}</Notice>}
      {p.value && (
        <Facts
          rows={[
            [
              'Assumed value',
              <span className="num" key="v">
                {qty(p.value)}
              </span>,
            ],
          ]}
        />
      )}
      <Field label="Why we assume it">
        <textarea rows={2} value={form.reason} onChange={(e) => edit({ reason: e.target.value })} />
      </Field>
      <div className="field-row">
        <Field label="Owner">
          <input value={form.owner} onChange={(e) => edit({ owner: e.target.value })} />
        </Field>
        <div className="field">
          <span className="field-label">Needs validation</span>
          <Segmented
            label="Needs validation"
            value={form.needsValidation ? 'yes' : 'no'}
            onChange={(v) => edit({ needsValidation: v === 'yes' })}
            options={[
              { value: 'yes', label: 'Yes' },
              { value: 'no', label: 'No' },
            ]}
          />
        </div>
      </div>
      <SaveBar
        dirty={dirty}
        busy={busy}
        label="Save assumption"
        onSave={() => void save()}
        onDiscard={() => {
          setForm(initial());
          setDirty(false);
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Calculation                                                          */
/* ------------------------------------------------------------------ */

function CalculationStage({ view }: { view: ArtifactView }) {
  const readOnly = useStore((s) => s.readOnly);
  const artifacts = useStore((s) => s.artifacts);
  const { refreshArtifacts, refreshProposals, toast, decide, focus } = useStore.getState();
  const p = (view.revision?.payload ?? {}) as CalculationPayload;
  const [running, setRunning] = useState(false);
  const inputs = (p.inputs ?? []).map((i) => {
    const source = artifacts.find((v) => v.artifact.id === i.sourceRef?.artifactId);
    return {
      ...i,
      sourceTitle: source?.artifact.title,
      sourceMoved: !!i.sourceRef && source?.artifact.selectedRevisionId !== i.sourceRef.revisionId,
    };
  });
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
      const r = await cmd<{ proposal?: { id: string } }>('calculation.run', {
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
      await Promise.all([refreshArtifacts(), refreshProposals()]);
      toast('ok', 'Recorded inputs recalculated. The new result is waiting for your review.');
      decide(r?.proposal?.id ?? null);
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setRunning(false);
    }
  };

  const result = p.result?.quantity;
  const moved = inputs?.some((i) => i.sourceMoved);
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
      {moved && (
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

      <Block title="Inputs" count={inputs?.length}>
        {!inputs ? (
          <p className="dim">Reading recorded inputs…</p>
        ) : !inputs.length ? (
          <p className="dim">No recorded inputs.</p>
        ) : (
          <div className="calc-inputs">
            {inputs.map((i) => (
              <div key={i.name} className={`calc-input ${i.sourceMoved ? 'moved' : ''}`}>
                <span className="mono calc-name">{i.name}</span>
                <span className="calc-eq">=</span>
                <span className="num calc-q">{qty(i.quantity)}</span>
                <span className="calc-src">
                  {i.sourceRef ? (
                    <button
                      type="button"
                      className="cell-link"
                      onClick={() => focus(i.sourceRef!.artifactId)}
                    >
                      {i.sourceTitle ?? shortId(i.sourceRef.artifactId)}
                    </button>
                  ) : (
                    <span className="dim">{i.literal ? 'literal' : 'No source recorded'}</span>
                  )}
                  {i.sourceMoved && <State state="stale" label="Source changed" quiet />}
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
          Re-running creates a proposal on this calculation. It never rewrites bindings or certifies
          a changed design.
        </p>
        <Button
          variant="primary"
          disabled={
            running ||
            !view.revision ||
            readOnly ||
            view.revision.id !== view.artifact.selectedRevisionId
          }
          onClick={() => void rerun()}
        >
          {running ? 'Calculating…' : 'Re-run recorded inputs'}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Test                                                                 */
/* ------------------------------------------------------------------ */

function TestStage({ view }: { view: ArtifactView }) {
  const readOnly = useStore((s) => s.readOnly);
  const { refreshArtifacts, toast } = useStore.getState();
  const p = (view.revision?.payload ?? {}) as TestPayload;
  const [obs, setObs] = useState('');
  const [result, setResult] = useState<'passed' | 'failed' | 'inconclusive' | 'not_run' | ''>('');
  const [evidence, setEvidence] = useState<EvidenceKind | ''>('');
  const [busy, setBusy] = useState(false);
  const record = async () => {
    if (!result || !evidence || !obs.trim()) return;
    setBusy(true);
    try {
      await cmd('test.record_result', {
        artifactId: view.artifact.id,
        result,
        observation: obs.trim(),
        evidenceKind: evidence,
        conditions: p.conditions,
        attachments: [],
      });
      await refreshArtifacts();
      toast('ok', 'Result recorded');
      setObs('');
      setResult('');
      setEvidence('');
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="doc">
      <Block title="Procedure" count={p.procedure?.length}>
        <ol className="steps">
          {(p.procedure ?? []).map((s) => (
            <li key={s.step}>
              <span className="step-n num">{s.step}</span>
              <div>
                <p>{s.instruction}</p>
                {s.expected && <small>Expected · {s.expected}</small>}
              </div>
            </li>
          ))}
        </ol>
      </Block>
      {p.conditions && <Facts rows={[['Conditions', p.conditions]]} />}

      <Block title="Results" count={p.results?.length}>
        {(p.results ?? []).length ? (
          <ul className="results">
            {p.results.map((r) => (
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
        <fieldset
          disabled={readOnly || busy || view.revision?.id !== view.artifact.selectedRevisionId}
          className="bare stack"
        >
          <div className="field-row">
            <Field label="Outcome">
              <select value={result} onChange={(e) => setResult(e.target.value as typeof result)}>
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
                value={evidence}
                onChange={(e) => setEvidence(e.target.value as EvidenceKind)}
              >
                <option value="" disabled>
                  Choose
                </option>
                {['measured', 'simulated', 'calculated', 'sourced', 'assumed'].map((k) => (
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
            <textarea rows={3} value={obs} onChange={(e) => setObs(e.target.value)} />
          </Field>
          <div>
            <Button
              variant="primary"
              onClick={() => void record()}
              disabled={!result || !evidence || !obs.trim() || busy}
            >
              {busy ? 'Recording…' : 'Record result'}
            </Button>
          </div>
        </fieldset>
      </Block>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Wiring                                                               */
/* ------------------------------------------------------------------ */

function WiringStage({ view }: { view: ArtifactView }) {
  const artifacts = useStore((s) => s.artifacts);
  const { toast, focus } = useStore.getState();
  const p = (view.revision?.payload ?? {}) as WiringPayload;
  const [findings, setFindings] = useState<
    { severity: string; code: string; message: string }[] | null
  >(null);
  const [coverage, setCoverage] = useState('');
  const [busy, setBusy] = useState(false);
  const [diagram, setDiagram] = useState<string | null>(null);
  const title = (id: string) =>
    artifacts.find((v) => v.artifact.id === id)?.artifact.title ?? shortId(id);
  const validate = async () => {
    setBusy(true);
    try {
      const r = await cmd<{
        findings: { severity: string; code: string; message: string }[];
        coverage: string;
      }>('wiring.validate', { artifactId: view.artifact.id, revisionId: view.revision?.id });
      setFindings(r.findings);
      setCoverage(r.coverage);
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const [diagramError, setDiagramError] = useState('');
  const [drawAttempt, setDrawAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setDiagram(null);
    setDiagramError('');
    void cmd<{ diagramSvg: string }>('wiring.render', {
      artifactId: view.artifact.id,
      revisionId: view.revision?.id,
    })
      .then((r) => {
        if (active) {
          if (!r.diagramSvg) setDiagramError('The renderer returned no diagram.');
          else setDiagram(r.diagramSvg);
        }
      })
      .catch((e) => active && setDiagramError(errMsg(e)));
    return () => {
      active = false;
    };
  }, [view.artifact.id, view.revision?.id, drawAttempt]);
  const readable = (m: string) =>
    m.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, (id) => {
      const component = artifacts.find((v) => v.artifact.id === id);
      if (component) return component.artifact.title;
      const n = (p.connections ?? []).findIndex((c) => c.id === id);
      return n >= 0 ? `connection ${n + 1}` : id;
    });
  return (
    <div className="doc wide">
      <div className="stage-toolbar">
        <Button size="sm" disabled={busy} onClick={() => void validate()}>
          {busy ? 'Checking…' : 'Validate wiring'}
        </Button>
        <Button size="sm" onClick={() => setDrawAttempt((n) => n + 1)}>
          Draw diagram
        </Button>
      </div>
      {findings && (
        <Block title="Findings" count={findings.length}>
          {findings.length === 0 ? (
            <p className="tone-ok-text">No findings within the checked coverage.</p>
          ) : (
            <ul className="findings">
              {findings.map((f, i) => (
                <li key={i}>
                  <State
                    state={
                      f.severity === 'error'
                        ? 'failed'
                        : f.severity === 'warning'
                          ? 'stale'
                          : 'info'
                    }
                    label={
                      f.severity === 'error'
                        ? 'Error'
                        : f.severity === 'warning'
                          ? 'Warning'
                          : 'Info'
                    }
                    tone={f.severity === 'info' ? 'neutral' : undefined}
                    quiet
                  />
                  <span>{readable(f.message)}</span>
                </li>
              ))}
            </ul>
          )}
          {coverage && <p className="footnote">{coverage}</p>}
        </Block>
      )}
      {p.coverageNote && <Notice>{p.coverageNote}</Notice>}
      {diagramError ? (
        <Notice tone="err">Diagram unavailable: {diagramError}</Notice>
      ) : (
        !diagram && (
          <p role="status" className="dim">
            Drawing recorded wiring…
          </p>
        )
      )}
      {diagram && (
        <div
          className="diagram wiring-diagram island"
          dangerouslySetInnerHTML={{
            __html: DOMPurify.sanitize(diagram, { USE_PROFILES: { svg: true } }),
          }}
        />
      )}
      <Block title="Pins" count={p.pins?.length ?? 0}>
        {!p.pins?.length ? (
          <p className="dim">No pin definitions recorded.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Pin</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Voltage range</th>
                </tr>
              </thead>
              <tbody>
                {p.pins.map((pin, i) => (
                  <tr key={i}>
                    <td>
                      <button
                        type="button"
                        className="cell-link"
                        onClick={() => focus(pin.componentArtifactId)}
                      >
                        {title(pin.componentArtifactId)}
                      </button>
                    </td>
                    <td className="mono">{pin.pin}</td>
                    <td>{pin.name ?? '—'}</td>
                    <td>{pin.type}</td>
                    <td className="num">
                      {pin.voltageRange
                        ? `${formatQty(pin.voltageRange.min)} – ${formatQty(pin.voltageRange.max)}`
                        : 'Unknown'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Block>
      <Block title="Connections" count={p.connections?.length ?? 0}>
        {!p.connections?.length && (
          <p className="dim">
            No connections recorded. Ask the agent to populate the wiring pins and connections.
          </p>
        )}
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>From</th>
                <th>To</th>
                <th>Signal</th>
                <th className="num">Voltage</th>
                <th>Wire</th>
              </tr>
            </thead>
            <tbody>
              {(p.connections ?? []).map((c, i) => (
                <tr key={c.id ?? i}>
                  <td>
                    <button
                      type="button"
                      className="cell-link"
                      onClick={() => focus(c.from.componentArtifactId)}
                    >
                      {title(c.from.componentArtifactId)}
                    </button>
                    <small className="cell-sub mono">{c.from.pin}</small>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="cell-link"
                      onClick={() => focus(c.to.componentArtifactId)}
                    >
                      {title(c.to.componentArtifactId)}
                    </button>
                    <small className="cell-sub mono">{c.to.pin}</small>
                  </td>
                  <td>
                    {c.signalRole}
                    {c.polarity && <small className="cell-sub">Polarity · {c.polarity}</small>}
                    {c.notes && <small className="cell-sub">{c.notes}</small>}
                  </td>
                  <td className="num">{c.voltage ? formatQty(c.voltage) : '—'}</td>
                  <td className="dim">
                    {c.wire?.gauge ?? '—'}
                    {c.wire?.currentRating ? ` · ${formatQty(c.wire.currentRating)}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Block>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Component, source, assembly                                          */
/* ------------------------------------------------------------------ */

function ComponentStage({ view }: { view: ArtifactView }) {
  const artifacts = useStore((s) => s.artifacts);
  const focus = useStore((s) => s.focus);
  const p = (view.revision?.payload ?? {}) as ComponentPayload;
  const props = Object.entries(p.properties ?? {});
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [offerError, setOfferError] = useState('');
  const projectId = useStore((s) => s.projectId);
  const events = useStore((s) => s.events);
  useEffect(() => {
    let active = true;
    void cmd<{ components: { offers: Offer[] }[] }>(
      'component.compare',
      { artifactIds: [view.artifact.id] },
      { projectId: projectId ?? undefined },
    )
      .then((r) => {
        if (active) {
          setOffers(r.components[0]?.offers ?? []);
          setOfferError('');
        }
      })
      .catch((e) => active && setOfferError(errMsg(e)));
    return () => {
      active = false;
    };
  }, [view.artifact.id, projectId, events]);
  return (
    <div className="doc">
      <div className="component-product">
        <ProductImage url={p.imageUrl} name={view.artifact.title} />
        {p.selectionReason && (
          <p className="part-reason">
            <span>Why this part</span>
            {p.selectionReason}
          </p>
        )}
      </div>
      {p.description && <p className="doc-lede">{p.description}</p>}
      <div className="spec-head">
        <div>
          <span className="target-label">Part number</span>
          <strong className="mono">{p.partNumber ?? 'Unknown'}</strong>
        </div>
        <div>
          <span className="target-label">Maker</span>
          <strong>{p.manufacturer ?? p.vendor ?? 'Unknown'}</strong>
        </div>
        <div>
          <span className="target-label">Selection</span>
          <State state={p.status ?? 'candidate'} />
        </div>
      </div>
      <Block title="Engineering properties" count={props.length}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Property</th>
                <th className="num">Value</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {props.map(([key, value]) => (
                <tr key={key}>
                  <td>{key.replaceAll('_', ' ')}</td>
                  <td className="num">
                    {value.quantity ? (
                      qty(value.quantity)
                    ) : (
                      <span className="unknown">Unknown</span>
                    )}
                  </td>
                  <td>
                    {value.sourceId ? (
                      <button
                        type="button"
                        className="cell-link"
                        onClick={() => focus(value.sourceId!)}
                      >
                        <TypeGlyph type="source" size={13} />
                        {artifacts.find((v) => v.artifact.id === value.sourceId)?.artifact.title ??
                          'Recorded source'}
                      </button>
                    ) : (
                      <span className="unknown">No source recorded</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Block>
      {Object.keys(p.attributes ?? {}).length > 0 && (
        <Block title="Attributes">
          <Facts
            rows={Object.entries(p.attributes).map(([name, fact]) => [
              name,
              <span key={name}>
                {fact.value}
                {fact.sourceId && (
                  <>
                    {' '}
                    ·{' '}
                    <button
                      type="button"
                      className="cell-link"
                      onClick={() => focus(fact.sourceId!)}
                    >
                      Recorded source
                    </button>
                  </>
                )}
                {fact.locator && <small className="cell-sub">{fact.locator}</small>}
              </span>,
            ])}
          />
        </Block>
      )}
      <Block title="Supplier offers" count={offers?.length}>
        {offerError ? (
          <Notice tone="err">Offers didn’t load: {offerError}</Notice>
        ) : !offers ? (
          <p role="status" className="dim">
            Reading offers…
          </p>
        ) : !offers.length ? (
          <p className="dim">
            No supplier offer recorded. Ask the agent to capture a product link and offer.
          </p>
        ) : (
          <ul className="results">
            {offers.map((offer) => (
              <li key={offer.id}>
                <OfferDetails offer={offer} />
                {offer.sourceId && (
                  <button
                    type="button"
                    className="cell-link"
                    onClick={() => focus(offer.sourceId!)}
                  >
                    Recorded source
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Block>
      {p.missingFields?.length > 0 && (
        <Notice tone="warn">Missing: {p.missingFields.join(', ')}</Notice>
      )}
    </div>
  );
}

function SourceStage({ view }: { view: ArtifactView }) {
  const p = (view.revision?.payload ?? {}) as SourcePayload;
  return (
    <div className="doc">
      {p.excerpt ? (
        <blockquote className="excerpt">
          <Quotes size={18} weight="fill" />
          {p.excerpt}
        </blockquote>
      ) : (
        <p className="dim">No excerpt was captured for this source.</p>
      )}
      <Facts
        rows={[
          ['Publisher', p.publisher ?? 'Unknown'],
          ['Kind', p.sourceKind ?? 'Unknown'],
          ['Captured', p.retrievedAt ? new Date(p.retrievedAt).toLocaleString() : 'Unknown'],
          ...(p.locator ? ([['Location', p.locator]] as [string, React.ReactNode][]) : []),
        ]}
      />
      {p.url && <ExternalLink url={p.url} />}
      {p.fileHash && (
        <Facts
          rows={[
            [
              'Captured file',
              <span className="mono" key="hash">
                {p.fileHash}
              </span>,
            ],
          ]}
        />
      )}
    </div>
  );
}

function AssemblyStage({ view }: { view: ArtifactView }) {
  const artifacts = useStore((s) => s.artifacts);
  const focus = useStore((s) => s.focus);
  const p = (view.revision?.payload ?? {}) as AssemblyPayload;
  if (!p.steps?.length)
    return (
      <Empty
        title="No steps recorded"
        body="Ask your agent to draft the build sequence, tools, and calibration."
      />
    );
  return (
    <div className="doc">
      <ol className="steps">
        {p.steps.map((s) => (
          <li key={s.order}>
            <span className="step-n num">{s.order}</span>
            <div>
              <p>{s.instruction}</p>
              {s.tools.length > 0 && <small>Tools · {s.tools.join(', ')}</small>}
              {s.calibration && <Notice>Calibration · {s.calibration}</Notice>}
              {s.componentRefs.length > 0 && (
                <div className="chips">
                  {s.componentRefs.map((id) => (
                    <button type="button" key={id} className="chip" onClick={() => focus(id)}>
                      <TypeGlyph type="component" size={12} />
                      {artifacts.find((v) => v.artifact.id === id)?.artifact.title ?? shortId(id)}
                      <ArrowRight size={11} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Documents: concept, architecture, subsystem, software, note          */
/* ------------------------------------------------------------------ */

const TEXT_KEYS = ['markdown', 'statement', 'description', 'body', 'notes'];

function DocumentStage({ view }: { view: ArtifactView }) {
  const readOnly = useStore((s) => s.readOnly);
  const { refreshArtifacts, toast } = useStore.getState();
  const rev = view.revision;
  const payload = (rev?.payload ?? {}) as Record<string, unknown>;
  const key =
    TEXT_KEYS.find((k) => typeof payload[k] === 'string') ??
    (view.artifact.type === 'software'
      ? 'notes'
      : view.artifact.type === 'subsystem' || view.artifact.type === 'concept'
        ? 'description'
        : 'markdown');
  const current = typeof payload[key] === 'string' ? (payload[key] as string) : '';
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(current);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setText(current);
    setEditing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev?.id]);
  const save = async () => {
    if (!rev) return;
    setBusy(true);
    try {
      await cmd('artifact.apply_edit', {
        artifactId: view.artifact.id,
        baseRevisionId: rev.id,
        payload: { ...payload, [key]: text },
        rationale: 'edit text',
      });
      await refreshArtifacts();
      setEditing(false);
      toast('ok', 'Saved');
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const software = view.artifact.type === 'software' ? (payload as Partial<SoftwarePayload>) : null;
  const concept = view.artifact.type === 'concept' ? (payload as Partial<ConceptPayload>) : null;
  return (
    <div className="doc">
      {software && (
        <Facts
          rows={[
            ['Language', software.language ?? 'Not specified'],
            [
              'Entry point',
              <span className="mono" key="e">
                {software.entryPoint ?? 'Not specified'}
              </span>,
            ],
          ]}
        />
      )}
      <div className="stage-toolbar">
        <Button
          size="sm"
          variant="ghost"
          disabled={readOnly || !rev || rev.id !== view.artifact.selectedRevisionId}
          onClick={() => setEditing((e) => !e)}
        >
          {editing ? 'Preview' : 'Edit text'}
        </Button>
        {editing && (
          <Button
            size="sm"
            variant="primary"
            disabled={
              readOnly || busy || text === current || rev?.id !== view.artifact.selectedRevisionId
            }
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        )}
      </div>
      {editing ? (
        <textarea
          aria-label="Object text"
          className="code-editor prose-editor"
          rows={18}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      ) : current ? (
        <div
          className="prose"
          dangerouslySetInnerHTML={{
            __html: DOMPurify.sanitize(marked.parse(current, { async: false }) as string),
          }}
        />
      ) : (
        <p className="dim">No text recorded.</p>
      )}
      {typeof payload.diagramSvg === 'string' && (
        <div
          className="diagram island"
          dangerouslySetInnerHTML={{
            __html: DOMPurify.sanitize(payload.diagramSvg, { USE_PROFILES: { svg: true } }),
          }}
        />
      )}
      {concept && Object.keys(concept.approxDimensions ?? {}).length > 0 && (
        <Block title="Approximate dimensions">
          <Facts
            rows={Object.entries(concept.approxDimensions!).map(([name, q]) => [
              name,
              <span className="num" key={name}>
                {qty(q)}
              </span>,
            ])}
          />
        </Block>
      )}
      {concept &&
        [
          { title: 'Systems', items: concept.systems },
          { title: 'Alternatives', items: concept.alternatives },
          { title: 'Uncertainties', items: concept.uncertainties },
        ].map(
          (s) =>
            (s.items?.length ?? 0) > 0 && (
              <Block key={s.title} title={s.title} count={s.items!.length}>
                <ul className="plain-list">
                  {s.items!.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </Block>
            ),
        )}
      {rev && (
        <ArtifactFiles
          revision={rev}
          visualPath={concept?.visualFile?.path}
          files={[
            ...new Map(
              [
                ...rev.files,
                ...(software?.files ?? []),
                ...(concept?.visualFile ? [concept.visualFile] : []),
              ].map((f) => [f.path, f]),
            ).values(),
          ]}
        />
      )}
    </div>
  );
}
