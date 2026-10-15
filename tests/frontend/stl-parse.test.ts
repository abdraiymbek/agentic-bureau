import { describe, expect, it } from 'vitest';
import { StlError, decodeBase64, parseStl } from '../../apps/desktop/src/renderer/lib/stl-parse';

type Tri = [number[], number[], number[]];

function binaryStl(triangles: Tri[], trailing = 0): ArrayBuffer {
  const buffer = new ArrayBuffer(84 + triangles.length * 50 + trailing);
  const view = new DataView(buffer);
  view.setUint32(80, triangles.length, true);
  triangles.forEach((tri, t) => {
    tri.flat().forEach((value, k) => view.setFloat32(84 + t * 50 + 12 + k * 4, value, true));
  });
  return buffer;
}

/** A unit cube scaled to `size`, two triangles per face, wound outward. */
function cube(size: number): Tri[] {
  const s = size;
  const quad = (a: number[], b: number[], c: number[], d: number[]): Tri[] => [
    [a, b, c],
    [a, c, d],
  ];
  return [
    ...quad([0, 0, 0], [0, s, 0], [s, s, 0], [s, 0, 0]),
    ...quad([0, 0, s], [s, 0, s], [s, s, s], [0, s, s]),
    ...quad([0, 0, 0], [s, 0, 0], [s, 0, s], [0, 0, s]),
    ...quad([0, s, 0], [0, s, s], [s, s, s], [s, s, 0]),
    ...quad([0, 0, 0], [0, 0, s], [0, s, s], [0, s, 0]),
    ...quad([s, 0, 0], [s, s, 0], [s, s, s], [s, 0, s]),
  ];
}

describe('STL to indexed geometry', () => {
  it('welds a binary cube to eight vertices and twelve triangles', () => {
    const mesh = parseStl(binaryStl(cube(10)));
    expect(mesh.triangles).toBe(12);
    expect(mesh.positions.length).toBe(8 * 3);
    expect(mesh.indices.length).toBe(36);
    expect(Math.max(...mesh.indices)).toBe(7);
    expect(mesh.bounds).toEqual({ min: [0, 0, 0], max: [10, 10, 10] });
  });
  it('keeps the twelve cube edges as feature edges and drops the face diagonals', () => {
    const mesh = parseStl(binaryStl(cube(10)));
    expect(mesh.edges.length).toBe(12 * 6);
    for (let i = 0; i < mesh.edges.length; i += 6) {
      const differing = [0, 1, 2].filter((k) => mesh.edges[i + k] !== mesh.edges[i + 3 + k]);
      expect(differing).toHaveLength(1);
    }
  });
  it('reports the open edges of a surface that is not closed', () => {
    const mesh = parseStl(binaryStl(cube(10).slice(0, 2)));
    expect(mesh.edges.length).toBe(4 * 6);
  });
  it('treats negative zero and zero as one place', () => {
    const mesh = parseStl(
      binaryStl([
        [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
        ],
        [
          [-0, 0, -0],
          [0, 1, 0],
          [0, 0, 1],
        ],
      ]),
    );
    expect(mesh.positions.length).toBe(4 * 3);
  });
  it('reads ASCII, including a file whose name starts the binary-looking header', () => {
    const text = `solid part
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 2.5 0 0
      vertex 0 1e1 0
    endloop
  endfacet
endsolid part`;
    const mesh = parseStl(new TextEncoder().encode(text).buffer as ArrayBuffer);
    expect(mesh.triangles).toBe(1);
    expect(mesh.bounds.max).toEqual([2.5, 10, 0]);
  });
  it('accepts bytes after the last triangle but not a short file', () => {
    expect(parseStl(binaryStl(cube(1), 7)).triangles).toBe(12);
    const whole = binaryStl(cube(1));
    expect(() => parseStl(whole.slice(0, whole.byteLength - 30))).toThrow(StlError);
    expect(() => parseStl(whole.slice(0, whole.byteLength - 30))).toThrow(/declares 12 triangles/);
  });
  it('explains input that is not a mesh at all', () => {
    expect(() => parseStl(new ArrayBuffer(10))).toThrow(/shorter than the 84-byte header/);
    expect(() => parseStl(binaryStl([]))).toThrow(/no triangles/);
    const damaged = binaryStl(cube(1));
    new DataView(damaged).setFloat32(84 + 12, Number.NaN, true);
    expect(() => parseStl(damaged)).toThrow(/not a finite number/);
    const cut = new TextEncoder().encode('solid x\nfacet\nvertex 0 0 0\nvertex 1 0 0\nendsolid');
    expect(() => parseStl(cut.buffer as ArrayBuffer)).toThrow(/ends inside a facet/);
  });
  it('indexes a hundred thousand triangles', () => {
    // A 224 x 224 grid of quads: 100,352 triangles sharing 50,625 vertices.
    const n = 224;
    const triangles: Tri[] = [];
    for (let x = 0; x < n; x++)
      for (let y = 0; y < n; y++) {
        const z = (i: number, j: number) => Math.sin(i / 9) * Math.cos(j / 7);
        const p = (i: number, j: number) => [i, j, z(i, j)];
        triangles.push([p(x, y), p(x + 1, y), p(x + 1, y + 1)]);
        triangles.push([p(x, y), p(x + 1, y + 1), p(x, y + 1)]);
      }
    const mesh = parseStl(binaryStl(triangles));
    expect(mesh.triangles).toBe(2 * n * n);
    expect(mesh.positions.length / 3).toBe((n + 1) * (n + 1));
    expect(mesh.indices).toBeInstanceOf(Uint32Array);
  });
  it('decodes base64 to the same bytes', () => {
    const bytes = new Uint8Array(binaryStl(cube(3)));
    const text = Buffer.from(bytes).toString('base64');
    expect(new Uint8Array(decodeBase64(text))).toEqual(bytes);
  });
});
