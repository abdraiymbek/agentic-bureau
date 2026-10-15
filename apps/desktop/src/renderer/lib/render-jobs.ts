/**
 * Truthful outcomes for the mechanical loop: what a CAD write actually produced, which render
 * jobs belong to a part and what state they are in, and where the core will accept a render.
 */
import type { Job, MechanicalPayload, Revision } from '@omenflow/contracts';
import { sameValue } from './revision-draft';

/* ------------------------------------------------------------------ */
/* Synchronous writes (cad.write_source)                                */
/* ------------------------------------------------------------------ */

/** The fields of a `cad.write_source` result the stage reads. Everything is optional on the wire. */
export interface CadWriteResult {
  revisionId: string;
  render?: { ok?: boolean; errors?: string[]; warnings?: string[]; ms?: number; tool?: string };
  notes?: string[];
}

export interface RenderOutcome {
  revisionId: string;
  /** The engine produced geometry. False means a revision was recorded without a mesh. */
  rendered: boolean;
  errors: string[];
  warnings: string[];
  /** Engine notes that qualify the result, such as an unverified inverted winding. */
  notes: string[];
}

/**
 * A write commits a revision whether or not the render succeeded, so success is read from
 * `render.ok` alone. A result without that flag is not treated as a success.
 */
export function renderOutcome(result: CadWriteResult): RenderOutcome {
  const rendered = result.render?.ok === true;
  const errors = result.render?.errors ?? [];
  return {
    revisionId: result.revisionId,
    rendered,
    errors:
      rendered || errors.length
        ? errors
        : ['The engine did not report a successful render and gave no error text.'],
    warnings: result.render?.warnings ?? [],
    notes: (result.notes ?? []).filter((n) => !/^Render failed\b/i.test(n)),
  };
}

/* ------------------------------------------------------------------ */
/* Background renders (cad.render jobs)                                 */
/* ------------------------------------------------------------------ */

const ACTIVE = new Set(['queued', 'running']);

export function jobIsActive(job: Pick<Job, 'status'>): boolean {
  return ACTIVE.has(job.status);
}

function jobInputs(job: Job): { artifactId?: string; revisionId?: string } {
  return job.inputs && typeof job.inputs === 'object'
    ? (job.inputs as { artifactId?: string; revisionId?: string })
    : {};
}

/** Render jobs for one part, newest first. */
export function renderJobsFor(jobs: Job[], artifactId: string): Job[] {
  return jobs
    .filter((j) => j.kind === 'cad_render' && jobInputs(j).artifactId === artifactId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function jobRevisionId(job: Job): string | null {
  return jobInputs(job).revisionId ?? null;
}

/** The error a job recorded, as text. Jobs store `{code, message}` or a bare string. */
export function jobErrorText(job: Job): string | null {
  const error = job.error;
  if (!error) return null;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && 'message' in error) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return typeof code === 'string' && code !== 'INTERNAL'
      ? `${String(message)} (${code})`
      : String(message);
  }
  return JSON.stringify(error);
}

/** The engine's own error lines from a job log, most recent last, capped for display. */
export function jobLogExcerpt(log: string, limit = 12): string[] {
  const lines = log
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean);
  const errors = lines.filter((l) => /\b(error|warning|parser|trace)\b/i.test(l));
  return (errors.length ? errors : lines).slice(-limit);
}

/** Whole seconds a job has been going (or took), from the times the core recorded. */
export function jobSeconds(job: Job, now: number): number | null {
  const start = Date.parse(job.startedAt ?? job.createdAt);
  if (!Number.isFinite(start)) return null;
  const end = job.finishedAt ? Date.parse(job.finishedAt) : now;
  return Number.isFinite(end) ? Math.max(0, Math.round((end - start) / 1000)) : null;
}

/* ------------------------------------------------------------------ */
/* Where a render can be asked for                                      */
/* ------------------------------------------------------------------ */

export type RenderBlock =
  | 'read-only-project'
  | 'no-revision'
  | 'no-source'
  | 'not-newest'
  | 'render-running'
  | 'unsaved-edits';

export interface RenderPermission {
  allowed: boolean;
  block: RenderBlock | null;
  /** Why not, in words; names the revision that can be rendered when there is one. */
  reason: string | null;
}

const allow: RenderPermission = { allowed: true, block: null, reason: null };
const deny = (block: RenderBlock, reason: string): RenderPermission => ({
  allowed: false,
  block,
  reason,
});

/**
 * The core commits a queued render only onto the part's newest revision of any state; asked
 * for anything else it runs the whole render and then refuses. So Render is offered only there.
 */
export function renderPermission(input: {
  readOnly: boolean;
  displayed: Revision | null;
  revisions: Revision[];
  activeJob: boolean;
  editing: boolean;
}): RenderPermission {
  const { displayed, revisions } = input;
  if (input.readOnly) return deny('read-only-project', 'This project is read-only.');
  if (!displayed) return deny('no-revision', 'There is no revision to render.');
  if (!displayed.files.some((f) => f.path.toLowerCase().endsWith('.scad')))
    return deny('no-source', `Revision ${displayed.seq} has no OpenSCAD source to render.`);
  const newest = revisions.reduce<Revision | null>(
    (top, r) => (!top || r.seq > top.seq ? r : top),
    null,
  );
  if (newest && newest.id !== displayed.id)
    return deny(
      'not-newest',
      `Only the newest revision can be rendered as it stands, and that is r${newest.seq}.`,
    );
  if (input.activeJob) return deny('render-running', 'A render of this part is already going.');
  if (input.editing)
    return deny('unsaved-edits', 'Save or discard your edits before rendering this revision.');
  return allow;
}

/* ------------------------------------------------------------------ */
/* What the mesh on screen is                                           */
/* ------------------------------------------------------------------ */

export type MeshProvenance = 'none' | 'rendered' | 'illustrative' | 'unlinked';

function plainParams(params: MechanicalPayload['params'] | undefined): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params ?? {}).map(([name, value]) => [
      name,
      value && typeof value === 'object' ? value.value : value,
    ]),
  );
}

/**
 * Whether the attached mesh is the recorded render of this revision's own source and
 * parameters. A mesh that was attached by hand, or carried over from a revision whose source
 * has since changed, is real geometry but not evidence about this revision.
 */
export function meshProvenance(
  payload: Partial<MechanicalPayload>,
  files: Revision['files'],
): MeshProvenance {
  const stl =
    files.find((f) => f.path === payload.stl?.path) ??
    files.find((f) => f.path.toLowerCase().endsWith('.stl'));
  if (!stl) return 'none';
  const scad = files.find((f) => f.path.toLowerCase().endsWith('.scad'));
  const identity = payload.renderIdentity;
  const linked =
    !!identity &&
    !!stl.sha256 &&
    identity.outputHash === stl.sha256 &&
    identity.sourceHash === scad?.sha256 &&
    sameValue(identity.params, plainParams(payload.params));
  if (linked) return 'rendered';
  // The project's own convention for a stand-in mesh attached for visual review.
  return payload.manufacturing?.includes('Illustrative') ? 'illustrative' : 'unlinked';
}
