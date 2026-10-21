/** Real local host transport. Deterministic JSON executable; never calls a paid model. */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatRecord } from '@omenflow/contracts';
import { RustCore, type HostEvent } from './rust-core';
const USER = { kind: 'user' as const };
const roots: string[] = [];
const apps: RustCore[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.shutdown();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omen-chat-'));
  roots.push(root);
  const app = await RustCore.start(path.join(root, 'app'), { cli: process.execPath });
  apps.push(app);
  const project = (await app.dispatch(
    'project.create',
    { path: path.join(root, 'project'), name: 'Structured conversation' },
    USER,
  )) as { projectId: string };
  const script = path.join(root, 'structured-agent');
  fs.writeFileSync(
    script,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'codex-cli 0.100.0'; exit 0; fi\ncat >/dev/null\necho run >> '${root}/runs'\nprintf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"20 mm; Ω unknown until measured."}}' '{"type":"turn.completed"}'\n`,
    { mode: 0o755 },
  );
  await app.dispatch('connection.configure', { adapterId: 'codex', executablePath: script }, USER);
  return { root, app, projectId: project.projectId };
}
const send = {
  conversationId: 'conversation',
  requestId: 'request',
  adapterId: 'codex',
  text: 'Inspect exact quantities',
};
describe.skipIf(process.platform === 'win32')('structured chat host contract', () => {
  it('records real output, deduplicates accepted retries after restart, and keeps projects isolated', async () => {
    const { root, app, projectId } = await setup();
    await app.dispatch('chat.send', send, USER, projectId);
    let record!: ChatRecord;
    await expect
      .poll(async () => {
        record = (await app.dispatch('chat.read', {}, USER, projectId)) as ChatRecord;
        return record.conversations[0]?.turns[0]?.state;
      })
      .toBe('completed');
    expect(record.conversations[0]?.turns[0]?.response).toBe('20 mm; Ω unknown until measured.');
    const terminal = (await app.dispatch('terminal.state', {}, USER, projectId)) as {
      session: unknown;
    };
    expect(terminal.session).toBeNull();
    const second = (await app.dispatch(
      'project.create',
      { path: path.join(root, 'second'), name: 'Other project' },
      USER,
    )) as { projectId: string };
    expect(await app.dispatch('chat.read', {}, USER, second.projectId)).toEqual({
      version: 1,
      conversations: [],
    });
    await app.shutdown();
    const restarted = await RustCore.start(path.join(root, 'app'), { cli: process.execPath });
    apps.push(restarted);
    await restarted.dispatch('project.open', { path: path.join(root, 'project') }, USER);
    const replay = (await restarted.dispatch('chat.send', send, USER, projectId)) as ChatRecord;
    expect(replay.conversations[0]?.turns).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, 'runs'), 'utf8').trim().split('\n')).toHaveLength(1);
    await expect(
      restarted.dispatch('chat.send', { ...send, text: 'Different request' }, USER, projectId),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
  it('announces each change to the record on the event stream, never the record itself', async () => {
    const { app, projectId } = await setup();
    const seen: HostEvent[] = [];
    const stop = app.subscribe((event) => seen.push(event));
    // The stream is live once an event recorded after subscribing shows up.
    await expect
      .poll(async () => {
        await app.dispatch(
          'artifact.create_draft',
          { type: 'note', title: 'Probe', payload: { markdown: 'Probe.' } },
          USER,
          projectId,
        );
        return seen.some((event) => event.name === 'event');
      })
      .toBe(true);
    const changes = () => seen.filter((event) => event.name === 'chat').map((event) => event.data);
    await app.dispatch('chat.send', send, USER, projectId);
    // Acceptance, the agent's text and the settled turn.
    await expect.poll(() => changes().length).toBe(3);
    stop();
    const record = (await app.dispatch('chat.read', {}, USER, projectId)) as ChatRecord;
    expect(record.conversations[0]?.turns[0]?.state).toBe('completed');
    const seqs = changes().map((change) => {
      expect(change).toEqual({ projectId, seq: expect.any(Number) });
      return (change as { seq: number }).seq;
    });
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(3);
  });
  it('lets one agent work in a project at a time', async () => {
    const { root, app, projectId } = await setup();
    const waiting = path.join(root, 'waiting-agent');
    fs.writeFileSync(
      waiting,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'codex-cli 0.100.0'; exit 0; fi\ncat >/dev/null\nwhile :; do sleep 1; done\n`,
      { mode: 0o755 },
    );
    await app.dispatch(
      'connection.configure',
      { adapterId: 'codex', executablePath: waiting },
      USER,
    );
    await app.dispatch(
      'connection.configure',
      { adapterId: 'custom', executablePath: '/bin/cat' },
      USER,
    );
    await app.dispatch('chat.send', send, USER, projectId);
    await expect(
      app.dispatch('terminal.start', { adapterId: 'custom' }, USER, projectId),
    ).rejects.toMatchObject({ code: 'BUSY' });
    await app.dispatch('chat.cancel', { conversationId: 'conversation' }, USER, projectId);
    await app.dispatch('terminal.start', { adapterId: 'custom' }, USER, projectId);
    await expect(
      app.dispatch('chat.send', { ...send, requestId: 'second' }, USER, projectId),
    ).rejects.toMatchObject({ code: 'BUSY' });
    await app.dispatch('terminal.stop', {}, USER, projectId);
  });
  it('keeps conversation transport user-only, with typed adapter and project errors', async () => {
    const { app, projectId } = await setup();
    await expect(
      app.dispatch(
        'chat.read',
        {},
        { kind: 'agent', sessionId: '00000000-0000-4000-8000-0000000000ca' },
        projectId,
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(
      app.dispatch('chat.send', { ...send, adapterId: 'opencode' }, USER, projectId),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(app.dispatch('chat.read', {}, USER, 'not-open')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      app.dispatch('chat.send', { ...send, text: '  ' }, USER, projectId),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
