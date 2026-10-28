// Shots 14–15, the apex. "agents propose." rises on graphite over the agent's
// recorded calls (tool · object, pre-blurred, stepping up on the four-note
// rise), with the live agent top-right. Hard cut on the 20.0 downbeat to Paper:
// "people decide.", present on the cut, alone on a dot grid. The thread is the
// underline in both: it parts around descenders, and around letters as they rise
// through it (skip-ink from each word's measured ink), and at 20.5 it gains its
// open chevron at the consequence end. Both phrases hang on the same optical
// left edge and baseline, so the cut swaps the words in place.
import { E, ez, lerp, prog, rng, show } from '../lib/core.js';
import { threadY } from '../lib/film.js';

let S;

const CUT = 20; // the downbeat: graphite → Paper
const CHEV = 20.5; // the thread gains its chevron
const END = 22.5;
const RISE = 0.42; // per word: settled well before the cut
const STEPS = [19, 19.25, 19.5, 19.75]; // the four-note rise: the ledger steps up a row on each
const RS = 0.5; // the ledger is only ever seen out of focus: it renders at half resolution

// The calls on the rover's record, in order: real ops (crates/contracts/registry.json)
// on objects from the record. The build follows fixtures/rover/rover.fixture.ts
// op for op; the tail is the payload proposal (scripts/design-preview.ts) as the
// agent guides run it (crates/agent-host/guides/start.md, review.md).
const CALLS = [
  ['project.summary', 'Sable inspection rover'],
  ['artifact.create_draft', 'Payload capacity'],
  ['artifact.create_draft', 'Endurance'],
  ['artifact.create_draft', 'Wheel radius (loaded)'],
  ['source.capture', 'LiPo 2S 450 mAh pack (supplier listing)'],
  ['source.capture', 'Pololu DRV8835 dual motor driver carrier'],
  ['source.capture', 'Raspberry Pi Camera Module 3 Wide'],
  ['component.add_candidate', 'Raspberry Pi Zero 2 W'],
  ['component.compare', 'Micro Metal Gearmotor HP 6V 100:1'],
  ['component.propose_selection', 'Raspberry Pi Camera Module 3 Wide'],
  ['artifact.create_draft', 'Camera tray'],
  ['calculation.run', 'Rover mass budget'],
  ['calculation.run', 'Wheel torque at 15° incline'],
  ['calculation.run', 'Electrical power budget'],
  ['calculation.run', 'Usable pack energy'],
  ['artifact.create_draft', 'Power + signal wiring'],
  ['test.create_draft', 'Ramp traverse with payload'],
  ['artifact.create_draft', 'Chassis assembly'],
  ['artifact.read', 'System architecture'],
  ['artifact.history', 'Payload capacity'],
  ['artifact.update_draft', 'Payload capacity'],
  ['proposal.submit', 'Payload capacity'],
  ['proposal.wait', 'Payload capacity'],
];

// Per-format layout. Headline: Geist 600, optical left edge x, baselines just above the thread.
function layout(ctx) {
  const thr = threadY(ctx);
  if (ctx.portrait) {
    const size = 200;
    const gap = Math.round(size * 0.09);
    return {
      thr, size, x: 80,
      lines: [[thr - gap - size], [thr - gap]], // baselines
      split: true,
      tipX: 80 + 24 * 38, // the chevron's tip lands on a grid column
      rows: { font: 24, lh: 52, cols: [{ x: 60, w: 500, blur: [2.6, 7], alpha: 0.3, speed: 34, ofs: 0 }, { x: 600, blur: [1.2, 3.4], alpha: 0.36, speed: 52, ofs: 9 }] },
      agent: { right: 80, top: 260, size: 34 }, // below the 220 px band where feed apps draw their tabs
      lift: '62% 52% at 38% 46%',
    };
  }
  const size = 180;
  const gap = Math.round(size * 0.09);
  return {
    thr, size, x: 160,
    lines: [[thr - gap]],
    split: false,
    tipX: 160 + 24 * 67,
    rows: { font: 22, lh: 48, cols: [{ x: 150, w: 790, blur: [2.6, 7], alpha: 0.3, speed: 30, ofs: 0 }, { x: 980, blur: [1.2, 3.4], alpha: 0.36, speed: 46, ofs: 11 }] },
    agent: { right: 160, top: 96, size: 30 },
    lift: '58% 62% at 36% 48%',
  };
}

export default function create(span) {
  return {
    id: 'hero',
    span,
    css: `
#s-hero .plate { position: absolute; inset: 0; overflow: hidden; }
#s-hero .g { background: #0b0c0e; }
#s-hero .p { background: #ebecee; }
#s-hero .lift { position: absolute; inset: 0; }
#s-hero .p .lift { left: -10%; right: -10%; will-change: transform; }
#s-hero .push { position: absolute; inset: 0; }
#s-hero .rows { position: absolute; inset: 0; width: 100%; height: 100%; }
#s-hero .grid { position: absolute; left: 0; top: 0; }
#s-hero .ln { position: absolute; left: 0; top: 0; font-family: var(--font-sans); font-weight: 600; line-height: 1;
  letter-spacing: -0.035em; white-space: nowrap; font-kerning: normal; }
#s-hero .g .ln { color: #ededee; }
#s-hero .p .ln { color: #141518; }
#s-hero .ln .w { display: inline-block; overflow: hidden; vertical-align: top; padding: 0.02em 0.05em 0; margin: -0.02em -0.05em 0; }
#s-hero .ln .w > span { display: inline-block; }
#s-hero .thr { position: absolute; left: 0; }
#s-hero .agent { position: absolute; display: flex; align-items: center; gap: 0.5em; font: 500 30px/1 var(--font-sans);
  letter-spacing: -0.01em; color: #a4a7ae; white-space: nowrap; }
#s-hero .agent .dot { position: relative; width: 0.4em; height: 0.4em; flex: none; }
#s-hero .agent .dot i, #s-hero .agent .dot b { position: absolute; inset: 0; border-radius: 50%; background: #cff36e; }
#s-hero .agent .dot i { box-shadow: 0 0 10px 1px rgba(207, 243, 110, 0.55), 0 0 34px 6px rgba(207, 243, 110, 0.12); }
#s-hero .grain { position: absolute; inset: 0; width: 100%; height: 100%; image-rendering: pixelated; }
`,
    build(root, ctx) {
      const L = layout(ctx);
      const { W, H } = ctx;
      const [w1, w2] = L.split ? [['agents'], ['propose.']] : [['agents', 'propose.']];
      const [p1, p2] = L.split ? [['people'], ['decide.']] : [['people', 'decide.']];
      const linesA = L.split ? [w1, w2] : [w1];
      const linesB = L.split ? [p1, p2] : [p1];
      const lineHtml = (ws) => `<div class="ln" style="font-size:${L.size}px">${ws.map((w) => `<span class="w"><span>${w}</span></span>`).join(' ')}</div>`;
      root.innerHTML = `
        <div class="plate g">
          <div class="lift" style="background: radial-gradient(ellipse ${L.lift}, #131417 0%, #0b0c0e 75%)"></div>
          <canvas class="rows" width="${W * RS}" height="${H * RS}"></canvas>
          <div class="push">${linesA.map(lineHtml).join('')}<canvas class="thr" width="${W}" height="64"></canvas></div>
          <div class="agent" style="font-size:${L.agent.size}px"><span class="dot"><b></b><i></i></span><span>Agent</span></div>
        </div>
        <div class="plate p">
          <div class="lift" style="background: radial-gradient(ellipse ${L.lift}, #f6f6f7 0%, #ebecee 78%)"></div>
          <div class="push"><canvas class="grid" width="${W}" height="${H}"></canvas>${linesB.map(lineHtml).join('')}<canvas class="thr" width="${W}" height="64"></canvas></div>
          <canvas class="grain" width="${Math.round(W / 3)}" height="${Math.round(H / 3)}"></canvas>
        </div>`;

      const plates = [...root.querySelectorAll('.plate')].map((el) => {
        const push = el.querySelector('.push');
        push.style.transformOrigin = `${L.x}px ${L.thr}px`;
        const thr = el.querySelector('canvas.thr');
        thr.style.top = `${L.thr - 32}px`;
        return { el, push, thr, g: thr.getContext('2d'), words: setLines(el, L), chevLen: L.size * 0.14 };
      });
      // The dot grid, drawn once: 24 px, dots on the text's left edge and on the
      // thread, easing off toward the corners.
      const gg = root.querySelector('.grid').getContext('2d');
      const gcx = W * 0.42;
      const gcy = H * 0.5;
      for (let y = ((L.thr % 24) + 24) % 24; y < H; y += 24) {
        for (let x = ((L.x % 24) + 24) % 24; x < W; x += 24) {
          const e = Math.hypot((x - gcx) / (W * 0.8), (y - gcy) / (H * 0.85));
          gg.globalAlpha = 0.13 * lerp(1, 0.45, E.sine(Math.min(1, Math.max(0, (e - 0.35) / 0.65))));
          gg.beginPath();
          gg.arc(x, y, 1.25, 0, Math.PI * 2);
          gg.fillStyle = '#141518';
          gg.fill();
        }
      }

      // Agent, top-right.
      const agent = root.querySelector('.agent');
      agent.style.right = `${L.agent.right}px`;
      agent.style.top = `${L.agent.top}px`;

      // The ledger: rows drawn once, pre-blurred at two focus distances into
      // offscreen canvases per column; each frame composites them into a single
      // frame-sized canvas, racking from near focus to deep defocus.
      const rowsEl = root.querySelector('.rows');
      const cols = L.rows.cols.map((c) => {
        const n = Math.ceil((H + 900) / L.rows.lh);
        const cw = ctx.portrait ? 980 : 940;
        const pad = 24;
        const off = document.createElement('canvas');
        off.width = cw * RS;
        off.height = (n * L.rows.lh + pad * 2) * RS;
        const og = off.getContext('2d');
        og.scale(RS, RS);
        og.font = `400 ${L.rows.font}px "IBM Plex Mono"`;
        og.textBaseline = 'alphabetic';
        for (let i = 0; i < n; i++) {
          const [tool, obj] = CALLS[(i + c.ofs) % CALLS.length];
          const y = pad + (i + 0.72) * L.rows.lh;
          og.fillStyle = '#848890';
          og.fillText(tool, pad, y);
          const tw = og.measureText(`${tool} `).width;
          og.fillStyle = '#64676f';
          og.fillText(`· ${obj}`, pad + tw, y);
        }
        if (c.w) {
          // A column ends before the next one begins: long rows fade out.
          const fade = og.createLinearGradient(pad + c.w - 110, 0, pad + c.w, 0);
          fade.addColorStop(0, '#000');
          fade.addColorStop(1, 'rgba(0,0,0,0)');
          og.globalCompositeOperation = 'destination-in';
          og.fillStyle = fade;
          og.fillRect(0, 0, cw, off.height / RS);
        }
        const focus = c.blur.map((b) => {
          const cv = document.createElement('canvas');
          cv.width = off.width;
          cv.height = off.height;
          const g = cv.getContext('2d');
          g.filter = `blur(${b * RS}px)`;
          g.drawImage(off, 0, 0);
          return cv;
        });
        return { focus, ...c, pad };
      });

      // Screen-space fade: the ledger dissolves toward the top and bottom.
      const rg = rowsEl.getContext('2d');
      const fade = rg.createLinearGradient(0, 0, 0, H * RS);
      fade.addColorStop(0, 'rgba(0,0,0,0)');
      fade.addColorStop(0.2, '#000');
      fade.addColorStop(0.72, '#000');
      fade.addColorStop(1, 'rgba(0,0,0,0)');
      // …and clears a pool of field around the live agent so it reads alone.
      const ax = (W - L.agent.right - L.agent.size * 1.6) * RS;
      const ay = (L.agent.top + L.agent.size / 2) * RS;
      const pool = rg.createRadialGradient(ax, ay, 0, ax, ay, L.agent.size * 7 * RS);
      pool.addColorStop(0, 'rgba(0,0,0,0.92)');
      pool.addColorStop(0.55, 'rgba(0,0,0,0.6)');
      pool.addColorStop(1, 'rgba(0,0,0,0)');
      S = { L, ctx, plates, agent, paperLift: root.querySelector('.p .lift'), halo: agent.querySelector('.dot b'), rg, fade, pool, cols, grain: root.querySelector('.grain') };
      S.gctx = S.grain.getContext('2d');
      S.img = S.gctx.createImageData(S.grain.width, S.grain.height);
    },
    render(t, ctx) {
      const { L, plates } = S;
      const paper = t >= CUT;
      show(plates[0].el, paper ? 0 : 1);
      show(plates[1].el, paper ? 1 : 0);
      if (!paper) renderPropose(t, plates[0]);
      else renderDecide(t, plates[1], ctx);
    },
    fx(t) {
      // Paper takes the light vignette; its grain is drawn in-scene (multiply).
      if (t >= CUT && t < END) return { vignette: 0.2, grain: 0 };
      return null;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Headline: masked words with measured ink                             */
/* ------------------------------------------------------------------ */

// Build one plate's lines: place each line so its baseline is exact and its ink
// starts on the margin, then profile every word's ink column by column.
function setLines(plate, L) {
  const font = `600 ${L.size}px Geist`;
  const ls = -0.035 * L.size;
  const meas = document.createElement('canvas').getContext('2d');
  meas.font = font;
  meas.letterSpacing = `${ls}px`;
  const push = plate.querySelector('.push');
  const k = push.getBoundingClientRect().width / push.offsetWidth || 1;
  const words = [];
  [...plate.querySelectorAll('.ln')].forEach((ln, li) => {
    const base = L.lines[li][0];
    // Baseline offset inside the line box, from a zero-size baseline probe.
    const probe = document.createElement('i');
    probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
    ln.appendChild(probe);
    const bo = (probe.getBoundingClientRect().top - ln.getBoundingClientRect().top) / k;
    probe.remove();
    // Optical left edge: ink on the margin; round bowls overshoot it a hair.
    const first = ln.textContent.trim();
    const m = meas.measureText(first);
    const round = /^[acdegoq]/.test(first) ? 0.012 * L.size : 0;
    ln.style.left = `${(L.x + m.actualBoundingBoxLeft - round).toFixed(2)}px`;
    ln.style.top = `${(base - bo).toFixed(2)}px`;
    // Each word's mask ends just below its descenders.
    const below = 0.19 * L.size;
    [...ln.querySelectorAll('.w')].forEach((w) => {
      w.style.paddingBottom = `${Math.max(0, below - (L.size - bo)).toFixed(2)}px`;
      w.style.marginBottom = `-${Math.max(0, below - (L.size - bo)).toFixed(2)}px`;
    });
    const pr = push.getBoundingClientRect();
    for (const inner of ln.querySelectorAll('.w > span')) {
      const r = inner.getBoundingClientRect();
      const x = (r.left - pr.left) / k;
      const prof = inkProfile(inner.textContent, font, ls, L.size);
      const maskTop = base - bo - 0.02 * L.size;
      words.push({ inner, x, base, maskTop, maskBot: base + below, ...prof });
    }
  });
  return words;
}

// Column-by-column ink runs of one word, in px relative to its origin/baseline.
function inkProfile(text, font, ls, size) {
  const pad = Math.ceil(size * 0.25);
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  g.font = font;
  g.letterSpacing = `${ls}px`;
  const w = Math.ceil(g.measureText(text).width + pad * 2);
  const base = Math.ceil(size * 1.1);
  c.width = w;
  c.height = Math.ceil(size * 1.5);
  g.font = font;
  g.letterSpacing = `${ls}px`;
  g.fillStyle = '#000';
  g.fillText(text, pad, base);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const cols = [];
  for (let x = 0; x < c.width; x++) {
    const runs = [];
    let a = -1;
    for (let y = 0; y < c.height; y++) {
      const on = d[(y * c.width + x) * 4 + 3] > 60;
      if (on && a < 0) a = y;
      if (!on && a >= 0) {
        runs.push(a - base, y - 1 - base);
        a = -1;
      }
    }
    if (a >= 0) runs.push(a - base, c.height - 1 - base);
    cols.push(runs);
  }
  return { cols, pad };
}

// Gaps the thread leaves around ink crossing it (skip-ink), in plate px.
// Gaps closer than `bridge` merge, so a word rising through the line opens one
// clean gap instead of leaving slivers of thread in its counters.
function inkGaps(words, thr, clear, dil, bridge) {
  const lo = thr - clear;
  const hi = thr + clear;
  const gaps = [];
  for (const w of words) {
    if (!w.on) continue;
    let run = -1;
    const n = w.cols.length;
    for (let i = 0; i <= n; i++) {
      let hit = false;
      if (i < n) {
        const c = w.cols[i];
        for (let j = 0; j < c.length; j += 2) {
          const a = Math.max(w.base + c[j] + w.y, w.maskTop);
          const b = Math.min(w.base + c[j + 1] + w.y, w.maskBot);
          if (a < b && a <= hi && b >= lo) {
            hit = true;
            break;
          }
        }
      }
      if (hit && run < 0) run = i;
      else if (!hit && run >= 0) {
        gaps.push([w.x + run - w.pad - dil, w.x + i - w.pad + dil]);
        run = -1;
      }
    }
  }
  gaps.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const g of gaps) {
    const last = out[out.length - 1];
    if (last && g[0] <= last[1] + bridge) last[1] = Math.max(last[1], g[1]);
    else out.push([...g]);
  }
  return out;
}

// The thread on its strip canvas: 1.5 px, minus the gaps, plus an optional chevron.
function drawThread(p, { color, spans, gaps, chev = 0, tipX = 0 }) {
  const { g } = p;
  const W = p.thr.width;
  g.clearRect(0, 0, W, 64);
  g.fillStyle = color;
  for (const [from, to] of spans) {
    let x = from;
    for (const [a, b] of gaps) {
      if (b <= x) continue;
      if (a >= to) break;
      if (a > x) g.fillRect(x, 31.25, a - x, 1.5);
      x = Math.max(x, b);
    }
    if (x < to) g.fillRect(x, 31.25, to - x, 1.5);
  }
  if (chev > 0) {
    // Open chevron: two arms opening from the tip, the product's 0.6 rad.
    const len = p.chevLen * E.cubicOut(chev);
    const ang = lerp(0.2, 0.6, E.expoOut(chev));
    g.strokeStyle = color;
    g.lineWidth = 1.5;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(tipX - Math.cos(ang) * len, 32 - Math.sin(ang) * len);
    g.lineTo(tipX, 32);
    g.lineTo(tipX - Math.cos(ang) * len, 32 + Math.sin(ang) * len);
    g.stroke();
  }
}

/* ------------------------------------------------------------------ */
/* Shot 14 · agents propose. (graphite)                                 */
/* ------------------------------------------------------------------ */

function renderPropose(t, p) {
  const { L, ctx, cols } = S;
  const l = t - 19;
  // Words rise out of their masks 1/8 s apart; the thread parts as they cross it.
  p.words.forEach((w, i) => {
    const at = 19 + i * 0.125;
    const k = prog(t, at, at + RISE);
    w.on = t >= at;
    w.y = (1 - E.expoOut(k)) * L.size * 1.12;
    w.inner.style.visibility = w.on ? 'visible' : 'hidden';
    w.inner.style.transform = `translate3d(0,${w.y.toFixed(2)}px,0)`;
  });
  p.push.style.transform = `scale(${lerp(1, 1.03, E.sineOut(prog(t, 19, CUT))).toFixed(5)})`;
  drawThread(p, { color: '#ededee', spans: [[0, ctx.W]], gaps: inkGaps(p.words, L.thr, L.size * 0.05, L.size * 0.055, L.size * 0.24) });

  // The ledger drifts up and steps one row on each note of the rise.
  const steps = STEPS.reduce((s, a) => s + E.expoOut(prog(t, a, a + 0.22)), 0);
  const { rg, fade, pool } = S;
  const sc = lerp(1, 1.012, E.sineOut(prog(t, 19, CUT))); // far plane: pushes less than the type
  rg.setTransform(1, 0, 0, 1, 0, 0);
  rg.globalCompositeOperation = 'source-over';
  rg.clearRect(0, 0, ctx.W, ctx.H);
  rg.setTransform(sc * RS, 0, 0, sc * RS, L.x * (1 - sc) * RS, L.thr * (1 - sc) * RS);
  // Rack focus: the calls are near-legible on the cut, then fall out of focus as
  // the words land.
  const rack = ez(t, 19.08, 19.6, E.cubicInOut);
  cols.forEach((c, i) => {
    const y = -c.pad - 120 - l * c.speed - steps * L.rows.lh * (i ? 1 : 0.6);
    c.focus.forEach((cv, j) => {
      const a = c.alpha * (j ? rack : 1 - rack);
      if (a < 0.002) return;
      rg.globalAlpha = a;
      rg.drawImage(cv, c.x - c.pad, y, cv.width / RS, cv.height / RS);
    });
  });
  rg.setTransform(1, 0, 0, 1, 0, 0);
  rg.globalAlpha = 1;
  rg.globalCompositeOperation = 'destination-in';
  rg.fillStyle = fade;
  rg.fillRect(0, 0, ctx.W, ctx.H);
  rg.globalCompositeOperation = 'destination-out';
  rg.fillStyle = pool;
  rg.fillRect(0, 0, ctx.W, ctx.H);
  rg.globalCompositeOperation = 'source-over';

  // Live agent: the halo breathes on the beat.
  const ph = (((t - 19) / 0.5) % 1 + 1) % 1;
  S.halo.style.transform = `scale(${(1 + E.cubicOut(ph) * 1.6).toFixed(3)})`;
  S.halo.style.opacity = (0.5 * (1 - E.sineOut(ph))).toFixed(3);
}

/* ------------------------------------------------------------------ */
/* Shot 15 · people decide. (Paper)                                     */
/* ------------------------------------------------------------------ */

function renderDecide(t, p, ctx) {
  const { L } = S;
  p.words.forEach((w) => {
    w.on = true;
    w.y = 0;
    w.inner.style.visibility = 'visible';
    w.inner.style.transform = 'none';
  });
  // The light on the Paper drifts toward the consequence end.
  S.paperLift.style.transform = `translate3d(${lerp(-0.03, 0.05, E.sine(prog(t, CUT, END))) * ctx.W}px,0,0)`;
  // Hold, then push in toward the start of the sentence.
  const k = prog(t, CHEV, END);
  p.push.style.transform = `scale(${lerp(1, 1.03, 1 - Math.cos((k * Math.PI) / 2)).toFixed(5)})`;
  // At 20.5 the thread resolves into a direction: the tail beyond the tip clears
  // to the right and the chevron's arms open.
  const c = prog(t, CHEV, CHEV + 0.32);
  const tail = t < CHEV ? 0 : E.expoOut(prog(t, CHEV, CHEV + 0.45));
  drawThread(p, {
    color: '#141518',
    spans: [[0, L.tipX], [L.tipX + (ctx.W + 4 - L.tipX) * tail, ctx.W]],
    gaps: inkGaps(p.words, L.thr, L.size * 0.05, L.size * 0.055, L.size * 0.24),
    chev: t >= CHEV ? Math.max(c, 0.001) : 0,
    tipX: L.tipX,
  });
  // Paper grain (the engine's grain screens, which vanishes on Paper): black at
  // a random alpha, the same darkening as a 5 % multiply on the paper field.
  const r = rng(Math.round(t * 120) + 11);
  const d = S.img.data;
  for (let i = 3; i < d.length; i += 4) d[i] = (r() * 12.5) | 0;
  S.gctx.putImageData(S.img, 0, 0);
}
