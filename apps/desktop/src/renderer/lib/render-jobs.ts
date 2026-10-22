/**
 * Truthful outcomes for the mechanical loop: what a CAD write actually produced, which render
 * and export jobs belong to a part and what state they are in, where the core will accept a
 * render, and what a STEP export wrote.
 */
import type { Job, MechanicalPayload, Revision } from '@omenflow/contracts';
import { formatQuantity } from '../ui/format';
import { formatBytes } from './diff';
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

/* ------------------------------------------------------------------ */
/* STEP export (cad.export with format step)                            */
/* ------------------------------------------------------------------ */

/** STEP export jobs for one part, newest first. */
export function exportJobsFor(jobs: Job[], artifactId: string): Job[] {
  return jobs
    .filter((j) => j.kind === 'cad_export' && jobInputs(j).artifactId === artifactId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The fields of a `cad.export` STEP result the stage reads. */
export interface StepExportResult {
  path: string;
  format: 'step';
  revisionId: string;
  revisionSeq: number;
  reviewState: string;
  isBaseline: boolean;
  verification?: string;
  /** brep: rebuilt with exact surfaces and compared with the render; faceted: the render's triangles. */
  method: 'brep' | 'faceted';
  exact: boolean;
  faces: number;
  solids: number;
  bytes: number;
  checks: Record<string, unknown>;
  converter: Record<string, unknown> | null;
  approximations?: string[];
  /** Why the file is not exact, when it is faceted and exact was tried. */
  reason?: string;
  notes?: string[];
}

/**
 * Why Export STEP is not offered for the revision on screen, or null. The core exports only a
 * revision's own render, the mesh its checks measured.
 */
export function stepExportBlock(input: {
  readOnly: boolean;
  displayed: Revision | null;
  provenance: MeshProvenance;
  editing: boolean;
  /** Revision number of a STEP export of this part that is still running. */
  running: number | null;
}): string | null {
  const { displayed } = input;
  if (input.readOnly) return 'This project is read-only.';
  if (!displayed) return 'There is no revision to export.';
  if (input.running !== null) return `A STEP export of r${input.running} is running.`;
  if (input.editing)
    return 'Save or discard your edits first; the export uses the recorded revision.';
  if (input.provenance === 'illustrative')
    return `r${displayed.seq} shows an illustrative mesh, not a render of its source.`;
  if (input.provenance !== 'rendered')
    return `r${displayed.seq} has no render of its own source; render it first.`;
  return null;
}

/** The suggested file name, slugged as the core names part files: `motor-mount-r3.step`. */
export function stepFileName(title: string, seq: number): string {
  let slug = '';
  for (const ch of title) {
    if (/^[A-Za-z0-9]$/.test(ch)) slug += ch.toLowerCase();
    else if (slug && !slug.endsWith('-')) slug += '-';
  }
  slug = slug.replace(/-+$/, '').slice(0, 60);
  return `${slug || 'part'}-r${seq}.step`;
}

const num = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * What a STEP export wrote, in words: exact surfaces only when the core compared them with the
 * render and every check passed; a faceted file says so and why.
 */
export function stepOutcomeView(r: StepExportResult): {
  tone: 'ok' | 'warn';
  headline: string;
  lines: string[];
  approximations: string[];
} {
  const size = formatBytes(r.bytes);
  const c = r.checks;
  const lines: string[] = [];
  const approximations = r.approximations ?? [];
  if (r.method === 'brep') {
    const volume = num(c.volumeErrorPct);
    const box = num(c.bboxErrorMm);
    const probes = num(c.surfaceProbes);
    const own = num(c.solidProbes);
    const samples = num(c.samples);
    const agree: string[] = [];
    if (probes !== null)
      agree.push(
        `${probes - (num(c.surfaceMismatches) ?? 0)} of ${probes} probes at ${own !== null ? 'the render’s' : 'its'} faces`,
      );
    if (own !== null)
      agree.push(`${own - (num(c.solidMismatches) ?? 0)} of ${own} at the solid’s own faces`);
    if (samples !== null)
      agree.push(`${samples - (num(c.sampleMismatches) ?? 0)} of ${samples} points through it`);
    const within = [
      volume !== null ? `volume within ${formatQuantity({ value: volume, unit: '%' })}` : null,
      box !== null ? `bounding box within ${formatQuantity({ value: box, unit: 'mm' })}` : null,
      agree.length
        ? `${agree.length > 1 ? `${agree.slice(0, -1).join(', ')} and ${agree[agree.length - 1]}` : agree[0]} agree`
        : null,
    ].filter((x): x is string => !!x);
    lines.push(
      `Rebuilt from the source and compared with r${r.revisionSeq}’s render${within.length ? `: ${within.join(', ')}` : ''}.`,
    );
  } else {
    lines.push(r.reason ? `Why not exact: ${r.reason}` : 'Faceted, as asked.');
    lines.push(
      `Built from r${r.revisionSeq}’s render triangles: ${r.solids} closed ${r.solids === 1 ? 'solid' : 'solids'}, no vertex moved.`,
    );
  }
  for (const note of r.notes ?? [])
    if (!note.startsWith('Approximated, not exact:')) lines.push(note);
  const headline =
    r.method === 'brep'
      ? r.exact
        ? `STEP saved · exact surfaces · ${r.faces} faces · ${size}`
        : `STEP saved · exact surfaces except approximated hulls · ${r.faces} faces · ${size}`
      : `STEP saved · faceted, not exact · ${r.faces} planar faces · ${size}`;
  return { tone: r.method === 'brep' && r.exact ? 'ok' : 'warn', headline, lines, approximations };
}

/** Is a faceted export's reason the missing converter, which Settings can fix? */
export function missingConverter(r: StepExportResult): boolean {
  return r.method === 'faceted' && !!r.reason && /^No Python with OCP\b/.test(r.reason);
}
