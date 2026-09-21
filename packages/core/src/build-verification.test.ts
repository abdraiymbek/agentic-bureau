import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { createProject } from '@omenflow/storage';
import { type MechanicalPayload, type Revision } from '@omenflow/contracts';
import { createDraft } from './artifacts.js';
import { ProjectContext, nullHost } from './context.js';
import { buildPreview, exportBuildPackage } from './build.js';
import { createCadVerificationEvidence } from './cad-verification.js';
import { renderFingerprint } from './cad-input.js';

const roots: string[] = [];
const handles: ReturnType<typeof createProject>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(select = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omenflow-build-test-'));
  roots.push(root);
  const handle = createProject(path.join(root, 'project'), 'Build', 'fixture');
  handles.push(handle);
  const ctx = new ProjectContext(handle, nullHost);
  const source = Buffer.from('cube(10);');
  // This tests evidence/packaging semantics. Mesh validity is covered by real CAD tests.
  const mesh = Buffer.from('synthetic mesh bytes');
  const sourceHash = ctx.objects.put(source);
  const outputHash = ctx.objects.put(mesh);
  const identityBase = {
    version: 1 as const,
    sourceHash,
    outputHash,
    params: {},
    modelUnit: 'mm',
    frame: 'right-handed-z-up' as const,
    engine: 'fixture',
    engineVersion: '1',
    options: 'fixture',
  };
  const renderIdentity = { ...identityBase, inputFingerprint: renderFingerprint(identityBase) };
  const result = createDraft(
    ctx,
    {
      type: 'mechanical',
      title: 'Part',
      payload: {
        params: {},
        modelUnit: 'mm',
        scad: { path: 'artifacts/mechanical/part.scad', sha256: sourceHash },
        stl: { path: 'artifacts/mechanical/part.stl', sha256: outputHash },
        renderIdentity,
      },
      files: [
        { path: 'artifacts/mechanical/part.scad', contentBase64: source.toString('base64') },
        { path: 'artifacts/mechanical/part.stl', contentBase64: mesh.toString('base64') },
      ],
      inputs: [],
      rationale: 'fixture',
    },
    { kind: 'user' },
  );
  if (select) ctx.repo.setSelectedRevision(result.artifact.id, result.revision.id);
  return { root, ctx, ...result };
}
function certify(ctx: ProjectContext, revision: Revision) {
  const expectSpec = { bbox: { min: [0, 0, 0], max: [10, 10, 10] } };
  const evidence = createCadVerificationEvidence(
    ctx,
    revision,
    (revision.payload as MechanicalPayload).renderIdentity!,
    expectSpec,
    [{ name: 'bounding box', pass: true, detail: 'fixture' }],
    { pass: true, detail: 'analytic valid cube fixture' },
  );
  const hash = ctx.objects.putText(JSON.stringify(evidence));
  const job = ctx.createJob({
    kind: 'cad_check',
    tool: 'cad.check',
    inputs: { artifactId: revision.artifactId, revisionId: revision.id, expect: expectSpec },
  });
  ctx.jobStatus(job.id, 'succeeded', { outputHashes: { verification: hash } });
}

describe('build readiness is bound to revision evidence', () => {
  it('keeps unverified geometry out of ready counts and labels explicit raw export', async () => {
    const { root, ctx, revision } = fixture();
    const preview = buildPreview(ctx);
    expect(preview.counts.ready).toBe(0);
    expect(preview.items[0]!.verification?.status).toBe('unverified');
    const destPath = path.join(root, 'raw.zip');
    await expect(
      exportBuildPackage(ctx, { destPath, includeDrafts: false }, { kind: 'user' }),
    ).rejects.toThrow(/unresolved/);
    const raw = await exportBuildPackage(ctx, { destPath, includeDrafts: true }, { kind: 'user' });
    expect(raw.status).toBe('draft');
    const manifest = JSON.parse(
      Buffer.from(unzipSync(fs.readFileSync(destPath))['manifest.json']!).toString(),
    );
    expect(manifest.artifacts[0].revisionId).toBe(revision.id);
    expect(manifest.artifacts[0].payload.renderIdentity).toEqual(
      (revision.payload as MechanicalPayload).renderIdentity,
    );
    expect(manifest.artifacts[0].verification.status).toBe('unverified');
    expect(manifest.verificationScope).toContain('declared geometric assertions');
  });

  it('requires exact current evidence and immutable output bytes', () => {
    const { ctx, revision } = fixture();
    certify(ctx, revision);
    expect(buildPreview(ctx).counts.ready).toBe(1);
    const meshHash = (revision.payload as MechanicalPayload).stl!.sha256!;
    fs.chmodSync(ctx.objects.absPath(meshHash), 0o644);
    fs.writeFileSync(ctx.objects.absPath(meshHash), 'corrupt');
    const preview = buildPreview(ctx);
    expect(preview.counts.ready).toBe(0);
    expect(preview.items[0]!.issues.some((i) => i.includes('corrupt'))).toBe(true);
  });

  it('includes a candidate when draft export is explicitly requested', async () => {
    const { root, ctx, revision } = fixture(false);
    const destPath = path.join(root, 'candidate.zip');
    await exportBuildPackage(ctx, { destPath, includeDrafts: true }, { kind: 'user' });
    const entries = unzipSync(fs.readFileSync(destPath));
    const manifest = JSON.parse(Buffer.from(entries['manifest.json']!).toString());
    expect(manifest.status).toBe('draft');
    expect(manifest.artifacts[0].revisionId).toBe(revision.id);
    expect(manifest.artifacts[0].selected).toBe(false);
    expect(entries['files/artifacts/mechanical/part.scad']).toBeTruthy();
  });
});
