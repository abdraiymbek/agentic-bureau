// Paper title card: the wordmark is already there on the cut (the hit is the
// reveal), its baseline a hair above the thread, which underlines it the way it
// underlines "people decide." in hero.js. Behind it, a field of causal links —
// solid beziers that pinch into a band on the thread left of the name, pass
// behind the name's clear space, fan out to the right and end in open chevrons
// at staggered depths — with light pulses travelling left to right, toward
// consequence. (Dashes would mean "related" in the Lens grammar, so the links
// stay solid.)
import { E, clamp, lerp, rng, prog, smooth } from '../lib/core.js';
import { createThread, threadY } from '../lib/film.js';

let S;

const SIZE = { landscape: 220, portrait: 150 }; // portrait matches the end card's wordmark
const GAP = 0.09; // baseline above the thread, in em (hero's gap)
const CLEAR = [36, 80]; // around the wordmark's ink box: links fully clear inside 36 px, back by 80 (half at 56)
const THREAD_ALPHA = 0.85;

export default function create(span) {
  const [T0, T1] = span;
  return {
    id: 'title',
    span,
    paper: true,
    css: `
#s-title { background: radial-gradient(ellipse 60% 55% at 50% 50%, #f6f6f7 0%, #ebecee 70%); }
#s-title canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
#s-title .push { position: absolute; inset: 0; transform-origin: 50% 50%; }
#s-title .word { position: absolute; left: 0; top: 0; display: flex; gap: 0.22em;
  font: 600 ${SIZE.landscape}px/1 var(--font-sans); letter-spacing: -0.032em; color: #141518; white-space: nowrap; }
#s-title .word .flow { font-weight: 400; color: #474b53; }
#s-title.portrait .word { font-size: ${SIZE.portrait}px; }
`,
    build(root, ctx) {
      root.classList.toggle('portrait', ctx.portrait);
      const { W, H } = ctx;
      const thr = threadY(ctx);
      root.innerHTML = `<div class="push"><canvas width="${W}" height="${H}"></canvas><div class="word"><span class="omen">Omen</span><span class="flow">Flow</span></div></div>`;
      const push = root.querySelector('.push');
      const g = root.querySelector('canvas').getContext('2d');
      const box = placeWord(root.querySelector('.word'), ctx, thr);
      const mask = clearMask(box, W, H);

      // The links: each enters from off the left edge, pinches into a band on the
      // thread just left of the name's clear space, runs behind the name, then fans
      // out and ends in a chevron somewhere in the right fifth of the frame.
      const r = rng(41);
      const n = ctx.portrait ? 110 : 76;
      const pinchX = Math.max(W * 0.06, box.x0 - CLEAR[1] - 16);
      const runX = pinchX + (box.x1 - pinchX) * 0.5; // the band holds behind the name until here
      const bandH = ctx.portrait ? 40 : 28;
      // Where the inputs come from: in 9:16 the left margin is narrow, so they
      // converge from a shorter run of the edge instead of its full height.
      const inSpan = ctx.portrait ? [thr - H * 0.3, thr + H * 0.3] : [-H * 0.15, H * 1.15];
      const zone = [box.y0 - CLEAR[1], box.y1 + CLEAR[1]]; // rows the clear space covers
      const roomRight = box.x1 + CLEAR[1] + 240 < W;
      const links = Array.from({ length: n }, (_, i) => {
        const k = (i + 0.5) / n;
        const y0 = lerp(inSpan[0], inSpan[1], k + (r() - 0.5) * 0.08);
        let y1 = lerp(-H * 0.05, H * 1.05, r() * 0.7 + k * 0.3);
        const yp = thr + (r() - 0.5) * bandH;
        const a = 0.07 + r() * 0.08;
        const w = 1 + (r() < 0.12 ? 0.6 : 0);
        const ph = r();
        const speed = 0.55 + r() * 0.35;
        // Staggered consequence ends, each with its own chevron.
        let hx = W * (0.8 + 0.18 * ph);
        // No chevron may land in the name's clear space: push it past the name when
        // there is room (16:9), otherwise steer the end above or below it (9:16).
        if (y1 > zone[0] && y1 < zone[1]) {
          if (roomRight) hx = Math.max(hx, lerp(box.x1 + CLEAR[1] + 120, W - 24, ph));
          else {
            const mid = (zone[0] + zone[1]) / 2;
            y1 = y1 < mid ? lerp(zone[0] - 150, zone[0], (y1 - zone[0]) / (mid - zone[0])) : lerp(zone[1], zone[1] + 150, (y1 - mid) / (zone[1] - mid));
          }
        }
        const p = [
          [-60, y0],
          [pinchX * 0.55, y0],
          [pinchX * 0.7, yp],
          [pinchX, yp],
          [runX, yp],
          [lerp(runX, hx, 0.5), y1],
          [hx, y1],
        ];
        return { p, a, w, ph, speed, len: pathLength(p) };
      });
      S = { push, g, links, mask, W, H, thread: createThread(push, ctx, { y: thr }) };
    },
    render(t) {
      const l = t - T0;
      const { g, links, mask, W, H } = S;
      g.clearRect(0, 0, W, H);
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.strokeStyle = '#141518';
      for (const k of links) {
        const [a, b, c, d, e, f, h] = k.p;
        g.globalAlpha = k.a;
        g.lineWidth = k.w;
        g.beginPath();
        g.moveTo(...a);
        g.bezierCurveTo(...b, ...c, ...d);
        g.bezierCurveTo(...e, ...f, ...h);
        g.stroke();
        // A pulse travels each link toward consequence: a short brighter stretch
        // whose front runs from the link's start to its chevron.
        const seg = Math.min(110, k.len * 0.07);
        const front = ((((l * k.speed + k.ph) % 1) + 1) % 1) * (k.len + seg);
        g.globalAlpha = Math.min(0.55, k.a * 4);
        g.lineWidth = k.w + 0.6;
        g.setLineDash([seg, k.len + seg]);
        g.lineDashOffset = seg - front;
        g.stroke();
        g.setLineDash([]);
        // Open chevron at the link's own consequence end, along its last tangent.
        const ang = Math.atan2(h[1] - f[1], h[0] - f[0]);
        g.globalAlpha = k.a * 1.6;
        g.lineWidth = k.w;
        g.beginPath();
        g.moveTo(h[0] - Math.cos(ang - 0.6) * 10, h[1] - Math.sin(ang - 0.6) * 10);
        g.lineTo(h[0], h[1]);
        g.lineTo(h[0] - Math.cos(ang + 0.6) * 10, h[1] - Math.sin(ang + 0.6) * 10);
        g.stroke();
      }
      // The name's clear space: the band passes behind it (feathered).
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'destination-out';
      g.drawImage(mask, 0, 0);
      g.globalCompositeOperation = 'source-over';
      // Slow push; the ink thread under the name is there on the cut frame, so the
      // held hairline of the breath continues across the hit.
      S.push.style.transform = `scale(${lerp(1, 1.035, E.sine(prog(t, T0, T1))).toFixed(4)})`;
      S.thread.set({ alpha: THREAD_ALPHA });
    },
  };
}

// Centre the wordmark's ink horizontally and sit its baseline GAP em above the
// thread (measured with a zero-size baseline probe). Returns the ink box.
function placeWord(word, ctx, thr) {
  const size = ctx.portrait ? SIZE.portrait : SIZE.landscape;
  const base = thr - Math.round(size * GAP);
  const omen = word.querySelector('.omen');
  const flow = word.querySelector('.flow');
  const probe = document.createElement('i');
  probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
  omen.appendChild(probe);
  const bo = probe.offsetTop; // offsetParent is .word
  probe.remove();
  const m = document.createElement('canvas').getContext('2d');
  m.letterSpacing = `${-0.032 * size}px`;
  m.font = `600 ${size}px Geist`;
  const mo = m.measureText('Omen');
  m.font = `400 ${size}px Geist`;
  const mf = m.measureText('Flow');
  const left = omen.offsetLeft - mo.actualBoundingBoxLeft;
  const right = flow.offsetLeft + mf.actualBoundingBoxRight;
  const x = ctx.W / 2 - (left + right) / 2;
  word.style.left = `${x.toFixed(2)}px`;
  word.style.top = `${(base - bo).toFixed(2)}px`;
  return {
    x0: x + left,
    x1: x + right,
    y0: base - Math.max(mo.actualBoundingBoxAscent, mf.actualBoundingBoxAscent),
    y1: base + Math.max(mo.actualBoundingBoxDescent, mf.actualBoundingBoxDescent),
  };
}

// Alpha mask of the clear space: opaque within CLEAR[0] of the ink box, feathered
// (smoothstep) to nothing at CLEAR[1]. Built once; composited destination-out.
function clearMask(box, W, H) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const mg = c.getContext('2d');
  const img = mg.createImageData(W, H);
  const [c0, c1] = CLEAR;
  for (let y = 0; y < H; y++) {
    const dy = Math.max(box.y0 - (y + 0.5), 0, y + 0.5 - box.y1);
    if (dy >= c1) continue;
    for (let x = 0; x < W; x++) {
      const dx = Math.max(box.x0 - (x + 0.5), 0, x + 0.5 - box.x1);
      const dd = Math.hypot(dx, dy);
      if (dd >= c1) continue;
      img.data[(y * W + x) * 4 + 3] = Math.round((1 - smooth(clamp((dd - c0) / (c1 - c0)))) * 255);
    }
  }
  mg.putImageData(img, 0, 0);
  return c;
}

// Length of the two cubic segments of a link, sampled.
function pathLength(p) {
  let len = 0;
  for (const [s, c1, c2, e] of [p.slice(0, 4), p.slice(3, 7)]) {
    let [px, py] = s;
    for (let i = 1; i <= 48; i++) {
      const u = i / 48;
      const v = 1 - u;
      const x = v * v * v * s[0] + 3 * v * v * u * c1[0] + 3 * v * u * u * c2[0] + u * u * u * e[0];
      const y = v * v * v * s[1] + 3 * v * v * u * c1[1] + 3 * v * u * u * c2[1] + u * u * u * e[1];
      len += Math.hypot(x - px, y - py);
      px = x;
      py = y;
    }
  }
  return len;
}
