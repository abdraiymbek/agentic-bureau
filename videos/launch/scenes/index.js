// The launch film's timeline (see ../STORYBOARD.md). Scene order is paint order:
// later scenes paint on top. Each scene file default-exports create(span) →
// scene, where a scene is { id, span: [start, end), paper?, css?, icons?,
// build(root, ctx), render(t, ctx), fx?(t, ctx) } and t is always global film
// time in seconds. Scenes load independently, so one that fails to load shows
// its error in its own slot instead of stopping the film.
import { THREAD_CSS } from '../lib/film.js';
import { clamp, ez, E } from '../lib/core.js';

export const BPM = 120;
export const DURATION = 29;

export const TIMELINE = [
  ['open', [0, 3]],
  ['pieces', [3, 6]],
  ['snap', [6, 8]],
  ['title', [8, 9.5]],
  ['lens', [9.5, 12.5]],
  ['decide', [12.5, 16.5]],
  ['impact', [16.5, 19]],
  ['hero', [19, 22.5]],
  ['converge', [22.5, 24]],
  ['end', [24, 29]],
];

function failed(id, span, err) {
  let label;
  return {
    id,
    span,
    css: `#s-${id} { background: #200; } #s-${id} pre { position: absolute; inset: 40px; font: 400 22px/1.4 var(--font-mono); color: #f3928a; white-space: pre-wrap; }`,
    build(root) {
      root.innerHTML = '<pre></pre>';
      label = root.querySelector('pre');
      label.textContent = `${id}.js failed to load\n\n${err?.stack ?? err}`;
    },
    render() {},
  };
}

/** Load the scenes; `only` (comma-separated ids) limits the film to those scenes. */
export async function loadScenes(only = null) {
  const keep = only ? new Set(only.split(',')) : null;
  const list = TIMELINE.filter(([id]) => !keep || keep.has(id));
  const scenes = await Promise.all(
    list.map(async ([id, span]) => {
      try {
        const mod = await import(`./${id}.js`);
        return mod.default(span);
      } catch (err) {
        console.error(`[scene ${id}]`, err);
        return failed(id, span, err);
      }
    }),
  );
  scenes[0].css = THREAD_CSS + (scenes[0].css ?? '');
  return scenes;
}

/**
 * Finishing layer per frame. Scenes may contribute through fx(t, ctx), called on
 * every frame (visible or not) so a flash can straddle a cut: flash and black
 * take the maximum, grain and vignette multiply.
 */
export function fx(t, ctx, scenes) {
  const out = { flash: 0, black: 0, grain: 1, vignette: 1 };
  for (const s of scenes) {
    let f = null;
    try {
      f = s.fx?.(t, ctx);
    } catch (err) {
      console.error(`[fx ${s.id}]`, err);
    }
    if (!f) continue;
    out.flash = Math.max(out.flash, f.flash ?? 0);
    out.black = Math.max(out.black, f.black ?? 0);
    out.grain *= f.grain ?? 1;
    out.vignette *= f.vignette ?? 1;
  }
  // Fade to field at the very end.
  out.black = Math.max(out.black, clamp(ez(t, DURATION - 0.8, DURATION, E.cubicInOut)));
  return out;
}
