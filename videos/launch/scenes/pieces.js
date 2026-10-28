// Shots 3–4 (3.0–6.0). Shot 3, "none of it · connects": the record's pieces
// float as six lit Lens islands over a lattice of link stubs that point nowhere,
// a raking light grazing them. Shot 4, "your agent drafts it all": a hard cut
// inside the agent terminal at macro scale — the agent CLI is already running in
// the PTY (no shell line), the camera rides the cursor while the request types
// in, Enter commits it with a carriage return (the input clears, the request is
// echoed into the transcript wrapped to the terminal's width, and a fresh prompt
// settles on the thread), and only then do the host's recorded calls rise in the
// activity rail.
import { E, ez, clamp, lerp, prog, rng, noise1, words, ic, $$ } from '../lib/core.js';
import { reveal } from '../lib/type.js';
import { createThread, threadY, headline } from '../lib/film.js';

// Fixture values only (fixtures/rover); labels are the app's type names (ui/kit.tsx TYPES).
const ISLANDS = [
  ['list-checks', 'Requirements', '<b>0.3</b> kg'],
  ['package', 'Parts', '<b>DRV8835</b>'],
  ['cube', 'Mechanical', '<b>62 × 44</b> mm'],
  ['calculator', 'Calculations', '<b>7.4</b> V × <b>0.45</b> Ah'],
  ['circuitry', 'Electronics', '<b>5</b> V'],
  ['flask', 'Tests', '<b>15°</b> ramp'],
];
// Centre x, y, depth (1 = focus plane), drift heading (deg), drift px/s.
const SCATTER = {
  land: [
    [425, 240, 1, 200, 12],
    [1500, 205, 1, -20, 10],
    [590, 842, 1.2, 160, 16],
    [1010, 330, 1, 80, 9],
    [1545, 805, 1, 10, 14],
    [1120, 742, 0.8, -150, 8],
  ],
  port: [
    [300, 300, 1, 200, 12],
    [780, 520, 1, -20, 10],
    [330, 1470, 1.2, 160, 16],
    [370, 735, 1, 80, 9],
    [760, 1250, 1, 10, 13],
    [770, 1690, 0.8, -150, 8],
  ],
};

const PROMPT = 'Build a compact inspection rover with a removable camera tray.';
// The transcript echo wraps the committed request after "rover" (column 34 with the
// prompt), so the whole request is readable once sent in both formats.
const WRAP = [PROMPT.slice(0, 32), PROMPT.slice(33)];
const CALLS = [
  ['artifact.create_draft', 'list-checks', 'Payload capacity', 5.375],
  ['calculation.run', 'calculator', 'Rover mass budget', 5.5],
  ['test.create_draft', 'flask', 'Ramp traverse with payload', 5.625],
];

// Timing (global seconds); the score's cues sit on these.
const T0 = 3;
const CUT = 4.5; // hard cut into the terminal
// Islands 0–2 are there on the cut frame (the hit reveals them); 3–5 pop on 8ths.
const POP = (i) => (i < 3 ? T0 : T0 + (i - 2) * 0.25);
const TYPE = 4.625; // the request: 62 keys at 120 /s, 4.625 … 5.133
const CPS = 120;
const SUBMIT = 5.25; // Enter: the request commits, the cursor returns to a fresh prompt
// The Enter frame (5.25 … 5.267) still holds the cursor after "tray."; the return
// lands on the next 60 fps frame (the epsilon keeps both of its sub-frames past it).
const RT = SUBMIT + 1 / 60 - 1e-4;
const SETTLE = 0.45; // the carriage return's deceleration into the prompt's rest
const ECHO = 0.62; // the committed request's alpha in the transcript
const PRE = 2; // the "> " column
const BLUR = 8; // px, the far text's defocus (baked once)
const PAD = 28;

const SHARP = [[1, 1]];
const SOFT = [[4.2, 0.3], [2.4, 0.45], [1.1, 0.6]];

let S;

/** Baseline of `host`'s text, in px below the top of `el` (layout space). */
function baselineOf(el, host) {
  const p = document.createElement('i');
  p.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
  host.appendChild(p);
  const r = el.getBoundingClientRect();
  const k = r.width / el.offsetWidth || 1;
  const y = (p.getBoundingClientRect().top - r.top) / k;
  p.remove();
  return y;
}

/** Piecewise-linear lookup through [[x, y], …], clamped at the ends. */
function pw(x, pts) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    if (x <= x1) {
      const [x0, y0] = pts[i - 1];
      return lerp(y0, y1, (x - x0) / (x1 - x0));
    }
  }
  return pts[pts.length - 1][1];
}

export default function create(span) {
  return {
    id: 'pieces',
    span,
    icons: [...new Set([...ISLANDS.map((d) => d[0]), 'hand-palm', 'magnifying-glass', 'copy-simple', 'broom', 'sidebar-simple', 'gear-six'])],
    css: `
#s-pieces { background: #0b0c0e; }
#s-pieces .p3, #s-pieces .p4 { position: absolute; inset: 0; overflow: hidden; }
#s-pieces .p3 { background: radial-gradient(ellipse 75% 65% at 50% 50%, #111215 0%, #0b0c0e 78%); }
#s-pieces .stubs { position: absolute; inset: 0; width: 100%; height: 100%; }
#s-pieces .isl { position: absolute; left: 0; top: 0; transform-origin: 50% 50%; will-change: transform; }
#s-pieces .isl .zm { position: relative; }
#s-pieces .isl .body { display: flex; align-items: center; gap: 20px; height: 100px; padding: 0 34px 0 22px; border-radius: 22px;
  background: linear-gradient(180deg, #1f2024, #151619); box-shadow: var(--shadow-float), inset 0 1px 0 rgba(255,255,255,0.07); white-space: nowrap; }
#s-pieces .isl .g { width: 52px; height: 52px; border-radius: 14px; background: linear-gradient(180deg, #2c2e33, #1e1f23); display: grid; place-items: center;
  color: var(--text); font-size: 28px; flex: none; box-shadow: inset 0 1px 0 rgba(255,255,255,0.09), 0 0 0 1px rgba(255,255,255,0.05); }
#s-pieces .isl .tx { display: flex; flex-direction: column; gap: 6px; }
#s-pieces .isl .lb { font: 500 28px/1.1 var(--font-sans); letter-spacing: -0.012em; color: var(--text-2); }
#s-pieces .isl .v { font: 400 20px/1.15 var(--font-mono); color: var(--text-3); }
#s-pieces .isl .v b { font-weight: 400; color: var(--text-2); }
#s-pieces .isl .gl, #s-pieces .isl .bl { position: absolute; inset: 0; border-radius: 22px; pointer-events: none; will-change: opacity; }
#s-pieces .isl .gl { box-shadow: 0 0 0 1px rgba(255,255,255,0.36), inset 0 1px 0 rgba(255,255,255,0.28), 0 0 26px -6px rgba(255,255,255,0.22); }
#s-pieces .isl.soft .gl { box-shadow: 0 0 3px 1px rgba(255,255,255,0.26), 0 0 26px -6px rgba(255,255,255,0.2); }
#s-pieces .isl .bl { box-shadow: 0 0 40px rgba(255,255,255,0.18), 0 0 0 1px rgba(255,255,255,0.3); background: rgba(255,255,255,0.035); }
#s-pieces .ph { position: absolute; left: 0; top: 0; font: 500 60px/1.1 var(--font-sans); letter-spacing: -0.032em; color: var(--text); white-space: nowrap; }
#s-pieces.portrait .ph { font-size: 68px; }

#s-pieces .p4 { background: #0d0e10; }
#s-pieces .cam { position: absolute; inset: 0; }
#s-pieces .bar { position: absolute; top: 52px; height: 60px; will-change: transform; }
#s-pieces .bar .bi { display: flex; align-items: center; gap: 18px; height: 100%; background: var(--field);
  border-bottom: 1px solid var(--line); font: 400 17px/1 var(--font-sans); color: var(--text-2); white-space: nowrap; filter: blur(1.4px); }
#s-pieces .bar .seg { display: inline-flex; padding: 3px; gap: 3px; border-radius: 16px; background: var(--raised); border: 1px solid var(--line); }
#s-pieces .bar .seg span { display: inline-flex; align-items: center; height: 39px; padding: 0 18px; border-radius: 12px; font: 500 19px/1 var(--font-sans); color: var(--text-3); }
#s-pieces .bar .seg .on { background: var(--raised-2); color: var(--text); box-shadow: 0 0 0 1px var(--line-strong); }
#s-pieces .bar .st { display: inline-flex; align-items: center; gap: 11px; font-weight: 500; color: var(--signal-text); }
#s-pieces .bar .pulse { position: relative; width: 10.5px; height: 10.5px; border-radius: 50%; background: var(--signal-stroke); }
#s-pieces .bar .pulse b { position: absolute; inset: -4.5px; border-radius: 50%; border: 1.5px solid var(--signal-stroke); }
#s-pieces .bar strong { font-weight: 500; color: var(--text); }
#s-pieces .bar .fact { display: inline-flex; gap: 15px; }
#s-pieces .bar .fact::before { content: '·'; color: var(--text-4); font-family: var(--font-sans); }
#s-pieces .bar .cli { font: 400 17px/1 var(--font-mono); color: var(--text-3); }
#s-pieces .bar .grow { flex: 1; }
#s-pieces .bar .sep { width: 1px; height: 24px; background: var(--line-strong); }
#s-pieces .bar .ib { display: grid; place-items: center; width: 39px; height: 39px; color: var(--text-3); font-size: 21px; }
#s-pieces .soft { position: absolute; }
#s-pieces .tp { position: absolute; overflow: hidden; }
#s-pieces .tp .lines { position: absolute; left: 0; top: 0; }
#s-pieces .tp .ln { position: absolute; left: 0; top: 0; white-space: pre; font-family: var(--font-mono); font-weight: 400; color: var(--text);
  font-variant-ligatures: none; text-shadow: 0 0 12px rgba(237, 237, 238, 0.16); }
#s-pieces .tp .ln .pr { color: var(--text-3); }
#s-pieces .cur { position: absolute; left: 0; top: 0; background: var(--terminal-cursor); will-change: transform;
  box-shadow: 0 0 26px rgba(207, 243, 110, 0.38), 0 0 110px 18px rgba(207, 243, 110, 0.07); }
#s-pieces .rail { position: absolute; }
#s-pieces .rail > *, #s-pieces .bar { transform-origin: 0 0; }
#s-pieces .rail > * { border-left: 1px solid var(--line-strong); }
#s-pieces .rail .rh { display: flex; align-items: baseline; gap: 16px; height: 62px; padding: 6px 0 0 28px; }
#s-pieces .rail .rh b { font: 500 25px/1 var(--font-sans); letter-spacing: -0.012em; color: var(--text); }
#s-pieces .rail .rh span { font: 400 19px/1 var(--font-sans); color: var(--text-2); }
#s-pieces .rail .call { display: flex; flex-direction: column; align-items: flex-start; gap: 11px; padding: 17px 0 18px 28px; border-top: 1px solid var(--line); }
#s-pieces.portrait .rail .rh { height: 54px; }
#s-pieces.portrait .rail .call { gap: 4px; padding: 11px 0 12px 28px; }
#s-pieces .rail .ct { font: 400 22px/1.15 var(--font-mono); color: var(--text-2); }
#s-pieces .rail .co { display: inline-flex; align-items: center; gap: 10px; height: 42px; padding: 0 15px 0 12px; border-radius: 8px; background: var(--raised-2);
  font: 500 22px/1 var(--font-sans); letter-spacing: -0.01em; color: var(--text); }
#s-pieces .rail .co .ic { color: var(--text-3); font-size: 22px; }
#s-pieces .hl { position: absolute; left: 0; top: 0; font: 600 96px/1.04 var(--font-sans); letter-spacing: -0.032em; color: var(--text); white-space: nowrap; }
#s-pieces.portrait .hl { font-size: 108px; line-height: 1.055; }
`,
    build(root, ctx) {
      const { W, H, portrait: P } = ctx;
      root.classList.toggle('portrait', P);
      const TY = threadY(ctx);
      const M = P ? 80 : 160;
      const HL = headline(ctx);
      const lay = SCATTER[P ? 'port' : 'land'];

      /* ---------------- markup ---------------- */
      const isl = ISLANDS.map(
        ([g, lb, v], i) =>
          `<div class="isl${lay[i][2] === 1 ? '' : ' soft'}"><div class="zm"><div class="body"><span class="g">${ic(g)}</span><span class="tx"><span class="lb">${lb}</span><span class="v">${v}</span></span></div><i class="gl"></i><i class="bl"></i></div></div>`,
      ).join('');
      const fs = P ? 44 : 52;
      const LH = Math.round(fs * 1.5);
      const CX = Math.round(W * (P ? 0.7 : 0.62));
      // One span per character: the depth fade is set per column.
      const chars = (pre, text) =>
        [...pre].map((c) => `<span class="pr">${c === '>' ? '&gt;' : c}</span>`).join('') + [...text].map((c) => `<span>${c}</span>`).join('');
      const icons = ['hand-palm', 'magnifying-glass', 'copy-simple', 'broom'].map((n) => `<span class="ib">${ic(n)}</span>`).join('');
      // The app's terminal session bar: status, agent, the CLI as plain mono text, recorded calls.
      const bar = `<div class="bar"><div class="bi"><span class="seg"><span>Conversation</span><span class="on">Terminal</span></span>
        <span class="st"><i class="pulse"><b></b></i>Running</span><strong>Agent</strong><span class="fact cli">claude</span><span class="fact calls"></span><span class="grow"></span>
        ${P ? '' : icons}<span class="sep"></span><span class="ib">${ic('sidebar-simple')}</span><span class="ib">${ic('gear-six')}</span></div></div>`;
      const calls = CALLS.map(([tool, g, obj]) => `<div class="call"><span class="ct">${tool}</span><span class="co">${ic(g)}${obj}</span></div>`).join('');
      const hl = P
        ? `<div class="hl"><div>${words('your agent')}</div><div>${words('drafts it all')}</div></div>`
        : `<div class="hl"><div>${words('your agent drafts it all')}</div></div>`;

      root.innerHTML = `
        <div class="p3"><canvas class="stubs" width="${W}" height="${H}"></canvas>${isl}
          <div class="ph a">${words('none of it')}</div><div class="ph b">${words('connects')}</div></div>
        <div class="p4">${bar}<div class="cam"><canvas class="soft"></canvas>
          <div class="tp"><div class="lines"><div class="ln l0">${chars('> ', PROMPT)}</div></div>
            <div class="lines rest"><div class="ln w0">${chars('> ', WRAP[0])}</div><div class="ln w1">${chars('  ', WRAP[1])}</div><div class="ln l1">${chars('> ', '')}</div></div></div>
          <div class="cur"></div></div><div class="rail"><div class="rh"><b>Activity</b><span class="sum"></span></div>${calls}</div>${hl}</div>`;
      const p3 = root.querySelector('.p3');
      const p4 = root.querySelector('.p4');

      /* ---------------- shot 3 ---------------- */
      // Islands are laid out at film size and composited, so a frame only moves them: the depth
      // blur on the body and the shadow are painted once. Zoom carries depth (and the 9:16 scale).
      const base = P ? 1.15 : 1;
      const islands = $$('.isl', p3).map((el, i) => {
        const [x, y, z, hd, sp] = lay[i];
        const a = (hd * Math.PI) / 180;
        el.querySelector('.zm').style.zoom = String(base * z);
        el.querySelector('.body').style.filter = z > 1 ? 'blur(1.25px)' : z < 1 ? 'blur(0.6px) brightness(0.66)' : 'none';
        return {
          el, gl: el.querySelector('.gl'), bl: el.querySelector('.bl'), w: el.offsetWidth, h: el.offsetHeight,
          x, y, z, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, seed: i * 17.3,
        };
      });

      // The split phrase on the thread's baseline: "none of it" left, "connects" right.
      const pa = p3.querySelector('.ph.a');
      const pb = p3.querySelector('.ph.b');
      const ba = baselineOf(pa, pa.querySelector('.w > span'));
      const bb = baselineOf(pb, pb.querySelector('.w > span'));
      pa.style.left = `${M}px`;
      pa.style.top = `${((P ? TY - 54 : TY) - ba).toFixed(1)}px`;
      pb.style.left = `${W - M - pb.offsetWidth}px`;
      pb.style.top = `${((P ? TY + 72 : TY) - bb).toFixed(1)}px`;

      // The lattice: sparse stubs of causal links (a hairline and an open chevron) on a jittered grid.
      const r = rng(303);
      const cell = 160;
      const cols = Math.ceil(W / cell) + 1;
      const rows = Math.ceil(H / cell) + 1;
      const gx = (W - (cols - 1) * cell) / 2;
      const gy = (H - (rows - 1) * cell) / 2;
      const stubs = [];
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < cols; i++) {
          const s = {
            x: gx + i * cell + (r() - 0.5) * cell * 0.55,
            y: gy + j * cell + (r() - 0.5) * cell * 0.55,
            a: r() * Math.PI * 2,
            w: (r() < 0.5 ? -1 : 1) * (0.05 + r() * 0.16),
            z: 0.75 + r() * 0.5,
            al: 0.16 + r() * 0.12,
            seed: r() * 100,
          };
          if (r() > 0.14) stubs.push(s);
        }
      // A few stubs close to the lens: large, soft and quick under the camera's drift.
      for (let i = 0; i < (P ? 6 : 7); i++) {
        const y = r() * H;
        const x = r() * W;
        if (Math.abs(y - TY) < 190) continue; // keep the phrase's corridor clear
        stubs.push({ x, y, a: r() * Math.PI * 2, w: (r() - 0.5) * 0.3, z: 2.2 + r() * 0.9, al: 0.05 + r() * 0.03, seed: r() * 100, near: true });
      }

      /* ---------------- shot 4 ---------------- */
      // The terminal is seen by a camera turned about the cursor (see proj). Real 3D compositing
      // is too slow on SwiftShader, so each off-horizon element (session bar, rail rows) gets the
      // affine fit of its projected corners, and the horizon band only takes the push.
      const cam = p4.querySelector('.cam');
      cam.style.transformOrigin = `${CX}px ${TY}px`;
      const OX = 420;
      const barEl = p4.querySelector('.bar');
      Object.assign(barEl.style, { left: `${-OX}px`, width: `${W + OX * 2}px` });
      barEl.firstElementChild.style.padding = `0 ${OX + 16}px 0 ${OX + 24}px`;
      // A pool of light where the lens focuses (flat, in screen space: the well itself is uniform).
      p4.style.background = `radial-gradient(1000px 640px at ${CX}px ${TY}px, #18191c, #111214 55%, #0d0e10)`;

      // Teleprompter band: the sharp lines in the DOM; the camera moves only .lines.
      const TX = -300; // the band starts beyond the left edge so the perspective never shows a seam
      // Tall enough for the transcript's two echo rows above the live line.
      const tpTop = Math.round(TY - LH * 3.4);
      const tpH = Math.round(LH * 4.7);
      const tp = cam.querySelector('.tp');
      Object.assign(tp.style, { left: `${TX}px`, top: `${tpTop}px`, width: `${W - TX}px`, height: `${tpH}px` });
      const l0 = tp.querySelector('.l0');
      const rest = tp.querySelector('.rest');
      const echo = [rest.querySelector('.w0'), rest.querySelector('.w1')];
      const l1 = rest.querySelector('.l1');
      for (const ln of [l0, ...echo, l1]) ln.style.font = `400 ${fs}px/${LH}px var(--font-mono)`;
      echo[1].style.top = `${LH}px`;
      l1.style.top = `${LH * 2}px`;
      const k = p4.getBoundingClientRect().width / W || 1;
      const cw = l0.getBoundingClientRect().width / k / (PRE + PROMPT.length);
      const lnBase = baselineOf(l0, l0);

      // Far text: each line pre-blurred once into a bitmap, drawn per frame into a small canvas
      // over the far-left band and faded there (it only ever holds fully typed text).
      const softW = Math.round(W * 0.36 - TX);
      const soft = cam.querySelector('canvas.soft');
      Object.assign(soft, { width: softW, height: tpH });
      Object.assign(soft.style, { left: `${TX}px`, top: `${tpTop}px`, width: `${softW}px`, height: `${tpH}px` });
      const bake = (pre, text) => {
        const c = document.createElement('canvas');
        c.width = Math.ceil((pre.length + text.length) * cw + PAD * 2);
        c.height = LH + PAD * 2;
        const g = c.getContext('2d', { willReadFrequently: true }); // CPU-side, like the canvas it is drawn into
        g.filter = `blur(${BLUR}px)`;
        g.font = `400 ${fs}px "IBM Plex Mono"`;
        g.fillStyle = '#848890';
        g.fillText(pre, PAD, PAD + lnBase);
        g.fillStyle = '#ededee';
        g.fillText(text, PAD + pre.length * cw, PAD + lnBase);
        return c;
      };
      const sg = soft.getContext('2d', { willReadFrequently: true });
      const softFade = sg.createLinearGradient(0, 0, softW, 0);
      for (const [x, a] of [[-W * 0.05, 0.14], [W * 0.12, 0.78], [W * 0.22, 0.5], [W * 0.34, 0]]) softFade.addColorStop(clamp((x - TX) / softW), `rgba(0,0,0,${a})`);
      // Sharp text fades out over the same band, per column.
      const fade = [[W * (P ? 0.1 : 0.12), 0], [W * 0.22, 0.55], [W * (P ? 0.34 : 0.32), 1]];

      const cur = cam.querySelector('.cur');
      const curH = Math.round(fs * 0.9);
      Object.assign(cur.style, { width: `${cw.toFixed(2)}px`, height: `${curH}px` });

      // After Enter the transcript rests with its prompt column on the margin once the
      // push (about CX) has reached 1.04 at the cut; the settle comes in from the right
      // and below, so the return reads as one leftward move decelerating into place.
      const XR = CX + (M - CX) / 1.04;
      const DX = Math.round(W * 0.05); // small enough that 9:16 keeps "rover" inside the right edge
      const DY = Math.round(LH * 0.5);

      const rail = p4.querySelector('.rail');
      const RX = P ? M : Math.round(W * 0.678);
      const RY = P ? 1060 : 596;
      const RS = P ? 1.25 : 1; // rail scale about its top-left
      Object.assign(rail.style, { left: `${RX}px`, top: `${RY}px`, width: `${((P ? W - M * 2 : W - RX - 60) / RS).toFixed(0)}px` });
      // Warped boxes: [element, layout x, layout y, w, h, anchor x, anchor y, scale].
      const warps = [[barEl, -OX, barEl.offsetTop, barEl.offsetWidth, barEl.offsetHeight, -OX, barEl.offsetTop, 1]];
      for (const el of rail.children) warps.push([el, RX, RY + el.offsetTop, el.offsetWidth, el.offsetHeight, RX, RY + el.offsetTop * RS, RS]);

      // The shared headline slot (lib/film.js headline).
      const hlEl = p4.querySelector('.hl');
      const hb = baselineOf(hlEl, hlEl.querySelector('.w > span'));
      hlEl.style.left = `${HL.x}px`;
      hlEl.style.top = `${(HL.y - hb).toFixed(1)}px`;

      const thread = createThread(cam, ctx, { y: TY });
      thread.el.style.left = `${TX}px`;
      thread.el.style.width = `${W - TX}px`;

      S = {
        W, H, P, TY, CX, XR, DX, DY, LH, cw, lnBase, curH, TX, tpTop, fade, warps,
        p3, p4, cam, g: p3.querySelector('.stubs').getContext('2d'), stubs, islands,
        pa: $$('.w > span', pa), pb: $$('.w > span', pb),
        lines: tp.querySelector('.lines'), l0, c0: [...l0.children], rest, echo,
        soft, sg, softW, tpH, softFade, b0: bake('> ', PROMPT),
        cur, thread,
        pulse: barEl.querySelector('.pulse b'),
        barCalls: barEl.querySelector('.calls'),
        rh: rail.querySelector('.rh'),
        sum: rail.querySelector('.sum'),
        calls: $$('.call', rail).map((el) => ({ el, co: el.querySelector('.co') })),
        hl: $$('.hl .w > span', p4),
      };
    },

    render(t) {
      const shot4 = t >= CUT;
      S.p3.style.display = shot4 ? 'none' : '';
      S.p4.style.display = shot4 ? '' : 'none';
      if (shot4) renderTerminal(t);
      else renderPieces(t);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Shot 3 · none of it connects                                         */
/* ------------------------------------------------------------------ */

function renderPieces(t) {
  const { W, H, g, stubs, islands } = S;
  const l = t - T0;
  const cx = W / 2;
  const cy = S.TY;
  const cam = prog(t, T0, CUT);
  const push = lerp(1, 1.03, cam); // a slow, steady push over the shot
  const truck = lerp(18, -18, E.sine(cam)); // a slow truck left: nearer things slide further
  const par = (v, c, z, ax = 0) => c + (v - c) * (1 + (push - 1) * z) + ax * truck * z;

  // A raking light crosses diagonally (the film's light motif), catching stubs and rims.
  const ux = 0.82;
  const uy = 0.57;
  const band = lerp(-500, W * ux + H * uy + 500, prog(t, T0 - 0.2, CUT + 0.3));
  g.clearRect(0, 0, W, H);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = '#ededee';
  for (const s of stubs) {
    const x = par(s.x, cx, s.z, 1) + noise1(t * 0.6 + s.seed, 1) * 4;
    const y = par(s.y, cy, s.z) + noise1(t * 0.6 + s.seed, 2) * 4;
    const a = s.a + s.w * l;
    const d = (x * ux + y * uy - band) / 260;
    const lit = Math.exp(-d * d);
    const L = 36 * s.z * push; // half of a 72 px stub
    const dx = Math.cos(a) * L;
    const dy = Math.sin(a) * L;
    const hx = x + dx;
    const hy = y + dy;
    const k = 8 * s.z;
    g.beginPath();
    g.moveTo(x - dx, y - dy);
    g.lineTo(hx, hy);
    // Open chevron at the consequence end.
    g.moveTo(hx - Math.cos(a - 0.62) * k, hy - Math.sin(a - 0.62) * k);
    g.lineTo(hx, hy);
    g.lineTo(hx - Math.cos(a + 0.62) * k, hy - Math.sin(a + 0.62) * k);
    // Near stubs are out of focus: a soft core in three passes.
    for (const [w, al] of s.near ? SOFT : SHARP) {
      g.globalAlpha = (s.al + lit * (s.near ? 0.04 : 0.2)) * al;
      g.lineWidth = s.near ? w * s.z : 1.3 + lit * 0.4;
      g.stroke();
    }
  }
  g.globalAlpha = 1;

  islands.forEach((d, i) => {
    const tp = POP(i);
    const on = t >= tp;
    d.el.style.visibility = on ? 'visible' : 'hidden';
    if (!on) return;
    // Islands on the cut frame are simply there (the hit is the reveal); later ones pop.
    const pop = tp === T0 ? 1 : ez(t, tp, tp + 0.12, E.cubicOut);
    const x = par(d.x + d.vx * l + noise1(t * 0.4 + d.seed, 3) * 3, cx, d.z, 1);
    const y = par(d.y + d.vy * l + noise1(t * 0.4 + d.seed, 4) * 3, cy, d.z);
    const s = lerp(0.96, 1, pop) * lerp(1, push, d.z);
    d.el.style.transform = `translate3d(${(x - d.w / 2).toFixed(2)}px, ${(y - d.h / 2).toFixed(2)}px, 0) scale(${s.toFixed(4)})`;
    // A lit rim at rest, a glint as it lands (decaying like the pluck) and as the light passes.
    const dl = (x * ux + y * uy - band) / 300;
    const rest = d.z < 1 ? 0.16 : 0.3;
    d.gl.style.opacity = Math.max(rest, (1 - prog(t, tp, tp + 0.45)) ** 2, Math.exp(-dl * dl) * 0.6).toFixed(3);
    // The landing bloom: the exposure lift comes from the object, not the frame.
    d.bl.style.opacity = ((1 - prog(t, tp, tp + 0.14)) ** 2).toFixed(3);
  });

  // "connects" is fully up by 3.9, so it holds the film's minimum 0.6 s before the cut.
  reveal(S.pa, t, { at: 3.3, stagger: 0.06, dur: 0.4, style: 'rise' });
  reveal(S.pb, t, { at: 3.5, stagger: 0.06, dur: 0.4, style: 'rise' });
}

/* ------------------------------------------------------------------ */
/* Shot 4 · your agent drafts it all                                    */
/* ------------------------------------------------------------------ */

function renderTerminal(t) {
  const { CX, TY, LH, cw, lnBase, curH, TX, tpTop } = S;

  // Typing: the camera rides the insertion point on line 0, so the cursor stays on the
  // thread at CX and the request streams left past it. Enter's frame still holds it.
  const sub = t >= RT;
  S.lines.style.visibility = sub ? 'hidden' : 'visible';
  S.soft.style.visibility = sub ? 'hidden' : 'visible';
  S.rest.style.visibility = sub ? 'visible' : 'hidden';
  let cx = CX;
  let cy = TY;
  if (!sub) {
    const n = clamp((t - TYPE) * CPS, 0, PROMPT.length);
    const camCol = PRE + n;
    // Column c sits at CX + (c − camCol)·cw; the baseline on the thread.
    const lx = CX - TX - camCol * cw;
    const ly = TY - tpTop - lnBase;
    S.lines.style.transform = `translate3d(${lx.toFixed(2)}px, ${ly.toFixed(2)}px, 0)`;
    // Characters are uncovered at the cursor's left edge as the line streams past it.
    S.l0.style.clipPath = `inset(0 calc(100% - ${((PRE + n) * cw).toFixed(2)}px) 0 0)`;
    S.c0.forEach((el, c) => {
      el.style.opacity = pw(CX + (c + 0.5 - camCol) * cw, S.fade).toFixed(3);
    });

    // The far text, defocused: the baked bitmap at the same offset, faded across the band.
    const { sg, softW, tpH } = S;
    sg.globalCompositeOperation = 'source-over';
    sg.clearRect(0, 0, softW, tpH);
    sg.drawImage(S.b0, lx - PAD, ly - PAD);
    sg.globalCompositeOperation = 'destination-in';
    sg.fillStyle = S.softFade;
    sg.fillRect(0, 0, softW, tpH);
    sg.globalCompositeOperation = 'source-over';
  } else {
    // Enter: the input clears (a cut, like the terminal's), the request is echoed into
    // the transcript above, wrapped, and a fresh prompt takes the thread. The return's
    // fast part is the cut; what is seen is its deceleration: everything in the band
    // eases left and up into place (≤ 6 px per 1/120 s), the cursor riding it.
    const e = ez(t, RT, RT + SETTLE, E.cubicOut);
    const ox = (1 - e) * S.DX;
    const oy = (1 - e) * S.DY;
    const bx = S.XR - TX + ox;
    const by = TY - tpTop - lnBase - 2 * LH + oy;
    S.rest.style.transform = `translate3d(${bx.toFixed(2)}px, ${by.toFixed(2)}px, 0)`;
    // The echo cuts in faint and firms up, so the request is never wholly gone.
    const a = (ECHO * lerp(0.3, 1, ez(t, RT, RT + 0.2, E.cubicOut))).toFixed(3);
    for (const el of S.echo) el.style.opacity = a;
    cx = S.XR + PRE * cw + ox;
    cy = TY + oy;
  }

  // The cursor block sits on the thread at the insertion point (it only leaves the
  // thread while the fresh prompt settles after Enter).
  S.cur.style.transform = `translate3d(${cx.toFixed(2)}px, ${(cy - curH + 1).toFixed(2)}px, 0)`;

  // The thread is the live line's baseline, drawn up to where the cursor rests.
  S.thread.set({ from: 0, to: cx - TX, alpha: 0.24, fade: 1400 });

  // Camera: push 1.00 → 1.04 about the typing cursor's point (CX on the thread) while the
  // view turns slowly (the near side is the rail's). Off-horizon boxes are warped to their projected corners.
  const k = prog(t, CUT, 6);
  const push = lerp(1, 1.04, k ** 1.4);
  const ry = (lerp(S.P ? 10 : 9, S.P ? 8.5 : 7.5, E.sine(k)) * Math.PI) / 180;
  const d = S.P ? 1500 : 1700;
  const proj = (x, y) => {
    const X = (x - CX) * push;
    const z = X * Math.sin(ry);
    const q = d / (d - z);
    return [CX + X * Math.cos(ry) * q, TY + (y - TY) * push * q];
  };
  S.cam.style.transform = `scale(${push.toFixed(4)})`;

  // The rail: its head settles in once the request is sent, then recorded calls rise on
  // 16ths; counts follow the ledger (nothing before the first call).
  const rh = ez(t, SUBMIT, SUBMIT + 0.33, E.cubicOut);
  S.rh.style.opacity = rh.toFixed(3);
  const dys = [0, (1 - rh) * 14];
  let n2 = 0;
  S.calls.forEach(({ el, co }, i) => {
    const ti = CALLS[i][3];
    const on = t >= ti;
    if (on) n2++;
    const e = ez(t, ti, ti + 0.42, E.expoOut);
    el.style.visibility = on ? 'visible' : 'hidden';
    el.style.opacity = clamp(e * 1.8).toFixed(3);
    dys.push((1 - e) * 30);
    co.style.boxShadow = on ? `0 0 0 1px rgba(255,255,255,${(0.05 + 0.3 * (1 - prog(t, ti, ti + 0.5)) ** 2).toFixed(3)})` : 'none';
  });
  const count = n2 ? `${n2} ${n2 === 1 ? 'call' : 'calls'}` : '';
  S.sum.textContent = n2 ? `${count} this session` : '';
  S.barCalls.textContent = count;
  S.barCalls.style.display = n2 ? '' : 'none';

  S.warps.forEach(([el, lx0, ly0, w, h, ax, ay, s], i) => {
    const dy = dys[i] * s;
    const [x0, y0] = proj(ax, ay + dy);
    const [x1, y1] = proj(ax + w * s, ay + dy);
    const [x2, y2] = proj(ax, ay + h * s + dy);
    el.style.transform = `matrix(${((x1 - x0) / w).toFixed(5)},${((y1 - y0) / w).toFixed(5)},${((x2 - x0) / h).toFixed(5)},${((y2 - y0) / h).toFixed(5)},${(x0 - lx0).toFixed(2)},${(y0 - ly0).toFixed(2)})`;
  });

  // Live dot: the product's pulse ring, as a function of time.
  const ph = ((t - CUT) / 1.8) % 1;
  S.pulse.style.transform = `scale(${lerp(0.6, 1.8, E.cubicOut(ph)).toFixed(3)})`;
  S.pulse.style.opacity = (0.9 * (1 - ph)).toFixed(3);

  reveal(S.hl, t, { at: CUT, stagger: 0.06, dur: 0.55, style: 'rise' });
}
