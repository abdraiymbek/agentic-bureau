import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreApp, nullHost } from './index.js';
import { changesSince, projectSummary } from './summary.js';

const apps: CoreApp[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.closeAll();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function setup(intent = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-context-budget-'));
  roots.push(root);
  const app = new CoreApp(path.join(root, 'app'), nullHost);
  apps.push(app);
  const { projectId } = (await app.dispatch(
    'project.create',
    { name: 'Budget test', intent, path: path.join(root, 'project') },
    { kind: 'user' },
  )) as { projectId: string };
  return app.contextFor(projectId);
}

describe('bounded agent context and gap-free event cursors', () => {
  it('reads more than1000 events exactly once with either nextCursor or legacy latest', async () => {
    const ctx = await setup();
    for (let i = 0; i < 1205; i++) ctx.emit('audit.marker', 'system', { i });
    const highWater = ctx.repo.latestEventSeq();
    for (const cursorField of ['nextCursor', 'latest'] as const) {
      let cursor = 0;
      const events: number[] = [];
      for (let page = 0; page < 10; page++) {
        const result = changesSince(ctx, cursor);
        expect(result.highWater).toBe(highWater);
        expect(result.nextCursor).toBe(result.latest);
        expect(result.events.length).toBeLessThanOrEqual(500);
        events.push(...result.events.map((event) => event.seq));
        cursor = result[cursorField];
        if (!result.hasMore) break;
      }
      expect(events).toEqual(Array.from({ length: highWater }, (_, i) => i + 1));
      expect(cursor).toBe(highWater);
      expect(changesSince(ctx, cursor)).toMatchObject({
        events: [],
        nextCursor: cursor,
        latest: cursor,
        hasMore: false,
      });
    }
  });

  it('honors a1000-character budget for long scalars and retains usable identity/detail handles', async () => {
    const ctx = await setup('engineering intent "\\\n'.repeat(3000));
    ctx.repo.updateProject({ name: 'Project name '.repeat(2000) });
    const summary = projectSummary(ctx, 1000);
    expect(JSON.stringify(summary).length).toBeLessThanOrEqual(1000);
    expect(summary.project.id).toBe(ctx.projectId);
    expect(summary.truncated).toBe(true);
    expect(summary.detailTools).toContain('artifact.read');
    expect(summary.project.intent.length).toBeLessThan(ctx.handle.project.intent.length);
  });
});
