import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Origin, MechanicalPayload } from '@omenflow/contracts';
import { CoreApp, nullHost, writeBinaryStl, parseStlTriangles, analyzeMesh } from './index.js';
import { latestCadVerification, createCadVerificationEvidence } from './cad-verification.js';
import { readActiveWork } from './work.js';
import type { CadAdapter } from './tools.js';
import type { CadReport } from './cad.js';

const user: Origin = { kind: 'user' };
const apps: CoreApp[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.closeAll();
});

function boxStl(length: number): Buffer {
  const vertices = [
    [0, 0, 0],
    [length, 0, 0],
    [length, 10, 0],
    [0, 10, 0],
    [0, 0, 2],
    [length, 0, 2],
    [length, 10, 2],
    [0, 10, 2],
  ];
  const faces = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [3, 7, 6],
    [3, 6, 2],
    [0, 4, 7],
    [0, 7, 3],
    [1, 2, 6],
    [1, 6, 5],
  ];
  return writeBinaryStl(Float64Array.from(faces.flatMap((f) => f.flatMap((v) => vertices[v]!))));
}

function fakeCad(onRender?: () => void): CadAdapter {
  return {
    toolId: 'openscad',
    async probe() {
      return { available: true, executablePath: '/bin/true', version: 'test' };
    },
    async validateSource() {
      return { ok: true, errors: [] };
    },
    async render(spec) {
      onRender?.();
      if (onRender) await new Promise((r) => setTimeout(r, 30));
      fs.writeFileSync(spec.outPath, boxStl(Number(spec.params.length ?? 10)));
      return { ok: true };
    },
    cancel() {},
    inspectStl(buf) {
      const mesh = analyzeMesh(parseStlTriangles(buf));
      return {
        triangles: mesh.triangles,
        bytes: buf.byteLength,
        format: 'binary' as const,
        bounds: mesh.bounds,
        plausible: mesh.topology.watertight,
      };
    },
  };
}

async function project(onRender?: () => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omen-work-identity-'));
  const app = new CoreApp(path.join(dir, 'appdata'), nullHost);
  apps.push(app);
  app.engineTools = { cad: fakeCad(onRender) };
  const created = (await app.dispatch(
    'project.create',
    { name: 'Work', path: path.join(dir, 'p') },
    user,
  )) as { projectId: string };
  const ctx = app.contextFor(created.projectId);
  ctx.tools = app.engineTools;
  const call = <T>(op: string, payload: unknown) =>
    app.dispatch(op, payload, user, created.projectId) as Promise<T>;
  return { app, ctx, call };
}

describe('request-bound work identity', () => {
  it('requires the checked output hash to match the stored revision, even for identical inputs', async () => {
    const { ctx, call } = await project();
    const part = await call<CadReport>('cad.write_source', { title: 'Block', source: 'cube(10);' });
    const revision = ctx.requireRevision(part.revisionId);
    const identity = (revision.payload as MechanicalPayload).renderIdentity!;
    const evidence = createCadVerificationEvidence(
      ctx,
      revision,
      { ...identity, outputHash: 'a'.repeat(64) },
      { shells: 1 },
      [{ name: 'single body', pass: true, detail: '1 shell' }],
      { pass: true, detail: 'valid mesh' },
    );
    expect(evidence.pass).toBe(true);
    expect(evidence.status).toBe('unverified');
  });

  it('does not certify inverted source after display normalization, cache reuse or legacy reopen', async () => {
    const { ctx, call } = await project();
    const original = ctx.tools.cad!;
    let renders = 0;
    ctx.tools.cad = {
      ...original,
      async render(spec, onLog) {
        renders++;
        const result = await original.render(spec, onLog);
        if (fs.readFileSync(spec.scadPath, 'utf8').includes('INVERTED')) {
          const tris = parseStlTriangles(fs.readFileSync(spec.outPath));
          for (let i = 0; i < tris.length; i += 9)
            for (let axis = 0; axis < 3; axis++) {
              const at = i + 3 + axis;
              [tris[at], tris[at + 3]] = [tris[at + 3]!, tris[at]!];
            }
          fs.writeFileSync(spec.outPath, writeBinaryStl(tris));
        }
        return result;
      },
    };
    const source = '// INVERTED\ncube(10);';
    let part = await call<CadReport>('cad.write_source', { title: 'Inverted', source });
    expect(part.notes.join(' ')).toContain('NOT VERIFIED');
    const expectBox = { shells: 1, bbox: { min: [0, 0, 0], max: [10, 10, 2] } };
    const check = () =>
      call<{ ready: boolean; verificationStatus: string }>('cad.check', {
        artifactId: part.artifactId,
        expect: expectBox,
      });
    expect(await check()).toMatchObject({ ready: false, verificationStatus: 'failed' });
    part = await call<CadReport>('cad.write_source', { artifactId: part.artifactId, source });
    expect(renders).toBe(1);
    expect(part.notes.join(' ')).toContain('NOT VERIFIED');
    expect(await check()).toMatchObject({ ready: false, verificationStatus: 'failed' });

    // Older stored renders/cache manifests lack the original winding flag. They
    // must be rendered again, not assumed valid because their display STL is outward.
    const rev = ctx.requireRevision(part.revisionId);
    const legacy = JSON.parse(JSON.stringify(rev.payload));
    delete legacy.renderIdentity.sourceOrientationCorrected;
    ctx.repo.db
      .prepare('UPDATE revision SET payload=? WHERE id=?')
      .run(JSON.stringify(legacy), rev.id);
    const manifest = ctx.resolvePath(
      `.omenflow/cache/render-v1/${legacy.renderIdentity.inputFingerprint}/complete.json`,
    );
    const cache = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    delete cache.sourceOrientationCorrected;
    fs.writeFileSync(manifest, JSON.stringify(cache));
    expect(await check()).toMatchObject({ ready: false, verificationStatus: 'failed' });
    expect(renders).toBe(2);
    expect(latestCadVerification(ctx, ctx.requireRevision(part.revisionId)).status).toBe('failed');

    part = await call<CadReport>('cad.write_source', {
      artifactId: part.artifactId,
      source: 'cube(10);',
    });
    expect(await check()).toMatchObject({ ready: true, verificationStatus: 'passed' });
  });

  it('requires rechecking evidence from the retired geometry checker', async () => {
    const { ctx, call } = await project();
    const part = await call<CadReport>('cad.write_source', { title: 'Block', source: 'cube(10);' });
    const spec = {
      artifactId: part.artifactId,
      expect: { shells: 1, bbox: { min: [0, 0, 0], max: [10, 10, 2] } },
    };
    await call('cad.check', spec);
    const revision = ctx.requireRevision(part.revisionId);
    const current = latestCadVerification(ctx, revision);
    expect(current.status).toBe('passed');
    const retired = ctx.storeContent(
      JSON.stringify({ ...current.evidence, checkerVersion: 'omenflow-mesh-checks-v2' }),
    );
    const job = ctx.repo.listJobs().find((j) => j.kind === 'cad_check')!;
    ctx.repo.updateJob(job.id, { outputHashes: { ...job.outputHashes, verification: retired } });
    expect(latestCadVerification(ctx, revision).status).toBe('unverified');
    await call('cad.check', spec);
    expect(latestCadVerification(ctx, revision).status).toBe('passed');
    expect(ctx.objects.has(retired)).toBe(true);
  });

  it('cancels a running verification worker without publishing evidence or active work', async () => {
    const { ctx, call } = await project();
    const written = await call<CadReport>('cad.write_source', {
      title: 'Block',
      source: 'cube(10);',
    });
    const pending = call('cad.check', {
      artifactId: written.artifactId,
      expect: { shells: 1, bbox: { min: [0, 0, 0], max: [10, 10, 2] } },
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const job = ctx.repo.listJobs().find((j) => j.kind === 'cad_check');
    expect(job?.status).toBe('running');
    ctx.cancelJob(job!.id);
    await rejected;
    expect(ctx.repo.getJob(job!.id)?.status).toBe('cancelled');
    expect(ctx.repo.getJob(job!.id)?.outputHashes).toEqual({});
    expect(readActiveWork(ctx)).toBeNull();
    expect(latestCadVerification(ctx, ctx.requireRevision(written.revisionId)).status).toBe(
      'unverified',
    );
  });

  it('binds committed assertions and ignores exploratory diagnostics', async () => {
    const { ctx, call } = await project();
    const written = await call<CadReport>('cad.write_source', {
      title: 'Block',
      source: 'cube(10);',
    });
    const committed = await call<{
      ready: boolean;
      verificationStatus: string;
      work: { nextAction: string; specHash: string };
    }>('cad.check', {
      artifactId: written.artifactId,
      expect: { shells: 1, bbox: { min: [0, 0, 0], max: [10, 10, 2], tol: 0.5 } },
    });
    expect(committed.verificationStatus).toBe('passed');
    expect(committed.ready).toBe(true);
    expect(committed.work.nextAction).toBe('request_review');
    expect(committed.work.specHash).toBeTruthy();
    const exploratory = await call<{
      ready: boolean;
      verificationStatus: string;
      exploratory?: boolean;
      work: { nextAction: string; specHash: string };
    }>('cad.check', {
      artifactId: written.artifactId,
      exploratory: true,
      expect: { shells: 1 },
    });
    expect(exploratory.exploratory).toBe(true);
    expect(exploratory.ready).toBe(false);
    expect(exploratory.work.specHash).toBe(committed.work.specHash);
    expect(exploratory.work.nextAction).toBe('commit_assertions');
    expect(latestCadVerification(ctx, ctx.requireRevision(written.revisionId)).status).toBe(
      'passed',
    );
    const dropped = await call<{
      ready: boolean;
      pass: boolean;
      next: string;
      verificationStatus: string;
      work: { nextAction: string };
    }>('cad.check', {
      artifactId: written.artifactId,
      expect: { shells: 1 },
    });
    expect(dropped.verificationStatus).toBe('scope_changed');
    expect(dropped.ready).toBe(false);
    expect(dropped.pass).toBe(true); // legacy per-assertion result is still available
    expect(dropped.next).toContain('NOT VERIFIED');
    expect(dropped.work.nextAction).toBe('restore_assertions');
    expect(readActiveWork(ctx)?.specHash).toBe(committed.work.specHash);
  });
});

describe('identical render sharing', () => {
  it('runs OpenSCAD once for concurrent identical source', async () => {
    let renders = 0;
    const { call } = await project(() => {
      renders++;
    });
    const [a, b] = await Promise.all([
      call<CadReport>('cad.write_source', { title: 'A', source: 'cube(10);' }),
      call<CadReport>('cad.write_source', { title: 'B', source: 'cube(10);' }),
    ]);
    expect(a.render.ok).toBe(true);
    expect(b.render.ok).toBe(true);
    expect(renders).toBe(1);
  });
});

describe('two live projects with delayed calculations', () => {
  it('keeps delayed results on the originating project', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omen-two-projects-'));
    const app = new CoreApp(path.join(dir, 'appdata'), nullHost);
    apps.push(app);
    const slow = (value: number, ms: number) => ({
      templates: () => [],
      evaluate: async () => {
        await new Promise((r) => setTimeout(r, ms));
        return { value, unit: 'kg' };
      },
    });
    const a = (await app.dispatch(
      'project.create',
      { name: 'A', path: path.join(dir, 'a') },
      user,
    )) as { projectId: string };
    const b = (await app.dispatch(
      'project.create',
      { name: 'B', path: path.join(dir, 'b') },
      user,
    )) as { projectId: string };
    app.contextFor(a.projectId).tools.calc = slow(11, 40);
    app.contextFor(b.projectId).tools.calc = slow(22, 5);
    const payload = (n: number) => ({
      expression: String(n),
      inputs: [{ name: 'x', quantity: { value: n, unit: 'kg' }, literal: true }],
      submitForReview: false,
      title: `calc-${n}`,
    });
    const [ra, rb] = await Promise.all([
      app.dispatch('calculation.run', payload(11), user, a.projectId) as Promise<{
        result: { value: number };
      }>,
      app.dispatch('calculation.run', payload(22), user, b.projectId) as Promise<{
        result: { value: number };
      }>,
    ]);
    expect(ra.result.value).toBe(11);
    expect(rb.result.value).toBe(22);
    expect(app.contextFor(a.projectId).repo.listArtifacts()).toHaveLength(1);
    expect(app.contextFor(b.projectId).repo.listArtifacts()).toHaveLength(1);
    expect(app.contextFor(a.projectId).repo.listArtifacts()[0]?.title).toBe('calc-11');
    expect(app.contextFor(b.projectId).repo.listArtifacts()[0]?.title).toBe('calc-22');
  });
});
