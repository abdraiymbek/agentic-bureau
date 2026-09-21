import { describe, expect, it } from 'vitest';
import { ErrorCodes, MAX_FRAME_BYTES } from '@omenflow/contracts';
import {
  assertCadInspectionBudget,
  MAX_CAD_MESH_BYTES,
  MAX_CAD_TRIANGLES,
  MAX_INTERSECTION_PAIRS,
  MAX_INTERSECTION_OVERLAP_PAIRS,
  parseStlTriangles,
  analyzeMesh,
  analyzeMeshCancellable,
  countIntersectingPairs,
  minWallThickness,
  writeBinaryStl,
  type TriangleBuffer,
} from './mesh.js';
import { runChecks, preservationCheck } from './cad-checks.js';

function triangles(n: number, overlap = false): TriangleBuffer {
  const tris = new Float64Array(n * 9);
  for (let i = 0; i < n; i++) {
    const offset = i / 100000;
    tris.set(
      overlap
        ? [offset, 0, 0, 1 + offset, 0, 1, 0, 1 + offset, -1]
        : [i * 2, 0, 0, i * 2 + 1, 0, 0, i * 2, 1, 0],
      i * 9,
    );
  }
  return tris;
}
const workLimit = {
  code: 'VALIDATION',
  details: expect.objectContaining({ reason: 'CAD_WORK_LIMIT', status: 'not_evaluated' }),
};

describe('bounded synchronous mesh work', () => {
  it('keeps supported STL payloads within framing after base64 and response overhead', () => {
    expect(Math.ceil(MAX_CAD_MESH_BYTES / 3) * 4 + 32 * 1024).toBeLessThan(MAX_FRAME_BYTES);
  });

  it('rejects bytes and declared binary triangles before allocating a triangle buffer', () => {
    expect(() => parseStlTriangles(Buffer.alloc(MAX_CAD_MESH_BYTES + 1))).toThrowError(
      expect.objectContaining(workLimit),
    );
    const binary = Buffer.alloc(84 + (MAX_CAD_TRIANGLES + 1) * 50);
    binary.writeUInt32LE(MAX_CAD_TRIANGLES + 1, 80);
    expect(() => parseStlTriangles(binary)).toThrowError(expect.objectContaining(workLimit));
    expect(() => analyzeMesh(new Float64Array((MAX_CAD_TRIANGLES + 1) * 9))).toThrowError(
      expect.objectContaining(workLimit),
    );
  });

  it('supports the declared triangle boundary and rejects invalid finite-coordinate assumptions', () => {
    const binary = writeBinaryStl(triangles(MAX_CAD_TRIANGLES));
    expect(parseStlTriangles(binary).length / 9).toBe(MAX_CAD_TRIANGLES);
    binary.writeFloatLE(Infinity, 96);
    expect(() => parseStlTriangles(binary)).toThrow(/non-finite/);
    expect(() => parseStlTriangles(Buffer.from('solid x\nvertex NaN 0 0\nendsolid x'))).toThrow(
      /non-finite/,
    );
    expect(() => parseStlTriangles(Buffer.from('solid x\nvertex 0 0 0\nendsolid x'))).toThrow(
      /incomplete triangle/,
    );
    expect(() => runChecks(new Float64Array([NaN, 0, 0, 1, 0, 0, 0, 1, 0]), {})).toThrow(
      /non-finite/,
    );
  });

  it('rejects a quadratic request before checking triangles and caps overlapping narrow-phase work', () => {
    const count = Math.ceil(Math.sqrt(2 * MAX_INTERSECTION_PAIRS)) + 1;
    expect(() => countIntersectingPairs(triangles(count))).toThrowError(
      expect.objectContaining(workLimit),
    );
    expect(() => runChecks(triangles(count), { maxSelfIntersections: 0 })).toThrowError(
      expect.objectContaining(workLimit),
    );
    const overlapping = Math.ceil(Math.sqrt(2 * MAX_INTERSECTION_OVERLAP_PAIRS)) + 1;
    expect(() => countIntersectingPairs(triangles(overlapping, true))).toThrowError(
      expect.objectContaining(workLimit),
    );
    expect(countIntersectingPairs(triangles(1000))).toBe(0);
  });

  it('bounds inspection requests including automatic section work', () => {
    const mesh = triangles(MAX_CAD_TRIANGLES);
    expect(() => assertCadInspectionBudget(mesh, 90, 0)).not.toThrow();
    expect(() => assertCadInspectionBudget(mesh, 91, 0)).toThrowError(
      expect.objectContaining(workLimit),
    );
    expect(() => assertCadInspectionBudget(mesh, 0, 46)).toThrowError(
      expect.objectContaining(workLimit),
    );
    expect(() => assertCadInspectionBudget(triangles(1), 513, 0)).toThrowError(
      expect.objectContaining(workLimit),
    );
  });

  it('bounds requested sample/probe workloads without silently reducing coverage', () => {
    const mesh = triangles(20000);
    expect(() => minWallThickness(mesh)).toThrowError(expect.objectContaining(workLimit));
    expect(() => preservationCheck(mesh, mesh, [])).toThrowError(
      expect.objectContaining(workLimit),
    );
    expect(() =>
      runChecks(mesh, { solid: Array.from({ length: 1000 }, () => [0, 0, 0]) }),
    ).toThrowError(expect.objectContaining(workLimit));
  });

  it('cancels mesh analysis before a worker result is committed', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(analyzeMeshCancellable(triangles(12), ac.signal)).rejects.toMatchObject({
      code: ErrorCodes.CANCELLED,
    });
    const live = new AbortController();
    const report = await analyzeMeshCancellable(triangles(12), live.signal);
    expect(report).toEqual(analyzeMesh(triangles(12)));
  });
});
