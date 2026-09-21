import { createHash } from 'node:crypto';
import {
  ErrorCodes,
  OmenflowError,
  type Expectation,
  type MechanicalPayload,
  type Revision,
} from '@omenflow/contracts';
import type { ProjectContext } from './context.js';
import type { CheckResult } from './cad-checks.js';
import { renderMatchesInput, type RenderIdentity } from './cad-input.js';

export const CAD_CHECKER_VERSION = 'omenflow-mesh-checks-v4';
export type CadVerificationStatus =
  'passed' | 'partial' | 'failed' | 'scope_changed' | 'unverified';
export interface CadVerificationEvidence {
  version: 1;
  artifactId: string;
  revisionId: string;
  inputFingerprint: string;
  outputHash: string;
  preservation?: { revisionId: string; inputFingerprint: string; outputHash: string };
  specHash: string;
  checkerVersion: string;
  expect: Expectation;
  checks: CheckResult[];
  integrity: { pass: boolean; detail: string };
  status: CadVerificationStatus;
  pass: boolean;
  scopeChanges: string[];
  priorSpecHashes: string[];
  exploratory?: boolean;
  coverage: {
    units: 'mm';
    frame: 'right-handed-z-up';
    assertions: string[];
    limitations: string[];
    requirementAuthority: 'agent_or_user_declared';
  };
}

interface AcceptedScope {
  evidenceHash: string;
  specHash: string;
  expect: Expectation;
  revisionId: string;
}
function acceptedScope(ctx: ProjectContext, artifactId: string): AcceptedScope | null {
  const raw = ctx.repo.meta(`cad.scope.accepted.${artifactId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AcceptedScope;
  } catch {
    return null;
  }
}

export function hasExplicitScope(expect: Expectation): boolean {
  return Object.entries(expect).some(
    ([key, value]) =>
      !['watertight', 'minRoundness'].includes(key) &&
      value !== undefined &&
      (!Array.isArray(value) || value.length > 0),
  );
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}

/** Explicit defaults make omission equivalent to the actual checker semantics. */
function normalizedSpec(expect: Expectation): Record<string, unknown> {
  const e = structuredClone(expect);
  if (e.bbox) e.bbox.tol ??= 0.1;
  if (e.volume) e.volume.tolPct ??= 1.5;
  for (const section of e.sections ?? []) {
    for (const shape of [
      ...(section.holes ?? []),
      ...(section.slots ?? []),
      ...(section.polygons ?? []),
    ])
      shape.tol ??= 0.1;
    if (section.outer) section.outer.tol ??= 0.1;
    if (section.materialArea) section.materialArea.tolPct ??= 1.5;
  }
  return { ...e, watertight: e.watertight ?? true, minRoundness: e.minRoundness ?? 0.97 };
}

function covers(previous: unknown, next: unknown, key = ''): boolean {
  if (previous === next) return true;
  if (typeof previous === 'number' && typeof next === 'number') {
    if (key === 'tol' || key === 'tolPct' || key === 'maxSelfIntersections')
      return next <= previous;
    if (key === 'minRoundness') return next >= previous;
  }
  if (Array.isArray(previous)) {
    if (!Array.isArray(next)) return false;
    // Coordinates are ordered; collections of independent assertions can grow/reorder.
    if (previous.every((v) => typeof v === 'number'))
      return JSON.stringify(previous) === JSON.stringify(next);
    return previous.every((p) => next.some((n) => covers(p, n, key)));
  }
  if (previous && typeof previous === 'object') {
    if (!next || typeof next !== 'object') return false;
    return Object.entries(previous).every(([k, v]) =>
      covers(v, (next as Record<string, unknown>)[k], k),
    );
  }
  return false;
}

export function specHashOf(expect: Expectation): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(normalizedSpec(expect))))
    .digest('hex');
}

/** Additions/tighter tolerances preserve scope. Removed/changed assertions require explicit review. */
export function verificationScopeChanges(previous: Expectation, next: Expectation): string[] {
  const before = normalizedSpec(previous);
  const after = normalizedSpec(next);
  return Object.entries(before)
    .filter(([key, value]) => !covers(value, after[key], key))
    .map(([key]) => key);
}

export function createCadVerificationEvidence(
  ctx: ProjectContext,
  revision: Revision,
  identity: RenderIdentity,
  expect: Expectation,
  checks: CheckResult[],
  integrity: { pass: boolean; detail: string },
  opts?: { exploratory?: boolean; boundExpect?: Expectation | null },
): CadVerificationEvidence {
  const priorSpecHashes: string[] = [];
  const scopeChanges = new Set<string>();
  const accepted = acceptedScope(ctx, revision.artifactId);
  if (accepted) {
    priorSpecHashes.push(accepted.specHash);
    for (const changed of verificationScopeChanges(accepted.expect, expect))
      scopeChanges.add(changed);
  }
  if (opts?.boundExpect && !accepted) {
    const hash = specHashOf(opts.boundExpect);
    if (!priorSpecHashes.includes(hash)) priorSpecHashes.push(hash);
    for (const changed of verificationScopeChanges(opts.boundExpect, expect))
      scopeChanges.add(changed);
  }
  const ancestorIds = new Set<string>();
  let ancestor = revision.parentId ? ctx.repo.getRevision(revision.parentId) : null;
  while (ancestor && !ancestorIds.has(ancestor.id)) {
    ancestorIds.add(ancestor.id);
    ancestor = ancestor.parentId ? ctx.repo.getRevision(ancestor.parentId) : null;
  }
  // Include pre-migration check inputs too; rewriting identical geometry never resets scope.
  for (const job of ctx.repo.listCadCheckJobs(revision.artifactId)) {
    if (accepted && job.outputHashes.verification === accepted.evidenceHash) break;
    const recorded = job.inputs as {
      expect?: Expectation;
      revisionId?: string;
      exploratory?: boolean;
    } | null;
    if (recorded?.exploratory) continue;
    // Historical inspection is not a new requirement for an already-created
    // candidate. Inherit the lineage's scope as it existed at branch creation.
    if (
      recorded?.revisionId !== revision.id &&
      (!recorded?.revisionId ||
        !ancestorIds.has(recorded.revisionId) ||
        job.createdAt > revision.createdAt)
    )
      continue;
    const prior = recorded?.expect;
    if (!prior) continue;
    const hash = specHashOf(prior);
    if (priorSpecHashes.includes(hash)) continue;
    priorSpecHashes.push(hash);
    for (const changed of verificationScopeChanges(prior, expect)) scopeChanges.add(changed);
  }
  const pass = checks.length > 0 && checks.every((c) => c.pass);
  const explicit = hasExplicitScope(expect);
  const status: CadVerificationStatus = !pass
    ? 'failed'
    : !integrity.pass
      ? 'failed'
      : !renderMatchesInput(revision.payload as MechanicalPayload, revision.files) ||
          (revision.payload as MechanicalPayload).renderIdentity?.inputFingerprint !==
            identity.inputFingerprint ||
          (revision.payload as MechanicalPayload).renderIdentity?.outputHash !== identity.outputHash
        ? 'unverified'
        : scopeChanges.size
          ? 'scope_changed'
          : !explicit
            ? 'partial'
            : 'passed';
  return {
    version: 1,
    artifactId: revision.artifactId,
    revisionId: revision.id,
    inputFingerprint: identity.inputFingerprint,
    outputHash: identity.outputHash,
    specHash: specHashOf(expect),
    checkerVersion: CAD_CHECKER_VERSION,
    expect,
    checks,
    integrity,
    pass,
    status,
    priorSpecHashes,
    scopeChanges: [...scopeChanges],
    ...(opts?.exploratory ? { exploratory: true } : {}),
    coverage: {
      units: 'mm',
      frame: 'right-handed-z-up',
      assertions: checks.map((c) => c.name),
      requirementAuthority: 'agent_or_user_declared',
      limitations: [
        'Checks cover only the declared assertions, not completeness of the engineering request.',
        'Triangle mesh and sampled cross-section/preservation checks are approximate and can miss unsampled defects.',
        'Material, mass, strength, fit tolerances and manufacturability are not assessed.',
        'A changed assertion scope requires explicit human acceptance of this evidence; acceptance does not establish completeness of the request.',
        'cad.inspect and exploratory cad.check are diagnostics; they do not bind or replace the committed request assertion spec.',
      ],
    },
  };
}

export function latestCadVerification(
  ctx: ProjectContext,
  revision: Revision,
): {
  status: CadVerificationStatus;
  evidence?: CadVerificationEvidence;
  evidenceHash?: string;
} {
  const payload = revision.payload as MechanicalPayload;
  if (!renderMatchesInput(payload, revision.files)) return { status: 'unverified' };
  const identity = payload.renderIdentity!;
  for (const job of ctx.repo.listCadCheckJobs(revision.artifactId)) {
    const ref = job.outputHashes.verification;
    if (!ref || !ctx.objects.has(ref) || !['succeeded', 'failed'].includes(job.status)) continue;
    let evidence: CadVerificationEvidence;
    try {
      evidence = JSON.parse(ctx.objects.read(ref).toString('utf8')) as CadVerificationEvidence;
    } catch {
      continue;
    }
    if (
      evidence.version !== 1 ||
      evidence.exploratory ||
      evidence.revisionId !== revision.id ||
      evidence.inputFingerprint !== identity.inputFingerprint ||
      evidence.outputHash !== identity.outputHash ||
      evidence.checkerVersion !== CAD_CHECKER_VERSION
    )
      continue;
    const stale =
      ctx.freshnessOf(revision.artifactId).freshness !== 'current' ||
      revision.inputs.some((i) => {
        const upstream = ctx.repo.getArtifact(i.artifactId);
        return (
          !upstream ||
          upstream.archived ||
          upstream.selectedRevisionId !== i.revisionId ||
          ctx.freshnessOf(i.artifactId).freshness !== 'current'
        );
      });
    const accepted = acceptedScope(ctx, revision.artifactId);
    const differsFromAccepted =
      accepted && verificationScopeChanges(accepted.expect, evidence.expect).length > 0;
    const status =
      evidence.status === 'failed'
        ? 'failed'
        : differsFromAccepted
          ? 'scope_changed'
          : evidence.status === 'scope_changed' &&
              evidence.pass &&
              evidence.integrity?.pass &&
              hasExplicitScope(evidence.expect) &&
              accepted?.specHash === evidence.specHash
            ? 'passed'
            : evidence.status;
    return { status: stale ? 'unverified' : status, evidence, evidenceHash: ref };
  }
  return { status: 'unverified' };
}

/** Call only from an authorized user review action carrying the exact displayed evidence hash. */
export function approveCadVerificationScope(
  ctx: ProjectContext,
  revision: Revision,
  evidenceHash: string,
): void {
  ctx.assertWritable();
  const current = latestCadVerification(ctx, revision);
  if (current.evidenceHash !== evidenceHash || !current.evidence)
    throw new OmenflowError(
      ErrorCodes.REVISION_CONFLICT,
      'Verification evidence changed or does not match this revision; refresh the review before accepting its scope.',
    );
  const evidence = current.evidence;
  if (
    current.status === 'unverified' ||
    !evidence.pass ||
    !evidence.integrity?.pass ||
    !hasExplicitScope(evidence.expect)
  )
    throw new OmenflowError(
      ErrorCodes.VALIDATION,
      'Failed, stale or generic-only checks cannot establish a verified engineering scope. Approve the artifact as unverified or provide matching dimensional checks.',
    );
  ctx.repo.tx(() => {
    ctx.repo.setMeta(
      `cad.scope.accepted.${revision.artifactId}`,
      JSON.stringify({
        evidenceHash,
        specHash: evidence.specHash,
        expect: evidence.expect,
        revisionId: revision.id,
      } satisfies AcceptedScope),
    );
    ctx.emit('cad.scope.accepted', 'user', {
      artifactId: revision.artifactId,
      revisionId: revision.id,
      evidenceHash,
      specHash: evidence.specHash,
      scopeChanges: evidence.scopeChanges,
    });
    const raw = ctx.repo.meta('work.active');
    if (raw) {
      try {
        const work = JSON.parse(raw) as {
          version: number;
          artifactId: string;
        } & Record<string, unknown>;
        if (work.version === 1 && work.artifactId === revision.artifactId) {
          ctx.repo.setMeta(
            'work.active',
            JSON.stringify({
              ...work,
              candidateRevisionId: revision.id,
              specHash: evidence.specHash,
              expect: evidence.expect,
              nextAction: 'request_review',
              updatedAt: new Date().toISOString(),
            }),
          );
        }
      } catch {
        /* work record is advisory; accepted scope is the durable authority */
      }
    }
  });
}
