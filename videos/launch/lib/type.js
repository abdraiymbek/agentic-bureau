// Kinetic type. A line is built from masked words (see core.words); these
// functions set each word's transform, opacity, blur and colour from time.
import { E, clamp, lerp, prog } from './core.js';

/**
 * Reveal (and optionally retire) a run of word spans.
 *
 * spans   inner <span> elements of `.w` wrappers, in reading order
 * at      time the first word starts entering
 * style   'rise'  — slides up out of its mask
 *         'blur'  — resolves from a soft blur, like a lens finding focus
 *         'dim'   — present but dim, each word brightens in turn
 *         'cut'   — appears on its beat with no motion
 * out     time the first word starts leaving (omit to stay)
 * outStyle 'rise' (up and out of the mask), 'blur', 'fade', 'cut'
 */
export function reveal(spans, t, o) {
  const {
    at,
    stagger = 0.055,
    dur = 0.55,
    style = 'rise',
    out = null,
    outStagger = 0.025,
    outDur = 0.32,
    outStyle = 'rise',
    dimFrom = 0.28,
    distance = 1.08,
  } = o;
  spans.forEach((s, i) => {
    const k = prog(t, at + i * stagger, at + i * stagger + dur);
    let y = 0;
    let op = 1;
    let blur = 0;
    let scale = 1;
    let bright = 1;
    if (style === 'rise') {
      y = (1 - E.expoOut(k)) * distance * 100;
      op = k > 0 ? 1 : 0;
    } else if (style === 'blur') {
      const e = E.cubicOut(k);
      op = e;
      blur = (1 - e) * 18;
      scale = lerp(1.06, 1, E.expoOut(k));
    } else if (style === 'dim') {
      op = t >= at - 0.001 ? 1 : 0;
      bright = lerp(dimFrom, 1, E.cubicOut(k));
    } else if (style === 'cut') {
      op = t >= at + i * stagger ? 1 : 0;
    }
    if (out != null) {
      const ko = prog(t, out + i * outStagger, out + i * outStagger + outDur);
      if (outStyle === 'rise') y -= E.expoIn(ko) * distance * 100;
      else if (outStyle === 'blur') {
        op *= 1 - E.cubicIn(ko);
        blur += E.cubicIn(ko) * 18;
      } else if (outStyle === 'fade') op *= 1 - ko;
      else if (outStyle === 'cut') op *= ko > 0 ? 0 : 1;
    }
    s.style.transform = `translate3d(0,${y.toFixed(2)}%,0)${scale !== 1 ? ` scale(${scale.toFixed(4)})` : ''}`;
    s.style.opacity = clamp(op).toFixed(4);
    s.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : 'none';
    if (style === 'dim') s.style.opacity = (clamp(op) * bright).toFixed(4);
  });
}

/** Characters typed one at a time into `el`, with an optional caret element. */
export function typeOn(el, text, t, at, cps = 38, caret = null, blinkAfter = true) {
  const n = clamp(Math.floor((t - at) * cps), 0, text.length);
  el.textContent = t < at ? '' : text.slice(0, n);
  if (caret) {
    const typing = t >= at && n < text.length;
    const on = typing || (blinkAfter && Math.floor(t * 2.2) % 2 === 0) || t < at;
    caret.style.opacity = on ? '1' : '0';
  }
  return n >= text.length;
}
