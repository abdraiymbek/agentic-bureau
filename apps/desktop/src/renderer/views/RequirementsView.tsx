import React, { useEffect, useState } from 'react';
import { cmd, CommandError } from '../api';
import { useStore } from '../store';
import type { ArtifactView, RequirementPayload, AssumptionPayload, MaybeQuantity } from '@stark/contracts';
import { isUnknown, formatQty } from '@stark/contracts';
import { EmptyBlock } from './OverviewView';

/** Requirements + assumptions surfaces — edit individually with units + acceptance. */
export function RequirementsView() {
  const { artifacts, selectedArtifactId, selectArtifact, refreshArtifacts, toast } = useStore();
  const reqs = artifacts.filter((v) => v.artifact.type === 'requirement');
  const asms = artifacts.filter((v) => v.artifact.type === 'assumption');
  const selected = [...reqs, ...asms].find((v) => v.artifact.id === selectedArtifactId);

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ width: 260, borderRight: '1px solid var(--border)', overflowY: 'auto', padding: 8 }}>
        <div className="dim" style={{ fontSize: 12, fontWeight: 600, padding: '4px 8px' }}>Requirements</div>
        {reqs.length === 0 && <div className="faint" style={{ padding: '4px 8px', fontSize: 12 }}>None yet</div>}
        {reqs.map((v) => (
          <ListRow key={v.artifact.id} v={v} active={selectedArtifactId === v.artifact.id} onClick={() => selectArtifact(v.artifact.id)} />
        ))}
        <div className="dim" style={{ fontSize: 12, fontWeight: 600, padding: '12px 8px 4px' }}>Assumptions</div>
        {asms.map((v) => (
          <ListRow key={v.artifact.id} v={v} active={selectedArtifactId === v.artifact.id} onClick={() => selectArtifact(v.artifact.id)} />
        ))}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {selected ? (
          selected.artifact.type === 'requirement' ? (
            <RequirementEditor view={selected} onSaved={refreshArtifacts} toast={toast} />
          ) : (
            <AssumptionEditor view={selected} onSaved={refreshArtifacts} toast={toast} />
          )
        ) : (
          <EmptyBlock title="No selection" body="Pick a requirement or assumption on the left to inspect and edit it." />
        )}
      </div>
    </div>
  );
}

function ListRow(props: { v: ArtifactView; active: boolean; onClick: () => void }) {
  const { v } = props;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={props.onClick}
      onKeyDown={(e) => e.key === 'Enter' && props.onClick()}
      style={{
        padding: '5px 8px',
        borderRadius: 4,
        cursor: 'pointer',
        background: props.active ? 'var(--bg-raised)' : 'transparent',
        display: 'flex',
        justifyContent: 'space-between',
        fontSize: 13,
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.artifact.title}</span>
      <span className={`pill ${v.freshness === 'stale' ? 'stale' : v.freshness === 'missing_input' ? 'missing' : 'current'}`} style={{ height: 18, fontSize: 11 }}>
        {v.freshness}
      </span>
    </div>
  );
}

function RequirementEditor(props: { view: ArtifactView; onSaved: () => Promise<void>; toast: (k: 'ok' | 'error', t: string) => void }) {
  const { view } = props;
  const p = (view.revision?.payload ?? {}) as RequirementPayload;
  const [statement, setStatement] = useState(p.statement ?? '');
  const t0 = p.target;
  const [targetValue, setTargetValue] = useState(t0 && !('unknown' in t0) ? String(t0.value) : '');
  const [targetUnit, setTargetUnit] = useState(t0 && !('unknown' in t0) ? t0.unit : 'g');
  const [acceptance, setAcceptance] = useState(p.acceptanceCriterion ?? '');
  const [priority, setPriority] = useState(p.priority ?? 'should');
  const [impact, setImpact] = useState<{ affected: { title: string; reason: string }[] } | null>(null);
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
  }, [view.revision?.id]);

  const save = async () => {
    if (!view.revision) return;
    try {
      const target = targetValue.trim() ? { value: Number(targetValue), unit: targetUnit } : undefined;
      await cmd('artifact.apply_edit', {
        artifactId: view.artifact.id,
        baseRevisionId: view.revision.id,
        payload: { statement, target, acceptanceCriterion: acceptance, priority, sourceId: p.sourceId, verification: p.verification },
        rationale: 'edit requirement',
      });
      props.toast('ok', 'Saved — impact propagated');
      await props.onSaved();
    } catch (e) {
      props.toast('error', (e as CommandError).message + (((e as CommandError).repair) ? ` — ${(e as CommandError).repair}` : ''));
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
    <div style={{ maxWidth: 640 }}>
      <h3 style={{ margin: '0 0 12px' }}>{view.artifact.title}</h3>
      <Field label="Statement">
        <textarea rows={3} value={statement} onChange={(e) => { setStatement(e.target.value); setDirty(true); }} style={{ width: '100%' }} />
      </Field>
      <div className="row" style={{ gap: 8 }}>
        <Field label="Target value">
          <input value={targetValue} onChange={(e) => { setTargetValue(e.target.value); setDirty(true); }} className="num" style={{ width: 120 }} />
        </Field>
        <Field label="Unit">
          <select value={targetUnit} onChange={(e) => { setTargetUnit(e.target.value); setDirty(true); }}>
            {['g', 'kg', 'mm', 'cm', 'm', 'V', 'A', 'mA', 'W', 'Wh', 'mAh', 's', 'min', 'h', 'N', 'N*m', 'rpm', 'deg', '1', '%'].map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
        </Field>
        <Field label="Priority">
          <select value={priority} onChange={(e) => { setPriority(e.target.value as never); setDirty(true); }}>
            <option value="must">must</option>
            <option value="should">should</option>
            <option value="could">could</option>
          </select>
        </Field>
      </div>
      <Field label="Acceptance criterion">
        <textarea rows={2} value={acceptance} onChange={(e) => { setAcceptance(e.target.value); setDirty(true); }} style={{ width: '100%' }} />
      </Field>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" onClick={save} disabled={!dirty}>Save</button>
        <button onClick={previewImpact}>Preview impact</button>
      </div>
      {impact && (
        <div style={{ marginTop: 12, border: '1px solid var(--border)', borderRadius: 6, padding: 12 }}>
          <div className="dim" style={{ fontSize: 12, marginBottom: 4 }}>Downstream impact</div>
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

function AssumptionEditor(props: { view: ArtifactView; onSaved: () => Promise<void>; toast: (k: 'ok' | 'error', t: string) => void }) {
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
  }, [view.revision?.id]);

  const save = async () => {
    if (!view.revision) return;
    try {
      await cmd('artifact.apply_edit', {
        artifactId: view.artifact.id,
        baseRevisionId: view.revision.id,
        payload: { statement, reason, owner, needsValidation, value: p.value, uncertainty: p.uncertainty },
        rationale: 'edit assumption',
      });
      props.toast('ok', 'Saved');
      await props.onSaved();
    } catch (e) {
      props.toast('error', (e as Error).message);
    }
  };

  return (
    <div style={{ maxWidth: 640 }}>
      <h3 style={{ margin: '0 0 12px' }}>{view.artifact.title}</h3>
      <Field label="Assumption">
        <textarea rows={3} value={statement} onChange={(e) => { setStatement(e.target.value); setDirty(true); }} style={{ width: '100%' }} />
      </Field>
      <Field label="Reason">
        <input value={reason} onChange={(e) => { setReason(e.target.value); setDirty(true); }} style={{ width: '100%' }} />
      </Field>
      <div className="row">
        <Field label="Owner">
          <input value={owner} onChange={(e) => { setOwner(e.target.value); setDirty(true); }} />
        </Field>
        <Field label="Needs validation">
          <select value={needsValidation ? 'yes' : 'no'} onChange={(e) => { setNeedsValidation(e.target.value === 'yes'); setDirty(true); }}>
            <option value="yes">yes</option>
            <option value="no">no</option>
          </select>
        </Field>
      </div>
      <button className="primary" onClick={save} disabled={!dirty} style={{ marginTop: 8 }}>Save</button>
    </div>
  );
}

export function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="col" style={{ gap: 4, marginBottom: 10, flex: 1 }}>
      <label className="dim" style={{ fontSize: 12 }}>{props.label}</label>
      {props.children}
    </div>
  );
}
