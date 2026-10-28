import React, { useEffect, useRef, useState } from 'react';
import type { ImpactReport, RequirementPayload, Revision } from '@bureau/contracts';
import { cmd, errMsg } from '../../api';
import { useStore } from '../../store';
import {
  Block,
  Button,
  Checkbox,
  Facts,
  Field,
  QuantityField,
  Segmented,
  TypeGlyph,
} from '../../ui/kit';
import {
  requirementForm,
  requirementPayloadFromForm,
  requirementProblem,
  TARGET_UNITS,
  type RequirementForm,
} from '../../lib/stage-forms';
import { useRevisionDraft } from '../useRevisionDraft';
import {
  SaveBar,
  UnderneathNotice,
  editRationale,
  useNavigate,
  type FieldLabels,
  type StageProps,
} from './shared';

const LABELS: FieldLabels<RequirementForm> = {
  statement: { label: 'Statement' },
  targetValue: {
    label: 'Target value',
    show: (value, form) => (value === null ? 'not set' : `${value} ${form.targetUnit}`.trim()),
  },
  targetUnit: { label: 'Target unit' },
  targetMin: { label: 'Band minimum' },
  targetMax: { label: 'Band maximum' },
  targetUnknown: { label: 'Target unknown', show: (value) => (value ? 'yes' : 'no') },
  unknownReason: { label: 'Reason the target is unknown' },
  acceptance: { label: 'Accepted when' },
  priority: { label: 'Priority' },
};

const payloadOf = (revision: Revision | null) =>
  (revision?.payload ?? {}) as Partial<RequirementPayload>;

export function RequirementStage({ view }: StageProps) {
  const toast = useStore((s) => s.toast);
  const { focus } = useNavigate();
  const recorded = payloadOf(view.revision);
  const draft = useRevisionDraft<RequirementForm>({
    view,
    label: `requirement “${view.artifact.title}”`,
    toForm: (revision) => requirementForm(payloadOf(revision)),
    check: requirementProblem,
    save: async (form, base, edited) => {
      const r = await cmd<{ revision: Revision }>('artifact.apply_edit', {
        artifactId: view.artifact.id,
        baseRevisionId: base.id,
        payload: requirementPayloadFromForm(payloadOf(base), form),
        rationale: editRationale('requirement', edited, LABELS),
      });
      return r.revision.id;
    },
  });
  const { form, edit } = draft;

  const [impact, setImpact] = useState<ImpactReport | null>(null);
  const [tracing, setTracing] = useState(false);
  const generation = useRef(0);
  const revisionId = view.revision?.id;
  useEffect(() => {
    generation.current++;
    setImpact(null);
    setTracing(false);
  }, [revisionId]);

  const trace = async (append = false) => {
    if (!view.revision) return;
    const g = ++generation.current;
    setTracing(true);
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
      if (g === generation.current) setTracing(false);
    }
  };

  const save = async () => {
    const id = await draft.save();
    if (id) toast('ok', 'Requirement saved as the new baseline');
  };
  const hasValue = form.targetValue !== null;
  const unknown = form.targetUnknown || !!form.unknownReason.trim();
  const affected = impact ? (impact.totalAffected ?? impact.affected.length) : null;

  return (
    <div className="doc">
      <UnderneathNotice draft={draft} labels={LABELS} />
      <fieldset disabled={!draft.canEdit || draft.busy} className="bare stage-fields">
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
            <QuantityField
              label="Target"
              value={{ value: form.targetValue, unit: form.targetUnit }}
              units={TARGET_UNITS}
              placeholder={unknown ? 'Unknown' : '—'}
              onChange={(next) => edit({ targetValue: next.value, targetUnit: next.unit })}
            />
            {hasValue ? (
              <div className="target-band">
                <span className="target-label">Band</span>
                <input
                  className="num"
                  aria-label="Band minimum"
                  inputMode="decimal"
                  placeholder="min"
                  value={form.targetMin}
                  onChange={(e) => edit({ targetMin: e.target.value })}
                />
                <span className="dim" aria-hidden="true">
                  –
                </span>
                <input
                  className="num"
                  aria-label="Band maximum"
                  inputMode="decimal"
                  placeholder="max"
                  value={form.targetMax}
                  onChange={(e) => edit({ targetMax: e.target.value })}
                />
                <span className="mono dim">{form.targetUnit}</span>
              </div>
            ) : (
              <>
                <Checkbox
                  checked={unknown}
                  onChange={(on) =>
                    edit(on ? { targetUnknown: true } : { targetUnknown: false, unknownReason: '' })
                  }
                  label="The target is unknown"
                  hint={
                    unknown
                      ? 'It stays unknown, with or without a reason. Clear this to record no target.'
                      : 'Nothing is recorded as the target.'
                  }
                />
                <Field label="Why the target is unknown" hint="An unknown target keeps its reason.">
                  <input
                    value={form.unknownReason}
                    onChange={(e) =>
                      edit({
                        unknownReason: e.target.value,
                        ...(e.target.value.trim() ? { targetUnknown: true } : {}),
                      })
                    }
                  />
                </Field>
              </>
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
      </fieldset>
      {recorded.verification && <Facts rows={[['Verification', recorded.verification]]} />}

      <SaveBar
        draft={draft}
        saveLabel="Save requirement"
        consequence="Saving records a new baseline revision without a review and marks what depends on it out of date."
        onSave={() => void save()}
        extra={
          <Button
            size="sm"
            variant="ghost"
            busy={tracing}
            disabled={!view.revision}
            onClick={() => void trace()}
          >
            Trace impact
          </Button>
        }
      />

      {impact && (
        <Block title={`If r${view.revision?.seq ?? ''} changes`} count={affected ?? undefined}>
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
            <Button size="sm" variant="ghost" busy={tracing} onClick={() => void trace(true)}>
              Show more ({impact.affected.length} of {impact.totalAffected})
            </Button>
          )}
        </Block>
      )}
    </div>
  );
}
