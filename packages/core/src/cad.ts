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
  isUnknown,
  newId,
  type Artifact,
  type Expectation,
  type Revision,
  type MaybeQuantity,
} from '@omenflow/contracts';
import type { ProjectContext } from './context.js';
import { commitRevision, materializeReadableView } from './artifacts.js';
import { slugify } from './hash.js';
import type { CadAdapter } from './tools.js';
import {
  analyzeMesh,
  containsPoint,
  crossSection,
  parseStlTriangles,
  type Axis,
  type MeshReport,
  type TriangleBuffer,
  type Vec3,
} from './mesh.js';
import { parseScadParameters, type ScadParameter } from './scad-params.js';
import { describeLoop, fmtNum, runChecks, type CheckResult } from './cad-checks.js';

type ScadValue = number | string | boolean;

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
  const rev = ctx.repo.listRevisions(artifact.id).at(-1);
  if (!rev) throw new OmenflowError(ErrorCodes.VALIDATION, 'Mechanical artifact has no revision');
  return rev;
}

/** Legacy resolution used by cad.render / cad.validate_source (baseline first). */
function mechPayload(ctx: ProjectContext, artifactId: string, revisionId?: string) {
  const artifact = requireMechanical(ctx, artifactId);
  const rev = revisionId
    ? ctx.requireRevision(revisionId)
    : artifact.selectedRevisionId
      ? ctx.repo.getRevision(artifact.selectedRevisionId)
      : ctx.repo.listRevisions(artifact.id).at(-1);
  if (!rev) throw new OmenflowError(ErrorCodes.VALIDATION, 'Mechanical artifact has no revision');
  return { artifact, rev, payload: rev.payload as MechanicalPayload };
}

function scadRefOf(rev: Revision) {
  const payload = rev.payload as MechanicalPayload;
  return payload.scad ?? rev.files.find((f) => f.path.endsWith('.scad'));
}
function stlRefOf(rev: Revision) {
  const payload = rev.payload as MechanicalPayload;
  return payload.stl ?? rev.files.find((f) => f.path.endsWith('.stl'));
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

/** Unwrap {value,unit} quantities to plain -D values. */
function plainParams(params: Record<string, unknown> | undefined): Record<string, ScadValue> {
  const out: Record<string, ScadValue> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v && typeof v === 'object' && 'value' in v) out[k] = (v as { value: number }).value;
    else if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

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
  },
): Promise<{ outcome: RenderOutcome; job: Job | null }> {
  const cad = cadTool(ctx);
  const started = Date.now();
  const key = createHash('sha256')
    .update(args.source)
    .update(JSON.stringify(Object.entries(args.params).sort()))
    .digest('hex')
    .slice(0, 24);
  const cacheDir = ctx.resolvePath(`.omenflow/cache/render/${key}`);
  const cachedStl = path.join(cacheDir, 'output.stl');
  const cachedLog = path.join(cacheDir, 'log.txt');
  if (fs.existsSync(cachedStl) && fs.statSync(cachedStl).size > 0) {
    const stl = fs.readFileSync(cachedStl);
    const log = fs.existsSync(cachedLog) ? fs.readFileSync(cachedLog, 'utf8') : '';
    const { warnings, errors } = classifyLog(log);
    return {
      job: null,
      outcome: {
        ok: true,
        ms: 0,
        tool: 'openscad (cached)',
        warnings,
        errors,
        log,
        stl,
        tris: parseStlTriangles(stl),
      },
    };
  }

  const probe = await cad.probe();
  if (!probe.available) {
    throw new OmenflowError(ErrorCodes.TOOL_MISSING, probe.error ?? 'OpenSCAD not found', {
      repair: 'Install OpenSCAD, then Connections → Locate OpenSCAD.',
    });
  }
  const tool = `${cad.toolId} ${probe.version ?? ''}`.trim();
  const job = ctx.createJob({
    kind: 'cad_render',
    tool: cad.toolId,
    toolVersion: probe.version,
    inputs: {
      artifactId: args.artifactId,
      revisionId: args.revisionId ?? null,
      params: args.params,
    },
    sessionId: args.origin.kind === 'agent' ? args.origin.sessionId : null,
  });
  fs.mkdirSync(cacheDir, { recursive: true });
  const scadPath = path.join(cacheDir, 'input.scad');
  fs.writeFileSync(scadPath, args.source);
  ctx.jobStatus(job.id, 'running');
  ctx.jobCancels.set(job.id, () => cad.cancel(job.id));
  let log = '';
  const res = await cad.render(
    {
      jobId: job.id,
      scadPath,
      outPath: cachedStl,
      params: args.params,
      timeoutMs: args.timeoutMs,
      workDir: cacheDir,
    },
    (chunk) => {
      log += chunk;
      ctx.jobLog(job.id, chunk);
    },
  );
  ctx.jobCancels.delete(job.id);
  fs.writeFileSync(cachedLog, log);
  const { warnings, errors } = classifyLog(log);
  const ms = Date.now() - started;
  const fail = (message: string): { outcome: RenderOutcome; job: Job } => {
    ctx.jobStatus(job.id, res.error === 'cancelled' ? 'cancelled' : 'failed', {
      error: {
        code: res.error === 'timeout' ? ErrorCodes.TIMEOUT : ErrorCodes.VALIDATION,
        message,
      },
    });
    try {
      fs.rmSync(cachedStl, { force: true });
    } catch {
      /* nothing to clean */
    }
    return {
      job: ctx.repo.getJob(job.id) ?? job,
      outcome: { ok: false, ms, tool, warnings, errors, log, error: message },
    };
  };
  if (!res.ok) {
    const empty = /top level object is empty/i.test(log);
    const why =
      res.error === 'timeout'
        ? `Render exceeded ${args.timeoutMs} ms — simplify the model (lower $fn, fewer minkowski/hull ops) or raise timeoutMs.`
        : empty
          ? 'OpenSCAD produced no geometry: the top-level object is empty (a difference() removed everything, a size is zero/undef, or nothing is instantiated at file scope).'
          : (errors[0] ?? warnings[0] ?? res.error ?? 'OpenSCAD failed');
    return fail(why);
  }
  if (!fs.existsSync(cachedStl) || fs.statSync(cachedStl).size === 0) {
    return fail(
      'OpenSCAD produced no geometry — the top-level object is empty (check that difference() leaves material and that nothing is commented out).',
    );
  }
  const stl = fs.readFileSync(cachedStl);
  const tris = parseStlTriangles(stl);
  if (tris.length === 0) return fail('OpenSCAD output contains no triangles.');
  ctx.jobStatus(job.id, 'succeeded', { outputHashes: { stl: ctx.objects.put(stl) } });
  return {
    job: ctx.repo.getJob(job.id) ?? job,
    outcome: { ok: true, ms, tool, warnings, errors, log, stl, tris },
  };
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
  parameters: { name: string; value: ScadValue; comment?: string }[];
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
      "Mesh is inside-out (negative signed volume). With polyhedron(), list each face's vertices clockwise when viewed from outside the solid; booleans on an inside-out body cut the wrong side.",
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

function buildReport(args: {
  artifact: Artifact;
  revision: Revision;
  sourcePath: string;
  source: string;
  outcome: RenderOutcome;
  unit: string;
  extraSections?: { axis: Axis; at: number }[];
  probes?: Vec3[];
}): CadReport {
  const params = parseScadParameters(args.source);
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
  const report = analyzeMesh(tris);
  base.geometry = geometrySummary(report, args.unit);
  base.sections = [
    ...autoSections(tris, report),
    ...(args.extraSections ?? []).map((s) => sectionReport(tris, s.axis, s.at)),
  ];
  if (args.probes?.length) {
    base.probes = args.probes.map((p) => ({
      point: p,
      result: containsPoint(tris, p) ? 'solid' : 'empty',
    }));
  }
  base.notes = geometryNotes(report, tris, params);
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
  const declared = parseScadParameters(input.source);
  const overrides = input.params ?? {};
  assertParamsExist(overrides, declared);

  let artifact: Artifact;
  let parent: Revision | null = null;
  let prevPayload: MechanicalPayload = { params: {}, paramManifest: [], modelUnit: 'mm' };
  if (input.artifactId) {
    artifact = requireMechanical(ctx, input.artifactId);
    parent = pickRevision(ctx, artifact);
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
    ctx.repo.tx(() => ctx.repo.insertArtifact(artifact));
  }
  if (input.title && input.artifactId && input.title !== artifact.title) {
    ctx.repo.updateArtifactTitle(artifact.id, input.title);
    artifact = { ...artifact, title: input.title };
  }

  const sourcePath = parent
    ? (scadRefOf(parent)?.path ?? uniqueSourcePath(ctx, artifact.title, artifact.id))
    : uniqueSourcePath(ctx, artifact.title, artifact.id);
  const scadSha = ctx.storeContent(input.source);
  const scadRef = { path: sourcePath, sha256: scadSha, role: 'source' as const };

  // Recorded params: previous values (dropping ones the source no longer declares) + overrides.
  const declaredNames = new Set(declared.map((p) => p.name));
  const recorded: Record<string, ScadValue> = {};
  for (const [k, v] of Object.entries(plainParams(prevPayload.params)))
    if (declaredNames.has(k)) recorded[k] = v;
  Object.assign(recorded, overrides);

  const { outcome, job } = await renderSource(ctx, {
    source: input.source,
    params: recorded,
    timeoutMs: input.timeoutMs,
    origin,
    artifactId: artifact.id,
  });

  const files = [scadRef];
  const payload: MechanicalPayload = {
    ...prevPayload,
    scad: scadRef,
    stl: undefined,
    params: recorded,
    paramManifest: declared.map((p) => ({
      name: p.name,
      ...(p.comment ? { description: p.comment } : {}),
    })),
    modelUnit: prevPayload.modelUnit ?? 'mm',
    bounds: undefined,
    renderJobId: job?.id,
  };
  let stlRef: { path: string; sha256: string; role: 'output' } | null = null;
  if (outcome.ok && outcome.stl && outcome.tris) {
    const stlSha = ctx.objects.put(outcome.stl);
    stlRef = { path: sourcePath.replace(/\.scad$/, '.stl'), sha256: stlSha, role: 'output' };
    files.push(stlRef as never);
    const report = analyzeMesh(outcome.tris);
    payload.stl = stlRef;
    payload.bounds = {
      min: report.bounds.min.map(r3) as Vec3,
      max: report.bounds.max.map(r3) as Vec3,
    };
  }
  const rev = commitRevision(ctx, {
    artifactId: artifact.id,
    parentId: parent?.id ?? null,
    origin,
    payload,
    files,
    inputs: parent?.inputs ?? [],
    rationale: input.rationale || (parent ? 'source revised' : 'initial source'),
    reviewState: 'draft',
  });
  // Tool-written files are ours to overwrite; a divergent user edit would have
  // been imported by the watcher as its own draft already.
  ctx.materialize(sourcePath, scadSha, rev.id, { overwrite: true });
  if (stlRef) ctx.materialize(stlRef.path, stlRef.sha256, rev.id, { overwrite: true });
  materializeReadableView(ctx, artifact, rev);

  return buildReport({
    artifact,
    revision: rev,
    sourcePath,
    source: input.source,
    outcome,
    unit: payload.modelUnit,
  });
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
  const params = parseScadParameters(source);
  const payload = rev.payload as MechanicalPayload;
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
      value: p.value,
      ...(p.comment ? { comment: p.comment } : {}),
    })),
    recordedParams: plainParams(payload.params),
    unit: payload.modelUnit ?? 'mm',
    hasRender: !!stlRefOf(rev)?.sha256,
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
  if (Object.keys(overrides).length === 0 && stl?.sha256 && ctx.objects.has(stl.sha256)) {
    const buf = ctx.objects.read(stl.sha256);
    const tris = parseStlTriangles(buf);
    if (tris.length > 0) {
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
          stl: buf,
          tris,
        },
      };
    }
  }
  const params = { ...plainParams(payload.params), ...overrides };
  const { outcome } = await renderSource(ctx, {
    source,
    params,
    timeoutMs: 90_000,
    origin,
    artifactId: artifact.id,
    revisionId: rev.id,
  });
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
    sections?: { axis: Axis; at: number }[];
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
    next: 'Use the sections/probes to confirm each requested feature; then cad.check with explicit expectations.',
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
  },
  origin: Origin,
): Promise<{
  artifactId: string;
  revisionId: string;
  pass: boolean;
  passed: number;
  total: number;
  checks: CheckResult[];
  droppedFailingAssertions?: string[];
  next: string;
}> {
  const m = await resolveMesh(ctx, input, origin);
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
  const checks = runChecks(m.outcome.tris, input.expect);
  const passed = checks.filter((c) => c.pass).length;
  const pass = checks.length > 0 && passed === checks.length;

  // Verification-weakening guard: assertions that failed on this very same
  // geometry earlier and are now simply absent. Dropping a check is not a fix.
  const paramsKey = JSON.stringify(input.params ?? {});
  const priorFailures = new Set<string>();
  for (const j of ctx.repo.listJobs(200)) {
    if (j.kind !== 'cad_check') continue;
    const inp = j.inputs as { revisionId?: string; params?: unknown } | null;
    if (!inp || inp.revisionId !== m.rev.id || JSON.stringify(inp.params ?? {}) !== paramsKey) {
      continue;
    }
    for (const line of j.log.split('\n')) {
      const mm = /^FAIL (.+?) — /.exec(line);
      if (mm) priorFailures.add(mm[1]!);
    }
  }
  const currentNames = new Set(checks.map((c) => c.name));
  const dropped = [...priorFailures].filter((n) => !currentNames.has(n));

  const job = ctx.createJob({
    kind: 'cad_check',
    tool: 'omenflow-geometry',
    inputs: {
      artifactId: m.artifact.id,
      revisionId: m.rev.id,
      params: input.params ?? {},
      expect: input.expect,
    },
    sessionId: origin.kind === 'agent' ? origin.sessionId : null,
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
    ].join('\n'),
  );
  ctx.jobStatus(job.id, pass ? 'succeeded' : 'failed', {
    error: pass
      ? undefined
      : {
          code: ErrorCodes.VALIDATION,
          message: `${checks.length - passed} of ${checks.length} checks failed`,
        },
  });
  const weakenedNote = dropped.length
    ? ` WARNING — this run dropped ${dropped.length} assertion(s) that FAILED on this same geometry earlier (${dropped.join('; ')}). Passing by removing checks is not verification: either the request does not require them (say so explicitly in your summary) or the geometry is wrong and must be fixed with cad.write_source.`
    : '';
  return {
    artifactId: m.artifact.id,
    revisionId: m.rev.id,
    pass,
    passed,
    total: checks.length,
    checks,
    ...(dropped.length ? { droppedFailingAssertions: dropped } : {}),
    next:
      (pass
        ? checks.length < 3
          ? 'All checks passed, but only a few assertions were made — add the remaining requested features (holes, outlines, points) before declaring done.'
          : 'All checks passed. The part matches the stated expectations; report done with a short summary of what was verified.'
        : 'A failed check means the geometry is wrong until proven otherwise: fix the source (cad.write_source with artifactId) and run cad.check again with the same expectations. Change an assertion only if it misread the request.') +
      weakenedNote,
  };
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
  const abs = ctx.resolvePath(scad.path);
  if (!fs.existsSync(abs)) {
    if (scad.sha256 && ctx.objects.has(scad.sha256)) {
      const tmp = ctx.resolvePath(`.omenflow/cache/validate-${rev.id}.scad`);
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      fs.writeFileSync(tmp, ctx.objects.read(scad.sha256));
      return cadTool(ctx).validateSource(tmp);
    }
    throw new OmenflowError(ErrorCodes.NOT_FOUND, `Missing source file: ${scad.path}`);
  }
  return cadTool(ctx).validateSource(abs);
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
  const cad = cadTool(ctx);
  const { artifact, rev, payload } = mechPayload(ctx, input.artifactId, input.revisionId);
  const scad = scadRefOf(rev);
  if (!scad?.sha256) {
    throw new OmenflowError(ErrorCodes.VALIDATION, 'No .scad source with content on revision');
  }

  const params: Record<string, ScadValue> = {
    ...plainParams(payload.params),
    ...plainParams(input.params),
  };
  const job = ctx.createJob({
    kind: 'cad_render',
    tool: cad.toolId,
    inputs: {
      artifactId: artifact.id,
      revisionId: rev.id,
      params,
      capturedInputs: rev.inputs,
      scadHash: scad.sha256,
    },
    sessionId: origin.kind === 'agent' ? origin.sessionId : null,
  });

  const sessionId = origin.kind === 'agent' ? origin.sessionId : 'user';
  const workDir = ctx.resolvePath(`.omenflow/work/${sessionId}/jobs/${job.id}`);
  fs.mkdirSync(workDir, { recursive: true });
  const scadSrc = path.join(workDir, 'input.scad');
  fs.writeFileSync(scadSrc, ctx.objects.read(scad.sha256));
  const outPath = path.join(workDir, 'output.stl');
  ctx.jobCancels.set(job.id, () => cad.cancel(job.id));

  void (async () => {
    ctx.jobStatus(job.id, 'running');
    const probe = await cad.probe();
    if (!probe.available) {
      ctx.jobStatus(job.id, 'failed', {
        error: {
          code: ErrorCodes.TOOL_MISSING,
          message: probe.error ?? 'OpenSCAD not found',
          repair: 'Install OpenSCAD, then Connections → Locate OpenSCAD.',
        },
      });
      return;
    }
    ctx.repo.updateJob(job.id, {
      toolVersion: probe.version,
      command: `${probe.executablePath} -o output.stl input.scad`,
    });
    const res = await cad.render(
      { jobId: job.id, scadPath: scadSrc, outPath, params, timeoutMs: input.timeoutMs, workDir },
      (chunk) => ctx.jobLog(job.id, chunk),
    );
    if (!res.ok) {
      const cancelled = res.error === 'cancelled';
      ctx.jobStatus(job.id, cancelled ? 'cancelled' : 'failed', {
        error: cancelled
          ? { code: ErrorCodes.CANCELLED, message: 'Render cancelled' }
          : { code: ErrorCodes.VALIDATION, message: res.error ?? 'render failed' },
      });
      return;
    }
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
      ctx.jobStatus(job.id, 'failed', {
        error: { code: ErrorCodes.VALIDATION, message: 'OpenSCAD produced no output' },
      });
      return;
    }
    const stlBuf = fs.readFileSync(outPath);
    let inspect;
    try {
      inspect = cad.inspectStl(stlBuf);
    } catch (e) {
      ctx.jobStatus(job.id, 'failed', {
        error: {
          code: ErrorCodes.VALIDATION,
          message: `Invalid STL output: ${(e as Error).message}`,
        },
      });
      return;
    }
    if (!inspect.plausible || inspect.triangles === 0) {
      ctx.jobStatus(job.id, 'failed', {
        error: { code: ErrorCodes.VALIDATION, message: 'STL has no geometry' },
      });
      return;
    }
    const stlHash = ctx.objects.put(stlBuf);
    const stlRel = scad.path.replace(/\.scad$/, '.stl');

    const captured = rev.inputs;
    let inputChanged = false;
    for (const inp of captured) {
      const up = ctx.repo.getArtifact(inp.artifactId);
      if (up && up.selectedRevisionId !== inp.revisionId) inputChanged = true;
    }

    const newPayload: MechanicalPayload = {
      ...payload,
      stl: { path: stlRel, sha256: stlHash, role: 'output' },
      params: { ...payload.params, ...(input.params ?? {}) } as MechanicalPayload['params'],
      bounds: inspect.bounds,
      renderJobId: job.id,
    };
    const newRev = commitRevision(ctx, {
      artifactId: artifact.id,
      parentId: rev.id,
      origin,
      payload: newPayload,
      files: [scad, { path: stlRel, sha256: stlHash, role: 'output' }],
      inputs: captured,
      rationale: inputChanged
        ? 'render output — inputs changed during run (not current evidence)'
        : 'render output',
      reviewState: 'draft',
    });
    ctx.materialize(stlRel, stlHash, newRev.id, { overwrite: true });
    materializeReadableView(ctx, artifact, newRev);
    ctx.jobStatus(job.id, inputChanged ? 'failed' : 'succeeded', {
      outputHashes: { stl: stlHash },
      error: inputChanged
        ? {
            code: ErrorCodes.INPUT_CHANGED,
            message:
              'Recorded inputs changed during render; output kept as draft, not current evidence',
            details: { draftRevisionId: newRev.id },
          }
        : undefined,
    });
    ctx.jobCancels.delete(job.id);
  })();

  return { job };
}
