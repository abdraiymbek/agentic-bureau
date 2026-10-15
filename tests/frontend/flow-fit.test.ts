import { describe, expect, it } from 'vitest';
import {
  clampViewport,
  countOutside,
  detailAt,
  fitViewport,
  freeRects,
  labelScale,
  reveal,
  zoomAt,
  ZOOM,
} from '../../apps/desktop/src/renderer/project/flow/fit';
import { rectsOverlap, type Rect } from '../../apps/desktop/src/renderer/project/flow/geometry';

const READABLE = { min: ZOOM.readable, max: ZOOM.fit };
/** The canvas of a 1440 × 900 window under the project header, above the map controls. */
const region: Rect = { x: 32, y: 132, w: 1344, h: 664 };
/** The Sable rover map. */
const bounds: Rect = { x: 0, y: -46, w: 1331, h: 508 };
/** Where the top-left corner of the map lands on screen. */
const origin = (fit: { viewport: { x: number; y: number; k: number } }, b = bounds) => ({
  x: b.x * fit.viewport.k + fit.viewport.x,
  y: b.y * fit.viewport.k + fit.viewport.y,
});

describe('flow fit', () => {
  it('fits the whole free rectangle and anchors the map at its top left', () => {
    const fit = fitViewport(bounds, region, [], READABLE);
    // 1344 / 1331 is within a hair of full size, so the map is drawn at exactly 100 %.
    expect(fit.viewport.k).toBe(1);
    expect(fit.overflow).toBe(false);
    expect(origin(fit)).toEqual({ x: 32, y: 132 });
    const roomy = fitViewport(bounds, { ...region, w: 1420, h: 720 }, [], READABLE);
    expect(roomy.viewport.k).toBeCloseTo(1420 / 1331, 5);
    const tight = fitViewport(bounds, { ...region, w: 1264 }, [], READABLE);
    expect(tight.viewport.k).toBeCloseTo(1264 / 1331, 5);
  });

  it('never enlarges past the working text size', () => {
    const fit = fitViewport({ x: 0, y: 0, w: 300, h: 120 }, region, [], READABLE);
    expect(fit.viewport.k).toBe(ZOOM.fit);
    expect(origin(fit, { x: 0, y: 0, w: 300, h: 120 })).toEqual({ x: 32, y: 132 });
  });

  it('ignores an island that floats entirely inside the header band', () => {
    const island: Rect = { x: 1064, y: 16, w: 312, h: 96 };
    expect(fitViewport(bounds, region, [island], READABLE)).toEqual(
      fitViewport(bounds, region, [], READABLE),
    );
  });

  it('goes under a short island rather than shrinking beside it', () => {
    const island: Rect = { x: 1064, y: 16, w: 312, h: 180 };
    const fit = fitViewport(bounds, region, [island], READABLE);
    // Under the island the full width is free; beside it the map would drop to 0.76.
    expect(fit.rect).toEqual({ x: 32, y: 212, w: 1344, h: 584 });
    expect(fit.viewport.k).toBe(1);
    expect(origin(fit).y).toBeCloseTo(212);
    expect(fit.overflow).toBe(false);
  });

  it('goes beside a narrow obstruction when that keeps the map larger', () => {
    const tall: Rect = { x: 1300, y: 100, w: 76, h: 500 };
    const narrow: Rect = { x: 0, y: -46, w: 900, h: 600 };
    const fit = fitViewport(narrow, region, [tall], READABLE);
    expect(fit.rect).toEqual({ x: 32, y: 132, w: 1252, h: 664 });
    expect(fit.viewport.k).toBe(ZOOM.fit);
  });

  it('keeps the readable minimum and overflows when the map cannot fit', () => {
    // 1024 × 700: the canvas is 976 wide.
    const small: Rect = { x: 24, y: 96, w: 936, h: 500 };
    const fit = fitViewport(bounds, small, [], READABLE);
    expect(fit.viewport.k).toBe(ZOOM.readable);
    expect(fit.overflow).toBe(true);
    expect(origin(fit)).toEqual({ x: 24, y: 96 });
    // "Fit all" trades legibility for the overview.
    const all = fitViewport(bounds, small, [], { min: ZOOM.min, max: ZOOM.fit });
    expect(all.viewport.k).toBeCloseTo(936 / 1331, 5);
    expect(all.overflow).toBe(false);
  });

  it('stays under the project name when no free rectangle is readable', () => {
    const island: Rect = { x: 1064, y: 16, w: 312, h: 420 };
    const tall: Rect = { x: 0, y: -46, w: 1500, h: 900 };
    const fit = fitViewport(tall, region, [island], READABLE);
    expect(fit.viewport.k).toBe(ZOOM.readable);
    expect(fit.overflow).toBe(true);
    expect(origin(fit, tall)).toEqual({ x: 32, y: 132 });
  });

  it('finds every maximal free rectangle around obstructions', () => {
    const island: Rect = { x: 1064, y: 16, w: 312, h: 180 };
    const rects = freeRects(region, [island]);
    expect(rects).toHaveLength(2);
    const inflated = { x: island.x - 16, y: island.y - 16, w: island.w + 32, h: island.h + 32 };
    for (const r of rects) expect(rectsOverlap(r, inflated)).toBe(false);
    expect(freeRects(region, [])).toEqual([region]);
    // An obstruction in the middle leaves a rectangle on each side.
    expect(freeRects(region, [{ x: 600, y: 400, w: 100, h: 100 }])).toHaveLength(4);
    // Nothing is free when the canvas is covered.
    expect(freeRects(region, [{ x: 0, y: 0, w: 1500, h: 900 }])).toEqual([]);
    expect(fitViewport(bounds, region, [{ x: 0, y: 0, w: 1500, h: 900 }], READABLE).overflow).toBe(
      true,
    );
  });

  it('zooms around the pointer and stays within the zoom limits', () => {
    const start = { x: 32, y: 132, k: 1 };
    const mapPoint = (v: typeof start, px: number, py: number) => ({
      x: (px - v.x) / v.k,
      y: (py - v.y) / v.k,
    });
    const zoomed = zoomAt(start, 1.4, 700, 400);
    expect(zoomed.k).toBe(1.4);
    expect(mapPoint(zoomed, 700, 400).x).toBeCloseTo(mapPoint(start, 700, 400).x);
    expect(mapPoint(zoomed, 700, 400).y).toBeCloseTo(mapPoint(start, 700, 400).y);
    expect(zoomAt(start, 9, 0, 0).k).toBe(ZOOM.max);
    expect(zoomAt(start, 0.01, 0, 0).k).toBe(ZOOM.min);
  });

  it('cannot be panned out of reach', () => {
    for (const lost of [
      { x: -5000, y: -5000, k: 1 },
      { x: 5000, y: 5000, k: 1 },
      { x: 0, y: 9000, k: 0.3 },
    ]) {
      const v = clampViewport(lost, bounds, region);
      const screen = {
        x: bounds.x * v.k + v.x,
        y: bounds.y * v.k + v.y,
        w: bounds.w * v.k,
        h: bounds.h * v.k,
      };
      expect(rectsOverlap(screen, region)).toBe(true);
      expect(v.k).toBe(lost.k);
    }
    const inside = { x: 40, y: 150, k: 1 };
    expect(clampViewport(inside, bounds, region)).toEqual(inside);
  });

  it('reveals a node with the smallest pan that brings it fully into view', () => {
    const v = { x: 32, y: 132, k: 1 };
    const visible: Rect = { x: 200, y: 100, w: 200, h: 40 };
    expect(reveal(v, visible, region)).toEqual(v);
    // A node at the very edge of the fitted map is in view: focusing it must not nudge the map.
    const atEdge: Rect = { x: 0, y: 0, w: 200, h: 40 };
    expect(reveal(v, atEdge, region)).toEqual(v);
    const farRight: Rect = { x: 1600, y: 100, w: 200, h: 40 };
    const shown = reveal(v, farRight, region);
    expect(farRight.x + shown.x + farRight.w).toBe(region.x + region.w - 24);
    expect(shown.y).toBe(v.y);
    const above: Rect = { x: 200, y: -400, w: 200, h: 40 };
    expect(above.y + reveal(v, above, region).y).toBe(region.y + 24);
  });

  it('counts what lies outside the visible region', () => {
    const rects: Rect[] = [
      { x: 0, y: 0, w: 200, h: 40 },
      { x: 2000, y: 0, w: 200, h: 40 },
      { x: 0, y: 3000, w: 200, h: 40 },
    ];
    expect(countOutside({ x: 32, y: 132, k: 1 }, rects, region)).toBe(2);
    expect(countOutside({ x: 32, y: 132, k: 0.2 }, rects, region)).toBe(0);
  });

  it('simplifies nodes as they shrink and keeps headers legible', () => {
    expect(detailAt(ZOOM.readable)).toBe('full');
    expect(detailAt(0.5)).toBe('glyph');
    expect(detailAt(0.25)).toBe('strip');
    expect(labelScale(1.4)).toBe(1);
    expect(labelScale(1)).toBe(1);
    // Headers keep their design size on screen as the map shrinks…
    expect(labelScale(ZOOM.readable) * ZOOM.readable).toBeCloseTo(1);
    expect(labelScale(0.5)).toBeCloseTo(2);
    // …down to a third of full size, then shrink with the map.
    expect(labelScale(0.2)).toBe(3);
  });
});
