import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addLeaveGuard,
  clearAllUnsaved,
  clearUnsaved,
  confirmLeave,
  guardLeave,
  hasUnsavedWork,
  heldArtifactIds,
  listUnsaved,
  markUnsaved,
  setLeavePrompt,
  subscribeUnsaved,
  type LeaveRequest,
} from '../../apps/desktop/src/renderer/lib/dirty';

let requests: LeaveRequest[] = [];
const removeGuards: (() => void)[] = [];

afterEach(() => {
  clearAllUnsaved();
  for (const remove of removeGuards.splice(0)) remove();
  setLeavePrompt(null);
  requests = [];
  vi.unstubAllGlobals();
});

const usePrompt = () => setLeavePrompt((r) => requests.push(r));

describe('unsaved-work registry', () => {
  it('records, relabels and clears work, telling listeners only about real changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeUnsaved(listener);
    markUnsaved('a', 'Payload capacity: statement');
    markUnsaved('a', 'Payload capacity: statement');
    expect(listener).toHaveBeenCalledTimes(1);
    markUnsaved('a', 'Payload capacity: statement and target', { holdArtifactIds: ['x'] });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listUnsaved()).toEqual([
      { id: 'a', label: 'Payload capacity: statement and target', holdArtifactIds: ['x'] },
    ]);
    expect([...heldArtifactIds()]).toEqual(['x']);
    clearUnsaved('a');
    clearUnsaved('a');
    expect(listener).toHaveBeenCalledTimes(3);
    expect(hasUnsavedWork()).toBe(false);
    unsubscribe();
  });

  it('lets navigation through at once when nothing is unsaved', () => {
    usePrompt();
    const proceed = vi.fn();
    guardLeave(proceed);
    expect(proceed).toHaveBeenCalledOnce();
    expect(requests).toEqual([]);
  });

  it('asks with every label, and discarding clears the registry before leaving', () => {
    usePrompt();
    markUnsaved('a', 'Payload capacity: target value');
    markUnsaved('b', 'Camera tray: notes');
    const proceed = vi.fn();
    guardLeave(proceed, { action: 'close the project' });
    expect(proceed).not.toHaveBeenCalled();
    expect(requests[0]!.labels).toEqual(['Payload capacity: target value', 'Camera tray: notes']);
    expect(requests[0]!.action).toBe('close the project');
    requests[0]!.proceed();
    expect(proceed).toHaveBeenCalledOnce();
    expect(listUnsaved()).toEqual([]);
  });

  it('keeps everything when the person chooses to keep editing', async () => {
    usePrompt();
    markUnsaved('a', 'Payload capacity: target value');
    const decision = confirmLeave('open another project');
    requests[0]!.cancel();
    await expect(decision).resolves.toBe(false);
    expect(listUnsaved()).toHaveLength(1);
  });

  it('falls back to the platform dialog, and refuses to discard without any way to ask', () => {
    markUnsaved('a', 'Payload capacity: target value');
    const proceed = vi.fn();
    const cancel = vi.fn();
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    guardLeave(proceed, { cancel });
    expect(cancel).toHaveBeenCalledOnce();
    vi.stubGlobal('confirm', undefined);
    guardLeave(proceed, { cancel });
    expect(cancel).toHaveBeenCalledTimes(2);
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    guardLeave(proceed, { cancel });
    expect(proceed).toHaveBeenCalledOnce();
  });

  it('chains another registry’s prompt after its own, asking each once', () => {
    usePrompt();
    let otherDirty = true;
    const ask = vi.fn((proceed: () => void) => proceed());
    removeGuards.push(addLeaveGuard({ isDirty: () => otherDirty, ask }));
    expect(hasUnsavedWork()).toBe(true);
    markUnsaved('a', 'Payload capacity: target value');
    const proceed = vi.fn();
    guardLeave(proceed);
    expect(ask).not.toHaveBeenCalled();
    requests[0]!.proceed();
    // The other registry still reports dirty work after its own prompt; it is not asked again.
    expect(ask).toHaveBeenCalledOnce();
    expect(proceed).toHaveBeenCalledOnce();
    otherDirty = false;
    guardLeave(proceed);
    expect(proceed).toHaveBeenCalledTimes(2);
  });
});
