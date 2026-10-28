import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RustCore, CoreError } from './rust-core';
import { useChat } from '../../apps/desktop/src/renderer/chat/chat-store';
let app: RustCore | undefined;
let root: string;
const user = { kind: 'user' as const };
afterEach(async () => {
  await app?.shutdown();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  useChat.setState({ projects: {} });
  vi.unstubAllGlobals();
});
it('keeps the read-only host gate while primary inline inspection reads actual source data ephemerally', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-inline-readonly-'));
  app = await RustCore.start(path.join(root, 'app'), { cli: process.execPath });
  const projectPath = path.join(root, 'project');
  const { projectId } = (await app.dispatch(
    'project.create',
    { name: 'Read-only inspection fixture', path: projectPath },
    user,
  )) as { projectId: string };
  const note = (await app.dispatch(
    'artifact.create_draft',
    {
      type: 'note',
      title: 'Recorded inspection note',
      payload: { markdown: 'Actual immutable content Ω' },
    },
    user,
    projectId,
  )) as { artifact: { id: string }; revision: { id: string } };
  await app.dispatch('project.close', {}, user, projectId);
  const marker = path.join(projectPath, 'bureau.project.json');
  fs.writeFileSync(
    marker,
    JSON.stringify({ ...JSON.parse(fs.readFileSync(marker, 'utf8')), version: 999 }),
  );
  const opened = (await app.dispatch('project.open', { path: projectPath }, user)) as {
    readOnly: boolean;
  };
  expect(opened.readOnly).toBe(true);
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  vi.stubGlobal('window', {
    bureau: {
      command: async (op: string, payload: unknown) => {
        try {
          return { ok: true, result: await app!.dispatch(op, payload, user, projectId) };
        } catch (e) {
          const error = e as CoreError;
          return { ok: false, error: { code: error.code, message: error.message } };
        }
      },
    },
  });
  await useChat.getState().open(projectId, {
    kind: 'artifact',
    artifactId: note.artifact.id,
    revisionId: note.revision.id,
  });
  const state = useChat.getState().projects[projectId]!;
  expect(state.inspections[state.activeId]?.cards[0]).toMatchObject({
    artifactId: note.artifact.id,
    revisionId: note.revision.id,
    origin: 'user',
  });
  expect(state.record.conversations).toEqual([]);
  const actual = (await app.dispatch(
    'artifact.read',
    { artifactId: note.artifact.id, revisionId: note.revision.id, detail: 'full' },
    user,
    projectId,
  )) as { revision: { payload: { markdown: string } } };
  expect(actual.revision.payload.markdown).toBe('Actual immutable content Ω');
  await expect(
    app.dispatch(
      'chat.open',
      { conversationId: 'cannot-write', part: { kind: 'artifact', artifactId: note.artifact.id } },
      user,
      projectId,
    ),
  ).rejects.toMatchObject({ code: 'READ_ONLY' });
  expect(fs.existsSync(path.join(projectPath, '.bureau/chat/conversations.json'))).toBe(false);
});
