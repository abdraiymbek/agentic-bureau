import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenScadAdapter } from './openscad.js';
import {
  analyzeMesh,
  containsPoint,
  countIntersectingPairs,
  crossSection,
  parseStlTriangles,
  type TriangleBuffer,
} from '@omenflow/core';

/**
 * Mesh analysis is validated against real OpenSCAD renders of shapes with
 * closed-form answers. Skipped when OpenSCAD is not installed.
 */
const adapter = new OpenScadAdapter();
let exe: string | null = null;
let dir: string;

function render(scad: string): TriangleBuffer {
  const src = path.join(dir, `${Math.random().toString(36).slice(2)}.scad`);
  const out = src.replace(/\.scad$/, '.stl');
  fs.writeFileSync(src, scad);
  execFileSync(exe!, ['-o', out, '--export-format', 'binstl', src], { stdio: 'ignore' });
  return parseStlTriangles(fs.readFileSync(out));
}

beforeAll(async () => {
  const probe = await adapter.probe();
  exe = probe.available ? probe.executablePath : null;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omenflow-mesh-'));
});

describe.skipIf(
  !process.env.CI &&
    !fs.existsSync('/Applications/OpenSCAD.app') &&
    !fs.existsSync('/usr/bin/openscad'),
)('mesh analysis on OpenSCAD renders', () => {
  it('cube: bounds, volume, area, watertight', () => {
    if (!exe) return;
    const r = analyzeMesh(render('cube([10,20,30]);'));
    expect(r.bounds.min).toEqual([0, 0, 0]);
    expect(r.bounds.max).toEqual([10, 20, 30]);
    expect(r.volume).toBeCloseTo(6000, 6);
    expect(r.surfaceArea).toBeCloseTo(2 * (200 + 300 + 600), 6);
    expect(r.topology.watertight).toBe(true);
    expect(r.topology.shells).toBe(1);
    expect(r.invertedNormals).toBe(false);
  });

  it('two separate cubes → two shells', () => {
    if (!exe) return;
    const r = analyzeMesh(render('cube(5); translate([20,0,0]) cube(5);'));
    expect(r.topology.shells).toBe(2);
    expect(r.volume).toBeCloseTo(250, 6);
  });

  it('translation, nonuniform scale and a 45-degree rotation match analytic quantities', () => {
    if (!exe) return;
    const tris = render(
      'translate([30,-15,7]) rotate([0,0,45]) scale([2,3,4]) cube([2,3,4],center=true);',
    );
    const r = analyzeMesh(tris);
    // Independent closed-form box dimensions are 4 x 9 x 16 before rotation.
    const halfXY = 13 / (2 * Math.sqrt(2));
    for (const axis of [0, 1] as const) {
      const center = axis === 0 ? 30 : -15;
      expect(r.bounds.min[axis]).toBeCloseTo(center - halfXY, 3);
      expect(r.bounds.max[axis]).toBeCloseTo(center + halfXY, 3);
    }
    expect(r.bounds.min[2]).toBe(-1);
    expect(r.bounds.max[2]).toBe(15);
    expect(r.volume).toBeCloseTo(4 * 9 * 16, 1);
    expect(r.surfaceArea).toBeCloseTo(2 * (4 * 9 + 9 * 16 + 16 * 4), 1);
    expect(r.topology.watertight).toBe(true);
    expect(containsPoint(tris, [30, -15, 7])).toBe(true);
    expect(containsPoint(tris, [30 + halfXY - 0.1, -15 + halfXY - 0.1, 7])).toBe(false);
  });

  it('a closed internal cavity is empty and reduces volume despite the unchanged envelope', () => {
    if (!exe) return;
    const tris = render('difference(){cube(20);translate([2,2,2])cube(16);}');
    const r = analyzeMesh(tris);
    expect(r.bounds.min).toEqual([0, 0, 0]);
    expect(r.bounds.max).toEqual([20, 20, 20]);
    expect(r.volume).toBeCloseTo(20 ** 3 - 16 ** 3, 6);
    expect(r.surfaceArea).toBeCloseTo(6 * (20 ** 2 + 16 ** 2), 6);
    expect(r.topology.watertight).toBe(true);
    expect(r.topology.shells).toBe(2);
    expect(containsPoint(tris, [10, 10, 10])).toBe(false);
    expect(containsPoint(tris, [1, 10, 10])).toBe(true);
    expect(crossSection(tris, 'z', 10).materialArea).toBeCloseTo(20 ** 2 - 16 ** 2, 6);
  });

  it('plate with a hole: containment + section circle', () => {
    if (!exe) return;
    const tris = render(
      'difference(){ cube([100,40,6]); translate([50,20,-1]) cylinder(d=8,h=10,$fn=64); }',
    );
    const r = analyzeMesh(tris);
    // polygon(64) inscribed → slightly less than π r²
    const holeArea = 64 * 0.5 * 16 * Math.sin((2 * Math.PI) / 64);
    expect(r.volume).toBeCloseTo(24000 - holeArea * 6, 3);
    expect(containsPoint(tris, [50, 20, 3])).toBe(false);
    expect(containsPoint(tris, [10, 10, 3])).toBe(true);
    expect(containsPoint(tris, [50, 20, 7])).toBe(false);
    expect(containsPoint(tris, [50, 24.5, 3])).toBe(true);
    expect(containsPoint(tris, [50, 23.5, 3])).toBe(false);

    const s = crossSection(tris, 'z', 3);
    expect(s.loops.length).toBe(2);
    const outer = s.loops.find((l) => !l.isHole)!;
    const hole = s.loops.find((l) => l.isHole)!;
    expect(outer.rectangle?.size).toEqual([100, 40]);
    expect(hole.circle).not.toBeNull();
    expect(hole.circle!.radius).toBeCloseTo(4, 3);
    expect(hole.circle!.center[0]).toBeCloseTo(50, 3);
    expect(hole.circle!.center[1]).toBeCloseTo(20, 3);
    expect(hole.circle!.roundness).toBeGreaterThan(0.99);
    expect(s.materialArea).toBeCloseTo(4000 - holeArea, 2);
    // Gate for defaulting soup checks: a clean CSG plate must not look intersecting.
    expect(countIntersectingPairs(tris)).toBe(0);
  });

  it('section along y axis finds holes drilled through y', () => {
    if (!exe) return;
    const tris = render(
      'difference(){ cube([60,5,30]); translate([20,-1,20]) rotate([-90,0,0]) cylinder(d=4.5,h=10,$fn=48); }',
    );
    const s = crossSection(tris, 'y', 2.5);
    expect(s.planeAxes).toEqual(['x', 'z']);
    const hole = s.loops.find((l) => l.isHole)!;
    expect(hole.circle!.radius).toBeCloseTo(2.25, 3);
    expect(hole.circle!.center).toEqual([20, 20]);
  });

  it('detects coarse faceting (default $fn pentagon on a small hole)', () => {
    if (!exe) return;
    const tris = render(
      'difference(){ cube([20,20,5]); translate([10,10,-1]) cylinder(d=2.5,h=10); }',
    );
    const s = crossSection(tris, 'z', 2.5);
    const hole = s.loops.find((l) => l.isHole)!;
    expect(hole.points.length).toBe(5);
    expect(hole.circle).not.toBeNull();
    expect(hole.circle!.roundness).toBeCloseTo(Math.cos(Math.PI / 5), 2);
  });

  it('open (non-watertight) mesh is reported', () => {
    if (!exe) return;
    // polyhedron with a missing face
    const tris = render(
      'polyhedron(points=[[0,0,0],[10,0,0],[10,10,0],[0,10,0],[5,5,8]], faces=[[0,1,4],[1,2,4],[2,3,4],[3,0,4]]);',
    );
    const r = analyzeMesh(tris);
    expect(r.topology.watertight).toBe(false);
    expect(r.topology.boundaryEdges).toBe(4);
  });
});
