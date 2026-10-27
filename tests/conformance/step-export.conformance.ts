/**
 * `cad_export` and the STEP converter's probe through the real host: user calls take the
 * command route, agent calls the bridge with a session token. Engine-free: nothing here needs
 * OpenSCAD or a Python with OCP (the converter probe is checked for its shape, not its answer).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoreError, RustCore } from './rust-core';

const USER = { kind: 'user' as const };
const AGENT = { kind: 'agent' as const, sessionId: '00000000-0000-4000-8000-0000000000f4' };

let root: string;
let app: RustCore;
let projectId: string;
const user = <T = unknown>(op: string, payload: unknown = {}) =>
  app.dispatch(op, payload, USER, projectId) as Promise<T>;
const agent = <T = unknown>(op: string, payload: unknown = {}) =>
  app.dispatch(op, payload, AGENT, projectId) as Promise<T>;

interface Draft {
  artifact: { id: string };
  revision: { id: string };
}
interface Doctor {
  results: Record<string, { available?: unknown; tried?: unknown }>;
}
const refusal = (call: Promise<unknown>) =>
  call.then(
    () => {
      throw new Error('the call was expected to fail');
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(CoreError);
      return error as CoreError;
    },
  );

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-step-'));
  app = await RustCore.start(path.join(root, 'app'));
  const created = (await app.dispatch(
    'project.create',
    { path: path.join(root, 'project'), name: 'STEP export', intent: 'conformance' },
    USER,
  )) as { projectId: string };
  projectId = created.projectId;
});
afterEach(async () => {
  await app.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('cad_export', () => {
  it('is an agent tool of the full profile that changes the project', async () => {
    const described = await agent('tool_describe', { tool: 'cad_export' });
    expect(described).toMatchObject({ tool: 'cad_export', tier: 'full', mutating: true });
  });

  it('exports STEP only from a mechanical part, and copies a stored file as before', async () => {
    const note = await user<Draft>('artifact.create_draft', {
      type: 'note',
      title: 'Bench notes',
      payload: { markdown: 'Measured by hand.' },
    });
    const step = await refusal(
      agent('cad_export', {
        artifactId: note.artifact.id,
        format: 'step',
        destPath: 'exports/notes.step',
      }),
    );
    expect(step.code).toBe('VALIDATION');
    expect(step.message).toContain('not a mechanical part');
    // A person's copy of a file the revision does not have says which file is missing.
    const stl = await refusal(
      user('cad.export', {
        artifactId: note.artifact.id,
        revisionId: note.revision.id,
        destPath: path.join(root, 'notes.stl'),
      }),
    );
    expect(stl.code).toBe('NOT_FOUND');
    expect(stl.message).toBe('r1 of "Bench notes" has no .stl file');
  });
});

describe('tool_doctor', () => {
  it('reports each tool on its own and checks nothing for an unknown one', async () => {
    const python = await agent<Doctor>('tool_doctor', { toolId: 'python' });
    expect(Object.keys(python.results)).toEqual(['python']);
    expect(typeof python.results.python?.available).toBe('boolean');
    expect(Array.isArray(python.results.python?.tried)).toBe(true);
    expect(await agent('tool_doctor', { toolId: 'kicad' })).toEqual({ results: {} });
  });
});
