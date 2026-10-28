import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeShutdownRequest, BureauApi } from '../../apps/desktop/src/renderer/api';
import {
  clearAllUnsaved,
  listUnsaved,
  markUnsaved,
  setLeavePrompt,
  type LeaveRequest,
} from '../../apps/desktop/src/renderer/lib/dirty';
import { installNativeShutdownGuard } from '../../apps/desktop/src/renderer/lib/native-shutdown';
import { unsavedEdits } from '../../apps/desktop/src/renderer/lib/unsaved-edits';

let receive: (request: NativeShutdownRequest) => void;
let prompts: LeaveRequest[];
let stop: () => void;
const reply = vi.fn().mockResolvedValue(undefined);
const api = {
  onShutdownRequest: (callback: typeof receive) => {
    receive = callback;
    return vi.fn();
  },
  replyToShutdown: reply,
} as unknown as BureauApi;

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  prompts = [];
  reply.mockClear();
  reply.mockResolvedValue(undefined);
  setLeavePrompt((request) => prompts.push(request));
  stop = installNativeShutdownGuard(api);
});

afterEach(() => {
  stop();
  unsavedEdits.clear();
  clearAllUnsaved();
  setLeavePrompt(null);
});

describe('native close and quit', () => {
  it('acknowledges receipt, then lets a clean workspace close without an edit prompt', async () => {
    receive({ requestId: 'close', action: 'close' });
    await flush();
    expect(prompts).toEqual([]);
    expect(reply.mock.calls).toEqual([
      ['close', 'received'],
      ['close', 'discard'],
    ]);
  });

  it('coalesces repeated requests and cancellation preserves typed work', async () => {
    markUnsaved('requirement', 'Payload: target');
    receive({ requestId: 'quit', action: 'quit' });
    receive({ requestId: 'quit', action: 'quit' });
    await flush();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.action).toBe('quit Bureau');
    expect(reply.mock.calls).toEqual([['quit', 'received']]);
    prompts[0]!.cancel();
    await flush();
    expect(reply).toHaveBeenLastCalledWith('quit', 'cancel');
    expect(listUnsaved()).toHaveLength(1);
    receive({ requestId: 'retry', action: 'close' });
    await flush();
    expect(prompts).toHaveLength(2);
  });

  it('includes parked edits and keeps every snapshot after discard until agent consent succeeds', async () => {
    markUnsaved('active', 'Camera tray: notes');
    unsavedEdits.put({
      key: 'p:a:stage',
      label: 'Payload: target',
      mounted: false,
      snapshot: { target: '250' },
    });
    receive({ requestId: 'quit', action: 'quit' });
    await flush();
    expect(prompts[0]!.labels).toEqual(['Camera tray: notes', 'Payload: target']);
    prompts[0]!.proceed();
    await flush();
    expect(reply).toHaveBeenLastCalledWith('quit', 'discard');
    expect(listUnsaved()).toHaveLength(1);
    expect(unsavedEdits.peek('p:a:stage')?.snapshot).toEqual({ target: '250' });
    // Declining the native agent dialog leaves the process alive. The next close asks again.
    receive({ requestId: 'retry', action: 'quit' });
    await flush();
    expect(prompts[1]!.labels).toEqual(['Camera tray: notes', 'Payload: target']);
  });

  it('asks even when every unsaved edit is parked', async () => {
    unsavedEdits.put({ key: 'p:a:stage', label: 'Parked draft', mounted: false, snapshot: 'text' });
    receive({ requestId: 'quit', action: 'quit' });
    await flush();
    expect(prompts[0]!.labels).toEqual(['Parked draft']);
    expect(reply).not.toHaveBeenCalledWith('quit', 'discard');
  });

  it('fails closed if delivery was already cancelled, and cancels an interrupted prompt', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    reply.mockRejectedValueOnce(new Error('Request expired'));
    receive({ requestId: 'expired', action: 'quit' });
    await flush();
    expect(prompts).toEqual([]);
    expect(reply).toHaveBeenLastCalledWith('expired', 'cancel');
    markUnsaved('active', 'Camera tray: notes');
    receive({ requestId: 'unmount', action: 'quit' });
    await flush();
    stop();
    expect(reply).toHaveBeenLastCalledWith('unmount', 'cancel');
    prompts[0]!.proceed();
    await flush();
    expect(reply).not.toHaveBeenCalledWith('unmount', 'discard');
    expect(listUnsaved()).toHaveLength(1);
    log.mockRestore();
  });
});
