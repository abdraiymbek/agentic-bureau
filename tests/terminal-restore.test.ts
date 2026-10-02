import { describe, expect, it, vi } from 'vitest';
import { createTerminalRestore } from '../apps/desktop/src/renderer/lib/terminal-restore.js';
import { Scrollback } from '../packages/agent-host/src/pty.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('terminal history lifetime', () => {
  it('restores the replacement terminal after StrictMode disposes the first instance', async () => {
    const response = deferred<{ session: { scrollback: string; scrollbackCursor: number } }>();
    const read = vi.fn(() => response.promise);
    const disposedWrite = vi.fn();
    const currentWrite = vi.fn();
    const first = createTerminalRestore(read, disposedWrite);
    const pendingFirst = first.restore();
    first.dispose();
    const second = createTerminalRestore(read, currentWrite);
    const pendingSecond = second.restore();
    response.resolve({ session: { scrollback: 'existing agent output', scrollbackCursor: 2 } });
    await Promise.all([pendingFirst, pendingSecond]);
    expect(disposedWrite).not.toHaveBeenCalled();
    expect(currentWrite).toHaveBeenCalledTimes(1);
    expect(currentWrite).toHaveBeenCalledWith('existing agent output');
    await second.restore();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('retries missing sessions and service failures while coalescing pending requests', async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('service unavailable'))
      .mockResolvedValueOnce({ session: null })
      .mockResolvedValue({ session: { scrollback: 'reconnected', scrollbackCursor: 1 } });
    const write = vi.fn();
    const history = createTerminalRestore(read, write);
    await history.restore();
    await history.restore();
    await Promise.all([history.restore(), history.restore()]);
    expect(read).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('reconnected');
    history.dispose();
    await history.restore();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('replays only live frames newer than the snapshot cursor', async () => {
    const response = deferred<{ session: { scrollback: string; scrollbackCursor: number } }>();
    const write = vi.fn();
    const history = createTerminalRestore(() => response.promise, write);
    const pending = history.restore();
    history.acceptLive({ seq: 1, chunk: 'old-a' });
    history.acceptLive({ seq: 2, chunk: 'old-b' });
    history.acceptLive({ seq: 3, chunk: 'live-after' });
    history.acceptLive({ seq: 4, chunk: 'live-later' });
    response.resolve({ session: { scrollback: 'snap-a snap-b', scrollbackCursor: 2 } });
    await pending;
    expect(write.mock.calls.map((call) => call[0])).toEqual([
      'snap-a snap-b',
      'live-after',
      'live-later',
    ]);
    history.acceptLive({ seq: 2, chunk: 'stale-replay' });
    history.acceptLive({ seq: 5, chunk: 'newest' });
    expect(write.mock.calls.map((call) => call[0])).toEqual([
      'snap-a snap-b',
      'live-after',
      'live-later',
      'newest',
    ]);
  });
});

describe('session scrollback sequence', () => {
  it('keeps a monotonic cursor after the bounded buffer drops prefix chunks', () => {
    const buf = new Scrollback(8);
    expect(buf.push('aaaa')).toBe(1);
    expect(buf.push('bbbb')).toBe(2);
    expect(buf.push('cccc')).toBe(3);
    const snap = buf.snapshot();
    expect(snap.text).toBe('bbbbcccc');
    expect(snap.cursor).toBe(3);
    expect(buf.push('dd')).toBe(4);
    expect(buf.snapshot()).toEqual({ text: 'ccccdd', cursor: 4 });
  });
});

describe('terminal session replacement', () => {
  it('restarts the output cursor and ignores retired frames after restart', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        session: { id: 'old', scrollback: 'old output', scrollbackCursor: 900 },
      })
      .mockResolvedValueOnce({
        session: { id: 'new', scrollback: 'new output', scrollbackCursor: 1 },
      });
    const write = vi.fn();
    const reset = vi.fn();
    const history = createTerminalRestore(read, write, reset);
    await history.restore();
    history.selectSession('new');
    history.acceptLive({ sessionId: 'new', seq: 2, chunk: 'new live' });
    history.acceptLive({ sessionId: 'old', seq: 901, chunk: 'old late output' });
    await history.restore();
    history.acceptLive({ sessionId: 'new', seq: 3, chunk: 'still live' });
    expect(reset).toHaveBeenCalledOnce();
    expect(write.mock.calls.flat()).toEqual(['old output', 'new output', 'new live', 'still live']);
  });

  it('cannot apply an old in-flight snapshot to a replacement session', async () => {
    const stale = deferred<{ session: { id: string; scrollback: string } }>();
    const read = vi
      .fn()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({
        session: { id: 'new', scrollback: 'replacement', scrollbackCursor: 1 },
      });
    const write = vi.fn();
    const history = createTerminalRestore(read, write);
    history.selectSession('old');
    const pending = history.restore();
    history.selectSession('new');
    await history.restore();
    stale.resolve({ session: { id: 'old', scrollback: 'stale' } });
    await pending;
    history.acceptLive({ sessionId: 'new', seq: 2, chunk: 'live' });
    expect(write.mock.calls.flat()).toEqual(['replacement', 'live']);
  });
});
