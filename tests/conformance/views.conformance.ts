/**
 * cad_view against the real engine and the real bridge: an agent asks to
 * see a part it wrote and gets one picture file in the project, named by
 * path and hash, with the panels' scale; never picture bytes in the reply.
 * Needs OpenSCAD, as the rest of the engine cases do.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RustCore } from './rust-core';

const USER = { kind: 'user' as const };
const AGENT = { kind: 'agent' as const, sessionId: '00000000-0000-4000-8000-0000000000f2' };
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A 40 × 30 × 4 mm plate with four ⌀3.2 through holes 5 mm in from each corner. */
const PLATE = `plate = [40, 30, 4];
hole_d = 3.2;
inset = 5;
difference() {
  cube(plate);
  for (x = [inset, plate[0] - inset], y = [inset, plate[1] - inset])
    translate([x, y, -1]) cylinder(d = hole_d, h = plate[2] + 2);
}
`;

/** The parts of a `cad_view` result these cases read. */
interface ViewResult {
  mesh: { source: string };
  mmPerPx: number;
  views: { name: string; mmPerPx: number; toScale?: boolean }[];
  sections: { label: string; plane: string; mmPerPx: number; loops: string[] }[];
  images: { path: string; sha256: string; mimeType: string; widthPx: number; heightPx: number }[];
  notes: string[];
}

let root: string;
let app: RustCore;
let projectId: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'omen-views-'));
  app = await RustCore.start(path.join(root, 'app'));
  const created = (await app.dispatch(
    'project.create',
    { path: path.join(root, 'project'), name: 'Views', intent: 'conformance' },
    USER,
  )) as { projectId: string };
  projectId = created.projectId;
});
afterEach(async () => {
  await app.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

it('draws a written part as one picture file with its sections and shared scale', async () => {
  const part = (await app.dispatch(
    'cad.write_source',
    { title: 'Sensor plate', source: PLATE, timeoutMs: 60000 },
    AGENT,
    projectId,
  )) as { artifactId: string; render: { ok: boolean } };
  expect(part.render.ok).toBe(true);
  const view = (await app.dispatch(
    'cad_view',
    { artifactId: part.artifactId, sections: [{ axis: 'z', at: 2 }] },
    AGENT,
    projectId,
  )) as ViewResult;
  expect(view.mesh.source).toBe('stored');
  expect(view.views.map((panel) => panel.name)).toEqual(['front', 'top', 'right', 'iso']);
  for (const panel of view.views.slice(0, 3)) expect(panel.mmPerPx).toBe(view.mmPerPx);
  expect(view.views[3]!.toScale).toBe(false);
  const [section] = view.sections;
  expect(section).toMatchObject({ label: 'A-A', plane: 'z=2', mmPerPx: view.mmPerPx });
  expect(section!.loops.filter((loop) => loop.startsWith('cut-out circle d=3.2'))).toHaveLength(4);
  expect(view.images).toHaveLength(1);
  const picture = view.images[0]!;
  expect(picture).toMatchObject({ mimeType: 'image/png' });
  const bytes = fs.readFileSync(path.join(root, 'project', picture.path));
  expect(bytes.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([
    picture.widthPx,
    picture.heightPx,
  ]);
  expect(Math.max(picture.widthPx, picture.heightPx)).toBeLessThanOrEqual(1024);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(picture.sha256);
  // No picture bytes anywhere in the reply: base64 of a PNG starts with iVBOR.
  expect(JSON.stringify(view)).not.toMatch(/iVBOR|"data"/);
  expect(view.notes).toContain('A picture is diagnostic: it binds and verifies nothing.');
});
