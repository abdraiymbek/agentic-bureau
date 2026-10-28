// Shots 10–11 · the decision. 12.5 cuts to the reference's split: Paper left
// with the record's numbers on the thread, graphite right with the rover on a
// slow turntable. The baseline 0.3 kg is solid ink; the agent's 0.5 kg lands
// hollow at 13.0 (it never tweens) and focus racks back to the baseline. 14.0
// cuts to a graphite macro of the Decision bar, its top edge on the thread: the
// focus ring finds Approve, ⌘↵ goes down, and on the 16.0 downbeat, the press.
import { E, ez, lerp, prog, clamp, noise1, ic, words, $, $$, show } from '../lib/core.js';
import { reveal } from '../lib/type.js';
import { createThread, threadY } from '../lib/film.js';
import { createRoverStage } from '../lib/roverStage.js';

const SPLIT = 12.5; // shot 10
const HOLLOW = 13.0; // the proposal lands
const RACK = [13.4, 13.9];
const BAR = 14.0; // shot 11
const SWAP = 15.0; // "until you approve." (a beat)
const RING = 15.375; // after the phrase has landed, a 16th before ⌘ goes down
const KEYS = [15.5, 15.94];
const PRESS = 16.0;
const LET_GO = PRESS + 0.12; // the camera holds through the press, then lets go
// The bar's notice opens as the button starts back up and is fully open by +0.2;
// its first line is at full opacity from +0.12, so it holds ~0.38 s to the cut.
const NOTICE = [PRESS + 0.04, PRESS + 0.2];
const NOTICE_READ = PRESS + 0.12;

const INK = '#141518';
const PLACEHOLDER = 'Rationale: why this is right, or what must change. Kept in the record.';

// Per-format layout (film px; the bar's own metrics are the app's, scaled by S).
const L = {
  land: {
    sheet: { w: 1075, h: 1080 },
    pane: { x: 1075, y: 0, w: 845, h: 1080 },
    x0: 160,
    vSize: 168,
    row2: 228, // second value's baseline below the thread
    labSize: 30,
    labAbove: 34, // "Baseline · r1": baseline this far above the 0.3 kg cap height
    labBelow: 74, // "Proposed by the agent · r2": baseline below the 0.5 kg baseline
    labGap: 48, // value → pill
    capDy: -262, // caption baseline relative to the thread
    capSize: 30,
    canvasShift: [0, 0],
    rover: { dist: 640, el: 26, az: -38, target: [2, 22, 0], fov: 22, yaw: [-0.17, 0.17], halo: [52, 44] },
    S: 3.1,
    M: [160, 220], // bar content margins (left aligns with the headline)
    edge: [96, 56], // nearest the push may take the content to the frame's left / right
    push: 1.14,
    rel: 1.0,
    hl: { x: 160, y: 230, size: 96, lines: [['nothing becomes the baseline'], ['until you approve.']] },
    // The rail column sits clear of the headline's right end (≈1455) and, at full
    // push, ≥ 80 px below the top and ≥ 56 px inside the right edge.
    railA: { x: 1525, y: 110, r: 1.3, alpha: 0.55 },
    // The standing note stays texture (the frame's words are the headline's), clear of the bar.
    railB: { x: 1525, gap: 26, r: 1.1, w: 276, blur: 5, alpha: 0.45 },
  },
  port: {
    sheet: { w: 1080, h: 1310 },
    pane: { x: 0, y: 1310, w: 1080, h: 610 },
    x0: 80,
    vSize: 176,
    row2: 184, // the 0.3 kg descender clears the 0.5 kg ascender
    labSize: 30,
    labAbove: 34,
    labBelow: 72,
    labGap: 36,
    capDy: -300,
    capSize: 32,
    canvasShift: [60, 10],
    rover: { dist: 380, el: 26, az: -38, target: [2, 22, 0], fov: 22, yaw: [-0.17, 0.17], halo: [50, 44] },
    S: 2.5,
    M: [110, 110],
    edge: [44, 44],
    push: 1.14,
    rel: 1.0,
    hl: { x: 80, y: 360, size: 108, lines: [['nothing becomes', 'the baseline'], ['until you', 'approve.']] },
    railA: { x: 112, y: 560, r: 1.8, alpha: 0.55 },
    railB: { x: 96, y: 1380, r: 2.6, w: 860, blur: 6, alpha: 0.55 },
  },
};

const AFFECTED = [
  ['cube', 'Camera tray'],
  ['calculator', 'Rover mass budget'],
  ['calculator', 'Wheel torque at 15° incline'],
  ['flask', 'Ramp traverse with payload'],
];
const ROW = 42; // the rail's row pitch (app px)
const MEANS =
  'Approval updates the baseline and marks dependents for revisiting. It does not mean the design is validated or fit to build.';

let S;

/** Offset of an element's first baseline from its top edge (measured, unscaled). */
function baselineOf(el) {
  const probe = document.createElement('span');
  probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
  el.appendChild(probe);
  const b = probe.getBoundingClientRect().top - el.getBoundingClientRect().top;
  probe.remove();
  return b;
}

/** Phosphor glyph as a Path2D in its 256 box. */
const glyph = (name) => new Path2D(/d="([^"]+)"/.exec(ic(name))[1]);

function wrap(g, text, width) {
  const out = [];
  let line = '';
  for (const w of text.split(' ')) {
    const next = line ? `${line} ${w}` : w;
    if (g.measureText(next).width > width && line) {
      out.push(line);
      line = w;
    } else line = next;
  }
  if (line) out.push(line);
  return out;
}

/**
 * The right rail, drawn once with the app's copy into a static canvas sized to
 * its content. 'affect' (Would affect 4 and its four dependents) is a sharp
 * plate at 2× so the rail push never softens it; 'means' (What approval means)
 * stays an out-of-focus plate, pre-blurred (no per-frame blur).
 */
function railPlate(part, { r, w = 0, blur = 0 }) {
  const pad = blur * 3;
  const dpr = blur > 0 ? 1 : 2;
  const probe = document.createElement('canvas').getContext('2d');
  // Content box (CSS px): the widest run of copy and the last line's descender.
  let cw;
  let ch;
  let lines = [];
  if (part === 'affect') {
    probe.font = `500 ${13 * r}px Geist`;
    const head = probe.measureText('Would affect 4').width;
    const names = Math.max(...AFFECTED.map(([, title]) => probe.measureText(title).width));
    probe.font = `400 ${11.5 * r}px Geist`;
    const sub = probe.measureText('may be marked out of date').width;
    cw = Math.max(head, 44 * r + Math.max(names, sub));
    ch = ROW * r * AFFECTED.length + 34 * r;
  } else {
    probe.font = `400 ${12.5 * r}px Geist`;
    lines = wrap(probe, MEANS, w);
    const body = Math.max(...lines.map((ln) => probe.measureText(ln).width));
    probe.font = `500 ${12.5 * r}px Geist`;
    cw = Math.max(body, probe.measureText('What approval means').width);
    ch = 40 * r + (lines.length - 1) * 19 * r + 4 * r;
  }
  cw = Math.ceil(cw);
  ch = Math.ceil(ch);
  const sharp = document.createElement('canvas');
  sharp.width = (cw + pad * 2) * dpr;
  sharp.height = (ch + pad * 2) * dpr;
  const g = sharp.getContext('2d');
  g.scale(dpr, dpr);
  g.translate(pad, pad);
  g.textBaseline = 'alphabetic';
  const icon = (name, x, y, size, color) => {
    g.save();
    g.translate(x, y);
    g.scale(size / 256, size / 256);
    g.fillStyle = color;
    g.fill(glyph(name));
    g.restore();
  };
  if (part === 'affect') {
    g.font = `500 ${13 * r}px Geist`;
    g.fillStyle = '#a4a7ae';
    g.fillText('Would affect', 0, 16 * r);
    const wa = g.measureText('Would affect ').width;
    g.fillStyle = '#ededee';
    g.fillText('4', wa, 16 * r);
    AFFECTED.forEach(([ic_, title], i) => {
      const y = ROW * r * (i + 1);
      g.fillStyle = 'rgba(255,255,255,0.14)';
      g.fillRect(0, y + 6 * r, 12 * r, Math.max(1, r * 0.7));
      icon(ic_, 20 * r, y, 15 * r, '#848890');
      g.font = `500 ${13 * r}px Geist`;
      g.fillStyle = '#ededee';
      g.fillText(title, 44 * r, y + 12 * r);
      g.font = `400 ${11.5 * r}px Geist`;
      g.fillStyle = '#848890';
      g.fillText('may be marked out of date', 44 * r, y + 30 * r); // the app's ImpactRail copy
    });
  } else {
    g.font = `500 ${12.5 * r}px Geist`;
    g.fillStyle = '#a4a7ae';
    g.fillText('What approval means', 0, 14 * r);
    g.font = `400 ${12.5 * r}px Geist`;
    g.fillStyle = '#848890';
    lines.forEach((ln, i) => g.fillText(ln, 0, 40 * r + i * 19 * r));
  }
  let out = sharp;
  if (blur > 0) {
    out = document.createElement('canvas');
    out.width = sharp.width;
    out.height = sharp.height;
    const o = out.getContext('2d');
    o.filter = `blur(${blur}px)`;
    o.drawImage(sharp, 0, 0);
  }
  Object.assign(out.style, {
    width: `${cw + pad * 2}px`,
    height: `${ch + pad * 2}px`,
    marginLeft: `${-pad}px`,
    marginTop: `${-pad}px`,
  });
  return out;
}


export default function create(span) {
  return {
    id: 'decide',
    span,
    icons: ['list-checks', 'git-branch', 'cube', 'calculator', 'flask'],
    css: `
#s-decide { background: #0b0c0e; }
#s-decide .s10, #s-decide .s11 { position: absolute; inset: 0; }

/* Shot 10 · the split */
#s-decide .pane { position: absolute; overflow: hidden; background: #0b0c0e; }
#s-decide .pane canvas { position: absolute; left: 0; top: 0; }
#s-decide .halo { position: absolute; inset: 0; }
#s-decide .sheet { position: absolute; left: 0; top: 0; overflow: hidden;
  background: radial-gradient(ellipse 80% 70% at 32% 46%, #f6f6f7 0%, #ebecee 70%, #e3e4e7 100%); }
#s-decide .rule { position: absolute; left: 0; right: 0; height: 1px; background: rgba(20,21,24,0.07); }
#s-decide .ink { position: absolute; inset: 0; transform-origin: 0 0; }
#s-decide .val { position: absolute; left: 0; top: 0; font: 500 150px/1 var(--font-mono); letter-spacing: -0.035em;
  color: ${INK}; white-space: nowrap; font-variant-numeric: tabular-nums; }
#s-decide .val .u { color: #656972; margin-left: 0.14em; }
#s-decide .val.hollow, #s-decide .val.hollow .u { color: transparent; -webkit-text-stroke: 1.5px ${INK}; }
#s-decide .val.hollow .u { -webkit-text-stroke-color: #80858f; }
#s-decide .lab { position: absolute; left: 0; top: 0; font: 400 20px/1 var(--font-mono); color: #474b53; white-space: nowrap; }
#s-decide .cap { position: absolute; left: 0; top: 0; display: flex; align-items: center; gap: 0.55em;
  font: 400 20px/1 var(--font-mono); color: #656972; white-space: nowrap; }
#s-decide .cap .ic { font-size: 1.15em; color: #474b53; }
#s-decide .pill { position: absolute; left: 0; top: 0; display: inline-flex; align-items: center; gap: 0.45em; height: 1.85em;
  padding: 0 0.85em 0 0.65em; border-radius: 999px; border: 1px solid rgba(15,17,20,0.16); background: rgba(15,17,20,0.035);
  font: 500 18px/1 var(--font-sans); color: ${INK}; white-space: nowrap; }
#s-decide .pill .ic { font-size: 1.1em; }

/* Shot 11 · the Decision bar at the app's own metrics, scaled for the macro */
#s-decide .s11 { background: radial-gradient(ellipse 80% 70% at 72% 26%, #121315 0%, #0b0c0e 78%); }
#s-decide .shake, #s-decide .cam, #s-decide .railcam { position: absolute; inset: 0; transform-origin: 0 0; }
#s-decide .plate { position: absolute; left: 0; top: 0; }
#s-decide .plate canvas { display: block; }
#s-decide .bar { position: absolute; left: 0; transform-origin: 0 0; background: #141518;
  padding-top: 12px; font-family: var(--font-sans); color: #ededee; }
#s-decide .bar .lit, #s-decide .bar .shade { position: absolute; left: 0; top: 0; width: 100%; pointer-events: none; }
#s-decide .bar .shade { background: linear-gradient(90deg, rgba(11,12,14,0.5), rgba(11,12,14,0.18) 38%, transparent 62%); }
#s-decide .fb { position: relative; height: 0; overflow: hidden; }
#s-decide .fbi { display: block; padding: 6px 12px 7px; line-height: 1.45; border-left: 2px solid rgba(255,255,255,0.17);
  border-radius: 6px; background: #17181b; font-size: 12.5px; color: #a4a7ae; white-space: nowrap; }
#s-decide .fbi strong { display: block; color: #ededee; font-weight: 500; }
/* One focal read: the outcome in text, the consequences ranked below it (text-2, 0.8×). */
#s-decide .fbi .sub { display: block; margin-top: 1px; font-size: 10px; line-height: 1.45; color: #a4a7ae; }
#s-decide.portrait .fbi .s3 { display: block; }
/* 9:16 frames Request and Approve; the ghost Reject would only crowd the row. */
#s-decide.portrait .rej { display: none; }
#s-decide .ta { position: relative; min-height: 38px; padding: 9px 10px; line-height: 18px; border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.12); background: #0d0e10; font-size: 12.5px; color: #848890; } /* the app's placeholder: --text-3 */
#s-decide .acts { position: relative; display: flex; align-items: center; gap: 8px; margin-top: 8px; }
#s-decide .grow { flex: 1; }
#s-decide .btn { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 32px;
  padding: 0 12px; border-radius: 8px; font-weight: 500; font-size: 12.5px; white-space: nowrap; border: 1px solid transparent; }
#s-decide .btn.ghost { color: #a4a7ae; }
#s-decide .btn.sec { background: #1e1f23; border-color: rgba(255,255,255,0.12); color: #ededee; }
#s-decide .btn.pri { background: linear-gradient(180deg, #f6f6f7, #ececee); color: #0b0c0e; }
#s-decide .bloom { position: absolute; left: 0; top: 0; width: 340px; height: 120px; transform: translate(-50%, -50%);
  background: radial-gradient(ellipse closest-side, rgba(255,255,255,0.42), rgba(255,255,255,0.12) 42%, transparent); pointer-events: none; }
#s-decide .kbd { display: inline-flex; align-items: center; gap: 1px; height: 18px; padding: 0 5px; border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.12); background: #1e1f23; color: #848890; font: 500 10.5px/1 var(--font-sans);
  letter-spacing: 0.02em; white-space: nowrap; }
#s-decide .btn.pri .kbd { background: transparent; border-color: rgba(11,12,14,0.22); color: rgba(11,12,14,0.72); }
#s-decide .kbd i { font-style: normal; display: inline-block; }
#s-decide .ring { position: absolute; left: -4px; top: -4px; overflow: visible; pointer-events: none; }
#s-decide .ring rect { fill: none; stroke: #cff36e; stroke-width: 2; }
#s-decide .hl { position: absolute; left: 0; top: 0; font: 600 96px/1.06 var(--font-sans); letter-spacing: -0.032em;
  color: #ededee; white-space: nowrap; }
#s-decide .hl .ln { display: block; }
#s-decide .fx-defs { position: absolute; width: 0; height: 0; }
`,
    build(root, ctx) {
      const P = ctx.portrait ? L.port : L.land;
      const TY = threadY(ctx);
      root.classList.toggle('portrait', ctx.portrait);
      root.innerHTML = `
        <div class="s10">
          <div class="pane"><div class="halo"></div><canvas></canvas></div>
          <div class="sheet paper">
            <div class="rule r2"></div>
            <div class="ink">
              <div class="cap">${ic('list-checks')}<span>Increase payload capacity to 500 g</span></div>
              <div class="lab l1">Baseline · r1</div>
              <div class="val v1">0.3<span class="u">kg</span></div>
              <div class="val v2 hollow">0.5<span class="u">kg</span></div>
              <div class="pill">${ic('git-branch')}<span>In review</span></div>
              <div class="lab l2">Proposed by the agent · r2</div>
            </div>
          </div>
        </div>
        <div class="s11">
          <svg class="fx-defs" width="0" height="0" aria-hidden="true"><filter id="decide-vblur" x="-0.3" y="-1.5" width="1.6" height="4" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="0 0"/><feOffset dy="0"/></filter><filter id="decide-vblur-front" x="-0.1" y="-1" width="1.2" height="3" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="0 0"/><feOffset dy="0"/></filter></svg>
          <div class="shake">
            <div class="railcam"><div class="plate pa"></div><div class="plate pb"></div></div>
            <div class="cam">
              <div class="bar">
                <div class="lit"></div>
                <div class="fb"><div class="fbi"><strong>Approved as the new baseline.</strong><span class="sub"><span class="s2">Four dependents are marked out of date.</span> <span class="s3">Approval does not mean validated.</span></span></div></div>
                <div class="ta"><span class="tx">${PLACEHOLDER}</span></div>
                <div class="acts">
                  <span class="btn ghost rej">Reject</span><span class="grow"></span>
                  <span class="btn sec req">Request changes</span>
                  <span class="bloom"></span>
                  <span class="btn pri appr"><span class="lb">Approve changes</span><span class="kbd ck"><i>⌘</i><i>↵</i></span><svg class="ring"><rect pathLength="1"/></svg></span>
                </div>
                <div class="shade"></div>
              </div>
            </div>
          </div>
          ${P.hl.lines.map((ls, i) => `<div class="hl h${i}">${ls.map((s) => `<span class="ln">${words(s)}</span>`).join('')}</div>`).join('')}
        </div>`;

      // Shot 10: the Paper sheet and the graphite pane.
      const s10 = $('.s10', root);
      const sheet = $('.sheet', root);
      Object.assign(sheet.style, { width: `${P.sheet.w}px`, height: `${P.sheet.h}px` });
      const pane = $('.pane', root);
      Object.assign(pane.style, { left: `${P.pane.x}px`, top: `${P.pane.y}px`, width: `${P.pane.w}px`, height: `${P.pane.h}px` });
      const [hx, hy] = P.rover.halo;
      $('.halo', root).style.background = `radial-gradient(ellipse 52% 40% at ${hx}% ${hy}%, rgba(237,237,238,0.11), rgba(237,237,238,0.035) 50%, transparent 78%)`;
      const canvas = $('.pane canvas', root);
      canvas.width = P.pane.w;
      canvas.height = P.pane.h;
      canvas.style.transform = `translate(${P.canvasShift[0]}px, ${P.canvasShift[1]}px)`;
      const stage = createRoverStage(canvas, { pointsPerMm2: 0.5, fov: P.rover.fov });

      const v1 = $('.v1', root);
      const v2 = $('.v2', root);
      const l1 = $('.l1', root);
      const l2 = $('.l2', root);
      const cap = $('.cap', root);
      const pill = $('.pill', root);
      for (const v of [v1, v2]) v.style.fontSize = `${P.vSize}px`;
      for (const e of [l1, l2]) e.style.fontSize = `${P.labSize}px`;
      cap.style.fontSize = `${P.capSize}px`;
      pill.style.fontSize = `${P.labSize - 2}px`;
      const place = (el, x, base) => {
        el.style.left = `${x}px`;
        el.style.top = `${(base - baselineOf(el)).toFixed(2)}px`;
      };
      // The two values share the thread's column; their labels bracket the pair:
      // the baseline's above it, the proposal's below it, the pill beside the hollow value.
      const capH = P.vSize * 0.698; // IBM Plex Mono cap height
      place(v1, P.x0, TY);
      place(v2, P.x0, TY + P.row2);
      place(l1, P.x0, TY - capH - P.labAbove);
      place(l2, P.x0, TY + P.row2 + P.labBelow);
      const capSpan = $('span', cap);
      cap.style.left = `${P.x0}px`;
      cap.style.top = `${(TY + P.capDy - capSpan.offsetTop - baselineOf(capSpan)).toFixed(2)}px`;
      const pillH = pill.getBoundingClientRect().height;
      pill.style.left = `${P.x0 + v1.getBoundingClientRect().width + P.labGap}px`;
      pill.style.top = `${(TY + P.row2 - capH / 2 - pillH / 2).toFixed(2)}px`;
      $('.r2', root).style.top = `${TY + P.row2}px`;
      const inkThread = createThread(sheet, ctx, { y: TY });
      const paneThread = createThread(s10, ctx, { y: TY });
      s10.insertBefore(paneThread.el, pane);

      // Shot 11: the bar at the app's metrics, scaled by S, its top edge on the thread.
      const bar = $('.bar', root);
      const Sx = P.S;
      const [ML, MR] = P.M;
      const BLEED = 40; // past the frame edges, so the press shake never shows an edge
      Object.assign(bar.style, {
        left: `${-BLEED}px`,
        top: `${TY}px`,
        width: `${(ctx.W + BLEED * 2) / Sx}px`,
        height: `${(ctx.H - TY) / Sx + 80}px`,
        padding: `12px ${(MR + BLEED) / Sx}px 0 ${(ML + BLEED) / Sx}px`,
        transform: `scale(${Sx})`,
      });
      const fb = $('.fb', root);
      const fbi = $('.fbi', root);
      const fbH = fbi.offsetHeight + 8;
      const appr = $('.appr', root);
      const ring = $('.ring', root);
      const aw = appr.offsetWidth;
      const ah = appr.offsetHeight;
      ring.setAttribute('width', aw + 8);
      ring.setAttribute('height', ah + 8);
      const rect = $('.ring rect', root);
      rect.setAttribute('x', 1);
      rect.setAttribute('y', 1);
      rect.setAttribute('width', aw + 6);
      rect.setAttribute('height', ah + 6);
      rect.setAttribute('rx', 11);
      // The push's fixed point: as near Approve as the frame allows, so at full push
      // the whole bar (field, Reject, ring) stays inside P.edge of the frame's sides.
      const rb = root.getBoundingClientRect();
      const sc = rb.width / ctx.W || 1;
      const ab = appr.getBoundingClientRect();
      const tb = $('.ta', root).getBoundingClientRect();
      const L0 = (tb.left - rb.left) / sc;
      const R0 = (ab.right - rb.left) / sc + 5 * Sx; // the ring's outer edge (4 app px out, 2 px stroke)
      const kp = P.push;
      const fxMaxL = (L0 * kp - P.edge[0]) / (kp - 1);
      const fxMinR = (R0 * kp - (ctx.W - P.edge[1])) / (kp - 1);
      const want = (ab.left - rb.left + ab.width / 2) / sc;
      const focusX = fxMinR <= fxMaxL ? clamp(want, fxMinR, fxMaxL) : (fxMinR + fxMaxL) / 2;
      const bloom = $('.bloom', root);
      bloom.style.left = `${appr.offsetLeft + aw / 2}px`;
      bloom.style.top = `${appr.offsetTop + ah / 2}px`;
      // A soft key light on the bar, centred on Approve.
      const lxp = ((appr.offsetLeft + aw / 2) / bar.offsetWidth) * 100;
      const lyp = ((appr.offsetTop + ah / 2) / bar.offsetHeight) * 100;
      for (const e of [$('.lit', root), $('.shade', root)]) e.style.height = `${(ctx.H - TY) / Sx + 40}px`;
      $('.lit', root).style.background = `radial-gradient(ellipse 40% 70% at ${lxp.toFixed(1)}% ${lyp.toFixed(1)}%, rgba(255,255,255,0.045), transparent 72%)`;

      // Rail plates (pre-blurred) and the headline.
      const pa = $('.pa', root);
      const pb = $('.pb', root);
      const plateA = railPlate('affect', P.railA);
      pa.appendChild(plateA);
      pb.appendChild(railPlate('means', P.railB));
      // In 16:9 the standing note follows the affected list down the same column.
      const yB = P.railB.y ?? P.railA.y + parseFloat(plateA.style.height) + P.railB.gap;
      Object.assign(pa.style, { left: `${P.railA.x}px`, top: `${P.railA.y}px` });
      Object.assign(pb.style, { left: `${P.railB.x}px`, top: `${yB.toFixed(2)}px` });
      const hls = $$('.hl', root);
      for (const h of hls) {
        // The film's headline slot: the first line's baseline sits on P.hl.y.
        h.style.fontSize = `${P.hl.size}px`;
        const first = $('.ln', h);
        const b = baselineOf(first) + first.offsetTop;
        h.style.left = `${P.hl.x}px`;
        h.style.top = `${(P.hl.y - b).toFixed(2)}px`;
      }
      const barThread = createThread($('.shake', root), ctx, { y: TY });
      Object.assign(barThread.el.style, { left: `${-BLEED}px`, width: `${ctx.W + BLEED * 2}px` });
      const glint = createThread($('.shake', root), ctx, { y: TY });
      // In 9:16 the standing note sits below the bar, nearer the lens: a foreground plate.
      const front = document.createElement('div');
      front.className = 'railcam front';
      $('.shake', root).appendChild(front);
      if (ctx.portrait) front.appendChild(pb);

      S = {
        P,
        TY,
        s10,
        s11: $('.s11', root),
        stage,
        ink: $('.ink', root),
        v1,
        v2,
        l1,
        l2,
        cap,
        pill,
        inkThread,
        paneThread,
        shake: $('.shake', root),
        cam: $('.cam', root),
        railcam: $('.railcam', root),
        front,
        pa,
        pb,
        fb,
        fbi,
        fbH,
        ta: $('.ta', root),
        acts: $('.acts', root),
        vblur: $('#decide-vblur feGaussianBlur', root),
        vblurFront: $('#decide-vblur-front feGaussianBlur', root),
        voff: $('#decide-vblur feOffset', root),
        voffFront: $('#decide-vblur-front feOffset', root),
        tx: $('.ta .tx', root),
        rej: $('.rej', root),
        req: $('.req', root),
        appr,
        lb: $('.appr .lb', root),
        bloom,
        ck: $('.ck', root),
        caps: $$('.ck i', root),
        ring,
        rect,
        hl: hls.map((h) => ({ el: h, spans: $$('.w > span', h) })),
        barThread,
        glint,
        shade: $('.shade', root),
        focusX,
      };
    },

    render(t, ctx) {
      const shot10 = t < BAR;
      show(S.s10, shot10 ? 1 : 0);
      show(S.s11, shot10 ? 0 : 1);
      if (shot10) renderSplit(t);
      else renderBar(t, ctx);
    },

    fx(t) {
      // No full-frame flash on the press: the light comes from the button (S.bloom).
      // Soften the vignette over the Paper half.
      if (t >= SPLIT && t < BAR) return { vignette: 0.55 };
      return null;
    },
  };
}

const blur = (el, px) => {
  el.style.filter = px > 0.03 ? `blur(${px.toFixed(2)}px)` : 'none';
};

function renderSplit(t) {
  const { P, TY } = S;
  const l = t - SPLIT;
  const p = prog(t, SPLIT, BAR);

  // Graphite half: the rover on a slow turntable under a raking light, no signal.
  // The explode shot's look (points over crisp edges), sharp, from a clear ¾ top view.
  const R = P.rover;
  const el = (R.el * Math.PI) / 180;
  const az = (R.az * Math.PI) / 180;
  const d = R.dist * lerp(1, 0.965, E.sine(p));
  const [tx, ty, tz] = R.target;
  S.stage.render({
    cam: { pos: [tx + d * Math.cos(el) * Math.cos(az), ty + d * Math.sin(el), tz + d * Math.cos(el) * Math.sin(az)], target: R.target },
    looks: { points: 0.8, edges: 0.45, solid: 0 },
    // The chassis plate is the densest surface; seen near edge-on its points pile
    // into a bright wedge, so it carries fewer of them and leans on its edges.
    partAlpha: (id) => (id === 'chassis' ? 0.4 : 1),
    rotY: lerp(R.yaw[0], R.yaw[1], p),
    sweepX: lerp(-72, 108, p),
    sweepW: 20,
    focus: d,
    aperture: 1.5,
    pointSize: 0.6,
    glow: 0.45,
    base: 0xb4b7be,
    groundAlpha: 0,
  });
  S.paneThread.set({ alpha: 0.2 });
  S.inkThread.set({ alpha: 0.85 });

  // The record's numbers: a slow push about the thread so the baseline stays on it.
  const k = lerp(1, 1.025, E.sine(p));
  S.ink.style.transform = `translate(${(P.x0 * (1 - k)).toFixed(2)}px, ${(TY * (1 - k)).toFixed(2)}px) scale(${k.toFixed(4)})`;

  // Caption and label settle in just after the cut; the baseline is there on it.
  const cIn = ez(l, 0.06, 0.5, E.expoOut);
  S.cap.style.opacity = cIn.toFixed(3);
  S.cap.style.transform = `translateY(${((1 - cIn) * 14).toFixed(2)}px)`;
  S.l1.style.opacity = ez(l, 0.14, 0.5, E.expoOut).toFixed(3);

  // 13.0: the proposal lands hollow, on the beat. The value itself never tweens.
  const land = ez(t, HOLLOW, HOLLOW + 0.16, E.expoOut);
  show(S.v2, t >= HOLLOW ? 1 : 0);
  S.v2.style.webkitTextStrokeWidth = `${lerp(3, 1.5, land).toFixed(2)}px`;
  const meta = ez(t, HOLLOW + 0.05, HOLLOW + 0.3, E.expoOut);
  show(S.pill, meta);
  show(S.l2, ez(t, HOLLOW + 0.1, HOLLOW + 0.35, E.expoOut));
  S.pill.style.transform = `translateY(${((1 - meta) * 10).toFixed(2)}px)`;

  // Focus: the eye follows the arrival (a short rack off the baseline), then racks back.
  const pull = ez(t, HOLLOW + 0.06, HOLLOW + 0.36, E.cubicInOut) * (1 - ez(t, RACK[0], RACK[1], E.cubicInOut));
  const away = ez(t, RACK[0], RACK[1], E.cubicInOut);
  blur(S.v1, pull * 3.2);
  blur(S.l1, pull * 2);
  blur(S.v2, away * 7);
  blur(S.l2, away * 4);
  blur(S.pill, away * 4);
  S.v2.style.transform = `translateY(${((1 - land) * -10).toFixed(2)}px)`;
  S.v2.style.opacity = lerp(1, 0.68, away).toFixed(3);
  S.v1.style.opacity = lerp(1, 0.8, pull).toFixed(3);
}

function renderBar(t, ctx) {
  const { P, TY } = S;
  // Slow push toward Approve, scaled about the thread so the bar's edge stays on it.
  // The camera holds through the press, then lets go gently and the notice reads.
  const x = prog(t, BAR, PRESS);
  let k = lerp(1, P.push, 0.55 * x + 0.45 * x * x);
  const rel = ez(t, LET_GO, LET_GO + 0.5, E.cubicInOut);
  k = lerp(k, P.rel, rel);
  // Letting go re-anchors on the bar's left margin so the notice keeps its first word.
  const fx = lerp(S.focusX, P.M[0], rel);
  S.cam.style.transform = `translate(${(fx * (1 - k)).toFixed(2)}px, ${(TY * (1 - k)).toFixed(2)}px) scale(${k.toFixed(4)})`;
  // The rail plates sit at other depths: less push behind the bar, more in front of it.
  const px = ctx.portrait ? ctx.W / 2 : fx;
  const kr = 1 + (k - 1) * 0.45;
  const dx = (t - BAR) * -8;
  S.railcam.style.transform = `translate(${(px * (1 - kr) + dx).toFixed(2)}px, ${(TY * (1 - kr)).toFixed(2)}px) scale(${kr.toFixed(4)})`;
  const kf = 1 + (k - 1) * 1.15;
  // The notice opens and pushes the bar's rows down once the press has landed
  // (nothing moves for the first +0.04); the camera lets go a beat later.
  const open = ez(t, NOTICE[0], NOTICE[1], E.cubicOut);
  const drop = S.fbH * P.S * k * open;
  S.front.style.transform = `translate(${(px * (1 - kf) - dx).toFixed(2)}px, ${(TY * (1 - kf) + drop).toFixed(2)}px) scale(${kf.toFixed(4)})`;

  // A small shake on the press.
  const sh = t >= PRESS ? Math.exp(-(t - PRESS) * 26) : 0;
  const sx = noise1((t - PRESS) * 70, 11) * 5 * sh;
  const sy = noise1((t - PRESS) * 70, 23) * 3.5 * sh;
  S.shake.style.transform = sh > 0.002 ? `translate(${sx.toFixed(2)}px, ${sy.toFixed(2)}px)` : 'none';
  S.barThread.set({ to: ctx.W + 80, alpha: 0.42 });
  // Light catches the bar's edge on the cut and runs along the thread.
  const gx = lerp(-200, ctx.W + 300, ez(t, BAR, BAR + 0.75, E.cubicOut));
  const ga = 1 - ez(t, BAR + 0.45, BAR + 0.75, E.cubicIn);
  S.glint.set({ from: gx - 520, to: gx, alpha: 0.55 * ga, headAlpha: 0.35 * ga, fade: 520 });

  // Headline: one phrase, replaced in place on the beat. Each is up within ~0.4 s
  // and holds well past 0.6 s; from the press the notice is the only read.
  const [h0, h1] = S.hl;
  reveal(h0.spans, t, { at: BAR, stagger: 0.03, dur: 0.34, style: 'rise', out: SWAP - 0.12, outStagger: 0.02, outDur: 0.14, outStyle: 'rise' });
  reveal(h1.spans, t, { at: SWAP + 0.01, stagger: 0.04, dur: 0.36, style: 'rise' });
  show(h0.el, t < SWAP + 0.1 ? 1 : 0);
  show(h1.el, (t >= SWAP ? 1 : 0) * (1 - ez(t, PRESS, PRESS + 0.1, E.cubicOut)));

  // The focus ring draws round Approve — the only signal on screen.
  const ringIn = ez(t, RING, RING + 0.22, E.expoOut);
  const ringOut = ez(t, PRESS + 0.05, PRESS + 0.16, E.cubicOut);
  S.rect.style.strokeDasharray = ringIn > 0.999 ? 'none' : `${ringIn.toFixed(4)} 1`;
  show(S.ring, (t >= RING ? 1 : 0) * (1 - ringOut));

  // ⌘ goes down on the beat, ↵ sinks slowly into the downbeat.
  const up = ez(t, PRESS + 0.08, PRESS + 0.2, E.cubicOut);
  const c1 = ez(t, KEYS[0], KEYS[0] + 0.06, E.cubicOut) * (1 - up);
  const c2 = ez(t, KEYS[0] + 0.19, KEYS[1], E.cubicIn) * (1 - up);
  S.caps[0].style.transform = `translateY(${(c1 * 2).toFixed(3)}px)`;
  S.caps[1].style.transform = `translateY(${(c2 * 2).toFixed(3)}px)`;
  const deep = Math.max(c1 * 0.5, c2);
  S.ck.style.transform = `translateY(${(deep * 0.8).toFixed(3)}px)`;
  S.ck.style.background = `rgba(11,12,14,${(0.1 * deep).toFixed(3)})`;
  S.ck.style.boxShadow = deep > 0.01 ? `inset 0 ${(deep * 1.5).toFixed(2)}px 0 rgba(11,12,14,${(0.14 * deep).toFixed(3)})` : 'none';
  S.ck.style.color = `rgba(11,12,14,${lerp(0.72, 0.95, deep).toFixed(3)})`;

  // 16.0: the press. The button goes down hard and springs back; the hit is light
  // off the button itself, brightest for the first frames, gone by +0.2.
  const down = t >= PRESS ? 1 - ez(t, PRESS + 0.05, PRESS + 0.14, E.cubicOut) : 0;
  S.appr.style.transform = down > 0.001 ? `scale(${(1 - 0.07 * down).toFixed(4)})` : 'none';
  const hit = t >= PRESS ? 1 - ez(t, PRESS + 0.04, PRESS + 0.2, E.cubicOut) : 0;
  show(S.bloom, hit);
  S.appr.style.boxShadow = hit > 0.002 ? `0 0 ${(14 + 10 * (1 - hit)).toFixed(1)}px ${(3 * hit).toFixed(2)}px rgba(255,255,255,${(0.4 * hit).toFixed(3)})` : 'none';
  S.bloom.style.transform = `translate(-50%, -50%) scale(${lerp(0.9, 1.12, ez(t, PRESS, PRESS + 0.2, E.cubicOut)).toFixed(4)})`;

  // The decision is in flight: the bar disables and reports its outcome, once, in the bar.
  const off = ez(t, PRESS + 0.05, PRESS + 0.2, E.cubicOut);
  const dim = lerp(1, 0.5, off).toFixed(3);
  for (const e of [S.rej, S.req, S.appr, S.ta]) e.style.opacity = dim;
  S.fb.style.height = `${(S.fbH * open).toFixed(2)}px`;
  // The opening pushes the rows below it down fast (up to ~15 px on screen per
  // 1/240 s), which the renderer's 4-sample blend (sub-frames 1/240 s apart) would
  // show as stacked copies. Each sub-frame is smeared over its own move to the next
  // one (app px): blurred by half of it, which merges the four and no softer, and
  // shifted on by half of it, so the streak spans the shutter as an exposure would.
  const [n0, n1] = NOTICE;
  const step = (u) => S.fbH * E.cubicOut(prog(u, n0, n1));
  const move = step(t + 1 / 240) - step(t);
  const on = move > 0.24;
  S.vblur.setAttribute('stdDeviation', `0 ${on ? (move / 2).toFixed(3) : 0}`);
  S.voff.setAttribute('dy', on ? (move / 2).toFixed(3) : '0');
  S.ta.style.filter = on ? 'url(#decide-vblur)' : 'none';
  S.acts.style.filter = on ? 'url(#decide-vblur)' : 'none';
  if (ctx.portrait) {
    // The standing note below the bar rides the same drop (in its plate's own scale).
    const mf = (move * P.S * k) / kf;
    S.vblurFront.setAttribute('stdDeviation', `0 ${on ? (mf / 2).toFixed(3) : 0}`);
    S.voffFront.setAttribute('dy', on ? (mf / 2).toFixed(3) : '0');
    S.pb.style.filter = on ? 'url(#decide-vblur-front)' : 'none';
  }
  // Its text hangs still from the top of the opening box (no rise), so the first
  // line is uncovered first and is at full opacity from NOTICE_READ.
  show(S.fbi, ez(t, NOTICE[0], NOTICE_READ, E.sineOut));

  // Shallow depth of field across the bar (app px, scaled with it): Approve is the
  // focal plane until the press, then focus racks to the notice.
  const rk = ez(t, PRESS + 0.04, PRESS + 0.3, E.cubicInOut);
  blur(S.rej, lerp(0.9, 0, rk));
  blur(S.tx, lerp(0.4, 0, rk));
  // The shade lies over the notice's first words, so it lifts by the time they
  // read; the rail, context until the press, steps back with it so the notice is
  // the one focal read.
  const lift = ez(t, NOTICE[0], NOTICE_READ, E.cubicOut);
  show(S.shade, 1 - lift);
  const back = lerp(1, 0.6, lift);
  show(S.pa, P.railA.alpha * back);
  show(S.pb, P.railB.alpha * back);
}
