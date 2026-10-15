import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ErrorCodes, RUST_HOST_OPS } from '@omenflow/contracts';
import { CoreApp, nullHost } from './index.js';

let root: string;
let app: CoreApp;
let projectId: string;
const user = { kind: 'user' as const };
const agent = { kind: 'agent' as const, sessionId: '00000000-0000-4000-8000-000000000011' };
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'omen-rust-host-ops-'));
  app = new CoreApp(path.join(root, 'app'), nullHost);
  const created = (await app.dispatch(
    'project.create',
    { path: path.join(root, 'project'), name: 'Rust host operations' },
    user,
  )) as { projectId: string };
  projectId = created.projectId;
});
afterEach(async () => {
  await app.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('operations the legacy TypeScript core does not serve', () => {
  it.each([...RUST_HOST_OPS])('%s answers with a typed error naming the Rust host', async (op) => {
    await expect(app.dispatch(op, { tool: 'bom_read' }, user, projectId)).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION,
      message: `${op} is implemented by the Rust host`,
      details: { op, implementedBy: 'rust-host' },
    });
  });

  it('still refuses the user-only one to an agent before anything else', async () => {
    await expect(app.dispatch('agent.activity', {}, agent, projectId)).rejects.toMatchObject({
      code: ErrorCodes.CAPABILITY_DENIED,
    });
    await expect(app.dispatch('work.status', {}, agent, projectId)).rejects.toMatchObject({
      message: 'work.status is implemented by the Rust host',
    });
  });
});

describe('cad.check inputs the legacy TypeScript core does not understand', () => {
  const artifactId = '00000000-0000-4000-8000-000000000001';
  it.each([
    [{ expect: { size: [40, 30, 5] } }, ['expect.size']],
    [
      { expect: { holes: [{ at: [10, 10, 2.5], d: 4 }], bodies: 1 } },
      ['expect.holes', 'expect.bodies'],
    ],
    [{ expect: { shells: 1, tol: 0.2 }, autoCommit: true }, ['autoCommit', 'expect.tol']],
  ])('refuses %j instead of verifying less than was asked', async (input, unsupported) => {
    await expect(
      app.dispatch('cad.check', { artifactId, ...input }, agent, projectId),
    ).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION,
      message: `cad.check with ${unsupported.join(', ')} is implemented by the Rust host`,
      details: { op: 'cad.check', unsupported, implementedBy: 'rust-host' },
    });
  });

  it('still serves the canonical expectation', async () => {
    await expect(
      app.dispatch('cad.check', { artifactId, expect: { shells: 1 } }, agent, projectId),
    ).rejects.toMatchObject({ code: ErrorCodes.NOT_FOUND });
  });
});

describe('tool.describe on the legacy core', () => {
  const describeTool = (payload: unknown) =>
    app.dispatch('tool.describe', payload, agent, projectId) as Promise<{
      op: string;
      tool: string;
      example: unknown;
    }>;

  it('accepts a tool or an op, in dotted or underscore form', async () => {
    for (const payload of [
      { op: 'cad.write_source' },
      { op: 'cad_write_source' },
      { tool: 'cad_write_source' },
      { tool: 'cad.write_source' },
    ])
      await expect(describeTool(payload)).resolves.toMatchObject({
        op: 'cad.write_source',
        tool: 'cad_write_source',
      });
    expect((await describeTool({ tool: 'artifact_read' })).example).toHaveProperty('artifactId');
  });

  it('says that the catalogue comes from the Rust host', async () => {
    await expect(describeTool({})).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION,
      message: expect.stringContaining('is implemented by the Rust host'),
    });
  });
});

describe('other inputs the legacy TypeScript core would ignore', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const end = (pin: string) => ({ componentArtifactId: id, pin });
  it.each([
    ['artifact.list', { cursor: 'next-page' }, ['cursor']],
    [
      'component.add_candidate',
      {
        title: 'Servo',
        manufacturer: 'Maker',
        partNumber: 'S-1',
        source: { url: 'https://example.com/servo', title: 'Servo page' },
      },
      ['source'],
    ],
    [
      'component.propose_selection',
      { artifactId: id, bomLines: [{ quantity: 1 }], reason: 'chosen' },
      ['revisionId omitted'],
    ],
    ['bom.propose_edit', { removeLineIds: [id], reason: 'drop it' }, ['removeLineIds']],
    ['bom.export', { format: 'csv', destPath: 'exports/bom.csv' }, ['destPath']],
    [
      'test.create_draft',
      {
        title: 'Ramp test',
        procedure: [{ step: 1, instruction: 'Climb the ramp' }],
        requirementRefs: [{ artifactId: id }],
      },
      ['requirementRefs[0].revisionId omitted'],
    ],
    [
      'test.record_result',
      {
        artifactId: id,
        evidenceKind: 'measured',
        observation: 'Climbed',
        result: 'passed',
        requirementRef: { artifactId: id },
      },
      ['requirementRef.revisionId omitted'],
    ],
    [
      'wiring.set_connections',
      {
        artifactId: id,
        connections: [
          { from: end('5V'), to: { ...end('VCC'), componentRevisionId: id }, signalRole: 'power' },
        ],
      },
      ['connections[0].id omitted', 'connections[0].from.componentRevisionId omitted'],
    ],
    [
      'artifact.create_draft',
      {
        type: 'wiring',
        title: 'Power',
        payload: { pins: [], connections: [{ from: end('5V'), to: end('VCC') }] },
      },
      [
        'connections[0].id omitted',
        'connections[0].from.componentRevisionId omitted',
        'connections[0].to.componentRevisionId omitted',
      ],
    ],
  ] as const)(
    '%s refuses %j instead of doing less than was asked',
    async (op, input, unsupported) => {
      await expect(app.dispatch(op, input, user, projectId)).rejects.toMatchObject({
        code: ErrorCodes.VALIDATION,
        message: `${op} with ${unsupported.join(', ')} is implemented by the Rust host`,
        details: { op, unsupported, implementedBy: 'rust-host' },
      });
    },
  );

  it('still serves the complete forms', async () => {
    await expect(
      app.dispatch(
        'test.record_result',
        {
          artifactId: id,
          evidenceKind: 'measured',
          observation: 'Climbed',
          result: 'passed',
          requirementRef: { artifactId: id, revisionId: id },
        },
        user,
        projectId,
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.NOT_FOUND });
    await expect(
      app.dispatch('bom.export', { format: 'csv' }, user, projectId),
    ).resolves.toHaveProperty('content');
    await expect(
      app.dispatch('artifact.list', { limit: 5 }, user, projectId),
    ).resolves.toHaveProperty('artifacts');
  });
});
