import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CoreApp,
  nullHost,
  latestCadVerification,
  approveCadVerificationScope,
  writeBinaryStl,
  type CadReport,
} from '@omenflow/core';
import type { Job, MechanicalPayload, Revision } from '@omenflow/contracts';
import { createEngineTools, OpenScadAdapter } from './index.js';

const user = { kind: 'user' } as const;
const apps: CoreApp[] = [];
let available = false;
beforeAll(async () => {
  available = (await new OpenScadAdapter().probe()).available;
});
afterEach(() => {
  for (const app of apps.splice(0)) app.closeAll();
});
async function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omen-cad-consistency-'));
  const app = new CoreApp(path.join(root, 'settings'), nullHost);
  app.engineTools = createEngineTools();
  apps.push(app);
  const { projectId } = (await app.dispatch(
    'project.create',
    { name: 'CAD consistency', path: path.join(root, 'project') },
    user,
  )) as { projectId: string };
  const ctx = app.contextFor(projectId);
  const call = <T>(op: string, payload: unknown): Promise<T> =>
    app.dispatch(op, payload, user, projectId) as Promise<T>;
  const write = (source = 'width=10; cube([width,10,10]);', extra = {}) =>
    call<CadReport>('cad.write_source', { title: 'Cube', source, ...extra });
  return { app, ctx, call, write };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Timed out waiting for background job');
}

describe.skipIf(
  !fs.existsSync('/Applications/OpenSCAD.app') && !fs.existsSync('/usr/bin/openscad'),
)('canonical CAD input and render lifecycle', () => {
  it('invalidates an old mesh on a GUI source edit and reads/checks the new source', async () => {
    if (!available) return;
    const { call, write, ctx } = await project();
    const first = await write();
    await call('artifact.accept_draft', {
      artifactId: first.artifactId,
      draftRevisionId: first.revisionId,
      rationale: 'baseline',
    });
    const edited = await call<{ revision: Revision }>('artifact.apply_edit', {
      artifactId: first.artifactId,
      baseRevisionId: first.revisionId,
      fileWrites: [
        {
          path: first.sourcePath,
          contentBase64: Buffer.from('width=20; cube([width,10,10]);').toString('base64'),
        },
      ],
      rationale: 'change width',
    });
    const payload = edited.revision.payload as MechanicalPayload;
    expect(payload.stl).toBeUndefined();
    expect(payload.renderIdentity).toBeUndefined();
    expect(payload.scad?.sha256).toBe(
      edited.revision.files.find((f) => f.path.endsWith('.scad'))?.sha256,
    );
    const source = await call<{ source: string; hasRender: boolean }>('cad.read_source', {
      artifactId: first.artifactId,
    });
    expect(source.source).toContain('width=20');
    expect(source.hasRender).toBe(false);
    const inspected = await call<CadReport>('cad.inspect', { artifactId: first.artifactId });
    expect(inspected.geometry?.bounds.size).toEqual([20, 10, 10]);
    const checked = await call<{ pass: boolean }>('cad.check', {
      artifactId: first.artifactId,
      expect: { bbox: { min: [0, 0, 0], max: [10, 10, 10] } },
    });
    expect(checked.pass).toBe(false);
    expect(ctx.repo.getArtifact(first.artifactId)?.selectedRevisionId).toBe(edited.revision.id);
  });

  it('set_param replaces the controlling override and composition pins the same geometry', async () => {
    if (!available) return;
    const { call, write, ctx } = await project();
    const first = await write(undefined, { params: { width: 20 } });
    expect(first.geometry?.bounds.size[0]).toBe(20);
    const changed = await call<CadReport>('cad.set_param', {
      artifactId: first.artifactId,
      name: 'width',
      value: 30,
    });
    expect(changed.geometry?.bounds.size[0]).toBe(30);
    const composed = await call<CadReport>('cad.compose', {
      title: 'Snapshot',
      instances: [{ artifactId: first.artifactId, revisionId: changed.revisionId }],
    });
    expect(composed.geometry?.bounds.size[0]).toBe(30);
    expect(ctx.repo.getRevision(composed.revisionId)?.inputs).toMatchObject([
      { artifactId: first.artifactId, revisionId: changed.revisionId },
    ]);
  });

  it('source edits through patch and GUI replace an inherited shadowing override', async () => {
    if (!available) return;
    const { write, call, ctx } = await project();
    const first = await write(undefined, { params: { width: 20 } });
    const patched = await call<CadReport>('cad.patch_source', {
      artifactId: first.artifactId,
      oldString: 'width=10',
      newString: 'width=30',
    });
    expect(patched.geometry?.bounds.size[0]).toBe(30);
    const overwritten = await write('width=30; cube([width,10,10]);', {
      artifactId: first.artifactId,
      params: { width: 40 },
    });
    await call('artifact.accept_draft', {
      artifactId: first.artifactId,
      draftRevisionId: overwritten.revisionId,
      rationale: 'baseline',
    });
    const edited = await call<{ revision: Revision }>('artifact.apply_edit', {
      artifactId: first.artifactId,
      baseRevisionId: overwritten.revisionId,
      fileWrites: [
        {
          path: first.sourcePath,
          contentBase64: Buffer.from('width=50; cube([width,10,10]);').toString('base64'),
        },
      ],
      rationale: 'explicit source dimension',
    });
    expect((edited.revision.payload as MechanicalPayload).params.width).toBeUndefined();
    expect(
      (await call<CadReport>('cad.inspect', { artifactId: first.artifactId })).geometry?.bounds
        .size[0],
    ).toBe(50);
    expect(ctx.requireRevision(edited.revision.id).files.some((f) => f.path.endsWith('.stl'))).toBe(
      false,
    );
  });

  it('converts explicit length and angle quantities and rejects unsupported dimensions', async () => {
    if (!available) return;
    const { call, write, ctx } = await project();
    const first = await write();
    const { job } = await call<{ job: Job }>('cad.render', {
      artifactId: first.artifactId,
      params: { width: { value: 1, unit: 'in' } },
    });
    await until(
      () =>
        ctx.repo.getJob(job.id)?.status !== 'running' &&
        ctx.repo.getJob(job.id)?.status !== 'queued',
    );
    expect(ctx.repo.getJob(job.id)?.status).toBe('succeeded');
    expect(
      (await call<CadReport>('cad.inspect', { artifactId: first.artifactId })).geometry?.bounds
        .size[0],
    ).toBe(25.4);
    await expect(
      call('cad.render', {
        artifactId: first.artifactId,
        params: { width: { value: 2, unit: 'kg' } },
      }),
    ).rejects.toThrow(/unsupported mass/);
  });

  it('rejects unpinned host dependencies before creating an artifact', async () => {
    const { write, ctx } = await project();
    for (const source of [
      'include </tmp/host.scad> cube(10);',
      'import("/tmp/host.stl");',
      'surface(file="height.png");',
      'linear_extrude(1) text("host font");',
      'cube(rands(1,10,1)[0]);',
    ]) {
      await expect(write(source)).rejects.toThrow(/self-contained/);
    }
    expect(ctx.repo.listArtifacts()).toHaveLength(0);
  });

  it('does not implicitly select rejected work', async () => {
    if (!available) return;
    const { write, call, ctx } = await project();
    const first = await write();
    const second = await write('cube(20);', { artifactId: first.artifactId });
    ctx.repo.setRevisionState(second.revisionId, 'rejected');
    const current = await call<{ revisionId: string }>('cad.read_source', {
      artifactId: first.artifactId,
    });
    expect(current.revisionId).toBe(first.revisionId);
    const historical = await call<{ revisionId: string }>('cad.read_source', {
      artifactId: first.artifactId,
      revisionId: second.revisionId,
    });
    expect(historical.revisionId).toBe(second.revisionId);
  });

  it('cancel before probe completes cannot spawn or commit a render', async () => {
    if (!available) return;
    const { write, call, ctx } = await project();
    const first = await write();
    const cad = ctx.tools.cad!;
    const probe = cad.probe.bind(cad);
    const render = cad.render.bind(cad);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let spawned = false;
    cad.probe = async () => {
      await gate;
      return probe();
    };
    cad.render = async (...args) => {
      spawned = true;
      return render(...args);
    };
    const { job } = await call<{ job: Job }>('cad.render', { artifactId: first.artifactId });
    await call('job.cancel', { jobId: job.id });
    release();
    await until(() => !ctx.jobCancels.has(job.id));
    expect(spawned).toBe(false);
    expect(ctx.repo.getJob(job.id)?.status).toBe('cancelled');
    expect(ctx.repo.listRevisions(first.artifactId)).toHaveLength(1);
  });

  it('external edits during a render are never overwritten', async () => {
    if (!available) return;
    const { write, ctx } = await project();
    const first = await write();
    const cad = ctx.tools.cad!;
    const probe = cad.probe.bind(cad);
    cad.probe = async () => {
      fs.writeFileSync(ctx.resolvePath(first.sourcePath), 'cube(99);');
      return probe();
    };
    await expect(write('cube(20);', { artifactId: first.artifactId })).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
      details: { sourcePath: first.sourcePath, conflictRevisionId: expect.any(String) },
    });
    expect(fs.readFileSync(ctx.resolvePath(first.sourcePath), 'utf8')).toBe('cube(99);');
    const history = ctx.repo.listRevisions(first.artifactId);
    expect(history.some((r) => r.rationale.includes('conflict candidate'))).toBe(true);
    expect(history.at(-1)?.id).not.toBe(first.revisionId);
  });

  it('a cancellation after the engine produced output still prevents commit', async () => {
    if (!available) return;
    const { write, call, ctx } = await project();
    const first = await write();
    const cad = ctx.tools.cad!;
    const render = cad.render.bind(cad);
    cad.render = async (spec, onLog) => {
      const result = await render(spec, onLog);
      ctx.cancelJob(spec.jobId);
      return result;
    };
    const { job } = await call<{ job: Job }>('cad.render', {
      artifactId: first.artifactId,
      params: { width: 30 },
    });
    await until(() => ctx.repo.getJob(job.id)?.status === 'cancelled');
    await until(() => !ctx.jobCancels.has(job.id));
    expect(ctx.repo.listRevisions(first.artifactId)).toHaveLength(1);
    expect(ctx.repo.getJob(job.id)?.status).toBe('cancelled');
  });

  it('ignores a corrupt completed cache entry', async () => {
    if (!available) return;
    const { write, ctx } = await project();
    const first = await write();
    const identity = (ctx.repo.getRevision(first.revisionId)?.payload as MechanicalPayload)
      .renderIdentity!;
    fs.writeFileSync(
      ctx.resolvePath(`.omenflow/cache/render-v1/${identity.inputFingerprint}/output.stl`),
      'corrupt',
    );
    const second = await write(undefined, { artifactId: first.artifactId });
    expect(second.render.ok).toBe(true);
    expect(second.render.tool).not.toContain('cached');
    expect(second.geometry?.bounds.size).toEqual([10, 10, 10]);
  });

  it('records engine-version cache identity and refuses an older expected parent', async () => {
    if (!available) return;
    const { write, ctx } = await project();
    const first = await write();
    const firstIdentity = (ctx.repo.getRevision(first.revisionId)?.payload as MechanicalPayload)
      .renderIdentity!;
    const cad = ctx.tools.cad!;
    const probe = cad.probe.bind(cad);
    cad.probe = async () => ({ ...(await probe()), version: 'test-version-change' });
    const second = await write(undefined, { artifactId: first.artifactId });
    const secondIdentity = (ctx.repo.getRevision(second.revisionId)?.payload as MechanicalPayload)
      .renderIdentity!;
    expect(secondIdentity.inputFingerprint).not.toBe(firstIdentity.inputFingerprint);
    await expect(
      write(undefined, { artifactId: first.artifactId, expectedRevisionId: first.revisionId }),
    ).rejects.toThrow(/revision changed/);
  });

  it('binds check evidence to exact geometry and cannot erase failures by empty checks or a rewrite', async () => {
    if (!available) return;
    const { write, call, ctx } = await project();
    const first = await write();
    const required = { bbox: { min: [0, 0, 0], max: [20, 10, 10] } };
    const failed = await call<{ pass: boolean; verificationStatus: string }>('cad.check', {
      artifactId: first.artifactId,
      expect: required,
    });
    expect(failed.pass).toBe(false);
    expect(failed.verificationStatus).toBe('failed');
    const empty = await call<{ pass: boolean; verificationStatus: string }>('cad.check', {
      artifactId: first.artifactId,
      expect: {},
    });
    expect(empty.pass).toBe(true);
    expect(empty.verificationStatus).toBe('scope_changed');
    const rewritten = await write('width=10; cube([width,10,10]); // unchanged', {
      artifactId: first.artifactId,
    });
    const erased = await call<{ verificationStatus: string }>('cad.check', {
      artifactId: first.artifactId,
      expect: {},
    });
    expect(erased.verificationStatus).toBe('scope_changed');
    expect(latestCadVerification(ctx, ctx.requireRevision(rewritten.revisionId)).status).toBe(
      'scope_changed',
    );
    const repaired = await write('width=20; cube([width,10,10]);', {
      artifactId: first.artifactId,
    });
    expect(latestCadVerification(ctx, ctx.requireRevision(repaired.revisionId)).status).toBe(
      'unverified',
    );
    const checked = await call<{ verificationStatus: string; evidenceHash: string }>('cad.check', {
      artifactId: first.artifactId,
      expect: required,
    });
    expect(checked.verificationStatus).toBe('passed');
    const result = latestCadVerification(ctx, ctx.requireRevision(repaired.revisionId));
    expect(result.status).toBe('passed');
    expect(result.evidence?.revisionId).toBe(repaired.revisionId);
    expect(result.evidenceHash).toBe(checked.evidenceHash);
    expect(result.evidence?.outputHash).toBe(
      (ctx.requireRevision(repaired.revisionId).payload as MechanicalPayload).stl?.sha256,
    );
  });

  it('requires explicit exact-evidence acceptance of a changed scope and then uses the accepted scope', async () => {
    if (!available) return;
    const { write, call, ctx } = await project();
    const first = await write();
    const oldScope = { bbox: { min: [0, 0, 0], max: [20, 10, 10] } };
    await call('cad.check', { artifactId: first.artifactId, expect: oldScope });
    const newScope = { bbox: { min: [0, 0, 0], max: [10, 10, 10] } };
    const checked = await call<{ verificationStatus: string; evidenceHash: string }>('cad.check', {
      artifactId: first.artifactId,
      expect: newScope,
    });
    expect(checked.verificationStatus).toBe('scope_changed');
    expect(() =>
      approveCadVerificationScope(ctx, ctx.requireRevision(first.revisionId), '0'.repeat(64)),
    ).toThrow(/evidence changed/);
    approveCadVerificationScope(ctx, ctx.requireRevision(first.revisionId), checked.evidenceHash);
    expect(latestCadVerification(ctx, ctx.requireRevision(first.revisionId)).status).toBe('passed');
    const checkedAgain = await call<{ verificationStatus: string }>('cad.check', {
      artifactId: first.artifactId,
      expect: newScope,
    });
    expect(checkedAgain.verificationStatus).toBe('passed');
    const weakened = await call<{ verificationStatus: string; evidenceHash: string }>('cad.check', {
      artifactId: first.artifactId,
      expect: {},
    });
    expect(weakened.verificationStatus).toBe('scope_changed');
    expect(() =>
      approveCadVerificationScope(
        ctx,
        ctx.requireRevision(first.revisionId),
        weakened.evidenceHash,
      ),
    ).toThrow(/generic-only/);
  });

  it('concurrent and subsequent cad.check retries replay the actual result exactly once', async () => {
    if (!available) return;
    const { write, app, ctx } = await project();
    const first = await write();
    const input = {
      artifactId: first.artifactId,
      expect: { bbox: { min: [0, 0, 0], max: [10, 10, 10] } },
    };
    const check = () => app.dispatch('cad.check', input, user, ctx.projectId, 'check-once');
    const results = await Promise.all([check(), check(), check()]);
    const replay = await check();
    expect(results[0]).toMatchObject({ pass: true, verificationStatus: 'passed' });
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(replay).toEqual({ ...(results[0] as Record<string, unknown>), idempotent: true });
    expect(ctx.repo.listCadCheckJobs(first.artifactId)).toHaveLength(1);
  });

  it('a successful parameter variant cannot verify the stored revision', async () => {
    if (!available) return;
    const { write, call, ctx } = await project();
    const first = await write();
    const checked = await call<{ pass: boolean; verificationStatus: string }>('cad.check', {
      artifactId: first.artifactId,
      params: { width: 20 },
      expect: { bbox: { min: [0, 0, 0], max: [20, 10, 10] } },
    });
    expect(checked.pass).toBe(true);
    expect(checked.verificationStatus).toBe('unverified');
    expect(latestCadVerification(ctx, ctx.requireRevision(first.revisionId)).status).toBe(
      'unverified',
    );
  });

  it('cannot certify an open zero-volume mesh by disabling the optional watertight assertion', async () => {
    if (!available) return;
    const { write, call, ctx } = await project();
    ctx.tools.cad!.render = async (spec) => {
      fs.writeFileSync(
        spec.outPath,
        writeBinaryStl(new Float64Array([0, 0, 0, 10, 0, 0, 0, 10, 0])),
      );
      return { ok: true };
    };
    const first = await write();
    const checked = await call<{ pass: boolean; verificationStatus: string; evidenceHash: string }>(
      'cad.check',
      {
        artifactId: first.artifactId,
        expect: { watertight: false, bbox: { min: [0, 0, 0], max: [10, 10, 0] } },
      },
    );
    expect(checked.pass).toBe(true);
    expect(checked.verificationStatus).toBe('failed');
    expect(latestCadVerification(ctx, ctx.requireRevision(first.revisionId)).status).toBe('failed');
    expect(() =>
      approveCadVerificationScope(ctx, ctx.requireRevision(first.revisionId), checked.evidenceHash),
    ).toThrow(/cannot establish/);
  });

  it('a final commit failure terminates its job and preserves the prior revision', async () => {
    if (!available) return;
    const { write, ctx } = await project();
    const first = await write();
    const insert = ctx.repo.insertRevision.bind(ctx.repo);
    ctx.repo.insertRevision = () => {
      throw new Error('injected commit failure');
    };
    try {
      await expect(write('cube(20);', { artifactId: first.artifactId })).rejects.toThrow(
        /injected commit failure/,
      );
    } finally {
      ctx.repo.insertRevision = insert;
    }
    expect(ctx.repo.listRevisions(first.artifactId)).toHaveLength(1);
    const job = ctx.repo.listJobs().find((j) => j.status === 'failed')!;
    expect(job).toBeTruthy();
    expect(ctx.objects.read(job.inputHashes.source!).toString()).toBe('cube(20);');
    expect(ctx.repo.listJobs().some((j) => j.status === 'running' || j.status === 'queued')).toBe(
      false,
    );
  });

  it('historical evidence cannot certify a reverted part against newly accepted requirements', async () => {
    if (!available) return;
    const { write, call, ctx } = await project();
    const first = await write();
    await call('cad.check', {
      artifactId: first.artifactId,
      expect: { bbox: { min: [0, 0, 0], max: [10, 10, 10] } },
    });
    const changed = await write('cube([20,10,10]);', { artifactId: first.artifactId });
    const checked = await call<{ evidenceHash: string }>('cad.check', {
      artifactId: first.artifactId,
      expect: { bbox: { min: [0, 0, 0], max: [20, 10, 10] } },
    });
    approveCadVerificationScope(ctx, ctx.requireRevision(changed.revisionId), checked.evidenceHash);
    expect(latestCadVerification(ctx, ctx.requireRevision(changed.revisionId)).status).toBe(
      'passed',
    );
    expect(latestCadVerification(ctx, ctx.requireRevision(first.revisionId)).status).toBe(
      'scope_changed',
    );
  });

  it('diagnosing an old revision after a candidate exists does not redefine the candidate requirements', async () => {
    if (!available) return;
    const { write, call, ctx } = await project();
    const first = await write();
    const changed = await write('cube([20,10,10]);', { artifactId: first.artifactId });
    await call('cad.check', {
      artifactId: first.artifactId,
      revisionId: first.revisionId,
      expect: { bbox: { min: [0, 0, 0], max: [10, 10, 10] } },
    });
    const final = await call<{ verificationStatus: string }>('cad.check', {
      artifactId: first.artifactId,
      revisionId: changed.revisionId,
      expect: { bbox: { min: [0, 0, 0], max: [20, 10, 10] } },
    });
    expect(final.verificationStatus).toBe('passed');
    expect(latestCadVerification(ctx, ctx.requireRevision(changed.revisionId)).status).toBe(
      'passed',
    );
  });

  it('preserves against the source-only baseline, even after a bad draft is rewritten', async () => {
    if (!available) return;
    const { call, ctx } = await project();
    const seed = await call<{ artifact: { id: string }; revision: Revision }>(
      'artifact.create_draft',
      {
        type: 'mechanical',
        title: 'Source-only baseline',
        payload: { modelUnit: 'mm', params: {} },
        files: [
          {
            path: 'artifacts/mechanical/reference.scad',
            contentBase64: Buffer.from('cube([20,20,20]);').toString('base64'),
          },
        ],
      },
    );
    await call('artifact.accept_draft', {
      artifactId: seed.artifact.id,
      draftRevisionId: seed.revision.id,
      rationale: 'source baseline',
    });
    const changed = await call<CadReport>('cad.write_source', {
      artifactId: seed.artifact.id,
      source: 'cube([20,20,20]); // unchanged geometry',
    });
    const check = (revisionId: string) =>
      call<{ pass: boolean; evidenceHash: string }>('cad.check', {
        artifactId: seed.artifact.id,
        revisionId,
        expect: {
          bbox: { min: [0, 0, 0], max: [20, 20, 20] },
          preserve: { changeRegions: [{ center: [1, 1, 1], radius: 1 }] },
        },
      });
    expect((await check(changed.revisionId)).pass).toBe(true);
    const bad = await call<CadReport>('cad.write_source', {
      artifactId: seed.artifact.id,
      source: 'cube([10,20,20]);',
    });
    const repeated = await call<CadReport>('cad.write_source', {
      artifactId: seed.artifact.id,
      source: 'cube([10,20,20]); // repeated',
    });
    const checked = await check(repeated.revisionId);
    expect(checked.pass).toBe(false);
    const evidence = JSON.parse(ctx.objects.read(checked.evidenceHash).toString()) as {
      preservation: { revisionId: string };
      checks: { name: string; pass: boolean }[];
    };
    expect(evidence.preservation.revisionId).toBe(seed.revision.id);
    expect(evidence.checks.find((c) => c.name === 'unrelated geometry preserved')?.pass).toBe(
      false,
    );
    expect(bad.revisionId).not.toBe(evidence.preservation.revisionId);
  });

  it('never overwrites an uppercase source filename with its derived STL', async () => {
    if (!available) return;
    const { call, ctx } = await project();
    const sourcePath = 'artifacts/mechanical/Legacy.SCAD';
    const seed = await call<{ artifact: { id: string } }>('artifact.create_draft', {
      type: 'mechanical',
      title: 'Legacy',
      payload: { scad: { path: sourcePath }, modelUnit: 'mm', params: {} },
      files: [{ path: sourcePath, contentBase64: Buffer.from('cube(10);').toString('base64') }],
    });
    const rendered = await call<CadReport>('cad.write_source', {
      artifactId: seed.artifact.id,
      source: 'cube(20);',
    });
    expect(fs.readFileSync(ctx.resolvePath(sourcePath), 'utf8')).toBe('cube(20);');
    expect((ctx.requireRevision(rendered.revisionId).payload as MechanicalPayload).stl?.path).toBe(
      'artifacts/mechanical/Legacy.stl',
    );
  });
});
