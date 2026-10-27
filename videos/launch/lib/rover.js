// The Sable inspection rover, built procedurally from the fixture's parts
// (fixtures/rover): a laser-cut chassis plate, two micro metal gearmotors on
// 60 mm wheels (0.03 m loaded radius), a rear ball caster, a 2S LiPo, the Pi
// Zero 2 W with the DRV8835 beside it under the printed camera tray (62 × 44 mm,
// 2.5 mm plate, 12 mm walls) on M2.5 standoffs, and the Camera Module 3 Wide in
// the tray's front slot. Millimetres; X forward, Y up, Z to the right.
//
// One build serves every look: solid meshes, crisp edges, and a deterministic
// surface point cloud per part, each with an explode direction.
import * as THREE from 'three';
import { rng } from './core.js';

const PLATE_Y = 22; // top of the axle line sits at wheel radius; plate rides above it

/** Rounded rectangle shape in XY. */
function roundRect(w, h, r, cx = 0, cy = 0) {
  const s = new THREE.Shape();
  const x0 = cx - w / 2;
  const y0 = cy - h / 2;
  s.moveTo(x0 + r, y0);
  s.lineTo(x0 + w - r, y0);
  s.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
  s.lineTo(x0 + w, y0 + h - r);
  s.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
  s.lineTo(x0 + r, y0 + h);
  s.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r);
  s.lineTo(x0, y0 + r);
  s.quadraticCurveTo(x0, y0, x0 + r, y0);
  return s;
}

/** Extrude an XY shape (X → world X, Y → world Z) upward by h from y0. */
function slab(shape, h, y0, segs = 10) {
  const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: segs });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0, 0);
  return g;
}

function box(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

function cyl(r, h, x, y, z, axis = 'y', segs = 28) {
  const g = new THREE.CylinderGeometry(r, r, h, segs, 1);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

function merge(geoms) {
  // Minimal merge (non-indexed) so parts stay one mesh each.
  const parts = geoms.map((g) => (g.index ? g.toNonIndexed() : g));
  let n = 0;
  for (const g of parts) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, o);
    o += g.attributes.position.array.length;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.computeVertexNormals();
  return out;
}

/** Wheel: tyre with tread ribs, hub and spokes, axis along Z. */
function wheel(z) {
  const g = [];
  const tyre = new THREE.TorusGeometry(26.5, 3.6, 10, 48);
  tyre.scale(1, 1, 1.7);
  g.push(tyre);
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    const rib = new THREE.BoxGeometry(2.2, 1.6, 10);
    rib.translate(0, 29.4, 0);
    rib.rotateZ(a);
    g.push(rib);
  }
  const rim = new THREE.CylinderGeometry(23.5, 23.5, 7, 40, 1, true);
  rim.rotateX(Math.PI / 2);
  g.push(rim);
  g.push(cyl(6, 9, 0, 0, 0, 'z', 20));
  for (let i = 0; i < 5; i++) {
    const s = new THREE.BoxGeometry(3, 19, 2.4);
    s.translate(0, 13.5, 0);
    s.rotateZ((i / 5) * Math.PI * 2);
    g.push(s);
  }
  const m = merge(g);
  m.translate(30, 30, z);
  return m;
}

function gearmotor(z, side) {
  // Pololu micro metal gearmotor: 10 × 12 mm section, ~26 mm gearbox + can, D-shaft to the wheel.
  const g = [];
  g.push(box(26, 10, 12, 30, 30, z));
  g.push(cyl(5, 9, 30 - 17, 30, z, 'x', 20)); // motor can end
  g.push(cyl(1.5, 10, 30, 30, z + side * 9, 'z', 10)); // shaft
  g.push(box(16, 2, 16, 30, 36, z)); // bracket top
  g.push(box(2, 8, 16, 22, 32, z));
  g.push(box(2, 8, 16, 38, 32, z));
  return merge(g);
}

function piZero() {
  const g = [];
  g.push(box(65, 1.4, 30, -4, PLATE_Y + 3 + 6.7, 0));
  // SoC, RAM, connectors, header pads
  g.push(box(12, 1.6, 12, -2, PLATE_Y + 3 + 8.1, 2));
  g.push(box(8, 2.6, 6, -30, PLATE_Y + 3 + 8.7, -10));
  g.push(box(8, 2.6, 6, -18, PLATE_Y + 3 + 8.7, -10));
  for (let i = 0; i < 20; i++) g.push(box(1.6, 2.4, 1.6, -27 + i * 2.54, PLATE_Y + 3 + 8.6, 12.5));
  // standoffs
  for (const [x, z] of [[-33, -11.5], [25, -11.5], [-33, 11.5], [25, 11.5]]) g.push(cyl(1.6, 6, x, PLATE_Y + 3 + 3, z, 'y', 10));
  return merge(g);
}

function driver() {
  // DRV8835 carrier beside the Pi: a small board on short standoffs.
  const g = [box(13, 1.2, 15, 38, PLATE_Y + 3 + 4.6, -9)];
  g.push(box(4, 1.2, 4, 38, PLATE_Y + 3 + 5.6, -9));
  for (let i = 0; i < 6; i++) g.push(box(1.2, 2.2, 1.2, 33 + i * 2, PLATE_Y + 3 + 6, -2.5));
  return merge(g);
}

function regulator() {
  const g = [box(13, 1.2, 18, 38, PLATE_Y + 3 + 4.6, 11)];
  g.push(box(5, 2.4, 5, 38, PLATE_Y + 3 + 6.2, 11));
  return merge(g);
}

function battery() {
  // LiPo 2S 450 mAh: soft pack under the rear of the plate between the wheels.
  const g = [box(50, 14, 30, -10, PLATE_Y - 8, 0)];
  g.push(box(6, 3, 8, 17, PLATE_Y - 8, 8));
  return merge(g);
}

function caster() {
  const g = [cyl(7, 8, -44, 12, 0, 'y', 20)];
  const ball = new THREE.SphereGeometry(5.5, 18, 12);
  ball.translate(-44, 5.5, 0);
  g.push(ball);
  g.push(cyl(2.6, 10, -44, 17, 0, 'y', 10));
  return merge(g);
}

function chassis() {
  const s = roundRect(118, 86, 9);
  // Lightening slots and mounting holes in the laser-cut plate.
  const hole = (x, y, r) => {
    const h = new THREE.Path();
    h.absarc(x, y, r, 0, Math.PI * 2, true);
    s.holes.push(h);
  };
  for (const [x, y] of [[-52, -36], [52, -36], [-52, 36], [52, 36]]) hole(x, y, 1.6);
  for (let i = 0; i < 3; i++) {
    const p = roundRect(5, 22, 2.5, -48 + i * 9, 0);
    s.holes.push(new THREE.Path(p.getPoints(6)));
  }
  return slab(s, 3, PLATE_Y, 12);
}

const TRAY = { w: 62, d: 44, t: 2.5, wallH: 12, wallT: 2, slotW: 25, slotD: 9 };
const TRAY_Y = PLATE_Y + 3 + 16; // on 16 mm standoffs above the plate

function tray() {
  const { w, d, t, wallH, wallT, slotW, slotD } = TRAY;
  // Plate in XY with X = forward (depth) and Y = across (width).
  const s = new THREE.Shape();
  const x0 = -d / 2 + 4;
  const xf = x0 + d; // front edge
  const y0 = -w / 2;
  s.moveTo(x0, y0);
  s.lineTo(xf, y0);
  s.lineTo(xf, -slotW / 2);
  s.lineTo(xf - slotD, -slotW / 2);
  s.lineTo(xf - slotD, slotW / 2);
  s.lineTo(xf, slotW / 2);
  s.lineTo(xf, -y0);
  s.lineTo(x0, -y0);
  s.closePath();
  for (const x of [x0 + 4, xf - 4]) for (const y of [y0 + 4, -y0 - 4]) {
    const h = new THREE.Path();
    h.absarc(x, y, 1.25, 0, Math.PI * 2, true);
    s.holes.push(h);
  }
  const g = [slab(s, t, TRAY_Y, 16)];
  // Side walls along X at both edges, and a rear wall.
  g.push(box(d, wallH, wallT, x0 + d / 2, TRAY_Y + t + wallH / 2, y0 + wallT / 2));
  g.push(box(d, wallH, wallT, x0 + d / 2, TRAY_Y + t + wallH / 2, -y0 - wallT / 2));
  g.push(box(wallT, wallH, w, x0 + wallT / 2, TRAY_Y + t + wallH / 2, 0));
  for (const x of [x0 + 4, xf - 4]) for (const z of [y0 + 4, -y0 - 4]) g.push(cyl(2.2, 16, x, PLATE_Y + 3 + 8, z, 'y', 12));
  return merge(g);
}

function camera() {
  // Camera Module 3 Wide: 25 × 24 mm board, lens barrel facing forward, in the tray's slot.
  const xf = -TRAY.d / 2 + 4 + TRAY.d;
  const g = [box(1.2, 24, 25, xf - 4.5, TRAY_Y + 12, 0)];
  g.push(box(6, 8.5, 8.5, xf - 1.5, TRAY_Y + 13, 0));
  g.push(cyl(3.6, 5, xf + 3, TRAY_Y + 13, 0, 'x', 24));
  g.push(box(10, 0.4, 16, xf - 10, TRAY_Y + 1, 0)); // ribbon
  return merge(g);
}

/** Facts on screen come from the fixture; null means the record says Unknown. */
export const PART_INFO = {
  chassis: { title: 'Chassis plate', sub: 'laser-cut · structure', value: '0.12', unit: 'kg' },
  tray: { title: 'Camera tray', sub: 'printed PLA · r2', value: '62 × 44', unit: 'mm' },
  camera: { title: 'Camera Module 3 Wide', sub: 'Raspberry Pi', value: null, unit: '' },
  pi: { title: 'Raspberry Pi Zero 2 W', sub: '5 V · compute', value: '0.011', unit: 'kg' },
  driver: { title: 'DRV8835 driver', sub: 'dual motor carrier', value: '2–11', unit: 'V' },
  regulator: { title: 'D24V22F5 regulator', sub: 'step-down', value: '5', unit: 'V' },
  battery: { title: 'LiPo 2S 450 mAh', sub: '30C pack', value: '0.04', unit: 'kg' },
  motorL: { title: 'Gearmotor HP 6V 100:1', sub: 'Pololu micro metal', value: '6', unit: 'V' },
  motorR: { title: 'Gearmotor HP 6V 100:1', sub: 'Pololu micro metal', value: '6', unit: 'V' },
  wheelL: { title: 'Wheel, 60 mm', sub: 'loaded radius', value: '0.03', unit: 'm' },
  wheelR: { title: 'Wheel, 60 mm', sub: 'loaded radius', value: '0.03', unit: 'm' },
  caster: { title: 'Ball caster', sub: 'rear support', value: null, unit: '' },
};

/** Sample n points on a geometry's surface, area-weighted and deterministic. */
function samplePoints(geom, n, seed) {
  const pos = geom.attributes.position.array;
  const tris = pos.length / 9;
  const areas = new Float32Array(tris);
  let total = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let i = 0; i < tris; i++) {
    a.fromArray(pos, i * 9);
    b.fromArray(pos, i * 9 + 3);
    c.fromArray(pos, i * 9 + 6);
    total += b.sub(a).cross(c.sub(a)).length() / 2;
    areas[i] = total;
  }
  const r = rng(seed);
  const out = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) {
    const x = r() * total;
    let lo = 0;
    let hi = tris - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (areas[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    let u = r();
    let v = r();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    for (let j = 0; j < 3; j++) {
      const p0 = pos[lo * 9 + j];
      const p1 = pos[lo * 9 + 3 + j];
      const p2 = pos[lo * 9 + 6 + j];
      out[k * 3 + j] = p0 + (p1 - p0) * u + (p2 - p0) * v;
    }
  }
  return out;
}

/**
 * Build the rover's parts. Each part: { id, info, geom, edges, points, center,
 * explode } — explode is the direction (mm at k = 1) the part travels in an
 * exploded view.
 */
export function buildRover({ pointsPerMm2 = 0.09, minPoints = 260 } = {}) {
  const defs = [
    ['chassis', chassis(), [0, 0, 0]],
    ['battery', battery(), [0, -46, 0]],
    ['caster', caster(), [-30, -64, 0]],
    ['motorL', gearmotor(-30, -1), [12, -34, -40]],
    ['motorR', gearmotor(30, 1), [12, -34, 40]],
    ['wheelL', wheel(-49), [0, 0, -78]],
    ['wheelR', wheel(49), [0, 0, 78]],
    ['pi', piZero(), [-6, 34, 0]],
    ['driver', driver(), [30, 44, -34]],
    ['regulator', regulator(), [30, 44, 34]],
    ['tray', tray(), [0, 88, 0]],
    ['camera', camera(), [56, 104, 0]],
  ];
  const parts = defs.map(([id, geom, ex], i) => {
    geom.computeBoundingBox();
    const center = geom.boundingBox.getCenter(new THREE.Vector3());
    let area = 0;
    const pos = geom.attributes.position.array;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (let k = 0; k < pos.length; k += 9) {
      a.fromArray(pos, k);
      b.fromArray(pos, k + 3);
      c.fromArray(pos, k + 6);
      area += b.sub(a).cross(c.sub(a)).length() / 2;
    }
    const n = Math.max(minPoints, Math.round(area * pointsPerMm2));
    return {
      id,
      info: PART_INFO[id],
      geom,
      edges: new THREE.EdgesGeometry(geom, 24),
      points: samplePoints(geom, n, 1000 + i * 97),
      center,
      explode: new THREE.Vector3(...ex),
    };
  });
  const bounds = new THREE.Box3();
  for (const p of parts) bounds.union(p.geom.boundingBox);
  return { parts, bounds, plateY: PLATE_Y, trayY: TRAY_Y };
}

/** Standard renderer for a film canvas: transparent, deterministic, no DPR scaling. */
export function filmRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(canvas.width, canvas.height, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

/** Round soft sprite for point clouds (white disc, feathered edge). */
export function dotTexture(size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.9)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
