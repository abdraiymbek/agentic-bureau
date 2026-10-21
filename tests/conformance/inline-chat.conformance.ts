/** Real CLI → authenticated bridge → durable turn-owned cards. No model calls. */
import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatRecord } from '@omenflow/contracts';
import { RustCore } from './rust-core';
const user = { kind: 'user' as const };
let app: RustCore | undefined;
let root: string;
afterEach(async () => {
  await app?.shutdown();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
it('persists validated agent cards into the actual owning turn and refuses unowned, foreign and executable props', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'omen-inline-'));
  const helper = path.resolve('native/omenflow-bridge/target/release/omenflow');
  app = await RustCore.start(path.join(root, 'app'), { cli: helper });
  const project = (await app.dispatch(
    'project.create',
    { path: path.join(root, 'project'), name: 'Deterministic inline conformance' },
    user,
  )) as { projectId: string };
  const pid = project.projectId;
  await app.dispatch(
    'connection.configure',
    {
      adapterId: 'codex',
      executablePath: path.resolve('tests/conformance/fixtures/inline-agent.py'),
      env: { OMEN_INLINE_HELPER: helper },
    },
    user,
  );
  await app.dispatch(
    'chat.send',
    {
      conversationId: 'owning-turn',
      requestId: 'rich-request',
      adapterId: 'codex',
      text: 'Run deterministic inline presentation fixture.',
    },
    user,
    pid,
  );
  let book!: ChatRecord;
  await expect
    .poll(
      async () => {
        book = (await app!.dispatch('chat.read', {}, user, pid)) as ChatRecord;
        return book.conversations[0]?.turns[0]?.response;
      },
      { timeout: 10000 },
    )
    .toContain('Deterministic fixture');
  expect(book.conversations[0]?.turns[0]?.state).toBe('running');
  await expect
    .poll(
      async () => {
        book = (await app!.dispatch('chat.read', {}, user, pid)) as ChatRecord;
        return book.conversations[0]?.turns[0]?.state;
      },
      { timeout: 15000 },
    )
    .toBe('completed');
  const turn = book.conversations[0]!.turns[0]!;
  expect(turn.parts?.map((p) => p.kind)).toEqual(['artifact', 'chart', 'form', 'choices']);
  expect(turn.response.match(/Deterministic fixture/g)).toHaveLength(1);
  expect(turn.parts?.every((p) => p.origin === 'agent')).toBe(true);
  const card = turn.parts![0]!;
  expect(card.kind).toBe('artifact');
  if (card.kind !== 'artifact') throw new Error('artifact missing');
  expect(card.revisionId).toBeTruthy();
  const beforeManual = JSON.stringify(turn);
  const manual = (await app.dispatch(
    'chat.open',
    {
      conversationId: 'owning-turn',
      part: { kind: 'artifact', artifactId: card.artifactId, revisionId: card.revisionId },
    },
    user,
    pid,
  )) as ChatRecord;
  expect(JSON.stringify(manual.conversations[0]?.turns[0])).toBe(beforeManual);
  expect(manual.conversations[0]?.cards?.[0]?.origin).toBe('user');
  book = manual;

  await expect(
    app.dispatch(
      'chat.present',
      { part: { kind: 'artifact', artifactId: card.artifactId } },
      { kind: 'agent', sessionId: '00000000-0000-4000-8000-000000000099' },
      pid,
    ),
  ).rejects.toMatchObject({ code: 'VALIDATION' });
  await expect(
    app.dispatch(
      'chat.open',
      {
        conversationId: 'bad',
        part: {
          kind: 'html',
          title: 'Unsafe',
          xLabel: 'X',
          xUnit: '',
          yLabel: 'Y',
          yUnit: '',
          source: 'test',
          provenance: 'illustrative',
          points: [
            { x: 0, y: 1 },
            { x: 1, y: 2 },
          ],
          html: '<script>bad()</script>',
        },
      },
      user,
      pid,
    ),
  ).rejects.toMatchObject({ code: 'VALIDATION' });
  const other = (await app.dispatch(
    'project.create',
    { path: path.join(root, 'other'), name: 'Other' },
    user,
  )) as { projectId: string };
  await expect(
    app.dispatch(
      'chat.open',
      {
        conversationId: 'foreign',
        part: { kind: 'artifact', artifactId: card.artifactId, revisionId: card.revisionId },
      },
      user,
      other.projectId,
    ),
  ).rejects.toBeTruthy();
  await app.dispatch('project.close', {}, user, pid);
  await app.dispatch('project.open', { path: path.join(root, 'project') }, user);
  expect(await app.dispatch('chat.read', {}, user, pid)).toEqual(book);
  await expect(
    app.dispatch(
      'proposal.approve',
      { proposalId: '00000000-0000-4000-8000-000000000001' },
      { kind: 'agent', sessionId: '00000000-0000-4000-8000-000000000099' },
      pid,
    ),
  ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
});

it('sends exact attached dimensions through the CLI into a real render and human review, and refuses stale or changed replay inputs', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'omen-inline-render-'));
  const helper = path.resolve('native/omenflow-bridge/target/release/omenflow');
  app = await RustCore.start(path.join(root, 'app'), { cli: helper });
  const project = (await app.dispatch(
    'project.create',
    { path: path.join(root, 'project'), name: 'Exact dimension conformance' },
    user,
  )) as { projectId: string };
  const pid = project.projectId;
  const source = fs.readFileSync(path.resolve('fixtures/rover/camera-tray.scad'), 'utf8');
  const initial = (await app.dispatch(
    'cad.write_source',
    { title: 'Camera tray', source, rationale: 'Known source fixture for actual engine test' },
    user,
    pid,
  )) as { artifactId: string; revisionId: string };
  await app.dispatch(
    'connection.configure',
    {
      adapterId: 'codex',
      executablePath: path.resolve('tests/conformance/fixtures/inline-agent.py'),
      env: { OMEN_INLINE_HELPER: helper },
    },
    user,
  );
  const input = {
    artifactId: initial.artifactId,
    revisionId: initial.revisionId,
    title: 'Camera tray',
    intent: 'render',
    fields: [
      { name: 'tray_width', text: '64.00', unit: 'mm', unknown: false },
      { name: 'tray_depth', text: '46', unit: 'mm', unknown: false },
    ],
  };
  const request = {
    conversationId: 'render-conversation',
    requestId: 'exact-request',
    adapterId: 'codex',
    text: 'Render these dimensions with the deterministic fixture and show the actual check and proposal.',
    input,
  };
  await app.dispatch('chat.send', request, user, pid);
  let book!: ChatRecord;
  await expect
    .poll(
      async () => {
        book = (await app!.dispatch('chat.read', {}, user, pid)) as ChatRecord;
        return book.conversations[0]?.turns[0]?.state;
      },
      { timeout: 30000 },
    )
    .toBe('completed');
  const turn = book.conversations[0]!.turns[0]!;
  expect(turn.input).toEqual(input);
  expect(turn.parts?.filter((c) => c.kind === 'artifact')).toHaveLength(1);
  const part = turn.parts!.find((c) => c.kind === 'artifact');
  if (!part || part.kind !== 'artifact') throw new Error('No rendered part');
  const result = (await app.dispatch(
    'artifact.read',
    { artifactId: part.artifactId, revisionId: part.revisionId, detail: 'full' },
    user,
    pid,
  )) as { revision: { payload: { params: Record<string, number>; renderIdentity: unknown } } };
  expect(result.revision.payload.params.tray_width).toBe(64);
  expect(result.revision.payload.params.tray_depth).toBe(46);
  expect(result.revision.payload.renderIdentity).toBeTruthy();
  expect(turn.parts?.some((c) => c.kind === 'review')).toBe(true);
  expect(
    ((await app.dispatch('chat.send', request, user, pid)) as ChatRecord).conversations[0]?.turns,
  ).toHaveLength(1);
  await expect(
    app.dispatch(
      'chat.send',
      {
        ...request,
        input: {
          ...input,
          fields: [{ name: 'tray_width', text: '65', unit: 'mm', unknown: false }],
        },
      },
      user,
      pid,
    ),
  ).rejects.toMatchObject({ code: 'VALIDATION' });
  await expect(
    app.dispatch('chat.send', { ...request, requestId: 'stale-new-request' }, user, pid),
  ).rejects.toMatchObject({ code: 'VALIDATION' });
});

it('reconciles multiple root Claude messages while excluding nested streams and aggregates', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'omen-inline-claude-'));
  app = await RustCore.start(path.join(root, 'app'), { cli: process.execPath });
  const { projectId } = (await app.dispatch(
    'project.create',
    { path: path.join(root, 'project'), name: 'Nested Claude protocol fixture' },
    user,
  )) as { projectId: string };
  const delta = (text: string) => ({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  });
  const aggregate = (text: string) => ({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  });
  const child = (record: object) => ({ ...record, parent_tool_use_id: 'child-tool' });
  const start = { type: 'stream_event', event: { type: 'message_start' } };
  const events = [
    start,
    delta('Root partial 12.40 mm Ω'),
    child(start),
    child(delta('INTERNAL CHILD PARTIAL')),
    child(aggregate('INTERNAL CHILD RESULT')),
    child({ type: 'result', subtype: 'success', result: 'Child result' }),
    aggregate('Root corrected 12.40 mm Ω'),
    start,
    delta('Second root partial.'),
    child(aggregate('SECOND CHILD RESULT')),
    aggregate('Second root corrected.'),
    { type: 'result', subtype: 'success', is_error: false, result: 'Second root corrected.' },
  ];
  const script = path.join(root, 'claude-json-fixture');
  fs.writeFileSync(
    script,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '2.1.287 (Claude Code)'; exit 0; fi\ncat >/dev/null\nprintf '%s\\n' ${events.map((event) => `'${JSON.stringify(event)}'`).join(' ')}\n`,
    { mode: 0o755 },
  );
  await app.dispatch(
    'connection.configure',
    { adapterId: 'claude-code', executablePath: script },
    user,
  );
  await app.dispatch(
    'chat.send',
    {
      conversationId: 'parent',
      requestId: 'parent-request',
      adapterId: 'claude-code',
      text: 'Deterministic root/nested protocol validation; no model.',
    },
    user,
    projectId,
  );
  let book!: ChatRecord;
  await expect
    .poll(async () => {
      book = (await app!.dispatch('chat.read', {}, user, projectId)) as ChatRecord;
      return book.conversations[0]?.turns[0]?.state;
    })
    .toBe('completed');
  expect(book.conversations[0]?.turns[0]?.response).toBe(
    'Root corrected 12.40 mm Ω\n\nSecond root corrected.',
  );
});
