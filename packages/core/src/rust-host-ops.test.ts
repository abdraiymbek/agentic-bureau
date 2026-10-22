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
    [{ expect: { spec: [{ item: 'plate 40 x 30 x 5 mm', size: [40, 30, 5] }] } }, ['expect.spec']],
    [
      { requirementIds: ['00000000-0000-4000-8000-000000000002'], expect: { shells: 1 } },
      ['requirementIds'],
    ],
    [{}, ['expect omitted']],
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

  it('refuses a part linked to a requirement the Rust host makes spec items of', async () => {
    const draft = async (type: string, title: string, payload: unknown, inputs: unknown[] = []) =>
      (await app.dispatch(
        'artifact.create_draft',
        { type, title, payload, inputs },
        user,
        projectId,
      )) as { artifact: { id: string }; revision: { id: string } };
    const requirement = (target: unknown) => ({
      statement: 'Fits the bay',
      acceptanceCriterion: 'Measured',
      target,
    });
    const fits = await draft('requirement', 'Fits the bay', requirement({ value: 20, unit: 'mm' }));
    const carries = await draft('requirement', 'Carries', requirement({ value: 0.3, unit: 'kg' }));
    const link = (made: { artifact: { id: string }; revision: { id: string } }) => ({
      artifactId: made.artifact.id,
      revisionId: made.revision.id,
      relationship: 'validates',
    });
    const linked = await draft('mechanical', 'Plate', {}, [link(fits), link(carries)]);
    await expect(
      app.dispatch(
        'cad.check',
        { artifactId: linked.artifact.id, expect: { shells: 1 } },
        user,
        projectId,
      ),
    ).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION,
      message: 'cad.check with linked requirement "Fits the bay" is implemented by the Rust host',
      details: { unsupported: ['linked requirement "Fits the bay"'], implementedBy: 'rust-host' },
    });
    // A requirement no geometry check shows changes nothing here.
    const other = await draft('mechanical', 'Tray', {}, [link(carries)]);
    await expect(
      app.dispatch(
        'cad.check',
        { artifactId: other.artifact.id, expect: { shells: 1 } },
        user,
        projectId,
      ),
    ).rejects.not.toMatchObject({ details: { implementedBy: 'rust-host' } });
  });
});

describe('source writes with expect on the legacy TypeScript core', () => {
  const artifactId = '00000000-0000-4000-8000-000000000001';
  it.each([
    ['cad.write_source', { title: 'Plate', source: 'cube([40, 30, 5]);' }],
    ['cad.patch_source', { artifactId, oldString: '40', newString: '42' }],
    ['cad.set_param', { artifactId, name: 'w', value: 42 }],
  ])('%s refuses expect instead of saving the part unchecked', async (op, input) => {
    await expect(
      app.dispatch(op, { ...input, expect: { size: [40, 30, 5] } }, agent, projectId),
    ).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION,
      message: `${op} with expect is implemented by the Rust host`,
      repair: 'Call it through the desktop app, or write without expect and verify with cad_check.',
      details: { op, unsupported: ['expect'], implementedBy: 'rust-host' },
    });
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
      'artifact.history',
      { artifactId: id, fields: 'summary', limit: 20, cursor: '1' },
      ['fields', 'limit', 'cursor'],
    ],
    [
      'test.record_result',
      {
        artifactId: id,
        expectedRevisionId: id,
        evidenceKind: 'measured',
        observation: 'Observed',
        result: 'passed',
      },
      ['expectedRevisionId'],
    ],
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
    [
      'artifact.create_draft',
      {
        type: 'requirement',
        title: 'V-groove',
        payload: {
          statement: 'A V-groove',
          acceptanceCriterion: 'Measured',
          features: [{ label: 'Groove bottom Ø50' }],
        },
      },
      ['payload.features'],
    ],
    [
      'artifact.update_draft',
      { artifactId: id, payload: { features: [{ label: 'Groove bottom Ø50' }] } },
      ['payload.features'],
    ],
    [
      'artifact.apply_edit',
      {
        artifactId: id,
        baseRevisionId: id,
        payloadPatch: { features: [{ label: 'Groove bottom Ø50' }] },
        rationale: 'Add the groove',
      },
      ['payloadPatch.features'],
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

describe('cad.export inputs the legacy TypeScript core does not serve', () => {
  const artifactId = '00000000-0000-4000-8000-000000000001';
  it.each([
    [{ format: 'step' }, ['format step']],
    [{ revisionId: artifactId }, ['revisionId']],
    [
      { format: 'step', method: 'faceted', timeoutMs: 1000 },
      ['format step', 'method', 'timeoutMs'],
    ],
  ] as const)('refuses %j instead of writing less than was asked', async (input, unsupported) => {
    await expect(
      app.dispatch(
        'cad.export',
        { artifactId, destPath: '/tmp/x.step', ...input },
        user,
        projectId,
      ),
    ).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION,
      message: `cad.export with ${unsupported.join(', ')} is implemented by the Rust host`,
      details: { op: 'cad.export', unsupported, implementedBy: 'rust-host' },
    });
  });

  it('refuses every agent call: this core would write anywhere', async () => {
    await expect(
      app.dispatch('cad.export', { artifactId, destPath: 'exports/a.stl' }, agent, projectId),
    ).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION,
      message: 'cad.export for an agent is implemented by the Rust host',
      details: { op: 'cad.export', unsupported: ['agent origin'], implementedBy: 'rust-host' },
    });
  });

  it("still serves a person's STL copy", async () => {
    await expect(
      app.dispatch(
        'cad.export',
        { artifactId, destPath: path.join(root, 'a.stl') },
        user,
        projectId,
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.NOT_FOUND });
  });
});
