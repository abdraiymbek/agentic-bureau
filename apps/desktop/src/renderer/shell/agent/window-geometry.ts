/**
 * Where the floating agent window sits and how large it may be. Positions are measured from the
 * top-left of the workbench area the window floats over.
 */

export interface Bounds {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A control's box, measured from the area's top-left like `Rect`. */
export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface WindowPrefs {
  /** Floating size and position; null until the person moves or resizes it. */
  rect: Rect | null;
  /** Docked to the right edge, beside the stage instead of over it. */
  docked: boolean;
  dockWidth: number;
  /** Shrunk to its header. */
  collapsed: boolean;
}

export const MIN_W = 360;
export const MIN_H = 220;
export const MARGIN = 12;
export const DEFAULT_SIZE = { w: 560, h: 380 };
export const DOCK_MIN = 320;
/** The window never takes more than this share of the area's width or height. */
export const MAX_SHARE_W = 0.5;
export const MAX_SHARE_H = 0.56;
export const DOCK_MAX_SHARE = 0.45;
export const KEY_STEP = 16;
export const KEY_STEP_LARGE = 64;

export const DEFAULT_PREFS: WindowPrefs = {
  rect: null,
  docked: false,
  dockWidth: 420,
  collapsed: false,
};

export function maxSize(bounds: Bounds): { w: number; h: number } {
  return {
    w: Math.max(MIN_W, Math.floor(bounds.width * MAX_SHARE_W)),
    h: Math.max(MIN_H, Math.floor(bounds.height * MAX_SHARE_H)),
  };
}

const clampTo = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), Math.max(low, high));

/** A control counts as pinned to the bottom when its lower edge is this close to the area's. */
export const PINNED_BAND = 48;
const CLEAR_GAP = 8;

/**
 * Room a window without a saved place leaves under itself, so it covers none of the controls
 * pinned along the bottom of the area it floats over (the flow map's legend and peek strip, a
 * save bar, the decision bar: whatever marks itself `data-toast-avoid`). It rises past each such
 * box under its columns that it would overlap, lowest first. `height` is what it shows: the
 * header alone while collapsed.
 */
export function bottomReserve(
  bounds: Bounds,
  span: { x: number; w: number; height: number },
  avoid: Box[],
): number {
  let reserve = 0;
  const pinned = avoid
    .filter(
      (b) =>
        b.right > b.left &&
        b.bottom > b.top &&
        b.right > span.x &&
        b.left < span.x + span.w &&
        b.bottom >= bounds.height - PINNED_BAND,
    )
    .sort((a, b) => b.bottom - a.bottom);
  for (const b of pinned) {
    const bottom = bounds.height - MARGIN - reserve;
    if (b.top < bottom && b.bottom > bottom - span.height)
      reserve = Math.max(reserve, bounds.height - MARGIN - b.top + CLEAR_GAP);
  }
  return reserve;
}

/**
 * Fit a rect inside the area: no larger than the allowed share, and fully on screen. `reserve`
 * is room kept free under a window that has no saved place (`bottomReserve`).
 */
export function clampRect(rect: Rect | null, bounds: Bounds, reserve = 0): Rect {
  const max = maxSize(bounds);
  const w = clampTo(rect?.w ?? DEFAULT_SIZE.w, MIN_W, Math.min(max.w, bounds.width - 2 * MARGIN));
  const h = clampTo(rect?.h ?? DEFAULT_SIZE.h, MIN_H, Math.min(max.h, bounds.height - 2 * MARGIN));
  // Without a saved place the window sits at the bottom-left, above the area's own controls.
  const x = rect ? rect.x : MARGIN;
  const y = rect ? rect.y : bounds.height - h - MARGIN;
  return {
    w,
    h,
    x: clampTo(x, MARGIN, bounds.width - w - MARGIN),
    y: clampTo(y, MARGIN, bounds.height - h - MARGIN - reserve),
  };
}

/** The person has not put the window anywhere: no saved place, or an older one with only a size. */
export const unplaced = (rect: Rect | null) => !rect || !Number.isFinite(rect.y);

export function clampDock(width: number, bounds: Bounds): number {
  return clampTo(width, DOCK_MIN, Math.floor(bounds.width * DOCK_MAX_SHARE));
}

/** Arrow keys on the resize handle: right and up grow the window, as dragging the corner does. */
export function keyResize(rect: Rect, key: string, large: boolean, bounds: Bounds): Rect | null {
  const step = large ? KEY_STEP_LARGE : KEY_STEP;
  const delta: Record<string, [number, number]> = {
    ArrowRight: [step, 0],
    ArrowLeft: [-step, 0],
    ArrowUp: [0, step],
    ArrowDown: [0, -step],
  };
  const d = delta[key];
  if (!d) return null;
  // The handle is the top-right corner: growing upward keeps the bottom edge where it is.
  const bottom = rect.y + rect.h;
  const next = clampRect({ ...rect, w: rect.w + d[0], h: rect.h + d[1] }, bounds);
  return { ...next, y: clampTo(bottom - next.h, MARGIN, bounds.height - next.h - MARGIN) };
}

export function parsePrefs(raw: string | null): WindowPrefs {
  try {
    const v = JSON.parse(raw ?? 'null') as Record<string, unknown> | null;
    if (!v || typeof v !== 'object') return DEFAULT_PREFS;
    const num = (key: string) =>
      typeof v[key] === 'number' && Number.isFinite(v[key]) ? (v[key] as number) : null;
    const w = num('w');
    const h = num('h');
    const x = num('x');
    const y = num('y');
    return {
      rect:
        w !== null && h !== null
          ? { w, h, x: x ?? MARGIN, y: y ?? Number.POSITIVE_INFINITY }
          : null,
      docked: v.docked === true,
      dockWidth: num('dockWidth') ?? DEFAULT_PREFS.dockWidth,
      collapsed: v.collapsed === true,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function serializePrefs(prefs: WindowPrefs): string {
  return JSON.stringify({
    ...(prefs.rect ?? {}),
    docked: prefs.docked,
    dockWidth: prefs.dockWidth,
    collapsed: prefs.collapsed,
  });
}
