import { describe, expect, it } from 'vitest';
import { requirementPayload, unitDef } from '@bureau/contracts';
import type { ArtifactView, RequirementPayload, StaleRecord } from '@bureau/contracts';
import {
  TARGET_UNITS,
  assumptionForm,
  assumptionPayloadFromForm,
  documentForm,
  documentTextKey,
  freshnessLabel,
  inputProblem,
  requirementForm,
  requirementPayloadFromForm,
  requirementProblem,
  requirementTarget,
} from '../../apps/desktop/src/renderer/lib/stage-forms';

const banded: RequirementPayload = {
  statement: 'The rover shall carry the payload.',
  target: { value: 0.3, unit: 'kg', min: 0.28, max: 0.35 },
  acceptanceCriterion: 'Ramp test passes.',
  priority: 'must',
  sourceId: '00000000-0000-4000-8000-000000000001',
  verification: 'Ramp test',
};

describe('requirement saves', () => {
  it('round-trips a banded target untouched when another field is edited', () => {
    const form = { ...requirementForm(banded), statement: 'The rover shall carry the pack.' };
    const saved = requirementPayloadFromForm(banded, form);
    expect(saved.target).toEqual({ value: 0.3, unit: 'kg', min: 0.28, max: 0.35 });
    expect(saved).toMatchObject({ sourceId: banded.sourceId, verification: 'Ramp test' });
    expect(requirementPayload.parse(saved)).toEqual({ ...banded, statement: form.statement });
  });
  it('keeps the features an agent recorded when a person edits another field', () => {
    const features = [
      {
        label: 'Groove bottom Ø50',
        expect: { sections: [{ axis: 'z' as const, at: 8, outer: { d: 50 } }] },
      },
    ];
    const payload = { ...banded, features };
    const form = { ...requirementForm(payload), statement: 'The rover shall carry the pack.' };
    expect(requirementPayloadFromForm(payload, form).features).toEqual(features);
    expect(requirementPayload.parse(requirementPayloadFromForm(payload, form)).features).toEqual(
      features,
    );
  });
  it('keeps one-sided bands one-sided', () => {
    const payload = { ...banded, target: { value: 45, unit: 'min', min: 40 } };
    expect(requirementPayloadFromForm(payload, requirementForm(payload)).target).toEqual({
      value: 45,
      unit: 'min',
      min: 40,
    });
  });
  it('keeps an unknown target unknown, with its reason', () => {
    const payload: RequirementPayload = {
      ...banded,
      target: { unknown: true, reason: 'Sensor not chosen' },
    };
    const form = requirementForm(payload);
    expect(form).toMatchObject({ targetValue: null, unknownReason: 'Sensor not chosen' });
    expect(requirementPayloadFromForm(payload, { ...form, priority: 'could' }).target).toEqual({
      unknown: true,
      reason: 'Sensor not chosen',
    });
  });
  it('records no target, never zero, when neither a value nor a reason is given', () => {
    const none = { ...banded, target: undefined };
    const form = requirementForm(none);
    expect(form.targetValue).toBeNull();
    expect('target' in requirementPayloadFromForm(none, form)).toBe(false);
    expect(requirementTarget({ ...form, unknownReason: '  ' })).toBeUndefined();
    expect(requirementTarget({ ...form, unknownReason: ' not measured ' })).toEqual({
      unknown: true,
      reason: 'not measured',
    });
  });
  it('keeps an unknown target that has no reason when another field is edited', () => {
    const payload: RequirementPayload = { ...banded, target: { unknown: true, reason: '' } };
    const form = requirementForm(payload);
    expect(form).toMatchObject({ targetValue: null, targetUnknown: true, unknownReason: '' });
    const saved = requirementPayloadFromForm(payload, {
      ...form,
      statement: 'Survive a 1 m drop',
    });
    expect(saved.target).toEqual({ unknown: true, reason: '' });
    expect(requirementPayload.parse(saved).target).toEqual({ unknown: true, reason: '' });
  });
  it('removes an unknown target only when the person clears it', () => {
    const form = requirementForm({ ...banded, target: { unknown: true, reason: 'TBD' } });
    expect(requirementTarget({ ...form, unknownReason: '' })).toEqual({
      unknown: true,
      reason: '',
    });
    expect(requirementTarget({ ...form, targetUnknown: false, unknownReason: '' })).toBeUndefined();
    expect(requirementForm({ ...banded, target: undefined }).targetUnknown).toBe(false);
  });
  it('lets a value replace an unknown, and a cleared value fall back to the typed reason', () => {
    const form = { ...requirementForm({ ...banded, target: { unknown: true, reason: 'TBD' } }) };
    expect(requirementTarget({ ...form, targetValue: 2, targetUnit: 'kg' })).toEqual({
      value: 2,
      unit: 'kg',
    });
  });
  it('refuses a value without a unit and a band that is not numbers in order', () => {
    const form = requirementForm(banded);
    expect(requirementProblem(form)).toBeNull();
    expect(requirementProblem({ ...form, targetUnit: ' ' })).toMatch(/unit/);
    expect(requirementProblem({ ...form, targetMin: 'low' })).toMatch(/minimum needs a number/);
    expect(requirementProblem({ ...form, targetMax: '0.1' })).toMatch(/above its maximum/);
    expect(requirementProblem({ ...form, targetValue: null })).toMatch(/band needs a target/);
    expect(
      requirementProblem({ ...form, targetValue: null, targetMin: '', targetMax: '' }),
    ).toBeNull();
  });
  it('offers only units the contracts know', () => {
    for (const unit of TARGET_UNITS) expect(unitDef(unit), unit).toBeDefined();
    expect(new Set(TARGET_UNITS).size).toBe(TARGET_UNITS.length);
  });
});

describe('other editable payloads', () => {
  it('carries the assumption value and uncertainty through a save', () => {
    const recorded = {
      statement: 'Ambient stays below 40 °C.',
      value: { unknown: true as const, reason: 'Survey pending' },
      reason: 'Indoor use',
      uncertainty: 'Summer peak unmeasured',
      owner: 'Owner',
      needsValidation: true,
    };
    const saved = assumptionPayloadFromForm(recorded, {
      ...assumptionForm(recorded),
      needsValidation: false,
    });
    expect(saved).toEqual({ ...recorded, needsValidation: false });
  });
  it('finds the prose field of each document type', () => {
    expect(documentTextKey('note', { markdown: '# x' })).toBe('markdown');
    expect(documentTextKey('software', {})).toBe('notes');
    expect(documentTextKey('concept', {})).toBe('description');
    expect(documentTextKey('subsystem', {})).toBe('description');
    expect(documentTextKey('architecture', {})).toBe('markdown');
    expect(documentForm('software', { notes: 'Poll at 10 Hz' })).toEqual({ text: 'Poll at 10 Hz' });
    expect(documentForm('note', {})).toEqual({ text: '' });
  });
});

describe('input problems are named for what they are', () => {
  const view = (id: string, selectedRevisionId: string | null) =>
    ({ artifact: { id, selectedRevisionId } }) as ArtifactView;
  const record = (reason: StaleRecord['reason'], upstreamArtifactId: string) =>
    ({ reason, upstreamArtifactId, path: [upstreamArtifactId, 'self'] }) as StaleRecord;
  const artifacts = [view('approved', 'r1'), view('draft-only', null)];

  it('tells an unapproved input from a missing one', () => {
    expect(inputProblem(record('input_changed', 'approved'), artifacts)).toBe('changed');
    expect(inputProblem(record('missing_input', 'draft-only'), artifacts)).toBe('not-approved');
    expect(inputProblem(record('missing_input', 'gone'), artifacts)).toBe('missing');
    expect(inputProblem(record('missing_input', 'approved'), artifacts)).toBe('missing');
  });
  it('relabels freshness only when every missing input is merely unapproved', () => {
    const waiting = [record('missing_input', 'draft-only')];
    expect(freshnessLabel('missing_input', waiting, artifacts)).toBe('Input not yet approved');
    expect(
      freshnessLabel('missing_input', [...waiting, record('missing_input', 'gone')], artifacts),
    ).toBeUndefined();
    expect(freshnessLabel('stale', waiting, artifacts)).toBeUndefined();
    expect(freshnessLabel('missing_input', [], artifacts)).toBeUndefined();
  });
});
