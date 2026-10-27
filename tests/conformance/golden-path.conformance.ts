/**
 * `tests/golden-path.test.ts` against the Rust host: the plan's reference flow
 * driven through dispatch — fixture builders, then the 300 g → 500 g payload
 * change with impact-path inspection, reopen persistence, and archive export.
 * Assertions are the originals. A case the Rust core does not yet satisfy is
 * marked `it.fails` with the divergence it names.
 */
import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Origin } from '@bureau/contracts';
import { RustCore } from './rust-core';
import { buildRoverProject } from '../../fixtures/rover/rover.fixture';
import { buildDroneProject } from '../../fixtures/drone-dependencies/drone.fixture';

const USER: Origin = { kind: 'user' };
const AGENT: Origin = { kind: 'agent', sessionId: '00000000-0000-4000-8000-00000000a001' };

const apps: RustCore[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.closeAll();
});

async function makeApp(dir: string): Promise<RustCore> {
  const app = await RustCore.start(path.join(dir, '.appdata'));
  apps.push(app);
  return app;
}

describe('rover fixture builds a coherent project', () => {
  it('creates requirements, selected components, BOM, calcs, wiring, test', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-gp-'));
    const app = await makeApp(dir);
    const refs = await buildRoverProject(app, path.join(dir, 'rover'));

    const call = (op: string, payload: unknown = {}) =>
      app.dispatch(op, payload, USER, refs.projectId) as Promise<Record<string, any>>;

    // All baseline artifacts exist and are current.
    const list = await call('artifact.list');
    const byId = new Map<string, any>(list.artifacts.map((v: any) => [v.artifact.id, v]));
    for (const key of ['payloadReq', 'massCalc', 'torqueCalc', 'wiring', 'payloadTest'] as const) {
      const v = byId.get(refs[key].artifactId);
      expect(v, key).toBeTruthy();
      expect(v.freshness, key).toBe('current');
      expect(v.revision.reviewState).toBe('approved');
    }

    // BOM has real lines and known mass/cost totals.
    const bom = await call('bom.read');
    expect(bom.lines.length).toBeGreaterThanOrEqual(6);
    const usd = bom.totals.cost.find((m: any) => m.currency === 'USD');
    expect(parseFloat(usd.amount)).toBeCloseTo(113.75, 1);
    expect(bom.totals.knownMass.value).toBeCloseTo(0.0795, 3);
    expect(bom.totals.missingPriceCount).toBe(0);

    // The calculation engine produced real unit-correct results.
    const mass = await call('artifact.read', { artifactId: refs.massCalc.artifactId });
    const massResult = (mass.revision.payload as any).result.quantity;
    expect(massResult.unit).toBe('kg');
    expect(massResult.value).toBeCloseTo(0.505, 2); // 0.3 + 0.12 + 0.045 + 0.04

    const torque = await call('artifact.read', { artifactId: refs.torqueCalc.artifactId });
    const tq = (torque.revision.payload as any).result.quantity;
    expect(tq.unit).toBe('N*m');
    expect(tq.value).toBeGreaterThan(0.04); // 0.505 kg × g × (sin15° + a/g) × 0.03 m ≈ 0.046 N·m

    // Wiring validation produces a deterministic findings report.
    const wiring = await call('wiring.validate', { artifactId: refs.wiring.artifactId });
    expect(wiring).toHaveProperty('findings');
    expect(Array.isArray(wiring.findings)).toBe(true);
  });
});

describe('300 g → 500 g payload change', () => {
  it('propagates stale through calcs, CAD and test without erasing results', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-gp-'));
    const app = await makeApp(dir);
    const refs = await buildRoverProject(app, path.join(dir, 'rover'));
    const call = (op: string, payload: unknown = {}) =>
      app.dispatch(op, payload, USER, refs.projectId) as Promise<Record<string, any>>;

    // Record pre-change results so we can prove history survives.
    const before = await call('artifact.read', { artifactId: refs.massCalc.artifactId });
    const beforeValue = (before.revision.payload as any).result.quantity.value;

    // User changes the payload requirement to 500 g via direct edit.
    await call('artifact.apply_edit', {
      artifactId: refs.payloadReq.artifactId,
      baseRevisionId: refs.payloadReq.revisionId,
      payloadPatch: { target: { value: 0.5, unit: 'kg' } },
      rationale: 'customer asked for a heavier sensor pack',
    });

    // Impact report covers every artifact reachable through depends_on.
    const newRev = (await call('artifact.read', { artifactId: refs.payloadReq.artifactId }))
      .revision.id;
    const impact = await call('graph.impact', {
      refs: [{ artifactId: refs.payloadReq.artifactId, revisionId: newRev }],
    });
    const affected = new Set(impact.affected.map((a: any) => a.artifactId));
    expect(affected).toContain(refs.massCalc.artifactId);
    expect(affected).toContain(refs.mechanical.artifactId);
    expect(affected).toContain(refs.payloadTest.artifactId);
    // torque depends on massCalc which depends on the requirement — 2 hops.
    expect(affected).toContain(refs.torqueCalc.artifactId);
    for (const a of impact.affected) expect(a.path.length).toBeGreaterThanOrEqual(1);

    // Stale is visible; the old results are preserved, not erased.
    const list = await call('artifact.list');
    const massView = list.artifacts.find((v: any) => v.artifact.id === refs.massCalc.artifactId);
    expect(massView.freshness).toBe('stale');
    const massAfter = await call('artifact.read', { artifactId: refs.massCalc.artifactId });
    expect((massAfter.revision.payload as any).result.quantity.value).toBe(beforeValue);

    // Reopen: staleness and revisions survive process shutdown.
    await app.closeAll();
    apps.pop();
    const app2 = await makeApp(dir);
    const opened = (await app2.dispatch('project.open', { path: refs.dir }, USER)) as {
      projectId: string;
    };
    expect(opened.projectId).toBe(refs.projectId);
    const list2 = (await app2.dispatch('artifact.list', {}, USER, refs.projectId)) as any;
    const massView2 = list2.artifacts.find((v: any) => v.artifact.id === refs.massCalc.artifactId);
    expect(massView2.freshness).toBe('stale');
  });

  it('agents cannot self-approve: proposal flow enforced on the changed requirement', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-gp-'));
    const app = await makeApp(dir);
    const refs = await buildRoverProject(app, path.join(dir, 'rover'));

    // Agent drafts a new requirement revision — becomes a proposal, not baseline.
    const draft = (await app.dispatch(
      'artifact.update_draft',
      {
        artifactId: refs.payloadReq.artifactId,
        baseRevisionId: refs.payloadReq.revisionId,
        payloadPatch: undefined,
        payload: {
          statement: 'The rover shall carry a removable payload pack without loss of mobility.',
          target: { value: 0.5, unit: 'kg' },
          acceptanceCriterion:
            'Traverses a 15° ramp at ≥0.5 m/s carrying the payload; no slip or stall.',
          priority: 'must',
          verification: 'Ramp test with instrumented payload mass',
        },
        rationale: 'payload increase to 500 g',
      },
      AGENT,
      refs.projectId,
    )) as { revision: { id: string } };
    const proposal = (await app.dispatch(
      'proposal.submit',
      {
        changes: [
          {
            artifactId: refs.payloadReq.artifactId,
            baseRevisionId: refs.payloadReq.revisionId,
            newRevisionId: draft.revision.id,
            kind: 'baseline_update',
          },
        ],
        reason: 'raise payload to 500 g',
      },
      AGENT,
      refs.projectId,
    )) as { id: string };

    // Baseline is still 300 g until a human approves.
    const still = (await app.dispatch(
      'artifact.read',
      { artifactId: refs.payloadReq.artifactId },
      USER,
      refs.projectId,
    )) as any;
    expect(still.revision.payload.target.value).toBe(0.3);

    // The agent session itself cannot approve its own proposal.
    await expect(
      app.dispatch('proposal.approve', { proposalId: proposal.id }, AGENT, refs.projectId),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    await app.dispatch(
      'proposal.approve',
      { proposalId: proposal.id, rationale: 'scope change approved' },
      USER,
      refs.projectId,
    );
    const after = (await app.dispatch(
      'artifact.read',
      { artifactId: refs.payloadReq.artifactId },
      USER,
      refs.projectId,
    )) as any;
    expect(after.revision.payload.target.value).toBe(0.5);
  });
});

describe('archive export', () => {
  // DIVERGENCE: the Rust core writes no readable views (artifacts/<type>/<slug>.md|json), so the archive holds 7 files where the TypeScript core's holds more than 10.
  it.fails('exports a portable project archive and reimports it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-gp-'));
    const app = await makeApp(dir);
    const refs = await buildRoverProject(app, path.join(dir, 'rover'));

    const archive = path.join(dir, 'rover.bureaupack.zip');
    const res = (await app.dispatch(
      'project.export_archive',
      { destPath: archive },
      USER,
      refs.projectId,
    )) as any;
    expect(fs.existsSync(archive)).toBe(true);
    expect(res.files).toBeGreaterThan(10);

    const imported = (await app.dispatch(
      'project.import_archive',
      {
        archivePath: archive,
        destDir: path.join(dir, 'rover-copy'),
        newIdentity: true,
      },
      USER,
    )) as { projectId: string };
    const list = (await app.dispatch('artifact.list', {}, USER, imported.projectId)) as any;
    expect(list.artifacts.length).toBeGreaterThanOrEqual(10);
    // Mechanical artifact carried its .scad file through the archive.
    const mech = list.artifacts.find((v: any) => v.artifact.id === refs.mechanical.artifactId);
    expect(mech).toBeTruthy();
    const file = (await app.dispatch(
      'artifact.read_file',
      {
        artifactId: refs.mechanical.artifactId,
        path: 'artifacts/mechanical/camera-tray.scad',
      },
      USER,
      imported.projectId,
    )) as any;
    expect(Buffer.from(file.contentBase64, 'base64').toString('utf8')).toContain('tray_width');
  });

  // Not in the original: the round trip itself, kept under test while the case above is an expected failure.
  it('reimports an exported archive with its artifacts and source files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-gp-'));
    const app = await makeApp(dir);
    const refs = await buildRoverProject(app, path.join(dir, 'rover'));
    const original = (await app.dispatch('artifact.list', {}, USER, refs.projectId)) as any;

    const archive = path.join(dir, 'rover.bureaupack.zip');
    await app.dispatch('project.export_archive', { destPath: archive }, USER, refs.projectId);
    expect(fs.existsSync(archive)).toBe(true);
    const imported = (await app.dispatch(
      'project.import_archive',
      { archivePath: archive, destDir: path.join(dir, 'rover-copy'), newIdentity: true },
      USER,
    )) as { projectId: string };
    expect(imported.projectId).not.toBe(refs.projectId);

    const list = (await app.dispatch('artifact.list', {}, USER, imported.projectId)) as any;
    expect(list.artifacts.map((v: any) => v.artifact.id).sort()).toEqual(
      original.artifacts.map((v: any) => v.artifact.id).sort(),
    );
    const file = (await app.dispatch(
      'artifact.read_file',
      { artifactId: refs.mechanical.artifactId, path: 'artifacts/mechanical/camera-tray.scad' },
      USER,
      imported.projectId,
    )) as any;
    expect(Buffer.from(file.contentBase64, 'base64').toString('utf8')).toContain('tray_width');
  });
});

describe('drone dependency fixture', () => {
  it('payload requirement propagates into propulsion + endurance chain', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-gp-'));
    const app = await makeApp(dir);
    const refs = await buildDroneProject(app, path.join(dir, 'drone'));

    // Baseline check: propulsion and endurance ran with real calculated results.
    const prop = (await app.dispatch(
      'artifact.read',
      { artifactId: refs.propulsionCalc.artifactId },
      USER,
      refs.projectId,
    )) as any;
    expect((prop.revision.payload as any).result.quantity.unit).toBe('kg');
    const endu = (await app.dispatch(
      'artifact.read',
      { artifactId: refs.enduranceCalc.artifactId },
      USER,
      refs.projectId,
    )) as any;
    expect((endu.revision.payload as any).result.quantity.unit).toBe('h');

    await app.dispatch(
      'artifact.apply_edit',
      {
        artifactId: refs.payloadReq.artifactId,
        baseRevisionId: refs.payloadReq.revisionId,
        payloadPatch: { target: { value: 0.5, unit: 'kg' } },
        rationale: 'heavier survey head',
      },
      USER,
      refs.projectId,
    );

    const newRev = (
      (await app.dispatch(
        'artifact.read',
        { artifactId: refs.payloadReq.artifactId },
        USER,
        refs.projectId,
      )) as any
    ).revision.id;
    const impact = (await app.dispatch(
      'graph.impact',
      {
        refs: [{ artifactId: refs.payloadReq.artifactId, revisionId: newRev }],
      },
      USER,
      refs.projectId,
    )) as any;
    const affected = new Set(impact.affected.map((a: any) => a.artifactId));
    expect(affected).toContain(refs.propulsionCalc.artifactId);
    expect(affected).toContain(refs.enduranceCalc.artifactId);
  });
});
