import fs from 'node:fs';
import path from 'node:path';
import {
  ErrorCodes,
  Job,
  MechanicalPayload,
  Origin,
  OmenflowError,
  formatQty,
  isUnknown,
  newId,
  type MaybeQuantity,
} from '@omenflow/contracts';
import type { ProjectContext } from './context.js';
import { commitRevision, materializeReadableView } from './artifacts.js';
import type { CadAdapter } from './tools.js';

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

function mechPayload(ctx: ProjectContext, artifactId: string, revisionId?: string) {
  const artifact = ctx.requireArtifact(artifactId);
  if (artifact.type !== 'mechanical') {
    throw new OmenflowError(ErrorCodes.VALIDATION, 'CAD ops require a mechanical artifact');
  }
  const rev = revisionId
    ? ctx.requireRevision(revisionId)
    : artifact.selectedRevisionId
      ? ctx.repo.getRevision(artifact.selectedRevisionId)
      : ctx.repo.listRevisions(artifact.id).at(-1);
  if (!rev) throw new OmenflowError(ErrorCodes.VALIDATION, 'Mechanical artifact has no revision');
  return { artifact, rev, payload: rev.payload as MechanicalPayload };
}

export async function cadValidateSource(
  ctx: ProjectContext,
  artifactId: string,
  revisionId?: string,
) {
  const { rev, payload } = mechPayload(ctx, artifactId, revisionId);
  const scad = payload.scad ?? rev.files.find((f) => f.path.endsWith('.scad'));
  if (!scad) throw new OmenflowError(ErrorCodes.VALIDATION, 'No .scad source on revision');
  const abs = ctx.resolvePath(scad.path);
  if (!fs.existsSync(abs)) {
    // Fall back to object store copy.
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
 * Render a mechanical artifact's .scad source to .stl via real OpenSCAD.
 * Returns the job immediately; completion commits a draft revision with the
 * mesh — flagged INPUT_CHANGED if upstream revisions moved mid-run.
 */
export async function cadRender(
  ctx: ProjectContext,
  input: {
    artifactId: string;
    revisionId?: string;
    params?: Record<string, number | string | boolean>;
    timeoutMs: number;
  },
  origin: Origin,
): Promise<{ job: Job }> {
  ctx.assertWritable();
  const cad = cadTool(ctx);
  const { artifact, rev, payload } = mechPayload(ctx, input.artifactId, input.revisionId);
  const scad = payload.scad ?? rev.files.find((f) => f.path.endsWith('.scad'));
  if (!scad?.sha256) {
    throw new OmenflowError(ErrorCodes.VALIDATION, 'No .scad source with content on revision');
  }

  const job = ctx.createJob({
    kind: 'cad_render',
    tool: cad.toolId,
    inputs: {
      artifactId: artifact.id,
      revisionId: rev.id,
      params: input.params ?? {},
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

  const params: Record<string, number | string | boolean> = {};
  for (const [k, v] of Object.entries(payload.params ?? {})) {
    if (typeof v === 'object' && v !== null && 'value' in v) {
      params[k] = (v as { value: number }).value;
    } else {
      params[k] = v as number | string | boolean;
    }
  }
  Object.assign(params, input.params ?? {});

  // Cancellation reaches the adapter (SIGTERM→SIGKILL escalation inside).
  ctx.jobCancels.set(job.id, () => cad.cancel(job.id));

  // Run async; dispatch returns the job now.
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
    // Validate output: exists, parses, nonempty, plausible bounds.
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
    const stlRel = `artifacts/mechanical/${artifact.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'part'}-${rev.seq + 1}.stl`;

    // Input freshness check: recorded inputs captured at job start vs now.
    const captured = rev.inputs;
    let inputChanged = false;
    for (const inp of captured) {
      const up = ctx.repo.getArtifact(inp.artifactId);
      if (up && up.selectedRevisionId !== inp.revisionId) inputChanged = true;
    }

    const newPayload: MechanicalPayload = {
      ...payload,
      stl: { path: stlRel, sha256: stlHash, role: 'output' },
      params: { ...payload.params, ...(input.params ?? {}) },
      bounds: inspect.bounds,
      renderJobId: job.id,
    };
    const newRev = commitRevision(ctx, {
      artifactId: artifact.id,
      parentId: rev.id,
      origin,
      payload: newPayload,
      files: [...(scad ? [scad] : []), { path: stlRel, sha256: stlHash, role: 'output' }],
      inputs: captured,
      rationale: inputChanged
        ? 'render output — inputs changed during run (not current evidence)'
        : 'render output',
      reviewState: 'draft',
    });
    ctx.materialize(stlRel, stlHash, newRev.id);
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

export function cadInspect(ctx: ProjectContext, artifactId: string, revisionId?: string) {
  const cad = cadTool(ctx);
  const { rev, payload } = mechPayload(ctx, artifactId, revisionId);
  const stl = payload.stl ?? rev.files.find((f) => f.path.endsWith('.stl'));
  if (!stl?.sha256) throw new OmenflowError(ErrorCodes.NOT_FOUND, 'No STL output on revision');
  const buf = ctx.objects.read(stl.sha256);
  const inspect = cad.inspectStl(buf);
  const dimX = inspect.bounds.max[0] - inspect.bounds.min[0];
  const dimY = inspect.bounds.max[1] - inspect.bounds.min[1];
  const dimZ = inspect.bounds.max[2] - inspect.bounds.min[2];
  return {
    inspect,
    modelUnit: payload.modelUnit,
    dimensions: {
      x: formatQty({ value: dimX, unit: payload.modelUnit } as MaybeQuantity),
      y: formatQty({ value: dimY, unit: payload.modelUnit } as MaybeQuantity),
      z: formatQty({ value: dimZ, unit: payload.modelUnit } as MaybeQuantity),
    },
    isUnknown: isUnknown,
  };
}
