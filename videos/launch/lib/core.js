// Shared helpers for the launch film. Everything here is a pure function of its
// inputs: scenes compute every property from time alone, so the preview and the
// frame-by-frame render are identical.

/* ------------------------------------------------------------------ */
/* Math                                                                 */
/* ------------------------------------------------------------------ */

export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, k) => a + (b - a) * k;
export const prog = (t, a, b) => clamp((t - a) / (b - a));
export const smooth = (x) => x * x * (3 - 2 * x);

export const E = {
  lin: (x) => x,
  sine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
  sineOut: (x) => Math.sin((Math.PI * x) / 2),
  cubicOut: (x) => 1 - (1 - x) ** 3,
  cubicIn: (x) => x ** 3,
  cubicInOut: (x) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2),
  quartOut: (x) => 1 - (1 - x) ** 4,
  quintOut: (x) => 1 - (1 - x) ** 5,
  quintInOut: (x) => (x < 0.5 ? 16 * x ** 5 : 1 - (-2 * x + 2) ** 5 / 2),
  expoOut: (x) => (x >= 1 ? 1 : 1 - 2 ** (-10 * x)),
  expoIn: (x) => (x <= 0 ? 0 : 2 ** (10 * x - 10)),
  expoInOut: (x) =>
    x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? 2 ** (20 * x - 10) / 2 : (2 - 2 ** (-20 * x + 10)) / 2,
  circOut: (x) => Math.sqrt(1 - (x - 1) ** 2),
  backOut: (x) => 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2,
};

/** Eased progress of t through [a, b]. */
export const ez = (t, a, b, fn = E.expoOut) => fn(prog(t, a, b));

/** Visible between an eased entrance [a, b] and an eased exit [c, d]. */
export const env = (t, a, b, c, d, fi = E.expoOut, fo = E.cubicInOut) =>
  ez(t, a, b, fi) * (1 - ez(t, c, d, fo));

/** Keyframed vector track: keys = [[time, [values…], easing?], …]. */
export function track(t, keys) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1, fn = E.cubicInOut] = keys[i];
    if (t <= t1) {
      const [t0, v0] = keys[i - 1];
      const k = fn(prog(t, t0, t1));
      return v0.map((a, j) => lerp(a, v1[j], k));
    }
  }
  return keys[keys.length - 1][1];
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth deterministic 1D value noise in [-1, 1]. */
export function noise1(x, seed = 0) {
  const i = Math.floor(x);
  const f = x - i;
  const h = (n) => {
    let s = Math.imul((n + seed * 7919) | 0, 0x27d4eb2d);
    s ^= s >>> 15;
    s = Math.imul(s, 0x85ebca6b);
    s ^= s >>> 13;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
  return lerp(h(i), h(i + 1), smooth(f));
}

/** Count a number up with fixed decimals. */
export const count = (v, decimals = 0) => v.toFixed(decimals);

/* ------------------------------------------------------------------ */
/* Design tokens as numbers (for canvas / three.js; CSS uses var(--…))   */
/* ------------------------------------------------------------------ */

export const TOKENS = {
  field: '#0b0c0e',
  surface: '#111214',
  raised: '#17181b',
  raised2: '#1e1f23',
  inset: '#0d0e10',
  text: '#ededee',
  text2: '#a4a7ae',
  text3: '#848890',
  text4: '#64676f',
  signal: '#cff36e',
  signalText: '#d9f68c',
  warn: '#f1bb68',
  ok: '#8fd6aa',
  err: '#f3928a',
  canvasGrid: '#1d1f23',
  canvasGridMajor: '#2a2d33',
  model: '#c9ccd2',
  // Paper
  paperField: '#ebecee',
  paperSurface: '#f6f6f7',
  paperText: '#141518',
  paperText2: '#474b53',
  paperText3: '#656972',
  paperSignalStroke: '#5a7d00',
  paperWarn: '#88570b',
};

/* ------------------------------------------------------------------ */
/* DOM                                                                  */
/* ------------------------------------------------------------------ */

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/** Set opacity and hide fully transparent elements so they cost nothing. */
export function show(el, o) {
  el.style.opacity = o <= 0.001 ? '0' : o >= 0.999 ? '1' : o.toFixed(4);
  el.style.visibility = o <= 0.001 ? 'hidden' : 'visible';
  return o > 0.001;
}

export const px = (v) => `${v.toFixed(2)}px`;

/** Split text into masked words: <span class="w"><span>word</span></span>. */
export const words = (text, cls = 'w') =>
  text
    .split(' ')
    .map((w) => `<span class="${cls}"><span>${w}</span></span>`)
    .join(' ');

/** Split text into masked letters (spaces kept as plain spaces). */
export const letters = (text, cls = 'w') =>
  [...text].map((ch) => (ch === ' ' ? ' ' : `<span class="${cls}"><span>${ch}</span></span>`)).join('');

/* ------------------------------------------------------------------ */
/* Icons and brand                                                      */
/* ------------------------------------------------------------------ */

const ICONS = {};
/** Load Phosphor icons (regular weight unless "name:weight"). */
export async function loadIcons(names) {
  await Promise.all(
    names
      .filter((n) => !(n in ICONS))
      .map(async (n) => {
        const [name, weight = 'regular'] = n.split(':');
        const file = weight === 'regular' ? name : `${name}-${weight}`;
        const res = await fetch(`../node_modules/@phosphor-icons/core/assets/${weight}/${file}.svg`);
        if (!res.ok) throw new Error(`icon ${n} not found`);
        const svg = await res.text();
        ICONS[n] = svg.replace(/<svg[^>]*>/, '').replace('</svg>', '');
      }),
  );
}
/** Inline Phosphor icon; call loadIcons first. */
export const ic = (n, cls = 'ic') => {
  if (!(n in ICONS)) throw new Error(`icon ${n} not loaded`);
  return `<svg class="${cls}" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">${ICONS[n]}</svg>`;
};

/** The Omen mark: three facets. Paths match design-system/brand/omen-mark.svg. */
export const MARK_PATHS = [
  'M241.5 84 L227.2 253 Q225.8 267.5 213.5 276 L70.5 375 Z',
  'M258.5 84 L272.8 253 Q274.2 267.5 286.5 276 L429.5 375 Z',
  'M80 393 L238 325 Q250 318.5 262 325 L420 393 Z',
];
export const MARK_VIEWBOX = '60 48 380 380';
export const mark = (cls = 'mark') =>
  `<svg class="${cls}" viewBox="${MARK_VIEWBOX}" fill="currentColor" stroke="currentColor" stroke-width="5" stroke-linejoin="round" aria-hidden="true">${MARK_PATHS.map((d) => `<path d="${d}"/>`).join('')}</svg>`;

/** Engineering state chip: colour always comes with a word. */
export const state = (tone, label, cls = '') => `<span class="state ${tone} ${cls}"><i></i>${label}</span>`;
