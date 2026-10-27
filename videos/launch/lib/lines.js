// A field of short line segments drawn on a 2D canvas. Each segment has a loose
// "scattered" pose and an exact "settled" pose; a wave front sweeping across the
// frame snaps them from one to the other — order arriving out of chaos.
import { E, clamp, lerp, rng, noise1 } from './core.js';

/**
 * targets: [{ x, y, a, len }] settled poses (a = angle in radians).
 * Returns { segs, draw(ctx2d, t, opts) }.
 */
export function createLineField(targets, { seed = 11, W, H, spread = 1, jitterLen = 0.35 } = {}) {
  const r = rng(seed);
  const segs = targets.map((tg, i) => ({
    ...tg,
    sx: tg.x + (r() - 0.5) * 220 * spread,
    sy: tg.y + (r() - 0.5) * 160 * spread,
    sa: tg.a + (r() - 0.5) * Math.PI * 1.6,
    sl: tg.len * (1 - jitterLen + r() * jitterLen * 2),
    seed: r() * 1000,
    delay: r(),
    i,
  }));
  return {
    segs,
    /**
     * k(seg) → settle progress 0..1 for a segment (use waveK for a sweeping front).
     * drift: how much unsettled segments wander (px), t: time for the wander.
     */
    draw(g, t, { k, color = '#ededee', width = 3, alpha = 1, drift = 18, cap = 'butt', settleColor = null } = {}) {
      g.lineCap = cap;
      g.lineWidth = width;
      for (const s of segs) {
        const p = clamp(k(s));
        const e = E.expoOut(p);
        const wx = noise1(t * 0.9 + s.seed, 1) * drift * (1 - e);
        const wy = noise1(t * 0.9 + s.seed, 2) * drift * (1 - e);
        const wa = noise1(t * 0.6 + s.seed, 3) * 0.4 * (1 - e);
        const x = lerp(s.sx, s.x, e) + wx;
        const y = lerp(s.sy, s.y, e) + wy;
        const a = lerp(s.sa, s.a, e) + wa;
        const L = lerp(s.sl, s.len, e) / 2;
        const dx = Math.cos(a) * L;
        const dy = Math.sin(a) * L;
        g.globalAlpha = alpha * (s.alpha ?? 1);
        g.strokeStyle = settleColor && p >= 1 ? settleColor : color;
        g.beginPath();
        g.moveTo(x - dx, y - dy);
        g.lineTo(x + dx, y + dy);
        g.stroke();
      }
      g.globalAlpha = 1;
    },
  };
}

/** Progress of a sweeping front: segments left of `front` (px) settle over `width` px, with per-segment delay. */
export const waveK = (front, width = 420, delay = 0.35) => (s) => (front - s.x - s.delay * width * delay) / width;

/** Edges of a regular grid as targets: every cell contributes its top and left edge. */
export function gridTargets(W, H, cell, gap = 14, inset = 0) {
  const out = [];
  const cols = Math.ceil((W - inset * 2) / cell) + 1;
  const rows = Math.ceil((H - inset * 2) / cell) + 1;
  const x0 = (W - (cols - 1) * cell) / 2;
  const y0 = (H - (rows - 1) * cell) / 2;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const x = x0 + i * cell;
      const y = y0 + j * cell;
      out.push({ x: x + cell / 2, y, a: 0, len: cell - gap, row: j, col: i, kind: 'h' });
      out.push({ x, y: y + cell / 2, a: Math.PI / 2, len: cell - gap, row: j, col: i, kind: 'v' });
    }
  return out;
}
