import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRecord } from '@omenflow/contracts';
import type { ChatChange } from '../../apps/desktop/src/renderer/api';
import { useChat } from '../../apps/desktop/src/renderer/chat/chat-store';
import {
  CHANGE_GAP_MS,
  FALLBACK_MS,
  useChatSync,
} from '../../apps/desktop/src/renderer/chat/useChatSync';

const mounted = vi.hoisted(() => ({ cleanups: [] as (() => void)[] }));
// There is no DOM here: run an effect as a component's first commit would, and keep its cleanup
// for the unmount.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) mounted.cleanups.push(cleanup);
  },
}));

const command = vi.fn();
let listeners: Set<(change: ChatChange) => void>;
let response: string;
const record = (): ChatRecord => ({
  version: 1,
  conversations: [
    {
      id: 'conversation',
      title: 'Inspect dimensions',
      turns: [
        {
          requestId: 'request',
          text: 'Inspect dimensions',
          response,
          adapterId: 'codex',
          sessionId: 'session',
          state: 'running',
          error: null,
          createdAt: '2026-10-20T12:00:00Z',
        },
      ],
    },
  ],
});
const reads = () => command.mock.calls.filter(([op]) => op === 'chat.read').length;
const shown = () => useChat.getState().projects.p1?.record.conversations[0]?.turns[0]?.response;
const announce = (projectId: string, seq: number) => {
  for (const listener of listeners) listener({ projectId, seq });
};
const unmount = () => {
  for (const cleanup of mounted.cleanups.splice(0)) cleanup();
};

beforeEach(() => {
  vi.useFakeTimers();
  listeners = new Set();
  response = '';
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal('window', {
    omenflow: {
      command,
      onChat: (listener: (change: ChatChange) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
  command.mockReset().mockImplementation(async () => ({ ok: true, result: record() }));
  useChat.setState({ projects: {} });
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useChat.setState({ projects: {} });
});

describe('conversation sync', () => {
  it('reads the record when the host announces a change, and not on a timer', async () => {
    useChatSync('p1');
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(FALLBACK_MS - 1000);
    expect(reads()).toBe(1);

    response = 'Width is 20 mm';
    announce('p1', 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toBe(2);
    expect(shown()).toBe('Width is 20 mm');

    announce('p2', 2);
    await vi.advanceTimersByTimeAsync(CHANGE_GAP_MS * 5);
    expect(reads()).toBe(2);
  });

  it('streams a burst of changes as a few reads and never drops the last one', async () => {
    useChatSync('p1');
    await vi.advanceTimersByTimeAsync(0);
    let held: ((value: unknown) => void) | undefined;
    command.mockImplementation(
      () =>
        new Promise((resolve) => {
          held = resolve;
        }),
    );
    response = 'Width';
    announce('p1', 1);
    await vi.advanceTimersByTimeAsync(CHANGE_GAP_MS);
    expect(reads()).toBe(2);
    // More text streams while that read is out: it is not raced by a second one.
    for (let seq = 2; seq <= 40; seq += 1) announce('p1', seq);
    response = 'Width is 20 mm';
    await vi.advanceTimersByTimeAsync(CHANGE_GAP_MS * 3);
    expect(reads()).toBe(2);
    held!({ ok: true, result: { ...record(), conversations: [] } });
    command.mockImplementation(async () => ({ ok: true, result: record() }));
    await vi.advanceTimersByTimeAsync(CHANGE_GAP_MS);
    expect(reads()).toBe(3);
    expect(shown()).toBe('Width is 20 mm');
    await vi.advanceTimersByTimeAsync(CHANGE_GAP_MS * 5);
    expect(reads()).toBe(3);
  });

  it('falls back to a slow read without events, and stops when unmounted', async () => {
    useChatSync('p1');
    await vi.advanceTimersByTimeAsync(0);
    response = 'A change whose event was missed';
    await vi.advanceTimersByTimeAsync(FALLBACK_MS - CHANGE_GAP_MS);
    expect(reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(CHANGE_GAP_MS * 2);
    expect(reads()).toBe(2);
    expect(shown()).toBe('A change whose event was missed');

    unmount();
    expect(listeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(FALLBACK_MS * 2);
    expect(reads()).toBe(2);
  });
});
