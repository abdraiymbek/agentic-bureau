import { describe, expect, it } from 'vitest';
import type { MeshBounds } from '../../apps/desktop/src/renderer/lib/stl-parse';
import {
  STANDARD_VIEWS,
  VIEW_ORDER,
  boundsCenter,
  boundsRadius,
  boundsSize,
  clampFraction,
  drawnExtent,
  fitDistance,
  fitHalfHeight,
  formatEnvelope,
  formatLength,
  gridHalfExtent,
  gridSpacing,
  gridStep,
  keptBySection,
  measure,
  orbitOffset,
  sectionCoordinate,
  sectionPlane,
  sideBySideShift,
  snapToVertex,
  unitsPerPixel,
  type Vec3,
} from '../../apps/desktop/src/renderer/lib/viewport-math';

const tray: MeshBounds = { min: [0, -10, -44], max: [62, 4.5, 0] };

describe('envelope', () => {
  it('reads size, centre and radius from the bounds', () => {
    expect(boundsSize(tray)).toEqual([62, 14.5, 44]);
    expect(boundsCenter(tray)).toEqual([31, -2.75, -22]);
    expect(boundsRadius(tray)).toBeCloseTo(Math.hypot(62, 14.5, 44) / 2);
  });
  it('prints lengths with two decimals and their unit', () => {
    expect(formatLength(14.5, 'mm')).toBe('14.50 mm');
    expect(formatEnvelope(tray, 'mm')).toBe('62.00 × 14.50 × 44.00 mm');
  });
});

describe('section plane', () => {
  it('places the plane between the faces of the envelope', () => {
    expect(sectionCoordinate(tray, { axis: 'z', fraction: 0.5, flipped: false })).toBe(-22);
    expect(sectionCoordinate(tray, { axis: 'x', fraction: 0, flipped: false })).toBe(0);
    expect(sectionCoordinate(tray, { axis: 'y', fraction: 1, flipped: false })).toBe(4.5);
    expect(sectionCoordinate(tray, { axis: 'x', fraction: 7, flipped: false })).toBe(62);
  });
  it('treats a slider value that is not a number as the middle', () => {
    expect(clampFraction(Number.NaN)).toBe(0.5);
    expect(clampFraction(-2)).toBe(0);
  });
  it('keeps the low side by default and the high side when flipped', () => {
    const low = sectionPlane(tray, { axis: 'z', fraction: 0.5, flipped: false });
    expect(low).toEqual({ normal: [0, 0, -1], constant: -22 });
    expect(keptBySection([10, 0, -30], low)).toBe(true);
    expect(keptBySection([10, 0, -22], low)).toBe(true);
    expect(keptBySection([10, 0, -10], low)).toBe(false);
    const high = sectionPlane(tray, { axis: 'z', fraction: 0.5, flipped: true });
    expect(keptBySection([10, 0, -10], high)).toBe(true);
    expect(keptBySection([10, 0, -30], high)).toBe(false);
    const alongX = sectionPlane(tray, { axis: 'x', fraction: 0.25, flipped: false });
    expect(alongX.normal).toEqual([-1, 0, 0]);
    expect(keptBySection([15.5, 0, 0], alongX)).toBe(true);
    expect(keptBySection([15.6, 0, 0], alongX)).toBe(false);
  });
});

describe('measure', () => {
  it('gives the distance and the signed offset along each axis', () => {
    expect(measure([0, 0, 0], [3, 4, 12])).toEqual({ distance: 13, delta: [3, 4, 12] });
    expect(measure([62, 0, 0], [0, 0, 0]).delta).toEqual([-62, 0, 0]);
  });
  it('snaps a pick to the nearest corner within the tolerance', () => {
    const corners: Vec3[] = [
      [0, 0, 0],
      [10, 0, 0],
      [0, 10, 0],
    ];
    expect(snapToVertex([9.6, 0.2, 0], corners, 0.5)).toEqual({
      point: [10, 0, 0],
      onVertex: true,
    });
    expect(snapToVertex([0.2, 0.2, 0], corners, 0.5).point).toEqual([0, 0, 0]);
  });
  it('leaves a pick on the face, and says so, when no corner is close enough', () => {
    const hit: Vec3 = [4, 3, 0];
    const picked = snapToVertex(
      hit,
      [
        [0, 0, 0],
        [10, 0, 0],
        [0, 10, 0],
      ],
      0.5,
    );
    expect(picked).toEqual({ point: [4, 3, 0], onVertex: false });
    expect(picked.point).not.toBe(hit);
  });
  it('turns a pixel tolerance into model units for either projection', () => {
    expect(
      unitsPerPixel({
        orthographic: true,
        fov: 40,
        viewHeight: 100,
        distance: 5,
        viewportHeightPx: 500,
      }),
    ).toBeCloseTo(0.2);
    const near = unitsPerPixel({
      orthographic: false,
      fov: 40,
      viewHeight: 0,
      distance: 100,
      viewportHeightPx: 500,
    });
    const far = unitsPerPixel({
      orthographic: false,
      fov: 40,
      viewHeight: 0,
      distance: 200,
      viewportHeightPx: 500,
    });
    expect(near).toBeCloseTo((2 * 100 * Math.tan((20 * Math.PI) / 180)) / 500);
    expect(far).toBeCloseTo(near * 2);
  });
});

describe('camera', () => {
  it('has seven standard views with unit directions and distinct keys', () => {
    expect(VIEW_ORDER).toHaveLength(7);
    expect(new Set(VIEW_ORDER.map((v) => STANDARD_VIEWS[v].key)).size).toBe(7);
    for (const view of VIEW_ORDER) {
      const { from, up } = STANDARD_VIEWS[view];
      expect(Math.hypot(...from)).toBeCloseTo(1);
      expect(Math.hypot(...up)).toBeCloseTo(1);
    }
    // Front looks along +Y with Z up; top looks down with +Y up.
    expect(STANDARD_VIEWS.front.from).toEqual([0, -1, 0]);
    expect(STANDARD_VIEWS.top).toMatchObject({ from: [0, 0, 1], up: [0, 1, 0] });
  });
  it('fits a sphere in the narrower of the two fields of view', () => {
    const wide = fitDistance(10, 40, 2);
    expect(wide).toBeCloseTo(10 / Math.sin((20 * Math.PI) / 180));
    expect(fitDistance(10, 40, 0.5)).toBeGreaterThan(wide);
    expect(fitHalfHeight(10, 2)).toBe(10);
    expect(fitHalfHeight(10, 0.5)).toBe(20);
  });
  it('orbits about Z without changing the distance, and stops short of the poles', () => {
    const quarter = orbitOffset([10, 0, 0], Math.PI / 2, 0);
    expect(quarter[0]).toBeCloseTo(0);
    expect(quarter[1]).toBeCloseTo(10);
    expect(quarter[2]).toBeCloseTo(0);
    const tilted = orbitOffset([10, 0, 0], 0, -Math.PI / 4);
    expect(Math.hypot(...tilted)).toBeCloseTo(10);
    expect(tilted[2]).toBeCloseTo(10 * Math.SQRT1_2);
    const over = orbitOffset([10, 0, 0], 0, -Math.PI);
    expect(over[2]).toBeLessThan(10);
    expect(over[2]).toBeGreaterThan(9.99);
    expect(orbitOffset([0, 0, 0], 1, 1)).toEqual([0, 0, 0]);
  });
});

describe('ground and comparison layout', () => {
  it('chooses grid spacings of 1, 2 or 5 times a power of ten', () => {
    expect([8, 62, 150, 400, 0.3].map(gridStep)).toEqual([1, 10, 20, 50, 0.05]);
    expect(gridStep(0)).toBe(1);
    expect(gridSpacing(tray)).toBe(10);
  });
  it('extends the grid past the envelope in whole cells', () => {
    expect(gridHalfExtent(tray, 10)).toBe(80);
    expect(gridHalfExtent({ min: [0, 0, 0], max: [1, 1, 1] }, 10)).toBe(10);
  });
  it('puts a side-by-side comparison on the low-X side with a gap', () => {
    const other: MeshBounds = { min: [0, 0, 0], max: [40, 10, 10] };
    const shift = sideBySideShift(tray, other);
    expect(other.max[0] + shift).toBeCloseTo(-12.4);
    const extent = drawnExtent(tray, other, true);
    expect(extent.min[0]).toBeCloseTo(-52.4);
    expect(extent.max).toEqual([62, 10, 10]);
    expect(drawnExtent(tray, other, false).min[0]).toBe(0);
    expect(drawnExtent(tray, null, true)).toBe(tray);
  });
});
