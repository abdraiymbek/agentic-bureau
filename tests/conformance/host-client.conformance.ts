/**
 * The client contract itself: what every other conformance case relies on.
 * Error shape, the two origins, events, idempotent replay, and restart on the
 * same application data.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoreError, RustCore, type HostEvent } from './rust-core';

const USER = { kind: 'user' as const };
const AGENT = { kind: 'agent' as const, sessionId: '00000000-0000-4000-8000-0000000000c1' };

const roots: string[] = [];
const apps: RustCore[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.shutdown();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function start(root: string): Promise<RustCore> {
  const app = await RustCore.start(path.join(root, 'app'));
  apps.push(app);
  return app;
}

async function withProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-host-'));
  roots.push(root);
  const app = await start(root);
  const created = (await app.dispatch(
    'project.create',
    { path: path.join(root, 'project'), name: 'Host client', intent: 'conformance' },
    USER,
  )) as { projectId: string };
  return { root, app, projectId: created.projectId };
}

const note = (title: string) => ({ type: 'note', title, payload: { markdown: `${title}.` } });

describe('errors', () => {
  it('reject with code, message, repair and details', async () => {
    const { app, projectId } = await withProject();
    const failure = await app.dispatch('artifact.read', {}, USER, projectId).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CoreError);
    expect(failure).toBeInstanceOf(Error);
    const error = failure as CoreError;
    expect(error.code).toBe('VALIDATION');
    expect(error.message).toMatch(/artifactId/);
    expect(typeof error.repair).toBe('string');
    expect((error.details as { issues: { path: string }[] }).issues[0]!.path).toBe('artifactId');
    await expect(app.dispatch('artifact.list', {}, USER, 'not-open')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('the raw command envelope is the one the desktop renderer receives', async () => {
    const { app, projectId } = await withProject();
    const ok = await app.command('artifact.list', {}, projectId);
    expect(Object.keys(ok).sort()).toEqual(['ok', 'requestId', 'result']);
    expect(ok.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const failed = await app.command('artifact.read', {}, projectId);
    expect(Object.keys(failed).sort()).toEqual(['error', 'ok', 'requestId']);
    expect(failed.ok).toBe(false);
  });
});

describe('origins', () => {
  it('agent calls take the bridge and are recorded as agent work', async () => {
    const { app, projectId } = await withProject();
    const drafted = (await app.dispatch(
      'artifact.create_draft',
      note('Agent draft'),
      AGENT,
      projectId,
    )) as { artifact: { id: string }; revision: { origin: string; id: string } };
    expect(drafted.revision.origin).toBe('agent');
    const byUser = (await app.dispatch(
      'artifact.create_draft',
      note('My draft'),
      USER,
      projectId,
    )) as {
      revision: { origin: string };
    };
    expect(byUser.revision.origin).toBe('user');

    // Human-only operations are refused on the agent path, by the bridge itself.
    await expect(
      app.dispatch(
        'artifact.accept_draft',
        { artifactId: drafted.artifact.id, draftRevisionId: drafted.revision.id },
        AGENT,
        projectId,
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(app.dispatch('terminal.state', {}, AGENT, projectId)).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
    });
    // An agent session is bound to one project and cannot be issued for another.
    await expect(
      app.dispatch('project.summary', {}, AGENT, '00000000-0000-4000-8000-00000000dead'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(app.dispatch('project.summary', {}, AGENT)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(
      app.dispatch('artifact.list', {}, { kind: 'system' }, projectId),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('research answers with the typed unavailable error on both paths', async () => {
    const { app, projectId } = await withProject();
    for (const origin of [USER, AGENT]) {
      await expect(
        app.dispatch('research.read_page', { url: 'https://example.com/' }, origin, projectId),
      ).rejects.toMatchObject({
        code: 'TOOL_MISSING',
        message: 'Research browsing is unavailable in the headless host',
        details: { host: 'headless' },
      });
    }
  });
});

describe('events', () => {
  it('every project event carries the project it belongs to, once', async () => {
    const { app, projectId } = await withProject();
    const seen: HostEvent[] = [];
    const stop = app.subscribe((event) => seen.push(event));
    const committed = (revisionId: string) =>
      seen.filter((event) => {
        const data = event.data as { type?: string; data?: { revisionId?: string } };
        return (
          event.name === 'event' &&
          data.type === 'revision.committed' &&
          data.data?.revisionId === revisionId
        );
      });
    // The stream is live once an event recorded after subscribing shows up.
    await expect
      .poll(async () => {
        const probe = (await app.dispatch(
          'artifact.create_draft',
          note('Probe'),
          USER,
          projectId,
        )) as { revision: { id: string } };
        return committed(probe.revision.id).length;
      })
      .toBeGreaterThan(0);
    const draft = (await app.dispatch(
      'artifact.create_draft',
      note('Watched'),
      USER,
      projectId,
    )) as {
      revision: { id: string };
    };
    await expect.poll(() => committed(draft.revision.id).length).toBe(1);
    const event = committed(draft.revision.id)[0]!.data as { projectId?: string; origin: string };
    expect(event.projectId).toBe(projectId);
    expect(event.origin).toBe('user');
    const seqs = seen.filter((e) => e.name === 'event').map((e) => (e.data as { seq: number }).seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    stop();
  });

  it('events from agent calls carry the project and the session too', async () => {
    const { app, projectId } = await withProject();
    const seen: HostEvent[] = [];
    const stop = app.subscribe((event) => seen.push(event));
    const agentEvents = () =>
      seen.filter((e) => e.name === 'event' && (e.data as { origin: string }).origin === 'agent');
    await expect
      .poll(async () => {
        await app.dispatch('artifact.create_draft', note('Agent probe'), AGENT, projectId);
        return agentEvents().length;
      })
      .toBeGreaterThan(0);
    stop();
    const event = agentEvents()[0]!.data as { projectId?: string; data: { sessionId?: string } };
    expect(event.projectId).toBe(projectId);
    expect(event.data.sessionId).toBe(AGENT.sessionId);
  });
});

describe('durability', () => {
  it('an idempotency key replays the first result on either path', async () => {
    const { app, projectId } = await withProject();
    for (const origin of [USER, AGENT]) {
      const key = `once-${origin.kind}`;
      const first = (await app.dispatch(
        'artifact.create_draft',
        note(`Once by ${origin.kind}`),
        origin,
        projectId,
        key,
      )) as { artifact: { id: string } };
      const replay = (await app.dispatch(
        'artifact.create_draft',
        note(`Once by ${origin.kind}`),
        origin,
        projectId,
        key,
      )) as { artifact: { id: string } };
      expect(replay.artifact.id).toBe(first.artifact.id);
    }
    const list = (await app.dispatch('artifact.list', {}, USER, projectId)) as {
      artifacts: unknown[];
    };
    expect(list.artifacts).toHaveLength(2);
  });

  it('restarts on the same application data with projects and recents intact', async () => {
    const { root, app, projectId } = await withProject();
    await app.dispatch('artifact.create_draft', note('Kept'), USER, projectId);
    const socketPath = app.socketPath;
    await app.shutdown();
    await expect(app.dispatch('artifact.list', {}, USER, projectId)).rejects.toThrow();

    const again = await start(root);
    expect(again.socketPath).toBe(socketPath);
    const recent = (await again.dispatch('app.recent_projects', {}, USER)) as {
      projects: string[];
    };
    expect(recent.projects).toHaveLength(1);
    const reopened = (await again.dispatch('project.open', { path: recent.projects[0] }, USER)) as {
      projectId: string;
    };
    expect(reopened.projectId).toBe(projectId);
    const list = (await again.dispatch('artifact.list', {}, USER, projectId)) as {
      artifacts: { artifact: { title: string } }[];
    };
    expect(list.artifacts.map((v) => v.artifact.title)).toEqual(['Kept']);
  });
});
