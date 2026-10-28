import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RustCore } from './rust-core';

let root: string;
let app: RustCore;
let projectId: string;
const user = { kind: 'user' as const };
const agent = { kind: 'agent' as const, sessionId: '00000000-0000-4000-8000-000000000081' };
const call = (op: string, payload: unknown, origin = user as typeof user | typeof agent) =>
  app.dispatch(op, payload, origin, projectId) as Promise<any>;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-history-'));
  app = await RustCore.start(path.join(root, 'app'));
  const created = (await app.dispatch(
    'project.create',
    { path: path.join(root, 'project'), name: 'History' },
    user,
  )) as { projectId: string };
  projectId = created.projectId;
});
afterEach(async () => {
  await app.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('revision history and observation concurrency', () => {
  it('pages lightweight history without changing complete legacy reads', async () => {
    const first = await call('artifact.create_draft', {
      type: 'note',
      title: 'History',
      payload: { markdown: 'Initial context' },
    });
    const artifactId = first.artifact.id;
    for (let seq = 2; seq <= 19; seq++) {
      await call('artifact.update_draft', { artifactId, payload: { markdown: `Context ${seq}` } });
    }
    const whole = await call('artifact.history', { artifactId });
    expect(whole.revisions).toHaveLength(19);
    expect(whole.revisions[0].payload.markdown).toBe('Initial context');
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await call('artifact.history', {
        artifactId,
        fields: 'summary',
        limit: 7,
        cursor,
      });
      expect(page.total).toBe(19);
      expect(page.revisions.length).toBeLessThanOrEqual(7);
      for (const revision of page.revisions) {
        expect(revision).not.toHaveProperty('payload');
        expect(revision).not.toHaveProperty('files');
        expect(revision).not.toHaveProperty('inputs');
        seen.push(revision.id);
      }
      cursor = page.nextCursor ?? undefined;
      expect(page.hasMore).toBe(!!cursor);
    } while (cursor);
    expect(seen).toEqual(whole.revisions.map((revision: { id: string }) => revision.id));
  });

  it('agent truncation offers a continuation after the last history row shown', async () => {
    const first = await call('artifact.create_draft', {
      type: 'note',
      title: 'History',
      payload: { markdown: 'Context' },
    });
    const artifactId = first.artifact.id;
    for (let seq = 2; seq <= 75; seq++) {
      await call('artifact.update_draft', {
        artifactId,
        payload: { markdown: `Context ${seq}` },
        rationale: 'An engineering change with recorded context. '.repeat(15),
      });
    }
    let input: Record<string, unknown> = { artifactId, fields: 'summary', limit: 75 };
    const seen: number[] = [];
    let continuedAfterCut = false;
    for (;;) {
      const page = await call('artifact.history', input, agent);
      const rows = page.revisions as { seq: number }[];
      expect(rows.length).toBeGreaterThan(0);
      seen.push(...rows.map((revision) => revision.seq));
      const more = page.truncated?.more;
      if (more) {
        expect(more.args.cursor).toBe(String(seen.at(-1)));
        input = more.args;
        continuedAfterCut = true;
      } else if (page.hasMore) {
        input = { ...input, cursor: page.nextCursor };
      } else break;
      expect(seen.length).toBeLessThan(75);
    }
    expect(continuedAfterCut).toBe(true);
    expect(seen).toEqual(Array.from({ length: 75 }, (_, index) => index + 1));
  });

  it('refuses stale observations before attachments and keeps accepted results intact', async () => {
    const test = await call('test.create_draft', {
      title: 'Bench test',
      procedure: [{ step: 1, instruction: 'Measure the sample' }],
    });
    const artifactId = test.artifact.id;
    await call('artifact.accept_draft', { artifactId, draftRevisionId: test.revision.id });
    const observation = {
      artifactId,
      expectedRevisionId: test.revision.id,
      evidenceKind: 'measured',
      observation: 'Sample measured 12 mm',
      result: 'passed',
    };
    const saved = await call('test.record_result', observation);
    expect(saved.approved).toBe(true);
    const before = await call('artifact.history', { artifactId });
    await expect(
      call('test.record_result', {
        ...observation,
        attachments: [{ path: 'tests/stale.log', contentBase64: 'invalid!' }],
      }),
    ).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
      details: { expectedRevisionId: test.revision.id, currentRevisionId: saved.revision.id },
    });
    expect(await call('artifact.history', { artifactId })).toEqual(before);
    const proposed = await call(
      'test.record_result',
      {
        ...observation,
        expectedRevisionId: saved.revision.id,
        observation: 'Agent recorded the log',
      },
      agent,
    );
    expect(proposed.approved).toBe(false);
    const current = await call('artifact.read', { artifactId });
    expect(current.view.artifact.selectedRevisionId).toBe(saved.revision.id);
    expect(current.drafts[0].payload.results).toHaveLength(2);
  });
});
