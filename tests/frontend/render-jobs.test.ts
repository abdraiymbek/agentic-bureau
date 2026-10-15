import { describe, expect, it } from 'vitest';
import type { Job, MechanicalPayload, Revision } from '@omenflow/contracts';
import {
  jobErrorText,
  jobIsActive,
  jobLogExcerpt,
  jobRevisionId,
  jobSeconds,
  meshProvenance,
  renderJobsFor,
  renderOutcome,
  renderPermission,
} from '../../apps/desktop/src/renderer/lib/render-jobs';

function job(id: string, status: Job['status'], extra: Partial<Job> = {}): Job {
  return {
    id,
    kind: 'cad_render',
    tool: 'openscad',
    toolVersion: null,
    inputs: { artifactId: 'part', revisionId: 'r2' },
    inputHashes: {},
    command: null,
    status,
    log: '',
    outputHashes: {},
    error: null,
    sessionId: null,
    createdAt: `2026-10-13T10:00:0${id.length}Z`,
    startedAt: null,
    finishedAt: null,
    ...extra,
  };
}

function revision(
  id: string,
  seq: number,
  files: string[],
  state: Revision['reviewState'] = 'draft',
) {
  return {
    id,
    seq,
    reviewState: state,
    files: files.map((path) => ({ path, role: 'source', sha256: `${path}-hash`.padEnd(64, '0') })),
  } as unknown as Revision;
}

describe('what a CAD write produced', () => {
  it('reports a failed render as failed, with the engine errors', () => {
    const outcome = renderOutcome({
      revisionId: 'r5',
      render: { ok: false, errors: ['ERROR: Parser error in line 50'], warnings: [] },
      notes: ['Render failed — fix the source and call cad.write_source again.'],
    });
    expect(outcome).toEqual({
      revisionId: 'r5',
      rendered: false,
      errors: ['ERROR: Parser error in line 50'],
      warnings: [],
      notes: [],
    });
  });
  it('never takes a missing success flag for a success', () => {
    const outcome = renderOutcome({ revisionId: 'r5' });
    expect(outcome.rendered).toBe(false);
    expect(outcome.errors).toHaveLength(1);
  });
  it('keeps warnings and qualifying notes on a successful render', () => {
    const outcome = renderOutcome({
      revisionId: 'r6',
      render: { ok: true, warnings: ['WARNING: Object may not be a valid 2-manifold'] },
      notes: ['NOT VERIFIED: source winding is inverted; repair the source before checking.'],
    });
    expect(outcome.rendered).toBe(true);
    expect(outcome.errors).toEqual([]);
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.notes).toEqual([
      'NOT VERIFIED: source winding is inverted; repair the source before checking.',
    ]);
  });
});

describe('background render jobs', () => {
  const jobs = [
    job('a', 'succeeded'),
    job('bb', 'failed', { error: { code: 'TOOL_MISSING', message: 'OpenSCAD not found' } }),
    job('ccc', 'running', { inputs: { artifactId: 'other', revisionId: 'x' } }),
    job('dddd', 'queued', { kind: 'cad_check' }),
  ];
  it('lists the render jobs of one part, newest first', () => {
    expect(renderJobsFor(jobs, 'part').map((j) => j.id)).toEqual(['bb', 'a']);
    expect(renderJobsFor(jobs, 'other').map((j) => j.id)).toEqual(['ccc']);
    expect(renderJobsFor([job('x', 'failed', { inputs: null })], 'part')).toEqual([]);
  });
  it('knows which states are still going', () => {
    expect(['queued', 'running'].every((s) => jobIsActive({ status: s as Job['status'] }))).toBe(
      true,
    );
    expect(
      ['succeeded', 'failed', 'cancelled', 'interrupted'].some((s) =>
        jobIsActive({ status: s as Job['status'] }),
      ),
    ).toBe(false);
  });
  it('reads the error a job recorded in either shape', () => {
    expect(jobErrorText(jobs[1]!)).toBe('OpenSCAD not found (TOOL_MISSING)');
    expect(jobErrorText(job('e', 'failed', { error: 'timed out after 120 s' }))).toBe(
      'timed out after 120 s',
    );
    expect(
      jobErrorText(job('f', 'failed', { error: { code: 'INTERNAL', message: 'engine crashed' } })),
    ).toBe('engine crashed');
    expect(jobErrorText(jobs[0]!)).toBeNull();
  });
  it('shows the engine’s own error lines from a long log', () => {
    const log = [
      'Compiling…',
      'WARNING: variable x unknown',
      'ERROR: Parser error',
      '',
      'done',
    ].join('\n');
    expect(jobLogExcerpt(log)).toEqual(['WARNING: variable x unknown', 'ERROR: Parser error']);
    expect(jobLogExcerpt('first\nsecond\nthird', 2)).toEqual(['second', 'third']);
    expect(jobLogExcerpt('')).toEqual([]);
  });
  it('times a job from the core’s own timestamps', () => {
    const started = job('g', 'running', { startedAt: '2026-10-13T10:00:10Z' });
    expect(jobSeconds(started, Date.parse('2026-10-13T10:00:25Z'))).toBe(15);
    expect(
      jobSeconds(
        { ...started, finishedAt: '2026-10-13T10:00:12Z' },
        Date.parse('2026-10-13T11:00:00Z'),
      ),
    ).toBe(2);
    expect(jobSeconds(job('h', 'queued', { createdAt: 'not a time' }), 0)).toBeNull();
    expect(jobRevisionId(started)).toBe('r2');
  });
});

describe('where a render is offered', () => {
  const r1 = revision('r1', 1, ['part.scad'], 'approved');
  const r2 = revision('r2', 2, ['part.scad', 'part.stl']);
  const rejected = revision('r3', 3, ['part.scad'], 'rejected');
  const ask = (displayed: Revision | null, revisions: Revision[], extra = {}) =>
    renderPermission({
      readOnly: false,
      displayed,
      revisions,
      activeJob: false,
      editing: false,
      ...extra,
    });

  it('offers it on the newest revision of any state, and only there', () => {
    expect(ask(r2, [r1, r2])).toEqual({ allowed: true, block: null, reason: null });
    expect(ask(r1, [r1, r2])).toMatchObject({ allowed: false, block: 'not-newest' });
    expect(ask(r1, [r1, r2]).reason).toContain('r2');
    // A later rejected revision still makes the core refuse the earlier one.
    expect(ask(r2, [r1, r2, rejected]).block).toBe('not-newest');
  });
  it('explains every other reason it is unavailable', () => {
    expect(ask(r2, [r1, r2], { readOnly: true }).block).toBe('read-only-project');
    expect(ask(null, []).block).toBe('no-revision');
    expect(ask(revision('r9', 9, ['part.stl']), []).block).toBe('no-source');
    expect(ask(r2, [r1, r2], { activeJob: true }).block).toBe('render-running');
    expect(ask(r2, [r1, r2], { editing: true }).block).toBe('unsaved-edits');
  });
});

describe('what the mesh on screen is', () => {
  const files = revision('r2', 2, ['part.scad', 'part.stl']).files;
  const hash = (path: string) => files.find((f) => f.path === path)!.sha256!;
  const identity = (overrides = {}) =>
    ({
      version: 1,
      sourceHash: hash('part.scad'),
      outputHash: hash('part.stl'),
      params: { width: 50 },
      ...overrides,
    }) as MechanicalPayload['renderIdentity'];

  it('is a render only when identity, source, output and parameters all agree', () => {
    const params = { width: { value: 50, unit: 'mm' } };
    expect(meshProvenance({ params, renderIdentity: identity() }, files)).toBe('rendered');
    expect(meshProvenance({ params, renderIdentity: identity({ sourceHash: 'x' }) }, files)).toBe(
      'unlinked',
    );
    expect(meshProvenance({ params, renderIdentity: identity({ outputHash: 'x' }) }, files)).toBe(
      'unlinked',
    );
    expect(meshProvenance({ params: { width: 60 }, renderIdentity: identity() }, files)).toBe(
      'unlinked',
    );
    expect(meshProvenance({ params }, files)).toBe('unlinked');
  });
  it('keeps the stand-in label only while the mesh is not a real render', () => {
    const manufacturing = 'Illustrative design-preview mesh.';
    expect(meshProvenance({ manufacturing }, files)).toBe('illustrative');
    expect(
      meshProvenance({ manufacturing, params: { width: 50 }, renderIdentity: identity() }, files),
    ).toBe('rendered');
  });
  it('has nothing to say without a mesh', () => {
    expect(meshProvenance({}, files.slice(0, 1))).toBe('none');
  });
});
