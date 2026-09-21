import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoreApp } from './app.js';
import { newId, type Origin } from '@omenflow/contracts';
import { MAX_INGEST_FILE_BYTES } from './artifacts.js';

const user: Origin = { kind: 'user' };
const agent: Origin = { kind: 'agent', sessionId: newId() };
const apps: CoreApp[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.closeAll();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omen-command-safety-'));
  roots.push(root);
  const app = new CoreApp(path.join(root, 'settings'));
  apps.push(app);
  const created = (await app.dispatch(
    'project.create',
    { name: 'Safety', path: path.join(root, 'project') },
    user,
  )) as { projectId: string };
  const ctx = app.contextFor(created.projectId);
  const call = (op: string, payload: unknown, origin: Origin = user, key?: string) =>
    app.dispatch(op, payload, origin, ctx.projectId, key);
  const note = () =>
    call(
      'artifact.create_draft',
      { type: 'note', title: 'Note', payload: { markdown: 'baseline' } },
      agent,
    ) as Promise<{ artifact: { id: string }; revision: { id: string } }>;
  return { app, ctx, root, call, note };
}

describe('command safety', () => {
  it('rejects invalid creation without orphan artifacts or externally published events', async () => {
    const { ctx, call } = await setup();
    const events: string[] = [];
    ctx.listeners.add((e) => events.push(e.type));
    await expect(
      call('artifact.create_draft', { type: 'requirement', title: 'Invalid', payload: {} }, agent),
    ).rejects.toThrow();
    expect(ctx.repo.listArtifacts()).toHaveLength(0);
    expect(events).toEqual([]);
  });
  it('validates paths before mutation and recovery intent', async () => {
    const { ctx, call, root } = await setup();
    const payload = {
      type: 'note',
      title: 'Unsafe',
      payload: { markdown: 'x' },
      files: [{ path: '../escape.txt', contentBase64: Buffer.from('x').toString('base64') }],
    };
    await expect(call('artifact.create_draft', payload, agent)).rejects.toThrow();
    await expect(
      call(
        'artifact.create_draft',
        { ...payload, files: [{ path: '.omenflow/state.sqlite', contentBase64: 'eA==' }] },
        agent,
      ),
    ).rejects.toThrow();
    fs.writeFileSync(path.join(root, 'outside.txt'), 'outside');
    await expect(
      call(
        'artifact.create_draft',
        {
          ...payload,
          files: [{ path: 'artifacts/a.txt', sourcePath: path.join(root, 'outside.txt') }],
        },
        agent,
      ),
    ).rejects.toThrow();
    expect(ctx.repo.listArtifacts()).toHaveLength(0);
    expect(ctx.repo.pendingMaterializations()).toHaveLength(0);
  });
  it('rejects ingest payloads larger than the transport frame', async () => {
    const { ctx, call } = await setup();
    await expect(
      call(
        'artifact.create_draft',
        {
          type: 'note',
          title: 'Huge',
          payload: { markdown: 'x' },
          files: [
            {
              path: 'artifacts/huge.bin',
              contentBase64: Buffer.alloc(MAX_INGEST_FILE_BYTES + 1).toString('base64'),
            },
          ],
        },
        agent,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(ctx.repo.listArtifacts()).toHaveLength(0);
  });
  it('serializes concurrent retries with the same operation key', async () => {
    const { ctx, call } = await setup();
    const p = { type: 'note', title: 'Once', payload: { markdown: 'x' } };
    const values = await Promise.all(
      Array.from({ length: 100 }, () => call('artifact.create_draft', p, agent, 'one')),
    );
    expect(new Set(values.map((v) => (v as { artifact: { id: string } }).artifact.id)).size).toBe(
      1,
    );
    expect(ctx.repo.listArtifacts()).toHaveLength(1);
    await expect(
      call('artifact.create_draft', { ...p, title: 'Different' }, agent, 'one'),
    ).rejects.toThrow('different payload');
  });
  it('does not partially propose an invalid change set', async () => {
    const { ctx, call, note } = await setup();
    const a = await note();
    await expect(
      call(
        'proposal.submit',
        {
          reason: 'invalid batch',
          changes: [
            {
              artifactId: a.artifact.id,
              newRevisionId: a.revision.id,
              baseRevisionId: null,
              kind: 'new_artifact',
            },
            {
              artifactId: newId(),
              newRevisionId: newId(),
              baseRevisionId: null,
              kind: 'new_artifact',
            },
          ],
        },
        agent,
      ),
    ).rejects.toThrow();
    expect(ctx.repo.getRevision(a.revision.id)?.reviewState).toBe('draft');
    expect(ctx.repo.listProposals()).toHaveLength(0);
  });
  it('does not trust caller-supplied new-artifact kind over an existing baseline', async () => {
    const { call, note } = await setup();
    const a = await note();
    await call('artifact.accept_draft', {
      artifactId: a.artifact.id,
      draftRevisionId: a.revision.id,
      rationale: 'baseline',
    });
    const b = (await call(
      'artifact.update_draft',
      { artifactId: a.artifact.id, payload: { markdown: 'change' } },
      agent,
    )) as { revision: { id: string } };
    await expect(
      call(
        'proposal.submit',
        {
          reason: 'bypass',
          changes: [
            {
              artifactId: a.artifact.id,
              newRevisionId: b.revision.id,
              baseRevisionId: null,
              kind: 'new_artifact',
            },
          ],
        },
        agent,
      ),
    ).rejects.toThrow();
  });
  it('rejects revision IDs belonging to another artifact', async () => {
    const { call, note } = await setup();
    const a = await note();
    const b = await note();
    await expect(
      call(
        'artifact.update_draft',
        { artifactId: a.artifact.id, draftRevisionId: b.revision.id, payload: { markdown: 'x' } },
        agent,
      ),
    ).rejects.toThrow();
    await expect(
      call('artifact.read', { artifactId: a.artifact.id, revisionId: b.revision.id }, agent),
    ).rejects.toThrow();
  });
  it('publishes events and writes materialized files only after commit; rolls back the outbox', async () => {
    const { ctx } = await setup();
    const seen: string[] = [];
    ctx.listeners.add((e) => seen.push(e.type));
    const sha = ctx.storeContent('durable');
    expect(() =>
      ctx.repo.tx(() => {
        ctx.emit('audit.uncommitted', 'system', {});
        ctx.materialize('artifacts/uncommitted.txt', sha);
        expect(seen).toEqual([]);
        expect(fs.existsSync(path.join(ctx.root, 'artifacts/uncommitted.txt'))).toBe(false);
        throw new Error('fault');
      }),
    ).toThrow('fault');
    expect(seen).toEqual([]);
    expect(ctx.repo.pendingMaterializations()).toHaveLength(0);
    ctx.repo.tx(() => {
      ctx.emit('audit.committed', 'system', {});
      ctx.materialize('artifacts/committed.txt', sha);
    });
    expect(seen).toEqual(['audit.committed']);
    expect(fs.readFileSync(path.join(ctx.root, 'artifacts/committed.txt'), 'utf8')).toBe('durable');
  });
  it('does not recover a project that is already live', async () => {
    const { app, ctx } = await setup();
    const j = ctx.createJob({ kind: 'audit', tool: 'audit' });
    ctx.jobStatus(j.id, 'running');
    await app.dispatch('project.open', { path: ctx.root }, user);
    expect(ctx.repo.getJob(j.id)?.status).toBe('running');
    expect(app.contexts.size).toBe(1);
  });
  it('cancelled job cannot become successful', async () => {
    const { ctx } = await setup();
    const j = ctx.createJob({ kind: 'audit', tool: 'audit' });
    ctx.cancelJob(j.id);
    ctx.jobStatus(j.id, 'succeeded');
    expect(ctx.repo.getJob(j.id)?.status).toBe('cancelled');
    expect(() => ctx.assertJobActive(j.id)).toThrow();
  });
  it('gates app-level origin and validates inputs', async () => {
    const { app, ctx, call } = await setup();
    await expect(call('project.rename', { name: 'agent rename' }, agent)).rejects.toThrow(
      'cannot call',
    );
    await expect(app.dispatch('project.create', { name: 4, path: ctx.root }, user)).rejects.toThrow(
      'Invalid input',
    );
    await expect(call('browser.open', { url: 'http://127.0.0.2/' }, agent)).rejects.toThrow();
  });
});
