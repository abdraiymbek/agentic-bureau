/**
 * Spec items through the host as an agent reaches it: cad_check with a listed
 * item that has no assertion is partial and committed, work_status names the
 * item with a call that resolves it, and following that call verifies the
 * part. Needs OpenSCAD; it fails rather than skipping without one.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RustCore } from './rust-core';

const AGENT = { kind: 'agent' as const, sessionId: '00000000-0000-4000-8000-0000000000f2' };

interface Outstanding {
  kind: string;
  severity: string;
  artifactId: string;
  next: { tool: string; args: { expect: { spec: Record<string, unknown>[] } } } | null;
}
interface WorkStatus {
  ready: boolean;
  outstanding: Outstanding[];
}

let root: string;
let app: RustCore;
let projectId: string;
const agent = <T>(op: string, payload: unknown = {}) =>
  app.dispatch(op, payload, AGENT, projectId) as Promise<T>;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-spec-items-'));
  app = await RustCore.start(path.join(root, 'app'));
  const created = (await app.dispatch(
    'project.create',
    { path: path.join(root, 'project'), name: 'Spec items', intent: 'conformance' },
    { kind: 'user' },
  )) as { projectId: string };
  projectId = created.projectId;
});
afterEach(async () => {
  await app.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

it('keeps a check with an unasserted item partial and names the item in work_status', async () => {
  const written = await agent<{ artifactId: string; render: { ok: boolean } }>('cad_write_source', {
    title: 'Plate',
    source: 'cube([20, 10, 2]);',
    timeoutMs: 60_000,
  });
  expect(written.render.ok, 'OpenSCAD must render the plate').toBe(true);
  const checked = await agent<{ spec: { items: unknown[]; listedBy: string } }>('cad_check', {
    artifactId: written.artifactId,
    autoCommit: true,
    expect: {
      bodies: 1,
      spec: [
        { item: 'plate 20 x 10 x 2 mm', size: [20, 10, 2] },
        { item: 'material at the centre' },
      ],
    },
  });
  expect(checked).toMatchObject({
    verificationStatus: 'partial',
    committed: true,
    ready: false,
    spec: { counts: { items: 2, passed: 1, unasserted: 1, blocking: 1 } },
  });
  expect(checked.spec.items[1]).toMatchObject({
    item: 'material at the centre',
    from: 'listed',
    state: 'unasserted',
  });
  expect(checked.spec.listedBy).toBe('agent');

  const status = await agent<WorkStatus>('work_status');
  expect(status.ready).toBe(false);
  const found = status.outstanding.find((item) => item.kind === 'cad_spec_unasserted');
  expect(found).toMatchObject({ severity: 'blocker', artifactId: written.artifactId });
  const next = found!.next!;
  expect(next).toMatchObject({ tool: 'cad_check' });
  expect(next.args.expect.spec).toEqual([
    { item: 'plate 20 x 10 x 2 mm', size: [20, 10, 2] },
    { item: 'material at the centre' },
  ]);

  const args = structuredClone(next.args);
  args.expect.spec[1]!.solid = [[10, 5, 1]];
  const fixed = await agent<unknown>('cad_check', args);
  expect(fixed).toMatchObject({ verificationStatus: 'passed', ready: true, scopeChanges: [] });
  const done = await agent<WorkStatus>('work_status');
  expect(done.ready).toBe(true);
  expect(done.outstanding.map((item) => item.kind)).not.toContain('cad_spec_unasserted');
});
