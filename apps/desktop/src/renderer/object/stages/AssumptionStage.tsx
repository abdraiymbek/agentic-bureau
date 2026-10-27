import React from 'react';
import type { AssumptionPayload, Revision } from '@bureau/contracts';
import { cmd } from '../../api';
import { useStore } from '../../store';
import { Facts, Field, Notice, Segmented } from '../../ui/kit';
import {
  assumptionForm,
  assumptionPayloadFromForm,
  type AssumptionForm,
} from '../../lib/stage-forms';
import { useRevisionDraft } from '../useRevisionDraft';
import {
  SaveBar,
  UnderneathNotice,
  editRationale,
  qty,
  type FieldLabels,
  type StageProps,
} from './shared';

const LABELS: FieldLabels<AssumptionForm> = {
  statement: { label: 'Assumption' },
  reason: { label: 'Why we assume it' },
  owner: { label: 'Owner' },
  needsValidation: { label: 'Needs validation' },
};

const payloadOf = (revision: Revision | null) =>
  (revision?.payload ?? {}) as Partial<AssumptionPayload>;

export function AssumptionStage({ view }: StageProps) {
  const toast = useStore((s) => s.toast);
  const recorded = payloadOf(view.revision);
  const draft = useRevisionDraft<AssumptionForm>({
    view,
    label: `assumption “${view.artifact.title}”`,
    toForm: (revision) => assumptionForm(payloadOf(revision)),
    save: async (form, base, edited) => {
      const r = await cmd<{ revision: Revision }>('artifact.apply_edit', {
        artifactId: view.artifact.id,
        baseRevisionId: base.id,
        payload: assumptionPayloadFromForm(payloadOf(base), form),
        rationale: editRationale('assumption', edited, LABELS),
      });
      return r.revision.id;
    },
  });
  const { form, edit } = draft;
  const save = async () => {
    const id = await draft.save();
    if (id) toast('ok', 'Assumption saved as the new baseline');
  };
  return (
    <div className="doc">
      <Notice tone={form.needsValidation ? 'warn' : 'neutral'}>
        An assumption is not an established fact.{' '}
        {form.needsValidation ? 'It still needs validation.' : 'Marked as not needing validation.'}
      </Notice>
      <UnderneathNotice draft={draft} labels={LABELS} />
      <fieldset disabled={!draft.canEdit || draft.busy} className="bare stage-fields">
        <label className="doc-statement">
          <span className="sr-only">Assumption</span>
          <textarea
            rows={2}
            value={form.statement}
            onChange={(e) => edit({ statement: e.target.value })}
          />
        </label>
        {recorded.uncertainty && <Notice tone="warn">{recorded.uncertainty}</Notice>}
        {recorded.value && (
          <Facts
            rows={[
              [
                'Assumed value',
                <span className="num" key="v">
                  {qty(recorded.value)}
                </span>,
              ],
            ]}
          />
        )}
        <Field label="Why we assume it">
          <textarea
            rows={2}
            value={form.reason}
            onChange={(e) => edit({ reason: e.target.value })}
          />
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
      </fieldset>
      <SaveBar
        draft={draft}
        saveLabel="Save assumption"
        consequence="Saving records a new baseline revision without a review and marks what depends on it out of date."
        onSave={() => void save()}
      />
    </div>
  );
}
