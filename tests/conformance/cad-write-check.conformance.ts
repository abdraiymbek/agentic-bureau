/**
 * Write-and-check through the real agent path and the real engine: a source
 * write with `expect` saves, renders and checks the revision in one call, and
 * the person's path refuses `expect`. Needs OpenSCAD (conformance CI installs
 * it); this case fails, never skips, when no engine is found.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentActivity } from '@omenflow/contracts';
import { CoreError, RustCore } from './rust-core';

const USER = { kind: 'user' as const };
const AGENT = { kind: 'agent' as const, sessionId: '00000000-0000-4000-8000-0000000000f2' };

let root: string;
let app: RustCore;
let projectId: string;
const user = (op: string, payload: unknown = {}) =>
  app.dispatch(op, payload, USER, projectId) as Promise<any>;
const agent = (op: string, payload: unknown = {}) =>
  app.dispatch(op, payload, AGENT, projectId) as Promise<any>;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'omen-write-check-'));
  app = await RustCore.start(path.join(root, 'app'));
  const created = (await app.dispatch(
    'project.create',
    { path: path.join(root, 'project'), name: 'Write and check', intent: 'conformance' },
    USER,
  )) as { projectId: string };
  projectId = created.projectId;
});
afterEach(async () => {
  await app.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('cad_write_source with expect', () => {
  it('checks the saved revision in the same call and records the check as the host’s', async () => {
    const probe = await user('cad.probe');
    expect(probe.available, `OpenSCAD is required for this case: ${probe.error}`).toBe(true);

    const source =
      'difference() {\n  cube([10, 10, 2]);\n  translate([5, 5, -1]) cylinder(d = 4, h = 4, $fn = 64);\n}\n';
    const written = await agent('cad_write_source', {
      title: 'Washer plate',
      source,
      expect: { size: [10, 10, 2], bodies: 1, holes: [{ at: [5, 5, 1], d: 4 }] },
    });
    expect(written).toMatchObject({
      render: { ok: true },
      ready: true,
      verificationStatus: 'passed',
      check: { committed: true },
      workStatus: { scope: 'session', ready: true },
      nextStep: { tool: null },
    });
    expect(written.nextStep.why).toContain('Do the rest of the request if any');

    const missed = await agent('cad_write_source', {
      artifactId: written.artifactId,
      expectedRevisionId: written.revisionId,
      source,
      expect: { size: [10, 10, 2], bodies: 1, holes: [{ at: [5, 5, 1], d: 5 }] },
    });
    expect(missed).toMatchObject({ ready: false, check: { committed: false } });
    expect(missed.workStatus).toBeUndefined();

    const activity: AgentActivity = await user('agent.activity');
    const writes = activity.calls.filter((call) => call.op === 'cad.write_source');
    expect(writes).toHaveLength(2);
    expect(activity.calls).toHaveLength(2);
    expect(writes[0]?.alsoRan).toEqual([
      expect.objectContaining({
        tool: 'cad_check',
        ok: true,
        verificationStatus: 'passed',
        committed: true,
      }),
      expect.objectContaining({ tool: 'work_status', ok: true, scope: 'session', ready: true }),
    ]);
    expect(writes[1]?.alsoRan).toEqual([
      expect.objectContaining({
        tool: 'cad_check',
        verificationStatus: 'failed',
        committed: false,
      }),
    ]);
  });

  it('is refused on the person’s path before anything is written', async () => {
    const refused = await user('cad.write_source', {
      title: 'Washer plate',
      source: 'cube([10, 10, 2]);',
      expect: { size: [10, 10, 2] },
    }).then(
      () => {
        throw new Error('the call was expected to fail');
      },
      (error: unknown) => error as CoreError,
    );
    expect(refused).toBeInstanceOf(CoreError);
    expect(refused.code).toBe('VALIDATION');
    expect(refused.message).toBe('cad_write_source checks expect only in an agent session');
    expect((await user('artifact.list')).total).toBe(0);
  });
});
