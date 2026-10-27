// Shots 12–13 · the approval's consequences. A macro slice of the Flow map on a
// tilted plane: the impact travels the recorded stale path in amber on the beat
// (payload→tray + payload→mass, payload→ramp, mass→torque), each node it reaches
// turns "Out of date", the camera trucks after it in one long move (kept slow
// enough on screen for the 4-sample blur) and focus rides the head as far as the
// frame reaches, so the node ahead stays soft until it is reached. The last
// push flattens onto Ramp traverse with payload and the film match-cuts into the
// test itself: a 15° hatched ramp on a floor grid, the rover parked at its foot
// (it never drives), a raking light up the slope, callouts projected from 3D.
import * as THREE from 'three';
import { E, clamp, ez, lerp, track, ic } from '../lib/core.js';
import { createFlowMap, FLOWMAP_CSS, FLOWMAP_ICONS } from '../lib/flowmapView.js';
import { NODE, NW } from '../lib/flowmap.js';
import { createRoverStage } from '../lib/roverStage.js';

const CUT = 18; // shot 12 → 13
const Z = 2.2; // the map is laid out at film scale (CSS zoom), so its type rasterises crisp
// The recorded stale path (core propagate_from: [payload,tray], [payload,mass],
// [payload,ramp], [payload,mass,torque]). The ramp test validates Payload
// capacity directly (fixture requirementRefs), so its leg is the long reach.
const LEG = { 'payload>tray': [16.5, 16.75], 'payload>mass': [16.5, 16.75], 'payload>ramp': [17.0, 17.25], 'mass>torque': [17.5, 17.75] };
const ARRIVE = { tray: 16.75, mass: 16.75, ramp: 17.25, torque: 17.75 };
const PATH = new Set(Object.keys(LEG));
// The routed links share lanes: payload→tray, →mass and →ramp leave Payload
// capacity as one trunk through the Parts row gap, tray forks off in the
// Parts→Design gutter, ramp off mass in the Design→Evidence gutter. So the legs
// travel in path distance, not path fraction: tray and mass ride the trunk as
// one head and fork two-thirds of the way through their eighth, and the long
// reach to the ramp test runs in along the already-amber lane and peels off
// down to its node.
const FORK_T = 16.67;
const CLEAR = [17.85, 17.97]; // everything but Ramp traverse clears before the match cut
const SUB = 1 / 240; // one sub-frame of the final render's 4-sample blur
const REST = CUT - 0.03; // the camera is still from here to the cut
const MATCH_HOLD = 0.08; // shot 12's node dissolves into the island while it holds (km starts at 0.08)
let PROFILE = null; // per leg: [[t, distance, speed], …] (built from the routed paths)
let TRAY_FORK = 0; // path distance at which payload→tray leaves the trunk it shares with payload→mass
/** Cubic Hermite in time: distance with set speeds at both ends. */
function travel(t, keys) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, d1, v1] = keys[i];
    if (t > t1) continue;
    const [t0, d0, v0] = keys[i - 1];
    const T = t1 - t0;
    const s = (t - t0) / T;
    const s2 = s * s;
    const s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * d0 + (s3 - 2 * s2 + s) * v0 * T + (3 * s2 - 2 * s3) * d1 + (s3 - s2) * v1 * T;
  }
  return keys.at(-1)[1];
}
/** Path distance two link paths share from their start (they are routed through the same lanes). */
function sharedLength(p, q) {
  const L = Math.min(p.getTotalLength(), q.getTotalLength());
  let d = 0;
  for (; d <= L; d += 1) {
    const a = p.getPointAtLength(d);
    const b = q.getPointAtLength(d);
    if (Math.hypot(a.x - b.x, a.y - b.y) > 0.25) break;
  }
  return Math.max(0, d - 1);
}
// The Evidence column is laid out 40 px wider here, so its long titles keep
// clear of the border and the incoming chevron.
const WIDE = new Set(['power', 'energy', 'mass', 'torque', 'ramp']);
const XW = 40;
const nodeW = (id) => NW + (WIDE.has(id) ? XW : 0);
const WARN = '#f1bb68';

/* ------------------------------------------------------------------ */
/* Shot 12 camera: a perspective matrix shared by CSS and the projection */
/* ------------------------------------------------------------------ */

/**
 * An ease that cruises: its speed rises on a raised cosine over the first `a`
 * of the move, holds, and falls over the last `b`. For a given distance it has
 * the lowest peak speed a smooth start and stop allow, so a long truck stays
 * slow enough on screen for the 4-sample blur to read as motion, not copies.
 */
const cruise = (a, b) => {
  const v = 1 / (1 - (a + b) / 2);
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    if (x < a) return v * (x / 2 - (a / (2 * Math.PI)) * Math.sin((Math.PI * x) / a));
    if (x <= 1 - b) return v * (a / 2 + x - a);
    const y = 1 - x;
    return 1 - v * (y / 2 - (b / (2 * Math.PI)) * Math.sin((Math.PI * y) / b));
  };
};

const persp = (P) => new DOMMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1 / P, 0, 0, 0, 1]);
/** World (map px) → screen: the target lands on the anchor at scale s·Z. */
const worldMatrix = (c) =>
  new DOMMatrix()
    .translate(c.ax, c.ay)
    .multiply(persp(c.P))
    .rotateAxisAngle(0, 0, 1, c.rz)
    .rotateAxisAngle(1, 0, 0, c.rx)
    .rotateAxisAngle(0, 1, 0, c.ry)
    .scale(c.s * Z)
    .translate(-c.tx, -c.ty);
const project = (M, x, y) => {
  const w = M.m14 * x + M.m24 * y + M.m44;
  return [(M.m11 * x + M.m21 * y + M.m41) / w, (M.m12 * x + M.m22 * y + M.m42) / w, w];
};

const ctr = (id) => [NODE[id].x + nodeW(id) / 2, NODE[id].cy];
const RX = NODE.ramp.x + nodeW('ramp') / 2; // the Evidence column's centre line
// Keyframes per format: target (world) → anchor (screen), scale, tilt.
const CAM12 = {
  // One truck from Payload capacity onto the column, slow enough on screen
  // (≤ ~30 px per 1/120 s) for the 4-sample blur to read as motion, not copies.
  // The impact runs ahead of it: Camera tray is reached at the frame's right
  // edge, Rover mass budget just past it, and the camera takes both in as it
  // travels, lands on the column as the long reach arrives, then pushes in on
  // Ramp traverse for the match cut. Each component (target in world px → anchor
  // on screen, scale, tilt) has its own keys, so the push can leave the column
  // framed through the torque leg while the truck's speed stays flat. It comes
  // to rest two frames before the cut (as the rest clears), so the frames
  // either side of the match hold the node on identical pixels.
  land: {
    tx: [[16.5, [125]], [17.38, [1330], cruise(0.14, 0.36)], [REST, [RX], E.sine]],
    ax: [[16.5, [340]], [17.38, [1000], cruise(0.14, 0.36)], [17.7, [1100], E.sine], [REST, [960], E.sine]],
    ty: [[16.5, [173]], [16.95, [219], E.sine], [17.38, [300], E.cubicInOut], [17.6, [312], E.sine], [REST, [379], E.sine]],
    ay: [[16.5, [540]], [16.95, [528], E.sine], [17.38, [540], E.cubicInOut]],
    s: [[16.5, [0.92]], [16.85, [0.85], E.sine], [17.38, [0.96], E.sine], [17.6, [1.0], E.sine], [REST, [1.22], E.sine]],
    rot: [[16.5, [-4, 11, 0]], [17.7, [-3, 9, 0], E.sine], [REST, [0, 0, 0], E.cubicInOut]],
  },
  // 9:16: the narrow frame lands wider, tray and the whole column at once,
  // then pushes in with the torque leg's bracket kept inside the right edge.
  port: {
    tx: [[16.5, [125]], [17.33, [1270], cruise(0.2, 0.36)], [REST, [RX], E.sine]],
    ax: [[16.5, [380]], [17.33, [540], cruise(0.2, 0.36)], [17.7, [480], E.sine], [REST, [540], E.sine]],
    ty: [[16.5, [173]], [16.95, [218], E.sine], [17.33, [292], E.cubicInOut], [REST, [379], E.sine]],
    ay: [[16.5, [960]], [16.95, [945], E.sine], [17.33, [960], E.cubicInOut]],
    s: [[16.5, [0.96]], [16.9, [0.78], E.sine], [17.33, [0.76], E.sine], [17.75, [1.05], E.sine], [REST, [1.42], E.sine]],
    rot: [[16.5, [-8, 9, 0]], [17.7, [-7, 7, 0], E.sine], [REST, [0, 0, 0], E.cubicInOut]],
  },
};
function cam12(t, ctx) {
  const k = CAM12[ctx.portrait ? 'port' : 'land'];
  const [tx] = track(t, k.tx);
  const [ty] = track(t, k.ty);
  const [ax] = track(t, k.ax);
  const [ay] = track(t, k.ay);
  const [s] = track(t, k.s);
  const [rx, ry, rz] = track(t, k.rot);
  return { tx, ty, ax, ay, s, rx, ry, rz, P: ctx.portrait ? 1500 : 1700 };
}
// Focus rides the impact: payload → between tray and mass → ramp → torque → ramp.
const FOCUS_REACH = 0.5; // of the frame's half-width (world px at the current scale)
const FOCUS = [
  [16.5, ctr('payload')],
  [16.75, [1260, 218], E.cubicInOut],
  [17.0, [1265, 222]],
  [17.25, ctr('ramp'), E.cubicInOut],
  [17.5, ctr('ramp')],
  [17.75, ctr('torque'), E.cubicInOut],
  [18.0, ctr('ramp'), E.cubicInOut],
];

/** 0..1 of a leg's path the amber has covered (path fraction, as the stale dash and head read it). */
function staleK(t, key) {
  const leg = LEG[key];
  if (!leg || t <= leg[0]) return 0;
  if (t >= leg[1]) return 1;
  const P = PROFILE?.[key];
  return P ? clamp(travel(t, P) / S.links[key].len) : ez(t, leg[0], leg[1], E.cubicInOut);
}
const nodeK = (t, id) => (ARRIVE[id] ? ez(t, ARRIVE[id], ARRIVE[id] + 0.12, E.cubicOut) : 0);
const hit = (t, a) => (t >= a ? Math.exp(-(t - a) * 7) : 0);

/** Open chevron at the consequence end of a link path (as lib/flowmapView.js draws it). */
function chevronAt(pathEl) {
  const L = pathEl.getTotalLength();
  const p = pathEl.getPointAtLength(L);
  const q = pathEl.getPointAtLength(Math.max(0, L - 2));
  const a = Math.atan2(p.y - q.y, p.x - q.x);
  const s = 6;
  const p1 = [p.x - Math.cos(a - 0.6) * s, p.y - Math.sin(a - 0.6) * s];
  const p2 = [p.x - Math.cos(a + 0.6) * s, p.y - Math.sin(a + 0.6) * s];
  return `M${p1[0].toFixed(2)} ${p1[1].toFixed(2)} L${p.x.toFixed(2)} ${p.y.toFixed(2)} L${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
}
function setLinkPath(l, d) {
  l.path.setAttribute('d', d);
  l.stale.setAttribute('d', d);
  l.len = l.path.getTotalLength();
  l.chev.setAttribute('d', chevronAt(l.path));
}

/* ------------------------------------------------------------------ */
/* Shot 13: the ramp rig (mm; X forward up the slope, Y up, Z right)     */
/* ------------------------------------------------------------------ */

const ANG = (15 * Math.PI) / 180;
const X0 = 96; // foot of the ramp; the rover's front tyre ends at x ≈ 60
const RL = 400; // run
const RH = RL * Math.tan(ANG); // rise ≈ 107 mm
const LAND = 180; // landing at the top
const ZW = 130; // half width
const SL = RL / Math.cos(ANG); // slope length

// Lines lit per fragment (long grid and edge segments): a raking band along
// X + 0.35·Z, and a radial fade so the floor dissolves into the field.
const LINE_VS = `
varying vec3 vW;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const LINE_FS = `
uniform float uAlpha, uHot, uSweep, uW, uRadius;
uniform vec3 uCenter;
varying vec3 vW;
void main() {
  float d = (vW.x + 0.35 * vW.z - uSweep) / uW;
  float light = exp(-d * d);
  float fade = 1.0 - smoothstep(uRadius * 0.3, uRadius, length(vW.xz - uCenter.xz));
  float a = uAlpha * fade * (1.0 + uHot * light);
  gl_FragColor = vec4(vec3(1.0), clamp(a, 0.0, 1.0));
}`;
const lineMat = (alpha, hot, radius = 1e6) =>
  new THREE.ShaderMaterial({
    vertexShader: LINE_VS,
    fragmentShader: LINE_FS,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uSweep: { value: -2000 },
      uW: { value: 70 },
      uAlpha: { value: alpha },
      uHot: { value: hot },
      uCenter: { value: new THREE.Vector3(260, 0, 0) },
      uRadius: { value: radius },
    },
  });
const segs = (arr) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
  return g;
};

function buildRig(scene) {
  const X1 = X0 + RL;
  const X2 = X1 + LAND;
  // Solid faces (occlude the grid and the rover behind), barely above the field.
  const face = (pts, color) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
    scene.add(m);
    return m;
  };
  const quad = (a, b, c, d, color) => face([a, b, c, a, c, d], color);
  const slope = quad([X0, 0, -ZW], [X1, RH, -ZW], [X1, RH, ZW], [X0, 0, ZW], 0x16171a);
  // The slope's face catches the raking light as a soft sheen (sRGB values: no conversion here).
  slope.material = new THREE.ShaderMaterial({
    vertexShader: LINE_VS,
    fragmentShader: `
uniform float uSweep, uW;
varying vec3 vW;
void main() {
  float d = (vW.x + 0.35 * vW.z - uSweep) / uW;
  gl_FragColor = vec4(vec3(0.086, 0.09, 0.102) + vec3(0.075) * exp(-d * d), 1.0);
}`,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    uniforms: { uSweep: { value: -2000 }, uW: { value: 110 } },
  });
  quad([X1, RH, -ZW], [X2, RH, -ZW], [X2, RH, ZW], [X1, RH, ZW], 0x131417); // landing
  face([[X0, 0, ZW], [X1, 0, ZW], [X1, RH, ZW]], 0x0e0f11); // near side triangle
  quad([X1, 0, ZW], [X2, 0, ZW], [X2, RH, ZW], [X1, RH, ZW], 0x0e0f11); // near side of landing
  face([[X0, 0, -ZW], [X1, RH, -ZW], [X1, 0, -ZW]], 0x0e0f11);
  quad([X1, 0, -ZW], [X1, RH, -ZW], [X2, RH, -ZW], [X2, 0, -ZW], 0x0e0f11);
  quad([X2, 0, -ZW], [X2, RH, -ZW], [X2, RH, ZW], [X2, 0, ZW], 0x0d0e10);

  // Edges.
  const e = [];
  const seg = (a, b) => e.push(...a, ...b);
  for (const z of [-ZW, ZW]) {
    seg([X0, 0, z], [X1, RH, z]);
    seg([X1, RH, z], [X2, RH, z]);
    seg([X2, RH, z], [X2, 0, z]);
    seg([X0, 0, z], [X2, 0, z]);
    seg([X1, RH, z], [X1, 0, z]);
  }
  seg([X0, 0, -ZW], [X0, 0, ZW]);
  seg([X1, RH, -ZW], [X1, RH, ZW]);
  seg([X2, RH, -ZW], [X2, RH, ZW]);
  seg([X2, 0, -ZW], [X2, 0, ZW]);
  const edges = new THREE.LineSegments(segs(e), lineMat(0.17, 3.5));
  scene.add(edges);

  // Hatching across the slope at 45° in its own plane (u up the slope, v across).
  const h = [];
  const P = (u, v) => [X0 + u * Math.cos(ANG), u * Math.sin(ANG) + 0.6, v];
  const step = 15;
  for (let c = -2 * ZW; c <= SL; c += step) {
    // line u = c + (v + ZW), clipped to 0 ≤ u ≤ SL, -ZW ≤ v ≤ ZW
    const vA = Math.max(-ZW, -ZW - c);
    const vB = Math.min(ZW, SL - c - ZW);
    if (vB <= vA) continue;
    h.push(...P(c + vA + ZW, vA), ...P(c + vB + ZW, vB));
  }
  const hatch = new THREE.LineSegments(segs(h), lineMat(0.12, 5.5));
  scene.add(hatch);

  // Floor grid: 40 mm cells, every fifth line stronger, fading out radially.
  const gMinor = [];
  const gMajor = [];
  const R = 1800;
  for (let i = -45; i <= 45; i++) {
    const v = i * 40;
    const arr = i % 5 === 0 ? gMajor : gMinor;
    arr.push(-R + 260, 0, v, R + 260, 0, v);
    arr.push(v + 260, 0, -R, v + 260, 0, R);
  }
  const minor = new THREE.LineSegments(segs(gMinor), lineMat(0.13, 2.5, 1300));
  const major = new THREE.LineSegments(segs(gMajor), lineMat(0.2, 2.5, 1300));
  minor.renderOrder = major.renderOrder = -1;
  scene.add(minor, major);
  return { mats: [edges.material, hatch.material, minor.material, major.material, slope.material], X1, X2 };
}

const CAM13 = {
  // [t, [azimuth°, elevation°, distance, tx, ty, tz, fov]]
  land: [
    [18.0, [-58, 10, 720, 215, 60, 0, 30]],
    [19.0, [-52, 9.5, 660, 215, 62, 0, 30], E.sine],
  ],
  port: [
    [18.0, [-71, 21, 980, 225, 90, -28, 38]],
    [19.0, [-65, 20, 910, 225, 92, -28, 38], E.sine],
  ],
};

/* ------------------------------------------------------------------ */

let S;

export default function create(span) {
  return {
    id: 'impact',
    span,
    icons: [...FLOWMAP_ICONS, 'flask'],
    css:
      FLOWMAP_CSS.replaceAll('.fm', '#s-impact .fm') +
      `
#s-impact { background: var(--field); }
#s-impact .m12, #s-impact .m13 { position: absolute; inset: 0; }
#s-impact .m12 canvas.dots { position: absolute; inset: 0; width: 100%; height: 100%; }
#s-impact .cam { position: absolute; left: 0; top: 0; width: 1px; height: 1px; transform-origin: 0 0; }
#s-impact .fmz { position: absolute; left: 0; top: 0; zoom: ${Z}; }
#s-impact .fm .node:is(${[...WIDE].map((id) => `[data-id="${id}"]`).join(',')}) { width: ${NW + XW}px; }
#s-impact .fm path.s { stroke-width: 1.15; }
#s-impact .fm circle.h { r: 2.4px; fill: #ffe6bf; filter: none; }
#s-impact .fm path.hs { fill: none; stroke: #ffe6bf; stroke-width: 4.8; stroke-linecap: round; opacity: 0; }
#s-impact .fm .node .mk:not(.ring) { display: none; }
#s-impact .fm .node.soft .mk.ring { border-color: transparent; box-shadow: 0 0 var(--b) 0.5px rgba(132,136,144,0.85), inset 0 0 var(--b) rgba(132,136,144,0.5); }
#s-impact .fm .node.soft { border-color: transparent !important;
  box-shadow: 0 0 var(--b) 0.5px rgba(255,255,255,0.13), inset 0 0 var(--b) rgba(255,255,255,0.05) !important; }
#s-impact .fm .node.soft .nl { color: transparent; text-shadow: 0 0 var(--b) rgba(212,214,218,0.95); }
#s-impact .fm .node.soft .ic { opacity: 0.3; }
/* Long titles end in an ellipsis inside their node (clip, not hidden, plus a
   margin, so the soft-focus text-shadow is not cut square); only the widened
   Evidence titles may run to their edge. */
#s-impact .fm .node .nl { min-width: 0; overflow: clip; overflow-clip-margin: 8px; }
#s-impact .fm .node:is(${[...WIDE].map((id) => `[data-id="${id}"]`).join(',')}) .nl { overflow: visible; }
#s-impact .fm .node .od { left: 43px; right: auto; top: auto; bottom: 7px; padding: 0; background: none; border-radius: 0;
  font: 500 12.5px/1 var(--font-sans); gap: 6px; letter-spacing: 0; }
#s-impact .fm .node .od::before { width: 6px; height: 6px; }
#s-impact .fm .node .sub { position: absolute; left: 43px; bottom: 7.5px; font: 400 11.5px/1 var(--font-mono); color: var(--text-3); white-space: nowrap; letter-spacing: 0; }
#s-impact .fm .trail { position: absolute; height: 0.7px; background: #ededee; transform-origin: 0 50%; }
#s-impact .glow { position: absolute; left: 0; top: 0; width: 360px; height: 360px; margin: -180px 0 0 -180px; border-radius: 50%;
  background: radial-gradient(circle, rgba(255,226,180,0.55) 0%, rgba(241,187,104,0.22) 14%, rgba(241,187,104,0.06) 38%, rgba(241,187,104,0) 70%);
  visibility: hidden; }
#s-impact .m13 { background: radial-gradient(ellipse 46% 42% at 52% 64%, #141519 0%, rgba(11,12,14,0) 100%); }
#s-impact.portrait .m13 { background: radial-gradient(ellipse 60% 34% at 50% 58%, #141519 0%, rgba(11,12,14,0) 100%); }
#s-impact .m13 canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
#s-impact .m13 svg.co { position: absolute; inset: 0; overflow: visible; }
#s-impact .m13 svg.co path { fill: none; stroke: #a4a7ae; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
#s-impact .m13 .lbl { position: absolute; left: 0; top: 0; transform-origin: 0 0; font: 500 27px/1 var(--font-mono); color: var(--text); white-space: nowrap; letter-spacing: 0; }
#s-impact .m13 .lbl.spd, #s-impact .m13 .lbl.deg { padding: 7px 12px; border-radius: 8px; background: var(--field); }
#s-impact .m13 .lbl .u { color: var(--text-3); }
/* The label island is the map node grown up: glyph beside a title over its
   state, the node's proportions at 27/16 (31/16 in 9:16), so the match cut
   from the node lands glyph on glyph and word on word. */
#s-impact .isle { position: absolute; left: 0; top: 0; transform-origin: 0 0; padding: 20px 26px 21px 25px; white-space: nowrap; font-size: 27px; }
#s-impact .isle .bg { position: absolute; left: 0; top: 0; }
#s-impact .isle .hd { position: relative; display: grid; width: max-content; grid-template-columns: auto auto; column-gap: 0.69em; row-gap: 0.185em; align-items: center; justify-content: start; }
#s-impact .isle .hd .ic { grid-row: 1 / 3; font-size: 1.0625em; color: var(--text-3); }
#s-impact .isle .hd .t { font: 400 1em/1 var(--font-sans); letter-spacing: -0.005em; color: var(--text); }
#s-impact .isle .hd .st { display: inline-flex; align-items: center; gap: 0.48em; font: 500 0.78125em/1 var(--font-sans); letter-spacing: 0; color: var(--warn); }
#s-impact .isle .hd .st i { width: 0.48em; height: 0.48em; border-radius: 50%; background: var(--warn); }
#s-impact .isle .r2 { position: relative; margin: 17px 0 0 1.75em; font: 400 24px/1 var(--font-mono); color: var(--text-3); letter-spacing: 0; }
#s-impact .lead { position: absolute; left: 0; top: 0; height: 1px; background: #848890; transform-origin: 0 50%; }
#s-impact .pin { position: absolute; left: 0; top: 0; width: 7px; height: 7px; margin: -3.5px 0 0 -3.5px; border-radius: 50%; background: #a4a7ae; }
#s-impact.portrait .isle { font-size: 31px; padding: 23px 30px 24px 29px; }
#s-impact.portrait .isle .r2 { font-size: 27px; margin-top: 19px; }
#s-impact.portrait .m13 .lbl { font-size: 34px; }
`,
    build(root, ctx) {
      root.classList.toggle('portrait', ctx.portrait);
      const { W, H } = ctx;
      root.innerHTML = `
        <div class="m12"><canvas class="dots" width="${W / 2}" height="${H / 2}"></canvas><div class="cam"><div class="fmz"></div></div>
          <div class="glow"></div><div class="glow"></div><div class="glow"></div><div class="glow"></div></div>
        <div class="m13"><canvas width="${W}" height="${H}"></canvas>
          <svg class="co" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><path class="arc"/><path class="arr"/><path class="ach"/><path class="tick"/></svg>
          <div class="lbl deg">15<span class="u">°</span></div>
          <div class="lbl spd">≥ 0.5<span class="u"> m/s</span></div>
          <div class="lead"></div><div class="pin"></div>
          <div class="isle"><div class="bg"></div>
            <div class="hd">${ic('flask')}<span class="t">Ramp traverse with payload</span><span class="st"><i></i>Out of date</span></div>
            <div class="r2">Expected · Reaches ≥0.5 m/s mid-ramp, no slip</div></div>
        </div>`;
      const m12 = root.querySelector('.m12');
      const fmz = root.querySelector('.fmz');
      const fm = createFlowMap(fmz);
      // Payload capacity carries its new baseline revision on a second line.
      const pay = fm.byId.payload.el;
      pay.insertAdjacentHTML('beforeend', '<span class="sub">r2 · baseline</span>');
      // The thread arrives from the left as the Payload capacity row.
      const trail = document.createElement('div');
      trail.className = 'trail';
      trail.style.cssText = `left:-2400px;top:${NODE.payload.cy}px;width:2400px`;
      fm.el.appendChild(trail);
      for (const n of fm.nodes) {
        n.nl = n.el.querySelector('.nl');
        n.w = nodeW(n.id);
        n.cx = n.x + n.w / 2;
      }
      // mass → torque stays in its column, now on the wider nodes' right edge.
      const mt = fm.links.find((l) => l.key === 'mass>torque');
      const xr = NODE.mass.x + nodeW('mass');
      setLinkPath(mt, `M${xr} ${NODE.mass.cy} C${xr + 46} ${NODE.mass.cy} ${xr + 46} ${NODE.torque.cy} ${xr} ${NODE.torque.cy}`);
      const links = Object.fromEntries(fm.links.map((l) => [l.key, l]));
      // Leg profiles in path distance (world px, px/s). Tray and mass share the
      // trunk at one speed up to the fork, then tray settles into its short
      // branch (a cubic-out, so the shared speed is matched without overshoot)
      // while mass runs on; both land on 16.75. The ramp leg starts on the
      // trunk just short of the Parts→Design gutter (off frame left) and runs in.
      const Lt = links['payload>tray'].len;
      const Lm = links['payload>mass'].len;
      const Lr = links['payload>ramp'].len;
      const F1 = sharedLength(links['payload>tray'].path, links['payload>mass'].path);
      const vF = (2.7 * (Lt - F1)) / (LEG['payload>tray'][1] - FORK_T);
      // The head leaves Payload capacity gently while the camera holds, then runs with the truck.
      const trunk = [[LEG['payload>mass'][0], 0, 0], [16.58, 0.17 * F1, 2200], [FORK_T, F1, vF]];
      PROFILE = {
        'payload>tray': [...trunk, [LEG['payload>tray'][1], Lt, 0]],
        'payload>mass': [...trunk, [LEG['payload>mass'][1], Lm, 0]],
        'payload>ramp': [[LEG['payload>ramp'][0], Math.max(0, F1 - 60), 0], [LEG['payload>ramp'][1], Lr, 0]],
      };
      TRAY_FORK = F1;
      // Each amber head is drawn as the stretch of path it covers in one
      // sub-frame of the 4-sample blur, so the blend lays a continuous comet
      // tail instead of four dots (the head outruns the truck).
      const staleG = fm.el.querySelector('svg .stale');
      for (const key of PATH) {
        const hs = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hs.setAttribute('d', links[key].path.getAttribute('d'));
        hs.setAttribute('pathLength', '1');
        hs.setAttribute('class', 'hs');
        staleG.appendChild(hs);
        links[key].hs = hs;
      }

      // Shot 13.
      const m13 = root.querySelector('.m13');
      const canvas = m13.querySelector('canvas');
      const stage = createRoverStage(canvas, { pointsPerMm2: 0.16, fov: 28 });
      const rig = buildRig(stage.scene);
      // Compile every program now, so no frame pays for SwiftShader's shader JIT.
      stage.renderer.compile(stage.scene, stage.camera);
      const isle = m13.querySelector('.isle');
      const hd = isle.querySelector('.hd');
      const r2 = isle.querySelector('.r2');
      // Island-local position of the flask glyph's centre (the match-cut pivot).
      const glyph = hd.querySelector('.ic');
      const ir = isle.getBoundingClientRect();
      const gr = glyph.getBoundingClientRect();
      const gx = gr.left - ir.left + gr.width / 2;
      const gy = gr.top - ir.top + gr.height / 2;
      const titleSize = parseFloat(getComputedStyle(hd.querySelector('.t')).fontSize);
      const R = titleSize / 16; // map node px → island px
      const pad = parseFloat(getComputedStyle(isle).paddingRight);
      const isleW = isle.offsetWidth;
      const isleH = isle.offsetHeight;
      // The Ramp traverse node as laid out (map px, its border box at 0,0): its
      // glyph's centre pins the island, and its "Out of date" row sits a hair
      // above where the island's grid puts the state row; `stNudge` is that
      // residue (island px), applied at the match and relaxed as the island
      // travels. (The title already lands on the node's, to a fraction of a px.)
      const nodeEl = fm.byId.ramp.el;
      const nr = nodeEl.getBoundingClientRect();
      const kz = nr.width / nodeW('ramp'); // screen px per map px at build (the .fmz zoom)
      const ngr = nodeEl.querySelector('.ic').getBoundingClientRect();
      const nGlyph = [(ngr.left - nr.left + ngr.width / 2) / kz, (ngr.top - nr.top + ngr.height / 2) / kz];
      const st = hd.querySelector('.st');
      const odr = nodeEl.querySelector('.od').getBoundingClientRect();
      const str = st.getBoundingClientRect();
      const stNudge = [
        gx + ((odr.left - nr.left) / kz - nGlyph[0]) * R - (str.left - ir.left),
        gy + ((odr.top - nr.top) / kz - nGlyph[1]) * R - (str.top - ir.top),
      ];
      // The node's box in island px around the glyph, and the island's two
      // resting boxes: the head alone, then grown to hold the expected line.
      const box = {
        node: [gx - nGlyph[0] * R, gy - nGlyph[1] * R, nodeW('ramp') * R, 46 * R, 12 * R],
        head: [0, 0, hd.offsetLeft + hd.offsetWidth + pad, hd.offsetTop + hd.offsetHeight + parseFloat(getComputedStyle(isle).paddingBottom), 15],
        full: [0, 0, isleW, isleH, 15],
      };
      S = {
        m12,
        m13,
        cam: root.querySelector('.cam'),
        dotsEl: m12.querySelector('canvas.dots'),
        dots: m12.querySelector('canvas.dots').getContext('2d', { willReadFrequently: true }), // CPU raster: thousands of tiny rects
        glows: [...m12.querySelectorAll('.glow')],
        fm,
        links,
        stage,
        rig,
        co: Object.fromEntries([...m13.querySelectorAll('svg.co path')].map((p) => [p.getAttribute('class'), p])),
        deg: m13.querySelector('.deg'),
        degW: m13.querySelector('.deg').offsetWidth,
        spd: m13.querySelector('.spd'),
        spdW: m13.querySelector('.spd').offsetWidth,
        spdH: m13.querySelector('.spd').offsetHeight,
        lead: m13.querySelector('.lead'),
        pin: m13.querySelector('.pin'),
        isle,
        r2,
        title: hd.querySelector('.t'),
        st,
        stNudge,
        nGlyph,
        r2Box: [r2.offsetLeft, r2.offsetTop, r2.offsetWidth, r2.offsetHeight],
        bg: isle.querySelector('.bg'),
        box,
        isleW,
        isleH,
        R,
        glyph: [gx, gy],
        titleSize,
        v: new THREE.Vector3(),
      };
    },
    render(t, ctx) {
      const on12 = t < CUT;
      // The cut lands on identical pixels: shot 13 opens on shot 12's last frame
      // of Ramp traverse (the map node itself, everything else already cleared),
      // and the island, laid on it to a fraction of a pixel, takes over during
      // its hold: it comes up beneath the node, then the node goes.
      const node = on12 ? 1 : 1 - ez(t, CUT + MATCH_HOLD / 4, CUT + MATCH_HOLD, E.sine);
      S.isle.style.opacity = ez(t, CUT, CUT + MATCH_HOLD / 2, E.sine).toFixed(3);
      S.m12.style.display = node > 0 ? 'block' : 'none';
      S.m13.style.display = on12 ? 'none' : 'block';
      S.m12.style.zIndex = on12 ? '' : '1';
      S.m12.style.opacity = on12 ? '' : node.toFixed(3);
      S.dotsEl.style.visibility = on12 ? 'visible' : 'hidden';
      if (on12) renderMap(t, ctx);
      else {
        renderRamp(t, ctx);
        if (node > 0) renderMap(CUT - 1e-4, ctx);
      }
    },
  };
}

/* ------------------------------------------------------------------ */

function renderMap(t, ctx) {
  const { W, H } = ctx;
  const c = cam12(t, ctx);
  const M = worldMatrix(c);
  S.cam.style.transform = M.multiply(new DOMMatrix().scale(1 / Z)).toString();
  // The impact runs ahead of the truck: focus rides it, but no further than
  // the frame reaches, so the lens never racks onto something out of shot.
  const [hx, fy] = track(t, FOCUS);
  const reach = (W / 2 / (c.s * Z)) * FOCUS_REACH;
  const mid = c.tx + (W / 2 - c.ax) / (c.s * Z);
  const fx = clamp(hx, mid - reach, mid + reach);
  const wF = project(M, fx, fy)[2];
  const A = ctx.portrait ? 70 : 80; // aperture: blur (px) per unit of relative depth
  const coc = (w) => (A * Math.abs(w - wF)) / w;
  // The last push is onto Ramp traverse alone: the rest steps back for the match cut.
  const push = ez(t, 17.8, CUT, E.cubicInOut);
  // …and in its last eighth everything else clears, links and lights too, so
  // the frame the island cuts from holds Ramp traverse alone.
  const clear = ez(t, CLEAR[0], CLEAR[1], E.cubicInOut);

  S.fm.render({
    stale: (key) => staleK(t, key),
    staleNode: (id) => nodeK(t, id),
    marks: (id) => (id === 'wheel' ? 'ring' : ''),
    dimRest: 1,
    labelK: 0,
  });

  // Nodes: two-line state, depth of field, arrival glow, culling.
  for (const n of S.fm.nodes) {
    const [sx, sy, w] = project(M, n.cx, n.cy);
    const k = M.m11 ? (c.s * Z) / w : 1; // screen px per world px here
    const half = (n.w / 2) * k + 80;
    const vis = sx > -half && sx < W + half && sy > -60 * k && sy < H + 60 * k;
    n.el.style.visibility = vis ? 'visible' : 'hidden';
    if (!vis) continue;
    const st = n.id === 'payload' ? 1 : nodeK(t, n.id);
    n.nl.style.transform = st > 0 ? `translateY(${(-7.5 * E.cubicOut(st)).toFixed(2)}px)` : '';
    if (ARRIVE[n.id]) n.od.style.transform = `translateY(${((1 - E.cubicOut(st)) * 5).toFixed(2)}px)`;
    // Focus is attention: a node the impact has reached is held sharp.
    const b = (coc(w) / k) * (ARRIVE[n.id] ? 1 - 0.9 * st : n.id === 'payload' ? 0.3 : 1);
    // Quantised, so a node keeps its raster while its focus barely moves.
    const bq = Math.min(3.5, Math.round(b * 2) / 2);
    // Defocus is faked with shadow blurs (text-shadow, box-shadow): far cheaper
    // under SwiftShader than a filter on every node. Deep background dissolves.
    const soft = bq >= 0.5;
    n.el.classList.toggle('soft', soft);
    if (soft) n.el.style.setProperty('--b', `${(bq * 1.7).toFixed(1)}px`);
    const gone = n.thread ? 0 : clamp((b - 2.6) / 1.4);
    if (gone >= 1) {
      n.el.style.visibility = 'hidden';
      continue;
    }
    let o = parseFloat(n.el.style.opacity);
    if (!n.thread) o *= lerp(1, 0.55, clamp(b / 4)) * (1 - gone);
    if (n.id !== 'ramp') o *= lerp(1, n.id === 'mass' || n.id === 'torque' ? 0.6 : 0.3, push) * (1 - clear);
    if (o < 0.002) {
      n.el.style.visibility = 'hidden';
      continue;
    }
    n.el.style.opacity = o.toFixed(3);
    if (ARRIVE[n.id] && t >= ARRIVE[n.id]) {
      const p = hit(t, ARRIVE[n.id]);
      n.el.style.transform = `scale(${(1 + 0.035 * p).toFixed(4)})`;
      n.el.style.boxShadow = `0 0 30px rgba(241,187,104,${(0.15 + 0.35 * p).toFixed(2)})`;
      // A bright flash on arrival, then the recorded amber edge for good.
      n.el.style.borderColor = p > 0.02 ? `rgba(255,214,150,${(0.85 + 0.15 * p).toFixed(3)})` : 'rgba(241,187,104,0.85)';
    }
    if (n.id === 'payload') n.el.style.borderColor = 'rgba(237,237,238,0.42)';
  }

  // Links: thinner at film scale, context ones fall back with depth; recorded
  // chevrons turn amber when the impact arrives.
  for (const l of S.fm.links) {
    const [, , w] = project(M, (l.a.cx + l.b.cx) / 2, (l.a.cy + l.b.cy) / 2);
    const thread = PATH.has(l.key);
    const b = coc(w);
    l.path.style.strokeWidth = thread ? '1.05' : '0.85';
    const out = 1 - clear;
    l.path.style.opacity = ((thread ? 0.95 : 0.6 / (1 + b / 6)) * lerp(1, l.key === 'payload>ramp' ? 1 : 0.45, push) * out).toFixed(3);
    if (thread) l.path.style.stroke = 'rgba(255,255,255,0.26)';
    const sp = staleK(t, l.key);
    if (sp >= 0.999) {
      l.chev.style.stroke = WARN;
      l.chev.style.opacity = '1';
      l.chev.style.strokeWidth = '1.3';
    } else l.chev.style.strokeWidth = '';
    if (out < 1) {
      l.chev.style.opacity = (parseFloat(l.chev.style.opacity) * out).toFixed(3);
      l.stale.style.opacity = (parseFloat(l.stale.style.opacity) * out).toFixed(3);
    }
    if (l.hs) {
      l.head.style.opacity = '0';
      const on = sp > 0 && sp < 1;
      l.hs.style.opacity = on ? out.toFixed(3) : '0';
      if (on) {
        // Inset by the round caps, so one sub-frame's stretch ends where the
        // next begins (no bright beads where they would overlap).
        const cap = 2.4 / l.len;
        let a = staleK(t - SUB, l.key) + cap;
        let b = sp - cap;
        if (b < a) a = b = (a + b) / 2;
        l.hs.style.strokeDasharray = `${Math.max(b - a, 1e-5).toFixed(5)} 2`;
        l.hs.style.strokeDashoffset = (-a).toFixed(5);
      }
    }
  }

  // Light riding the amber heads, then a spark where each one lands (screen space).
  // A head on amber it shares with a leader stays under the leader's light
  // (tray on the trunk), and shows from where it leaves it.
  const heads = [];
  for (const key of Object.keys(LEG)) {
    const sp = staleK(t, key);
    const spark = hit(t, LEG[key][1]);
    if (sp <= 0 || (sp >= 1 && spark < 0.03)) continue;
    const l = S.links[key];
    const d = Math.min(sp, 1) * l.len;
    const p = l.path.getPointAtLength(d);
    const [sx, sy, w] = project(M, p.x, p.y);
    const k = (c.s * Z) / w / 2.2;
    const u = (t - LEG[key][0]) / (LEG[key][1] - LEG[key][0]);
    const own = key === 'payload>tray' ? clamp((d - TRAY_FORK) / 40) : 1;
    if (sp < 1) heads.push([sx, sy, 0.7 + 0.5 * k, Math.sin(Math.PI * u) ** 0.5 * own]);
    else heads.push([sx, sy, (0.9 + 0.6 * k) * (1.25 - 0.25 * spark), spark]);
  }
  S.glows.forEach((g, i) => {
    const h = heads[i];
    if (!h || h[3] * (1 - clear) < 0.002) return (g.style.visibility = 'hidden');
    g.style.visibility = 'visible';
    g.style.transform = `translate3d(${h[0].toFixed(1)}px,${h[1].toFixed(1)}px,0) scale(${h[2].toFixed(3)})`;
    g.style.opacity = (h[3] * (1 - clear)).toFixed(3);
  });

  // The map's dot grid, projected (22 px cells), with depth of field; drawn in
  // a few alpha buckets so it costs a handful of fills.
  // Half resolution: the dots are background texture, and soft is right for them.
  const g = S.dots;
  g.setTransform(0.5, 0, 0, 0.5, 0, 0);
  g.clearRect(0, 0, W, H);
  const cell = 22;
  const buckets = Array.from({ length: 8 }, () => []);
  const x0 = Math.floor((c.tx - 1100) / cell) * cell;
  const y0 = Math.floor((c.ty - 760) / cell) * cell;
  for (let y = y0; y < c.ty + 760; y += cell) {
    for (let x = x0; x < c.tx + 1500; x += cell) {
      const [sx, sy, w] = project(M, x, y);
      if (w < 0.4 || sx < -10 || sx > W + 10 || sy < -10 || sy > H + 10) continue;
      const k = (c.s * Z) / w;
      const r = Math.max(1, 0.55 * k) + coc(w) * 0.5;
      const a = Math.min(1, (1.4 * k) / (r * 2)) * clamp(k / 1.2);
      const i = Math.min(7, Math.round(a * 7));
      if (i > 0) buckets[i].push(sx - r, sy - r, r * 2);
    }
  }
  g.fillStyle = '#ffffff';
  buckets.forEach((q, i) => {
    if (!q.length) return;
    g.globalAlpha = (0.075 * i) / 7;
    g.beginPath();
    for (let j = 0; j < q.length; j += 3) g.rect(q[j], q[j + 1], q[j + 2], q[j + 2]);
    g.fill();
  });
  g.globalAlpha = 1;
}

/* ------------------------------------------------------------------ */

function screenOf(v, ctx) {
  v.project(S.stage.camera);
  return [((v.x + 1) / 2) * ctx.W, ((1 - v.y) / 2) * ctx.H, v.z];
}

function renderRamp(t, ctx) {
  const { W } = ctx;
  const [az, el, dist, tx, ty, tz, fov] = track(t, CAM13[ctx.portrait ? 'port' : 'land']);
  const a = (az * Math.PI) / 180;
  const e = (el * Math.PI) / 180;
  const pos = [tx + Math.sin(a) * Math.cos(e) * dist, ty + Math.sin(e) * dist, tz + Math.cos(a) * Math.cos(e) * dist];
  // Raking light: eases in over the rover's front, climbs the slope, eases off.
  const sweep = lerp(40, X0 + RL + 240, ez(t, CUT, CUT + 0.96, E.sine));
  for (const m of S.rig.mats) m.uniforms.uSweep.value = sweep;
  S.stage.render({
    cam: { pos, target: [tx, ty, tz], fov },
    looks: { points: 0.62, edges: 0.2, solid: 0 },
    base: 0x7c8088,
    sweepX: sweep,
    sweepW: 45,
    // The parked rover only glints (its hot colour held at half white); the slope takes the light.
    glow: 0.35,
    partHot: () => 1e-3,
    hot: 0x8f9298,
    pointSize: 0.85,
    focus: Math.hypot(pos[0], pos[1] - 30, pos[2]),
    aperture: 3,
    groundAlpha: 0,
  });
  const v = S.v;
  const P = (x, y, z) => screenOf(v.set(x, y, z), ctx);
  const d = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('');
  const l = t - CUT;

  // "15°": an arc drawn in the near side face, from the floor up to the slope.
  const ka = ez(l, 0.12, 0.34, E.cubicInOut);
  const R = 120;
  const arc = [];
  for (let i = 0; i <= 24; i++) {
    const th = ANG * (i / 24) * ka;
    arc.push(P(X0 + Math.cos(th) * R, Math.sin(th) * R, ZW));
  }
  S.co.arc.setAttribute('d', ka > 0 ? d(arc) : '');
  const base = [P(X0, 0, ZW), P(X0 + R + 46, 0, ZW)];
  S.co.tick.setAttribute('d', ka > 0 ? d([base[0], [lerp(base[0][0], base[1][0], ka), lerp(base[0][1], base[1][1], ka)]]) : '');
  const [lx, ly] = P(X0 + Math.cos(ANG / 2) * (R + 34), Math.sin(ANG / 2) * (R + 34), ZW);
  // Beside the arc, or tucked inside it when the frame edge is near.
  const degX = lx + 8 + S.degW > W - 48 ? lx - 18 - S.degW : lx + 8;
  placeLabel(S.deg, degX, ly, ez(l, 0.25, 0.4, E.cubicOut), 'left');

  // "≥ 0.5 m/s": an arrow up the slope's centreline (the test's direction; the
  // rover stays put), ending on the slope short of the landing lip.
  const kw = ez(l, 0.375, 0.6, E.cubicInOut);
  const u0 = 90;
  const uEnd = 398;
  const u1 = lerp(u0, uEnd, kw);
  const up = (u) => P(X0 + u * Math.cos(ANG), u * Math.sin(ANG) + 3, -10);
  const p0 = up(u0);
  const p1 = up(u1);
  S.co.arr.setAttribute('d', kw > 0 ? d([p0, p1]) : '');
  const ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
  const ch = 13;
  S.co.ach.setAttribute(
    'd',
    kw > 0.05
      ? d([
          [p1[0] - Math.cos(ang - 0.55) * ch, p1[1] - Math.sin(ang - 0.55) * ch],
          p1,
          [p1[0] - Math.cos(ang + 0.55) * ch, p1[1] - Math.sin(ang + 0.55) * ch],
        ])
      : '',
  );
  // The value reads level, above the arrow's midpoint along its normal, clear of the line.
  const ma = up(u0);
  const mb = up(uEnd);
  const am = Math.atan2(mb[1] - ma[1], mb[0] - ma[0]);
  const nx = Math.sin(am);
  const ny = -Math.cos(am); // the upper side of an arrow climbing to the right
  const reach = 22 + (S.spdW / 2) * Math.abs(nx) + (S.spdH / 2) * Math.abs(ny);
  const mid = [(ma[0] + mb[0]) / 2 + nx * reach, (ma[1] + mb[1]) / 2 + ny * reach];
  placeLabel(S.spd, mid[0], mid[1], ez(l, 0.5, 0.64, E.cubicOut), 'center');

  // The label island: pinned to the ramp's far top edge (the landing's back lip,
  // 60 % across), resting above it, arriving from the map node's place.
  const anchor = P(S.rig.X2, RH, lerp(ZW, -ZW, 0.6));
  const restX = clamp(anchor[0] - 0.7 * S.isleW, 56, W - 56 - S.isleW);
  const restY = anchor[1] - (ctx.portrait ? 150 : 110) - S.isleH;
  // Where Ramp traverse with payload sat on the last frame of shot 12.
  const cEnd = cam12(CUT - 1e-4, ctx);
  const ME = worldMatrix(cEnd);
  const kN = (cEnd.s * Z) / project(ME, NODE.ramp.cx, NODE.ramp.cy)[2];
  const [gx, gy] = project(ME, NODE.ramp.x + S.nGlyph[0], NODE.ramp.y + S.nGlyph[1]);
  // The node's type size exactly: the island starts as the node, then grows into a label.
  const s0 = (16 * kN) / S.titleSize;
  // Hold the match briefly, then travel slowly enough (≤ ~33 px per 1/120 s) to
  // read as motion blur rather than stepped copies.
  const km = ez(l, 0.06, 0.62, E.sine);
  const sc = lerp(s0, 1, km);
  const gxNow = lerp(gx, restX + S.glyph[0], km);
  const gyNow = lerp(gy, restY + S.glyph[1], km);
  S.isle.style.transform = `translate3d(${(gxNow - S.glyph[0] * sc).toFixed(1)}px,${(gyNow - S.glyph[1] * sc).toFixed(1)}px,0) scale(${sc.toFixed(4)})`;
  // Its surface: the node's box (amber edge, warm fill) relaxing into an island's.
  const kb = ez(l, 0.08, 0.54, E.cubicInOut);
  const kr = ez(l, 0.44, 0.62, E.cubicInOut);
  const bx = S.box.node.map((n, i) => lerp(lerp(n, S.box.head[i], km), S.box.full[i], kr));
  // The node's 1 px border is inside its box, over its fill: an inset ring at
  // the match, handing over to the island's outer hairline.
  const ring = lerp(kN / s0, 1, kb);
  const fill = [lerp(34, 23, kb), lerp(29, 24, kb), lerp(21, 27, kb)];
  // The node's own glow on the cut frame, then the island's drop shadow.
  const glow = 0.15 + 0.35 * hit(CUT, ARRIVE.ramp);
  Object.assign(S.bg.style, {
    transform: `translate(${bx[0].toFixed(2)}px,${bx[1].toFixed(2)}px)`,
    width: `${bx[2].toFixed(2)}px`,
    height: `${bx[3].toFixed(2)}px`,
    borderRadius: `${bx[4].toFixed(2)}px`,
    background: `rgb(${fill.map((x) => x.toFixed(1)).join(',')})`,
    boxShadow:
      `inset 0 0 0 ${ring.toFixed(2)}px rgba(241,187,104,${(0.85 * (1 - kb)).toFixed(3)}),` +
      ` 0 0 0 1px rgba(255,255,255,${(0.12 * kb).toFixed(3)}),` +
      ` inset 0 1px 0 rgba(255,255,255,${(0.04 * kb).toFixed(3)}),` +
      ` 0 0 ${(30 * (kN / s0)).toFixed(1)}px rgba(241,187,104,${(glow * (1 - kb)).toFixed(3)}),` +
      ` 0 2px 6px -2px rgba(0,0,0,${(0.5 * kb).toFixed(3)}), 0 18px 48px -18px rgba(0,0,0,${(0.75 * kb).toFixed(3)})`,
  });
  // The state row starts on the node's, then settles into the island's grid.
  S.st.style.transform = `translate(${(S.stNudge[0] * (1 - km)).toFixed(2)}px,${(S.stNudge[1] * (1 - km)).toFixed(2)}px)`;
  const tc = lerp(212, 237, kb);
  S.title.style.color = `rgb(${tc.toFixed(1)},${(tc + 2 * (1 - kb)).toFixed(1)},${(tc + 6 * (1 - kb) + kb).toFixed(1)})`;
  // The expected line opens under the head (the island grows to hold it).
  // Held inside the growing box, so it is wiped in by the island, never spilling past it.
  S.r2.style.opacity = ez(l, 0.5, 0.64, E.cubicOut).toFixed(3);
  S.r2.style.transform = `translateY(${((1 - kr) * -8).toFixed(2)}px)`;
  const cr = Math.max(0, S.r2Box[0] + S.r2Box[2] - (bx[0] + bx[2] - 12));
  const cb = Math.max(0, S.r2Box[1] + S.r2Box[3] - (bx[1] + bx[3] - 6));
  S.r2.style.clipPath = cr > 0 || cb > 0 ? `inset(0 ${cr.toFixed(1)}px ${cb.toFixed(1)}px 0)` : 'none';
  // Leader from the island down to the landing lip.
  const kl = ez(l, 0.62, 0.78, E.cubicOut);
  const lx0 = clamp(anchor[0], restX + 40, restX + S.isleW - 40);
  const ly0 = restY + S.isleH + 2;
  const len = Math.hypot(anchor[0] - lx0, anchor[1] - ly0) * kl;
  const la = Math.atan2(anchor[1] - ly0, anchor[0] - lx0);
  S.lead.style.transform = `translate3d(${lx0.toFixed(1)}px,${ly0.toFixed(1)}px,0) rotate(${la.toFixed(4)}rad)`;
  S.lead.style.width = `${len.toFixed(1)}px`;
  S.lead.style.opacity = kl > 0 ? '0.8' : '0';
  S.pin.style.transform = `translate3d(${anchor[0].toFixed(1)}px,${anchor[1].toFixed(1)}px,0)`;
  S.pin.style.opacity = kl >= 1 ? '1' : '0';
}

function placeLabel(el, x, y, k, align) {
  el.style.opacity = k.toFixed(3);
  const dx = align === 'center' ? '-50%' : '0px';
  el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) translate(${dx},-50%) translateY(${((1 - k) * 8).toFixed(1)}px)`;
}
