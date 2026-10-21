import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRecord } from '@omenflow/contracts';
import { useChat } from '../../apps/desktop/src/renderer/chat/chat-store';
const command = vi.fn();
const record = (conversation: string, request: string, text = 'first'): ChatRecord => ({
  version: 1,
  conversations: [
    {
      id: conversation,
      title: text,
      turns: [
        {
          requestId: request,
          text,
          response: 'A recorded answer: 20 mm',
          adapterId: 'codex',
          sessionId: 'session',
          state: 'completed',
          error: null,
          createdAt: '2026-10-19T12:00:00Z',
        },
      ],
    },
  ],
});
let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal('window', { omenflow: { command } });
  command.mockReset().mockResolvedValue({ ok: true, result: { version: 1, conversations: [] } });
  useChat.setState({ projects: {} });
});
afterEach(() => {
  useChat.setState({ projects: {} });
  vi.unstubAllGlobals();
});
const project = () => useChat.getState().projects.p1!;
const text = () => project().drafts[project().activeId]?.text;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('durable chat composer and host acknowledgements', () => {
  it('preserves a newer typed draft when send acknowledgement is delayed', async () => {
    useChat.getState().draft('p1', 'first');
    const conversation = project().activeId;
    const wait = deferred<unknown>();
    command.mockImplementation((op) =>
      op === 'chat.send'
        ? wait.promise
        : Promise.resolve({ ok: true, result: record(conversation, request) }),
    );
    const sending = useChat.getState().send('p1', 'codex');
    const request = project().pending[conversation]!.requestId;
    useChat.getState().draft('p1', 'new text typed while confirming');
    wait.resolve({ ok: true, result: record(conversation, request) });
    await sending;
    expect(text()).toBe('new text typed while confirming');
    expect(project().pending[conversation]).toBeUndefined();
    expect(project().record.conversations[0]?.turns).toHaveLength(1);
  });
  it('clears only an unchanged submitted draft, including surrounding whitespace', async () => {
    useChat.getState().draft('p1', '  first  ');
    const conversation = project().activeId;
    command.mockImplementation((_op, payload) =>
      Promise.resolve({
        ok: true,
        result: record(
          conversation,
          payload.requestId ?? project().pending[conversation]?.requestId ?? 'req',
        ),
      }),
    );
    await useChat.getState().send('p1', 'codex');
    expect(text()).toBe('');
    expect(command.mock.calls[0]?.[1].text).toBe('  first  ');
  });
  it('keeps the new conversation, exact draft, original retry ID and newer text through failure and renderer reload', async () => {
    useChat.getState().newConversation('p1');
    const conversation = project().activeId;
    useChat.getState().draft('p1', 'original request');
    const wait = deferred<unknown>();
    command.mockReturnValueOnce(wait.promise);
    const sending = useChat.getState().send('p1', 'codex');
    const request = project().pending[conversation]!.requestId;
    useChat.getState().draft('p1', 'newer draft with units: 12.5 mm\nΩ unknown');
    wait.reject(new Error('Disconnected'));
    await sending;
    useChat.setState({ projects: {} });
    useChat.getState().ensure('p1');
    expect(project().activeId).toBe(conversation);
    expect(text()).toBe('newer draft with units: 12.5 mm\nΩ unknown');
    expect(project().pending[conversation]?.text).toBe('original request');
    expect(project().pending[conversation]?.requestId).toBe(request);
    command.mockImplementation(() =>
      Promise.resolve({ ok: true, result: record(conversation, request, 'original request') }),
    );
    await useChat.getState().send('p1', 'codex', project().pending[conversation]);
    const sends = command.mock.calls.filter(([op]) => op === 'chat.send');
    expect(sends[1]?.[1].requestId).toBe(request);
    expect(text()).toBe('newer draft with units: 12.5 mm\nΩ unknown');
  });
  it('keeps drafts and acknowledgements attached to their own thread and project', async () => {
    useChat.getState().draft('p1', 'first');
    const first = project().activeId;
    const wait = deferred<unknown>();
    command.mockReturnValueOnce(wait.promise);
    const sending = useChat.getState().send('p1', 'codex');
    const request = project().pending[first]!.requestId;
    useChat.getState().newConversation('p1');
    const second = project().activeId;
    useChat.getState().draft('p1', 'second thread');
    useChat.getState().draft('p2', 'other project');
    command.mockResolvedValue({ ok: true, result: record(first, request) });
    wait.resolve({ ok: true, result: record(first, request) });
    await sending;
    expect(project().activeId).toBe(second);
    expect(text()).toBe('second thread');
    const other = useChat.getState().projects.p2!;
    expect(other.drafts[other.activeId]?.text).toBe('other project');
    expect(other.record.conversations).toEqual([]);
    useChat.setState({ projects: {} });
    useChat.getState().ensure('p1');
    useChat.getState().ensure('p2');
    expect(project().activeId).toBe(second);
    expect(text()).toBe('second thread');
  });
  it('reconciles an accepted request via polling before a lost acknowledgement without clearing a newer draft', async () => {
    useChat.getState().draft('p1', 'first');
    const id = project().activeId;
    const wait = deferred<unknown>();
    command.mockReturnValueOnce(wait.promise);
    const sending = useChat.getState().send('p1', 'codex');
    const request = project().pending[id]!.requestId;
    useChat.getState().draft('p1', 'keep this');
    command.mockResolvedValue({ ok: true, result: record(id, request) });
    await useChat.getState().refresh('p1');
    expect(project().pending[id]).toBeUndefined();
    expect(text()).toBe('keep this');
    wait.reject(new Error('response lost'));
    await sending;
    await useChat.getState().refresh('p1');
    expect(text()).toBe('keep this');
    expect(project().pending[id]).toBeUndefined();
  });
  it('shows storage failure instead of claiming the draft is saved', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('full');
      },
    });
    useChat.getState().draft('p1', 'still visible');
    expect(text()).toBe('still visible');
    expect(project().storageError).toBe(true);
  });
});

it('merges exact values on the same revision and retains newer attachments across a lost send acknowledgement', async () => {
  const ref = {
    artifactId: 'part',
    revisionId: 'revision',
    title: 'Camera tray',
    intent: 'render' as const,
  };
  const field = (name: string, value: string) => ({
    name,
    text: value,
    unit: 'mm',
    unknown: false,
  });
  useChat
    .getState()
    .prepare('p1', 'Render these exact values', { ...ref, fields: [field('width', '12.40')] });
  useChat
    .getState()
    .prepare('p1', 'Render these exact values', { ...ref, fields: [field('height', '8')] });
  const id = project().activeId;
  expect(project().drafts[id]?.input?.fields).toEqual([
    field('width', '12.40'),
    field('height', '8'),
  ]);
  const wait = deferred<unknown>();
  command.mockImplementation((op) =>
    op === 'chat.send'
      ? wait.promise
      : Promise.resolve({ ok: true, result: { version: 1, conversations: [] } }),
  );
  const sending = useChat.getState().send('p1', 'codex');
  const pending = project().pending[id]!;
  useChat
    .getState()
    .prepare('p1', 'Render these exact values', { ...ref, fields: [field('width', '13.40')] });
  wait.reject(new Error('ACK lost'));
  await sending;
  expect(project().pending[id]?.input?.fields[0]?.text).toBe('12.40');
  expect(project().drafts[id]?.input?.fields[0]?.text).toBe('13.40');
  const accepted = record(id, pending.requestId, pending.text);
  accepted.conversations[0]!.turns[0]!.input = pending.input;
  const { acknowledge } = await import('../../apps/desktop/src/renderer/chat/chat-store');
  const next = acknowledge(project(), accepted);
  expect(next.drafts[id]?.input?.fields[0]?.text).toBe('13.40');
  expect(next.pending[id]).toBeUndefined();
  expect(command.mock.calls[0]?.[1].input).toEqual(pending.input);
});

it('opens real read-only references in temporary isolated context without rewriting history or saving inspection cards', async () => {
  useChat.getState().ensure('p1');
  const conversation = project().activeId;
  command.mockImplementation((op) =>
    Promise.resolve(
      op === 'chat.open'
        ? { ok: false, error: { code: 'READ_ONLY', message: 'Project is read-only' } }
        : op === 'artifact.read'
          ? {
              ok: true,
              result: {
                view: { artifact: { title: 'Recorded note' }, head: { id: 'revision' } },
                revision: {
                  id: 'revision',
                  artifactId: 'note',
                  payload: { markdown: 'Actual content' },
                },
              },
            }
          : { ok: true, result: { version: 1, conversations: [] } },
    ),
  );
  await useChat.getState().open('p1', { kind: 'artifact', artifactId: 'note' });
  const card = project().inspections[conversation]!.cards[0]!;
  expect(card).toMatchObject({
    kind: 'artifact',
    artifactId: 'note',
    revisionId: 'revision',
    origin: 'user',
  });
  expect(project().record.conversations).toEqual([]);
  await useChat.getState().refresh('p1');
  expect(project().inspections[conversation]!.cards[0]!.id).toBe(card.id);
  await useChat.getState().open('p1', { kind: 'artifact', artifactId: 'note' });
  expect(project().inspections[conversation]!.cards).toHaveLength(1);
  useChat.getState().newConversation('p1');
  expect(project().inspections[project().activeId]).toBeUndefined();
  expect(useChat.getState().projects.p2).toBeUndefined();
  expect([...storage.values()].join('')).not.toContain('Recorded note');
  useChat.setState({ projects: {} });
  useChat.getState().ensure('p1');
  expect(project().inspections).toEqual({});
});
