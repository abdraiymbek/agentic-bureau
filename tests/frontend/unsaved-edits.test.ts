import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestLeave, unsavedEdits } from '../../apps/desktop/src/renderer/lib/unsaved-edits';
import {
  clearAllUnsaved,
  confirmLeave,
  listUnsaved,
  setLeavePrompt,
  type LeaveRequest,
} from '../../apps/desktop/src/renderer/lib/dirty';

// Object edits answer to the frame's one prompt (`lib/dirty.ts`), so these tests install that
// prompt; `proceed` is its "Discard and …" and `cancel` its "Keep editing".
const entry = (key: string, mounted = true) => ({
  key,
  label: `requirement “${key}”`,
  mounted,
  snapshot: { form: key },
});

afterEach(() => {
  unsavedEdits.clear();
  clearAllUnsaved();
  setLeavePrompt(null);
});

describe('leaving with unsaved edits', () => {
  it('proceeds at once when nothing is being edited', () => {
    const proceed = vi.fn();
    requestLeave(proceed);
    expect(proceed).toHaveBeenCalledTimes(1);
  });
  it('asks first, and leaves only after an explicit discard', () => {
    const asked: LeaveRequest[] = [];
    setLeavePrompt((request) => asked.push(request));
    unsavedEdits.put(entry('p:a:stage'));
    const proceed = vi.fn();
    requestLeave(proceed, 'show r3');
    expect(proceed).not.toHaveBeenCalled();
    expect(asked[0]!.labels).toEqual(['requirement “p:a:stage”']);
    expect(asked[0]!.action).toBe('show r3');
    // Staying is not calling discard: the edits are still registered.
    expect(unsavedEdits.peek('p:a:stage')).toBeDefined();
    asked[0]!.proceed();
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(unsavedEdits.peek('p:a:stage')).toBeUndefined();
  });
  it('tells every editor when its edits were discarded', () => {
    setLeavePrompt((request) => request.proceed());
    const heard = vi.fn();
    const stop = unsavedEdits.subscribe(heard);
    unsavedEdits.put(entry('p:a:stage'));
    heard.mockClear();
    requestLeave(() => {});
    expect(heard).toHaveBeenCalled();
    stop();
  });
  it('does not ask about edits parked by an editor that is gone', () => {
    setLeavePrompt(() => {
      throw new Error('should not ask');
    });
    unsavedEdits.put(entry('p:a:stage'));
    unsavedEdits.park('p:a:stage');
    const proceed = vi.fn();
    requestLeave(proceed);
    expect(proceed).toHaveBeenCalled();
    // The parked edits are still there for the editor's return.
    expect(unsavedEdits.peek('p:a:stage')).toMatchObject({
      mounted: false,
      snapshot: { form: 'p:a:stage' },
    });
    expect(unsavedEdits.open()).toEqual([]);
    expect(unsavedEdits.list()).toHaveLength(1);
  });
  it('parks only what is registered and drops what was saved', () => {
    unsavedEdits.park('missing');
    expect(unsavedEdits.list()).toEqual([]);
    unsavedEdits.put(entry('p:a:stage'));
    unsavedEdits.drop('p:a:stage');
    expect(unsavedEdits.list()).toEqual([]);
    expect(listUnsaved()).toEqual([]);
  });
});

describe('object edits in the frame registry', () => {
  it('stop a frame navigation until the person chooses, and stay when they keep editing', async () => {
    const asked: LeaveRequest[] = [];
    setLeavePrompt((request) => asked.push(request));
    unsavedEdits.put(entry('p:a:stage'));
    expect(listUnsaved().map((w) => w.label)).toEqual(['requirement “p:a:stage”']);
    const leaving = confirmLeave('close the project');
    asked[0]!.cancel();
    expect(await leaving).toBe(false);
    expect(unsavedEdits.peek('p:a:stage')).toMatchObject({ mounted: true });
  });
  it('are dropped with the frame registry when the person discards', async () => {
    setLeavePrompt((request) => request.proceed());
    unsavedEdits.put(entry('p:a:stage'));
    expect(await confirmLeave('open Camera tray')).toBe(true);
    expect(unsavedEdits.list()).toEqual([]);
  });
  it('leave the frame registry when parked, and are cleared with the project', () => {
    unsavedEdits.put(entry('p:a:stage'));
    unsavedEdits.put(entry('p:b:stage'));
    unsavedEdits.park('p:a:stage');
    expect(listUnsaved().map((w) => w.id)).toEqual(['object-edit:p:b:stage']);
    unsavedEdits.clear();
    expect(unsavedEdits.list()).toEqual([]);
    expect(listUnsaved()).toEqual([]);
  });
});
