// Omen Flow launch trailer. Every visual property is a pure function of time,
// so the preview and the frame-by-frame render are identical.
import { createTray } from './tray.js';

export const DURATION = 18.5;
const W = 1920;
const H = 1080;

/* ------------------------------------------------------------------ */
/* Math                                                                 */
/* ------------------------------------------------------------------ */

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, k) => a + (b - a) * k;
const prog = (t, a, b) => clamp((t - a) / (b - a));
const E = {
  lin: (x) => x,
  sine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
  cubicOut: (x) => 1 - (1 - x) ** 3,
  cubicInOut: (x) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2),
  quartOut: (x) => 1 - (1 - x) ** 4,
  expoOut: (x) => (x >= 1 ? 1 : 1 - 2 ** (-10 * x)),
  expoIn: (x) => (x <= 0 ? 0 : 2 ** (10 * x - 10)),
  expoInOut: (x) =>
    x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? 2 ** (20 * x - 10) / 2 : (2 - 2 ** (-20 * x + 10)) / 2,
  backOut: (x) => 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2,
};
const ez = (t, a, b, fn = E.expoOut) => fn(prog(t, a, b));
/** Visible between an eased entrance [a,b] and an eased exit [c,d]. */
const env = (t, a, b, c, d, fi = E.expoOut, fo = E.cubicInOut) => ez(t, a, b, fi) * (1 - ez(t, c, d, fo));

function track(t, keys) {
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

function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mix = (a, b, k) => a.map((v, i) => lerp(v, b[i], k));
const C = {
  line: [255, 255, 255, 0.12],
  edge: [255, 255, 255, 0.17],
  signal: [207, 243, 110, 1],
  signalLine: [207, 243, 110, 0.55],
  warn: [241, 187, 104, 1],
  surface: [17, 18, 20, 1],
  signalSoft: [30, 36, 20, 1],
  warnSoft: [34, 29, 21, 1],
};
const col = (c) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${c[3].toFixed(3)})`;

/* ------------------------------------------------------------------ */
/* Assets                                                               */
/* ------------------------------------------------------------------ */

const ICON_NAMES = [
  'list-checks', 'question', 'link', 'package', 'tree-structure', 'cube', 'circuitry', 'wrench',
  'calculator', 'flask', 'git-branch', 'arrow-right', 'at', 'arrows-out', 'arrow-counter-clockwise',
  'grid-four', 'bounding-box', 'warning-circle', 'caret-down', 'arrow-square-out', 'caret-left',
  'caret-right',
];
const ICONS = {};
async function loadIcons() {
  await Promise.all(
    ICON_NAMES.map(async (n) => {
      const svg = await (await fetch(`../node_modules/@phosphor-icons/core/assets/regular/${n}.svg`)).text();
      ICONS[n] = svg.replace(/<svg[^>]*>/, '').replace('</svg>', '');
    }),
  );
}
const ic = (n, cls = 'ic') =>
  `<svg class="${cls}" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">${ICONS[n]}</svg>`;

const MARK = `<svg class="mark" viewBox="60 48 380 380" fill="currentColor" stroke="currentColor" stroke-width="5" stroke-linejoin="round" aria-hidden="true"><path d="M241.5 84 L227.2 253 Q225.8 267.5 213.5 276 L70.5 375 Z"/><path d="M258.5 84 L272.8 253 Q274.2 267.5 286.5 276 L429.5 375 Z"/><path d="M80 393 L238 325 Q250 318.5 262 325 L420 393 Z"/></svg>`;

const words = (text) =>
  text
    .split(' ')
    .map((w) => `<span class="w"><span>${w}</span></span>`)
    .join(' ');
const letters = (text) =>
  [...text].map((ch) => `<span class="w"><span>${ch}</span></span>`).join('');
const state = (tone, label, cls = '') => `<span class="state ${tone} ${cls}"><i></i>${label}</span>`;

/* ------------------------------------------------------------------ */
/* Project data — the Sable inspection rover fixture                    */
/* ------------------------------------------------------------------ */

const TYPE_ICON = {
  requirement: 'list-checks', assumption: 'question', source: 'link', component: 'package',
  architecture: 'tree-structure', mechanical: 'cube', wiring: 'circuitry', assembly: 'wrench',
  calculation: 'calculator', test: 'flask',
};
const NW = 250;
const NH = 46;
const WC = [770, 266]; // world centre
const NODES = [
  ['endurance', 'requirement', 'Endurance', 0, 92],
  ['payload', 'requirement', 'Payload capacity', 0, 150],
  ['wheel', 'assumption', 'Wheel radius (loaded)', 0, 240],
  ['s_batt', 'source', 'LiPo 2S 450 mAh pack (supplier listing)', 330, 92],
  ['s_reg', 'source', 'Pololu D24V22F5 5 V step-down regulator', 330, 150],
  ['s_drv', 'source', 'Pololu DRV8835 dual motor driver carrier', 330, 208],
  ['s_m100', 'source', 'Pololu Micro Metal Gearmotor HP 6V, 100:1', 330, 266],
  ['s_m50', 'source', 'Pololu Micro Metal Gearmotor HP 6V, 50:1', 330, 324],
  ['s_cam', 'source', 'Raspberry Pi Camera Module 3 Wide', 330, 382],
  ['s_pi', 'source', 'Raspberry Pi Zero 2 W', 330, 440],
  ['c_batt', 'component', 'LiPo 2S 450 mAh 30C pack', 630, 92],
  ['c_reg', 'component', 'D24V22F5 5 V step-down regulator', 630, 150],
  ['c_drv', 'component', 'DRV8835 dual motor driver carrier', 630, 208],
  ['c_m100', 'component', 'Micro Metal Gearmotor HP 6V 100:1', 630, 266],
  ['c_m50', 'component', 'Micro Metal Gearmotor HP 6V 50:1', 630, 324],
  ['c_cam', 'component', 'Raspberry Pi Camera Module 3 Wide', 630, 382],
  ['c_pi', 'component', 'Raspberry Pi Zero 2 W', 630, 440],
  ['arch', 'architecture', 'System architecture', 960, 92],
  ['tray', 'mechanical', 'Camera tray', 960, 182],
  ['wiring', 'wiring', 'Power + signal wiring', 960, 272],
  ['chassis', 'assembly', 'Chassis assembly', 960, 362],
  ['power', 'calculation', 'Electrical power budget', 1290, 92],
  ['energy', 'calculation', 'Usable pack energy', 1290, 150],
  ['mass', 'calculation', 'Rover mass budget', 1290, 208],
  ['torque', 'calculation', 'Wheel torque at 15° incline', 1290, 266],
  ['ramp', 'test', 'Ramp traverse with payload', 1290, 356],
].map(([id, type, label, x, y]) => ({ id, type, label, x, y, cx: x + NW / 2, cy: y + NH / 2 }));
const NODE = Object.fromEntries(NODES.map((n) => [n.id, n]));
const COL_INDEX = { 0: 0, 330: 1, 630: 2, 960: 3, 1290: 4 };
const HEADS = [
  [0, 'Intent', 3], [330, 'Parts', 14], [960, 'Design', 4], [1290, 'Evidence', 5],
];
const GROUPS = [
  [0, 66, 'Requirements', 2], [0, 214, 'Assumptions', 1], [330, 66, 'Sources', 7],
  [630, 66, 'Components', 7], [960, 66, 'Architecture', 1], [960, 156, 'Mechanical', 1],
  [960, 246, 'Electronics', 1], [960, 336, 'Assembly', 1], [1290, 66, 'Calculations', 4],
  [1290, 330, 'Tests', 1],
];
const LINKS = [
  ['s_batt', 'c_batt'], ['s_reg', 'c_reg'], ['s_drv', 'c_drv'], ['s_m100', 'c_m100'],
  ['s_m50', 'c_m50'], ['s_cam', 'c_cam'], ['s_pi', 'c_pi'], ['payload', 'tray'], ['payload', 'mass'],
  ['c_cam', 'tray'], ['c_batt', 'arch'], ['c_batt', 'wiring'], ['c_batt', 'energy'],
  ['c_batt', 'mass'], ['c_reg', 'wiring'], ['c_drv', 'wiring'], ['c_pi', 'wiring'], ['c_drv', 'arch'],
  ['c_m100', 'chassis'], ['c_pi', 'arch'], ['mass', 'torque'], ['wheel', 'torque'],
  ['torque', 'ramp'], ['endurance', 'energy'], ['wiring', 'power'], ['arch', 'power'],
].map(([a, b]) => ({ a: NODE[a], b: NODE[b], key: `${a}>${b}` }));

// Hovering Payload capacity lights its downstream thread.
const THREAD_NODES = new Set(['payload', 'tray', 'mass', 'torque', 'ramp']);
const THREAD_LINKS = new Set(['payload>tray', 'payload>mass', 'mass>torque', 'torque>ramp']);
// After approval the impact travels the same recorded path (seconds after approval).
const STALE_LINKS = { 'payload>tray': 12.95, 'payload>mass': 12.95, 'mass>torque': 13.3, 'torque>ramp': 13.6 };
const STALE_NODES = { tray: 13.28, mass: 13.28, torque: 13.6, ramp: 13.9 };

function linkPath(l) {
  const { a, b } = l;
  if (a.x === b.x) {
    const x = a.x + NW;
    return `M${x} ${a.cy} C${x + 46} ${a.cy} ${x + 46} ${b.cy} ${x} ${b.cy}`;
  }
  const x1 = a.x + NW;
  const x2 = b.x;
  const dx = Math.max(40, (x2 - x1) * 0.5);
  return `M${x1} ${a.cy} C${x1 + dx} ${a.cy} ${x2 - dx} ${b.cy} ${x2} ${b.cy}`;
}

/* ------------------------------------------------------------------ */
/* DOM                                                                  */
/* ------------------------------------------------------------------ */

const PROMPT =
  'Build a compact inspection rover with a removable camera tray. 300 g sensor payload, 30 min runtime, indoor floors and short ramps.';
const RESUME =
  'Resume from decision: Payload capacity approved at 0.5 kg (r2). Revisit Camera tray, Rover mass budget, Wheel torque at 15° incline and Ramp traverse with payload.';
const RATIONALE = 'Sensor pack grew to 500 g. The ramp traverse will confirm.';
const TERM_LINES = [
  ['requirements', 3, 'drafted'],
  ['parts', 14, 'sourced'],
  ['design + evidence', 9, 'proposed'],
];

function buildStage(stage) {
  stage.innerHTML = `
  <div id="bg" class="layer"><div class="dots"></div><div class="halo"></div></div>

  <div id="flow-cam" class="layer"><div id="world">
    <svg id="links" width="1600" height="520" viewBox="0 0 1600 520" overflow="visible">
      <g class="base"></g><g class="stale"></g><g class="streaks"></g><g class="pulses"></g>
    </svg>
    <div id="nodes"></div>
  </div></div>

  <div id="needs" class="island">
    <div class="rh">Needs you <b>4</b></div>
    ${[
      ['Camera tray', 'Mechanical'],
      ['Rover mass budget', 'Calculation'],
      ['Wheel torque at 15° incline', 'Calculation'],
      ['Ramp traverse with payload', 'Test'],
    ]
      .map(
        ([t, k]) =>
          `<div class="nrow">${ic('warning-circle')}<div><div class="nt">${t}</div><div class="ns">${k} · an input changed since it was recorded</div></div></div>`,
      )
      .join('')}
  </div>

  <div id="obj" class="layer persp"><div class="obj-frame">
    <div class="rail left">
      <div class="rh">Depends on <b>2</b></div>
      <div class="rlink">${ic('list-checks')}<div><div class="rt">Payload capacity</div><div class="rs">tray sized to payload requirement · pinned</div></div><i class="mk warn"></i><span class="conn"></span></div>
      <div class="rlink">${ic('package')}<div><div class="rt">Raspberry Pi Camera Module 3 Wide</div><div class="rs">camera slot dimensions · pinned</div></div><span class="conn"></span></div>
      <div class="rh sp">Record</div>
      <dl class="facts"><dt>Origin</dt><dd>user</dd><dt>Recorded</dt><dd>1 min ago</dd><dt>Material</dt><dd>PLA · assumption</dd><dt>Identifier</dt><dd class="mono">e7da2b35</dd></dl>
    </div>
    <div class="ostage">
      <div class="crumb">${ic('cube')} Mechanical <span>›</span> payload</div>
      <div class="otitle"><h2>Camera tray</h2><span class="ask">${ic('at')} Ask agent</span></div>
      <div class="states">${state('ok', 'Approved')}${state('ok', 'Current')}<span class="rev">Revision 2</span></div>
      <div class="well">
        <canvas id="tray" width="1680" height="860"></canvas>
        <div class="island revpick">Revision <span class="sel">r2 · Baseline ${ic('caret-down')}</span></div>
        <div class="island tools">${ic('arrows-out')}<span>${ic('cube')} Persp</span>${ic('bounding-box')}${ic('grid-four')}${ic('arrow-counter-clockwise')}</div>
        <div class="dims mono"><span></span></div>
      </div>
      <div class="params">
        ${[
          ['tray_width', 62, 'Payload bay width'],
          ['tray_depth', 44, 'Front-to-back depth'],
          ['tray_thick', 2.5, 'Plate thickness'],
        ]
          .map(
            ([n, v, d]) =>
              `<div class="param"><div class="pn mono">${n}</div><div class="pv mono"><span data-v="${v}">0</span> mm</div><div class="pd">${d}</div></div>`,
          )
          .join('')}
      </div>
    </div>
    <div class="rail right">
      <div class="rh">Affects</div>
      <div class="rquiet">Nothing depends on this yet.</div>
      <div class="rh sp">Revisions <b>2</b></div>
      <div class="revrow on"><span class="mono">r2</span><div><div>Baseline <em>· user</em></div><small>Attach illustrative geometry</small></div></div>
      <div class="revrow"><span class="mono">r1</span><div><div>Superseded <em>· user</em></div><small>first printable tray for the removable payload</small></div></div>
    </div>
  </div></div>

  <div id="montage" class="layer persp">
    <div class="mcard" id="m0">
      <div class="mh"><span class="mt">${ic('list-checks')} Requirement</span><span class="chips">${state('ok', 'Approved')}${state('warn', 'Change in review')}</span></div>
      <h3>Payload capacity</h3>
      <p class="stmt">${words('The rover shall carry a removable payload pack without loss of mobility.')}</p>
      <div class="qrow">
        <div class="qfield"><label>Target</label><div class="qbox"><span class="qv mono">0.3</span><span class="qu mono">kg</span></div></div>
        <div class="qfield sm"><label>Priority</label><div class="qtxt">must</div></div>
        <div class="qfield grow"><label>Acceptance</label><div class="qtxt">Traverses a 15° ramp at ≥0.5 m/s carrying the payload; no slip or stall.</div></div>
      </div>
    </div>
    <div class="mcard" id="m1">
      <div class="mh"><span class="mt">${ic('calculator')} Calculation</span><span class="chips">${state('warn', 'Experimental')}</span></div>
      <h3>Rover mass budget</h3>
      <div class="calc">
        <div class="res"><label>Result</label><div class="big mono"><span class="cnt">0.000</span><span class="u">kg</span></div><div class="meta">calculated evidence · tool mathjs-restricted</div>
          <div class="expr mono">payload + chassis + electronics + battery</div></div>
        <div class="inputs">
          <label>Inputs <b>4</b></label>
          ${[
            ['payload', '0.3 kg', 'Payload capacity', true],
            ['chassis', '0.12 kg', 'literal', false],
            ['electronics', '0.045 kg', 'literal', false],
            ['battery', '0.04 kg', 'LiPo 2S 450 mAh 30C pack', true],
          ]
            .map(
              ([n, v, s, linked]) =>
                `<div class="irow"><span class="mono n">${n}</span><span class="eq">=</span><span class="mono v">${v}</span><span class="s ${linked ? 'lk' : ''}">${s}</span></div>`,
            )
            .join('')}
        </div>
      </div>
    </div>
    <div class="mcard" id="m2">
      <div class="mh"><span class="mt">${ic('circuitry')} Electronics</span><span class="chips">${state('ok', 'Voltage ranges compatible')}</span></div>
      <h3>Power + signal wiring</h3>
      <svg class="wiring" viewBox="0 0 1160 400" width="1160" height="400">
        <g class="wires">
          ${['M270 200 H355 V78 H450', 'M270 200 H355 V318 H450', 'M690 78 H860', 'M690 306 H860', 'M690 330 H860']
            .map((d) => `<path d="${d}" pathLength="1" />`)
            .join('')}
        </g>
        <g class="boxes">
          ${[
            [30, 145, 240, 110, 'LiPo 2S 450 mAh', [['BAT+', '6.4–8.4 V'], ['BAT−', '']]],
            [450, 28, 240, 100, 'D24V22F5 regulator', [['VIN', '6–36 V'], ['VOUT', '5 V']]],
            [450, 262, 240, 100, 'DRV8835 driver', [['VIN', '2–11 V'], ['OUT1 · OUT2', '']]],
            [860, 28, 270, 100, 'Raspberry Pi Zero 2 W', [['5V', '5 V']]],
            [860, 262, 270, 100, 'Gearmotor HP 100:1 × 2', [['M+ · M−', '6 V']]],
          ]
            .map(
              ([x, y, w, h, t, pins]) =>
                `<g class="bx" transform="translate(${x} ${y})"><rect width="${w}" height="${h}" rx="12"/><text x="18" y="34" class="bt">${t}</text>${pins
                  .map(
                    ([p, v], i) =>
                      `<text x="18" y="${62 + i * 24}" class="bp">${p}</text><text x="${w - 18}" y="${62 + i * 24}" class="bv" text-anchor="end">${v}</text>`,
                  )
                  .join('')}</g>`,
            )
            .join('')}
        </g>
      </svg>
    </div>
    <div class="mcard" id="m3">
      <div class="mh"><span class="mt">${ic('package')} Component</span><span class="chips">${state('ok', 'Selected')}</span></div>
      <h3>Raspberry Pi Zero 2 W</h3>
      <div class="sub mono">RPI-ZERO-2W · Raspberry Pi</div>
      <div class="cgrid">
        <div class="props">
          ${[
            ['mass', '0.011 kg', 'Raspberry Pi product page'],
            ['input_voltage', '5 V', 'Raspberry Pi product page'],
            ['avg_current', null, 'workload-dependent; measure on first run'],
          ]
            .map(
              ([n, v, s]) =>
                `<div class="prow"><span class="mono n">${n}</span>${v ? `<span class="mono v">${v}</span>` : '<span class="unk">Unknown</span>'}<span class="s">${s}</span></div>`,
            )
            .join('')}
        </div>
        <div class="offer">
          <label>Selection reason</label>
          <div class="why">Camera + Wi-Fi + GPIO in 11 g</div>
          <label>Offer</label>
          <div class="oline"><span>Raspberry Pi approved reseller</span><span class="mono">15.00 USD <em>per 1</em></span></div>
        </div>
      </div>
    </div>
  </div>

  <div id="decide" class="layer persp"><div class="dec-frame">
    <div class="dstage">
      <div class="dtop">${ic('git-branch')} Proposal 1 of 1 <span class="nav">${ic('caret-left')}${ic('caret-right')}</span></div>
      <h2>Increase payload capacity to 500 g</h2>
      <div class="dmeta"><span class="flip">${state('warn', 'Needs review', 'a')}${state('ok', 'Approved', 'b')}</span><span>Proposed by user · 1 change</span></div>
      <div class="dsec"><span class="obj">${ic('list-checks')} Payload capacity ${ic('arrow-right')}</span><span class="pill">baseline update</span><span class="mono rr">r1 → r2</span></div>
      <div class="diff"><span class="k">target</span><span class="old mono">0.3 kg<i class="strike"></i></span><span class="arr">${ic('arrow-right')}</span><span class="new mono">0.5 kg</span></div>
      <div class="dnotice"><b>Approved as the new baseline.</b> Four dependents are marked out of date. Approval does not mean validated.</div>
      <div class="dbar">
        <div class="rat"><span class="typed"></span><span class="ph">Why this is right for the design (optional, kept in the record)</span></div>
        <div class="btns"><span class="reject">Reject</span><span class="gap"></span><span class="btn sec">Request changes</span><span class="btn pri" id="approve">Approve changes <kbd>⌘↵</kbd></span></div>
      </div>
    </div>
    <div class="drail">
      <div class="rh">Would affect <b>4</b></div>
      ${[
        ['cube', 'Camera tray'],
        ['calculator', 'Rover mass budget'],
        ['flask', 'Ramp traverse with payload'],
        ['calculator', 'Wheel torque at 15° incline'],
      ]
        .map(
          ([i, t]) =>
            `<div class="arow"><span class="conn"></span>${ic(i)}<div><div class="at">${t}</div><div class="as"><span class="a">may need revisiting</span><span class="b"><i></i>Out of date</span></div></div></div>`,
        )
        .join('')}
      <div class="means"><div class="rh">What approval means</div><p>Approval updates the baseline and marks dependents for revisiting. It does not mean the design is validated or fit to build.</p></div>
    </div>
  </div></div>

  <div id="agent" class="island">
    <div class="ah"><span class="pulse"><i></i></span><b>Agent</b><span class="live">session live</span><span class="path mono">~/sable-inspection-rover</span></div>
    <div class="term mono">
      <div class="p1"><span class="pr">›</span> <span class="tx"></span><span class="caret"></span></div>
      ${TERM_LINES.map(([k, n, v]) => `<div class="out"><span class="k">${k}</span><span class="n">${n}</span><span class="v">${v}</span></div>`).join('')}
      <div class="out last"><span class="k">26 objects wait for your review</span></div>
      <div class="p2"><span class="pr">›</span> <span class="tx"></span><span class="caret"></span></div>
    </div>
  </div>

  <div id="end" class="layer">
    <div class="ring"></div>
    <div class="core"></div>
    <div class="lockup">
      ${MARK}
      <div class="word"><span class="omen">${letters('Omen')}</span><span class="flow">${letters('Flow')}</span></div>
      <div class="tag">${words('See the whole. Focus on one. Decide.')}</div>
    </div>
    <div class="foot mono"><span>Local desktop engineering workspace</span><i></i><span>Bring your own agent CLI</span><i></i><span>0.1</span></div>
  </div>

  <div id="type" class="layer">
    <div class="kt" id="kt-whole" style="left:112px;top:104px"><div class="kl">${words('See the whole.')}</div><div class="kcap mono">Level 0 · the whole project, intent to evidence</div></div>
    <div class="kt" id="kt-focus" style="left:112px;top:380px"><div class="kl">${words('Focus on')}</div><div class="kl">${words('one.')}</div><div class="kcap mono">Level 1 · one object between its inputs and consequences</div></div>
    <div class="kt cap" id="kt-shape"><div class="kl">${words('The interface takes the shape of the work.')}</div></div>
    <div class="kt" id="kt-decide" style="left:1340px;top:410px"><div class="kl">${words('Decide.')}</div><div class="kcap mono">Level 2 · one proposal and its impact</div></div>
    <div class="kt" id="kt-agents" style="left:112px;top:96px"><div class="kl">${words('Agents propose.')}</div><div class="kl dim">${words('People decide.')}</div><div class="kcap mono">Nothing becomes the baseline until a person approves it</div></div>
  </div>

  <div id="cursor"><svg viewBox="0 0 20 28" width="30" height="42"><path d="M1.5 1.5 L1.5 22 L7 17 L10.6 25.4 L14.2 23.9 L10.7 15.8 L17.8 15.8 Z" fill="#fff" stroke="#0b0c0e" stroke-width="1.4" stroke-linejoin="round"/></svg></div>
  <div id="ripple"></div>

  <div id="fx" class="layer">
    <canvas class="grain" width="640" height="360"></canvas>
    <div class="vignette"></div>
    <div class="flash"></div>
    <div class="black"></div>
  </div>

  <svg width="0" height="0" style="position:absolute"><defs>
    ${['obj', 'm0', 'm1', 'm2', 'm3', 'dec']
      .map((id) => `<filter id="mb-${id}" x="-20%" y="-5%" width="140%" height="110%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="0 0"/></filter>`)
      .join('')}
  </defs></svg>`;
}

/* ------------------------------------------------------------------ */
/* Scene state                                                          */
/* ------------------------------------------------------------------ */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
let S; // element cache
let tray;
let stageEl;

function show(el, o) {
  el.style.opacity = o <= 0.001 ? '0' : o >= 0.999 ? '1' : o.toFixed(4);
  el.style.visibility = o <= 0.001 ? 'hidden' : 'visible';
  return o > 0.001;
}

function setup() {
  const nodesEl = $('#nodes');
  const base = $('#links .base');
  const stale = $('#links .stale');
  const streaks = $('#links .streaks');
  const pulses = $('#links .pulses');
  const svgNS = 'http://www.w3.org/2000/svg';

  nodesEl.innerHTML =
    HEADS.map(([x, l, n]) => `<div class="colhead" data-x="${x}" style="left:${x}px;top:14px">${l}<span>${n}</span></div>`).join('') +
    GROUPS.map(([x, y, l, n]) => `<div class="grp" data-x="${x}" style="left:${x}px;top:${y}px">${l}<span>${n}</span></div>`).join('') +
    NODES.map(
      (n) =>
        `<div class="node" data-id="${n.id}" style="left:${n.x}px;top:${n.y}px">${ic(TYPE_ICON[n.type])}<span class="nl">${n.label}</span><i class="mk"></i></div>`,
    ).join('');

  const colRow = {};
  for (const n of NODES) {
    const c = COL_INDEX[n.x];
    colRow[c] = (colRow[c] ?? -1) + 1;
    n.t0 = 2.62 + c * 0.13 + colRow[c] * 0.035;
    n.el = nodesEl.querySelector(`[data-id="${n.id}"]`);
    n.mk = n.el.querySelector('.mk');
    n.seed = rng(n.x * 31 + n.y)();
  }
  const mkPath = (parent, d, cls) => {
    const p = document.createElementNS(svgNS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('pathLength', '1');
    if (cls) p.setAttribute('class', cls);
    parent.appendChild(p);
    return p;
  };
  for (const l of LINKS) {
    const d = linkPath(l);
    l.el = mkPath(base, d);
    l.t0 = Math.max(l.a.t0, l.b.t0) + 0.22;
    l.thread = THREAD_LINKS.has(l.key);
    if (l.key in STALE_LINKS) {
      l.staleEl = mkPath(stale, d);
      l.staleT = STALE_LINKS[l.key];
      l.head = document.createElementNS(svgNS, 'circle');
      l.head.setAttribute('r', '5');
      stale.appendChild(l.head);
    }
    if (l.thread) {
      l.pulses = [0, 1].map(() => {
        const c = document.createElementNS(svgNS, 'circle');
        c.setAttribute('r', '4.5');
        pulses.appendChild(c);
        return c;
      });
    }
    l.len = l.el.getTotalLength();
  }
  for (const n of NODES) {
    n.streak = document.createElementNS(svgNS, 'line');
    streaks.appendChild(n.streak);
  }

  const kt = (id) => {
    const el = $(`#${id}`);
    return { el, spans: $$('.w > span', el), cap: $('.kcap', el) };
  };

  S = {
    bg: $('#bg'),
    dots: $('#bg .dots'),
    halo: $('#bg .halo'),
    cam: $('#flow-cam'),
    world: $('#world'),
    base,
    labels: $$('#nodes .colhead, #nodes .grp').map((el) => ({ el, t0: 2.55 + COL_INDEX[el.dataset.x] * 0.13 })),
    needs: $('#needs'),
    needRows: $$('#needs .nrow'),
    obj: $('#obj'),
    objFrame: $('.obj-frame'),
    objLinks: $$('.obj-frame .rlink'),
    objConns: $$('.obj-frame .conn'),
    objRails: $$('.obj-frame .rail > *'),
    objStageParts: $$('.ostage > *'),
    dims: $('.well .dims span'),
    params: $$('.params [data-v]'),
    wellIslands: $$('.well .island'),
    montage: $('#montage'),
    cards: $$('.mcard'),
    stmtWords: $$('#m0 .stmt .w > span'),
    qv: $('#m0 .qv'),
    cnt: $('#m1 .cnt'),
    irows: $$('#m1 .irow'),
    wires: $$('#m2 .wires path'),
    boxes: $$('#m2 .bx'),
    prows: $$('#m3 .prow'),
    unk: $('#m3 .unk'),
    decide: $('#decide'),
    decFrame: $('.dec-frame'),
    decParts: $$('.dstage > *'),
    strike: $('.diff .strike'),
    oldV: $('.diff .old'),
    newV: $('.diff .new'),
    arr: $('.diff .arr'),
    flipA: $('.flip .a'),
    flipB: $('.flip .b'),
    typed: $('.rat .typed'),
    ph: $('.rat .ph'),
    approve: $('#approve'),
    arows: $$('.arow'),
    notice: $('.dnotice'),
    means: $('.means'),
    agent: $('#agent'),
    p1: $('#agent .p1 .tx'),
    p1c: $('#agent .p1 .caret'),
    p2row: $('#agent .p2'),
    p2: $('#agent .p2 .tx'),
    p2c: $('#agent .p2 .caret'),
    outs: $$('#agent .out'),
    outN: $$('#agent .out .n'),
    pulse: $('#agent .pulse'),
    end: $('#end'),
    ring: $('#end .ring'),
    core: $('#end .core'),
    mark: $('#end .mark'),
    wordL: $$('#end .word .w > span'),
    tagW: $$('#end .tag .w > span'),
    foot: $('#end .foot'),
    lockup: $('#end .lockup'),
    kt: {
      whole: kt('kt-whole'),
      focus: kt('kt-focus'),
      shape: kt('kt-shape'),
      decide: kt('kt-decide'),
      agents: kt('kt-agents'),
    },
    cursor: $('#cursor'),
    ripple: $('#ripple'),
    grain: $('#fx .grain'),
    flash: $('#fx .flash'),
    black: $('#fx .black'),
    filters: Object.fromEntries(
      ['obj', 'm0', 'm1', 'm2', 'm3', 'dec'].map((id) => [id, $(`#mb-${id} feGaussianBlur`)]),
    ),
  };
  S.grainCtx = S.grain.getContext('2d');
  S.grainImg = S.grainCtx.createImageData(640, 360);
}

/* ------------------------------------------------------------------ */
/* Scenes                                                               */
/* ------------------------------------------------------------------ */

const cam = (fx, fy, sx, sy, s, rx = 0, rz = 0, z = 0) => [fx, fy, sx, sy, Math.log(s), rx, rz, z];
const T = NODE.tray;
const PL = NODE.payload;
const CAM_A = [
  [2.45, cam(T.cx, T.cy, 1190, 640, 0.58, 62, -24, -260)],
  [4.0, cam(T.cx, T.cy, 1318, 530, 0.95, 17, -5, 0), E.expoOut],
  [6.05, cam(T.cx, T.cy, 1330, 522, 1.0, 9, -2, 0), E.sine],
  [6.45, cam(T.cx, T.cy, 1330, 522, 1.0, 9, -2, 0)],
  [6.86, cam(T.cx, T.cy, 960, 540, 11, 0, 0, 0), E.expoIn],
];
const CAM_C = [
  [12.45, cam(PL.cx, PL.cy, 960, 540, 3.6, 0, 0, 0)],
  [13.6, cam(PL.cx, PL.cy, 196, 570, 0.86, 12, -3, 0), E.expoOut],
  [14.5, cam(PL.cx, PL.cy, 180, 560, 0.9, 11, -3.6, 0), E.sine],
  [15.45, cam(WC[0], WC[1], 960, 540, 1.1, 0, -16, 0), E.cubicInOut],
];

function camCss(v) {
  const [fx, fy, sx, sy, ls, rx, rz, z] = v;
  return `translate3d(${sx}px,${sy}px,${z}px) rotateX(${rx}deg) rotateZ(${rz}deg) scale(${Math.exp(ls)}) translate(${-fx}px,${-fy}px)`;
}

/** Horizontal whip with directional motion blur proportional to velocity. */
function whip(t, fn, filterId) {
  const x = fn(t);
  const v = (fn(t + 1 / 120) - x) * 120; // px/s
  const blur = Math.min(60, Math.max(0, Math.abs(v) - 900) * 0.0055);
  S.filters[filterId].setAttribute('stdDeviation', `${blur.toFixed(2)} 0`);
  return { x, blur, v };
}

function renderBg(t) {
  S.dots.style.transform = `translate3d(${(-t * 9) % 32}px, ${(-t * 4) % 32}px, 0)`;
  const glow = env(t, 0, 1.2, 17.8, 18.5);
  show(S.bg, glow);
  // A soft neutral key light that follows the focus of each act.
  const hx = track(t, [[0, [960, 520]], [2.6, [960, 520]], [4, [1100, 560]], [7, [1260, 560]], [10.5, [760, 540]], [13, [820, 600]], [15.5, [960, 520]]]);
  S.halo.style.transform = `translate(${hx[0] - 900}px, ${hx[1] - 700}px)`;
}

function renderFlow(t) {
  const a = t < 9;
  const vis = a
    ? ez(t, 2.45, 2.95, E.cubicOut) * (1 - ez(t, 6.68, 6.86, E.lin))
    : ez(t, 12.45, 12.85, E.cubicOut) * (1 - ez(t, 15.3, 15.5, E.lin));
  if (!show(S.cam, vis)) return;
  S.world.style.transform = camCss(track(t, a ? CAM_A : CAM_C));
  S.cam.style.filter = a && t > 6.55 ? `blur(${(ez(t, 6.55, 6.86, E.expoIn) * 8).toFixed(2)}px)` : 'none';

  const lit = a ? ez(t, 5.18, 5.55, E.cubicOut) : 0;
  const staleDim = a ? 0 : ez(t, 12.9, 13.4, E.cubicOut) * (1 - ez(t, 14.45, 14.7));
  const conv = !a && t > 14.5;

  for (const n of NODES) {
    const inThread = THREAD_NODES.has(n.id);
    const ap = a ? ez(t, n.t0, n.t0 + 0.65, E.expoOut) : 1;
    const ring = a ? ez(t, n.t0, n.t0 + 0.2, E.cubicOut) * (1 - ez(t, n.t0 + 0.5, n.t0 + 1.8, E.cubicOut)) : 0;
    const nl = inThread ? lit : 0;
    const st = !a && n.id in STALE_NODES ? ez(t, STALE_NODES[n.id], STALE_NODES[n.id] + 0.35, E.cubicOut) : 0;
    const bump = !a && n.id in STALE_NODES ? Math.sin(Math.PI * prog(t, STALE_NODES[n.id], STALE_NODES[n.id] + 0.4)) : 0;
    let dim = inThread ? 1 : lerp(1, 0.26, lit);
    if (!(n.id in STALE_NODES) && n.id !== 'payload') dim *= lerp(1, 0.5, staleDim);

    let tx = 0;
    let ty = (1 - ap) * 26;
    let sc = lerp(0.94, 1, ap) * (1 + bump * 0.05);
    let o = ap * dim;
    if (conv) {
      const k = E.expoIn(prog(t, 14.55 + n.seed * 0.32, 15.12 + n.seed * 0.32));
      tx = (WC[0] - n.cx) * k;
      ty = (WC[1] - n.cy) * k;
      sc *= lerp(1, 0.08, k);
      o = lerp(o, 1, k) * (1 - ez(t, 15.3, 15.45, E.lin));
      const k0 = Math.max(0, k - 0.3);
      const on = k > 0.01 && k < 0.999;
      n.streak.setAttribute('x1', lerp(n.cx, WC[0], k0));
      n.streak.setAttribute('y1', lerp(n.cy, WC[1], k0));
      n.streak.setAttribute('x2', n.cx + tx);
      n.streak.setAttribute('y2', n.cy + ty);
      n.streak.style.opacity = on ? (0.9 * Math.sin(Math.PI * k)).toFixed(3) : '0';
    } else n.streak.style.opacity = '0';

    n.el.style.transform = `translate3d(${tx}px,${ty}px,0) scale(${sc})`;
    n.el.style.opacity = o.toFixed(3);
    const border = mix(mix(C.line, C.signalLine, Math.max(nl, ring * 0.9)), [241, 187, 104, 0.8], st);
    n.el.style.borderColor = col(border);
    n.el.style.background = col(mix(mix(C.surface, C.signalSoft, nl), C.warnSoft, st));
    n.el.style.boxShadow =
      ring > 0.01 || nl > 0.01
        ? `0 0 ${24 + 20 * ring}px ${rgba(C.signal, (0.16 * Math.max(ring, nl * 0.7)).toFixed(3))}`
        : st > 0.01
          ? `0 0 26px ${rgba(C.warn, (0.14 * st + 0.2 * bump).toFixed(3))}`
          : 'none';
    n.el.style.color = nl > 0.5 ? 'var(--text)' : '';
    // Marks: Payload capacity is in review until approval; the assumption has no baseline.
    const mk = n.id === 'payload' ? (a ? 'warn' : '') : n.id === 'wheel' ? 'ring' : st > 0.4 ? 'warn' : '';
    if (n.mk.className !== `mk ${mk}`) n.mk.className = `mk ${mk}`;
  }

  for (const l of S.labels) {
    const k = a ? ez(t, l.t0, l.t0 + 0.6) : 1 - (conv ? ez(t, 14.5, 14.9, E.cubicOut) : 0);
    l.el.style.opacity = (k * (a ? lerp(1, 0.5, lit) : 1)).toFixed(3);
    l.el.style.transform = `translateY(${a ? (1 - k) * 14 : 0}px)`;
  }
  S.base.style.opacity = conv ? (1 - ez(t, 14.5, 14.85, E.cubicOut)).toFixed(3) : '1';
  const pulseOn = a ? ez(t, 5.3, 5.5) : 0;
  for (const l of LINKS) {
    const dp = a ? ez(t, l.t0, l.t0 + 0.6, E.cubicInOut) : 1;
    l.el.style.strokeDashoffset = (1 - dp).toFixed(4);
    const tl = l.thread ? lit : 0;
    let dim = l.thread ? 1 : lerp(1, 0.22, lit);
    if (!l.staleEl) dim *= lerp(1, 0.45, staleDim);
    l.el.style.stroke = col(mix(C.edge, C.signal, tl));
    l.el.style.strokeWidth = lerp(1.5, 2.4, tl).toFixed(2);
    l.el.style.opacity = dim.toFixed(3);
    if (l.pulses) {
      l.pulses.forEach((c, j) => {
        const ph = ((t - 5.3) * 0.85 + j * 0.5 + l.a.y * 0.001) % 1;
        const p = l.el.getPointAtLength(Math.max(0, ph) * l.len);
        c.setAttribute('cx', p.x.toFixed(2));
        c.setAttribute('cy', p.y.toFixed(2));
        c.style.opacity = (pulseOn * Math.sin(Math.PI * clamp(ph))).toFixed(3);
      });
    }
    if (l.staleEl) {
      const sp = a ? 0 : ez(t, l.staleT, l.staleT + 0.34, E.cubicInOut);
      l.staleEl.style.strokeDashoffset = (1 - sp).toFixed(4);
      l.staleEl.style.opacity = (conv ? 1 - ez(t, 14.5, 14.85) : 1).toFixed(3);
      const hp = l.el.getPointAtLength(sp * l.len);
      l.head.setAttribute('cx', hp.x.toFixed(2));
      l.head.setAttribute('cy', hp.y.toFixed(2));
      l.head.style.opacity = (sp > 0 && sp < 1 ? 1 : 0).toString();
    }
  }
}

function renderNeeds(t) {
  const v = t > 9 ? env(t, 13.25, 13.75, 14.35, 14.6) : 0;
  if (!show(S.needs, v)) return;
  const k = ez(t, 13.25, 13.95);
  S.needs.style.transform = `translate3d(${(1 - k) * 60}px,0,0)`;
  S.needRows.forEach((el, i) => {
    const r = ez(t, 13.35 + i * 0.09, 13.85 + i * 0.09);
    el.style.opacity = r.toFixed(3);
    el.style.transform = `translateY(${(1 - r) * 12}px)`;
  });
}

function renderAgent(t) {
  const vis = t < 9 ? env(t, 0.15, 0.85, 6.3, 6.55) : env(t, 12.6, 13.0, 14.45, 14.7);
  if (!show(S.agent, vis)) return;
  // Centre stage → docked bottom-left as the floating agent window.
  const dock = t < 9 ? ez(t, 2.45, 3.25, E.expoInOut) : 1;
  const intro = t < 9 ? ez(t, 0.15, 1.0, E.expoOut) : ez(t, 12.6, 13.1, E.expoOut);
  const sc = lerp(lerp(0.9, 1, intro), 0.5, dock);
  const x = lerp(430, 44, dock);
  const y = lerp(375 + (1 - intro) * 40, 1080 - 40 - 330 * 0.5 + (t > 9 ? (1 - intro) * 30 : 0), dock);
  S.agent.style.transform = `translate3d(${x}px,${y}px,0) scale(${sc})`;
  S.agent.style.filter = intro < 0.98 ? `blur(${((1 - intro) * 10).toFixed(2)}px)` : 'none';

  const n1 = Math.floor(PROMPT.length * E.sine(prog(t, 0.5, 1.62)));
  S.p1.textContent = PROMPT.slice(0, n1);
  const typing1 = t > 0.35 && t < 1.7;
  S.p1c.style.opacity = typing1 || (t < 0.5 && Math.floor(t * 4) % 2 === 0) ? '1' : '0';
  S.outs.forEach((el, i) => {
    const k = ez(t, 1.72 + i * 0.13, 2.0 + i * 0.13, E.expoOut);
    el.style.opacity = k.toFixed(3);
    el.style.transform = `translateY(${(1 - k) * 10}px)`;
  });
  S.outN.forEach((el, i) => {
    const target = TERM_LINES[i][1];
    el.textContent = Math.round(target * E.cubicOut(prog(t, 1.72 + i * 0.13, 2.15 + i * 0.13)));
  });
  const second = t > 9;
  S.p2row.style.display = second ? '' : 'none';
  S.p1.parentElement.style.opacity = second ? '0.4' : '1';
  S.outs.forEach((el) => second && (el.style.opacity = '0.4'));
  if (second) {
    const n2 = Math.floor(RESUME.length * E.sine(prog(t, 13.15, 14.15)));
    S.p2.textContent = RESUME.slice(0, n2);
    S.p2c.style.opacity = Math.floor(t * 4) % 2 === 0 || (t > 13.1 && t < 14.2) ? '1' : '0';
  }
  const pl = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 1.1);
  S.pulse.style.setProperty('--p', pl.toFixed(3));
}

function renderObj(t) {
  const vis = ez(t, 6.7, 6.98, E.cubicOut) * (1 - ez(t, 8.56, 8.64, E.lin));
  if (!show(S.obj, vis)) return;
  const enter = ez(t, 6.7, 7.45, E.expoOut);
  const { x: wx, blur } = whip(t, (u) => -2300 * ez(u, 8.36, 8.62, E.expoIn), 'obj');
  const ry = lerp(-24, -12, E.sine(prog(t, 6.52, 8.6)));
  const s = lerp(1.9, 0.73, enter) * lerp(1, 1.02, prog(t, 7.3, 8.5));
  S.objFrame.style.transform = `translate3d(${1262 + wx}px, ${548}px, 0) rotateY(${ry}deg) rotateX(${lerp(8, 4, enter)}deg) scale(${s}) translate(-780px,-395px)`;
  S.objFrame.style.filter = blur > 0.3 ? 'url(#mb-obj)' : enter < 0.97 ? `blur(${((1 - enter) * 14).toFixed(2)}px)` : 'none';

  S.objRails.forEach((el, i) => {
    const k = ez(t, 6.95 + i * 0.05, 7.5 + i * 0.05);
    el.style.opacity = k.toFixed(3);
    el.style.transform = `translateX(${(el.closest('.right') ? 1 : -1) * (1 - k) * 24}px)`;
  });
  S.objStageParts.forEach((el, i) => {
    const k = ez(t, 6.8 + i * 0.06, 7.35 + i * 0.06);
    el.style.opacity = k.toFixed(3);
    el.style.transform = `translateY(${(1 - k) * 18}px)`;
  });
  S.objConns.forEach((el, i) => el.style.setProperty('--k', ez(t, 7.2 + i * 0.08, 7.6 + i * 0.08, E.cubicInOut).toFixed(3)));
  S.wellIslands.forEach((el, i) => {
    const k = ez(t, 7.35 + i * 0.08, 7.8 + i * 0.08);
    el.style.opacity = k.toFixed(3);
    el.style.transform = `translateY(${(1 - k) * -10}px)`;
  });

  const build = ez(t, 7.0, 7.8, E.cubicInOut);
  tray.render({
    azimuth: -0.95 + (t - 6.5) * 0.3,
    build,
    scanAlpha: ez(t, 6.95, 7.1) * (1 - ez(t, 7.75, 8.05, E.cubicOut)),
  });

  const dims = '62.00 × 14.50 × 44.00 mm';
  S.dims.textContent = dims.slice(0, Math.floor(dims.length * prog(t, 7.6, 7.95)));
  S.dims.parentElement.style.opacity = t > 7.62 ? '1' : '0';
  S.params.forEach((el, i) => {
    const v = Number(el.dataset.v);
    const k = E.expoOut(prog(t, 7.4 + i * 0.07, 7.95 + i * 0.07));
    el.textContent = (v * k).toFixed(v % 1 ? 1 : 0);
  });
}

function renderMontage(t) {
  if (!show(S.montage, t > 8.36 && t < 10.64 ? 1 : 0)) return;
  S.cards.forEach((card, i) => {
    const t0 = 8.5 + i * 0.5;
    const id = `m${i}`;
    const { x, blur, v } = whip(
      t,
      (u) => 2300 * (1 - ez(u, t0 - 0.1, t0 + 0.17, E.expoOut)) - 2300 * ez(u, t0 + 0.38, t0 + 0.52, E.expoIn),
      id,
    );
    const on = t > t0 - 0.11 && t < t0 + 0.53;
    card.style.visibility = on ? 'visible' : 'hidden';
    if (!on) return;
    const settle = prog(t, t0, t0 + 0.5);
    card.style.transform = `translate3d(${960 + x}px, 540px, 0) rotateY(${clamp(-v * 0.0016, -18, 18)}deg) scale(${lerp(0.86, 0.89, settle)}) translate(-620px,-300px)`;
    card.style.filter = blur > 0.3 ? `url(#mb-${id})` : 'none';
  });
  // Requirement: statement words and the target quantity.
  S.stmtWords.forEach((el, i) => {
    const k = ez(t, 8.46 + i * 0.018, 8.8 + i * 0.018);
    el.style.transform = `translateY(${(1 - k) * 105}%)`;
  });
  S.qv.textContent = (0.3 * E.expoOut(prog(t, 8.55, 8.85))).toFixed(1);
  // Calculation: the result resolves from its inputs.
  S.cnt.textContent = (0.505 * E.expoOut(prog(t, 9.02, 9.4))).toFixed(3);
  S.irows.forEach((el, i) => {
    const k = ez(t, 8.95 + i * 0.05, 9.25 + i * 0.05);
    el.style.opacity = k.toFixed(3);
    el.style.transform = `translateX(${(1 - k) * 30}px)`;
  });
  // Electronics: the diagram draws itself.
  S.boxes.forEach((el, i) => {
    const k = ez(t, 9.45 + i * 0.03, 9.75 + i * 0.03);
    el.style.opacity = k.toFixed(3);
  });
  S.wires.forEach((el, i) => (el.style.strokeDashoffset = (1 - ez(t, 9.5 + i * 0.03, 9.85 + i * 0.03, E.cubicInOut)).toFixed(4)));
  // Component: known properties, and the unknown stays labelled.
  S.prows.forEach((el, i) => {
    const k = ez(t, 9.95 + i * 0.06, 10.25 + i * 0.06);
    el.style.opacity = k.toFixed(3);
    el.style.transform = `translateY(${(1 - k) * 14}px)`;
  });
}

function renderDecide(t) {
  const vis = t > 10.34 && t < 12.8 ? 1 - ez(t, 12.45, 12.78, E.cubicOut) : 0;
  if (!show(S.decide, vis)) return;
  const { x, blur, v } = whip(t, (u) => 2300 * (1 - ez(u, 10.4, 10.7, E.expoOut)), 'dec');
  const out = ez(t, 12.4, 12.78, E.expoIn);
  const ry = lerp(20, 12, E.sine(prog(t, 10.5, 12.4))) + clamp(-v * 0.0016, -18, 18);
  S.decFrame.style.transform = `translate3d(${720 + x}px, 548px, 0) rotateY(${ry}deg) rotateX(3deg) scale(${0.8 * lerp(1, 0.55, out)}) translate(-640px,-350px)`;
  S.decFrame.style.filter = blur > 0.3 ? 'url(#mb-dec)' : out > 0.01 ? `blur(${(out * 12).toFixed(2)}px)` : 'none';

  S.decParts.forEach((el, i) => {
    const k = ez(t, 10.55 + i * 0.05, 11.05 + i * 0.05);
    el.style.opacity = k.toFixed(3);
    el.style.transform = `translateY(${(1 - k) * 16}px)`;
  });
  S.strike.style.transform = `scaleX(${ez(t, 10.95, 11.2, E.cubicInOut)})`;
  S.oldV.style.opacity = lerp(1, 0.55, ez(t, 10.95, 11.2)).toFixed(3);
  const nk = ez(t, 11.08, 11.38);
  S.newV.style.opacity = nk.toFixed(3);
  S.newV.style.transform = `translateX(${(1 - nk) * -14}px)`;
  S.arr.style.opacity = ez(t, 11.0, 11.2).toFixed(3);

  const nt = Math.floor(RATIONALE.length * prog(t, 11.12, 11.62));
  S.typed.textContent = RATIONALE.slice(0, nt);
  S.ph.style.display = nt > 0 ? 'none' : '';

  const press = Math.sin(Math.PI * prog(t, 11.82, 11.96));
  const done = ez(t, 11.92, 12.1);
  S.approve.style.transform = `scale(${1 - press * 0.05})`;
  S.approve.style.boxShadow = `0 0 0 ${(done * 10).toFixed(1)}px ${rgba([241, 241, 242], (0.25 * (1 - done)).toFixed(3))}`;
  S.flipA.style.opacity = (1 - done).toFixed(3);
  S.flipA.style.transform = `translateY(${-done * 12}px)`;
  S.flipB.style.opacity = done.toFixed(3);
  S.flipB.style.transform = `translateY(${(1 - done) * 12}px)`;
  const nk2 = ez(t, 12.02, 12.32);
  S.notice.style.opacity = nk2.toFixed(3);
  S.notice.style.transform = `translateY(${(1 - nk2) * 10}px)`;

  S.arows.forEach((el, i) => {
    const k = ez(t, 10.7 + i * 0.06, 11.2 + i * 0.06);
    el.style.opacity = k.toFixed(3);
    el.style.transform = `translateX(${(1 - k) * 22}px)`;
    const s = ez(t, 12.0 + i * 0.07, 12.2 + i * 0.07, E.cubicOut);
    el.style.setProperty('--s', s.toFixed(3));
  });
  S.means.style.opacity = ez(t, 11.0, 11.5).toFixed(3);
}

function renderEnd(t) {
  const vis = t > 15.2 ? 1 : 0;
  if (!show(S.end, vis)) return;
  // Converging energy → one point → flash.
  const core = ez(t, 15.05, 15.5, E.expoIn) * (1 - ez(t, 15.5, 15.9, E.expoOut));
  S.core.style.transform = `translate(-50%,-50%) scale(${lerp(0.2, 1.6, core)})`;
  S.core.style.opacity = core.toFixed(3);
  const rk = prog(t, 15.5, 16.6);
  S.ring.style.transform = `translate(-50%,-50%) scale(${lerp(0.05, 2.2, E.expoOut(rk))})`;
  S.ring.style.opacity = (rk > 0 ? (1 - E.cubicOut(rk)) * 0.8 : 0).toFixed(3);

  const push = lerp(1, 1.035, E.sine(prog(t, 15.5, 18.5)));
  S.lockup.style.transform = `translate(-50%,-50%) scale(${push})`;
  // The mark is never animated: it simply appears under the flash.
  S.mark.style.opacity = t >= 15.5 ? '1' : '0';
  S.wordL.forEach((el, i) => {
    const k = ez(t, 15.62 + i * 0.045, 16.4 + i * 0.045);
    el.style.transform = `translateY(${(1 - k) * 110}%)`;
  });
  S.tagW.forEach((el, i) => {
    const k = ez(t, 16.2 + i * 0.07, 16.9 + i * 0.07);
    el.style.transform = `translateY(${(1 - k) * 110}%)`;
  });
  const fk = ez(t, 16.85, 17.4);
  S.foot.style.opacity = fk.toFixed(3);
  S.foot.style.transform = `translate(-50%, ${(1 - fk) * 12}px)`;
}

function renderType(t) {
  const block = (b, tin, tout, st = 0.07) => {
    const on = t > tin - 0.01 && t < tout + 0.8;
    b.el.style.visibility = on ? 'visible' : 'hidden';
    if (!on) return;
    b.spans.forEach((el, i) => {
      const kin = ez(t, tin + i * st, tin + i * st + 0.8, E.expoOut);
      const kout = ez(t, tout + i * 0.03, tout + i * 0.03 + 0.38, E.expoIn);
      el.style.transform = `translateY(${((1 - kin) * 112 - kout * 112).toFixed(2)}%) rotate(${((1 - kin) * 5).toFixed(2)}deg)`;
    });
    if (b.cap) {
      const k = ez(t, tin + 0.4, tin + 1.0) * (1 - ez(t, tout, tout + 0.25, E.cubicOut));
      b.cap.style.opacity = k.toFixed(3);
      b.cap.style.transform = `translateY(${(1 - k) * 10}px)`;
    }
  };
  block(S.kt.whole, 4.3, 5.95);
  block(S.kt.focus, 6.95, 8.02);
  block(S.kt.shape, 8.62, 10.3, 0.035);
  block(S.kt.decide, 10.7, 12.12);
  block(S.kt.agents, 12.85, 14.2, 0.1);
}

function stagePoint(el, ox = 0.5, oy = 0.5) {
  const s = stageEl.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const k = s.width / W;
  return [(r.left + r.width * ox - s.left) / k, (r.top + r.height * oy - s.top) / k];
}

function renderCursor(t) {
  let p = null;
  let o = 0;
  let press = 0;
  let click = null;
  const arc = (a, b, k, lift = 60) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k) - Math.sin(Math.PI * k) * lift];
  if (t > 4.45 && t < 6.7) {
    const pay = stagePoint(PL.el, 0.42, 0.62);
    const tr = stagePoint(T.el, 0.38, 0.62);
    const start = [1560, 990];
    if (t < 5.95) p = arc(start, pay, ez(t, 4.55, 5.15, E.expoInOut), 80);
    else p = arc(pay, tr, ez(t, 5.95, 6.36, E.expoInOut), 70);
    o = ez(t, 4.45, 4.7) * (1 - ez(t, 6.52, 6.66, E.lin));
    press = Math.sin(Math.PI * prog(t, 6.36, 6.5));
    click = [6.44, tr];
  } else if (t > 11.2 && t < 12.45) {
    const ap = stagePoint(S.approve, 0.42, 0.6);
    p = arc([1690, 1010], ap, ez(t, 11.3, 11.8, E.expoInOut), 50);
    o = ez(t, 11.2, 11.4) * (1 - ez(t, 12.25, 12.42, E.lin));
    press = Math.sin(Math.PI * prog(t, 11.82, 11.96));
    click = [11.9, ap];
  }
  if (!show(S.cursor, o) || !p) {
    show(S.ripple, 0);
    return;
  }
  S.cursor.style.transform = `translate3d(${p[0] - 3}px,${p[1] - 3}px,0) scale(${1 - press * 0.16})`;
  const rk = prog(t, click[0], click[0] + 0.5);
  if (show(S.ripple, rk > 0 && rk < 1 ? (1 - rk) * 0.7 : 0)) {
    S.ripple.style.transform = `translate3d(${click[1][0]}px,${click[1][1]}px,0) translate(-50%,-50%) scale(${lerp(0.2, 1.4, E.expoOut(rk))})`;
  }
}

function renderFx(t) {
  // Film grain, re-seeded per frame.
  const r = rng(Math.round(t * 120) + 7);
  const d = S.grainImg.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = (r() * 255) | 0;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  S.grainCtx.putImageData(S.grainImg, 0, 0);
  const flash = t >= 15.5 ? 1 - ez(t, 15.5, 16.3, E.expoOut) : ez(t, 15.38, 15.5, E.expoIn) * 0.6;
  show(S.flash, flash);
  const black = Math.max(1 - ez(t, 0, 0.35, E.cubicOut), ez(t, 17.95, 18.5, E.cubicInOut));
  show(S.black, black);
}

export function render(t) {
  t = clamp(t, 0, DURATION);
  renderBg(t);
  renderFlow(t);
  renderObj(t);
  renderMontage(t);
  renderDecide(t);
  renderNeeds(t);
  renderAgent(t);
  renderEnd(t);
  renderType(t);
  renderCursor(t);
  renderFx(t);
}

/* ------------------------------------------------------------------ */
/* Boot                                                                 */
/* ------------------------------------------------------------------ */

async function boot() {
  stageEl = $('#stage');
  await loadIcons();
  buildStage(stageEl);
  setup();
  tray = createTray($('#tray'));
  await document.fonts.ready;
  await Promise.all(
    ['400 16px Geist', '500 16px Geist', '600 16px Geist', '400 16px "IBM Plex Mono"', '500 16px "IBM Plex Mono"'].map((f) =>
      document.fonts.load(f),
    ),
  );
  render(0);
}

const params = new URLSearchParams(location.search);
const renderMode = params.has('render');
document.body.classList.toggle('render', renderMode);

window.__trailer = boot().then(() => {
  window.__render = render;
  window.__duration = DURATION;
  if (renderMode) return;
  // Interactive preview: play, scrub, and loop with the rendered soundtrack.
  const fit = () => {
    const k = Math.min(innerWidth / W, (innerHeight - 56) / H);
    stageEl.style.transform = `scale(${k})`;
  };
  addEventListener('resize', fit);
  fit();
  const audio = new Audio('../out/trailer-audio.wav');
  const scrub = $('#scrub');
  const label = $('#time');
  let playing = true;
  let t0 = performance.now();
  let tNow = Number(params.get('t') ?? 0);
  const start = () => {
    t0 = performance.now() - tNow * 1000;
    audio.currentTime = tNow;
    audio.play().catch(() => {});
  };
  start();
  const frame = () => {
    if (playing) {
      tNow = (performance.now() - t0) / 1000;
      if (tNow > DURATION) {
        tNow = 0;
        start();
      }
    }
    render(tNow);
    scrub.value = String(tNow);
    label.textContent = tNow.toFixed(2);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  const toggle = () => {
    playing = !playing;
    if (playing) start();
    else audio.pause();
  };
  scrub.max = String(DURATION);
  scrub.addEventListener('input', () => {
    tNow = Number(scrub.value);
    playing = false;
    audio.pause();
  });
  $('#play').addEventListener('click', toggle);
  addEventListener('keydown', (e) => {
    if (e.code === 'Space') toggle();
    if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
      playing = false;
      audio.pause();
      tNow = clamp(tNow + (e.code === 'ArrowRight' ? 1 : -1) / (e.shiftKey ? 2 : 60), 0, DURATION);
    }
  });
});
