import { bottom, clamp, rectsOverlap, right, type Rect } from './geometry';

/** Where the map sits on the canvas: screen = map × k + (x, y). */
export interface Viewport {
  x: number;
  y: number;
  k: number;
}

export const ZOOM = {
  /** The furthest out. Nodes are a strip of state marks by here. */
  min: 0.2,
  /** Node titles are 11 px at this zoom. A fit never goes below it; the map pans instead. */
  readable: 0.88,
  /** A fit never enlarges past the interface's working text size. */
  fit: 1.08,
  max: 1.6,
  step: 1.25,
} as const;

/** A fit that would enlarge the map by less than this stays at exactly 100 %. */
const FULL_SIZE_SNAP = 1.04;
/** Room kept between the map and anything floating over the canvas. */
const OBSTRUCTION_GAP = 16;
/** How much of the map always stays on the canvas, so it cannot be panned out of reach. */
const KEEP_IN_VIEW = 96;

export interface Fit {
  viewport: Viewport;
  /** The free rectangle the map was fitted into. */
  rect: Rect;
  /** The whole map does not fit at this zoom; the rest is reached by panning. */
  overflow: boolean;
}

/**
 * Every maximal rectangle of `region` that keeps `gap` clear of each obstruction, found by
 * trying each obstruction edge as a boundary.
 */
export function freeRects(region: Rect, obstructions: Rect[], gap = OBSTRUCTION_GAP): Rect[] {
  const blocking = obstructions
    .map((o) => ({ x: o.x - gap, y: o.y - gap, w: o.w + 2 * gap, h: o.h + 2 * gap }))
    .filter((o) => rectsOverlap(o, region));
  const lefts = [region.x, ...blocking.map(right)];
  const tops = [region.y, ...blocking.map(bottom)];
  const rights = [right(region), ...blocking.map((o) => o.x)];
  const bottoms = [bottom(region), ...blocking.map((o) => o.y)];
  const found = new Map<string, Rect>();
  for (const x of lefts) {
    for (const y of tops) {
      for (const r of rights) {
        for (const b of bottoms) {
          const rect = { x, y, w: r - x, h: b - y };
          if (rect.w <= 0 || rect.h <= 0) continue;
          if (x < region.x || y < region.y || r > right(region) || b > bottom(region)) continue;
          if (blocking.some((o) => rectsOverlap(o, rect))) continue;
          found.set(`${x},${y},${r},${b}`, rect);
        }
      }
    }
  }
  const rects = [...found.values()];
  const contains = (outer: Rect, inner: Rect) =>
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    right(outer) >= right(inner) &&
    bottom(outer) >= bottom(inner);
  return rects.filter((a) => !rects.some((b) => b !== a && contains(b, a)));
}

/**
 * Fits the map into the best free rectangle of the canvas, anchored at that rectangle's top
 * left so the reading origin sits under the project name. The zoom stays within `limits`: when
 * the map would have to shrink below them it keeps the lower limit and overflows instead.
 * Between rectangles that give the same zoom, the one nearest the top left wins.
 */
export function fitViewport(
  bounds: Rect,
  region: Rect,
  obstructions: Rect[],
  limits: { min: number; max: number },
): Fit {
  let best: (Fit & { area: number }) | null = null;
  for (const rect of freeRects(region, obstructions)) {
    const raw = Math.min(rect.w / Math.max(bounds.w, 1), rect.h / Math.max(bounds.h, 1));
    // Just above full size is drawn at full size: every node then sits on whole pixels.
    const clamped = clamp(raw, limits.min, limits.max);
    const k = clamped > 1 && clamped < FULL_SIZE_SNAP ? 1 : clamped;
    const candidate = {
      viewport: { k, x: rect.x - bounds.x * k, y: rect.y - bounds.y * k },
      rect,
      overflow: raw < limits.min,
      area: rect.w * rect.h,
    };
    const better =
      !best ||
      k > best.viewport.k + 1e-6 ||
      (Math.abs(k - best.viewport.k) <= 1e-6 &&
        (rect.y - best.rect.y || rect.x - best.rect.x || best.area - candidate.area) < 0);
    if (better) best = candidate;
  }
  if (best) return { viewport: best.viewport, rect: best.rect, overflow: best.overflow };
  // Nothing is free (the canvas is covered): fall back to the region itself.
  const k = limits.min;
  return {
    viewport: { k, x: region.x - bounds.x * k, y: region.y - bounds.y * k },
    rect: region,
    overflow: true,
  };
}

/** The same map point stays under the screen point (px, py) while the zoom changes. */
export function zoomAt(viewport: Viewport, k: number, px: number, py: number): Viewport {
  const next = clamp(k, ZOOM.min, ZOOM.max);
  const ratio = next / viewport.k;
  return { k: next, x: px - (px - viewport.x) * ratio, y: py - (py - viewport.y) * ratio };
}

/** Keeps part of the map inside the region, however far it is panned. */
export function clampViewport(viewport: Viewport, bounds: Rect, region: Rect): Viewport {
  const { k } = viewport;
  const w = bounds.w * k;
  const h = bounds.h * k;
  const keepX = Math.min(KEEP_IN_VIEW, w, region.w);
  const keepY = Math.min(KEEP_IN_VIEW, h, region.h);
  const left = clamp(bounds.x * k + viewport.x, region.x + keepX - w, right(region) - keepX);
  const top = clamp(bounds.y * k + viewport.y, region.y + keepY - h, bottom(region) - keepY);
  return { k, x: left - bounds.x * k, y: top - bounds.y * k };
}

/**
 * The smallest pan that brings a map rectangle fully into the region. Something already in view
 * is left where it is; something that has to be brought in lands a margin clear of the edge.
 */
export function reveal(viewport: Viewport, target: Rect, region: Rect, margin = 24): Viewport {
  const { k } = viewport;
  const shift = (start: number, size: number, from: number, extent: number) => {
    if (start >= from && start + size <= from + extent) return 0;
    const low = from + margin;
    const high = from + extent - margin;
    return size > high - low || start < low ? low - start : high - (start + size);
  };
  return {
    k,
    x: viewport.x + shift(target.x * k + viewport.x, target.w * k, region.x, region.w),
    y: viewport.y + shift(target.y * k + viewport.y, target.h * k, region.y, region.h),
  };
}

/** How many of the rectangles lie entirely outside the region at this viewport. */
export function countOutside(viewport: Viewport, rects: Rect[], region: Rect): number {
  let outside = 0;
  for (const r of rects) {
    const screen = {
      x: r.x * viewport.k + viewport.x,
      y: r.y * viewport.k + viewport.y,
      w: r.w * viewport.k,
      h: r.h * viewport.k,
    };
    if (!rectsOverlap(screen, region)) outside++;
  }
  return outside;
}

/** How much detail a node carries at a zoom: its title, then glyph and state mark, then a strip. */
export type Detail = 'full' | 'glyph' | 'strip';

export function detailAt(k: number): Detail {
  return k >= 0.62 ? 'full' : k >= 0.4 ? 'glyph' : 'strip';
}

/**
 * Group and column headers are drawn larger as the map shrinks, so they keep their design size
 * on screen down to a third of full size.
 */
export function labelScale(k: number): number {
  return clamp(1 / k, 1, 3);
}
