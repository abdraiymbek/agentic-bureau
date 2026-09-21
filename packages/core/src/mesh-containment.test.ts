import { describe, expect, it } from 'vitest';
import { containsPoint, type Vec3 } from './mesh.js';

function box(lo: number, hi: number, diagonals: number): number[] {
  const v: Vec3[] = [
    [lo, lo, lo],
    [hi, lo, lo],
    [hi, hi, lo],
    [lo, hi, lo],
    [lo, lo, hi],
    [hi, lo, hi],
    [hi, hi, hi],
    [lo, hi, hi],
  ];
  const faces = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  return faces.flatMap(([a, b, c, d], i) =>
    (diagonals & (1 << i) ? [a!, b!, d!, b!, c!, d!] : [a!, b!, c!, a!, c!, d!]).flatMap(
      (n) => v[n]!,
    ),
  );
}

describe('point containment is independent of face triangulation', () => {
  it('distinguishes an enclosed cavity, material and outside for every cube-face diagonal pattern', () => {
    for (let mask = 0; mask < 64; mask++) {
      const mesh = new Float64Array([...box(0, 20, mask), ...box(2, 18, mask ^ 42)]);
      for (const p of [
        [10, 10, 10],
        [3, 4, 5],
        [17, 16, 15],
      ] as Vec3[])
        expect(containsPoint(mesh, p), `cavity ${mask} at ${p}`).toBe(false);
      for (const p of [
        [1, 10, 10],
        [19, 9, 10],
        [10, 1, 9],
      ] as Vec3[])
        expect(containsPoint(mesh, p), `material ${mask} at ${p}`).toBe(true);
      expect(containsPoint(mesh, [30, 10, 10])).toBe(false);
    }
  });
  it('does not merge opposite sides of a thin wall', () => {
    const mesh = new Float64Array([...box(0, 20, 21), ...box(0.001, 19.999, 42)]);
    expect(containsPoint(mesh, [0.0005, 10, 10])).toBe(true);
    expect(containsPoint(mesh, [10, 10, 10])).toBe(false);
  });
});
