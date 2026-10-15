/**
 * `packages/core/src/artifact-content.test.ts` against the Rust host. Every
 * call is agent-origin, so it travels the real bridge with a session token.
 * Assertions are the originals except where the Rust core deliberately says
 * more: an agent payload with an undeclared key is refused by name (not with
 * the "No recognized" guard text), and agent events record their session.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { artifactTypes, describeOp, validatePayload, type ArtifactType } from '@omenflow/contracts';
import { CoreError, RustCore } from './rust-core';
import payloads from '../fixtures/artifact-payloads.json';

let root: string;
let app: RustCore;
let projectId: string;
const user = { kind: 'user' as const };
const agent = { kind: 'agent' as const, sessionId: '00000000-0000-4000-8000-000000000010' };
const call = (op: string, payload: unknown) =>
  app.dispatch(op, payload, agent, projectId) as Promise<any>;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'omen-content-'));
  app = await RustCore.start(path.join(root, 'app'));
  const created = (await app.dispatch(
    'project.create',
    { path: path.join(root, 'project'), name: 'Artifact content' },
    user,
  )) as { projectId: string };
  projectId = created.projectId;
});
afterEach(async () => {
  await app.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('all artifact types retain agent-authored content', () => {
  it.each(artifactTypes)(
    '%s is discoverable, saved as a draft and readable without approval',
    async (type) => {
      const schema = describeOp('artifact.create_draft', type)?.payloadSchema as {
        properties: object;
      };
      expect(schema.properties).toBeDefined();
      const saved = await call('artifact.create_draft', {
        type,
        title: `Example ${type}`,
        payload: payloads[type],
      });
      const read = await call('artifact.read', {
        artifactId: saved.artifact.id,
        revisionId: saved.revision.id,
      });
      expect(read.revision.payload).toMatchObject(payloads[type]);
      expect(read.revision.reviewState).toBe('draft');
      expect(read.view.artifact.selectedRevisionId).toBeNull();
      expect(read.view.revision).toBeNull(); // renderer must explicitly load draft history
      const history = await call('artifact.history', { artifactId: saved.artifact.id });
      expect(history.revisions[0].payload).toEqual(read.revision.payload);
    },
  );
  it.each(['wiring', 'software', 'assembly', 'test', 'subsystem'] as ArtifactType[])(
    'rejects prose in an unrecognized %s field instead of silently saving empty content',
    async (type) => {
      const refused = await call('artifact.create_draft', {
        type,
        title: 'Wrong payload',
        payload: { content: 'This must not disappear' },
      }).then(
        () => null,
        (error: unknown) => error as CoreError,
      );
      expect(refused).toBeInstanceOf(CoreError);
      expect(refused!.code).toBe('VALIDATION');
      expect(refused!.message).toMatch(
        new RegExp(`^Invalid ${type} payload: content: unknown key`),
      );
      expect(refused!.repair).toContain('tool_describe');
      expect(refused!.details).toMatchObject({
        artifactType: type,
        issues: [{ path: 'content', kind: 'unknown_key' }],
      });
      const list = await call('artifact.list', {});
      expect(list.artifacts).toEqual([]);
      expect(() => validatePayload(type, {})).not.toThrow(); // incremental authoring remains compatible
    },
  );
  it('extends an unapproved draft without dropping its content, files, or ancestry', async () => {
    const first = await call('artifact.create_draft', {
      type: 'software',
      title: 'Firmware',
      payload: payloads.software,
      files: [
        {
          path: 'software/controller.py',
          contentBase64: Buffer.from('print("test")').toString('base64'),
        },
      ],
    });
    const second = await call('artifact.update_draft', {
      artifactId: first.artifact.id,
      title: 'Firmware revised',
    });
    expect(second.revision.parentId).toBe(first.revision.id);
    expect(second.revision.payload).toEqual(first.revision.payload);
    expect(second.revision.files).toEqual(first.revision.files);
  });
  it('publishes later offers so open component and Parts views can refresh', async () => {
    const first = await call('artifact.create_draft', {
      type: 'component',
      title: 'Controller',
      payload: payloads.component,
    });
    const added = await call('component.add_offer', {
      artifactId: first.artifact.id,
      seller: 'Supplier',
      url: 'https://example.com/new-offer',
      price: null,
    });
    const events = await call('project.changes_since', { seq: 0 });
    expect(events.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'component.offer_added',
          origin: 'agent',
          projectId,
          data: {
            artifactId: first.artifact.id,
            offerId: added.offer.id,
            sessionId: agent.sessionId,
          },
        }),
      ]),
    );
  });
  it('exposes the payload schema through the callable tool', async () => {
    const result = await call('tool.describe', {
      op: 'artifact.create_draft',
      artifactType: 'wiring',
    });
    expect(
      result.payloadSchema.properties.connections.items.properties.from.properties
        .componentRevisionId,
    ).toBeDefined();
  });
  it('retains candidate offers and product destinations outside the component payload', async () => {
    const saved = await call('component.add_candidate', {
      title: 'Controller',
      manufacturer: 'Example maker',
      partNumber: 'CTRL-12',
      offer: { seller: 'Example supplier', url: 'https://example.com/controller', price: null },
    });
    const result = await call('component.compare', { artifactIds: [saved.artifact.id] });
    expect(result.components[0].payload.partNumber).toBe('CTRL-12');
    expect(result.components[0].offers[0]).toMatchObject({
      url: 'https://example.com/controller',
      price: null,
      quantityBasis: 1,
    });
  });
  it('returns a diagram for an explicit unapproved wiring revision', async () => {
    const saved = await call('artifact.create_draft', {
      type: 'wiring',
      title: 'Supply',
      payload: payloads.wiring,
    });
    const result = await call('wiring.render', {
      artifactId: saved.artifact.id,
      revisionId: saved.revision.id,
    });
    expect(result.diagramSvg).toContain('<svg');
    expect(result.table).toHaveLength(1);
  });
});
