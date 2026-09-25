import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { artifactTypes, describeOp, validatePayload, type ArtifactType } from '@omenflow/contracts';
import { CoreApp, nullHost } from './index.js';
import { createEngineTools } from '@omenflow/engineering';
import payloads from '../../../tests/fixtures/artifact-payloads.json';

let root: string;
let app: CoreApp;
let projectId: string;
const user = { kind: 'user' as const };
const agent = { kind: 'agent' as const, sessionId: '00000000-0000-4000-8000-000000000010' };
const call = (op: string, payload: unknown) =>
  app.dispatch(op, payload, agent, projectId) as Promise<any>;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'omen-content-'));
  app = new CoreApp(path.join(root, 'app'), nullHost);
  app.engineTools = createEngineTools();
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
      await expect(
        call('artifact.create_draft', {
          type,
          title: 'Wrong payload',
          payload: { content: 'This must not disappear' },
        }),
      ).rejects.toThrow(/No recognized/);
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
          data: { artifactId: first.artifact.id, offerId: added.offer.id },
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
