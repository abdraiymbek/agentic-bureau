// Film-wide constants and the thread: one horizontal hairline that runs through
// every shot at the same height, so hard cuts read as match cuts on the spine.
import { E, clamp, lerp, prog } from './core.js';

/** The thread's height in each format. */
export const threadY = (ctx) => (ctx.portrait ? 960 : 540);

/** Shared headline slot (Geist 600) per format. */
export const headline = (ctx) =>
  ctx.portrait ? { x: 80, y: 360, size: 108 } : { x: 160, y: 230, size: 96 };

/** Margins per format. */
export const margin = (ctx) => (ctx.portrait ? 80 : 160);

export const THREAD_CSS = `
.thread { position: absolute; left: 0; height: 0; pointer-events: none; }
.thread .ln { position: absolute; left: 0; top: -0.75px; height: 1.5px; background: var(--thread-color, #ededee); transform-origin: 0 50%; }
.thread .hd { position: absolute; top: 0; width: 6px; height: 6px; margin: -3px 0 0 -3px; border-radius: 50%; background: #fff;
  box-shadow: 0 0 10px 2px rgba(255,255,255,0.9), 0 0 60px 18px rgba(255,255,255,0.22), 0 0 140px 40px rgba(255,255,255,0.08); }
.paper .thread .ln { background: var(--thread-color, #141518); }
.paper .thread .hd { background: #141518; box-shadow: none; }
`;

/** Create a thread element inside `root`; returns { el, set }. */
export function createThread(root, ctx, { y = threadY(ctx), color = null } = {}) {
  const el = document.createElement('div');
  el.className = 'thread';
  el.style.top = `${y}px`;
  el.style.width = `${ctx.W}px`;
  if (color) el.style.setProperty('--thread-color', color);
  el.innerHTML = '<div class="ln"></div><div class="hd"></div>';
  root.appendChild(el);
  const ln = el.querySelector('.ln');
  const hd = el.querySelector('.hd');
  return {
    el,
    /**
     * from/to in px along the line; alpha 0..1; head at `to` with headAlpha; fade
     * makes the line fall off behind the head over `fade` px (0 = solid).
     */
    set({ from = 0, to = ctx.W, alpha = 1, headAlpha = 0, fade = 0, color: c = null, y: yy = null } = {}) {
      const w = Math.max(0, to - from);
      ln.style.left = `${from.toFixed(2)}px`;
      ln.style.width = `${w.toFixed(2)}px`;
      ln.style.opacity = clamp(alpha).toFixed(3);
      ln.style.background = c ?? '';
      ln.style.maskImage = fade > 0 ? `linear-gradient(90deg, rgba(0,0,0,0.35) ${Math.max(0, w - fade)}px, #000 ${w}px)` : 'none';
      ln.style.webkitMaskImage = ln.style.maskImage;
      hd.style.left = `${to.toFixed(2)}px`;
      hd.style.opacity = clamp(headAlpha).toFixed(3);
      if (yy != null) el.style.top = `${yy}px`;
    },
  };
}

/** Convenience: a head travelling from x0 to x1 over [a, b] with an easing. */
export const travel = (t, a, b, x0, x1, fn = E.expoInOut) => lerp(x0, x1, fn(prog(t, a, b)));
