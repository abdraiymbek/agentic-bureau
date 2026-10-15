/**
 * STL bytes to indexed geometry. Pure and DOM-free so it runs in a worker and under test.
 * Coincident corners are welded by exact coordinate, which is what makes the mesh indexed;
 * nothing is moved, smoothed or repaired.
 */

export interface MeshBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface ParsedMesh {
  /** Unique vertices, xyz. */
  positions: Float32Array;
  /** Three vertex indices per triangle. */
  indices: Uint32Array;
  /** Feature-edge segments, two xyz points each: open edges and creases sharper than 25°. */
  edges: Float32Array;
  triangles: number;
  bounds: MeshBounds;
}

/** The bytes are not a usable STL. The message says what was wrong with them. */
export class StlError extends Error {}

const HEADER_BYTES = 84;
const TRIANGLE_BYTES = 50;
const CREASE_COS = Math.cos((25 * Math.PI) / 180);

function declaredBytes(view: DataView): number {
  return HEADER_BYTES + view.getUint32(80, true) * TRIANGLE_BYTES;
}

function binaryCorners(view: DataView): Float32Array {
  const triangles = view.getUint32(80, true);
  const corners = new Float32Array(triangles * 9);
  for (let t = 0; t < triangles; t++) {
    const at = HEADER_BYTES + t * TRIANGLE_BYTES + 12;
    for (let k = 0; k < 9; k++) corners[t * 9 + k] = view.getFloat32(at + k * 4, true);
  }
  return corners;
}

function asciiCorners(text: string): Float32Array {
  const number = '([-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?)';
  const vertex = new RegExp(`vertex\\s+${number}\\s+${number}\\s+${number}`, 'g');
  const values: number[] = [];
  for (let m = vertex.exec(text); m; m = vertex.exec(text))
    values.push(Number(m[1]), Number(m[2]), Number(m[3]));
  if (values.length % 9 !== 0)
    throw new StlError(
      `The STL text ends inside a facet: ${values.length / 3} vertices is not a whole number of triangles.`,
    );
  return Float32Array.from(values);
}

function corners(buffer: ArrayBuffer): Float32Array {
  const view = new DataView(buffer);
  const hasHeader = view.byteLength >= HEADER_BYTES;
  if (hasHeader && declaredBytes(view) === view.byteLength) return binaryCorners(view);
  const head = new TextDecoder().decode(buffer.slice(0, 512)).trimStart();
  if (head.startsWith('solid')) {
    const text = new TextDecoder().decode(buffer);
    if (/\bfacet\b/.test(text) || /\bendsolid\b/.test(text)) return asciiCorners(text);
  }
  if (!hasHeader)
    throw new StlError(
      `The file is ${view.byteLength} bytes, shorter than the 84-byte header of a binary STL.`,
    );
  // Some exporters append bytes after the last triangle; fewer bytes than declared is damage.
  if (declaredBytes(view) < view.byteLength && view.getUint32(80, true) > 0)
    return binaryCorners(view);
  throw new StlError(
    `The binary STL header declares ${view.getUint32(80, true)} triangles (${declaredBytes(view)} bytes) but the file is ${view.byteLength} bytes. It is truncated or not an STL.`,
  );
}

/** Welds identical corners with an open-addressed table over the exact float bits. */
function weld(soup: Float32Array): { positions: Float32Array; indices: Uint32Array } {
  const count = soup.length / 3;
  let capacity = 16;
  while (capacity < count * 2) capacity *= 2;
  const table = new Int32Array(capacity).fill(-1);
  const bits = new Int32Array(soup.buffer, soup.byteOffset, soup.length);
  const positions = new Float32Array(soup.length);
  const indices = new Uint32Array(count);
  let unique = 0;
  for (let i = 0; i < count; i++) {
    // Negative zero and zero are the same place.
    for (let k = 0; k < 3; k++) if (soup[i * 3 + k] === 0) soup[i * 3 + k] = 0;
    const a = bits[i * 3]!;
    const b = bits[i * 3 + 1]!;
    const c = bits[i * 3 + 2]!;
    let slot = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) >>> 0;
    slot &= capacity - 1;
    for (;;) {
      const existing = table[slot]!;
      if (existing < 0) {
        table[slot] = unique;
        positions[unique * 3] = soup[i * 3]!;
        positions[unique * 3 + 1] = soup[i * 3 + 1]!;
        positions[unique * 3 + 2] = soup[i * 3 + 2]!;
        indices[i] = unique++;
        break;
      }
      if (
        positions[existing * 3] === soup[i * 3] &&
        positions[existing * 3 + 1] === soup[i * 3 + 1] &&
        positions[existing * 3 + 2] === soup[i * 3 + 2]
      ) {
        indices[i] = existing;
        break;
      }
      slot = (slot + 1) & (capacity - 1);
    }
  }
  return { positions: positions.slice(0, unique * 3), indices };
}

function faceNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(indices.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const ux = positions[b]! - positions[a]!;
    const uy = positions[b + 1]! - positions[a + 1]!;
    const uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!;
    const vy = positions[c + 1]! - positions[a + 1]!;
    const vz = positions[c + 2]! - positions[a + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    normals[t] = nx / length;
    normals[t + 1] = ny / length;
    normals[t + 2] = nz / length;
  }
  return normals;
}

/** Edges with one face, or two faces meeting at more than the crease angle. */
function featureEdges(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = faceNormals(positions, indices);
  const vertexCount = positions.length / 3;
  const first = new Map<number, number>();
  const segments: number[] = [];
  const push = (a: number, b: number) => {
    segments.push(
      positions[a * 3]!,
      positions[a * 3 + 1]!,
      positions[a * 3 + 2]!,
      positions[b * 3]!,
      positions[b * 3 + 1]!,
      positions[b * 3 + 2]!,
    );
  };
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e]!;
      const b = indices[t + ((e + 1) % 3)]!;
      if (a === b) continue;
      const key = a < b ? a * vertexCount + b : b * vertexCount + a;
      const other = first.get(key);
      if (other === undefined) {
        first.set(key, t);
      } else if (other >= 0) {
        const dot =
          normals[other]! * normals[t]! +
          normals[other + 1]! * normals[t + 1]! +
          normals[other + 2]! * normals[t + 2]!;
        if (dot < CREASE_COS) push(a, b);
        first.set(key, -1);
      }
    }
  }
  for (const [key, face] of first) {
    if (face >= 0) push(Math.floor(key / vertexCount), key % vertexCount);
  }
  return Float32Array.from(segments);
}

export function parseStl(buffer: ArrayBuffer): ParsedMesh {
  const soup = corners(buffer);
  if (soup.length === 0) throw new StlError('The STL contains no triangles.');
  for (let i = 0; i < soup.length; i++)
    if (!Number.isFinite(soup[i]!))
      throw new StlError('The STL contains a coordinate that is not a finite number.');
  const { positions, indices } = weld(soup);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }
  return {
    positions,
    indices,
    edges: featureEdges(positions, indices),
    triangles: indices.length / 3,
    bounds: { min, max },
  };
}

export function decodeBase64(text: string): ArrayBuffer {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
