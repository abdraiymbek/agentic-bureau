export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export const right = (r: Rect) => r.x + r.w;
export const bottom = (r: Rect) => r.y + r.h;

/** True when the two rectangles share interior area; touching edges do not count. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a);
}

/** True when the segment a–b passes through the interior of the rectangle (Liang–Barsky). */
export function segmentCrossesRect(a: Point, b: Point, r: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const edges: [number, number][] = [
    [-dx, a.x - r.x],
    [dx, right(r) - a.x],
    [-dy, a.y - r.y],
    [dy, bottom(r) - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q <= 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 >= t1) return false;
  }
  return true;
}
