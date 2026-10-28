/**
 * How each editable payload becomes a flat form and back. A save sends the whole payload, so
 * every mapping carries the fields the form does not show through unchanged.
 */
import type {
  ArtifactType,
  ArtifactView,
  AssumptionPayload,
  MaybeQuantity,
  RequirementPayload,
  StaleRecord,
} from '@bureau/contracts';

/* ------------------------------------------------------------------ */
/* Requirement                                                          */
/* ------------------------------------------------------------------ */

export type RequirementForm = {
  statement: string;
  /** null means no value is set. It is never saved as zero. */
  targetValue: number | null;
  targetUnit: string;
  /** Uncertainty band in the target's unit, as typed. Empty means that end is not recorded. */
  targetMin: string;
  targetMax: string;
  /**
   * The target is recorded as unknown, with or without a reason. Only used while no value is
   * set; clearing it is the one way an unknown target becomes no target.
   */
  targetUnknown: boolean;
  /** Why the target is unknown. Only used while no value is set; typing one marks it unknown. */
  unknownReason: string;
  acceptance: string;
  priority: 'must' | 'should' | 'could';
};

/** Units offered for a target, by dimension. A recorded unit outside the list is kept. */
export const TARGET_UNITS = [
  'mm',
  'cm',
  'm',
  'km',
  'in',
  'ft',
  'mg',
  'g',
  'kg',
  'lb',
  'oz',
  'ms',
  's',
  'min',
  'h',
  'day',
  'uA',
  'mA',
  'A',
  'mV',
  'V',
  'kV',
  'mW',
  'W',
  'kW',
  'J',
  'mWh',
  'Wh',
  'kWh',
  'mAh',
  'Ah',
  'N',
  'kgf',
  'lbf',
  'N*mm',
  'N*cm',
  'N*m',
  'kg*cm',
  'oz*in',
  'deg',
  'rad',
  'rpm',
  'rad/s',
  'm/s',
  'km/h',
  'mph',
  'm/s^2',
  'degC',
  'K',
  '%',
  '1',
];

const bandText = (n: number | undefined) => (n === undefined ? '' : String(n));

export function requirementForm(payload: Partial<RequirementPayload>): RequirementForm {
  const target = payload.target;
  const known = target && !('unknown' in target) ? target : null;
  return {
    statement: payload.statement ?? '',
    targetValue: known ? known.value : null,
    targetUnit: known ? known.unit : '',
    targetMin: bandText(known?.min),
    targetMax: bandText(known?.max),
    targetUnknown: !!target && 'unknown' in target,
    unknownReason: target && 'unknown' in target ? target.reason : '',
    acceptance: payload.acceptanceCriterion ?? '',
    priority: payload.priority ?? 'should',
  };
}

const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

function bandEnd(text: string): number | undefined | null {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return DECIMAL.test(trimmed) ? Number(trimmed) : null;
}

/** The first thing wrong with the form, in words; null when it can be saved. */
export function requirementProblem(form: RequirementForm): string | null {
  const min = bandEnd(form.targetMin);
  const max = bandEnd(form.targetMax);
  if (form.targetValue === null) {
    if (min !== undefined || max !== undefined)
      return 'A band needs a target value. Enter the value or clear the band.';
    return null;
  }
  if (!form.targetUnit.trim()) return 'Choose a unit for the target value.';
  if (min === null) return `The band minimum needs a number, got “${form.targetMin.trim()}”.`;
  if (max === null) return `The band maximum needs a number, got “${form.targetMax.trim()}”.`;
  if (min !== undefined && max !== undefined && min > max)
    return 'The band minimum is above its maximum.';
  return null;
}

/**
 * The target the form describes: a quantity with its band, an unknown with its reason (which may
 * be empty, as recorded), or none.
 */
export function requirementTarget(form: RequirementForm): MaybeQuantity | undefined {
  if (form.targetValue === null) {
    const reason = form.unknownReason.trim();
    return form.targetUnknown || reason ? { unknown: true, reason } : undefined;
  }
  const min = bandEnd(form.targetMin);
  const max = bandEnd(form.targetMax);
  return {
    value: form.targetValue,
    unit: form.targetUnit.trim(),
    ...(typeof min === 'number' ? { min } : {}),
    ...(typeof max === 'number' ? { max } : {}),
  };
}

export function requirementPayloadFromForm(
  recorded: Partial<RequirementPayload>,
  form: RequirementForm,
): RequirementPayload {
  const payload: RequirementPayload = {
    ...recorded,
    statement: form.statement,
    acceptanceCriterion: form.acceptance,
    priority: form.priority,
  };
  const target = requirementTarget(form);
  if (target) payload.target = target;
  else delete payload.target;
  return payload;
}

/* ------------------------------------------------------------------ */
/* Assumption                                                           */
/* ------------------------------------------------------------------ */

export type AssumptionForm = {
  statement: string;
  reason: string;
  owner: string;
  needsValidation: boolean;
};

export function assumptionForm(payload: Partial<AssumptionPayload>): AssumptionForm {
  return {
    statement: payload.statement ?? '',
    reason: payload.reason ?? '',
    owner: payload.owner ?? '',
    needsValidation: payload.needsValidation ?? true,
  };
}

export function assumptionPayloadFromForm(
  recorded: Partial<AssumptionPayload>,
  form: AssumptionForm,
): AssumptionPayload {
  return { ...recorded, ...form };
}

/* ------------------------------------------------------------------ */
/* Documents                                                            */
/* ------------------------------------------------------------------ */

const TEXT_KEYS = ['markdown', 'statement', 'description', 'body', 'notes'];

/** The payload field that holds a document type's prose. */
export function documentTextKey(type: ArtifactType, payload: Record<string, unknown>): string {
  return (
    TEXT_KEYS.find((k) => typeof payload[k] === 'string') ??
    (type === 'software'
      ? 'notes'
      : type === 'subsystem' || type === 'concept'
        ? 'description'
        : 'markdown')
  );
}

export type DocumentForm = {
  text: string;
};

export function documentForm(type: ArtifactType, payload: Record<string, unknown>): DocumentForm {
  const value = payload[documentTextKey(type, payload)];
  return { text: typeof value === 'string' ? value : '' };
}

/* ------------------------------------------------------------------ */
/* Input problems                                                       */
/* ------------------------------------------------------------------ */

export type InputProblem = 'changed' | 'not-approved' | 'missing';

/**
 * What is actually wrong with a recorded input. An input that exists but has no approved
 * baseline is not missing: it is waiting for approval, and that is a different thing to do.
 */
export function inputProblem(record: StaleRecord, artifacts: ArtifactView[]): InputProblem {
  if (record.reason !== 'missing_input') return 'changed';
  const upstream = artifacts.find((v) => v.artifact.id === record.upstreamArtifactId);
  return upstream && !upstream.artifact.selectedRevisionId ? 'not-approved' : 'missing';
}

/** The word for an object's freshness, naming unapproved inputs for what they are. */
export function freshnessLabel(
  freshness: ArtifactView['freshness'],
  reasons: StaleRecord[],
  artifacts: ArtifactView[],
): string | undefined {
  if (freshness !== 'missing_input') return undefined;
  const missing = reasons.filter((r) => r.reason === 'missing_input');
  return missing.length && missing.every((r) => inputProblem(r, artifacts) === 'not-approved')
    ? 'Input not yet approved'
    : undefined;
}
