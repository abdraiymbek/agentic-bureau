import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId, type Artifact, type MechanicalPayload, type Revision } from '@bureau/contracts';
import {
  CoreApp,
  nullHost,
  writeBinaryStl,
  runChecks,
  createCadVerificationEvidence,
  type ProjectContext,
  type TriangleBuffer,
} from '@bureau/core';
import { renderFingerprint } from '../packages/core/src/cad-input.js';
import {
  evaluateProject,
  metricsFrom,
  providerRunChecks,
  renderScad,
  type CodexRun,
} from '../evals/cad/harness.js';
import type { Task } from '../evals/cad/tasks.js';
import { createEngineTools } from '@bureau/engineering';

const vertices = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];
const faces = [
  [0, 2, 1],
  [0, 3, 2],
  [4, 5, 6],
  [4, 6, 7],
  [0, 1, 5],
  [0, 5, 4],
  [1, 2, 6],
  [1, 6, 5],
  [2, 3, 7],
  [2, 7, 6],
  [3, 0, 4],
  [3, 4, 7],
];
const cube = new Float64Array(
  faces.flatMap((face) => face.flatMap((i) => vertices[i]!)),
) as TriangleBuffer;
const task: Task = {
  id: 'eval-regression',
  category: 'basic',
  prompt: 'Make a unit cube',
  expect: { bbox: { min: [0, 0, 0], max: [1, 1, 1] }, volume: { value: 1 }, shells: 1 },
};
const fakeRender: typeof renderScad = () => ({ tris: cube, stderr: '' });
const roots: string[] = [];
const apps: CoreApp[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const app of apps.splice(0)) app.closeAll();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-evaluator-'));
  roots.push(root);
  const out = path.join(root, 'out');
  fs.mkdirSync(out);
  const app = new CoreApp(path.join(root, 'app'), nullHost);
  apps.push(app);
  const { projectId } = (await app.dispatch(
    'project.create',
    { path: path.join(root, 'project'), name: 'Evaluator' },
    { kind: 'user' },
  )) as { projectId: string };
  return { root, out, app, projectId, ctx: app.contextFor(projectId) };
}
function artifact(ctx: ProjectContext): Artifact {
  const a: Artifact = {
    id: newId(),
    type: 'mechanical',
    title: 'Cube',
    selectedRevisionId: null,
    archived: false,
    createdAt: new Date().toISOString(),
    subsystem: null,
  };
  ctx.repo.insertArtifact(a);
  return a;
}
function revision(
  ctx: ProjectContext,
  a: Artifact,
  state: Revision['reviewState'] = 'draft',
  rendered = true,
): Revision {
  const seq = ctx.repo.nextRevisionSeq(a.id);
  const scad = {
    path: `artifacts/mechanical/${a.id}.scad`,
    sha256: ctx.storeContent(`cube(1); // revision ${seq}`),
    role: 'source' as const,
  };
  const stl = {
    path: `artifacts/mechanical/${a.id}.stl`,
    sha256: ctx.storeContent(writeBinaryStl(cube)),
    role: 'output' as const,
  };
  const base = {
    version: 1 as const,
    sourceHash: scad.sha256,
    params: {},
    modelUnit: 'mm',
    frame: 'right-handed-z-up' as const,
    engine: 'test',
    engineVersion: '1',
    options: 'test',
  };
  const payload: MechanicalPayload = {
    modelUnit: 'mm',
    params: {},
    paramManifest: [],
    scad,
    ...(rendered
      ? {
          stl,
          renderIdentity: {
            ...base,
            inputFingerprint: renderFingerprint(base),
            outputHash: stl.sha256,
          },
        }
      : {}),
  };
  const rev: Revision = {
    id: newId(),
    artifactId: a.id,
    parentId: ctx.repo.listRevisions(a.id).at(-1)?.id ?? null,
    seq,
    origin: 'agent',
    originDetail: null,
    createdAt: new Date().toISOString(),
    payload,
    files: rendered ? [scad, stl] : [scad],
    inputs: [],
    contentHash: scad.sha256,
    rationale: 'fixture',
    reviewState: state,
  };
  ctx.repo.insertRevision(rev);
  if (state === 'approved') ctx.repo.setSelectedRevision(a.id, rev.id);
  return rev;
}
function verify(ctx: ProjectContext, rev: Revision, pass = true) {
  const checks = pass
    ? runChecks(cube, task.expect)
    : [{ name: 'bounding box', pass: false, detail: 'wrong dimensions' }];
  const evidence = createCadVerificationEvidence(
    ctx,
    rev,
    (rev.payload as MechanicalPayload).renderIdentity!,
    task.expect,
    checks,
    { pass: true, detail: 'analytic closed unit-cube fixture' },
  );
  const hash = ctx.storeContent(JSON.stringify(evidence));
  const job = ctx.createJob({
    kind: 'cad_check',
    tool: 'omenflow-geometry',
    inputs: { artifactId: rev.artifactId, revisionId: rev.id, expect: task.expect },
  });
  ctx.jobStatus(job.id, pass ? 'succeeded' : 'failed', { outputHashes: { verification: hash } });
}
const successfulRun: CodexRun = {
  exitCode: 0,
  timedOut: false,
  events: [{ type: 'turn.completed' }],
  stderr: '',
  durationMs: 1,
};

describe('CAD evaluator release gates', () => {
  it.skipIf(!process.env.BUREAU_OPENSCAD_E2E)(
    'evaluates a real rendered and checked final revision end to end',
    async () => {
      const env = await setup();
      env.app.engineTools = createEngineTools();
      env.ctx.tools = env.app.engineTools;
      const origin = { kind: 'agent' as const, sessionId: newId() };
      const created = (await env.app.dispatch(
        'cad.write_source',
        { title: 'Unit cube', source: 'cube(1);' },
        origin,
        env.projectId,
      )) as { artifactId: string; revisionId: string };
      await env.app.dispatch(
        'cad.check',
        { artifactId: created.artifactId, revisionId: created.revisionId, expect: task.expect },
        origin,
        env.projectId,
      );
      const result = await evaluateProject(env.app, env.projectId, task, null, env.out);
      expect(
        result.checks.every((check) => check.pass),
        JSON.stringify(result.checks),
      ).toBe(true);
      expect(result.finalCheckPassed).toBe(true);
    },
  );

  it('cannot pass provider timeout, nonzero/signal exit, error, or missing completion using valid geometry', () => {
    const geometry = runChecks(cube, task.expect);
    expect(geometry.every((check) => check.pass)).toBe(true);
    for (const change of [
      { timedOut: true },
      { exitCode: 1 },
      { exitCode: null },
      { events: [] },
      { events: [{ type: 'error' }, { type: 'turn.completed' }] },
      { events: [{ type: 'turn.failed' }] },
    ]) {
      expect(
        [...providerRunChecks({ ...successfulRun, ...change }), ...geometry].every(
          (check) => check.pass,
        ),
      ).toBe(false);
    }
    expect(providerRunChecks(successfulRun).every((check) => check.pass)).toBe(true);
  });

  it('does not infer verification from pass:true text in a trace', () => {
    const metrics = metricsFrom({
      ...successfulRun,
      events: [
        {
          type: 'item.completed',
          item: {
            type: 'mcp_tool_call',
            tool: 'cad_check',
            result: { content: [{ type: 'text', text: '{"pass":true}' }] },
          },
        },
      ],
    });
    expect(metrics.checkCalls).toBe(1);
    expect(metrics.lastCheckPassed).toBeNull();
  });

  it('passes the exact active candidate with matching render and verification identities', async () => {
    const env = await setup();
    const a = artifact(env.ctx);
    const rev = revision(env.ctx, a);
    verify(env.ctx, rev);
    const result = await evaluateProject(env.app, env.projectId, task, null, env.out, fakeRender);
    expect(result.checks.every((check) => check.pass)).toBe(true);
    expect(result.finalRevisionId).toBe(rev.id);
    expect(result.finalCheckPassed).toBe(true);
    expect(result.verificationEvidenceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects unexpected artifact count and never substitutes another artifact for an archived seed', async () => {
    const env = await setup();
    const a = artifact(env.ctx);
    verify(env.ctx, revision(env.ctx, a));
    const b = artifact(env.ctx);
    verify(env.ctx, revision(env.ctx, b));
    const result = await evaluateProject(env.app, env.projectId, task, null, env.out, fakeRender);
    expect(result.checks.find((check) => check.name === 'mechanical artifact count')?.pass).toBe(
      false,
    );
    env.ctx.repo.setArchived(a.id, true);
    const missingSeed = await evaluateProject(
      env.app,
      env.projectId,
      { ...task, seed: { title: 'Seed', scad: 'cube(1);', path: 'seed.scad' } },
      a.id,
      env.out,
      fakeRender,
    );
    expect(missingSeed.finalRevisionId).toBeNull();
    expect(missingSeed.checks.find((check) => check.name === 'deliverable')?.pass).toBe(false);
  });

  it('excludes rejected/superseded history and does not count rejected changes as completed modification', async () => {
    const env = await setup();
    const a = artifact(env.ctx);
    const baseline = revision(env.ctx, a, 'approved');
    verify(env.ctx, baseline);
    revision(env.ctx, a, 'rejected');
    revision(env.ctx, a, 'superseded');
    const result = await evaluateProject(
      env.app,
      env.projectId,
      { ...task, seed: { title: 'Seed', scad: 'cube(1);', path: 'seed.scad' } },
      a.id,
      env.out,
      fakeRender,
    );
    expect(result.finalRevisionId).toBe(baseline.id);
    expect(
      result.checks.find((check) => check.name === 'new revision on the same artifact')?.pass,
    ).toBe(false);
    env.ctx.repo.setRevisionState(baseline.id, 'rejected');
    const noCandidate = await evaluateProject(
      env.app,
      env.projectId,
      task,
      null,
      env.out,
      fakeRender,
    );
    expect(noCandidate.checks.some((check) => !check.pass)).toBe(true);
    expect(noCandidate.finalRevisionId).toBeNull();
  });

  it('does not use an earlier mesh or verification after the final source changes', async () => {
    const env = await setup();
    const a = artifact(env.ctx);
    const previous = revision(env.ctx, a, 'approved');
    verify(env.ctx, previous);
    const candidate = revision(env.ctx, a, 'draft', false);
    const result = await evaluateProject(env.app, env.projectId, task, null, env.out, fakeRender);
    expect(result.finalRevisionId).toBe(candidate.id);
    expect(result.finalCheckPassed).toBeNull();
    expect(
      result.checks.find((check) => check.name === 'final revision rendered by agent')?.pass,
    ).toBe(false);
    expect(result.checks.find((check) => check.name === 'final revision verified')?.pass).toBe(
      false,
    );
  });

  it('requires final-revision evidence even when an earlier revision passed', async () => {
    const env = await setup();
    const a = artifact(env.ctx);
    verify(env.ctx, revision(env.ctx, a, 'approved'));
    const candidate = revision(env.ctx, a);
    let result = await evaluateProject(env.app, env.projectId, task, null, env.out, fakeRender);
    expect(result.finalCheckPassed).toBeNull();
    verify(env.ctx, candidate, false);
    result = await evaluateProject(env.app, env.projectId, task, null, env.out, fakeRender);
    expect(result.finalCheckPassed).toBe(false);
    expect(result.checks.every((check) => check.pass)).toBe(false);
  });

  it('fails successful renders with warnings, including variants, and failed preservation references', async () => {
    const env = await setup();
    const a = artifact(env.ctx);
    revision(env.ctx, a, 'approved');
    verify(env.ctx, revision(env.ctx, a));
    const warnings: typeof renderScad = (_source, _out, name) =>
      name === 'seed'
        ? { error: 'seed render failed', stderr: 'ERROR: invalid seed' }
        : { tris: cube, stderr: 'WARNING: ignored variable' };
    const result = await evaluateProject(
      env.app,
      env.projectId,
      {
        ...task,
        variants: [{ params: { size: 1 }, expect: task.expect }],
        seed: { title: 'Seed', scad: 'cube(1);', path: 'seed.scad' },
        changeRegions: [{ center: [0, 0, 0], radius: 0.1 }],
      },
      a.id,
      env.out,
      warnings,
    );
    expect(result.checks.find((check) => check.name === 'source renders cleanly')?.pass).toBe(
      false,
    );
    expect(
      result.checks.find(
        (check) => check.name.includes('variant') && check.name.includes('cleanly'),
      )?.pass,
    ).toBe(false);
    expect(result.checks.find((check) => check.name === 'unrelated geometry preserved')?.pass).toBe(
      false,
    );
  });

  it.skipIf(process.platform === 'win32')(
    'captures successful subprocess stderr and rejects stale output on empty rerender',
    async () => {
      const env = await setup();
      const script = path.join(env.root, 'fake-openscad');
      const stl = writeBinaryStl(cube).toString('base64');
      fs.writeFileSync(
        script,
        `#!${process.execPath}\nimport fs from 'node:fs';\nconst out=process.argv[process.argv.indexOf('-o')+1];\nfs.writeFileSync(out,Buffer.from('${stl}','base64'));\nprocess.stderr.write('WARNING: ignored variable\\n');\nprocess.stdout.write('stdout is not diagnostics');\n`,
      );
      fs.chmodSync(script, 0o755);
      vi.stubEnv('BUREAU_EVAL_OPENSCAD', script);
      const rendered = renderScad('cube(1);', env.out, 'test');
      expect('tris' in rendered).toBe(true);
      expect(rendered.stderr).toContain('WARNING: ignored variable');
      expect(rendered.stderr).not.toContain('stdout is not diagnostics');
      fs.writeFileSync(script, `#!${process.execPath}\nprocess.exit(0);\n`);
      expect(renderScad('cube(1);', env.out, 'test')).toMatchObject({ error: 'no output' });
    },
  );
});
