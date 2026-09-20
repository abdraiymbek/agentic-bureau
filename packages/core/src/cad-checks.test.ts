import { describe, expect, it } from 'vitest';
import { findLoosenedAssertions, preservationCheck, runChecks } from './cad-checks.js';
import type { TriangleBuffer, Vec3 } from './mesh.js';

function box(min: Vec3, max: Vec3): TriangleBuffer {
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
  const out = new Float64Array(faces.length * 9);
  faces.forEach((f, i) =>
    f.forEach((vi, k) => {
      out[i * 9 + k * 3] = v[vi]![0];
      out[i * 9 + k * 3 + 1] = v[vi]![1];
      out[i * 9 + k * 3 + 2] = v[vi]![2];
    }),
  );
  return out;
}

describe('preservationCheck', () => {
  it('passes when only the declared region changed', () => {
    const orig = box([0, 0, 0], [60, 40, 4]);
    const modified = box([0, 0, 0], [60, 40, 4]);
    const r = preservationCheck(orig, modified, [{ center: [5, 5, 2], radius: 4 }]);
    expect(r.pass).toBe(true);
  });

  it('fails when geometry far from the change region is altered', () => {
    const orig = box([0, 0, 0], [60, 40, 4]);
    const grown = box([0, 0, 0], [60, 40, 8]);
    const r = preservationCheck(orig, grown, [{ center: [5, 5, 2], radius: 4 }], 200);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/differ/);
  });
});

describe('findLoosenedAssertions', () => {
  it('flags the same check passing only because the tolerance grew', () => {
    const loosened = findLoosenedAssertions(
      [{ name: 'bounding box', pass: false, tightness: 10 }],
      [{ name: 'bounding box', pass: true, tightness: 0.2 }],
    );
    expect(loosened).toEqual(['bounding box']);
  });

  it('does not flag a retry that keeps the same tightness', () => {
    expect(
      findLoosenedAssertions(
        [{ name: 'volume', pass: false, tightness: 1 / 1.5 }],
        [{ name: 'volume', pass: true, tightness: 1 / 1.5 }],
      ),
    ).toEqual([]);
  });
});

describe('runChecks quality flags', () => {
  it('fails maxSelfIntersections when two boxes interpenetrate', () => {
    const a = box([0, 0, 0], [10, 10, 10]);
    const b = box([5, 5, 5], [15, 15, 15]);
    const merged = new Float64Array(a.length + b.length);
    merged.set(a);
    merged.set(b, a.length);
    const r = runChecks(merged, { maxSelfIntersections: 0, watertight: false });
    const hit = r.find((c) => c.name === 'self-intersections');
    expect(hit?.pass).toBe(false);
  });
});
