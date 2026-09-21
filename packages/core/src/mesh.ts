/**
 * Deterministic triangle-mesh analysis for CAD verification.
 *
 * Everything here is pure geometry on an STL triangle soup: bounding box,
 * volume, surface area, watertightness, connected shells, point containment,
 * planar cross-sections with loop extraction and circle recognition. It is the
 * measurement layer the agent harness uses so the language model never has
 * to guess dimensions from a picture or a bounding box.
 *
 * Coordinates are whatever the STL carries (OpenSCAD: model units, mm by
 * convention). No unit conversion happens here.
 */

import { Worker } from 'node:worker_threads';
import { ErrorCodes, OmenflowError, type OmenflowErrorBody } from '@omenflow/contracts';

/** Supported synchronous V0.1 mesh budget; 6 MB remains below 8 MiB after base64. */
export const MAX_CAD_MESH_BYTES = 6_000_000;
export const MAX_CAD_TRIANGLES = 100_000;
export const MAX_INTERSECTION_PAIRS = 8_000_000;
export const MAX_INTERSECTION_OVERLAP_PAIRS = 100_000;
export const MAX_CAD_CHECK_TRIANGLE_VISITS = 10_000_000;
export const MAX_CAD_CHECK_ASSERTIONS = 512;

export function meshWorkLimit(operation: string, actual: number, limit: number): never {
  throw new OmenflowError(
    ErrorCodes.VALIDATION,
    `${operation} exceeds the supported V0.1 work limit (${actual} > ${limit})`,
    {
      details: { reason: 'CAD_WORK_LIMIT', operation, actual, limit, status: 'not_evaluated' },
      repair:
        'Reduce tessellation, split the part/check into smaller supported operations, or omit this check while keeping its coverage explicitly unverified.',
    },
  );
}

export function assertMeshByteLimit(bytes: number): void {
  if (bytes > MAX_CAD_MESH_BYTES) meshWorkLimit('STL byte size', bytes, MAX_CAD_MESH_BYTES);
}

export function assertTriangleLimit(tris: Float64Array): void {
  if (tris.length % 9)
    throw new OmenflowError(ErrorCodes.VALIDATION, 'Triangle buffer has incomplete vertices');
  if (tris.length / 9 > MAX_CAD_TRIANGLES)
    meshWorkLimit('Mesh triangles', tris.length / 9, MAX_CAD_TRIANGLES);
}

export function assertFiniteMesh(tris: Float64Array): void {
  assertTriangleLimit(tris);
  if (tris.some((value) => !Number.isFinite(value)))
    throw new OmenflowError(ErrorCodes.VALIDATION, 'STL contains non-finite coordinates');
}

/** Requested inspection work plus at most five automatic section planes. */
export function assertCadInspectionBudget(
  tris: Float64Array,
  probes: number,
  sections: number,
): void {
  assertTriangleLimit(tris);
  const count = probes + sections;
  if (count > MAX_CAD_CHECK_ASSERTIONS)
    meshWorkLimit('CAD inspection probes/sections', count, MAX_CAD_CHECK_ASSERTIONS);
  const visits = (tris.length / 9) * (probes + (sections + 5) * 2);
  if (visits > MAX_CAD_CHECK_TRIANGLE_VISITS)
    meshWorkLimit('CAD inspection triangle visits', visits, MAX_CAD_CHECK_TRIANGLE_VISITS);
}

export function assertIntersectionBudget(tris: Float64Array): void {
  assertTriangleLimit(tris);
  const n = tris.length / 9;
  const pairs = (n * (n - 1)) / 2;
  if (pairs > MAX_INTERSECTION_PAIRS)
    meshWorkLimit('Self-intersection candidate pairs', pairs, MAX_INTERSECTION_PAIRS);
}

export type Vec3 = [number, number, number];
export type Axis = 'x' | 'y' | 'z';

/** Flat triangle buffer: 9 numbers per triangle (ax ay az bx by bz cx cy cz). */
export type TriangleBuffer = Float64Array;

const AXIS_INDEX: Record<Axis, number> = { x: 0, y: 1, z: 2 };

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

export function parseStlTriangles(buf: Buffer): TriangleBuffer {
  assertMeshByteLimit(buf.byteLength);
  if (buf.byteLength >= 84) {
    const count = buf.readUInt32LE(80);
    if (84 + count * 50 === buf.byteLength) {
      if (count > MAX_CAD_TRIANGLES) meshWorkLimit('Mesh triangles', count, MAX_CAD_TRIANGLES);
      const out = new Float64Array(count * 9);
      for (let i = 0; i < count; i++) {
        const base = 84 + i * 50 + 12;
        for (let k = 0; k < 9; k++) {
          const value = buf.readFloatLE(base + k * 4);
          if (!Number.isFinite(value))
            throw new OmenflowError(ErrorCodes.VALIDATION, 'STL contains non-finite coordinates');
          out[i * 9 + k] = value;
        }
      }
      return out;
    }
  }
  const text = buf.toString('utf8');
  const vals: number[] = [];
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (vals.length + 3 > MAX_CAD_TRIANGLES * 9)
      meshWorkLimit('Mesh triangles', (vals.length + 3) / 9, MAX_CAD_TRIANGLES);
    const vertex = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (vertex.some((value) => !Number.isFinite(value)))
      throw new OmenflowError(ErrorCodes.VALIDATION, 'STL contains non-finite coordinates');
    vals.push(...vertex);
  }
  if (vals.length % 9)
    throw new OmenflowError(ErrorCodes.VALIDATION, 'ASCII STL contains an incomplete triangle');
  return Float64Array.from(vals);
}

export function triangleCount(tris: TriangleBuffer): number {
  return tris.length / 9;
}

/* ------------------------------------------------------------------ */
/* Global properties                                                   */
/* ------------------------------------------------------------------ */

export interface MeshBounds {
  min: Vec3;
  max: Vec3;
  size: Vec3;
  center: Vec3;
}

export function bounds(tris: TriangleBuffer): MeshBounds {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = tris[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  if (tris.length === 0)
    return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] };
  const size: Vec3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const center: Vec3 = [(max[0] + min[0]) / 2, (max[1] + min[1]) / 2, (max[2] + min[2]) / 2];
  return { min, max, size, center };
}

/** Signed volume via divergence theorem. Negative → inward-facing normals. */
export function signedVolume(tris: TriangleBuffer): number {
  let v = 0;
  for (let i = 0; i < tris.length; i += 9) {
    const ax = tris[i]!,
      ay = tris[i + 1]!,
      az = tris[i + 2]!;
    const bx = tris[i + 3]!,
      by = tris[i + 4]!,
      bz = tris[i + 5]!;
    const cx = tris[i + 6]!,
      cy = tris[i + 7]!,
      cz = tris[i + 8]!;
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

export function surfaceArea(tris: TriangleBuffer): number {
  let s = 0;
  for (let i = 0; i < tris.length; i += 9) {
    const ux = tris[i + 3]! - tris[i]!,
      uy = tris[i + 4]! - tris[i + 1]!,
      uz = tris[i + 5]! - tris[i + 2]!;
    const vx = tris[i + 6]! - tris[i]!,
      vy = tris[i + 7]! - tris[i + 1]!,
      vz = tris[i + 8]! - tris[i + 2]!;
    const cx = uy * vz - uz * vy,
      cy = uz * vx - ux * vz,
      cz = ux * vy - uy * vx;
    s += Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
  }
  return s;
}

const QUANT = 1e-5;
function vkey(x: number, y: number, z: number): string {
  return `${Math.round(x / QUANT)},${Math.round(y / QUANT)},${Math.round(z / QUANT)}`;
}

export interface TopologyReport {
  /** Edges used by exactly one triangle (holes in the surface). */
  boundaryEdges: number;
  /** Edges used by more than two triangles (self-touching / non-manifold). */
  nonManifoldEdges: number;
  /** Every edge shared by exactly two triangles with opposite direction. */
  watertight: boolean;
  /** Number of disconnected shells (bodies sharing no vertex). */
  shells: number;
  degenerateTriangles: number;
}

export function topology(tris: TriangleBuffer): TopologyReport {
  assertFiniteMesh(tris);
  const n = triangleCount(tris);
  const ids = new Map<string, number>();
  const idOf = (x: number, y: number, z: number): number => {
    const k = vkey(x, y, z);
    let id = ids.get(k);
    if (id === undefined) {
      id = ids.size;
      ids.set(k, id);
    }
    return id;
  };
  const triIds = new Int32Array(n * 3);
  let degenerate = 0;
  for (let t = 0; t < n; t++) {
    const b = t * 9;
    const a = idOf(tris[b]!, tris[b + 1]!, tris[b + 2]!);
    const bb = idOf(tris[b + 3]!, tris[b + 4]!, tris[b + 5]!);
    const c = idOf(tris[b + 6]!, tris[b + 7]!, tris[b + 8]!);
    triIds[t * 3] = a;
    triIds[t * 3 + 1] = bb;
    triIds[t * 3 + 2] = c;
    if (a === bb || bb === c || a === c) degenerate++;
  }
  // Directed edge counts.
  const directed = new Map<string, number>();
  for (let t = 0; t < n; t++) {
    const a = triIds[t * 3]!,
      b = triIds[t * 3 + 1]!,
      c = triIds[t * 3 + 2]!;
    if (a === b || b === c || a === c) continue;
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const k = `${u}>${v}`;
      directed.set(k, (directed.get(k) ?? 0) + 1);
    }
  }
  let boundary = 0;
  let nonManifold = 0;
  const seen = new Set<string>();
  for (const [k, cnt] of directed) {
    const [u, v] = k.split('>');
    const uk = Number(u) < Number(v) ? `${u}|${v}` : `${v}|${u}`;
    if (seen.has(uk)) continue;
    seen.add(uk);
    const rev = directed.get(`${v}>${u}`) ?? 0;
    const total = cnt + rev;
    if (total === 1) boundary++;
    else if (total > 2 || cnt > 1 || rev > 1) nonManifold++;
  }
  // Connected shells via union-find on vertex ids.
  const parent = new Int32Array(ids.size);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let t = 0; t < n; t++) {
    union(triIds[t * 3]!, triIds[t * 3 + 1]!);
    union(triIds[t * 3 + 1]!, triIds[t * 3 + 2]!);
  }
  const roots = new Set<number>();
  for (let i = 0; i < parent.length; i++) roots.add(find(i));
  return {
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
    watertight: boundary === 0 && nonManifold === 0 && n > 0,
    shells: n === 0 ? 0 : roots.size,
    degenerateTriangles: degenerate,
  };
}

/* ------------------------------------------------------------------ */
/* Point containment                                                   */
/* ------------------------------------------------------------------ */

/** Möller–Trumbore ray/triangle; returns t or null. */
function rayTri(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  tris: TriangleBuffer,
  i: number,
): number | null {
  const ax = tris[i]!,
    ay = tris[i + 1]!,
    az = tris[i + 2]!;
  const e1x = tris[i + 3]! - ax,
    e1y = tris[i + 4]! - ay,
    e1z = tris[i + 5]! - az;
  const e2x = tris[i + 6]! - ax,
    e2y = tris[i + 7]! - ay,
    e2z = tris[i + 8]! - az;
  const px = dy * e2z - dz * e2y,
    py = dz * e2x - dx * e2z,
    pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const tx = ox - ax,
    ty = oy - ay,
    tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return null;
  const qx = ty * e1z - tz * e1y,
    qy = tz * e1x - tx * e1z,
    qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > 1e-9 ? t : null;
}

const RAY_DIRS: Vec3[] = [
  [0.577350269, 0.577350269, 0.577350269],
  [-0.267261242, 0.534522484, 0.801783726],
  [0.801783726, -0.267261242, -0.534522484],
  [-0.40824829, -0.816496581, 0.40824829],
  [0.301511345, -0.904534034, 0.301511345],
];

/**
 * Inside/outside test by ray-parity, majority over five irrational-ish
 * directions so edge/vertex grazing does not flip the answer.
 */
export function containsPoint(tris: TriangleBuffer, p: Vec3): boolean {
  let inside = 0;
  for (const d of RAY_DIRS) {
    const distances: number[] = [];
    for (let i = 0; i < tris.length; i += 9) {
      const distance = rayTri(p[0], p[1], p[2], d[0], d[1], d[2], tris, i);
      if (distance !== null) distances.push(distance);
    }
    // A face diagonal/vertex belongs to several triangles, but is one surface
    // crossing. Counting triangles makes cavity classification depend on how
    // the exporter triangulated coplanar faces. Keep distinct thin-wall sides.
    distances.sort((a, b) => a - b);
    let hits = 0;
    let previous = -Infinity;
    for (const distance of distances) {
      const epsilon = Math.max(1e-8, 16 * Number.EPSILON * Math.abs(distance));
      if (distance - previous > epsilon) {
        hits++;
        previous = distance;
      }
    }
    if (hits % 2 === 1) inside++;
  }
  return inside > RAY_DIRS.length / 2;
}

/* ------------------------------------------------------------------ */
/* Cross-sections                                                      */
/* ------------------------------------------------------------------ */

export interface CircleFit {
  center: [number, number];
  /** Radius of the circumscribed circle (polygon vertices lie on the true circle in OpenSCAD). */
  radius: number;
  minRadius: number;
  maxRadius: number;
  /** minRadius / maxRadius — 1 for a perfect circle; low values mean coarse faceting. */
  roundness: number;
}

export interface SectionLoop {
  /** 2-D points in the section plane, ordered. Axes are the two non-section axes in x,y,z order. */
  points: [number, number][];
  /** Absolute enclosed area. */
  area: number;
  centroid: [number, number];
  bbox: { min: [number, number]; max: [number, number]; size: [number, number] };
  /** Nesting depth: 0 = outer boundary of material, 1 = hole inside it, 2 = island inside a hole… */
  depth: number;
  /** True when the loop bounds empty space (odd depth). */
  isHole: boolean;
  /** Set when the loop is well approximated by a circle. */
  circle: CircleFit | null;
  /** Set when the loop is an axis-aligned rectangle (within tolerance). */
  rectangle: { size: [number, number]; center: [number, number] } | null;
}

export interface CrossSection {
  axis: Axis;
  at: number;
  /** The two in-plane axes in order, e.g. ['x','y'] for axis 'z'. */
  planeAxes: [Axis, Axis];
  loops: SectionLoop[];
  /** Net material area in the plane. */
  materialArea: number;
  openChains: number;
  origin?: Vec3;
  normal?: Vec3;
}

function polygonArea(pts: [number, number][]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]!;
    const [x2, y2] = pts[(i + 1) % pts.length]!;
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

function pointInPolygon(pt: [number, number], poly: [number, number][]): boolean {
  let inside = false;
  const [x, y] = pt;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function fitCircle(pts: [number, number][], centroid: [number, number]): CircleFit | null {
  if (pts.length < 5) return null;
  // maxR: farthest vertex (polygon vertices sit on the true circle in OpenSCAD).
  // minR: closest approach of any edge (the apothem) — captures faceting.
  let minR = Infinity;
  let maxR = 0;
  const [cx, cy] = centroid;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]!;
    const [x2, y2] = pts[(i + 1) % pts.length]!;
    const r = Math.hypot(x1 - cx, y1 - cy);
    if (r > maxR) maxR = r;
    const dx = x2 - x1,
      dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((cx - x1) * dx + (cy - y1) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(x1 + t * dx - cx, y1 + t * dy - cy);
    if (d < minR) minR = d;
  }
  const roundness = maxR > 0 ? minR / maxR : 0;
  // Reject shapes that are clearly not circles (a square scores ≈ 0.707).
  if (roundness < 0.75) return null;
  return {
    center: [round(centroid[0]), round(centroid[1])],
    radius: round(maxR),
    minRadius: round(minR),
    maxRadius: round(maxR),
    roundness: Math.round(roundness * 1000) / 1000,
  };
}

function fitRectangle(
  pts: [number, number][],
  area: number,
): { size: [number, number]; center: [number, number] } | null {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (w <= 0 || h <= 0) return null;
  if (Math.abs(area - w * h) / (w * h) > 0.01) return null;
  return {
    size: [round(w), round(h)],
    center: [round((minX + maxX) / 2), round((minY + maxY) / 2)],
  };
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Remove vertices that lie on the straight line between their neighbours (triangulation artefacts). */
function dropCollinear(pts: [number, number][]): [number, number][] {
  if (pts.length < 4) return pts;
  const out: [number, number][] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n]!;
    const c = pts[i]!;
    const q = pts[(i + 1) % n]!;
    const cross = (c[0] - p[0]) * (q[1] - c[1]) - (c[1] - p[1]) * (q[0] - c[0]);
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len > 0 && Math.abs(cross) / len < 1e-6) continue;
    out.push(c);
  }
  return out.length >= 3 ? out : pts;
}

/**
 * Slice the mesh with the plane `axis = at` and return closed loops with
 * nesting, area, centroid, and circle/rectangle recognition.
 */
export function crossSection(tris: TriangleBuffer, axis: Axis, at: number): CrossSection {
  assertFiniteMesh(tris);
  const k = AXIS_INDEX[axis];
  const [u, v] = [0, 1, 2].filter((i) => i !== k) as [number, number];
  const planeAxes: [Axis, Axis] = [
    (['x', 'y', 'z'] as Axis[])[u]!,
    (['x', 'y', 'z'] as Axis[])[v]!,
  ];
  // Nudge off exact vertex planes to avoid degenerate coplanar faces.
  let plane = at;
  for (let i = k; i < tris.length; i += 3) {
    if (Math.abs(tris[i]! - plane) < 1e-9) {
      plane = at + 1e-6;
      break;
    }
  }

  type Seg = { a: [number, number]; b: [number, number] };
  const segs: Seg[] = [];
  for (let i = 0; i < tris.length; i += 9) {
    const pts: [number, number][] = [];
    for (let e = 0; e < 3; e++) {
      const p = i + e * 3;
      const q = i + ((e + 1) % 3) * 3;
      const pa = tris[p + k]! - plane;
      const qa = tris[q + k]! - plane;
      if ((pa > 0 && qa > 0) || (pa < 0 && qa < 0) || pa === qa) continue;
      const t = pa / (pa - qa);
      pts.push([
        tris[p + u]! + t * (tris[q + u]! - tris[p + u]!),
        tris[p + v]! + t * (tris[q + v]! - tris[p + v]!),
      ]);
    }
    if (pts.length === 2) {
      const [a, b] = pts as [[number, number], [number, number]];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-9) segs.push({ a, b });
    }
  }

  const built = loopsFromSegments(segs);
  return { axis, at, planeAxes, ...built };
}

type Seg2 = { a: [number, number]; b: [number, number] };

function loopsFromSegments(segs: Seg2[]): {
  loops: SectionLoop[];
  materialArea: number;
  openChains: number;
} {
  const Q = 1e-6;
  const key = (p: [number, number]) => `${Math.round(p[0] / Q)},${Math.round(p[1] / Q)}`;
  const byStart = new Map<string, number[]>();
  segs.forEach((s, idx) => {
    for (const kk of [key(s.a), key(s.b)]) {
      const arr = byStart.get(kk) ?? [];
      arr.push(idx);
      byStart.set(kk, arr);
    }
  });
  const used = new Uint8Array(segs.length);
  const loops: [number, number][][] = [];
  let openChains = 0;
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const chain: [number, number][] = [segs[s]!.a, segs[s]!.b];
    let cur = segs[s]!.b;
    const startKey = key(segs[s]!.a);
    let closed = false;
    for (let guard = 0; guard < segs.length + 1; guard++) {
      const ck = key(cur);
      if (ck === startKey) {
        closed = true;
        break;
      }
      const cands = (byStart.get(ck) ?? []).filter((i) => !used[i]);
      if (cands.length === 0) break;
      const ni = cands[0]!;
      used[ni] = 1;
      const seg = segs[ni]!;
      cur = key(seg.a) === ck ? seg.b : seg.a;
      chain.push(cur);
    }
    if (closed) {
      chain.pop();
      const simplified = dropCollinear(chain);
      if (simplified.length >= 3) loops.push(simplified);
    } else {
      openChains++;
    }
  }

  const out: SectionLoop[] = loops.map((pts) => {
    const signed = polygonArea(pts);
    const area = Math.abs(signed);
    let cx = 0,
      cy = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i]!;
      const [x2, y2] = pts[(i + 1) % pts.length]!;
      const f = x1 * y2 - x2 * y1;
      cx += (x1 + x2) * f;
      cy += (y1 + y2) * f;
    }
    const centroid: [number, number] =
      Math.abs(signed) > 1e-12 ? [cx / (6 * signed), cy / (6 * signed)] : [pts[0]![0], pts[0]![1]];
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return {
      points: pts,
      area,
      centroid: [round(centroid[0]), round(centroid[1])],
      bbox: {
        min: [round(minX), round(minY)],
        max: [round(maxX), round(maxY)],
        size: [round(maxX - minX), round(maxY - minY)],
      },
      depth: 0,
      isHole: false,
      circle: fitCircle(pts, centroid),
      rectangle: fitRectangle(pts, area),
    };
  });
  for (let i = 0; i < out.length; i++) {
    let depth = 0;
    const probe = out[i]!.points[0]!;
    for (let j = 0; j < out.length; j++) {
      if (i === j) continue;
      if (out[j]!.area <= out[i]!.area) continue;
      if (pointInPolygon(probe, out[j]!.points)) depth++;
    }
    out[i]!.depth = depth;
    out[i]!.isHole = depth % 2 === 1;
  }
  let materialArea = 0;
  for (const l of out) materialArea += l.isHole ? -l.area : l.area;
  out.sort((a, b) => a.depth - b.depth || b.area - a.area);
  return { loops: out, materialArea: round(materialArea), openChains };
}

function norm3(v: Vec3): Vec3 {
  const L = Math.hypot(v[0], v[1], v[2]);
  return L > 0 ? [v[0] / L, v[1] / L, v[2] / L] : [0, 0, 1];
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Orthonormal plane basis. Axis-aligned normals match `crossSection` planeAxes. */
function planeBasis(n: Vec3): { u: Vec3; v: Vec3 } {
  const ax = Math.abs(n[0]),
    ay = Math.abs(n[1]),
    az = Math.abs(n[2]);
  if (az > 0.999 && ax < 1e-6 && ay < 1e-6) {
    return n[2] >= 0 ? { u: [1, 0, 0], v: [0, 1, 0] } : { u: [1, 0, 0], v: [0, -1, 0] };
  }
  if (ay > 0.999 && ax < 1e-6 && az < 1e-6) {
    return n[1] >= 0 ? { u: [1, 0, 0], v: [0, 0, 1] } : { u: [1, 0, 0], v: [0, 0, -1] };
  }
  if (ax > 0.999 && ay < 1e-6 && az < 1e-6) {
    return n[0] >= 0 ? { u: [0, 1, 0], v: [0, 0, 1] } : { u: [0, 1, 0], v: [0, 0, -1] };
  }
  const helper: Vec3 = ay < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm3(cross3(helper, n));
  return { u, v: cross3(n, u) };
}

/**
 * Slice the mesh with an arbitrary plane through `origin` with `normal`.
 * Axis-aligned normals reproduce `crossSection` loop geometry.
 */
export function crossSectionPlane(tris: TriangleBuffer, origin: Vec3, normal: Vec3): CrossSection {
  assertFiniteMesh(tris);
  const n = norm3(normal);
  let ox = origin[0],
    oy = origin[1],
    oz = origin[2];
  for (let i = 0; i < tris.length; i += 3) {
    const d = (tris[i]! - ox) * n[0] + (tris[i + 1]! - oy) * n[1] + (tris[i + 2]! - oz) * n[2];
    if (Math.abs(d) < 1e-9) {
      ox += n[0] * 1e-6;
      oy += n[1] * 1e-6;
      oz += n[2] * 1e-6;
      break;
    }
  }
  const { u, v } = planeBasis(n);
  const segs: Seg2[] = [];
  for (let i = 0; i < tris.length; i += 9) {
    const pts: [number, number][] = [];
    for (let e = 0; e < 3; e++) {
      const p = i + e * 3;
      const q = i + ((e + 1) % 3) * 3;
      const pa = (tris[p]! - ox) * n[0] + (tris[p + 1]! - oy) * n[1] + (tris[p + 2]! - oz) * n[2];
      const qa = (tris[q]! - ox) * n[0] + (tris[q + 1]! - oy) * n[1] + (tris[q + 2]! - oz) * n[2];
      if ((pa > 0 && qa > 0) || (pa < 0 && qa < 0) || pa === qa) continue;
      const t = pa / (pa - qa);
      const ix = tris[p]! + t * (tris[q]! - tris[p]!);
      const iy = tris[p + 1]! + t * (tris[q + 1]! - tris[p + 1]!);
      const iz = tris[p + 2]! + t * (tris[q + 2]! - tris[p + 2]!);
      pts.push([
        (ix - ox) * u[0] + (iy - oy) * u[1] + (iz - oz) * u[2],
        (ix - ox) * v[0] + (iy - oy) * v[1] + (iz - oz) * v[2],
      ]);
    }
    if (pts.length === 2) {
      const [a, b] = pts as [[number, number], [number, number]];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-9) segs.push({ a, b });
    }
  }
  const built = loopsFromSegments(segs);
  let axis: Axis = 'z';
  let at = origin[2];
  let planeAxes: [Axis, Axis] = ['x', 'y'];
  if (Math.abs(n[2]) > 0.999) {
    axis = 'z';
    at = origin[2];
    planeAxes = ['x', 'y'];
  } else if (Math.abs(n[1]) > 0.999) {
    axis = 'y';
    at = origin[1];
    planeAxes = ['x', 'z'];
  } else if (Math.abs(n[0]) > 0.999) {
    axis = 'x';
    at = origin[0];
    planeAxes = ['y', 'z'];
  }
  return { axis, at, planeAxes, origin, normal: n, ...built };
}

/* ------------------------------------------------------------------ */
/* Convenience: full report                                            */
/* ------------------------------------------------------------------ */

export interface MeshReport {
  triangles: number;
  bounds: MeshBounds;
  volume: number;
  surfaceArea: number;
  /** True when the signed volume is negative (inside-out normals). */
  invertedNormals: boolean;
  topology: TopologyReport;
}

export function analyzeMesh(tris: TriangleBuffer): MeshReport {
  assertFiniteMesh(tris);
  const sv = signedVolume(tris);
  return {
    triangles: triangleCount(tris),
    bounds: bounds(tris),
    volume: Math.abs(sv),
    surfaceArea: surfaceArea(tris),
    invertedNormals: sv < 0,
    topology: topology(tris),
  };
}

/** Small fixtures stay in-process; larger or cancellable work uses a worker. */
export const MESH_WORKER_MIN_TRIANGLES = 2_500;

export async function analyzeMeshCancellable(
  tris: TriangleBuffer,
  signal?: AbortSignal,
): Promise<MeshReport> {
  if (signal?.aborted) throw new OmenflowError(ErrorCodes.CANCELLED, 'Mesh analysis was cancelled');
  if (!signal && triangleCount(tris) < MESH_WORKER_MIN_TRIANGLES) return analyzeMesh(tris);
  return runMeshTask<MeshReport>({ operation: 'analyze', tris }, signal);
}

/** Pure geometry jobs share the packaged worker; no synchronous failure fallback. */
export function runMeshTask<T>(data: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(new URL('./mesh-worker.mjs', import.meta.url), {
        workerData: data,
      });
    } catch (error) {
      if (signal?.aborted)
        return reject(new OmenflowError(ErrorCodes.CANCELLED, 'Mesh analysis was cancelled'));
      return reject(OmenflowError.from(error));
    }
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      fn();
    };
    const onAbort = () =>
      done(() => reject(new OmenflowError(ErrorCodes.CANCELLED, 'Mesh analysis was cancelled')));
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    worker.once('message', (message: { ok?: boolean; report?: T; error?: OmenflowErrorBody }) => {
      if (message?.ok && message.report) done(() => resolve(message.report!));
      else if (signal?.aborted) onAbort();
      else
        done(() =>
          reject(
            message.error
              ? OmenflowError.fromBody(message.error)
              : new OmenflowError(ErrorCodes.INTERNAL, 'Mesh worker returned no analysis'),
          ),
        );
    });
    worker.once('error', (error) => {
      if (signal?.aborted) return onAbort();
      done(() => reject(OmenflowError.from(error)));
    });
    worker.once('exit', (code) =>
      done(() =>
        reject(
          new OmenflowError(
            ErrorCodes.JOB_INTERRUPTED,
            `Mesh worker exited before returning analysis (code ${code})`,
          ),
        ),
      ),
    );
  });
}

/**
 * Reverse winding when the mesh is watertight and inside-out. Open (non-closed)
 * meshes are left alone — flipping them would still be a guess.
 */
export function orientTriangles(tris: TriangleBuffer): { tris: TriangleBuffer; flipped: boolean } {
  if (tris.length === 0) return { tris, flipped: false };
  const topo = topology(tris);
  if (!topo.watertight || signedVolume(tris) >= 0) return { tris, flipped: false };
  const out = new Float64Array(tris.length);
  for (let i = 0; i < tris.length; i += 9) {
    out[i] = tris[i]!;
    out[i + 1] = tris[i + 1]!;
    out[i + 2] = tris[i + 2]!;
    out[i + 3] = tris[i + 6]!;
    out[i + 4] = tris[i + 7]!;
    out[i + 5] = tris[i + 8]!;
    out[i + 6] = tris[i + 3]!;
    out[i + 7] = tris[i + 4]!;
    out[i + 8] = tris[i + 5]!;
  }
  return { tris: out, flipped: true };
}

/** Binary STL for a triangle buffer (normals left zero; consumers recompute). */
export function writeBinaryStl(tris: TriangleBuffer): Buffer {
  assertFiniteMesh(tris);
  const n = triangleCount(tris);
  const buf = Buffer.alloc(84 + n * 50);
  buf.write('omenflow', 0, 'ascii');
  buf.writeUInt32LE(n, 80);
  for (let i = 0; i < n; i++) {
    const base = 84 + i * 50 + 12;
    for (let k = 0; k < 9; k++) buf.writeFloatLE(tris[i * 9 + k]!, base + k * 4);
  }
  return buf;
}

function triBBox(tris: TriangleBuffer, i: number): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < 9; k += 3) {
    for (let a = 0; a < 3; a++) {
      const v = tris[i + k + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  return { min, max };
}

function boxesOverlap(
  a: { min: Vec3; max: Vec3 },
  b: { min: Vec3; max: Vec3 },
  eps = 1e-9,
): boolean {
  return (
    a.min[0]! <= b.max[0]! + eps &&
    a.max[0]! >= b.min[0]! - eps &&
    a.min[1]! <= b.max[1]! + eps &&
    a.max[1]! >= b.min[1]! - eps &&
    a.min[2]! <= b.max[2]! + eps &&
    a.max[2]! >= b.min[2]! - eps
  );
}

function sharedVertices(tris: TriangleBuffer, i: number, j: number): number {
  let n = 0;
  for (let a = 0; a < 3; a++) {
    const ak = vkey(tris[i + a * 3]!, tris[i + a * 3 + 1]!, tris[i + a * 3 + 2]!);
    for (let b = 0; b < 3; b++) {
      const bk = vkey(tris[j + b * 3]!, tris[j + b * 3 + 1]!, tris[j + b * 3 + 2]!);
      if (ak === bk) {
        n++;
        break;
      }
    }
  }
  return n;
}

function segmentHitsTriangle(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  tris: TriangleBuffer,
  i: number,
): boolean {
  const t = rayTri(ax, ay, az, bx - ax, by - ay, bz - az, tris, i);
  return t !== null && t < 1 - 1e-6;
}

function trianglesIntersect(tris: TriangleBuffer, i: number, j: number): boolean {
  for (let e = 0; e < 3; e++) {
    const p = i + e * 3;
    const q = i + ((e + 1) % 3) * 3;
    if (
      segmentHitsTriangle(
        tris[p]!,
        tris[p + 1]!,
        tris[p + 2]!,
        tris[q]!,
        tris[q + 1]!,
        tris[q + 2]!,
        tris,
        j,
      )
    )
      return true;
  }
  for (let e = 0; e < 3; e++) {
    const p = j + e * 3;
    const q = j + ((e + 1) % 3) * 3;
    if (
      segmentHitsTriangle(
        tris[p]!,
        tris[p + 1]!,
        tris[p + 2]!,
        tris[q]!,
        tris[q + 1]!,
        tris[q + 2]!,
        tris,
        i,
      )
    )
      return true;
  }
  return false;
}

/**
 * Count triangle pairs whose interiors intersect. Adjacent faces that share an
 * edge are ignored. Used to catch STL soup (overlapping bodies, self-piercing).
 */
export function countIntersectingPairs(tris: TriangleBuffer): number {
  assertIntersectionBudget(tris);
  assertFiniteMesh(tris);
  const n = triangleCount(tris);
  const boxes = new Array<{ min: Vec3; max: Vec3 }>(n);
  for (let t = 0; t < n; t++) boxes[t] = triBBox(tris, t * 9);
  let count = 0;
  let overlaps = 0;
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      if (!boxesOverlap(boxes[a]!, boxes[b]!)) continue;
      if (++overlaps > MAX_INTERSECTION_OVERLAP_PAIRS)
        meshWorkLimit(
          'Self-intersection overlapping pairs',
          overlaps,
          MAX_INTERSECTION_OVERLAP_PAIRS,
        );
      const ia = a * 9,
        ib = b * 9;
      if (sharedVertices(tris, ia, ib) >= 2) continue;
      if (trianglesIntersect(tris, ia, ib)) count++;
    }
  }
  return count;
}

/**
 * Estimated minimum wall thickness: from each triangle centroid, ray along
 * the inward normal to the next hit. Returns null when no opposite face is found.
 */
export function minWallThickness(tris: TriangleBuffer, samples?: number): number | null {
  assertFiniteMesh(tris);
  const n = triangleCount(tris);
  if (n === 0) return null;
  const inverted = signedVolume(tris) < 0;
  const step = samples && samples < n ? Math.max(1, Math.floor(n / samples)) : 1;
  const visits = Math.ceil(n / step) * n;
  if (visits > MAX_CAD_CHECK_TRIANGLE_VISITS)
    meshWorkLimit('Wall-thickness triangle visits', visits, MAX_CAD_CHECK_TRIANGLE_VISITS);
  let minT = Infinity;
  for (let t = 0; t < n; t += step) {
    const i = t * 9;
    const ax = tris[i]!,
      ay = tris[i + 1]!,
      az = tris[i + 2]!;
    const ux = tris[i + 3]! - ax,
      uy = tris[i + 4]! - ay,
      uz = tris[i + 5]! - az;
    const vx = tris[i + 6]! - ax,
      vy = tris[i + 7]! - ay,
      vz = tris[i + 8]! - az;
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    nx /= len;
    ny /= len;
    nz /= len;
    if (inverted) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const px = (ax + tris[i + 3]! + tris[i + 6]!) / 3;
    const py = (ay + tris[i + 4]! + tris[i + 7]!) / 3;
    const pz = (az + tris[i + 5]! + tris[i + 8]!) / 3;
    const eps = 1e-4;
    const ox = px - nx * eps,
      oy = py - ny * eps,
      oz = pz - nz * eps;
    let best: number | null = null;
    for (let j = 0; j < tris.length; j += 9) {
      if (j === i) continue;
      const hit = rayTri(ox, oy, oz, -nx, -ny, -nz, tris, j);
      if (hit !== null && (best === null || hit < best)) best = hit;
    }
    if (best !== null && best < minT) minT = best;
  }
  return minT === Infinity ? null : minT;
}

/** Sort loops for a compact human/LLM-readable description of a section. */
export function describeSection(section: CrossSection, unit = 'mm'): string[] {
  const [a, b] = section.planeAxes;
  const lines: string[] = [];
  for (const loop of section.loops) {
    const kind = loop.isHole ? 'hole' : 'outer';
    const where = `${a}=${loop.centroid[0]}, ${b}=${loop.centroid[1]}`;
    if (loop.circle && loop.circle.roundness >= 0.9) {
      lines.push(
        `${kind}: circle d=${round(loop.circle.radius * 2)} ${unit} at (${where}) roundness=${loop.circle.roundness}`,
      );
    } else if (loop.rectangle) {
      lines.push(
        `${kind}: rectangle ${loop.rectangle.size[0]}×${loop.rectangle.size[1]} ${unit} centered (${a}=${loop.rectangle.center[0]}, ${b}=${loop.rectangle.center[1]})`,
      );
    } else {
      lines.push(
        `${kind}: polygon area=${round(loop.area)} ${unit}² bbox ${loop.bbox.size[0]}×${loop.bbox.size[1]} centered (${where})`,
      );
    }
  }
  if (section.openChains > 0)
    lines.push(`warning: ${section.openChains} open chain(s) — mesh not closed at this plane`);
  return lines;
}
