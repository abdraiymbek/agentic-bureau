// Omen Flow use-case showcase: one sentence becomes a whole survey quadcopter
// project. The window is drawn with the renderer's own stylesheets and class
// names; every property is a pure function of time, so the scrubbable preview
// and the frame-by-frame render are identical.
import { createMount, MOUNT } from './mount.js';
import { DURATION, PROMPT, CUE, TYPE_TIMES, CALLS, NODE_TIMES } from './cues.js';

const W = 1920;
const H = 1080;
const WIN_W = 1920;
const WIN_H = 1200;

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
  quintInOut: (x) => (x < 0.5 ? 16 * x ** 5 : 1 - (-2 * x + 2) ** 5 / 2),
  expoOut: (x) => (x >= 1 ? 1 : 1 - 2 ** (-10 * x)),
  expoInOut: (x) =>
    x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? 2 ** (20 * x - 10) / 2 : (2 - 2 ** (-20 * x + 10)) / 2,
  backOut: (x) => 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2,
  cubicIn: (x) => x ** 3,
};
const ez = (t, a, b, fn = E.expoOut) => fn(prog(t, a, b));
/** Visible between an eased entrance [a,b] and an eased exit [c,d]. */
const env = (t, a, b, c, d, fi = E.expoOut, fo = E.cubicInOut) => ez(t, a, b, fi) * (1 - ez(t, c, d, fo));

/** Keyframed vectors: [time, [values], easing into this key]. */
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

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const show = (el, on) => {
  const v = on ? '' : 'none';
  if (el.style.display !== v) el.style.display = v;
};
const setText = (el, s) => {
  if (el.textContent !== s) el.textContent = s;
};
const setAttr = (el, name, v) => {
  if (v == null || v === false) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== String(v)) el.setAttribute(name, v);
};
const toggle = (el, cls, on) => {
  if (el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on);
};

/* ------------------------------------------------------------------ */
/* Assets                                                               */
/* ------------------------------------------------------------------ */

const ICON_LIST = [
  'robot', 'graph', 'package', 'clock-counter-clockwise', 'files', 'target', 'git-branch', 'app-window',
  'gear-six', 'caret-down', 'caret-right', 'arrow-left', 'magnifying-glass', 'plus', 'arrow-right',
  'list-checks', 'question', 'link', 'cube', 'circuitry', 'wrench', 'calculator', 'flask',
  'tree-structure', 'shield-check', 'book-open', 'sidebar-simple', 'picture-in-picture', 'arrows-out',
  'minus', 'check-circle', 'sliders-horizontal', 'frame-corners', 'keyboard', 'corners-out', 'check',
  'circle-dashed', 'arrow-up:bold', 'dots-three:bold', 'square:fill',
];
const ICONS = {};
async function loadIcons() {
  await Promise.all(
    ICON_LIST.map(async (key) => {
      const [name, weight = 'regular'] = key.split(':');
      const file = weight === 'regular' ? name : `${name}-${weight}`;
      const res = await fetch(`../node_modules/@phosphor-icons/core/assets/${weight}/${file}.svg`);
      ICONS[key] = (await res.text()).replace(/<svg[^>]*>/, '').replace('</svg>', '');
    }),
  );
}
const ic = (name, size = 16, cls = '') =>
  `<svg${cls ? ` class="${cls}"` : ''} width="${size}" height="${size}" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">${ICONS[name]}</svg>`;

const MARK_PATHS = `<path d="M241.5 84 L227.2 253 Q225.8 267.5 213.5 276 L70.5 375 Z"/><path d="M258.5 84 L272.8 253 Q274.2 267.5 286.5 276 L429.5 375 Z"/><path d="M80 393 L238 325 Q250 318.5 262 325 L420 393 Z"/>`;
const mark = (size, cls = '') =>
  `<svg${cls ? ` class="${cls}"` : ''} width="${size}" height="${size}" viewBox="60 48 380 380" fill="currentColor" stroke="currentColor" stroke-width="5" stroke-linejoin="round" aria-hidden="true">${MARK_PATHS}</svg>`;

const CURSOR = `<svg viewBox="0 0 26 34" width="26" height="34" aria-hidden="true"><path d="M3 2 L3 26.5 L9.1 20.9 L13.2 30.2 L17.4 28.4 L13.4 19.3 L21.6 19.3 Z" fill="#111" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>`;

/* ------------------------------------------------------------------ */
/* The project the agent builds                                         */
/* ------------------------------------------------------------------ */

const TYPE_ICON = {
  requirement: 'list-checks', assumption: 'question', source: 'link', component: 'package',
  architecture: 'tree-structure', mechanical: 'cube', wiring: 'circuitry', assembly: 'wrench',
  calculation: 'calculator', test: 'flask',
};
const COLS = [
  { x: 0, w: 196 },
  { x: 258, w: 226 },
  { x: 528, w: 238 },
  { x: 824, w: 200 },
  { x: 1084, w: 232 },
];
const NODES = [
  ['req_payload', 'requirement', 'Payload capacity', 0, 26],
  ['req_flight', 'requirement', 'Flight time', 0, 78],
  ['req_fold', 'requirement', 'Folded length', 0, 130],
  ['asm_hover', 'assumption', 'Hover power per kg', 0, 216],
  ['s0', 'source', 'Holybro Pixhawk 6C (product page)', 1, 26, true],
  ['s1', 'source', 'Holybro M10 GPS (product page)', 1, 92, true],
  ['s2', 'source', 'T-Motor MN3508 KV700 (product page)', 1, 158, true],
  ['s3', 'source', 'Tekko32 F4 4in1 50A ESC (listing)', 1, 224, true],
  ['s4', 'source', 'LiPo 4S 6000 mAh pack (supplier listing)', 1, 290, true],
  ['s5', 'source', 'Holybro SiK Radio V3 (product page)', 1, 356, true],
  ['c0', 'component', 'Pixhawk 6C flight controller', 2, 33],
  ['c1', 'component', 'M10 GPS module', 2, 99],
  ['c2', 'component', 'MN3508 KV700 motor', 2, 165],
  ['c3', 'component', 'Tekko32 F4 4in1 50A ESC', 2, 231],
  ['c4', 'component', 'LiPo 4S 6000 mAh pack', 2, 297],
  ['c5', 'component', 'SiK telemetry radio V3', 2, 363],
  ['arch', 'architecture', 'System architecture', 3, 26],
  ['hinge', 'mechanical', 'Folding arm hinge', 3, 112],
  ['mount', 'mechanical', 'Sensor head mount', 3, 164],
  ['wiring', 'wiring', 'Power + signal wiring', 3, 250],
  ['assembly', 'assembly', 'Airframe assembly', 3, 336],
  ['mass', 'calculation', 'Takeoff mass budget', 4, 26],
  ['twr', 'calculation', 'Thrust-to-weight at takeoff', 4, 78],
  ['endurance', 'calculation', 'Hover endurance', 4, 130],
  ['hovertest', 'test', 'Hover test with payload', 4, 216],
].map(([id, type, title, col, y, tall = false]) => {
  const c = COLS[col];
  const h = tall ? 54 : 40;
  return { id, type, title, col, x: c.x, y, w: c.w, h, tall, cy: y + h / 2, t0: NODE_TIMES[id] };
});
const NODE = Object.fromEntries(NODES.map((n) => [n.id, n]));

const GROUPS = [
  [0, 0, 'Requirements', ['req_payload', 'req_flight', 'req_fold']],
  [0, 190, 'Assumptions', ['asm_hover']],
  [1, 0, 'Sources', ['s0', 's1', 's2', 's3', 's4', 's5']],
  [2, 7, 'Components', ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']],
  [3, 0, 'Architecture', ['arch']],
  [3, 86, 'Mechanical', ['hinge', 'mount']],
  [3, 224, 'Electronics', ['wiring']],
  [3, 310, 'Assembly', ['assembly']],
  [4, 0, 'Calculations', ['mass', 'twr', 'endurance']],
  [4, 190, 'Tests', ['hovertest']],
].map(([col, y, label, ids]) => ({ col, x: COLS[col].x, y, label, ids }));
const HEADS = [
  [0, 'Intent', [0]],
  [1, 'Parts', [1, 2]],
  [3, 'Design', [3]],
  [4, 'Evidence', [4]],
].map(([col, label, cols]) => ({ x: COLS[col].x, label, ids: NODES.filter((n) => cols.includes(n.col)).map((n) => n.id) }));

const LINK_PAIRS = [
  ['s0', 'c0'], ['s1', 'c1'], ['s2', 'c2'], ['s3', 'c3'], ['s4', 'c4'], ['s5', 'c5'],
  ['c0', 'arch'], ['c3', 'arch'],
  ['req_fold', 'hinge'], ['c2', 'hinge'],
  ['req_payload', 'mount'],
  ['c0', 'wiring'], ['c1', 'wiring'], ['c3', 'wiring'], ['c4', 'wiring'], ['c5', 'wiring'], ['arch', 'wiring'],
  ['mount', 'assembly'], ['hinge', 'assembly'],
  ['req_payload', 'mass'], ['c2', 'mass'], ['c4', 'mass'],
  ['mass', 'twr'], ['c2', 'twr'],
  ['req_flight', 'endurance'], ['asm_hover', 'endurance'], ['c4', 'endurance'], ['mass', 'endurance'],
  ['req_payload', 'hovertest'], ['twr', 'hovertest'], ['endurance', 'hovertest'],
];

/** Free horizontal lanes through a column, between its nodes and group labels. */
function lanes(col) {
  const busy = [
    ...NODES.filter((n) => n.col === col).map((n) => [n.y - 3, n.y + n.h + 3]),
    ...GROUPS.filter((g) => g.col === col).map((g) => [g.y - 2, g.y + 24]),
  ].sort((a, b) => a[0] - b[0]);
  const free = [];
  let y = -30;
  for (const [a, b] of busy) {
    if (a - y >= 8) free.push((a + y) / 2);
    y = Math.max(y, b);
  }
  free.push(y + 14);
  return free;
}
const LANES = COLS.map((_, i) => lanes(i));

function linkPath(a, b) {
  const chevron = (x, y, dir) => `M${x - 6 * dir},${y - 4}L${x},${y}L${x - 6 * dir},${y + 4}`;
  if (a.col === b.col) {
    const x = a.x + a.w;
    const bend = x + 20;
    return { d: `M${x},${a.cy}C${bend},${a.cy} ${bend},${b.cy} ${x + 1.5},${b.cy}`, head: chevron(x + 1.5, b.cy, -1) };
  }
  let x = a.x + a.w;
  let y = a.cy;
  let d = `M${x},${y}`;
  for (let c = a.col + 1; c < b.col; c++) {
    const target = y * 0.5 + b.cy * 0.5;
    const lane = LANES[c].reduce((best, v) => (Math.abs(v - target) < Math.abs(best - target) ? v : best));
    const x2 = COLS[c].x;
    const dx = (x2 - x) * 0.6;
    d += `C${x + dx},${y} ${x2 - dx},${lane} ${x2},${lane}L${COLS[c].x + COLS[c].w},${lane}`;
    x = COLS[c].x + COLS[c].w;
    y = lane;
  }
  const x2 = b.x - 1.5;
  const dx = Math.max(18, (x2 - x) * 0.6);
  d += `C${x + dx},${y} ${x2 - dx},${b.cy} ${x2},${b.cy}`;
  return { d, head: chevron(x2, b.cy, 1) };
}

const LINKS = LINK_PAIRS.map(([a, b]) => {
  const A = NODE[a];
  const B = NODE[b];
  const span = Math.abs(B.col - A.col) || 1;
  const t0 = Math.max(A.t0, B.t0) - 0.08;
  return { a: A, b: B, key: `${a}>${b}`, t0, dur: 0.3 + 0.14 * span, ...linkPath(A, B) };
});

// Hovering Payload capacity lights everything downstream of it.
const THREAD = new Set(['req_payload']);
const THREAD_LINKS = new Set();
for (let grew = true; grew; ) {
  grew = false;
  for (const l of LINKS)
    if (THREAD.has(l.a.id) && !THREAD_LINKS.has(l.key)) {
      THREAD_LINKS.add(l.key);
      THREAD.add(l.b.id);
      grew = true;
    }
}

/* ------------------------------------------------------------------ */
/* The conversation                                                     */
/* ------------------------------------------------------------------ */

const PARAS = [
  [5.7, 7.25, 'Starting from the brief. I’ll record what it must do, source the parts, draft the design, then check it with calculations.'],
  [8.3, 9.2, 'Recorded three requirements and the assumption the endurance estimate rests on.'],
  [12.3, 13.1, 'Captured six parts, each from its maker’s page.'],
  [16.5, 17.5, 'Drafted the sensor head mount and the arm hinge in OpenSCAD and rendered both.'],
  [22.4, 23.4, 'Hover endurance comes to 22.4 min against the 20 min target. It stays an estimate until the hover test records a result.'],
  [26.9, 27.6, 'Ready for review: 25 objects and 31 links. Nothing becomes the baseline until you approve.'],
];
const CARD_TIMES = { req: 9.25, mount: 17.6, calc: 23.3, review: CUE.proposal };
const RUN_END = 27.7;
const SENT = CUE.clickSend + 0.06;

const state = (tone, label, id = '') =>
  `<span class="state tone-${tone}"${id ? ` id="${id}"` : ''}><span class="state-dot" aria-hidden="true"></span><span class="sc-state-label">${label}</span></span>`;
const field = (label, value, unit) =>
  `<label class="inline-field"><span>${label}</span><span class="inline-field-input"><input value="${value}" readonly tabindex="-1" /><span>${unit}</span></span></label>`;
const quantity = (label, value, unit) =>
  `<div class="inline-quantity"><label class="inline-field"><span>${label}</span><span class="inline-field-input"><input value="${value}" readonly tabindex="-1" /><input class="inline-unit" value="${unit}" readonly tabindex="-1" /></span></label><label class="checkbox"><input type="checkbox" tabindex="-1" /><span class="checkbox-copy">Unknown</span></label></div>`;
const rows = (pairs) =>
  `<dl class="inline-value-list">${pairs.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
const cardHead = (icon, eyebrow, title, chip, action) =>
  `<header class="inline-card-head"><span class="inline-card-icon">${ic(icon, 19)}</span><div><span class="chat-eyebrow">${eyebrow}</span><h2>${title}</h2></div>${chip}<button type="button" class="btn btn-ghost btn-sm">${action}</button></header>`;

function requirementCard() {
  return `<section class="inline-card inline-artifact">
    ${cardHead(TYPE_ICON.requirement, 'Recorded object', 'Payload capacity', state('neutral', 'Draft'), 'Open object')}
    <div class="inline-record-body">
      <p>The quadcopter shall carry the survey sensor head for the whole flight.</p>
      <div class="inline-editor"><fieldset class="inline-quantities">${quantity('Target', '0.3', 'kg')}</fieldset></div>
      ${rows([['Priority', 'must'], ['Verification', 'Hover test with payload']])}
    </div>
  </section>`;
}

function mountCard() {
  const P = MOUNT;
  return `<section class="inline-card inline-artifact">
    ${cardHead(TYPE_ICON.mechanical, 'Part workspace', 'Sensor head mount', state('neutral', 'Draft'), 'Open object')}
    <div class="inline-mesh-deferred" id="meshDeferred">
      <span class="inline-caption">The 3D view waits until you show it here.</span>
      <button type="button" class="btn btn-secondary btn-sm" id="show3d">Show 3D</button>
      <button type="button" class="btn btn-ghost btn-sm">Open on the Agent tab</button>
    </div>
    <div class="inline-mesh" id="meshBox" style="display:none">
      <div class="inline-mesh-canvas sc-mesh"><canvas id="mountCanvas" width="904" height="520"></canvas></div>
      <div class="inline-mesh-tools">
        <button type="button" class="btn btn-ghost btn-sm">${ic('arrows-out', 14)}Fit</button>
        <button type="button" class="btn btn-ghost btn-sm">${ic('corners-out', 14)}Larger view</button>
      </div>
      <div class="inline-mesh-caption"><span>Engine render · exact revision</span><span class="num">Mesh envelope ${P.plateW} × ${P.plateD} × ${P.plateT + P.yokeH} mm</span></div>
    </div>
    <div class="inline-editor">
      <div class="inline-section-head"><strong>Dimensions & parameters</strong><span>Source values · units preserved</span></div>
      <fieldset class="inline-fields">
        ${field('plate w', P.plateW, 'mm')}${field('plate d', P.plateD, 'mm')}
        ${field('yoke h', P.yokeH, 'mm')}${field('pivot d', P.pivotD, 'mm')}
      </fieldset>
    </div>
  </section>`;
}

function calcCard() {
  return `<section class="inline-card inline-artifact">
    ${cardHead(TYPE_ICON.calculation, 'Recorded object', 'Hover endurance', state('neutral', 'Draft'), 'Open object')}
    <div class="inline-record-body">
      <div class="inline-editor"><fieldset class="inline-quantities">${quantity('Value', '22.4', 'min')}</fieldset></div>
      ${rows([
        ['Expression', '<span class="mono">usable_energy / hover_power</span>'],
        ['usable_energy', '<span class="mono">71.0 Wh</span> · LiPo 4S 6000 mAh pack, 80 % usable'],
        ['hover_power', '<span class="mono">190 W</span> · Takeoff mass budget × Hover power per kg'],
        ['Assumptions', 'Sea level, still air'],
      ])}
    </div>
  </section>`;
}

function reviewCard() {
  const change = (title, kind) =>
    `<div class="inline-review-change"><h3>${title}</h3><div class="inline-review-identity">r— ${ic('arrow-right', 12)} r1 <span>${kind}</span></div></div>`;
  return `<section class="inline-card inline-review" id="reviewCard">
    <header class="inline-card-head"><span class="inline-card-icon">${ic('shield-check', 19)}</span><div><span class="chat-eyebrow">Human review</span><h2>Review 25 changes</h2></div>${state('warn', 'Needs you', 'reviewState')}<button type="button" class="btn btn-ghost btn-sm">Open in Decisions</button></header>
    <details class="inline-provenance"><summary>Why this change was proposed</summary></details>
    <details class="inline-provenance"><summary>What this decision changes</summary></details>
    ${change('Payload capacity', 'Checks: not applicable')}
    ${change('Sensor head mount', 'Checks: passed')}
    <div class="sc-grow" id="reviewEditorWrap"><div class="inline-editor" id="reviewEditor">
      <label class="checkbox"><input type="checkbox" id="reviewCheck" tabindex="-1" /><span class="checkbox-copy">I reviewed these exact changes and their evidence</span></label>
      <label class="inline-reason">Review note<textarea placeholder="Optional for approval; required when requesting changes" tabindex="-1"></textarea></label>
      <div class="inline-card-actions">
        <button type="button" class="btn btn-ghost btn-sm" id="approveBtn"><span class="btn-spinner" aria-hidden="true" id="approveSpin" style="display:none"><span class="spinner" style="width:10px;height:10px"></span></span><span id="approveLabel">Approve baseline</span></button>
        <button type="button" class="btn btn-secondary btn-sm" disabled>Request changes</button>
      </div>
    </div></div>
  </section>`;
}

function turnHtml(prefix) {
  return `<li class="chat-turn">
    <article class="chat-user-message" aria-label="Your message"><div>${PROMPT}</div></article>
    <article class="chat-assistant-message" aria-label="Agent response">
      <header><span class="chat-assistant-mark">${mark(18)}</span><strong>Omen Flow</strong><span>Claude Code</span><time>just now</time></header>
      <div class="prose" id="${prefix}Prose">${PARAS.map((_, i) => `<p id="${prefix}P${i}"></p>`).join('')}</div>
      ${
        prefix === 'dock'
          ? `<div class="inline-cards">${[
              ['req', requirementCard()],
              ['mount', mountCard()],
              ['calc', calcCard()],
              ['review', reviewCard()],
            ]
              .map(([k, html]) => `<div class="sc-grow" id="card_${k}"><div>${html}</div></div>`)
              .join('')}</div>`
          : ''
      }
      <p class="chat-run-status" role="status" id="${prefix}Run"><span class="spinner" style="width:12px;height:12px"></span><span id="${prefix}RunLabel">Agent is working</span></p>
    </article>
  </li>`;
}

function composerHtml(prefix) {
  return `<div class="chat-composer-dock"><div class="chat-column">
    <form class="chat-composer" id="${prefix}Composer" onsubmit="return false">
      <div class="sc-ta" id="${prefix}Ta"><span class="sc-ph" id="${prefix}Ph">Describe what you want to make…</span><span id="${prefix}Text"></span><i class="sc-caret" id="${prefix}Caret"></i></div>
      <div class="chat-composer-tools">
        <button type="button" class="icon-btn icon-btn-md" aria-label="Add project context">${ic('plus', 16)}</button>
        <button type="button" class="chat-agent-picker">Claude Code${ic('caret-down', 12)}</button>
        <span class="grow"></span>
        <button type="button" class="icon-btn icon-btn-md chat-send" id="${prefix}Send" disabled>${ic('arrow-up:bold', 18)}</button>
        <button type="button" class="btn btn-secondary btn-sm chat-stop" id="${prefix}Stop" style="display:none">${ic('square:fill', 13)}Stop response</button>
      </div>
    </form>
    <p class="chat-composer-note">Agents draft. You decide. <span>Enter to send · Shift Enter for a new line</span></p>
  </div></div>`;
}

/* ------------------------------------------------------------------ */
/* DOM                                                                  */
/* ------------------------------------------------------------------ */

function mapHtml() {
  const node = (n) =>
    `<button type="button" class="map-node${n.tall ? ' tall' : ''} touched unbaselined" data-id="${n.id}" style="left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px">${ic(TYPE_ICON[n.type], 16, 'type-glyph')}<span class="map-node-title">${n.title}</span><span class="map-mark hollow"></span></button>`;
  const edges = (over) =>
    `<svg class="map-edges${over ? ' over' : ''}" viewBox="-20 -60 1360 520" style="left:-20px;top:-60px;width:1360px;height:520px">${LINKS.map(
      (l) => `<g data-key="${l.key}"><path class="map-edge forward" d="${l.d}"></path><path class="map-edge forward sc-head" d="${l.head}"></path></g>`,
    ).join('')}</svg>`;
  return `
    <div class="map-grid" aria-hidden="true" style="background-size:22px 22px;background-position:32px 4px"></div>
    <div class="map-world" id="world" style="transform: translate(32px, 248px) scale(1)">
      ${edges(false)}
      <div class="map-veil" id="veil" style="left:-120px;top:-300px;width:1600px;height:1100px"></div>
      ${edges(true)}
      <div class="map-labels">
        ${HEADS.map((h, i) => `<div class="map-label column" data-head="${i}" style="left:${h.x}px;top:-46px">${h.label} <span></span></div>`).join('')}
        ${GROUPS.map((g, i) => `<button type="button" class="map-label type" data-group="${i}" style="left:${g.x}px;top:${g.y}px">${ic('caret-down', 10)}${g.label} <span></span></button>`).join('')}
      </div>
      ${NODES.map(node).join('')}
    </div>
    <div class="map-foot">
      <ul class="map-legend island"><li><i class="lg-line"></i>input → consequence</li><li><i class="map-mark hollow"></i>no baseline</li></ul>
      <div class="map-peek-slot"></div>
      <div class="map-controls island">
        <button type="button" class="icon-btn icon-btn-sm">${ic('minus', 14)}</button>
        <span class="map-zoom">100%</span>
        <button type="button" class="icon-btn icon-btn-sm">${ic('plus', 14)}</button>
        <button type="button" class="icon-btn icon-btn-sm">${ic('frame-corners', 14)}</button>
        <button type="button" class="icon-btn icon-btn-sm">${ic('keyboard', 14)}</button>
      </div>
    </div>`;
}

function appHtml() {
  const bar = [
    ['agent', 'robot'], ['flow', 'graph'], ['parts', 'package'], ['timeline', 'clock-counter-clockwise'],
    ['files', 'files'], ['evidence', 'target'],
  ];
  return `<div class="app">
    <header class="titlebar">
      <span class="traffic-space"><span class="sc-lights"><i></i><i></i><i></i></span></span>
      <button type="button" class="titlebar-mark">${mark(18)}</button>
      <button type="button" class="project-switch"><span class="truncate">Survey quadcopter</span>${ic('caret-down', 12)}</button>
      <nav class="trail"><button type="button" class="icon-btn icon-btn-sm">${ic('arrow-left', 14)}</button>${ic('caret-right', 12, 'trail-sep')}<span class="trail-current truncate" id="trail">Agent</span></nav>
      <div class="titlebar-actions">
        <button type="button" class="decisions-pill" id="pill"><span class="state-dot" aria-hidden="true"></span>1 to review</button>
        <button type="button" class="omni-trigger">${ic('magnifying-glass', 13)}<span>Go to or ask</span><kbd class="kbd">⌘K</kbd></button>
      </div>
    </header>
    <div class="workbench">
      <nav class="activity-bar" aria-label="Views">
        ${bar.map(([k, i]) => `<button type="button" class="activity-btn" data-k="${k}">${ic(i, 20)}</button>`).join('')}
        <button type="button" class="activity-btn" data-k="decisions">${ic('git-branch', 20)}<span class="activity-badge" id="badge">1</span></button>
        <div class="activity-bottom">
          <button type="button" class="activity-btn">${ic('app-window', 20)}</button>
          <button type="button" class="activity-btn">${ic('gear-six', 20)}</button>
        </div>
      </nav>
      <div class="workbench-main">
        <div class="stage-area">
          <div class="project lens-flow" id="lens">
            <header class="project-head"><div class="identity">
              <h1>Survey quadcopter</h1>
              <button type="button" class="identity-intent"><span>A folding survey quadcopter that carries a 300 g sensor head for 20 minutes.</span></button>
              <p class="identity-meta" id="meta"></p>
            </div></header>
            <aside class="needs island" id="needs">
              <header class="needs-head"><span>Needs you</span><span class="count">1</span><span class="grow"></span><button type="button" class="icon-btn icon-btn-sm">${ic('caret-up', 14)}</button></header>
              <div class="needs-list"><div class="needs-rows"><div class="needs-row"><button type="button" class="needs-open">${ic('git-branch', 14, 'needs-icon warn')}<span class="needs-copy"><strong>First baseline for the survey quadcopter</strong><small>Claude Code proposed 25 changes · just now</small></span>${ic('arrow-right', 12, 'needs-go')}</button></div></div></div>
            </aside>
            <div class="needs island quiet" id="needsQuiet" role="status">${ic('circle-dashed', 14)}<span id="needsQuietText"></span></div>
            <div class="needs island quiet" id="needsSettled" role="status">${ic('check-circle', 14, 'tone-ok-text')}Every baseline is current and reviewed</div>
            <div class="beginning" id="beginning">
              <div class="beginning-flow" aria-hidden="true">
                ${['requirement', 'component', 'mechanical', 'calculation']
                  .map((t, i) => `${i ? '<span class="beginning-link"></span>' : ''}<span class="beginning-node">${ic(TYPE_ICON[t], 14)}${['Intent', 'Parts', 'Design', 'Evidence'][i]}</span>`)
                  .join('')}
              </div>
              <h2>Start with what it must do.</h2>
              <p>Your agent drafts requirements, parts, models, and calculations. They appear here as one connected flow — and none become the design until you approve them.</p>
            </div>
            <div class="map" data-detail="full" id="map">${mapHtml()}</div>
          </div>
        </div>
        <section class="agent-surface mode-tab pane-conversation" id="agentTab">
          <header class="session-bar">
            <div class="segmented" role="radiogroup"><button type="button" role="radio" aria-checked="true">Conversation</button><button type="button" role="radio" aria-checked="false">Terminal</button></div>
            <div class="session-main">
              <span class="session-status tone-neutral" id="tabStatus"><span class="state-dot" id="tabDot" aria-hidden="true"></span><span class="pulse tone-signal" id="tabPulse" aria-hidden="true"><i class="sc-ring"></i></span><span id="tabStatusLabel">Ready</span></span>
              <button type="button" class="session-thread"><strong class="truncate" id="tabThread">New conversation</strong>${ic('caret-down', 11)}</button>
            </div>
            <div class="session-controls">
              <button type="button" class="icon-btn icon-btn-sm">${ic('book-open', 14)}</button>
              <span class="session-sep" aria-hidden="true"></span>
              <button type="button" class="icon-btn icon-btn-sm" aria-pressed="true">${ic('sidebar-simple', 14)}</button>
              <button type="button" class="icon-btn icon-btn-sm">${ic('gear-six', 14)}</button>
            </div>
          </header>
          <div class="agent-body">
            <div class="agent-conversation">
              <section class="chat-conversation is-empty" id="tabConv">
                <div class="chat-conversation-scroll scroll-region" id="tabScroll">
                  <div class="chat-column">
                    <div id="welcome">
                      <div class="chat-welcome"><div class="chat-welcome-mark">${mark(40)}</div><h2>What are we making?</h2><p>Bring an idea, a constraint, or a question.</p></div>
                      <div class="chat-starters">
                        <button type="button">${ic('sliders-horizontal', 16)}<strong>Explore a direction</strong><span>Turn an idea into a useful brief</span></button>
                        <button type="button">${ic('cube', 16)}<strong>Shape a part</strong><span>Work from dimensions and constraints</span></button>
                        <button type="button">${ic('shield-check', 16)}<strong>Check the evidence</strong><span>See what is known, and what is missing</span></button>
                      </div>
                    </div>
                    <ol class="chat-messages" id="tabMsgs" style="display:none">${turnHtml('tab')}</ol>
                  </div>
                </div>
                ${composerHtml('tab')}
              </section>
            </div>
            <aside class="activity-rail" aria-label="Agent activity">
              <header class="activity-rail-head"><h2>Activity</h2><span class="activity-rail-summary" id="railSummary"></span><span class="grow"></span></header>
              <div class="activity-rail-body">
                <p class="activity-rail-note" id="railEmpty">No tool calls recorded in this project yet.</p>
                <section class="call-group" id="railGroup" style="display:none">
                  <h3><span>14:02</span><span id="railCount"></span><span>conversation</span></h3>
                  <ol>${CALLS.map(
                    ([, tool, ms], i) =>
                      `<li class="call ok" data-call="${i}"><div class="call-head">${ic('check-circle', 13, 'call-mark')}<span class="call-tool truncate">${toolWords(tool)}</span><span class="call-outcome">ok</span><span class="call-time mono">${ms} ms</span></div><div class="call-meta"><span class="mono">${tool}</span></div></li>`,
                  ).join('')}</ol>
                </section>
              </div>
            </aside>
          </div>
        </section>
        <section class="agent-surface mode-docked pane-conversation" id="dock" style="width:520px">
          <header class="agent-head">
            <span class="agent-light live" id="dockLight" aria-hidden="true"></span>
            <span class="agent-name truncate">Survey quadcopter</span>
            <span class="agent-status tone-signal" id="dockStatus">Responding</span>
            <span class="grow"></span>
            <button type="button" class="icon-btn icon-btn-sm">${ic('dots-three:bold', 15)}</button>
            <button type="button" class="icon-btn icon-btn-sm">${ic('picture-in-picture', 13)}</button>
            <button type="button" class="icon-btn icon-btn-sm">${ic('arrows-out', 13)}</button>
            <button type="button" class="icon-btn icon-btn-sm">${ic('minus', 13)}</button>
          </header>
          <div class="agent-body">
            <div class="agent-conversation">
              <section class="chat-conversation is-compact" id="dockConv">
                <div class="chat-conversation-scroll scroll-region" id="dockScroll">
                  <div class="chat-column"><ol class="chat-messages">${turnHtml('dock')}</ol></div>
                </div>
                ${composerHtml('dock')}
              </section>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>`;
}

function toolWords(tool) {
  const s = tool.split(/[_.\s]+/).join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const CHAPTERS = [
  ['Intent', 'Three requirements and one assumption. <b>Every target carries its unit.</b>'],
  ['Parts', 'Six real parts, <b>each traced to its source.</b>'],
  ['Design', 'Architecture, wiring, and <b>CAD you can inspect in 3D.</b>'],
  ['Evidence', 'Calculations that <b>show their inputs.</b>'],
];
const words = (html) =>
  html
    .split(/(<b>.*?<\/b>)/)
    .flatMap((part) =>
      part.startsWith('<b>')
        ? part
            .slice(3, -4)
            .split(' ')
            .filter(Boolean)
            .map((w) => `<span class="sc-w"><span><b>${w}</b></span></span>`)
        : part
            .split(' ')
            .filter(Boolean)
            .map((w) => `<span class="sc-w"><span>${w}</span></span>`),
    )
    .join(' ');

function buildStage(stage) {
  stage.innerHTML = `
    <div class="sc-layer sc-bg"><div class="sc-dots"></div><div class="sc-halo"></div></div>
    <div class="sc-layer sc-tilt" id="tilt"><div class="sc-cam" id="cam">
      <div class="sc-win" id="win">${appHtml()}<div class="sc-win-dim" id="winDim"></div></div>
      <div class="sc-ripple" id="ripple"></div>
      <div class="sc-cursor" id="cursor">${CURSOR}</div>
    </div></div>
    <div class="sc-open" id="open"><h2>${words('One sentence.')}</h2></div>
    <div class="sc-layer sc-vignette"></div>
    <div class="sc-layer sc-scrim" id="scrim"></div>
    <div class="sc-chapter" id="chapter">
      ${CHAPTERS.map(
        ([title, line], i) => `<div class="sc-ch" data-ch="${i}">
          <div class="sc-ch-idx"><span>0${i + 1} / 04</span><span class="sc-ch-bars">${CHAPTERS.map((_, j) => `<i class="${j < i ? 'done' : j === i ? 'on' : ''}"></i>`).join('')}</span></div>
          <h2>${words(title)}</h2>
          <p>${words(line)}</p>
        </div>`,
      ).join('')}
    </div>
    <div class="sc-layer sc-capscrim" id="capScrim"></div>
    <div class="sc-caption" id="caption">${words('Agents propose.')} <span class="sc-dim2">${words('You decide.')}</span></div>
    <div class="sc-layer sc-end" id="end"><div class="sc-end-inner">
      ${mark(92, 'sc-mark')}
      <h1>${words('Omen')} <span class="sc-flow">${words('Flow')}</span></h1>
      <p>${words('One sentence in. A connected engineering record out.')}</p>
      <small id="endSmall">Open source · macOS and Linux · Bring Claude Code, Codex, or your own agent</small>
    </div></div>
    <div class="sc-layer sc-fade" id="fade"></div>`;
}

/* ------------------------------------------------------------------ */
/* State at time t                                                      */
/* ------------------------------------------------------------------ */

let R = {}; // element references
let mount = null;
const HEIGHTS = {}; // natural heights of growing blocks, measured once

function grab() {
  R = {
    tilt: $('#tilt'), open: $('#open'), cam: $('#cam'), win: $('#win'), winDim: $('#winDim'), cursor: $('#cursor'), ripple: $('#ripple'),
    trail: $('#trail'), pill: $('#pill'), badge: $('#badge'),
    bar: Object.fromEntries($$('.activity-btn[data-k]').map((b) => [b.dataset.k, b])),
    lens: $('#lens'), meta: $('#meta'), needs: $('#needs'), needsQuiet: $('#needsQuiet'),
    needsQuietText: $('#needsQuietText'), needsSettled: $('#needsSettled'), beginning: $('#beginning'), map: $('#map'), world: $('#world'), veil: $('#veil'),
    nodes: Object.fromEntries($$('.map-node[data-id]').map((n) => [n.dataset.id, n])),
    heads: $$('.map-label.column'), groups: $$('.map-label.type'),
    edges: Object.fromEntries($$('.map-edges:not(.over) g').map((g) => [g.dataset.key, g])),
    over: Object.fromEntries($$('.map-edges.over g').map((g) => [g.dataset.key, g])),
    tabSurface: $('#agentTab'), tabConv: $('#tabConv'), tabScroll: $('#tabScroll'), welcome: $('#welcome'), tabMsgs: $('#tabMsgs'),
    tabStatus: $('#tabStatus'), tabDot: $('#tabDot'), tabPulse: $('#tabPulse'), tabStatusLabel: $('#tabStatusLabel'), tabThread: $('#tabThread'),
    railEmpty: $('#railEmpty'), railGroup: $('#railGroup'), railCount: $('#railCount'), railSummary: $('#railSummary'),
    calls: $$('[data-call]'),
    dockSurface: $('#dock'), dockScroll: $('#dockScroll'), dockLight: $('#dockLight'), dockStatus: $('#dockStatus'),
    cards: Object.fromEntries(['req', 'mount', 'calc', 'review'].map((k) => [k, $(`#card_${k}`)])),
    meshDeferred: $('#meshDeferred'), meshBox: $('#meshBox'), show3d: $('#show3d'),
    reviewState: $('#reviewState'), reviewCheck: $('#reviewCheck'), reviewEditorWrap: $('#reviewEditorWrap'),
    approveBtn: $('#approveBtn'), approveSpin: $('#approveSpin'), approveLabel: $('#approveLabel'),
    scrim: $('#scrim'), chapters: $$('.sc-ch'), capScrim: $('#capScrim'), caption: $('#caption'), end: $('#end'),
    endSmall: $('#endSmall'), fade: $('#fade'),
  };
  for (const p of ['tab', 'dock'])
    R[p] = {
      composer: $(`#${p}Composer`), text: $(`#${p}Text`), ph: $(`#${p}Ph`), caret: $(`#${p}Caret`),
      send: $(`#${p}Send`), stop: $(`#${p}Stop`), paras: PARAS.map((_, i) => $(`#${p}P${i}`)),
      run: $(`#${p}Run`), runLabel: $(`#${p}RunLabel`), spin: $(`#${p}Run .spinner`),
    };
}

/** Characters of a streamed paragraph shown at t, released a word at a time. */
function streamed(text, a, b, t) {
  const n = Math.floor(text.length * E.sine(prog(t, a, b)));
  if (n >= text.length) return text;
  const cut = text.lastIndexOf(' ', n);
  return cut > 0 ? text.slice(0, cut) : '';
}

function composerState(p, t, { typing }) {
  const typed = typing ? TYPE_TIMES.filter((x) => x <= t).length : 0;
  const sent = typing && t >= SENT;
  const text = sent ? '' : PROMPT.slice(0, typed);
  setText(p.text, text);
  show(p.ph, !text);
  const focused = typing && t >= CUE.clickComposer && !sent;
  const last = typed ? TYPE_TIMES[typed - 1] : CUE.clickComposer;
  const blinkOn = t - last < 0.5 || Math.floor((t - last) / 0.53) % 2 === 1;
  p.caret.style.opacity = focused && blinkOn ? 1 : 0;
  p.composer.style.borderColor = focused ? 'var(--signal-line)' : '';
  const running = t >= SENT && t < RUN_END;
  show(p.send, !running);
  show(p.stop, running);
  setAttr(p.send, 'disabled', text ? null : '');
  const press = typing ? env(t, CUE.clickSend - 0.05, CUE.clickSend, CUE.clickSend + 0.02, CUE.clickSend + 0.16) : 0;
  p.send.style.transform = press ? `scale(${1 - 0.08 * press})` : '';
}

function conversationState(p, t, dock) {
  PARAS.forEach(([a, b, text], i) => {
    const s = t >= a ? streamed(text, a, b, t) : '';
    setText(p.paras[i], s);
    show(p.paras[i], !!s);
  });
  const running = t >= SENT && t < RUN_END;
  show(p.run, running);
  setText(p.runLabel, t > PARAS[0][0] ? 'Response in progress' : 'Agent is working');
  p.spin.style.transform = `rotate(${(t * 450) % 360}deg)`;
  if (!dock) return;
  for (const [k, t0] of Object.entries(CARD_TIMES)) {
    const k1 = ez(t, t0, t0 + 0.45, E.cubicOut);
    const el = R.cards[k];
    el.style.height = k1 >= 1 ? '' : `${HEIGHTS[k] * k1}px`;
    el.style.opacity = ez(t, t0 + 0.08, t0 + 0.45, E.cubicOut);
    el.style.marginBottom = k1 ? '' : '0px';
    show(el, k1 > 0);
  }
}

function update(t) {
  const flow = t >= CUE.clickFlow + 0.04;

  /* Shell */
  setText(R.trail, flow ? 'Flow' : 'Agent');
  setAttr(R.bar.agent, 'aria-current', flow ? null : 'page');
  setAttr(R.bar.flow, 'aria-current', flow ? 'page' : null);
  const proposed = t >= CUE.proposal + 0.2 && t < CUE.approved + 0.12;
  show(R.pill, proposed);
  show(R.badge, proposed);

  /* Agent tab */
  show(R.tabSurface, !flow);
  const sent = t >= SENT;
  toggle(R.tabConv, 'is-empty', !sent);
  show(R.welcome, !sent);
  show(R.tabMsgs, sent);
  R.tabMsgs.style.opacity = ez(t, SENT, SENT + 0.3, E.cubicOut);
  R.tabMsgs.style.transform = `translateY(${(1 - ez(t, SENT, SENT + 0.5)) * 14}px)`;
  composerState(R.tab, t, { typing: true });
  conversationState(R.tab, t, false);
  const running = sent && t < RUN_END;
  show(R.tabDot, !running);
  show(R.tabPulse, running);
  toggle(R.tabStatus, 'tone-signal', running);
  toggle(R.tabStatus, 'tone-neutral', !running);
  setText(R.tabStatusLabel, running ? 'Responding' : 'Ready');
  setText(R.tabThread, sent ? 'Survey quadcopter' : 'New conversation');
  const ring = R.tabPulse.firstChild;
  const ph = ((t - SENT) / 1.8) % 1;
  ring.style.transform = `scale(${0.6 + ph * 1.6})`;
  ring.style.opacity = (1 - ph) * 0.9;
  const shownCalls = CALLS.filter(([c]) => c <= t).length;
  show(R.railEmpty, !shownCalls);
  show(R.railGroup, shownCalls > 0);
  setText(R.railCount, `${shownCalls} ${shownCalls === 1 ? 'call' : 'calls'}`);
  setText(R.railSummary, shownCalls ? `${shownCalls} ${shownCalls === 1 ? 'call' : 'calls'} this session` : '');
  R.calls.forEach((el, i) => {
    const t0 = CALLS[i][0];
    show(el, t >= t0);
    el.style.opacity = ez(t, t0, t0 + 0.25, E.cubicOut);
  });

  /* Dock */
  show(R.dockSurface, flow);
  conversationState(R.dock, t, true);
  composerState(R.dock, t, { typing: false });
  toggle(R.dockLight, 'live', running);
  toggle(R.dockLight, 'ready', !running);
  setText(R.dockStatus, running ? 'Responding' : 'Conversation');
  toggle(R.dockStatus, 'tone-signal', running);
  toggle(R.dockStatus, 'tone-neutral', !running);

  // The part renders only once you ask for it in a docked conversation.
  const shown3d = t >= CUE.clickShow3d + 0.06;
  show(R.meshDeferred, !shown3d);
  show(R.meshBox, shown3d);
  R.show3d.style.transform = `scale(${1 - 0.06 * env(t, CUE.clickShow3d - 0.05, CUE.clickShow3d, CUE.clickShow3d + 0.02, CUE.clickShow3d + 0.15)})`;

  // Review: tick the box, arm the approval, confirm it.
  R.reviewCheck.checked = t >= CUE.clickCheck;
  const armed = t >= CUE.clickApprove && t < CUE.clickConfirm;
  const busy = t >= CUE.clickConfirm && t < CUE.approved;
  toggle(R.approveBtn, 'armed', armed);
  toggle(R.approveBtn, 'busy', busy);
  show(R.approveSpin, busy);
  setText(R.approveLabel, t >= CUE.clickApprove ? 'Confirm approval' : 'Approve baseline');
  R.approveSpin.firstChild.style.transform = `rotate(${(t * 450) % 360}deg)`;
  const approved = t >= CUE.approved;
  const stateEl = R.reviewState;
  toggle(stateEl, 'tone-warn', !approved);
  toggle(stateEl, 'tone-ok', approved);
  setText(stateEl.lastChild, approved ? 'Approved' : 'Needs you');
  const ed = 1 - ez(t, CUE.pullBack, CUE.pullBack + 0.5, E.cubicInOut);
  R.reviewEditorWrap.style.height = ed >= 1 ? '' : `${HEIGHTS.editor * ed}px`;
  R.reviewEditorWrap.style.opacity = ed;

  // Follow the newest content, as the conversation does.
  R.dockScroll.scrollTop = R.dockScroll.scrollHeight;
  R.tabScroll.scrollTop = R.tabScroll.scrollHeight;

  /* Flow lens */
  const beginning = flow && t < CUE.ch1 + 0.55;
  show(R.beginning, beginning);
  R.beginning.style.opacity = 1 - ez(t, CUE.ch1 + 0.2, CUE.ch1 + 0.5, E.cubicInOut);
  const mapIn = ez(t, CUE.ch1 + 0.25, CUE.ch1 + 0.55, E.cubicOut);
  show(R.map, flow && mapIn > 0);
  R.map.style.opacity = mapIn;

  const visible = new Set(NODES.filter((n) => t >= n.t0).map((n) => n.id));
  const threadOn = env(t, CUE.hover + 0.08, CUE.hover + 0.32, 29.3, 29.6, E.cubicOut, E.cubicInOut);
  const threaded = threadOn > 0.01;
  for (const n of NODES) {
    const el = R.nodes[n.id];
    const k = ez(t, n.t0, n.t0 + 0.42, E.cubicOut);
    show(el, k > 0);
    el.style.opacity = k;
    el.style.transform = `translateY(${(1 - k) * 8}px) scale(${0.96 + 0.04 * k})`;
    // The agent's ring flares on arrival and settles to its resting glow.
    const flare = 1 - ez(t, n.t0 + 0.1, n.t0 + 1.2, E.cubicOut);
    el.style.boxShadow =
      k > 0
        ? `0 0 0 1px var(--signal-line), 0 0 ${18 + 26 * flare}px ${-4 + 4 * flare}px color-mix(in srgb, var(--signal-stroke) ${45 + 30 * flare}%, transparent)`
        : '';
    const baselined = t >= CUE.approved + 0.1 + n.col * 0.07;
    toggle(el, 'unbaselined', !baselined);
    show(el.lastChild, !baselined);
    const on = threaded && THREAD.has(n.id);
    setAttr(el, 'data-thread', on ? (n.id === 'req_payload' ? 'origin' : 'down') : null);
  }
  R.veil.style.visibility = threaded ? 'visible' : 'hidden';
  R.veil.style.opacity = 0.72 * threadOn;
  setAttr(R.map, 'data-threaded', threaded ? '' : null);

  for (const l of LINKS) {
    const g = R.edges[l.key];
    const k = ez(t, l.t0, l.t0 + l.dur, E.cubicInOut);
    show(g, k > 0);
    if (k > 0) {
      const [line, head] = g.children;
      const len = (l.len ??= line.getTotalLength());
      line.style.strokeDasharray = `${len}`;
      line.style.strokeDashoffset = `${len * (1 - k)}`;
      head.style.opacity = ez(t, l.t0 + l.dur * 0.85, l.t0 + l.dur + 0.1, E.cubicOut);
    }
    const o = R.over[l.key];
    setAttr(o.children[0], 'data-lit', threaded && THREAD_LINKS.has(l.key) ? '' : null);
    setAttr(o.children[1], 'data-lit', threaded && THREAD_LINKS.has(l.key) ? '' : null);
    o.style.opacity = threadOn;
  }
  HEADS.forEach((h, i) => {
    const n = h.ids.filter((id) => visible.has(id)).length;
    const first = Math.min(...h.ids.map((id) => NODE[id].t0));
    const el = R.heads[i];
    el.style.opacity = ez(t, first - 0.1, first + 0.3, E.cubicOut);
    setText(el.lastChild, String(n));
  });
  GROUPS.forEach((g, i) => {
    const n = g.ids.filter((id) => visible.has(id)).length;
    const first = Math.min(...g.ids.map((id) => NODE[id].t0));
    const el = R.groups[i];
    el.style.opacity = ez(t, first - 0.1, first + 0.3, E.cubicOut);
    setText(el.lastChild, String(n));
  });
  const linkCount = LINKS.filter((l) => t >= l.t0 + l.dur * 0.5).length;
  setText(R.meta, visible.size ? `${visible.size} ${visible.size === 1 ? 'object' : 'objects'} · ${linkCount} recorded ${linkCount === 1 ? 'link' : 'links'}` : 'No objects yet');

  // Needs you: one quiet line naming what is unfinished, the proposal, then the settled line.
  const rowsIn = t >= CUE.proposal + 0.2 && !approved;
  show(R.needs, rowsIn);
  R.needs.style.opacity = ez(t, CUE.proposal + 0.2, CUE.proposal + 0.5, E.cubicOut);
  R.needs.style.transform = `translateY(${(1 - ez(t, CUE.proposal + 0.2, CUE.proposal + 0.6)) * -8}px)`;
  show(R.needsQuiet, visible.size > 0 && !rowsIn && !approved);
  R.needsQuiet.style.opacity = ez(t, NODES[0].t0, NODES[0].t0 + 0.4, E.cubicOut);
  const n = visible.size;
  setText(R.needsQuietText, `Nothing waits on you · ${n} ${n === 1 ? 'object has' : 'objects have'} no baseline · ${n} ${n === 1 ? 'draft is' : 'drafts are'} not proposed`);
  show(R.needsSettled, approved);
  R.needsSettled.style.opacity = ez(t, CUE.approved + 0.1, CUE.approved + 0.4, E.cubicOut);
}

/* ------------------------------------------------------------------ */
/* Camera, cursor, titles                                               */
/* ------------------------------------------------------------------ */

const POS = {};
/** An element's box in window coordinates, whatever the camera is doing. */
function box(el) {
  const w = R.win.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const k = w.width / WIN_W;
  const x = (r.left - w.left) / k;
  const y = (r.top - w.top) / k;
  return { x, y, w: r.width / k, h: r.height / k, cx: x + r.width / k / 2, cy: y + r.height / k / 2 };
}
/** A map world point in window coordinates. */
const world = (wx, wy) => [POS.world.x + wx, POS.world.y + wy];

function measure() {
  const at = (t, fn) => {
    update(t);
    fn();
  };
  at(0, () => {
    POS.composer = box($('#tabComposer'));
    POS.ta = box($('#tabTa'));
  });
  at(CUE.clickSend - 0.1, () => {
    POS.send = box(R.tab.send);
  });
  at(6.6, () => {
    POS.turn = box($('#tabMsgs'));
  });
  at(CUE.clickFlow, () => {
    POS.flowBtn = box(R.bar.flow);
  });
  at(CUE.ch1 + 1, () => {
    POS.world = box(R.world);
  });
  at(CUE.clickShow3d - 0.1, () => {
    POS.show3d = box(R.show3d);
    POS.mountCard = box(R.cards.mount);
  });
  at(21, () => {
    POS.mesh = box(R.meshBox);
  });
  at(25, () => {
    POS.calc = box(R.cards.calc);
  });
  at(CUE.clickCheck - 0.1, () => {
    POS.check = box(R.reviewCheck);
    POS.approve = box(R.approveBtn);
    POS.review = box(R.cards.review);
  });
  at(CUE.clickConfirm - 0.1, () => {
    POS.confirm = box(R.approveBtn);
  });
  POS.payload = { cx: world(NODE.req_payload.x + 70, 0)[0], cy: world(0, NODE.req_payload.cy)[1] };
}

/** Each growing block's natural height, read just after it has fully arrived. */
function measureHeights() {
  const k = () => R.win.getBoundingClientRect().width / WIN_W;
  for (const key of [...Object.keys(CARD_TIMES), 'editor']) HEIGHTS[key] = 0;
  for (const [key, t0] of Object.entries(CARD_TIMES)) {
    update(t0 + 0.5);
    HEIGHTS[key] = R.cards[key].firstElementChild.getBoundingClientRect().height / k();
  }
  update(CUE.pullBack - 0.1);
  HEIGHTS.editor = R.reviewEditorWrap.firstElementChild.getBoundingClientRect().height / k();
}

let CAM = null;
function cameraKeys() {
  const C = POS.composer;
  const T = POS.turn;
  const [ix, iy] = world(240, 210);
  const [px, py] = world(520, 250);
  const [dx, dy] = world(900, 230);
  const [ex] = world(1186, 0);
  const mesh = POS.mesh;
  const calc = POS.calc;
  const rev = POS.review;
  const WIDE = [WIN_W / 2, WIN_H / 2, 0.84];
  const mapC = world(660, 190);
  return [
    [0, WIDE],
    [0.9, [WIN_W / 2, WIN_H / 2 + 10, 0.88], E.sine],
    [4.6, [C.cx + 30, C.cy - 40, 1.72], E.cubicInOut],
    [5.35, [C.cx + 30, C.cy - 40, 1.74], E.sine],
    [6.3, [WIN_W, T.y + 250, 1.3], E.expoInOut],
    [6.95, [WIN_W, T.y + 260, 1.33], E.sine],
    [7.5, [WIN_W / 2, WIN_H / 2, 0.9], E.cubicInOut],
    [8.3, [WIN_W / 2, WIN_H / 2, 0.88], E.sine],
    [9.3, [ix, iy, 1.85], E.expoInOut],
    [12.1, [ix + 40, iy + 10, 1.9], E.sine],
    [13.1, [px, py, 1.5], E.expoInOut],
    [16.2, [px + 90, py + 10, 1.55], E.sine],
    [17.1, [WIN_W, dy + 40, 1.78], E.expoInOut],
    [18.5, [WIN_W, dy + 60, 1.8], E.sine],
    [19.1, [WIN_W, mesh.cy, 1.82], E.expoInOut],
    [22.0, [WIN_W, mesh.cy + 10, 1.88], E.sine],
    [22.8, [(ex + calc.cx) / 2, calc.cy - 30, 1.4], E.expoInOut],
    [26.2, [(ex + calc.cx) / 2 + 20, calc.cy - 30, 1.46], E.sine],
    [27.1, [WIN_W / 2, WIN_H / 2, 0.88], E.expoInOut],
    [27.45, [WIN_W / 2, WIN_H / 2, 0.89], E.sine],
    [29.4, [mapC[0], mapC[1], 1.14], E.cubicInOut],
    [30.0, [rev.cx - 260, rev.cy + 60, 1.45], E.expoInOut],
    [33.2, [rev.cx - 280, rev.cy + 50, 1.52], E.sine],
    [34.2, [WIN_W / 2, WIN_H / 2, 0.8], E.expoInOut],
    [35.4, [WIN_W / 2, WIN_H / 2 - 30, 0.72], E.cubicOut],
  ];
}

function cursorKeys() {
  const C = POS.ta;
  return [
    [0, [C.x + C.w * 0.72, C.y + C.h + 140]],
    [0.85, [C.x + 260, C.y + 30], E.cubicInOut],
    [4.75, [C.x + 280, C.y + 40], E.sine],
    [5.25, [POS.send.cx + 2, POS.send.cy + 2], E.cubicInOut],
    [6.6, [POS.send.cx - 160, POS.send.cy - 220], E.sine],
    [7.5, [POS.flowBtn.cx + 2, POS.flowBtn.cy + 2], E.cubicInOut],
    [8.3, [POS.flowBtn.cx + 220, POS.flowBtn.cy + 260], E.cubicOut],
    [18.2, [POS.show3d.cx + 120, POS.show3d.cy + 140], E.sine],
    [18.95, [POS.show3d.cx + 4, POS.show3d.cy + 3], E.cubicInOut],
    [21.6, [POS.show3d.cx + 60, POS.show3d.cy + 300], E.sine],
    [27.1, [POS.payload.cx + 200, POS.payload.cy + 120], E.sine],
    [27.7, [POS.payload.cx, POS.payload.cy + 4], E.cubicInOut],
    [29.3, [POS.payload.cx + 10, POS.payload.cy + 8], E.sine],
    [30.0, [POS.check.cx + 2, POS.check.cy + 2], E.cubicInOut],
    [30.7, [POS.approve.cx, POS.approve.cy + 2], E.cubicInOut],
    [31.3, [POS.confirm.cx, POS.confirm.cy + 2], E.cubicInOut],
    [33.0, [POS.confirm.cx + 40, POS.confirm.cy + 60], E.sine],
  ];
}
const CLICKS = [CUE.clickComposer, CUE.clickSend, CUE.clickFlow, CUE.clickShow3d, CUE.clickCheck, CUE.clickApprove, CUE.clickConfirm];

/** Close shots stay inside the window; wide shots let it float on the backdrop. */
function frame([cx, cy, s]) {
  const hw = W / 2 / s;
  const hh = H / 2 / s;
  const k = clamp((s - 0.9) / 0.15);
  const fx = hw * 2 <= WIN_W ? clamp(cx, hw, WIN_W - hw) : WIN_W / 2;
  const fy = hh * 2 <= WIN_H ? clamp(cy, hh, WIN_H - hh) : WIN_H / 2;
  return [lerp(cx, fx, k), lerp(cy, fy, k), s];
}

function cameraAndCursor(t) {
  const [cx, cy, s] = frame(track(t, CAM.cam));
  R.cam.style.transform = `translate(${W / 2 - cx * s}px, ${H / 2 - cy * s}px) scale(${s})`;
  const [x, y] = track(t, CAM.cursor);
  const visible =
    env(t, 0.25, 0.6, CUE.typeStart + 0.15, CUE.typeStart + 0.4) +
    env(t, CUE.typeEnd + 0.05, CUE.typeEnd + 0.3, 8.6, 9.0) +
    env(t, 18.1, 18.45, 21.7, 22.1) +
    env(t, 26.9, 27.25, 33.2, 33.7);
  const press = Math.max(...CLICKS.map((c) => env(t, c - 0.06, c, c + 0.02, c + 0.14)));
  R.cursor.style.transform = `translate(${x - 3}px, ${y - 2}px) scale(${(1 - 0.12 * press) / Math.max(0.8, s) ** 0.35})`;
  R.cursor.style.opacity = clamp(visible);
  const last = CLICKS.filter((c) => c <= t).pop();
  const rk = last == null ? 1 : prog(t, last, last + 0.5);
  const [rx, ry] = last == null ? [x, y] : track(last, CAM.cursor);
  R.ripple.style.opacity = rk < 1 ? (1 - rk) * 0.6 * clamp(visible) : 0;
  R.ripple.style.transform = `translate(${rx}px, ${ry}px) scale(${0.3 + 0.9 * E.cubicOut(rk)})`;
}

function wordsIn(el, t, t0, stagger = 0.045, dur = 0.55) {
  $$('.sc-w > span', el).forEach((w, i) => {
    const k = ez(t, t0 + i * stagger, t0 + i * stagger + dur, E.expoOut);
    w.style.transform = `translateY(${(1 - k) * 105}%)`;
  });
}

const CH_TIMES = [
  [CUE.ch1 + 0.55, CUE.ch2 - 0.35],
  [CUE.ch2 + 0.35, CUE.ch3 - 0.35],
  [CUE.ch3 + 0.35, 21.4],
  [CUE.ch4 + 0.35, 26.6],
];

function titles(t) {
  // The window settles flat as the film opens and tips back as it leaves.
  const settle = 1 - ez(t, 0, 1.6, E.cubicOut);
  const leave = ez(t, CUE.pullBack + 0.2, CUE.end + 0.5, E.cubicInOut);
  const tilted = settle > 0.0005 || leave > 0.0005;
  R.tilt.style.transform = tilted
    ? `perspective(2200px) rotateX(${16 * settle + 9 * leave}deg) rotateY(${-7 * settle}deg) scale(${1 - 0.04 * settle})`
    : 'none';

  R.open.style.opacity = env(t, 1.7, 2.1, CUE.clickSend - 0.25, CUE.clickSend + 0.05, E.cubicOut, E.cubicInOut);
  wordsIn(R.open, t, 1.7, 0.09, 0.7);

  let scrim = 0;
  CH_TIMES.forEach(([a, b], i) => {
    const el = R.chapters[i];
    const o = env(t, a, a + 0.35, b - 0.3, b, E.cubicOut, E.cubicInOut);
    el.style.opacity = o;
    el.style.transform = `translateY(${-6 * ez(t, b - 0.3, b, E.cubicIn)}px)`;
    wordsIn(el, t, a);
    scrim = Math.max(scrim, o);
  });
  R.scrim.style.opacity = scrim;

  const cap = env(t, CUE.approved + 0.05, CUE.approved + 0.4, CUE.pullBack + 0.4, CUE.pullBack + 0.8, E.cubicOut, E.cubicInOut);
  R.caption.style.opacity = cap;
  R.capScrim.style.opacity = cap;
  wordsIn(R.caption, t, CUE.approved + 0.05, 0.08, 0.6);

  const endIn = ez(t, CUE.end, CUE.end + 0.6, E.cubicOut);
  R.winDim.style.opacity = 0.8 * ez(t, CUE.pullBack + 0.3, CUE.end + 0.4, E.cubicInOut);
  R.win.parentElement.style.opacity = 1 - ez(t, CUE.end - 0.2, CUE.end + 0.6, E.cubicInOut);
  R.end.style.opacity = endIn;
  wordsIn(R.end, t, CUE.end + 0.05, 0.06, 0.7);
  R.endSmall.style.opacity = ez(t, CUE.end + 0.9, CUE.end + 1.5, E.cubicOut);
  R.fade.style.opacity = 1 - ez(t, 0, 0.6, E.cubicOut) + ez(t, DURATION - 0.6, DURATION, E.cubicIn);
}

function meshState(t) {
  if (t < CUE.clickShow3d + 0.06 || t > CUE.approved + 3) return;
  const b0 = CUE.clickShow3d + 0.15;
  mount.render({
    azimuth: -0.9 + (t - b0) * 0.32,
    build: ez(t, b0 + 0.15, b0 + 1.9, E.cubicInOut),
    scanAlpha: env(t, b0, b0 + 0.2, b0 + 1.8, b0 + 2.3),
    distance: 262 - 18 * ez(t, b0, b0 + 3, E.cubicOut),
  });
}

export function render(t) {
  update(t);
  meshState(t);
  cameraAndCursor(t);
  titles(t);
}

/* ------------------------------------------------------------------ */
/* Boot                                                                 */
/* ------------------------------------------------------------------ */

async function boot() {
  const stage = $('#stage');
  await loadIcons();
  buildStage(stage);
  grab();
  await document.fonts.ready;
  await Promise.all(
    ['400 16px Geist', '500 16px Geist', '600 16px Geist', '400 16px "IBM Plex Mono"', '500 16px "IBM Plex Mono"'].map((f) =>
      document.fonts.load(f),
    ),
  );
  mount = createMount($('#mountCanvas'));
  measureHeights();
  measure();
  CAM = { cam: cameraKeys(), cursor: cursorKeys() };
  render(0);
}

const params = new URLSearchParams(location.search);
const renderMode = params.has('render');
document.body.classList.toggle('render', renderMode);

window.__showcase = boot().then(() => {
  window.__render = render;
  window.__duration = DURATION;
  if (renderMode) return;
  // Interactive preview: play, scrub, and loop with the rendered soundtrack.
  const stage = $('#stage');
  const fit = () => {
    const k = Math.min(innerWidth / W, (innerHeight - 56) / H);
    stage.style.transform = `scale(${k})`;
  };
  addEventListener('resize', fit);
  fit();
  const audio = new Audio('../out/showcase-audio.wav');
  const scrub = $('#scrub');
  const label = $('#time');
  let playing = !params.has('t');
  let t0 = performance.now();
  let tNow = Number(params.get('t') ?? 0);
  const start = () => {
    t0 = performance.now() - tNow * 1000;
    audio.currentTime = tNow;
    audio.play().catch(() => {});
  };
  if (playing) start();
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
