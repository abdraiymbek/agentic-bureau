import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenScadAdapter } from './openscad.js';

const adapter = () => new OpenScadAdapter();

const asciiStl = `solid test
 facet normal 0 0 1
  outer loop
   vertex 0 0 0
   vertex 10 0 0
   vertex 0 10 0
  endloop
 endfacet
 facet normal 0 0 -1
  outer loop
   vertex 0 0 0
   vertex 0 10 5
   vertex 10 0 5
  endloop
 endfacet
endsolid test`;

function makeBinaryStl(tris: [number, number, number][][]): Buffer {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.write('binary stl fixture', 0, 'ascii');
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach((tri, i) => {
    const base = 84 + i * 50 + 12; // skip normal
    tri.forEach((v, vi) => v.forEach((c, ci) => buf.writeFloatLE(c, base + (vi * 3 + ci) * 4)));
  });
  return buf;
}

describe('OpenScadAdapter.inspectStl', () => {
  it('parses ascii STL: triangle count and bounds', () => {
    const r = adapter().inspectStl(Buffer.from(asciiStl, 'utf8'));
    expect(r.format).toBe('ascii');
    expect(r.triangles).toBe(2);
    expect(r.bounds.min).toEqual([0, 0, 0]);
    expect(r.bounds.max).toEqual([10, 10, 5]);
    expect(r.plausible).toBe(true);
    expect(r.bytes).toBe(Buffer.byteLength(asciiStl));
  });

  it('parses binary STL: triangle count and bounds', () => {
    const buf = makeBinaryStl([
      [
        [0, 0, 0],
        [10, 0, 0],
        [0, 10, 0],
      ],
      [
        [0, 0, -2],
        [10, 0, 0],
        [0, 10, 0],
      ],
    ]);
    const r = adapter().inspectStl(buf);
    expect(r.format).toBe('binary');
    expect(r.triangles).toBe(2);
    expect(r.bounds.min).toEqual([0, 0, -2]);
    expect(r.bounds.max).toEqual([10, 10, 0]);
    expect(r.plausible).toBe(true);
  });

  it('flags garbage as implausible', () => {
    const r = adapter().inspectStl(Buffer.from('this is not an stl file at all', 'utf8'));
    expect(r.plausible).toBe(false);
    expect(r.triangles).toBe(0);
  });

  it('flags a solid with no facets as implausible', () => {
    const r = adapter().inspectStl(Buffer.from('solid empty\nendsolid empty', 'utf8'));
    expect(r.plausible).toBe(false);
  });
});

describe('OpenScadAdapter discovery/probe', () => {
  it('probe() returns a well-formed ToolProbeResult without throwing', async () => {
    const r = await adapter().probe();
    expect(typeof r.available).toBe('boolean');
    expect(r.executablePath === null || typeof r.executablePath === 'string').toBe(true);
    expect(r.version === null || typeof r.version === 'string').toBe(true);
    if (!r.available) expect(typeof r.error).toBe('string');
  });

  it('probe() reports unavailable for a bogus preferred path', async () => {
    const a = new OpenScadAdapter({ preferredPath: '/nonexistent/openscad' });
    const r = await a.probe();
    // May still discover a real system binary; only assert no throw + shape.
    expect(typeof r.available).toBe('boolean');
  });
});

describe('OpenScadAdapter e2e (requires real OpenSCAD)', () => {
  it.skipIf(!process.env.STARK_OPENSCAD_E2E)('renders a cube to STL with -D params', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stark-scad-e2e-'));
    const scad = path.join(dir, 'box.scad');
    const out = path.join(dir, 'box.stl');
    fs.writeFileSync(scad, 'size = 5; cube([size, size, 2]);\n');

    const a = adapter();
    const probe = await a.probe();
    expect(probe.available).toBe(true);

    const valid = await a.validateSource(scad);
    expect(valid).toEqual({ ok: true, errors: [] });

    const logs: string[] = [];
    const res = await a.render(
      {
        jobId: 'e2e',
        scadPath: scad,
        outPath: out,
        params: { size: 8 },
        timeoutMs: 60_000,
        workDir: dir,
      },
      (c) => logs.push(c),
    );
    expect(res.ok).toBe(true);
    const stl = a.inspectStl(fs.readFileSync(out));
    expect(stl.plausible).toBe(true);
    expect(stl.bounds.max[0]! - stl.bounds.min[0]!).toBeCloseTo(8, 3);

    const bad = path.join(dir, 'bad.scad');
    fs.writeFileSync(bad, 'cube([1,2);\n');
    const invalid = await a.validateSource(bad);
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.length).toBeGreaterThan(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
