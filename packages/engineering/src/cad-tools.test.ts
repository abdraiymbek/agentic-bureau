import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Origin } from '@omenflow/contracts';
import { CoreApp, nullHost, type CadReport } from '@omenflow/core';
import { createEngineTools, OpenScadAdapter } from './index.js';

/**
 * Agent-facing CAD vocabulary (cad.write_source / read_source / inspect /
 * check) against real OpenSCAD. Skipped when OpenSCAD is not installed.
 */
const AGENT: Origin = { kind: 'agent', sessionId: '00000000-0000-4000-8000-00000000c0de' };
let available = false;
const apps: CoreApp[] = [];

beforeAll(async () => {
  available = (await new OpenScadAdapter().probe()).available;
});
afterEach(() => {
  for (const a of apps.splice(0)) a.closeAll();
});

async function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omenflow-cadtools-'));
  const app = new CoreApp(path.join(dir, 'appdata'), nullHost);
  app.engineTools = createEngineTools();
  apps.push(app);
  const created = (await app.dispatch(
    'project.create',
    { name: 'cad tools', path: path.join(dir, 'p'), intent: '' },
    { kind: 'user' },
  )) as { projectId: string };
  const call = <T = Record<string, any>>(op: string, payload: unknown) =>
    app.dispatch(op, payload, AGENT, created.projectId) as Promise<T>;
  return { app, projectId: created.projectId, call, root: path.join(dir, 'p') };
}

const PLATE = `// plate with one hole\nw = 100; d = 40; t = 6; hole_d = 8;\n$fn = 64;\ndifference(){ cube([w,d,t]); translate([w/2,d/2,-1]) cylinder(d=hole_d, h=t+2); }\n`;

describe.skipIf(
  !fs.existsSync('/Applications/OpenSCAD.app') && !fs.existsSync('/usr/bin/openscad'),
)('cad.write_source / inspect / check / read_source', () => {
  it('write_source renders and reports measured geometry in one call', async () => {
    if (!available) return;
    const { call, root } = await project();
    const r = await call<CadReport>('cad.write_source', { title: 'Plate', source: PLATE });
    expect(r.render.ok).toBe(true);
    expect(r.geometry?.bounds.max).toEqual([100, 40, 6]);
    expect(r.geometry?.watertight).toBe(true);
    expect(r.geometry?.shells).toBe(1);
    expect(r.parameters.map((p) => p.name)).toEqual(['w', 'd', 't', 'hole_d', '$fn']);
    const mid = r.sections!.find((s) => s.plane.startsWith('z='))!;
    expect(mid.loops.some((l) => l.includes('cut-out circle d=8'))).toBe(true);
    expect(mid.loops.some((l) => l.includes('rectangle 100×40'))).toBe(true);
    // Source and render are materialized as working files, no conflict litter.
    expect(fs.existsSync(path.join(root, 'artifacts/mechanical/plate.scad'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'artifacts/mechanical/plate.stl'))).toBe(true);
    expect(
      fs.readdirSync(path.join(root, 'artifacts/mechanical')).filter((f) => f.includes('conflict')),
    ).toEqual([]);
  });

  it('check passes correct expectations and fails wrong ones with measured values', async () => {
    if (!available) return;
    const { call } = await project();
    const w = await call<CadReport>('cad.write_source', { title: 'Plate', source: PLATE });
    const ok = await call('cad.check', {
      artifactId: w.artifactId,
      expect: {
        bbox: { min: [0, 0, 0], max: [100, 40, 6] },
        sections: [{ axis: 'z', at: 3, holeCount: 1, holes: [{ center: [50, 20], d: 8 }] }],
        empty: [[50, 20, 3]],
        shells: 1,
      },
    });
    expect(ok.pass).toBe(true);
    const bad = await call('cad.check', {
      artifactId: w.artifactId,
      expect: { sections: [{ axis: 'z', at: 3, holes: [{ center: [50, 20], d: 10 }] }] },
    });
    expect(bad.pass).toBe(false);
    expect(bad.checks[1].detail).toContain('DIAMETER off by -2');
  });

  it('flags checks that drop assertions which failed on the same geometry', async () => {
    if (!available) return;
    const { call } = await project();
    const w = await call<CadReport>('cad.write_source', { title: 'Plate', source: PLATE });
    const first = await call('cad.check', {
      artifactId: w.artifactId,
      expect: {
        bbox: { min: [0, 0, 0], max: [100, 40, 6] },
        sections: [{ axis: 'z', at: 3, holes: [{ center: [50, 20], d: 10 }] }],
      },
    });
    expect(first.pass).toBe(false);
    const second = await call('cad.check', {
      artifactId: w.artifactId,
      expect: { bbox: { min: [0, 0, 0], max: [100, 40, 6] } },
    });
    expect(second.pass).toBe(true);
    expect(second.droppedFailingAssertions).toEqual(['section z=3: hole d10 at (x=50, y=20)']);
    expect(second.next).toMatch(/WARNING — this run dropped 1 assertion/);
  });

  it('revising writes a new draft on the same artifact; read_source returns plain text', async () => {
    if (!available) return;
    const { call } = await project();
    const w = await call<CadReport>('cad.write_source', { title: 'Plate', source: PLATE });
    const src = await call('cad.read_source', { artifactId: w.artifactId });
    expect(src.source).toBe(PLATE);
    expect(src.parameters.find((p: any) => p.name === 'hole_d').value).toBe(8);
    const w2 = await call<CadReport>('cad.write_source', {
      artifactId: w.artifactId,
      source: PLATE.replace('hole_d = 8', 'hole_d = 10'),
      rationale: 'bigger hole',
    });
    expect(w2.artifactId).toBe(w.artifactId);
    expect(w2.revisionId).not.toBe(w.revisionId);
    const list = await call('artifact.list', { type: 'mechanical' });
    expect(list.artifacts.length).toBe(1);
    // The project watcher must not re-import our own overwritten working
    // files as phantom "external edit" revisions (debounce is 300 ms).
    await new Promise((r) => setTimeout(r, 900));
    const hist = await call('artifact.history', { artifactId: w.artifactId });
    expect(hist.revisions.length).toBe(2);
    expect(hist.revisions[1].parentId).toBe(w.revisionId);
    const latest = await call('cad.read_source', { artifactId: w.artifactId });
    expect(latest.revisionId).toBe(w2.revisionId);
    expect(latest.source).toContain('hole_d = 10');
  });

  it('inspect answers sections/probes and re-renders parameter variants without committing', async () => {
    if (!available) return;
    const { call } = await project();
    const w = await call<CadReport>('cad.write_source', { title: 'Plate', source: PLATE });
    const i = await call<CadReport>('cad.inspect', {
      artifactId: w.artifactId,
      params: { w: 120 },
      sections: [{ axis: 'x', at: 60 }],
      probes: [
        [60, 20, 3],
        [10, 10, 3],
      ],
    });
    expect(i.geometry?.bounds.max[0]).toBe(120);
    expect(i.probes).toEqual([
      { point: [60, 20, 3], result: 'empty' },
      { point: [10, 10, 3], result: 'solid' },
    ]);
    expect(i.sections!.some((s) => s.plane.startsWith('x=60'))).toBe(true);
    const hist = await call('artifact.history', { artifactId: w.artifactId });
    expect(hist.revisions.length).toBe(1);
  });

  it('rejects unknown parameters with the list of declared ones', async () => {
    if (!available) return;
    const { call } = await project();
    await expect(
      call('cad.write_source', { title: 'Plate', source: PLATE, params: { width: 5 } }),
    ).rejects.toThrow(/Unknown parameter: width.*w, d, t, hole_d/);
  });

  it('reports render failure structurally instead of throwing away the source', async () => {
    if (!available) return;
    const { call } = await project();
    const r = await call<CadReport>('cad.write_source', {
      title: 'Broken',
      source: 'difference(){ cube(10); translate([-1,-1,-1]) cube(12); }',
    });
    expect(r.render.ok).toBe(false);
    expect(r.render.error).toMatch(/no geometry|empty/i);
    const typo = await call<CadReport>('cad.write_source', {
      title: 'Typo',
      source: 'size_x = 10;\ncube([size_x, sizey, 5]);',
    });
    expect(typo.render.warnings.some((w) => /sizey/.test(w))).toBe(true);
  });
});
