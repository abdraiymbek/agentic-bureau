/**
 * Pure-geometry tests for mesh orientation, oblique sections, and soup
 * detection. Triangle buffers are built by hand so these run without OpenSCAD.
 */
import { describe, expect, it } from 'vitest';
import {
  analyzeMesh,
  containsPoint,
  countIntersectingPairs,
  crossSection,
  crossSectionPlane,
  minWallThickness,
  orientTriangles,
  type TriangleBuffer,
  type Vec3,
} from './mesh.js';

/** Axis-aligned box as 12 triangles. `invert` reverses winding (inside-out). */
function box(min: Vec3, max: Vec3, invert = false): TriangleBuffer {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v: Vec3[] = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  const faces: [number, number, number][] = [
    [0, 2, 1],
    [0, 3, 2], // −Z
    [4, 5, 6],
    [4, 6, 7], // +Z
    [0, 1, 5],
    [0, 5, 4], // −Y
    [3, 7, 6],
    [3, 6, 2], // +Y
    [0, 4, 7],
    [0, 7, 3], // −X
    [1, 2, 6],
    [1, 6, 5], // +X
  ];
  const out = new Float64Array(faces.length * 9);
  faces.forEach((f, i) => {
    const abc = invert ? [f[0], f[2], f[1]] : f;
    abc.forEach((vi, k) => {
      out[i * 9 + k * 3] = v[vi]![0];
      out[i * 9 + k * 3 + 1] = v[vi]![1];
      out[i * 9 + k * 3 + 2] = v[vi]![2];
    });
  });
  return out;
}

describe('orientTriangles', () => {
  it('leaves an outward-wound cube unchanged', () => {
    const tris = box([0, 0, 0], [10, 20, 30]);
    const r = orientTriangles(tris);
    expect(r.flipped).toBe(false);
    expect(analyzeMesh(r.tris).invertedNormals).toBe(false);
    expect(analyzeMesh(r.tris).volume).toBeCloseTo(6000, 6);
  });

  it('flips a watertight inside-out cube so signed volume is positive', () => {
    const tris = box([0, 0, 0], [10, 20, 30], true);
    expect(analyzeMesh(tris).invertedNormals).toBe(true);
    const r = orientTriangles(tris);
    expect(r.flipped).toBe(true);
    const after = analyzeMesh(r.tris);
    expect(after.invertedNormals).toBe(false);
    expect(after.topology.watertight).toBe(true);
    expect(after.volume).toBeCloseTo(6000, 6);
    expect(containsPoint(r.tris, [5, 10, 15])).toBe(true);
    expect(containsPoint(r.tris, [15, 10, 15])).toBe(false);
  });

  it('does not flip an open (non-watertight) mesh', () => {
    // One face of a tetrahedron — not a closed volume.
    const open = Float64Array.from([0, 0, 0, 10, 0, 0, 5, 8, 0]);
    const r = orientTriangles(open);
    expect(r.flipped).toBe(false);
  });
});

describe('crossSectionPlane', () => {
  it('matches axis-aligned crossSection on a cube mid-plane', () => {
    const tris = box([0, 0, 0], [10, 20, 30]);
    const aligned = crossSection(tris, 'z', 15);
    const oblique = crossSectionPlane(tris, [0, 0, 15], [0, 0, 1]);
    expect(oblique.loops).toHaveLength(1);
    expect(aligned.loops[0]!.rectangle?.size).toEqual([10, 20]);
    expect(oblique.loops[0]!.rectangle?.size).toEqual([10, 20]);
  });

  it('keeps a round outline when the plane runs through a ring of vertices', () => {
    // The flank of a revolved V-groove: a 64-facet band from radius 25 at z = 8
    // out to radius 32 at z = 13.6, each facet split by a diagonal. A cut at
    // z = 8 lies on the inner ring; nudged by no more than the loop builder's
    // point grid, the facets' cut points merged and the outline lost corners.
    const n = 64;
    const ring = (r: number, z: number, i: number): Vec3 => [
      r * Math.cos((2 * Math.PI * i) / n),
      r * Math.sin((2 * Math.PI * i) / n),
      z,
    ];
    const tris: number[] = [];
    for (let i = 0; i < n; i++) {
      const a0 = ring(25, 8, i);
      const a1 = ring(25, 8, i + 1);
      const b0 = ring(32, 13.6, i);
      const b1 = ring(32, 13.6, i + 1);
      tris.push(...a0, ...a1, ...b0, ...a1, ...b1, ...b0);
    }
    const s = crossSection(new Float64Array(tris), 'z', 8);
    expect(s.loops).toHaveLength(1);
    const circle = s.loops[0]!.circle!;
    expect(circle.radius * 2).toBeCloseTo(50, 2);
    expect(circle.roundness).toBeGreaterThan(0.99);
  });

  it('cuts a cube on a 45° plane and reports a rectangular section', () => {
    const tris = box([0, 0, 0], [20, 20, 20]);
    // Plane x + z = 20 through the cube — a 20√2 × 20 rectangle.
    const s = crossSectionPlane(tris, [10, 0, 10], [1, 0, 1]);
    expect(s.openChains).toBe(0);
    expect(s.loops).toHaveLength(1);
    const loop = s.loops[0]!;
    expect(loop.isHole).toBe(false);
    const diag = Math.SQRT2 * 20;
    expect(loop.bbox.size[0]).toBeGreaterThan(diag - 0.2);
    expect(loop.bbox.size[0]).toBeLessThan(diag + 0.2);
    expect(loop.bbox.size[1]).toBeCloseTo(20, 1);
  });
});

describe('STL soup detection', () => {
  it('reports zero intersections for a single closed cube', () => {
    expect(countIntersectingPairs(box([0, 0, 0], [10, 10, 10]))).toBe(0);
  });

  it('detects two interpenetrating cubes in one buffer', () => {
    const a = box([0, 0, 0], [10, 10, 10]);
    const b = box([5, 5, 5], [15, 15, 15]);
    const merged = new Float64Array(a.length + b.length);
    merged.set(a);
    merged.set(b, a.length);
    expect(countIntersectingPairs(merged)).toBeGreaterThan(0);
  });

  it('measures wall thickness of a hollow cube (2 mm walls)', () => {
    const outer = box([0, 0, 0], [20, 20, 20]);
    const inner = box([2, 2, 2], [18, 18, 18], true);
    const shell = new Float64Array(outer.length + inner.length);
    shell.set(outer);
    shell.set(inner, outer.length);
    const t = minWallThickness(shell);
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThan(1.5);
    expect(t!).toBeLessThan(2.6);
  });
});
