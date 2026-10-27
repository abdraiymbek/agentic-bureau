// Shots 8–9 · "every change has a path." / "shaped like the work."
// The record in 3D on the graphite field (the optional rover behind it read as
// a smudge, so the map stands alone). At 10.0 the Payload capacity thread
// lights the way the product's hover does: a travelling head in signal that
// forks where the routed links part and reaches a node on every 16th (a tick
// each), pulses after, the rest of the map at 28 %. Then Level 1 — one object between its rails — in two plates under one
// held headline: the requirement as a statement with its target, and the Camera
// tray on a 3D stage with callouts projected from its geometry. Rail connectors
// run on the thread's y and end in open chevrons at the consequence; in 9:16
// inputs still enter the stage from the left and consequences leave it right.
import * as THREE from 'three';
import { E, ez, clamp, lerp, words, ic, show, $$ } from '../lib/core.js';
import { reveal } from '../lib/type.js';
import { threadY, headline } from '../lib/film.js';
import { createFlowMap, FLOWMAP_CSS, FLOWMAP_ICONS } from '../lib/flowmapView.js';
import { NW } from '../lib/flowmap.js';
import { createRoverStage } from '../lib/roverStage.js';

const TL = 10.0; // the thread lights
const T9 = 11.0; // cut to Level 1
const TB = 11.75; // plate cut: requirement → Camera tray

// The head's arrivals, each on a 16th. Payload capacity's three links share one routed trunk
// (to the Camera tray's gutter, then on to the Evidence gutter), so one head leaves Payload
// capacity and forks where they part: tray (10.125), mass (10.25), then the ramp branch
// eases down into the test (10.5); a second head leaves the mass budget for the torque (10.375).
const REACH = { payload: 10.0, tray: 10.125, mass: 10.25, torque: 10.375, ramp: 10.5 };
const TAIL = 120; // the head's bright tail, world px
// Pulses after the head: one train out of Payload capacity along every lit link at one speed,
// an 8th apart, so they ride the shared trunk as one and fork with it.
const PULSE_T = 10.5;
const PULSE_V = 1200; // world px / s
const PULSE_GAP = PULSE_V * 0.25;

const C = {
  edge: [255, 255, 255, 0.17],
  line: [255, 255, 255, 0.12],
  signalLine: [207, 243, 110, 0.55],
  signalHot: [226, 250, 160, 1],
  surface: [17, 18, 20, 1],
  signalSoft: [30, 36, 20, 1],
};
const mix = (a, b, k) => a.map((v, i) => lerp(v, b[i], k));
const col = (c) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${c[3].toFixed(3)})`;
const NS = 'http://www.w3.org/2000/svg';
const PERSP9 = 2200;

// Camera tray (lib/rover.js): plate x −18…26, z ±31, y 41…43.5; walls to y 55.5.
const TRAY = { x0: -18, xf: 26, z: 31, y0: 41, yp: 43.5, yw: 55.5 };
const TRAY_C = new THREE.Vector3(4, 47, 0);
// The Evidence column is widened so the lit path's names read in full.
const EVID_X = 1290;
const WIDE = 64;

let S;

/** Piecewise cubic Hermite through keys [[t, value, slope per second], …], held outside. */
function hermite(t, keys) {
  if (t <= keys[0][0]) return keys[0][1];
  const last = keys[keys.length - 1];
  if (t >= last[0]) return last[1];
  let i = 0;
  while (t > keys[i + 1][0]) i++;
  const [t0, v0, m0] = keys[i];
  const [t1, v1, m1] = keys[i + 1];
  const h = t1 - t0;
  const u = (t - t0) / h;
  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * v0 + (u3 - 2 * u2 + u) * h * m0 + (-2 * u3 + 3 * u2) * v1 + (u3 - u2) * h * m1;
}

/** Arc length at which two paths that leave the same point part. */
function forkAt(p, q) {
  const n = Math.min(p.getTotalLength(), q.getTotalLength());
  let s = 0;
  for (; s < n; s += 1) {
    const a = p.getPointAtLength(s);
    const b = q.getPointAtLength(s);
    if (Math.hypot(a.x - b.x, a.y - b.y) > 0.25) break;
  }
  return Math.max(0, s - 1);
}

/** Offset of `el` inside `root`, ignoring transforms. */
function offset(el, root) {
  let x = 0;
  let y = 0;
  for (let e = el; e && e !== root; e = e.offsetParent) {
    x += e.offsetLeft;
    y += e.offsetTop;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

/** A headline line whose baseline sits at y. */
function placeLine(el, x, y) {
  const probe = document.createElement('i');
  probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
  el.appendChild(probe);
  const base = probe.offsetTop;
  probe.remove();
  el.style.left = `${x}px`;
  el.style.top = `${y - base}px`;
}

// The link label keeps "· pinned" with the word before it, so a wrapped line never starts on a dot.
const railRow = (glyph, title, sub) =>
  `<div class="rl"><span class="gl">${ic(glyph)}</span><div class="rc"><div class="rt">${title}</div><div class="rs">${sub.replaceAll(' · ', '&nbsp;· ')}</div></div></div>`;

/** Level 1 camera per plate and format: [rotateY, rotateX, scale] over the plate. */
function compCam(t, portrait) {
  if (t < TB) {
    const u = E.sine(clamp((t - T9) / 0.75));
    // 9:16 turns the other way from 16:9: the side carrying the gutter connectors recedes.
    return portrait ? [lerp(3.5, 2.5, u), lerp(5, 4, u), lerp(1, 1.03, u)] : [lerp(-8, -6, u), lerp(4, 3, u), lerp(1, 1.03, u)];
  }
  const u = E.sine(clamp((t - TB) / 0.75));
  return portrait ? [lerp(-3.5, -2.5, u), lerp(4, 3, u), lerp(1, 1.025, u)] : [lerp(7, 5, u), lerp(3.5, 2.5, u), lerp(1, 1.025, u)];
}

export default function create(span) {
  const [T0] = span;
  return {
    id: 'lens',
    span,
    icons: [...new Set([...FLOWMAP_ICONS, 'list-checks', 'cube', 'package', 'calculator', 'flask', 'caret-down', 'caret-right', 'at', 'arrows-out', 'bounding-box', 'grid-four'])],
    css:
      FLOWMAP_CSS.replace(/\.fm/g, '#s-lens .fm') +
      `
#s-lens { background: #0b0c0e; }
#s-lens canvas.gl { position: absolute; left: 0; top: 0; width: 100%; height: 100%; z-index: 1; }
#s-lens .s8, #s-lens .s9 { position: absolute; inset: 0; z-index: 2; }
#s-lens .s9 { z-index: 3; perspective: ${PERSP9}px; perspective-origin: 960px 540px;
  background: radial-gradient(ellipse 52% 60% at 52% 62%, rgba(255,255,255,0.035), transparent 70%); }
#s-lens.portrait .s9 { perspective-origin: 540px 960px; background: radial-gradient(ellipse 70% 42% at 50% 60%, rgba(255,255,255,0.035), transparent 70%); }
#s-lens .cam { position: absolute; inset: 0; perspective: 1800px; perspective-origin: 50% 50%; }
#s-lens .fm { will-change: transform; }
#s-lens .fm .node.wide .nl { overflow: visible; text-overflow: clip; }
#s-lens .veil { position: absolute; left: 0; right: 0; top: 0; height: 330px; background: linear-gradient(180deg, rgba(11,12,14,0.92) 0%, rgba(11,12,14,0.6) 45%, rgba(11,12,14,0) 100%); }
#s-lens.portrait .veil { height: 600px; }
#s-lens .hl { position: absolute; inset: 0; z-index: 10; pointer-events: none; }
#s-lens .hl .ln { position: absolute; font: 600 96px/1 var(--font-sans); letter-spacing: -0.032em; color: var(--text); white-space: nowrap; }
#s-lens.portrait .hl .ln { font-size: 108px; }

/* Peek: the product's hover strip along the map's foot. */
#s-lens .peek { position: absolute; left: 50%; top: 0; z-index: 9; display: flex; align-items: center; gap: 16px; height: 64px; padding: 0 24px;
  transform: translateX(-50%); border-radius: 15px; background: var(--raised); box-shadow: var(--shadow-float);
  font: 400 24px var(--font-mono); color: var(--text-2); white-space: nowrap; }
#s-lens .peek .ic { font-size: 24px; color: var(--text-3); }
#s-lens .peek b { font: 500 25px var(--font-sans); color: var(--text); letter-spacing: -0.01em; }
#s-lens .peek i { width: 5px; height: 5px; border-radius: 50%; background: var(--text-4); }
#s-lens .peek .u { color: var(--text-3); }
#s-lens.portrait .peek { height: 80px; padding: 0 28px; font-size: 30px; gap: 18px; }
#s-lens.portrait .peek b { font-size: 31px; }
#s-lens.portrait .peek .ic { font-size: 30px; }

/* Level 1: rails · stage · rails. */
#s-lens .comp { position: absolute; inset: 0; transform-origin: 960px 540px; will-change: transform; }
#s-lens.portrait .comp { transform-origin: 540px 960px; }
#s-lens .plate { position: absolute; inset: 0; }
#s-lens .rail { position: absolute; width: 330px; display: flex; flex-direction: column; gap: 16px; }
#s-lens .rh { font: 500 20px var(--font-sans); color: var(--text-3); letter-spacing: -0.005em; display: flex; gap: 10px; margin-bottom: 4px; }
#s-lens .rh b { font-weight: 500; color: var(--text-4); }
#s-lens .rquiet { font: 400 21px/1.35 var(--font-sans); color: var(--text-3); }
#s-lens .rl { display: flex; gap: 14px; align-items: flex-start; padding: 17px 20px; border-radius: 16px; background: var(--raised); box-shadow: 0 0 0 1px var(--line); }
#s-lens .rl .gl { font-size: 23px; color: var(--text-3); line-height: 0; margin-top: 3px; }
#s-lens .rl .rc { flex: 1; min-width: 0; }
#s-lens .rt { font: 500 22px/1.28 var(--font-sans); color: var(--text); letter-spacing: -0.01em; }
#s-lens .rs { margin-top: 6px; font: 400 16.5px/1.35 var(--font-sans); color: var(--text-3); }
#s-lens .rev { display: flex; gap: 14px; padding: 15px 20px; border-radius: 16px; font: 400 18px/1.3 var(--font-sans); color: var(--text-2); }
#s-lens .rev.on { background: var(--raised); box-shadow: 0 0 0 1px var(--line); }
#s-lens .rev .mono { color: var(--text-3); }
#s-lens .rev small { display: block; margin-top: 4px; font-size: 15.5px; color: var(--text-3); }

#s-lens .stage { position: absolute; border-radius: 28px; background: linear-gradient(180deg, #141518, #111214 46%); box-shadow: 0 0 0 1px var(--line-strong); padding: 40px 44px; }
#s-lens .pa .stage { overflow: hidden; }
#s-lens .sheen { position: absolute; left: 0; top: 0; width: 70%; height: 100%; pointer-events: none; border-radius: 28px;
  background: linear-gradient(100deg, transparent 10%, rgba(255,255,255,0.045) 48%, rgba(255,255,255,0.06) 52%, transparent 90%); }
#s-lens .kind { display: flex; align-items: center; gap: 10px; font: 400 19px var(--font-sans); color: var(--text-3); }
#s-lens .kind .ic { font-size: 21px; }
#s-lens .kind .sep { font-size: 14px; color: var(--text-4); display: inline-flex; }
#s-lens .otitle { display: flex; align-items: center; margin-top: 14px; }
#s-lens .otitle h2 { font: 500 56px/1.1 var(--font-sans); letter-spacing: -0.032em; color: var(--text); }
#s-lens .ask { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; height: 40px; padding: 0 14px; border-radius: 10px; font: 500 18px var(--font-sans); color: var(--text-2); }
#s-lens .ask .ic { font-size: 19px; }
#s-lens .states { display: flex; align-items: center; gap: 18px; margin-top: 16px; font: 400 18px var(--font-sans); color: var(--text-3); }
#s-lens .states .st { display: inline-flex; align-items: center; gap: 9px; color: var(--text-2); }
/* Filled neutral dot: an approved baseline (a hollow ring would mean none), no success colour. */
#s-lens .states .st i { width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); border: 0; }
#s-lens .stmt { margin-top: 34px; font: 400 38px/1.3 var(--font-sans); letter-spacing: -0.02em; color: var(--text); max-width: 720px; white-space: normal; }
#s-lens .stmt .w { padding-bottom: 0.06em; margin-bottom: -0.06em; }
#s-lens .target { display: flex; gap: 28px; margin-top: 40px; align-items: flex-end; }
#s-lens .flabel { font: 400 18px var(--font-sans); color: var(--text-3); margin-bottom: 12px; }
#s-lens .qbox { display: flex; align-items: baseline; gap: 16px; height: 116px; padding: 0 28px; border-radius: 16px; background: var(--raised-2); box-shadow: 0 0 0 1px var(--line-control); }
#s-lens .qbox .qv { font: 400 64px/116px var(--font-mono); color: var(--text); letter-spacing: -0.01em; }
#s-lens .qbox .qu { display: inline-flex; align-items: center; gap: 8px; font: 400 30px var(--font-mono); color: var(--text-3); }
#s-lens .qbox .qu .ic { font-size: 18px; color: var(--text-4); }
#s-lens .seg { display: flex; gap: 3px; padding: 4px; height: 52px; border-radius: 12px; background: var(--raised); box-shadow: 0 0 0 1px var(--line); font: 500 19px var(--font-sans); color: var(--text-3); }
#s-lens .seg span { display: grid; place-items: center; padding: 0 18px; border-radius: 9px; }
#s-lens .seg span.on { background: var(--raised-2); color: var(--text); box-shadow: 0 0 0 1px var(--line-control); }
#s-lens .acc { margin-top: 36px; }
#s-lens .acc p { font: 400 22px/1.4 var(--font-sans); color: var(--text-2); max-width: 640px; }
#s-lens.portrait .acc { display: none; }
/* Ranked below the headline: headline → object title → target / tray callouts → Affects rows. */
#s-lens .seg, #s-lens .acc, #s-lens .ask, #s-lens .states, #s-lens .rev, #s-lens .rv, #s-lens .well .island:not(.note) { opacity: 0.32; }

#s-lens .well { position: relative; margin-top: 26px; border-radius: 20px; background: radial-gradient(ellipse at 50% 55%, rgba(255,255,255,0.045), transparent 66%), var(--canvas-bg); box-shadow: inset 0 0 0 1px var(--line); }
#s-lens .well .island { position: absolute; top: 18px; display: flex; align-items: center; gap: 14px; height: 48px; padding: 0 16px; border-radius: 15px;
  background: var(--raised); box-shadow: var(--shadow-float); font: 400 17px var(--font-sans); color: var(--text-3); z-index: 2; }
#s-lens .well .island .sel { display: inline-flex; align-items: center; gap: 8px; padding: 6px 11px; border-radius: 9px; background: var(--raised-2); color: var(--text); }
#s-lens .well .island .ic { font-size: 19px; }
#s-lens .well .revpick { left: 18px; }
#s-lens .well .tools { right: 18px; }
#s-lens .well .tools span { display: inline-flex; align-items: center; gap: 7px; }
/* The app's provenance note for this mesh (MechanicalStage "Illustrative mesh"): a pill beside the revision
   picker, as in the app's top-left viewport corner; neutral, since amber belongs to "Out of date". */
#s-lens .well .note { top: 26px; height: 32px; padding: 0 13px; border-radius: 999px; box-shadow: 0 0 0 1px var(--line-strong); font-size: 15px; color: var(--text-3); }

/* 9:16 rails: one-line rows (title · link label) stacked in a column the stage's width. */
#s-lens.portrait .rail { gap: 10px; }
#s-lens.portrait .rl { align-items: center; padding: 12px 20px; border-radius: 14px; }
#s-lens.portrait .rl .gl { margin-top: 0; }
#s-lens.portrait .rl .rc { display: flex; align-items: baseline; gap: 14px; white-space: nowrap; }
#s-lens.portrait .rs { margin-top: 0; }

#s-lens svg.links { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
#s-lens svg.links path { fill: none; stroke-linecap: round; stroke-linejoin: round; }
#s-lens svg.callouts { position: absolute; left: 0; top: 0; z-index: 6; overflow: visible; pointer-events: none; }
#s-lens svg.callouts path { fill: none; stroke: #a4a7ae; stroke-width: 1.4; stroke-linecap: round; }
#s-lens svg.callouts path.ext { stroke: #64676f; stroke-width: 1.1; }
#s-lens svg.callouts rect { fill: rgba(13,14,16,0.86); stroke: rgba(255,255,255,0.12); stroke-width: 1; }
#s-lens svg.callouts text { font: 400 22px var(--font-mono); fill: #ededee; }
#s-lens svg.callouts text tspan.u { fill: #848890; }
#s-lens svg.callouts circle { fill: #ededee; }
`,
    build(root, ctx) {
      const { W, H, portrait } = ctx;
      root.classList.toggle('portrait', portrait);
      const ty = threadY(ctx);
      const { x: hlx, y: hly } = headline(ctx);
      const lines8 = portrait ? ['every change', 'has a path.'] : ['every change has a path.'];
      const lines9 = portrait ? ['shaped like', 'the work.'] : ['shaped like the work.'];

      root.innerHTML = `
        <canvas class="gl" width="${W}" height="${H}"></canvas>
        <div class="s8"><div class="cam"></div><div class="veil"></div>
          <div class="peek">${ic('list-checks')}<b>Payload capacity</b><i></i><span>requirement</span><i></i><span>0.3 <span class="u">kg</span></span></div>
        </div>
        <div class="s9"><div class="comp">
          <div class="plate pa">
            <div class="rail ra-l"><div class="rh">Depends on</div><div class="rquiet">No recorded inputs.</div></div>
            <div class="stage"><div class="sheen"></div><div class="kind">${ic('list-checks')}<span>Requirement</span></div>
              <div class="otitle"><h2>Payload capacity</h2><span class="ask">${ic('at')} Ask agent</span></div>
              <div class="states"><span class="st"><i></i>Baseline · Approved</span><span>Revision 1</span></div>
              <p class="stmt">${words('The rover shall carry a removable payload pack without loss of mobility.')}</p>
              <div class="target"><div><div class="flabel">Target</div><div class="qbox"><span class="qv">0.3</span><span class="qu">kg ${ic('caret-down')}</span></div></div>
                <div><div class="flabel">Priority</div><div class="seg"><span class="on">Must</span><span>Should</span><span>Could</span></div></div></div>
              <div class="acc"><div class="flabel">Accepted when</div><p>Traverses a 15° ramp at ≥0.5 m/s carrying the payload; no&nbsp;slip&nbsp;or&nbsp;stall.</p></div>
            </div>
            <div class="rail ra-r"><div class="rh">Affects <b>3</b></div>
              ${railRow('cube', 'Camera tray', 'tray sized to payload requirement · pinned')}
              ${railRow('calculator', 'Rover mass budget', 'input payload · pinned')}
              ${railRow('flask', 'Ramp traverse with payload', 'test for requirement · pinned')}
              <div class="rh rv" style="margin-top:34px">Revisions <b>1</b></div>
              <div class="rev on"><span class="mono">r1</span><div>Baseline<small>Primary mission requirement</small></div></div>
            </div>
          </div>
          <div class="plate pb">
            <div class="rail rb-l"><div class="rh">Depends on <b>2</b></div>
              ${railRow('list-checks', 'Payload capacity', 'tray sized to payload requirement · pinned')}
              ${railRow('package', 'Raspberry Pi Camera Module 3 Wide', 'camera slot dimensions · pinned')}
            </div>
            <div class="stage"><div class="kind">${ic('cube')}<span>Mechanical</span><span class="sep">${ic('caret-right')}</span><span>payload</span></div>
              <div class="otitle"><h2>Camera tray</h2><span class="ask">${ic('at')} Ask agent</span></div>
              <div class="states"><span class="st"><i></i>Baseline · Approved</span><span>Revision 2</span></div>
              <div class="well">
                <div class="island revpick">Revision <span class="sel">r2 · Baseline ${ic('caret-down')}</span></div>
                <div class="island tools">${ic('arrows-out')}<span>${ic('cube')} Persp</span>${ic('bounding-box')}${ic('grid-four')}</div>
                <div class="island note">Illustrative mesh</div>
              </div>
            </div>
            <div class="rail rb-r"><div class="rh">Affects</div><div class="rquiet">Nothing depends on this yet.</div>
              <div class="rh rv" style="margin-top:34px">Revisions <b>2</b></div>
              <div class="rev on"><span class="mono">r2</span><div>Baseline<small>Attach illustrative geometry</small></div></div>
              <div class="rev"><span class="mono">r1</span><div>Superseded<small>first printable tray for the removable payload</small></div></div>
            </div>
          </div>
          <svg class="links" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"></svg>
        </div></div>
        <svg class="callouts" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"></svg>
        <div class="hl"><div class="h8">${lines8.map((l) => `<div class="ln">${words(l)}</div>`).join('')}</div><div class="h9">${lines9.map((l) => `<div class="ln">${words(l)}</div>`).join('')}</div></div>`;

      // Headlines on the shared slot; a second line sits one line lower.
      const lh = portrait ? 114 : 100;
      [$$('.h8 .ln', root), $$('.h9 .ln', root)].forEach((ls) => ls.forEach((el, i) => placeLine(el, hlx, hly + i * lh)));

      // ---- Shot 8: the map, with a signal overlay for the travelling head.
      const fm = createFlowMap(root.querySelector('.cam'));
      const svg = fm.el.querySelector('svg');
      // Widen the Evidence column so "Wheel torque at 15° incline" and "Ramp traverse with
      // payload" read in full along the lit path; its same-column loops move out with the edge.
      for (const n of fm.nodes) {
        if (n.x !== EVID_X) continue;
        n.el.style.width = `${NW + WIDE}px`;
        n.el.classList.add('wide');
      }
      for (const l of fm.links) {
        if (l.a.x !== EVID_X || l.b.x !== EVID_X) continue;
        const x = EVID_X + NW + WIDE;
        const d = `M${x} ${l.a.cy} C${x + 46} ${l.a.cy} ${x + 46} ${l.b.cy} ${x} ${l.b.cy}`;
        l.path.setAttribute('d', d);
        l.stale.setAttribute('d', d);
        l.len = l.path.getTotalLength();
        const p = l.path.getPointAtLength(l.len);
        const q = l.path.getPointAtLength(Math.max(0, l.len - 2));
        const a = Math.atan2(p.y - q.y, p.x - q.x);
        const pt = (s) => `${(p.x - Math.cos(a + s) * 6).toFixed(2)} ${(p.y - Math.sin(a + s) * 6).toFixed(2)}`;
        l.chev.setAttribute('d', `M${pt(-0.6)} L${p.x.toFixed(2)} ${p.y.toFixed(2)} L${pt(0.6)}`);
      }
      svg.insertAdjacentHTML(
        'beforeend',
        `<defs><radialGradient id="lens-glow"><stop offset="0" stop-color="#f6ffdc" stop-opacity="1"/><stop offset="0.14" stop-color="#cff36e" stop-opacity="0.8"/><stop offset="0.45" stop-color="#cff36e" stop-opacity="0.18"/><stop offset="1" stop-color="#cff36e" stop-opacity="0"/></radialGradient></defs><g class="lit"></g>`,
      );
      const gLit = svg.querySelector('.lit');
      const lit = {};
      const thread = fm.links.filter((k) => k.thread);
      for (const l of thread) {
        const d = l.path.getAttribute('d');
        const mk = (extra) => {
          const p = document.createElementNS(NS, 'path');
          p.setAttribute('d', d);
          p.setAttribute('pathLength', '1');
          p.setAttribute('style', `fill:none;stroke-linecap:round;${extra}`);
          gLit.appendChild(p);
          return p;
        };
        const tail = Math.min(TAIL, l.len * 0.6) / l.len;
        lit[l.key] = {
          line: mk('stroke:#cff36e;stroke-width:2.6;stroke-dasharray:1 1'),
          tail: mk(`stroke:#f2ffd0;stroke-width:3.6;stroke-dasharray:${tail.toFixed(4)} 2`),
          tailN: tail,
        };
      }
      // Pulses sit under the heads.
      const pulses = Array.from({ length: 14 }, () => {
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('r', '4');
        c.setAttribute('class', 'p');
        gLit.appendChild(c);
        return c;
      });
      // One head per lit link; where links share the trunk only one of them draws it.
      for (const l of thread) {
        const g = document.createElementNS(NS, 'g');
        g.innerHTML = '<circle r="46" fill="url(#lens-glow)"/><circle r="4.4" fill="#fbffe8"/>';
        gLit.appendChild(g);
        lit[l.key].head = g;
      }

      // The head's schedule, from the routed lengths: a front leaves Payload capacity fast and
      // slows through the tray (10.125) to the mass budget (10.25); past the Evidence gutter's
      // fork the ramp branch carries on and eases into the test at 10.5.
      const link = Object.fromEntries(thread.map((l) => [l.key, l]));
      const Lt = link['payload>tray'].len;
      const Lm = link['payload>mass'].len;
      const Lr = link['payload>ramp'].len;
      const Lq = link['mass>torque'].len;
      const sTray = forkAt(link['payload>tray'].path, link['payload>ramp'].path);
      const sMass = forkAt(link['payload>mass'].path, link['payload>ramp'].path);
      const s1 = Lt / 0.125;
      const s2 = (Lm - Lt) / 0.125;
      const front = [
        [10.0, 0, 0.4 * s1],
        [10.125, Lt, (s1 + s2) / 2],
        [10.25, Lm, 0.35 * s2],
      ];
      let lo = 10.0;
      let hi = 10.25;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (hermite(mid, front) < sMass) lo = mid;
        else hi = mid;
      }
      const tFork = lo;
      const vFork = (hermite(tFork + 1e-4, front) - hermite(tFork - 1e-4, front)) / 2e-4;
      const legV = (Lr - sMass) / (10.5 - tFork);
      const rampLeg = [
        [tFork, sMass, Math.min(vFork, 1.6 * legV)],
        [10.5, Lr, 0.8 * legV],
      ];
      // Distance along each link at t, the arc length from which it draws its own head and
      // pulses (the shared trunk belongs to the ramp link), and its pulse-train offset.
      const GAP = NW + WIDE; // a pulse passes through the mass budget to reach the torque link
      const plan = {
        'payload>tray': { at: (t) => Math.min(hermite(t, front), Lt), own: sTray, t0: 10.0, t1: 10.125, base: 0 },
        'payload>mass': { at: (t) => Math.min(hermite(t, front), Lm), own: sMass, t0: 10.0, t1: 10.25, base: 0 },
        'payload>ramp': { at: (t) => (t < tFork ? hermite(t, front) : hermite(t, rampLeg)), own: 0, t0: 10.0, t1: 10.5, base: 0 },
        'mass>torque': { at: (t) => hermite(t, [[10.25, 0, (1.1 * Lq) / 0.125], [10.375, Lq, (0.6 * Lq) / 0.125]]), own: 0, t0: 10.25, t1: 10.375, base: Lm + GAP },
      };
      for (const l of thread) Object.assign(lit[l.key], plan[l.key]);

      // ---- One renderer: the tray in the well (9b).
      const canvas = root.querySelector('canvas.gl');
      const stage = createRoverStage(canvas, { pointsPerMm2: 0.03, fov: 26 });
      const lights = stage.scene.children.filter((o) => o.isLight);
      const trayPart = stage.parts.find((p) => p.id === 'tray');
      // Graphite faces; the standoffs belong to the chassis assembly, not the tray object.
      const keepTray = new THREE.Plane(new THREE.Vector3(0, 1, 0), -40.9);
      trayPart.solid.material.color.set(0x2a2d33);
      trayPart.solid.material.roughness = 0.88;
      trayPart.solid.material.metalness = 0;
      trayPart.solid.material.clippingPlanes = [...trayPart.solid.material.clippingPlanes, keepTray];
      trayPart.edges.material.clippingPlanes = [...trayPart.edges.material.clippingPlanes, keepTray];
      const rimLight = new THREE.DirectionalLight(0xffffff, 0);
      rimLight.position.set(-160, 140, 40);
      stage.scene.add(rimLight);

      // ---- Level 1 layout per format. Stages are type-shaped: in 9:16 the requirement's
      // stage is shorter (its three consequences sit below it), the tray's taller.
      const pa = root.querySelector('.pa');
      const pb = root.querySelector('.pb');
      // 9:16 is inset 16 px past the 80 px margin: the push and tilt bring it out to about 80.
      const stA = portrait ? [96, 700, 888, 548] : [550, 312, 820, 860];
      const stB = portrait ? [96, 700, 888, 700] : stA;
      [[pa, stA], [pb, stB]].forEach(([pl, [x, y, w, h]]) =>
        Object.assign(pl.querySelector('.stage').style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` }),
      );
      const rails = { al: pa.querySelector('.ra-l'), ar: pa.querySelector('.ra-r'), bl: pb.querySelector('.rb-l'), br: pb.querySelector('.rb-r') };
      if (!portrait) {
        // Rails beside the stage, every header on one height across the cut; the first
        // rows (the links on the thread) centre on the thread.
        const [sx, , sw] = stA;
        for (const [k, el] of Object.entries(rails)) {
          el.style.left = `${k.endsWith('l') ? sx - 80 - 330 : sx + sw + 80}px`;
          el.style.top = '0px';
        }
        const mid = [rails.ar, rails.bl].map((el) => {
          const o = offset(el.querySelector('.rl'), el);
          return o.y + o.h / 2;
        });
        const top = Math.round(ty - (mid[0] + mid[1]) / 2);
        for (const el of Object.values(rails)) el.style.top = `${top}px`;
        // The plates tilt opposite ways, so equal tops land a few px apart on screen: nudge each
        // rail so all four headers share one screen height at the plate cut (TB).
        const comp = root.querySelector('.comp');
        const at = { al: TB - 1e-3, ar: TB - 1e-3, bl: TB, br: TB };
        for (let pass = 0; pass < 2; pass++) {
          const y = {};
          for (const [k, el] of Object.entries(rails)) {
            comp.style.transform = compMatrix(at[k], false).css;
            y[k] = el.querySelector('.rh').getBoundingClientRect().top;
          }
          const goal = (y.al + y.ar + y.bl + y.br) / 4;
          for (const [k, el] of Object.entries(rails)) el.style.top = `${(parseFloat(el.style.top) + goal - y[k]).toFixed(2)}px`;
        }
        comp.style.transform = '';
      } else {
        // A column the stage's width: inputs above, consequences below.
        for (const el of Object.values(rails)) Object.assign(el.style, { left: `${stA[0]}px`, width: `${stA[2]}px` });
        for (const el of [rails.ar, rails.br]) {
          el.style.textAlign = 'right';
          el.querySelector('.rh').style.justifyContent = 'flex-end';
          el.querySelectorAll('.rev, .rv').forEach((r) => (r.style.display = 'none'));
        }
        $$('.rl', rails.ar).forEach((r) => (r.style.textAlign = 'left'));
        rails.bl.querySelector('.rh').style.display = 'none';
        rails.al.style.top = `${stA[1] - 40 - rails.al.offsetHeight}px`;
        rails.bl.style.top = `${stB[1] - 40 - rails.bl.offsetHeight}px`;
        rails.ar.style.top = `${stA[1] + stA[3] + 30}px`;
        rails.br.style.top = `${stB[1] + stB[3] + 30}px`;
      }

      // Connectors: rail rows → stage (inputs), stage → rail rows (consequences); solid,
      // open chevron at the consequence end, corners rounded.
      const linksSvg = root.querySelector('svg.links');
      const conn = { a: [], b: [] };
      const f1 = (v) => +v.toFixed(1);
      const roundPath = (pts, r = 10) => {
        let d = `M${f1(pts[0][0])} ${f1(pts[0][1])}`;
        for (let i = 1; i < pts.length - 1; i++) {
          const [ax, ay] = pts[i - 1];
          const [cx, cy] = pts[i];
          const [bx, by] = pts[i + 1];
          const l1 = Math.hypot(cx - ax, cy - ay);
          const l2 = Math.hypot(bx - cx, by - cy);
          const rr = Math.min(r, l1 / 2, l2 / 2);
          d += ` L${f1(cx - ((cx - ax) / l1) * rr)} ${f1(cy - ((cy - ay) / l1) * rr)} Q${f1(cx)} ${f1(cy)} ${f1(cx + ((bx - cx) / l2) * rr)} ${f1(cy + ((by - cy) / l2) * rr)}`;
        }
        const e = pts[pts.length - 1];
        return `${d} L${f1(e[0])} ${f1(e[1])}`;
      };
      const chev = (x, y, ang) => {
        const s = 9;
        return `M${f1(x - Math.cos(ang - 0.6) * s)} ${f1(y - Math.sin(ang - 0.6) * s)} L${f1(x)} ${f1(y)} L${f1(x - Math.cos(ang + 0.6) * s)} ${f1(y - Math.sin(ang + 0.6) * s)}`;
      };
      const addConn = (set, pts, bright) => {
        const g = document.createElementNS(NS, 'g');
        const [p, q] = pts.slice(-2);
        const ang = Math.atan2(q[1] - p[1], q[0] - p[0]);
        g.innerHTML = `<path d="${roundPath(pts)}" pathLength="1" stroke-dasharray="1 1"/><path d="${chev(q[0], q[1], ang)}"/>`;
        g.querySelectorAll('path').forEach((el) => {
          el.style.stroke = `rgba(237,237,238,${bright})`;
          el.style.strokeWidth = '1.5';
        });
        linksSvg.appendChild(g);
        set.push({ g, line: g.children[0], head: g.children[1] });
      };
      if (!portrait) {
        // Straight on each row's centre; the row nearest the thread takes the thread's y.
        const [sx, , sw] = stA;
        const rowY = (o) => {
          const y = o.y + o.h / 2;
          return Math.abs(y - ty) < 14 ? ty : y;
        };
        $$('.rl', rails.ar).forEach((r) => {
          const o = offset(r, root);
          const y = rowY(o);
          addConn(conn.a, [[sx + sw, y], [o.x - 3, y]], y === ty ? 0.66 : 0.32);
        });
        $$('.rl', rails.bl).forEach((r) => {
          const o = offset(r, root);
          const y = rowY(o);
          addConn(conn.b, [[o.x + o.w, y], [sx - 3, y]], y === ty ? 0.66 : 0.32);
        });
      } else {
        // Consequences leave the stage's right edge and turn into each row's right end;
        // inputs leave each row's left side and enter the stage's left edge. Nested, never crossing.
        const [ax, ay, aw, ah] = stA;
        $$('.rl', rails.ar).forEach((r, i) => {
          const o = offset(r, root);
          const cy = o.y + o.h / 2;
          const g = ax + aw + 18 + i * 12;
          const e = ay + ah - 40 - i * 18;
          addConn(conn.a, [[ax + aw, e], [g, e], [g, cy], [o.x + o.w + 3, cy]], 0.42);
        });
        const [bx, by] = stB;
        const rowsB = $$('.rl', rails.bl);
        rowsB.forEach((r, i) => {
          const o = offset(r, root);
          const cy = o.y + o.h / 2;
          const k = rowsB.length - 1 - i;
          const g = bx - 18 - k * 12;
          const e = by + 40 + k * 18;
          addConn(conn.b, [[o.x, cy], [g, cy], [g, e], [bx - 3, e]], 0.42);
        });
      }

      // The well: the tray is framed on its centre, projected through the tilt.
      const well = pb.querySelector('.well');
      const stBEl = pb.querySelector('.stage');
      well.style.height = `${stB[3] - offset(well, stBEl).y - (portrait ? 44 : 120)}px`;
      const wr = offset(well, root);
      // "Illustrative mesh" qualifies the shown revision: it sits right of the picker.
      const revpick = well.querySelector('.revpick');
      well.querySelector('.note').style.left = `${revpick.offsetLeft + revpick.offsetWidth + 12}px`;

      // Callouts, projected each frame from 3D anchors on the tray.
      const callSvg = root.querySelector('svg.callouts');
      const mkLabel = (value, unit) => {
        const g = document.createElementNS(NS, 'g');
        g.innerHTML = `<rect rx="8" ry="8"/><text><tspan>${value}</tspan><tspan class="u"> ${unit}</tspan></text>`;
        callSvg.appendChild(g);
        const text = g.querySelector('text');
        const bb = text.getBBox();
        const rect = g.querySelector('rect');
        const pw = 12;
        rect.setAttribute('x', String(-bb.width / 2 - pw));
        rect.setAttribute('y', '-19');
        rect.setAttribute('width', String(bb.width + pw * 2));
        rect.setAttribute('height', '38');
        text.setAttribute('x', String(-bb.width / 2));
        text.setAttribute('y', '8');
        return { g, w: bb.width + pw * 2 };
      };
      const mkPath = (cls = '') => {
        const p = document.createElementNS(NS, 'path');
        if (cls) p.setAttribute('class', cls);
        callSvg.appendChild(p);
        return p;
      };
      const { x0, xf, z, y0, yp, yw } = TRAY;
      const V = (x, y, zz) => new THREE.Vector3(x, y, zz);
      const callouts = [
        // Width across the front edge: the near callout, there on the cut.
        { kind: 'dim', a: V(xf + 14, y0, -z), b: V(xf + 14, y0, z), ea: [V(xf + 3, y0, -z), V(xf + 17, y0, -z)], eb: [V(xf + 3, y0, z), V(xf + 17, y0, z)], label: mkLabel('62', 'mm'), off: 34, at: TB },
        // Depth along the near side.
        { kind: 'dim', a: V(x0, y0, z + 14), b: V(xf, y0, z + 14), ea: [V(x0, y0, z + 3), V(x0, y0, z + 17)], eb: [V(xf, y0, z + 3), V(xf, y0, z + 17)], label: mkLabel('44', 'mm'), off: 34, at: TB + 0.14 },
        // Plate thickness at the front corner, right of the slot.
        { kind: 'lead', p: V(xf, (y0 + yp) / 2, -z + 10), dir: [0.1, -1], len: 112, above: true, label: mkLabel('2.5', 'mm plate'), at: TB + 0.24 },
        // Wall height on the near wall's top (camera-tray.scad wall_h = 12; walls are 2 mm thick).
        { kind: 'lead', p: V(x0 + 14, yw, z - 1), dir: [-0.12, -1], len: 92, above: true, label: mkLabel('12', 'mm wall height'), at: TB + 0.32 },
      ];
      for (const c of callouts) {
        c.line = mkPath();
        c.line.setAttribute('pathLength', '1');
        c.line.setAttribute('stroke-dasharray', '1 1');
        if (c.kind === 'dim') {
          c.e1 = mkPath('ext');
          c.e2 = mkPath('ext');
        } else {
          c.dot = document.createElementNS(NS, 'circle');
          c.dot.setAttribute('r', '3.4');
          callSvg.appendChild(c.dot);
        }
        callSvg.appendChild(c.label.g);
      }

      S = {
        ty,
        s8: root.querySelector('.s8'),
        s9: root.querySelector('.s9'),
        comp: root.querySelector('.comp'),
        pa,
        pb,
        h8: root.querySelector('.h8'),
        h9: root.querySelector('.h9'),
        w8: $$('.h8 .w > span', root),
        w9: $$('.h9 .w > span', root),
        peek: root.querySelector('.peek'),
        sheen: root.querySelector('.pa .sheen'),
        stmt: $$('.pa .stmt .w > span', root),
        rowsA: $$('.rl', rails.ar),
        rowsB: $$('.rl', rails.bl),
        conn,
        fm,
        lit,
        pulses,
        canvas,
        stage,
        lights,
        rimLight,
        wr,
        callSvg,
        callouts,
        v: new THREE.Vector3(),
        // Column heads and type-group labels, and the line under which they may show: just below
        // the headline's last baseline.
        labels: [...fm.el.querySelectorAll('.head, .grp')],
        hlFloor: hly + (lines8.length - 1) * lh + 12,
      };
      // 9:16: under the lowest lit node, clear of the platform caption zone (y > 1540).
      S.peek.style.top = `${portrait ? 1420 : 952}px`;
    },

    render(t, ctx) {
      const shot8 = t < T9;
      show(S.s8, shot8 ? 1 : 0);
      show(S.s9, shot8 ? 0 : 1);
      show(S.h8, shot8 ? 1 : 0);
      show(S.h9, shot8 ? 0 : 1);
      if (shot8) {
        renderMap(t, ctx);
        reveal(S.w8, t, { at: T0 + 0.02, stagger: 0.06, dur: 0.6, style: 'rise' });
        show(S.canvas, 0);
        show(S.callSvg, 0);
      } else {
        renderObject(t, ctx);
        reveal(S.w9, t, { at: T9 + 0.02, stagger: 0.06, dur: 0.6, style: 'rise' });
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Shot 8 · the map in 3D, the thread lit                                */
/* ------------------------------------------------------------------ */

/**
 * Map camera [pivot x, pivot y, screen x, rotateX, rotateY, scale, rotateZ]: the pivot (a map
 * point) rides the thread's y while the camera trucks right along the thread. In 9:16 the map
 * turns a little (12°) so the thread falls gently top-left → bottom-right while its labels stay
 * close to horizontal.
 *
 * The truck's speed is its blur (4 sub-frames per 60 fps frame), so it is one constant move from
 * cut to cut, never a dash through the reach: under 2.5 px per 1/240 s on screen. Scale and turn
 * hold; only the truck and a slight crane move. 9:16 sits the map at 1:1 and turns it a little
 * more, so its far side is shorter and the frame travels less. Payload capacity is at the left
 * edge when the thread lights (10.0). 16:9 frames every arrival as it lands, the torque bracket
 * by 10.375; the narrow 9:16 frame sees the tray (10.125), the mass budget (10.25, at the edge)
 * and the ramp (10.5) land, then the truck brings in the lit torque and its bracket.
 */
const MAP_CAM = {
  landscape: [[408, 176, 820, 27, 14, 1.3, 0], [925, 236, 820, 24.5, 14, 1.3, 0]],
  portrait: [[298, 176, 520, 22, 12, 1, 12], [1062, 240, 520, 20, 12, 1, 11]],
};
function mapCam(t, portrait) {
  const [a, b] = MAP_CAM[portrait ? 'portrait' : 'landscape'];
  const u = clamp((t - 9.5) / (T9 - 9.5));
  return a.map((v, i) => lerp(v, b[i], u));
}

function renderMap(t, ctx) {
  const { fm, lit, pulses } = S;
  const [px, py, cx, rx, ry, s, rz] = mapCam(t, ctx.portrait);
  fm.el.style.transform = `translate3d(${cx.toFixed(2)}px,${S.ty}px,0) rotateZ(${rz.toFixed(3)}deg) rotateX(${rx.toFixed(3)}deg) rotateY(${ry.toFixed(3)}deg) scale(${s.toFixed(4)}) translate3d(${(-px).toFixed(2)}px,${(-py).toFixed(2)}px,0)`;

  // The product's hover: the rest steps back to 28 % as the thread lights. Wheel radius
  // (loaded) keeps its hollow no-baseline ring, as in snap. Pulses are this scene's own.
  const L = ez(t, TL, TL + 0.14, E.cubicOut);
  fm.render({ lit: L, pulseT: null, marks: (id) => (id === 'wheel' ? 'ring' : '') });
  // As the crane lifts the map, a label rising into the headline's row (in 16:9 "Parts 14" left
  // of "every") steps out over the 48 px below the headline's baseline instead of sliding
  // through it. Measured on screen, so it follows the camera exactly.
  const labelK = lerp(1, 0.5, L);
  for (const el of S.labels) el.style.opacity = (labelK * clamp((el.getBoundingClientRect().top - S.hlFloor) / 48)).toFixed(3);

  // Thread nodes light as the head reaches them, each with a tick.
  for (const id of Object.keys(REACH)) {
    const n = fm.byId[id];
    const r = REACH[id];
    const k = ez(t, r, r + 0.09, E.cubicOut);
    const sp = t >= r ? Math.exp(-(t - r) / 0.16) : 0;
    const hov = id === 'payload' ? 0.35 * k : 0;
    n.el.style.borderColor = col(mix(mix(C.line, C.signalLine, k), C.signalHot, clamp(sp * 0.85 + hov)));
    n.el.style.background = col(mix(C.surface, C.signalSoft, k));
    n.el.style.boxShadow = k > 0.01 ? `0 0 ${(26 + 40 * sp).toFixed(1)}px rgba(207,243,110,${(0.12 * k + 0.32 * sp + 0.05 * hov).toFixed(3)})` : 'none';
    n.el.style.color = k > 0.5 ? 'var(--text)' : '';
    n.el.style.transform = `scale(${(1 + 0.035 * sp + 0.02 * hov).toFixed(4)})`;
  }

  // Thread links stay white until the head draws them in signal.
  const pk = L * ez(t, PULSE_T, PULSE_T + 0.25, E.cubicOut);
  const train = (((PULSE_V * (t - PULSE_T)) % PULSE_GAP) + PULSE_GAP) % PULSE_GAP;
  let pi = 0;
  for (const l of fm.links) {
    if (!l.thread) continue;
    const o = lit[l.key];
    const d = t < o.t0 ? 0 : o.at(t);
    const p = clamp(d / l.len);
    l.path.style.stroke = col(C.edge);
    l.path.style.strokeWidth = '1.5';
    l.chev.style.stroke = t >= o.t1 ? '#cff36e' : col(C.edge);
    o.line.style.strokeDashoffset = (1 - p).toFixed(4);
    o.line.style.opacity = t >= o.t0 ? '1' : '0';
    o.tail.style.strokeDashoffset = (o.tailN - p).toFixed(4);
    const moving = t >= o.t0 && t < o.t1;
    o.tail.style.opacity = moving ? '1' : '0';
    // The head, drawn by this link only on its own branch (the trunk is the ramp link's).
    const own = moving && (o.own === 0 || d > o.own + 2);
    if (own) {
      const q = l.path.getPointAtLength(d);
      o.head.setAttribute('transform', `translate(${q.x.toFixed(2)} ${q.y.toFixed(2)})`);
    }
    o.head.style.opacity = own ? '1' : '0';
    // Pulses on this link's own stretch, faded in out of Payload capacity and the mass budget
    // and out into each consequence.
    if (pk > 0.001) {
      const lo = o.base + o.own;
      const hi = o.base + l.len;
      for (let g = Math.ceil((lo - train) / PULSE_GAP) * PULSE_GAP + train; g <= hi && pi < pulses.length; g += PULSE_GAP) {
        const s0 = g - o.base;
        const q = l.path.getPointAtLength(s0);
        const a = pk * clamp(s0 / (o.base ? 24 : 60)) * clamp((l.len - s0) / 36);
        const c = pulses[pi++];
        c.setAttribute('cx', q.x.toFixed(2));
        c.setAttribute('cy', q.y.toFixed(2));
        c.style.opacity = a.toFixed(3);
      }
    }
  }
  for (; pi < pulses.length; pi++) pulses[pi].style.opacity = '0';

  // Peek: the hovered object, as the product shows it.
  show(S.peek, ez(t, TL, TL + 0.12, E.cubicOut));
}

function setLights(k, rim) {
  const [hemi, key, back] = S.lights;
  hemi.intensity = lerp(0.25, 1.1, k);
  key.intensity = lerp(1.7, 2.6, k);
  back.intensity = lerp(1.6, 1.4, k);
  S.rimLight.intensity = rim;
}

/* ------------------------------------------------------------------ */
/* Shot 9 · Level 1: the requirement, then the Camera tray                */
/* ------------------------------------------------------------------ */

function compMatrix(t, portrait) {
  const [ry, rx, s] = compCam(t, portrait);
  const [ox, oy] = portrait ? [540, 960] : [960, 540];
  const css = `rotateY(${ry.toFixed(3)}deg) rotateX(${rx.toFixed(3)}deg) scale(${s.toFixed(4)})`;
  return { css, m: new DOMMatrix(`translate(${ox}px,${oy}px) ${css} translate(${-ox}px,${-oy}px)`), ox, oy };
}

/** Screen position of a point on the Level 1 plane (through its tilt and the perspective). */
function projComp(M, x, y) {
  const q = M.m.transformPoint(new DOMPoint(x, y, 0));
  const k = PERSP9 / (PERSP9 - q.z);
  return [M.ox + (q.x - M.ox) * k, M.oy + (q.y - M.oy) * k];
}

function renderObject(t, ctx) {
  const plateB = t >= TB;
  show(S.pa, plateB ? 0 : 1);
  show(S.pb, plateB ? 1 : 0);
  S.conn.a.forEach((c) => show(c.g, plateB ? 0 : 1));
  S.conn.b.forEach((c) => show(c.g, plateB ? 1 : 0));
  const M = compMatrix(t, ctx.portrait);
  S.comp.style.transform = M.css;

  if (!plateB) {
    // (a) The requirement: the statement reads across, consequences connect.
    reveal(S.stmt, t, { at: T9, stagger: 0.022, dur: 0.32, style: 'dim', dimFrom: 0.32 });
    // A soft light crosses the stage with the reading.
    const sw = ez(t, T9, T9 + 0.7, E.sine);
    S.sheen.style.transform = `translate3d(${lerp(-75, 150, sw).toFixed(2)}%,0,0)`;
    S.sheen.style.opacity = (Math.sin(Math.PI * sw) * 1).toFixed(3);
    S.rowsA.forEach((r, i) => {
      const k = ez(t, T9 + 0.12 + i * 0.07, T9 + 0.5 + i * 0.07, E.expoOut);
      r.style.transform = ctx.portrait ? `translate3d(0,${((1 - k) * 18).toFixed(2)}px,0)` : `translate3d(${((1 - k) * 22).toFixed(2)}px,0,0)`;
      r.style.opacity = (0.25 + 0.75 * k).toFixed(3);
      // The Camera tray link takes the hover just before the plate cuts to it.
      const h = i === 0 ? ez(t, TB - 0.2, TB - 0.08, E.cubicOut) : 0;
      r.style.background = h > 0 ? `rgb(${lerp(23, 30, h) | 0},${lerp(24, 31, h) | 0},${lerp(27, 35, h) | 0})` : '';
      r.style.boxShadow = h > 0 ? `0 0 0 1px rgba(255,255,255,${lerp(0.07, 0.2, h).toFixed(3)})` : '';
    });
    S.conn.a.forEach((c, i) => drawConn(c, ez(t, T9 + 0.06 + i * 0.07, T9 + 0.42 + i * 0.07, E.cubicInOut)));
    show(S.canvas, 0);
    show(S.callSvg, 0);
    return;
  }

  // (b) The Camera tray on its stage.
  S.conn.b.forEach((c, i) => drawConn(c, ez(t, TB + 0.04 + i * 0.08, TB + 0.4 + i * 0.08, E.cubicInOut)));
  renderTray(t, ctx, M);
}

function drawConn(c, k) {
  c.line.style.strokeDashoffset = (1 - k).toFixed(4);
  c.head.style.opacity = clamp((k - 0.8) / 0.2).toFixed(3);
}

function renderTray(t, ctx, M) {
  const { stage, canvas, wr } = S;
  const { W, H, portrait } = ctx;
  show(canvas, 1);
  canvas.style.zIndex = '4';
  // Centre the tray in the well (shift the frustum, keep the perspective).
  const [wcx, wcy] = projComp(M, wr.x + wr.w / 2, wr.y + wr.h * (portrait ? 0.56 : 0.53));
  stage.camera.setViewOffset(W, H, W / 2 - wcx, H / 2 - wcy, W, H);
  setLights(0, 2.4);

  const u = clamp((t - TB) / 0.75);
  const az = lerp(0.36, 0.36 + (18 * Math.PI) / 180, E.sineOut(u));
  const elv = 0.46;
  const R = (portrait ? 560 : 310) * lerp(1.05, 1, E.sineOut(u));
  const pos = [TRAY_C.x + R * Math.cos(elv) * Math.cos(az), TRAY_C.y + R * Math.sin(elv), TRAY_C.z + R * Math.cos(elv) * Math.sin(az)];
  // Rack focus: the tray resolves out of bokeh behind the near callout.
  const f = ez(t, TB, TB + 0.34, E.cubicInOut);
  stage.render({
    cam: { pos, target: TRAY_C.toArray(), fov: 26 },
    looks: { points: lerp(1, 0, f), edges: lerp(0.16, 0.95, f), solid: lerp(0.12, 1, f) },
    partAlpha: (id) => (id === 'tray' ? 1 : 0),
    focus: lerp(R * 0.5, R, f),
    aperture: lerp(22, 0, f),
    pointSize: 1.25,
    glow: 0.6,
    base: 0xc9ccd2,
    groundAlpha: 0,
    keyPos: [140, 260, 160],
    edgeColor: 0xededee,
  });

  // Callouts from 3D anchors.
  show(S.callSvg, 1);
  const P = (v) => {
    S.v.copy(v).project(stage.camera);
    return [(S.v.x + 1) * 0.5 * W, (1 - S.v.y) * 0.5 * H];
  };
  const seg = (a, b) => `M${a[0].toFixed(1)} ${a[1].toFixed(1)} L${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
  const cc = P(TRAY_C);
  for (const c of S.callouts) {
    const k = c.at <= TB ? 1 : ez(t, c.at, c.at + 0.3, E.cubicInOut);
    const lk = c.at <= TB ? 1 : ez(t, c.at + 0.1, c.at + 0.34, E.cubicOut);
    if (c.kind === 'dim') {
      const a = P(c.a);
      const b = P(c.b);
      c.line.setAttribute('d', seg(a, b));
      c.e1.setAttribute('d', seg(P(c.ea[0]), P(c.ea[1])));
      c.e2.setAttribute('d', seg(P(c.eb[0]), P(c.eb[1])));
      c.line.style.strokeDashoffset = (1 - k).toFixed(4);
      c.e1.style.opacity = c.e2.style.opacity = k.toFixed(3);
      // Label beside the dimension line, away from the tray.
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      let nx = -(b[1] - a[1]);
      let ny = b[0] - a[0];
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl;
      ny /= nl;
      if (nx * (m[0] - cc[0]) + ny * (m[1] - cc[1]) < 0) {
        nx = -nx;
        ny = -ny;
      }
      c.label.g.setAttribute('transform', `translate(${(m[0] + nx * c.off).toFixed(1)} ${(m[1] + ny * c.off).toFixed(1)})`);
    } else {
      const p = P(c.p);
      const dl = Math.hypot(c.dir[0], c.dir[1]);
      const q = [p[0] + (c.dir[0] / dl) * c.len, p[1] + (c.dir[1] / dl) * c.len];
      c.line.setAttribute('d', seg(p, q));
      c.line.style.strokeDashoffset = (1 - k).toFixed(4);
      c.dot.setAttribute('cx', p[0].toFixed(1));
      c.dot.setAttribute('cy', p[1].toFixed(1));
      c.dot.style.opacity = k > 0 ? '1' : '0';
      const side = c.dir[0] < 0 ? -1 : 1;
      const at = c.above ? [q[0], q[1] - 26] : [q[0] + side * (c.label.w / 2 + 6), q[1]];
      c.label.g.setAttribute('transform', `translate(${at[0].toFixed(1)} ${at[1].toFixed(1)})`);
    }
    c.label.g.style.opacity = lk.toFixed(3);
  }
}
