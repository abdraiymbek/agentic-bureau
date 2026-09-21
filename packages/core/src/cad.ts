import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  ErrorCodes,
  Job,
  MechanicalPayload,
  Origin,
  OmenflowError,
  formatQty,
  dimOf,
  isUnknown,
  newId,
  type Artifact,
  type Expectation,
  type Revision,
  type MaybeQuantity,
  type RecordedInput,
} from '@omenflow/contracts';
import type { ProjectContext } from './context.js';
import { commitRevision, materializeReadableView } from './artifacts.js';
import { slugify } from './hash.js';
import type { CadAdapter } from './tools.js';
import {
  analyzeMesh,
  analyzeMeshCancellable,
  runMeshTask,
  assertMeshByteLimit,
  assertCadInspectionBudget,
  containsPoint,
  countIntersectingPairs,
  crossSection,
  crossSectionPlane,
  minWallThickness,
  orientTriangles,
  parseStlTriangles,
  writeBinaryStl,
  type Axis,
  type MeshReport,
  type TriangleBuffer,
  type Vec3,
} from './mesh.js';
import {
  ensureDefaultFaceting,
  parseScadParameters,
  setScadParameter,
  type ScadParameter,
} from './scad-params.js';
import { describeLoop, findLoosenedAssertions, fmtNum, type CheckResult } from './cad-checks.js';

import { createCadVerificationEvidence, type CadVerificationStatus } from './cad-verification.js';
import { readActiveWork, recordCommittedCheck } from './work.js';
import {
  assertSelfContainedScad,
  canonicalScadRef,
  effectiveCadParams,
  renderFingerprint,
  reconcileCadOverrides,
  renderMatchesInput,
  type RenderIdentity,
  type ScadValue,
} from './cad-input.js';

function cadTool(ctx: ProjectContext): CadAdapter {
  const cad = ctx.tools.cad as CadAdapter | undefined;
  if (!cad) {
    throw new OmenflowError(ErrorCodes.TOOL_MISSING, 'No CAD adapter registered', {
      repair: 'Check Connections for tool registration.',
    });
  }
  return cad;
}

export async function cadProbe(ctx: ProjectContext) {
  return cadTool(ctx).probe();
}

/* ------------------------------------------------------------------ */
/* Revision resolution                                                 */
/* ------------------------------------------------------------------ */

function requireMechanical(ctx: ProjectContext, artifactId: string): Artifact {
  const artifact = ctx.requireArtifact(artifactId);
  if (artifact.type !== 'mechanical') {
    throw new OmenflowError(
      ErrorCodes.VALIDATION,
      `Artifact "${artifact.title}" is a ${artifact.type}, not a mechanical part`,
      {
        repair:
          'Pass the artifactId of a mechanical artifact (see artifact.list with type "mechanical").',
      },
    );
  }
  return artifact;
}

/**
 * Pick the revision CAD ops work on. Explicit id wins; otherwise the newest
 * revision (draft or baseline) — the agent's most recent work, which is what
 * "inspect/check the part" means in a session.
 */
function pickRevision(ctx: ProjectContext, artifact: Artifact, revisionId?: string): Revision {
  if (revisionId) {
    const rev = ctx.requireRevision(revisionId);
    if (rev.artifactId !== artifact.id) {
      throw new OmenflowError(
        ErrorCodes.VALIDATION,
        `Revision ${revisionId} does not belong to artifact ${artifact.id}`,
      );
    }
    return rev;
  }
  const rev = ctx.repo
    .listRevisions(artifact.id)
    .filter((r) => r.reviewState !== 'rejected' && r.reviewState !== 'superseded')
    .at(-1);
  if (!rev) throw new OmenflowError(ErrorCodes.VALIDATION, 'Mechanical artifact has no revision');
  return rev;
}

/** Both UI and agent operations resolve the same explicit or active candidate. */
function mechPayload(ctx: ProjectContext, artifactId: string, revisionId?: string) {
  const artifact = requireMechanical(ctx, artifactId);
  const rev = pickRevision(ctx, artifact, revisionId);
  return { artifact, rev, payload: rev.payload as MechanicalPayload };
}

const scadRefOf = canonicalScadRef;
function stlRefOf(rev: Revision) {
  const payload = rev.payload as MechanicalPayload;
  return (
    rev.files.find((f) => f.path === payload.stl?.path) ??
    rev.files.find((f) => f.path.endsWith('.stl')) ??
    payload.stl
  );
}

function readScad(ctx: ProjectContext, rev: Revision): { path: string; source: string } {
  const ref = scadRefOf(rev);
  if (!ref) throw new OmenflowError(ErrorCodes.NOT_FOUND, 'This revision has no OpenSCAD source');
  if (ref.sha256 && ctx.objects.has(ref.sha256)) {
    return { path: ref.path, source: ctx.objects.read(ref.sha256).toString('utf8') };
  }
  const abs = ctx.resolvePath(ref.path);
  if (!fs.existsSync(abs))
    throw new OmenflowError(ErrorCodes.NOT_FOUND, `Missing source file: ${ref.path}`);
  return { path: ref.path, source: fs.readFileSync(abs, 'utf8') };
}

function readMeshObject(ctx: ProjectContext, hash: string): Buffer {
  assertMeshByteLimit(fs.statSync(ctx.objects.absPath(hash)).size);
  return ctx.objects.read(hash);
}

const plainParams = effectiveCadParams;

function assertParamsExist(params: Record<string, ScadValue>, declared: ScadParameter[]): void {
  const names = new Set(declared.map((p) => p.name));
  const unknown = Object.keys(params).filter((k) => !names.has(k));
  if (unknown.length) {
    throw new OmenflowError(
      ErrorCodes.VALIDATION,
      `Unknown parameter${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. ` +
        (names.size
          ? `Top-level variables in this source: ${[...names].join(', ')}.`
          : 'The source declares no top-level variables — add `name = value;` lines at file scope to make it parametric.'),
      { details: { unknown, available: [...names] } },
    );
  }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

interface RenderOutcome {
  ok: boolean;
  ms: number;
  tool: string;
  warnings: string[];
  errors: string[];
  log: string;
  stl?: Buffer;
  tris?: TriangleBuffer;
  error?: string;
  oriented?: boolean;
  identity?: RenderIdentity;
}

function applyOrientation(
  stl: Buffer,
  tris: TriangleBuffer,
): {
  stl: Buffer;
  tris: TriangleBuffer;
  oriented: boolean;
} {
  const r = orientTriangles(tris);
  if (!r.flipped) return { stl, tris, oriented: false };
  return { stl: writeBinaryStl(r.tris), tris: r.tris, oriented: true };
}

function classifyLog(log: string): { warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  for (const raw of log.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^ERROR:|^Execution aborted|^Can't|^Parser error|top level object is empty/i.test(line))
      errors.push(line);
    else if (/^WARNING:|^DEPRECATED:/i.test(line)) warnings.push(line);
  }
  return {
    warnings: [...new Set(warnings)].slice(0, 12),
    errors: [...new Set(errors)].slice(0, 12),
  };
}

/**
 * Render OpenSCAD source with parameter overrides and return the mesh.
 * Synchronous from the caller's point of view (awaited), tracked as a job for
 * evidence and cancellation. Results are cached by (source, params).
 */
async function renderSource(
  ctx: ProjectContext,
  args: {
    source: string;
    params: Record<string, ScadValue>;
    timeoutMs: number;
    origin: Origin;
    artifactId: string;
    revisionId?: string;
    existingJob?: Job;
  },
): Promise<{ outcome: RenderOutcome; job: Job }> {
  ctx.assertWritable();
  assertSelfContainedScad(args.source);
  const cad = cadTool(ctx);
  const started = Date.now();
  const job =
    args.existingJob ??
    ctx.createJob({
      kind: 'cad_render',
      tool: cad.toolId,
      inputHashes: { source: ctx.storeContent(args.source) },
      inputs: {
        artifactId: args.artifactId,
        revisionId: args.revisionId ?? null,
        params: args.params,
      },
      sessionId: args.origin.kind === 'agent' ? args.origin.sessionId : null,
    });
  ctx.jobCancels.set(job.id, () => cad.cancel(job.id));
  let workDir: string | undefined;
  let log = '';
  let tool = cad.toolId;
  let sharedFingerprint: string | undefined;
  let pendingShare: Promise<{ rawStl: Buffer; log: string }> | undefined;
  let failShared: ((error: unknown) => void) | undefined;
  let notifyShared: ((value: { rawStl: Buffer; log: string }) => void) | undefined;
  try {
    ctx.assertJobActive(job.id);
    ctx.jobStatus(job.id, 'running');
    const probe = await cad.probe();
    ctx.assertJobActive(job.id);
    if (!probe.available)
      throw new OmenflowError(ErrorCodes.TOOL_MISSING, probe.error ?? 'OpenSCAD not found', {
        repair: 'Install OpenSCAD, then Connections → Locate OpenSCAD.',
      });
    tool = `${cad.toolId} ${probe.version ?? ''}`.trim();
    const identityBase: Omit<RenderIdentity, 'inputFingerprint' | 'outputHash'> = {
      version: 1,
      sourceHash: createHash('sha256').update(args.source).digest('hex'),
      params: args.params,
      modelUnit: 'mm',
      frame: 'right-handed-z-up',
      engine: cad.toolId,
      engineVersion: probe.version ?? 'unknown',
      options: `stl;orientation-v1;exe=${probe.executablePath ?? 'unknown'}`,
    };
    const fingerprint = renderFingerprint(identityBase);
    const cacheDir = ctx.resolvePath(`.omenflow/cache/render-v1/${fingerprint}`);
    const cachedStl = path.join(cacheDir, 'output.stl');
    const manifest = path.join(cacheDir, 'complete.json');
    const finishMesh = (stl: Buffer, cached: boolean): RenderOutcome => {
      assertMeshByteLimit(stl.byteLength);
      if (!cad.inspectStl(stl).plausible)
        throw new OmenflowError(
          ErrorCodes.VALIDATION,
          'OpenSCAD output is not a complete STL mesh',
        );
      const tris = parseStlTriangles(stl);
      if (!tris.length || !tris.every(Number.isFinite))
        throw new OmenflowError(ErrorCodes.VALIDATION, 'OpenSCAD output has no finite geometry');
      const oriented = applyOrientation(stl, tris);
      const outputHash = ctx.objects.put(oriented.stl);
      return {
        ok: true,
        ms: Date.now() - started,
        tool: cached ? `${tool} (cached)` : tool,
        ...classifyLog(log),
        log,
        ...oriented,
        identity: { ...identityBase, inputFingerprint: fingerprint, outputHash },
      };
    };
    // A cache entry is visible only after output + manifest have been atomically published.
    if (fs.existsSync(manifest) && fs.existsSync(cachedStl)) {
      try {
        const stored = JSON.parse(fs.readFileSync(manifest, 'utf8')) as {
          fingerprint: string;
          outputHash: string;
          log: string;
        };
        assertMeshByteLimit(fs.statSync(cachedStl).size);
        const stl = fs.readFileSync(cachedStl);
        if (
          stored.fingerprint === fingerprint &&
          createHash('sha256').update(stl).digest('hex') === stored.outputHash
        ) {
          log = stored.log;
          ctx.assertJobActive(job.id);
          const outcome = finishMesh(stl, true);
          return { outcome, job };
        }
      } catch {
        /* A corrupt/incomplete cache is disposable, never evidence. */
      }
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
    const existingShare = ctx.inFlightRenders.get(fingerprint);
    if (existingShare) {
      try {
        const shared = await existingShare;
        ctx.assertJobActive(job.id);
        log = shared.log;
        return { outcome: finishMesh(shared.rawStl, true), job };
      } catch {
        /* Leader failed or was cancelled; this job still owes a render. */
      }
    }
    if (!ctx.inFlightRenders.has(fingerprint)) {
      pendingShare = new Promise<{ rawStl: Buffer; log: string }>((resolve, reject) => {
        notifyShared = resolve;
        failShared = reject;
      });
      void pendingShare.catch(() => {});
      sharedFingerprint = fingerprint;
      ctx.inFlightRenders.set(fingerprint, pendingShare);
    } else {
      try {
        const shared = await ctx.inFlightRenders.get(fingerprint)!;
        ctx.assertJobActive(job.id);
        log = shared.log;
        return { outcome: finishMesh(shared.rawStl, true), job };
      } catch {
        pendingShare = new Promise<{ rawStl: Buffer; log: string }>((resolve, reject) => {
          notifyShared = resolve;
          failShared = reject;
        });
        void pendingShare.catch(() => {});
        sharedFingerprint = fingerprint;
        ctx.inFlightRenders.set(fingerprint, pendingShare);
      }
    }
    workDir = ctx.resolvePath(`.omenflow/cache/render-work/${job.id}`);
    fs.mkdirSync(workDir, { recursive: true });
    const scadPath = path.join(workDir, 'input.scad');
    const outPath = path.join(workDir, 'output.stl');
    fs.writeFileSync(scadPath, args.source);
    ctx.repo.updateJob(job.id, {
      toolVersion: probe.version,
      command: `${probe.executablePath} -o output.stl input.scad`,
    });
    ctx.assertJobActive(job.id);
    const res = await cad.render(
      { jobId: job.id, scadPath, outPath, params: args.params, timeoutMs: args.timeoutMs, workDir },
      (chunk) => {
        log += chunk;
        ctx.jobLog(job.id, chunk);
      },
    );
    ctx.assertJobActive(job.id);
    const diagnostics = classifyLog(log);
    if (
      !res.ok ||
      diagnostics.errors.length ||
      !fs.existsSync(outPath) ||
      fs.statSync(outPath).size === 0
    ) {
      const message =
        res.error === 'timeout'
          ? `Render exceeded ${args.timeoutMs} ms — simplify the model or raise timeoutMs.`
          : /top level object is empty/i.test(log)
            ? 'OpenSCAD produced no geometry: the top-level object is empty.'
            : (diagnostics.errors[0] ??
              diagnostics.warnings[0] ??
              res.error ??
              'OpenSCAD produced no geometry');
      ctx.jobStatus(job.id, res.error === 'cancelled' ? 'cancelled' : 'failed', {
        error: {
          code: res.error === 'timeout' ? ErrorCodes.TIMEOUT : ErrorCodes.VALIDATION,
          message,
        },
      });
      failShared?.(new OmenflowError(ErrorCodes.VALIDATION, message));
      return {
        job,
        outcome: { ok: false, ms: Date.now() - started, tool, ...diagnostics, log, error: message },
      };
    }
    assertMeshByteLimit(fs.statSync(outPath).size);
    const rawStl = fs.readFileSync(outPath);
    const outcome = finishMesh(rawStl, false);
    notifyShared?.({ rawStl, log });
    ctx.assertJobActive(job.id);
    fs.writeFileSync(outPath, outcome.stl!);
    fs.writeFileSync(
      path.join(workDir, 'complete.json'),
      JSON.stringify({ fingerprint, outputHash: outcome.identity!.outputHash, log }),
    );
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
    // Concurrent renders use separate directories. A complete winner may be reused.
    if (!fs.existsSync(cacheDir)) fs.renameSync(workDir, cacheDir);
    return { outcome, job };
  } catch (error) {
    failShared?.(error);
    const e = OmenflowError.from(error);
    ctx.jobStatus(job.id, e.code === ErrorCodes.CANCELLED ? 'cancelled' : 'failed', {
      error: e.toBody(),
    });
    throw e;
  } finally {
    ctx.jobCancels.delete(job.id);
    if (
      sharedFingerprint &&
      pendingShare &&
      ctx.inFlightRenders.get(sharedFingerprint) === pendingShare
    )
      ctx.inFlightRenders.delete(sharedFingerprint);
    if (workDir && fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function completeRenderJob(ctx: ProjectContext, job: Job, outcome: RenderOutcome): void {
  if (!outcome.ok) return;
  ctx.assertJobActive(job.id);
  ctx.jobStatus(job.id, 'succeeded', { outputHashes: { stl: outcome.identity!.outputHash } });
}

/* ------------------------------------------------------------------ */
/* Reports                                                             */
/* ------------------------------------------------------------------ */

export interface GeometrySummary {
  unit: string;
  bounds: { min: Vec3; max: Vec3; size: Vec3 };
  volume: number;
  surfaceArea: number;
  triangles: number;
  watertight: boolean;
  shells: number;
}

export interface SectionReport {
  plane: string;
  loops: string[];
}

export interface CadReport {
  artifactId: string;
  revisionId: string;
  title: string;
  sourcePath: string;
  render: {
    ok: boolean;
    tool: string;
    ms: number;
    warnings: string[];
    errors: string[];
    error?: string;
  };
  geometry?: GeometrySummary;
  sections?: SectionReport[];
  probes?: { point: Vec3; result: 'solid' | 'empty' }[];
  parameters: {
    name: string;
    value: ScadValue;
    comment?: string;
    derived?: boolean;
    expr?: string;
  }[];
  notes: string[];
  next: string;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

function geometrySummary(report: MeshReport, unit: string): GeometrySummary {
  return {
    unit,
    bounds: {
      min: report.bounds.min.map(r3) as Vec3,
      max: report.bounds.max.map(r3) as Vec3,
      size: report.bounds.size.map(r3) as Vec3,
    },
    volume: r3(report.volume),
    surfaceArea: r3(report.surfaceArea),
    triangles: report.triangles,
    watertight: report.topology.watertight && !report.invertedNormals,
    shells: report.topology.shells,
  };
}

const MAX_LOOPS_PER_SECTION = 16;

function sectionReport(
  tris: TriangleBuffer,
  axis: Axis,
  at: number,
  label?: string,
): SectionReport {
  const s = crossSection(tris, axis, at);
  const [a, b] = s.planeAxes;
  const loops = s.loops.slice(0, MAX_LOOPS_PER_SECTION).map((l) => describeLoop(l, a, b));
  if (s.loops.length > MAX_LOOPS_PER_SECTION)
    loops.push(`…and ${s.loops.length - MAX_LOOPS_PER_SECTION} more loops`);
  if (s.loops.length === 0) loops.push('no material in this plane');
  if (s.openChains > 0)
    loops.push(`warning: ${s.openChains} open chain(s) — mesh is not closed at this plane`);
  return { plane: `${axis}=${fmtNum(r3(at))}${label ? ` (${label})` : ''}`, loops };
}

function autoSections(tris: TriangleBuffer, report: MeshReport): SectionReport[] {
  const { min, max } = report.bounds;
  const out: SectionReport[] = [];
  for (const axis of ['z', 'y', 'x'] as Axis[]) {
    const i = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
    const span = max[i]! - min[i]!;
    if (span <= 0) continue;
    // Slightly off the exact middle so a mid-height face never becomes the plane.
    out.push(sectionReport(tris, axis, min[i]! + span * 0.5 + 1e-3, 'mid'));
  }
  // Parts are usually built up along Z: features that stop short of a face
  // (blind bores, cutters that end early) show up near the ends, not the middle.
  const zSpan = max[2]! - min[2]!;
  if (zSpan > 0) {
    out.push(sectionReport(tris, 'z', min[2]! + zSpan * 0.1 + 1e-3, 'near bottom'));
    out.push(sectionReport(tris, 'z', min[2]! + zSpan * 0.9 + 1e-3, 'near top'));
  }
  return out;
}

function geometryNotes(
  report: MeshReport,
  tris: TriangleBuffer,
  params: ScadParameter[],
): string[] {
  const notes: string[] = [];
  if (report.topology.shells > 1) {
    notes.push(
      `${report.topology.shells} disconnected bodies — if this should be one part, make the features overlap or touch (a shared face is not enough; overlap by a small amount).`,
    );
  }
  if (!report.topology.watertight) {
    notes.push(
      `Mesh is not closed (${report.topology.boundaryEdges} boundary edges, ${report.topology.nonManifoldEdges} non-manifold edges).`,
    );
  }
  if (report.invertedNormals) {
    notes.push(
      "Mesh is inside-out (negative signed volume). With polyhedron(), list each face's vertices clockwise when viewed from outside the solid; booleans on an inside-out body cut the wrong side. Open meshes are diagnosed, not auto-flipped.",
    );
  }
  let crossings = 0;
  try {
    crossings = countIntersectingPairs(tris);
  } catch (error) {
    if (
      error instanceof OmenflowError &&
      (error.details as { reason?: string } | undefined)?.reason === 'CAD_WORK_LIMIT'
    ) {
      notes.push(
        `Self-intersections not evaluated: ${error.message}. This report does not establish intersection-free geometry.`,
      );
    } else throw error;
  }
  if (crossings > 0) {
    notes.push(
      `${crossings} self-intersecting triangle pair(s) — overlapping bodies or piercing faces can still satisfy bbox/volume. Separate the solids or boolean them; cad.check maxSelfIntersections: 0 to fail on this.`,
    );
  }
  const wall = minWallThickness(tris, 80);
  if (wall !== null && wall < 0.4) {
    notes.push(
      `Minimum sampled wall thickness is ${fmtNum(wall)} mm — thin skins often mean a cutter ended on a face instead of through it.`,
    );
  }
  // Faceting check on any circular loop in the mid sections.
  let coarse: string | null = null;
  const { min, max } = report.bounds;
  for (const axis of ['z', 'y', 'x'] as Axis[]) {
    const i = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
    if (max[i]! - min[i]! <= 0) continue;
    const s = crossSection(tris, axis, min[i]! + (max[i]! - min[i]!) * 0.5 + 1e-3);
    for (const l of s.loops) {
      if (
        l.circle &&
        l.circle.roundness >= 0.75 &&
        l.circle.roundness < 0.97 &&
        l.points.length <= 24
      ) {
        coarse = `${l.points.length}-sided`;
        break;
      }
    }
    if (coarse) break;
  }
  if (coarse) {
    notes.push(
      `A circular feature renders as a ${coarse} polygon (coarse faceting). Unless a polygon was intended, set $fn (e.g. $fn = 64;) so holes and cylinders are round.`,
    );
  }
  if (params.length === 0)
    notes.push(
      'No top-level parameters found. Exposing key dimensions as `name = value;` at file scope makes the part re-sizable via params.',
    );
  return notes;
}

const NEXT_STEP =
  'Compare these measurements with the request. Then call cad.check with explicit expectations (envelope, hole positions and diameters in cross-sections, solid/empty points) and fix any failure. Report done only when all checks pass.';

type ExtraSection = { axis?: Axis; at?: number; origin?: Vec3; normal?: Vec3 };

function extraSectionReport(tris: TriangleBuffer, spec: ExtraSection): SectionReport {
  if (spec.origin && spec.normal) {
    const s = crossSectionPlane(tris, spec.origin, spec.normal);
    const [a, b] = s.planeAxes;
    const loops = s.loops.slice(0, MAX_LOOPS_PER_SECTION).map((l) => describeLoop(l, a, b));
    if (s.loops.length > MAX_LOOPS_PER_SECTION)
      loops.push(`…and ${s.loops.length - MAX_LOOPS_PER_SECTION} more loops`);
    if (s.loops.length === 0) loops.push('no material in this plane');
    if (s.openChains > 0)
      loops.push(`warning: ${s.openChains} open chain(s) — mesh is not closed at this plane`);
    return {
      plane: `origin=(${spec.origin.map(fmtNum).join(', ')}) n=(${spec.normal.map(fmtNum).join(', ')})`,
      loops,
    };
  }
  if (spec.axis === undefined || spec.at === undefined) {
    return { plane: 'invalid section (need axis+at or origin+normal)', loops: [] };
  }
  return sectionReport(tris, spec.axis, spec.at);
}

function buildReport(args: {
  artifact: Artifact;
  revision: Revision;
  sourcePath: string;
  source: string;
  outcome: RenderOutcome;
  unit: string;
  extraSections?: ExtraSection[];
  probes?: Vec3[];
  injectedFn?: boolean;
  effectiveParams?: Record<string, ScadValue>;
}): CadReport {
  const effective =
    args.effectiveParams ??
    args.outcome.identity?.params ??
    plainParams((args.revision.payload as MechanicalPayload).params, args.unit);
  let effectiveSource = args.source;
  for (const [name, value] of Object.entries(effective)) {
    effectiveSource = setScadParameter(effectiveSource, name, value).source;
  }
  const params = parseScadParameters(effectiveSource);
  const base: CadReport = {
    artifactId: args.artifact.id,
    revisionId: args.revision.id,
    title: args.artifact.title,
    sourcePath: args.sourcePath,
    render: {
      ok: args.outcome.ok,
      tool: args.outcome.tool,
      ms: args.outcome.ms,
      warnings: args.outcome.warnings,
      errors: args.outcome.errors,
      ...(args.outcome.error ? { error: args.outcome.error } : {}),
    },
    parameters: params.map((p) => ({
      name: p.name,
      value: p.value,
      derived: p.derived,
      ...(p.expr ? { expr: p.expr } : {}),
      ...(p.comment ? { comment: p.comment } : {}),
    })),
    notes: [],
    next: NEXT_STEP,
  };
  if (!args.outcome.ok || !args.outcome.tris) {
    base.notes.push('Render failed — fix the source and call cad.write_source again.');
    if (args.outcome.warnings.length)
      base.notes.push(
        'OpenSCAD warnings usually point at the cause (unknown variable = typo, empty object = nothing left after difference).',
      );
    return base;
  }
  const tris = args.outcome.tris;
  assertCadInspectionBudget(tris, args.probes?.length ?? 0, args.extraSections?.length ?? 0);
  const report = analyzeMesh(tris);
  base.geometry = geometrySummary(report, args.unit);
  base.sections = [
    ...autoSections(tris, report),
    ...(args.extraSections ?? []).map((s) => extraSectionReport(tris, s)),
  ];
  if (args.probes?.length) {
    base.probes = args.probes.map((p) => ({
      point: p,
      result: containsPoint(tris, p) ? 'solid' : 'empty',
    }));
  }
  base.notes = geometryNotes(report, tris, params);
  if (args.outcome.oriented) {
    base.notes.unshift(
      'Mesh was inside-out; oriented so signed volume is positive (watertight only — open meshes are not flipped).',
    );
  }
  if (args.injectedFn) {
    base.notes.unshift(
      'Injected $fn = 64 so curved primitives render as circles instead of the default coarse polygon.',
    );
  }
  if (args.outcome.warnings.length) {
    base.notes.unshift(
      'OpenSCAD reported warnings (see render.warnings) — an unknown variable usually means a typo; fix before trusting the geometry.',
    );
  }
  return base;
}

/* ------------------------------------------------------------------ */
/* cad.write_source                                                    */
/* ------------------------------------------------------------------ */

function uniqueSourcePath(ctx: ProjectContext, title: string, artifactId: string): string {
  const slug = slugify(title);
  const candidate = `artifacts/mechanical/${slug}.scad`;
  const taken = ctx.repo.listArtifacts({ type: 'mechanical', includeArchived: true }).some((a) => {
    if (a.id === artifactId) return false;
    const rev = ctx.repo.listRevisions(a.id).at(-1);
    return !!rev && scadRefOf(rev)?.path === candidate;
  });
  return taken ? `artifacts/mechanical/${slug}-${artifactId.slice(0, 8)}.scad` : candidate;
}

export async function cadWriteSource(
  ctx: ProjectContext,
  input: {
    artifactId?: string;
    expectedRevisionId?: string;
    /** Internal composition snapshot provenance. */
    inputs?: RecordedInput[];
    existingJob?: Job;
    paramManifest?: MechanicalPayload['paramManifest'];
    title?: string;
    source: string;
    params?: Record<string, ScadValue>;
    subsystem?: string | null;
    rationale: string;
    timeoutMs: number;
  },
  origin: Origin,
): Promise<CadReport> {
  ctx.assertWritable();
  const faceted = ensureDefaultFaceting(input.source);
  const source = faceted.source;
  const declared = parseScadParameters(source);
  assertSelfContainedScad(source);
  const overrides = plainParams(input.params);
  assertParamsExist(overrides, declared);

  let artifact: Artifact;
  let parent: Revision | null = null;
  let prevPayload: MechanicalPayload = { params: {}, paramManifest: [], modelUnit: 'mm' };
  if (input.artifactId) {
    artifact = requireMechanical(ctx, input.artifactId);
    parent = pickRevision(ctx, artifact);
    if (input.expectedRevisionId && parent.id !== input.expectedRevisionId)
      throw new OmenflowError(
        ErrorCodes.REVISION_CONFLICT,
        'CAD input revision changed; read the current source before retrying.',
      );
    prevPayload = parent.payload as MechanicalPayload;
  } else {
    if (!input.title) {
      throw new OmenflowError(ErrorCodes.VALIDATION, 'title is required when creating a new part', {
        repair: 'Pass title (new part) or artifactId (revise an existing part).',
      });
    }
    artifact = {
      id: newId(),
      type: 'mechanical',
      title: input.title,
      subsystem: input.subsystem ?? null,
      selectedRevisionId: null,
      archived: false,
      createdAt: new Date().toISOString(),
    };
  }
  const sourcePath = parent
    ? (scadRefOf(parent)?.path ?? uniqueSourcePath(ctx, artifact.title, artifact.id))
    : uniqueSourcePath(ctx, artifact.title, artifact.id);
  const absoluteSource = ctx.resolvePath(sourcePath);
  const workingHash = fs.existsSync(absoluteSource)
    ? createHash('sha256').update(fs.readFileSync(absoluteSource)).digest('hex')
    : null;
  const scadSha = ctx.storeContent(source);
  const scadRef = { path: sourcePath, sha256: scadSha, role: 'source' as const };

  // Recorded params: previous values (dropping ones the source no longer declares) + overrides.
  const declaredNames = new Set(declared.map((p) => p.name));
  const inherited = parent
    ? reconcileCadOverrides(
        source,
        readScad(ctx, parent).source,
        plainParams(prevPayload.params, prevPayload.modelUnit),
      )
    : {};
  const recorded: Record<string, ScadValue> = {};
  for (const [k, v] of Object.entries(inherited)) if (declaredNames.has(k)) recorded[k] = v;
  Object.assign(recorded, overrides);

  const { outcome, job } = await renderSource(ctx, {
    source,
    params: recorded,
    timeoutMs: input.timeoutMs,
    origin,
    artifactId: artifact.id,
    revisionId: parent?.id,
    existingJob: input.existingJob,
  });

  try {
    const files = [scadRef];
    const payload: MechanicalPayload = {
      ...prevPayload,
      scad: scadRef,
      stl: undefined,
      params: recorded,
      paramManifest:
        input.paramManifest ??
        declared.map((p) => ({
          name: p.name,
          dimension:
            prevPayload.paramManifest.find((m) => m.name === p.name)?.dimension ??
            (typeof p.value === 'boolean'
              ? 'boolean'
              : typeof p.value === 'string'
                ? 'text'
                : p.name === '$fn'
                  ? 'count'
                  : 'number'),
          ...(prevPayload.paramManifest.find((m) => m.name === p.name)?.unit
            ? { unit: prevPayload.paramManifest.find((m) => m.name === p.name)!.unit }
            : {}),
          ...(p.comment ? { description: p.comment } : {}),
        })),
      modelUnit: prevPayload.modelUnit ?? 'mm',
      bounds: undefined,
      renderJobId: job.id,
      renderIdentity: outcome.identity,
    };
    let stlRef: { path: string; sha256: string; role: 'output' } | null = null;
    if (outcome.ok && outcome.stl && outcome.tris) {
      const stlSha = ctx.objects.put(outcome.stl);
      stlRef = {
        path: `${sourcePath.replace(/\.scad$/i, '')}.stl`,
        sha256: stlSha,
        role: 'output',
      };
      files.push(stlRef as never);
      const report = analyzeMesh(outcome.tris);
      payload.stl = stlRef;
      payload.bounds = {
        min: report.bounds.min.map(r3) as Vec3,
        max: report.bounds.max.map(r3) as Vec3,
      };
    }
    // All asynchronous work is complete. Do not overwrite a newer app or external edit.
    ctx.assertJobActive(job.id, { allowFailed: !outcome.ok });
    const nowHash = fs.existsSync(absoluteSource)
      ? createHash('sha256').update(fs.readFileSync(absoluteSource)).digest('hex')
      : null;
    if (
      (parent && pickRevision(ctx, ctx.requireArtifact(artifact.id)).id !== parent.id) ||
      nowHash !== workingHash
    ) {
      let conflictRev: Revision | undefined;
      ctx.repo.tx(() => {
        if (!parent) ctx.repo.insertArtifact(artifact);
        conflictRev = commitRevision(ctx, {
          artifactId: artifact.id,
          parentId: parent?.id ?? null,
          origin,
          payload,
          files,
          inputs: input.inputs ?? parent?.inputs ?? [],
          rationale: 'conflict candidate: source changed during render',
          reviewState: 'draft',
          skipMaterialize: true,
        });
      });
      ctx.jobStatus(job.id, 'failed', {
        error: {
          code: ErrorCodes.REVISION_CONFLICT,
          message: 'Source changed during render; result was kept as a conflict candidate.',
        },
        outputHashes: {
          scad: scadSha,
          ...(stlRef ? { stl: stlRef.sha256 } : {}),
          revision: conflictRev!.id,
        },
      });
      throw new OmenflowError(
        ErrorCodes.REVISION_CONFLICT,
        'Source changed during render; reread/rebase before retrying. Your existing work was preserved.',
        {
          repair: 'Review the conflict candidate revision; the working file was left unchanged.',
          details: { conflictRevisionId: conflictRev!.id, jobId: job.id, sourcePath },
        },
      );
    }
    let rev!: Revision;
    ctx.repo.tx(() => {
      if (!parent) ctx.repo.insertArtifact(artifact);
      rev = commitRevision(ctx, {
        artifactId: artifact.id,
        parentId: parent?.id ?? null,
        origin,
        payload,
        files,
        inputs: input.inputs ?? parent?.inputs ?? [],
        rationale: input.rationale || (parent ? 'source revised' : 'initial source'),
        reviewState: 'draft',
      });
    });
    // The revision and working-source CAS above passed with no intervening await.
    ctx.materialize(sourcePath, scadSha, rev.id, { overwrite: true });
    if (stlRef) ctx.materialize(stlRef.path, stlRef.sha256, rev.id, { overwrite: true });
    materializeReadableView(ctx, artifact, rev);

    const report = buildReport({
      artifact,
      revision: rev,
      sourcePath,
      source,
      outcome,
      unit: payload.modelUnit,
      injectedFn: faceted.injected,
    });
    completeRenderJob(ctx, job, outcome);
    return report;
  } catch (error) {
    const e = OmenflowError.from(error);
    ctx.jobStatus(job.id, e.code === ErrorCodes.CANCELLED ? 'cancelled' : 'failed', {
      error: e.toBody(),
      outputHashes: outcome.identity ? { stl: outcome.identity.outputHash } : undefined,
    });
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* cad.read_source                                                     */
/* ------------------------------------------------------------------ */

export function cadReadSource(
  ctx: ProjectContext,
  input: { artifactId: string; revisionId?: string },
) {
  const artifact = requireMechanical(ctx, input.artifactId);
  const rev = pickRevision(ctx, artifact, input.revisionId);
  const { path: sourcePath, source } = readScad(ctx, rev);
  const payload = rev.payload as MechanicalPayload;
  const effective = plainParams(payload.params, payload.modelUnit);
  let effectiveSource = source;
  for (const [name, value] of Object.entries(effective))
    effectiveSource = setScadParameter(effectiveSource, name, value).source;
  const params = parseScadParameters(effectiveSource);
  return {
    artifactId: artifact.id,
    revisionId: rev.id,
    title: artifact.title,
    revisionSeq: rev.seq,
    reviewState: rev.reviewState,
    isBaseline: artifact.selectedRevisionId === rev.id,
    sourcePath,
    source,
    parameters: params.map((p) => ({
      name: p.name,
      value: plainParams(payload.params, payload.modelUnit)[p.name] ?? p.value,
      derived: p.derived,
      ...(p.expr ? { expr: p.expr } : {}),
      ...(p.comment ? { comment: p.comment } : {}),
    })),
    recordedParams: plainParams(payload.params, payload.modelUnit),
    unit: payload.modelUnit ?? 'mm',
    hasRender: renderMatchesInput(payload, rev.files),
    next: 'Edit the source as needed and save it with cad.write_source({ artifactId, source }) — this creates a new draft revision on the same part; the baseline is untouched until a human approves.',
  };
}

/* ------------------------------------------------------------------ */
/* Mesh resolution for inspect / check                                 */
/* ------------------------------------------------------------------ */

async function resolveMesh(
  ctx: ProjectContext,
  input: { artifactId: string; revisionId?: string; params?: Record<string, ScadValue> },
  origin: Origin,
): Promise<{
  artifact: Artifact;
  rev: Revision;
  sourcePath: string;
  source: string;
  outcome: RenderOutcome;
  unit: string;
}> {
  const artifact = requireMechanical(ctx, input.artifactId);
  const rev = pickRevision(ctx, artifact, input.revisionId);
  const payload = rev.payload as MechanicalPayload;
  const unit = payload.modelUnit ?? 'mm';
  const { path: sourcePath, source } = readScad(ctx, rev);
  const declared = parseScadParameters(source);
  const overrides = input.params ?? {};
  assertParamsExist(overrides, declared);
  const stl = stlRefOf(rev);
  if (
    Object.keys(overrides).length === 0 &&
    renderMatchesInput(payload, rev.files) &&
    stl?.sha256 &&
    ctx.objects.has(stl.sha256)
  ) {
    const buf = readMeshObject(ctx, stl.sha256);
    const tris = parseStlTriangles(buf);
    if (tris.length > 0) {
      const oriented = applyOrientation(buf, tris);
      return {
        artifact,
        rev,
        sourcePath,
        source,
        unit,
        outcome: {
          ok: true,
          ms: 0,
          tool: 'stored render',
          warnings: [],
          errors: [],
          log: '',
          stl: oriented.stl,
          tris: oriented.tris,
          oriented: oriented.oriented,
          identity: payload.renderIdentity,
        },
      };
    }
  }
  const params = { ...plainParams(payload.params, unit), ...plainParams(overrides) };
  const { outcome, job } = await renderSource(ctx, {
    source,
    params,
    timeoutMs: 90_000,
    origin,
    artifactId: artifact.id,
    revisionId: rev.id,
  });
  completeRenderJob(ctx, job, outcome);
  return { artifact, rev, sourcePath, source, outcome, unit };
}

/* ------------------------------------------------------------------ */
/* cad.inspect                                                         */
/* ------------------------------------------------------------------ */

export async function cadInspect(
  ctx: ProjectContext,
  input: {
    artifactId: string;
    revisionId?: string;
    params?: Record<string, ScadValue>;
    sections?: ExtraSection[];
    probes?: Vec3[];
  },
  origin: Origin,
): Promise<CadReport & { legacy?: unknown }> {
  const m = await resolveMesh(ctx, input, origin);
  const report = buildReport({
    artifact: m.artifact,
    revision: m.rev,
    sourcePath: m.sourcePath,
    source: m.source,
    outcome: m.outcome,
    unit: m.unit,
    extraSections: input.sections,
    probes: input.probes,
  });
  if (!m.outcome.ok) {
    throw new OmenflowError(
      ErrorCodes.VALIDATION,
      `Cannot inspect: ${m.outcome.error ?? 'render failed'}`,
      {
        details: { warnings: m.outcome.warnings, errors: m.outcome.errors },
        repair: 'Fix the source with cad.write_source, then inspect again.',
      },
    );
  }
  // Backwards-compatible fields for callers of the original cad.inspect.
  const cad = cadTool(ctx);
  const legacyInspect = m.outcome.stl ? cad.inspectStl(m.outcome.stl) : undefined;
  const dims = report.geometry
    ? {
        x: formatQty({ value: report.geometry.bounds.size[0], unit: m.unit } as MaybeQuantity),
        y: formatQty({ value: report.geometry.bounds.size[1], unit: m.unit } as MaybeQuantity),
        z: formatQty({ value: report.geometry.bounds.size[2], unit: m.unit } as MaybeQuantity),
      }
    : undefined;
  return {
    ...report,
    next: 'Inspect is diagnostic only and does not bind request assertions. Use the sections/probes to confirm each requested feature; then cad.check (exploratory false) with explicit expectations from the request.',
    ...(legacyInspect
      ? { inspect: legacyInspect, modelUnit: m.unit, dimensions: dims, isUnknown }
      : {}),
  } as CadReport & { legacy?: unknown };
}

/* ------------------------------------------------------------------ */
/* cad.check                                                           */
/* ------------------------------------------------------------------ */

export async function cadCheck(
  ctx: ProjectContext,
  input: {
    artifactId: string;
    revisionId?: string;
    params?: Record<string, ScadValue>;
    expect: Expectation;
    exploratory?: boolean;
  },
  origin: Origin,
): Promise<{
  artifactId: string;
  revisionId: string;
  pass: boolean;
  passed: number;
  total: number;
  ready: boolean;
  verificationStatus: CadVerificationStatus;
  evidenceHash: string;
  specHash: string;
  scopeChanges: string[];
  checks: CheckResult[];
  droppedFailingAssertions?: string[];
  loosenedAssertions?: string[];
  exploratory?: boolean;
  work?: {
    artifactId: string;
    candidateRevisionId: string | null;
    specHash: string | null;
    nextAction: string;
  };
  next: string;
}> {
  const exploratory = input.exploratory === true;
  const job = ctx.createJob({
    kind: 'cad_check',
    tool: 'omenflow-geometry',
    inputs: input,
    sessionId: origin.kind === 'agent' ? origin.sessionId : null,
  });
  const controller = new AbortController();
  ctx.jobCancels.set(job.id, () => controller.abort());
  ctx.jobStatus(job.id, 'running');
  try {
    const m = await resolveMesh(ctx, input, origin);
    ctx.assertJobActive(job.id);
    if (!m.outcome.ok || !m.outcome.tris) {
      throw new OmenflowError(
        ErrorCodes.VALIDATION,
        `Cannot check: ${m.outcome.error ?? 'render failed'}`,
        {
          details: { warnings: m.outcome.warnings, errors: m.outcome.errors },
          repair: 'Fix the source with cad.write_source, then check again.',
        },
      );
    }
    const checks = await runMeshTask<CheckResult[]>(
      { operation: 'check', tris: m.outcome.tris, expect: input.expect },
      controller.signal,
    );
    ctx.assertJobActive(job.id);
    const changeRegions = input.expect.preserve?.changeRegions;
    let preservation:
      { revisionId: string; inputFingerprint: string; outputHash: string } | undefined;
    if (changeRegions?.length) {
      // Preserve the baseline from which this draft lineage started, not the most
      // recent rewritten draft (which would let a repeated bad edit certify itself).
      let parent = m.rev.parentId ? ctx.requireRevision(m.rev.parentId) : null;
      const seen = new Set<string>();
      while (
        parent &&
        parent.id !== m.artifact.selectedRevisionId &&
        !['approved', 'superseded'].includes(parent.reviewState) &&
        parent.parentId
      ) {
        if (seen.has(parent.id))
          throw new OmenflowError(ErrorCodes.VALIDATION, 'Revision ancestry contains a cycle');
        seen.add(parent.id);
        parent = ctx.requireRevision(parent.parentId);
      }
      if (parent) {
        const reference = await resolveMesh(
          ctx,
          { artifactId: m.artifact.id, revisionId: parent.id },
          origin,
        );
        if (reference.outcome.ok && reference.outcome.tris && reference.outcome.identity) {
          preservation = {
            revisionId: parent.id,
            inputFingerprint: reference.outcome.identity.inputFingerprint,
            outputHash: reference.outcome.identity.outputHash,
          };
          const result = await runMeshTask<CheckResult>(
            {
              operation: 'preserve',
              reference: reference.outcome.tris,
              tris: m.outcome.tris,
              regions: changeRegions.map((r) => ({ center: r.center as Vec3, radius: r.radius })),
            },
            controller.signal,
          );
          ctx.assertJobActive(job.id);
          checks.push({
            ...result,
            detail: `Compared with baseline/reference revision ${parent.id}: ${result.detail}`,
          });
        } else
          checks.push({
            name: 'unrelated geometry preserved',
            pass: false,
            detail: `Reference revision ${parent.id} cannot render: ${reference.outcome.error ?? 'invalid geometry'}. Repair the reference explicitly; repeating the modified source does not create a preservation reference.`,
          });
      } else
        checks.push({
          name: 'unrelated geometry preserved',
          pass: false,
          detail:
            'No prior baseline/reference revision exists; preservation cannot be established for a newly created part.',
        });
    }
    const passed = checks.filter((c) => c.pass).length;
    const pass = checks.length > 0 && passed === checks.length;

    // Verification-weakening guard: assertions that failed on this very same
    // geometry earlier and are now simply absent. Dropping a check is not a fix.
    const paramsKey = JSON.stringify(input.params ?? {});
    const priorFailures = new Set<string>();
    let lastPriorResults: CheckResult[] | null = null;
    for (const j of ctx.repo.listJobs(200)) {
      if (j.kind !== 'cad_check' || j.id === job.id) continue;
      const inp = j.inputs as {
        revisionId?: string;
        params?: unknown;
        results?: CheckResult[];
        exploratory?: boolean;
      } | null;
      if (
        !inp ||
        inp.exploratory ||
        inp.revisionId !== m.rev.id ||
        JSON.stringify(inp.params ?? {}) !== paramsKey
      ) {
        continue;
      }
      for (const line of j.log.split('\n')) {
        const mm = /^FAIL (.+?) — /.exec(line);
        if (mm) priorFailures.add(mm[1]!);
      }
      if (inp.results && !lastPriorResults) lastPriorResults = inp.results;
    }
    const currentNames = new Set(checks.map((c) => c.name));
    const dropped = [...priorFailures].filter((n) => !currentNames.has(n));
    const loosened = lastPriorResults ? findLoosenedAssertions(lastPriorResults, checks) : [];

    const integrityReport = await analyzeMeshCancellable(m.outcome.tris, controller.signal);
    ctx.assertJobActive(job.id);
    const integrity = {
      pass:
        m.outcome.tris.length > 0 &&
        m.outcome.tris.every(Number.isFinite) &&
        integrityReport.topology.watertight &&
        !integrityReport.invertedNormals &&
        integrityReport.volume > 0,
      detail:
        'Mandatory finite, nonempty, closed, positive-volume mesh; self-intersections and physical safety are only assessed where explicitly declared.',
    };
    const bound = readActiveWork(ctx);
    const evidence = createCadVerificationEvidence(
      ctx,
      m.rev,
      m.outcome.identity!,
      input.expect,
      checks,
      integrity,
      {
        exploratory,
        boundExpect:
          bound?.artifactId === m.artifact.id && bound.candidateRevisionId === m.rev.id
            ? bound.expect
            : null,
      },
    );
    evidence.preservation = preservation;
    const evidenceHash = ctx.storeContent(JSON.stringify(evidence));
    const work = recordCommittedCheck(ctx, m.rev, input.expect, evidence.status, exploratory);
    ctx.repo.updateJob(job.id, {
      inputs: {
        artifactId: m.artifact.id,
        revisionId: m.rev.id,
        params: input.params ?? {},
        expect: input.expect,
        preservation,
        exploratory,
        results: checks.map((c) => ({ name: c.name, pass: c.pass, tightness: c.tightness })),
      },
    });
    ctx.jobLog(
      job.id,
      [
        ...checks.map((c) => `${c.pass ? 'PASS' : 'FAIL'} ${c.name} — ${c.detail}`),
        ...(dropped.length
          ? [
              `WEAKENED: dropped previously failing assertions on unchanged geometry: ${dropped.join('; ')}`,
            ]
          : []),
        ...(loosened.length
          ? [
              `WEAKENED: loosened tolerance on assertions that previously failed: ${loosened.join('; ')}`,
            ]
          : []),
      ].join('\n'),
    );
    ctx.jobStatus(job.id, pass ? 'succeeded' : 'failed', {
      outputHashes: { verification: evidenceHash },
      error: pass
        ? undefined
        : {
            code: ErrorCodes.VALIDATION,
            message: `${checks.length - passed} of ${checks.length} checks failed`,
          },
    });
    const weakenedNote =
      (dropped.length
        ? ` WARNING — this run dropped ${dropped.length} assertion(s) that FAILED on this same geometry earlier (${dropped.join('; ')}). Passing by removing checks is not verification: either the request does not require them (say so explicitly in your summary) or the geometry is wrong and must be fixed with cad.write_source.`
        : '') +
      (loosened.length
        ? ` WARNING — this run passed ${loosened.length} assertion(s) only after loosening the tolerance (${loosened.join('; ')}). Tightening the geometry or stating why the looser bound is the real requirement is required before calling this verified.`
        : '');
    const next =
      (exploratory
        ? 'Exploratory diagnostic only. Commit the complete request assertions with exploratory:false after diagnosing them; this result cannot establish verified completion.'
        : evidence.status === 'scope_changed'
          ? `NOT VERIFIED: assertion scope changed (${evidence.scopeChanges.join(', ')}). Restore the committed assertions or request explicit human scope acceptance. State this unresolved status in your final response; passing individual checks does not resolve it.`
          : evidence.status !== 'passed'
            ? `NOT VERIFIED: ${evidence.status}. Required next action: ${work.nextAction}. Do not claim verified completion.`
            : 'Declared assertions and mandatory integrity pass for this exact revision. Summarize coverage and limitations; human approval remains separate.') +
      weakenedNote;
    return {
      ready: !exploratory && evidence.status === 'passed',
      verificationStatus: evidence.status,
      next,
      artifactId: m.artifact.id,
      revisionId: m.rev.id,
      pass,
      passed,
      total: checks.length,
      evidenceHash,
      specHash: evidence.specHash,
      scopeChanges: evidence.scopeChanges,
      checks,
      ...(dropped.length ? { droppedFailingAssertions: dropped } : {}),
      ...(loosened.length ? { loosenedAssertions: loosened } : {}),
      ...(exploratory ? { exploratory: true } : {}),
      work: {
        artifactId: work.artifactId,
        candidateRevisionId: work.candidateRevisionId,
        specHash: work.specHash,
        nextAction: work.nextAction,
      },
    };
  } catch (error) {
    const failure = OmenflowError.from(error);
    ctx.jobStatus(job.id, failure.code === ErrorCodes.CANCELLED ? 'cancelled' : 'failed', {
      error: failure.toBody(),
    });
    throw failure;
  } finally {
    ctx.jobCancels.delete(job.id);
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

export async function cadPatchSource(
  ctx: ProjectContext,
  input: {
    artifactId: string;
    expectedRevisionId?: string;
    oldString: string;
    newString: string;
    rationale: string;
    timeoutMs: number;
  },
  origin: Origin,
): Promise<CadReport> {
  ctx.assertWritable();
  const artifact = requireMechanical(ctx, input.artifactId);
  const rev = pickRevision(ctx, artifact);
  const { source } = readScad(ctx, rev);
  const hits = countOccurrences(source, input.oldString);
  if (hits !== 1) {
    throw new OmenflowError(
      ErrorCodes.VALIDATION,
      hits === 0
        ? 'oldString was not found in the current source — read the source and copy the snippet exactly.'
        : `oldString occurs ${hits} times; it must be unique so the patch cannot hit the wrong site.`,
      { details: { occurrences: hits } },
    );
  }
  return cadWriteSource(
    ctx,
    {
      artifactId: input.artifactId,
      expectedRevisionId: input.expectedRevisionId ?? rev.id,
      source: source.replace(input.oldString, input.newString),
      rationale: input.rationale || 'source patched',
      timeoutMs: input.timeoutMs,
    },
    origin,
  );
}

export async function cadSetParam(
  ctx: ProjectContext,
  input: {
    artifactId: string;
    expectedRevisionId?: string;
    name: string;
    value: ScadValue;
    rationale: string;
    timeoutMs: number;
  },
  origin: Origin,
): Promise<CadReport> {
  ctx.assertWritable();
  const artifact = requireMechanical(ctx, input.artifactId);
  const rev = pickRevision(ctx, artifact);
  const { source } = readScad(ctx, rev);
  let next: { source: string };
  try {
    next = setScadParameter(source, input.name, input.value);
  } catch (e) {
    throw new OmenflowError(ErrorCodes.VALIDATION, (e as Error).message, {
      repair: 'Call cad.read_source and use a name from parameters.',
    });
  }
  return cadWriteSource(
    ctx,
    {
      artifactId: input.artifactId,
      source: next.source,
      expectedRevisionId: input.expectedRevisionId ?? rev.id,
      params: {
        ...plainParams((rev.payload as MechanicalPayload).params),
        [input.name]: input.value,
      },
      rationale: input.rationale || `set ${input.name}`,
      timeoutMs: input.timeoutMs,
    },
    origin,
  );
}

function scadRotateXyz(p: Vec3, deg: Vec3): Vec3 {
  const [ax, ay, az] = deg.map((d) => (d * Math.PI) / 180) as Vec3;
  let [x, y, z] = p;
  let y1 = y * Math.cos(ax) - z * Math.sin(ax);
  let z1 = y * Math.sin(ax) + z * Math.cos(ax);
  y = y1;
  z = z1;
  const x1 = x * Math.cos(ay) + z * Math.sin(ay);
  z1 = -x * Math.sin(ay) + z * Math.cos(ay);
  x = x1;
  z = z1;
  const x2 = x * Math.cos(az) - y * Math.sin(az);
  y1 = x * Math.sin(az) + y * Math.cos(az);
  return [x2, y1, z];
}

function instanceBounds(
  min: Vec3,
  max: Vec3,
  translate: Vec3,
  rotate: Vec3,
): { min: Vec3; max: Vec3 } {
  const corners: Vec3[] = [];
  for (const x of [min[0], max[0]])
    for (const y of [min[1], max[1]])
      for (const z of [min[2], max[2]]) {
        const r = scadRotateXyz([x, y, z], rotate);
        corners.push([r[0] + translate[0], r[1] + translate[1], r[2] + translate[2]]);
      }
  const outMin: Vec3 = [Infinity, Infinity, Infinity];
  const outMax: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const c of corners) {
    for (let i = 0; i < 3; i++) {
      if (c[i]! < outMin[i]!) outMin[i] = c[i]!;
      if (c[i]! > outMax[i]!) outMax[i] = c[i]!;
    }
  }
  return { min: outMin, max: outMax };
}

function aabbInteriorOverlap(
  a: { min: Vec3; max: Vec3 },
  b: { min: Vec3; max: Vec3 },
  eps = 1e-3,
): boolean {
  return (
    a.min[0]! < b.max[0]! - eps &&
    a.max[0]! > b.min[0]! + eps &&
    a.min[1]! < b.max[1]! - eps &&
    a.max[1]! > b.min[1]! + eps &&
    a.min[2]! < b.max[2]! - eps &&
    a.max[2]! > b.min[2]! + eps
  );
}

export async function cadCompose(
  ctx: ProjectContext,
  input: {
    title: string;
    instances: { artifactId: string; revisionId?: string; translate?: Vec3; rotate?: Vec3 }[];
    rationale: string;
    timeoutMs: number;
  },
  origin: Origin,
): Promise<CadReport> {
  ctx.assertWritable();
  const blocks: string[] = [
    '// composed assembly — module-wrapped instances, transform only (no mates / STEP)',
  ];
  const inputs: RecordedInput[] = [];
  const placed: { i: number; box: { min: Vec3; max: Vec3 } }[] = [];
  input.instances.forEach((inst, i) => {
    const artifact = requireMechanical(ctx, inst.artifactId);
    const rev = pickRevision(ctx, artifact, inst.revisionId);
    const { source } = readScad(ctx, rev);
    const name = `_inst_${i}`;
    const t = inst.translate ?? [0, 0, 0];
    const r = inst.rotate ?? [0, 0, 0];
    let effectiveSource = source;
    for (const [key, value] of Object.entries(
      plainParams(
        (rev.payload as MechanicalPayload).params,
        (rev.payload as MechanicalPayload).modelUnit,
      ),
    )) {
      effectiveSource = setScadParameter(effectiveSource, key, value).source;
    }
    const body = effectiveSource.replace(/\s+$/, '');
    if (!inputs.some((i) => i.artifactId === artifact.id && i.revisionId === rev.id))
      inputs.push({
        artifactId: artifact.id,
        revisionId: rev.id,
        relationship: 'depends_on',
        label: 'composition snapshot',
      });
    const xform =
      r[0] === 0 && r[1] === 0 && r[2] === 0
        ? `translate([${t.join(', ')}]) ${name}();`
        : `translate([${t.join(', ')}]) rotate([${r.join(', ')}]) ${name}();`;
    blocks.push(`module ${name}() {\n${body}\n}\n${xform}`);
    const payload = rev.payload as MechanicalPayload;
    if (payload.bounds) {
      placed.push({
        i,
        box: instanceBounds(payload.bounds.min, payload.bounds.max, t, r),
      });
    }
  });
  const overlapPairs: string[] = [];
  for (let a = 0; a < placed.length; a++) {
    for (let b = a + 1; b < placed.length; b++) {
      if (aabbInteriorOverlap(placed[a]!.box, placed[b]!.box)) {
        overlapPairs.push(`#${placed[a]!.i} and #${placed[b]!.i}`);
      }
    }
  }
  const report = await cadWriteSource(
    ctx,
    {
      title: input.title,
      inputs,
      source: blocks.join('\n\n') + '\n',
      rationale: input.rationale || 'composed from existing parts',
      timeoutMs: input.timeoutMs,
    },
    origin,
  );
  if (overlapPairs.length) {
    report.notes.unshift(
      `Instances ${overlapPairs.join(', ')} overlap after transform — OpenSCAD unions overlapping top-level objects into one body. Separate them or accept the unioned solid.`,
    );
  }
  return report;
}

/* ------------------------------------------------------------------ */
/* Legacy ops (GUI + CLI compatibility)                                */
/* ------------------------------------------------------------------ */

export async function cadValidateSource(
  ctx: ProjectContext,
  artifactId: string,
  revisionId?: string,
) {
  const { rev } = mechPayload(ctx, artifactId, revisionId);
  const scad = scadRefOf(rev);
  if (!scad) throw new OmenflowError(ErrorCodes.VALIDATION, 'No .scad source on revision');
  const { source } = readScad(ctx, rev);
  assertSelfContainedScad(source);
  const tmp = ctx.resolvePath(`.omenflow/cache/validate-${rev.id}.scad`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, source);
  return cadTool(ctx).validateSource(tmp);
}

/**
 * Background render used by the GUI: returns the job immediately; completion
 * commits a draft revision carrying the mesh. Agents get the synchronous
 * cad.write_source / cad.inspect path instead.
 */
export async function cadRender(
  ctx: ProjectContext,
  input: {
    artifactId: string;
    revisionId?: string;
    params?: Record<string, unknown>;
    timeoutMs: number;
  },
  origin: Origin,
): Promise<{ job: Job }> {
  ctx.assertWritable();
  const { artifact, rev, payload } = mechPayload(ctx, input.artifactId, input.revisionId);
  const { source } = readScad(ctx, rev);
  assertSelfContainedScad(source);
  const params = {
    ...plainParams(payload.params, payload.modelUnit),
    ...plainParams(input.params, payload.modelUnit),
  };
  assertParamsExist(params, parseScadParameters(source));
  const job = ctx.createJob({
    kind: 'cad_render',
    tool: cadTool(ctx).toolId,
    inputHashes: { source: createHash('sha256').update(source).digest('hex') },
    inputs: { artifactId: artifact.id, revisionId: rev.id, params },
    sessionId: origin.kind === 'agent' ? origin.sessionId : null,
  });
  const paramManifest = parseScadParameters(source).map((p) => {
    const raw = input.params?.[p.name] ?? payload.params[p.name];
    const prior = payload.paramManifest.find((m) => m.name === p.name);
    if (raw && typeof raw === 'object' && 'value' in raw && 'unit' in raw) {
      const dim = dimOf(raw as { value: number; unit: string });
      return {
        name: p.name,
        dimension:
          dim === 'length'
            ? ('length' as const)
            : dim === 'angle'
              ? ('angle' as const)
              : ('number' as const),
        unit: dim === 'length' ? 'mm' : dim === 'angle' ? 'deg' : '1',
        description: p.comment,
      };
    }
    return (
      prior ?? {
        name: p.name,
        dimension:
          typeof p.value === 'boolean'
            ? ('boolean' as const)
            : typeof p.value === 'string'
              ? ('text' as const)
              : p.name === '$fn'
                ? ('count' as const)
                : ('number' as const),
        description: p.comment,
      }
    );
  });
  void cadWriteSource(
    ctx,
    {
      paramManifest,
      artifactId: artifact.id,
      expectedRevisionId: rev.id,
      source,
      params,
      rationale: 'render output',
      timeoutMs: input.timeoutMs,
      existingJob: job,
    },
    origin,
  )
    .catch((error: unknown) => {
      const e = OmenflowError.from(error);
      ctx.jobStatus(job.id, e.code === ErrorCodes.CANCELLED ? 'cancelled' : 'failed', {
        error: e.toBody(),
      });
    })
    .finally(() => ctx.jobCancels.delete(job.id));
  return { job };
}
