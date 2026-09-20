import React, { useEffect, useState } from 'react';
import { cmd, errMsg, CommandError } from '../api';
import { useStore } from '../store';
import type {
  ArtifactView,
  RequirementPayload,
  AssumptionPayload,
  Revision,
} from '@omenflow/contracts';
import {
  ArtifactIcon,
  EmptyState,
  FormField,
  ObjectRow,
  PageHeader,
  SearchField,
  StatusBadge,
} from '../components/ui';
import { InspectButton } from '../components/InspectButton';

export function RequirementsView() {
  const { artifacts, selectedArtifactId, selectArtifact } = useStore();
  const [query, setQuery] = useState('');
  const reqs = artifacts.filter((v) => v.artifact.type === 'requirement');
  const asms = artifacts.filter((v) => v.artifact.type === 'assumption');
  const selected =
    [...reqs, ...asms].find((v) => v.artifact.id === selectedArtifactId) ?? reqs[0] ?? asms[0];
  useEffect(() => {
    if (selected && selected.artifact.id !== selectedArtifactId)
      selectArtifact(selected.artifact.id);
  }, [selected, selectedArtifactId, selectArtifact]);
  const matches = (v: ArtifactView) => v.artifact.title.toLowerCase().includes(query.toLowerCase());
  return (
    <div className="page">
      <PageHeader title="Requirements" count={reqs.length} compact />
      <div className="object-layout">
        <aside className="object-browser" aria-label="Requirements and assumptions">
          <SearchField value={query} onChange={setQuery} placeholder="Find a requirement" />
          {[
            { label: 'Requirements', items: reqs },
            { label: 'Assumptions', items: asms },
          ].map((group) => (
            <div key={group.label}>
              <div className="object-group-label">
                {group.label}
                <span>{group.items.length}</span>
              </div>
              {group.items.filter(matches).map((v) => (
                <ObjectRow
                  key={v.artifact.id}
                  view={v}
                  selected={selected?.artifact.id === v.artifact.id}
                  onClick={() => selectArtifact(v.artifact.id)}
                  meta={
                    v.artifact.type === 'assumption'
                      ? 'To validate'
                      : `Revision ${v.revision?.seq ?? 0}`
                  }
                />
              ))}
            </div>
          ))}
          {![...reqs, ...asms].some(matches) && (
            <p className="browser-empty">
              {query ? 'No matching requirements.' : 'Requirements will appear here.'}
            </p>
          )}
        </aside>
        <div className="object-detail">
          {selected ? (
            <RequirementSurface key={selected.artifact.id} view={selected} />
          ) : (
            <EmptyState
              title="Begin with a clear requirement"
              body="Ask your agent to define what the system must do, its constraints, and how you will verify them."
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** Reused by the requirements workspace and the general object browser. */
export function RequirementSurface({ view }: { view: ArtifactView }) {
  const { refreshArtifacts, toast, readOnly } = useStore();
  const [draft, setDraft] = useState<Revision | null>(null);
  const [loading, setLoading] = useState(!view.revision);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (view.revision) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    void cmd<{ revision: Revision | null }>('artifact.read', { artifactId: view.artifact.id })
      .then((result) => {
        if (!cancelled) setDraft(result.revision);
      })
      .catch((e) => {
        if (!cancelled) setError(errMsg(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view.artifact.id, view.revision, view.draftCount, attempt]);
  if (!view.revision && loading)
    return (
      <div role="status" className="dim">
        Loading the latest draft…
      </div>
    );
  if (error)
    return (
      <EmptyState
        title="Couldn’t load this draft"
        body={error}
        action={<button onClick={() => setAttempt((a) => a + 1)}>Try again</button>}
      />
    );
  const display = view.revision ? view : { ...view, revision: draft };
  return (
    <>
      <div className="detail-heading">
        <div className="row">
          <ArtifactIcon type={view.artifact.type} />
          <span className="dim">
            {view.artifact.type === 'assumption' ? 'Assumption' : 'Requirement'}
          </span>
          <span className="grow" />
          <StatusBadge state={view.freshness} />
          <InspectButton />
        </div>
        <h3>{view.artifact.title}</h3>
        <div className="row">
          <StatusBadge state={display.revision?.reviewState ?? 'draft'} />
          <span className="faint">
            {display.revision ? `Revision ${display.revision.seq}` : 'No revision'}
          </span>
        </div>
      </div>
      {!view.revision && (
        <div className="inline-notice" style={{ marginBottom: 20 }}>
          This object has no approved baseline. The latest draft is shown for reference; ask your
          agent to submit it for review.
        </div>
      )}
      <fieldset disabled={readOnly || !view.revision} className="plain-fieldset">
        {view.artifact.type === 'requirement' ? (
          <RequirementEditor view={display} onSaved={refreshArtifacts} toast={toast} />
        ) : (
          <AssumptionEditor view={display} onSaved={refreshArtifacts} toast={toast} />
        )}
      </fieldset>
    </>
  );
}

function RequirementEditor(props: {
  view: ArtifactView;
  onSaved: () => Promise<void>;
  toast: (k: 'ok' | 'error', t: string) => void;
}) {
  const { view } = props;
  const p = (view.revision?.payload ?? {}) as RequirementPayload;
  const [statement, setStatement] = useState(p.statement ?? '');
  const t0 = p.target;
  const [targetValue, setTargetValue] = useState(t0 && !('unknown' in t0) ? String(t0.value) : '');
  const [targetUnit, setTargetUnit] = useState(t0 && !('unknown' in t0) ? t0.unit : 'g');
  const [acceptance, setAcceptance] = useState(p.acceptanceCriterion ?? '');
  const [priority, setPriority] = useState(p.priority ?? 'should');
  const [impact, setImpact] = useState<{ affected: { title: string; reason: string }[] } | null>(
    null,
  );
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const pp = (view.revision?.payload ?? {}) as RequirementPayload;
    setStatement(pp.statement ?? '');
    const t1 = pp.target;
    setTargetValue(t1 && !('unknown' in t1) ? String(t1.value) : '');
    setTargetUnit(t1 && !('unknown' in t1) ? t1.unit : 'g');
    setAcceptance(pp.acceptanceCriterion ?? '');
    setPriority(pp.priority ?? 'should');
    setDirty(false);
    setImpact(null);
  }, [view.revision?.id, view.revision?.payload]);

  const save = async () => {
    if (!view.revision) return;
    try {
      if (targetValue.trim() && !Number.isFinite(Number(targetValue))) {
        props.toast('error', `Target value must be a number — got "${targetValue}"`);
        return;
      }
      const target = targetValue.trim()
        ? { value: Number(targetValue), unit: targetUnit }
        : undefined;
      await cmd('artifact.apply_edit', {
        artifactId: view.artifact.id,
        baseRevisionId: view.revision.id,
        payload: {
          statement,
          target,
          acceptanceCriterion: acceptance,
          priority,
          sourceId: p.sourceId,
          verification: p.verification,
        },
        rationale: 'edit requirement',
      });
      props.toast('ok', 'Saved — impact propagated');
      await props.onSaved();
    } catch (e) {
      props.toast(
        'error',
        (e as CommandError).message +
          ((e as CommandError).repair ? ` — ${(e as CommandError).repair}` : ''),
      );
    }
  };

  const previewImpact = async () => {
    if (!view.revision) return;
    const r = await cmd<{ affected: { title: string; reason: string }[] }>('graph.impact', {
      refs: [{ artifactId: view.artifact.id, revisionId: view.revision.id }],
    });
    setImpact(r);
  };

  return (
    <div className="detail-form">
      <Field label="Statement">
        <textarea
          rows={3}
          value={statement}
          onChange={(e) => {
            setStatement(e.target.value);
            setDirty(true);
          }}
          style={{ width: '100%' }}
        />
      </Field>
      <div className="field-row">
        <Field label="Target value">
          <input
            value={targetValue}
            onChange={(e) => {
              setTargetValue(e.target.value);
              setDirty(true);
            }}
            className="num"
            style={{ width: '100%' }}
          />
        </Field>
        <Field label="Unit">
          <select
            value={targetUnit}
            onChange={(e) => {
              setTargetUnit(e.target.value);
              setDirty(true);
            }}
          >
            {[
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
            ].map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority">
          <select
            value={priority}
            onChange={(e) => {
              setPriority(e.target.value as never);
              setDirty(true);
            }}
          >
            <option value="must">must</option>
            <option value="should">should</option>
            <option value="could">could</option>
          </select>
        </Field>
      </div>
      <Field label="Acceptance criterion">
        <textarea
          rows={2}
          value={acceptance}
          onChange={(e) => {
            setAcceptance(e.target.value);
            setDirty(true);
          }}
          style={{ width: '100%' }}
        />
      </Field>
      <div className="form-actions">
        <button className="primary" onClick={save} disabled={!dirty}>
          Save requirement
        </button>
        <button onClick={previewImpact}>Preview impact</button>
      </div>
      {impact && (
        <div
          style={{ marginTop: 12, border: '1px solid var(--border)', borderRadius: 6, padding: 12 }}
        >
          <div className="dim" style={{ fontSize: 12, marginBottom: 4 }}>
            Downstream impact
          </div>
          {impact.affected.length === 0 && <div className="faint">No recorded dependents</div>}
          {impact.affected.map((a, i) => (
            <div key={i} style={{ padding: '2px 0', fontSize: 12 }}>
              {a.title} <span className="warn">— {a.reason}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AssumptionEditor(props: {
  view: ArtifactView;
  onSaved: () => Promise<void>;
  toast: (k: 'ok' | 'error', t: string) => void;
}) {
  const { view } = props;
  const p = (view.revision?.payload ?? {}) as AssumptionPayload;
  const [statement, setStatement] = useState(p.statement ?? '');
  const [reason, setReason] = useState(p.reason ?? '');
  const [owner, setOwner] = useState(p.owner ?? '');
  const [needsValidation, setNeedsValidation] = useState(p.needsValidation ?? true);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const pp = (view.revision?.payload ?? {}) as AssumptionPayload;
    setStatement(pp.statement ?? '');
    setReason(pp.reason ?? '');
    setOwner(pp.owner ?? '');
    setNeedsValidation(pp.needsValidation ?? true);
    setDirty(false);
  }, [view.revision?.id, view.revision?.payload]);

  const save = async () => {
    if (!view.revision) return;
    try {
      await cmd('artifact.apply_edit', {
        artifactId: view.artifact.id,
        baseRevisionId: view.revision.id,
        payload: {
          statement,
          reason,
          owner,
          needsValidation,
          value: p.value,
          uncertainty: p.uncertainty,
        },
        rationale: 'edit assumption',
      });
      props.toast('ok', 'Saved');
      await props.onSaved();
    } catch (e) {
      props.toast('error', errMsg(e));
    }
  };

  return (
    <div className="detail-form">
      <Field label="Assumption">
        <textarea
          rows={3}
          value={statement}
          onChange={(e) => {
            setStatement(e.target.value);
            setDirty(true);
          }}
          style={{ width: '100%' }}
        />
      </Field>
      <Field label="Reason">
        <input
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setDirty(true);
          }}
          style={{ width: '100%' }}
        />
      </Field>
      <div className="row">
        <Field label="Owner">
          <input
            value={owner}
            onChange={(e) => {
              setOwner(e.target.value);
              setDirty(true);
            }}
          />
        </Field>
        <Field label="Needs validation">
          <select
            value={needsValidation ? 'yes' : 'no'}
            onChange={(e) => {
              setNeedsValidation(e.target.value === 'yes');
              setDirty(true);
            }}
          >
            <option value="yes">yes</option>
            <option value="no">no</option>
          </select>
        </Field>
      </div>
      <button className="primary" onClick={save} disabled={!dirty} style={{ marginTop: 8 }}>
        Save assumption
      </button>
    </div>
  );
}

export function Field(props: { label: string; children: React.ReactNode }) {
  return <FormField label={props.label}>{props.children as React.ReactElement}</FormField>;
}
