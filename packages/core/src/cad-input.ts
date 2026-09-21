import { createHash } from 'node:crypto';
import {
  convert,
  dimOf,
  ErrorCodes,
  OmenflowError,
  type FileRef,
  type MechanicalPayload,
  type Revision,
} from '@omenflow/contracts';
import { parseScadParameters } from './scad-params.js';

export type ScadValue = number | string | boolean;
export type RenderIdentity = NonNullable<MechanicalPayload['renderIdentity']>;

/** An intentional source declaration edit supersedes an inherited -D override. */
export function reconcileCadOverrides(
  source: string,
  previousSource: string,
  params: Record<string, ScadValue>,
): Record<string, ScadValue> {
  const previous = new Map(parseScadParameters(previousSource).map((p) => [p.name, p]));
  const current = new Map(parseScadParameters(source).map((p) => [p.name, p]));
  return Object.fromEntries(
    Object.entries(params).filter(([name]) => {
      const before = previous.get(name);
      const after = current.get(name);
      return !!after && (!before || (before.value === after.value && before.expr === after.expr));
    }),
  );
}

/** Files are authoritative; payload refs are a compatibility mirror for old clients. */
export function canonicalScadRef(
  revision: Pick<Revision, 'payload' | 'files'>,
): FileRef | undefined {
  const payload = revision.payload as MechanicalPayload;
  return (
    revision.files.find((f) => f.path === payload.scad?.path) ??
    revision.files.find((f) => f.path.endsWith('.scad')) ??
    payload.scad
  );
}

/** Convert physical inputs deliberately. Bare numbers remain native OpenSCAD values. */
export function effectiveCadParams(
  params: Record<string, unknown> | undefined,
  modelUnit = 'mm',
): Record<string, ScadValue> {
  if (modelUnit !== 'mm')
    throw new OmenflowError(
      ErrorCodes.INVALID_UNITS,
      `CAD modelUnit ${modelUnit} is unsupported; V0.1 model coordinates must be millimetres. Convert inputs explicitly before rendering.`,
    );
  const out: Record<string, ScadValue> = {};
  for (const [name, v] of Object.entries(params ?? {})) {
    if (!/^[A-Za-z_$][A-Za-z0-9_]*$/.test(name))
      throw new OmenflowError(ErrorCodes.VALIDATION, `Invalid CAD parameter name: ${name}`);
    if (v && typeof v === 'object' && 'value' in v && 'unit' in v) {
      const q = v as { value: number; unit: string };
      if (!Number.isFinite(q.value))
        throw new OmenflowError(ErrorCodes.VALIDATION, `Non-finite parameter ${name}`);
      const dimension = dimOf(q);
      const unit =
        dimension === 'length'
          ? 'mm'
          : dimension === 'angle'
            ? 'deg'
            : dimension === 'dimensionless'
              ? '1'
              : null;
      if (!unit)
        throw new OmenflowError(
          ErrorCodes.INVALID_UNITS,
          `CAD parameter ${name} has unsupported ${dimension} unit ${q.unit}`,
        );
      out[name] = convert(q, unit).value;
    } else if (
      (typeof v === 'number' && Number.isFinite(v)) ||
      typeof v === 'string' ||
      typeof v === 'boolean'
    ) {
      out[name] = v as ScadValue;
    } else
      throw new OmenflowError(ErrorCodes.VALIDATION, `Unsupported CAD parameter value: ${name}`);
  }
  return out;
}

function stableParams(params: Record<string, unknown>): string {
  return JSON.stringify(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)));
}

export function renderMatchesInput(payload: MechanicalPayload, files: FileRef[]): boolean {
  const source = canonicalScadRef({ payload, files });
  const identity = payload.renderIdentity;
  const output = files.find((f) => f.path === payload.stl?.path) ?? payload.stl;
  return (
    !!identity &&
    identity.sourceHash === source?.sha256 &&
    identity.outputHash === output?.sha256 &&
    identity.modelUnit === payload.modelUnit &&
    stableParams(identity.params) ===
      stableParams(effectiveCadParams(payload.params, payload.modelUnit))
  );
}

/** Shared commit hook: changing any effective input removes every derived output. */
export function normalizeMechanicalRevision(
  raw: unknown,
  files: FileRef[],
  parent?: Revision | null,
  readObject?: (hash: string) => string,
): { payload: MechanicalPayload; files: FileRef[] } {
  const payload = { ...(raw as MechanicalPayload) };
  const scad = canonicalScadRef({ payload, files });
  const prior = parent?.payload as MechanicalPayload | undefined;
  const sourceChanged = !!payload.scad && payload.scad.sha256 !== scad?.sha256;
  const priorSource = parent ? canonicalScadRef(parent) : undefined;
  if (
    prior &&
    readObject &&
    priorSource?.sha256 &&
    scad?.sha256 &&
    priorSource.sha256 !== scad.sha256 &&
    !renderMatchesInput(payload, files)
  ) {
    const inherited = reconcileCadOverrides(
      readObject(scad.sha256),
      readObject(priorSource.sha256),
      effectiveCadParams(prior.params, prior.modelUnit),
    );
    const next = { ...(payload.params ?? {}) };
    for (const name of Object.keys(prior.params ?? {})) {
      if (!(name in inherited) && JSON.stringify(next[name]) === JSON.stringify(prior.params[name]))
        delete next[name];
    }
    payload.params = next;
  }
  const inputChanged =
    !!prior &&
    (canonicalScadRef(parent!)?.sha256 !== scad?.sha256 ||
      stableParams(prior.params ?? {}) !== stableParams(payload.params ?? {}) ||
      prior.modelUnit !== payload.modelUnit);
  payload.scad = scad;
  const stale =
    sourceChanged || (payload.renderIdentity ? !renderMatchesInput(payload, files) : inputChanged);
  if (stale) {
    payload.stl = undefined;
    payload.bounds = undefined;
    payload.renderJobId = undefined;
    payload.renderIdentity = undefined;
    return { payload, files: files.filter((f) => !f.path.endsWith('.stl') && f.role !== 'output') };
  }
  return { payload, files };
}

export function renderFingerprint(
  fields: Omit<RenderIdentity, 'inputFingerprint' | 'outputHash'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        ...fields,
        params: Object.entries(fields.params).sort(([a], [b]) => a.localeCompare(b)),
      }),
    )
    .digest('hex');
}

/** V0.1 only renders self-contained source: host files cannot silently affect a part. */
export function assertSelfContainedScad(source: string): void {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  if (/\b(?:include|use)\s*</.test(code) || /\b(?:import|surface|text|rands)\s*\(/.test(code)) {
    throw new OmenflowError(
      ErrorCodes.VALIDATION,
      'V0.1 CAD source must be self-contained; include/use/import/surface, host-font text() and random rands() dependencies are not yet reproducibly pinned.',
      {
        repair:
          'Inline the source, use explicit deterministic dimensions, and construct geometry directly without host fonts or random calls. Existing source remains readable.',
      },
    );
  }
}
