// End card: the mark appears (never animated — it cuts in under the point of
// light that ends the previous shot), the wordmark rises letter by letter, the
// three Lens verbs land on the beat, and a factual line says where it runs and
// where to get it.
import { E, ez, clamp, mark, letters, words, show, $$, MARK_VIEWBOX } from '../lib/core.js';
import { reveal } from '../lib/type.js';

let S;

// converge.js contracts the machine into a point of light at these coordinates
// (its L.apex, measured from this card). The mark's apex is pinned here in
// build(), so type changes on the card never move the point the cut lands on.
const APEX = { landscape: [570.7, 469.5], portrait: [540, 710.6] };
const APEX_VB = [250, 84]; // the mark's apex in MARK_VIEWBOX units

const CTA_AT = 1.7; // 25.7: the call to action, after the last tagline bell
const URL_AT = 1.825; // the address lands a sixteenth later, sharp

export default function create(span) {
  const [T0, T1] = span;
  return {
    id: 'end',
    span,
    css: `
#s-end { background: var(--field); }
#s-end .lockup { position: absolute; left: 50%; top: 50%; display: flex; align-items: center; gap: 72px; transform: translate(-50%, -62%); }
#s-end .mark { width: 132px; height: 132px; color: var(--text); flex: none; }
/* Set exactly as title.js sets the wordmark: display tracking, 0.22em word gap,
   pair kerning restored in build() (the per-letter masks would drop it). */
#s-end .word { font: 600 142px/1 var(--font-sans); letter-spacing: -0.032em; white-space: nowrap; display: flex; gap: 0.22em; }
#s-end .word > span { position: relative; }
#s-end .word .flow { font-weight: 400; color: var(--text-2); }
/* The rise only needs a vertical mask: side bearings never clip. */
#s-end .word .w { overflow: visible; clip-path: inset(0 -0.3em); }
#s-end .kern { position: absolute; left: 0; top: 0; visibility: hidden; white-space: nowrap; }
#s-end .tag { position: absolute; left: 50%; top: 50%; transform: translate(-50%, 92px); font: 400 38px/1.2 var(--font-sans); letter-spacing: -0.02em; color: var(--text); white-space: nowrap; display: flex; gap: 0.42em; }
#s-end .cta { position: absolute; left: 50%; bottom: 120px; transform: translateX(-50%); font: 400 25px/1 var(--font-mono); color: var(--text-2); white-space: nowrap; display: flex; flex-direction: column; align-items: center; gap: 20px; }
#s-end .cta .l1, #s-end .cta .plat { display: flex; gap: 18px; align-items: center; }
#s-end .cta .l2 { font-size: 28px; color: var(--text); letter-spacing: 0; }
#s-end .cta i { width: 4px; height: 4px; border-radius: 50%; background: var(--text-3); flex: none; }
#s-end .grain { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0.05; pointer-events: none; }
#s-end.portrait .lockup { flex-direction: column; gap: 84px; transform: translate(-50%, -66%); }
#s-end.portrait .mark { width: 168px; height: 168px; }
#s-end.portrait .word { font-size: 150px; }
#s-end.portrait .tag { flex-direction: column; align-items: center; gap: 2px; font-size: 50px; transform: translate(-50%, 150px); }
/* Clear of the bottom caption zone (≈ 380 px) that platform UI covers in 9:16. */
#s-end.portrait .cta { bottom: 412px; font-size: 32px; gap: 14px; }
#s-end.portrait .cta .l1 { flex-direction: column; gap: 14px; }
#s-end.portrait .cta .l1 > i { display: none; }
#s-end.portrait .cta .l2 { font-size: 34px; margin-top: 12px; }
`,
    build(root, ctx) {
      root.classList.toggle('portrait', ctx.portrait);
      const { W, H } = ctx;
      root.innerHTML = `
        <div class="lockup">${mark()}<div class="word"><span class="omen">${letters('Omen')}</span><span class="flow">${letters('Flow')}</span></div></div>
        <div class="tag"><span class="s">${words('See the whole.')}</span><span class="s">${words('Focus on one.')}</span><span class="s">${words('Decide.')}</span></div>
        <div class="cta"><div class="l1"><span>Free and open source</span><i></i><span class="plat"><span>macOS (Apple Silicon)</span><i></i><span>Linux preview</span></span></div><div class="l2">github.com/abdraiymbek/omen-flow</div></div>
        <canvas class="grain" width="${W / 2}" height="${H / 2}"></canvas>`;
      const stage = root.parentElement ?? root;
      const sr = stage.getBoundingClientRect();
      const k = sr.width / W || 1;
      const local = (el) => {
        const b = el.getBoundingClientRect();
        return { x: (b.left - sr.left) / k, y: (b.top - sr.top) / k, w: b.width / k, h: b.height / k };
      };

      // Kerning: lay each half of the name out as plain text, read where every
      // glyph starts, and shift the letter masks onto those positions.
      for (const part of $$('.word > span', root)) {
        const masks = $$('.w', part);
        const probe = document.createElement('span');
        probe.className = 'kern';
        probe.textContent = masks.map((m) => m.textContent).join('');
        part.appendChild(probe);
        const node = probe.firstChild;
        const range = document.createRange();
        const px = parseFloat(getComputedStyle(part).fontSize);
        let prev = 0;
        masks.forEach((m, i) => {
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const want = range.getBoundingClientRect().left;
          const have = m.firstElementChild.getBoundingClientRect().left;
          const d = (want - have) / k + prev; // `have` already includes earlier shifts
          m.style.marginLeft = `${(-0.02 * px + d - prev).toFixed(3)}px`;
          prev = d;
        });
        probe.remove();
      }

      // Pin the mark's apex to the point converge.js lands on.
      const lockup = root.querySelector('.lockup');
      const mk = local(root.querySelector('.mark'));
      const [vx, vy, vw] = MARK_VIEWBOX.split(' ').map(Number);
      const s = mk.w / vw;
      const [ax, ay] = APEX[ctx.portrait ? 'portrait' : 'landscape'];
      lockup.style.marginLeft = `${(ax - (mk.x + (APEX_VB[0] - vx) * s)).toFixed(3)}px`;
      lockup.style.marginTop = `${(ay - (mk.y + (APEX_VB[1] - vy) * s)).toFixed(3)}px`;

      const grain = root.querySelector('.grain');
      const gctx = grain.getContext('2d');
      const img = gctx.createImageData(grain.width, grain.height);
      S = {
        mark: root.querySelector('.mark'),
        letters: $$('.word .w > span', root),
        sentences: $$('.tag .s', root).map((el) => $$('.w > span', el)),
        l1: root.querySelector('.cta .l1'),
        l2: root.querySelector('.cta .l2'),
        gctx,
        img,
        px: new Uint32Array(img.data.buffer),
      };
    },
    render(t) {
      const l = t - T0;
      // The mark simply appears, under the point of light that ends the previous shot.
      S.mark.style.opacity = l >= 0 ? '1' : '0';
      reveal(S.letters, l, { at: 0.08, stagger: 0.035, dur: 0.7, style: 'rise' });
      S.sentences.forEach((spans, i) => reveal(spans, l, { at: 0.5 + i * 0.4, stagger: 0.05, dur: 0.6, style: 'blur' }));
      // The call to action fades up without blur, so the address lands sharp.
      [
        [S.l1, CTA_AT],
        [S.l2, URL_AT],
      ].forEach(([el, at]) => {
        const c = ez(l, at, at + 0.6, E.cubicOut);
        show(el, c);
        el.style.transform = c < 1 ? `translate3d(0,${((1 - c) * 8).toFixed(2)}px,0)` : 'none';
      });
      drawGrain(S, t);
    },
    // The card holds still for seconds, so the engine's looping grain would
    // shimmer at 5 Hz here: this scene draws its own, fresh every 1/120 s.
    fx(t) {
      return t >= T0 && t < T1 ? { grain: 0 } : null;
    },
  };
}

/**
 * Film grain for the hold: white specks at a random alpha, a new field every
 * 1/120 s (seeded by the frame index, so it is a pure function of t), drawn at
 * half resolution and smoothed on upscale so it reads as fine grain. Same
 * strength and mean lift as the engine's (uniform alpha at 5 % opacity).
 */
function drawGrain(S, t) {
  let x = Math.imul(Math.round(t * 120) + 0x51ed, 0x9e3779b1);
  x ^= x >>> 15;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = x | 0 || 1;
  const p = S.px;
  for (let i = 0; i < p.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    p[i] = (x & 0xff000000) | 0xffffff; // RGBA bytes: white, alpha = top byte
  }
  S.gctx.putImageData(S.img, 0, 0);
}
