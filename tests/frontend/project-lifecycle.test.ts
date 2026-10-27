import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@bureau/contracts';
import { useStore } from '../../apps/desktop/src/renderer/store';
import {
  closeProject,
  enterProject,
  exportProject,
  importArchive,
  openProjectAt,
  startAgent,
} from '../../apps/desktop/src/renderer/lib/actions';
import {
  clearAllUnsaved,
  listUnsaved,
  markUnsaved,
} from '../../apps/desktop/src/renderer/lib/dirty';

const project = { id: 'one', name: 'First' } as Project;
const command = vi.fn();
const api = {
  command,
  setActiveProject: vi.fn().mockResolvedValue(undefined),
  saveFile: vi.fn(),
  pickFile: vi.fn().mockResolvedValue('/archive.zip'),
  pickDirectory: vi.fn().mockResolvedValue('/copy'),
  dispatchEvent: vi.fn(),
};
const initial = useStore.getState();
beforeEach(() => {
  vi.stubGlobal('window', { bureau: api, dispatchEvent: vi.fn() });
  vi.stubGlobal(
    'CustomEvent',
    class {
      constructor(
        public type: string,
        public detail: unknown,
      ) {}
    },
  );
  vi.clearAllMocks();
  command.mockResolvedValue({ ok: true, result: {} });
  useStore.setState({
    ...initial,
    projectId: 'one',
    project,
    projectPath: '/one',
    refreshAll: vi.fn().mockResolvedValue(undefined),
    refreshSession: vi.fn().mockResolvedValue(undefined),
    toast: vi.fn(),
  });
});
afterEach(() => {
  clearAllUnsaved();
  vi.unstubAllGlobals();
  useStore.setState(initial);
});

const opened = { ok: true, result: { project: { ...project, id: 'two' }, projectId: 'two' } };
/** Waits for the leave prompt and answers it. */
async function answerLeave(discard: boolean) {
  await vi.waitFor(() => expect(useStore.getState().leavePrompt).not.toBeNull());
  useStore.getState().resolveLeavePrompt(discard);
}

describe('leaving unsaved edits for another project', () => {
  beforeEach(() => markUnsaved('requirement:a1', 'Payload capacity: target value'));

  it('does not ask, and keeps the edits, when the folder picker is cancelled', async () => {
    api.pickDirectory.mockResolvedValueOnce(null);
    await expect(openProjectAt()).resolves.toBe(false);
    expect(useStore.getState().leavePrompt).toBeNull();
    expect(listUnsaved()).toHaveLength(1);
    expect(command).not.toHaveBeenCalled();
  });

  it('does not ask, and keeps the edits, when the folder does not open', async () => {
    command.mockResolvedValueOnce({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Not a Bureau project' },
    });
    await expect(openProjectAt('/two')).rejects.toThrow('Not a Bureau project');
    expect(useStore.getState().leavePrompt).toBeNull();
    expect(useStore.getState().projectId).toBe('one');
    expect(listUnsaved()).toHaveLength(1);
  });

  it('closes the other project again and keeps the edits when the person stays', async () => {
    command.mockResolvedValueOnce(opened);
    const opening = openProjectAt('/two');
    await answerLeave(false);
    await expect(opening).resolves.toBe(false);
    expect(command).toHaveBeenLastCalledWith('project.close', {}, { projectId: 'two' });
    expect(useStore.getState().projectId).toBe('one');
    expect(listUnsaved()).toHaveLength(1);
  });

  it('discards the edits only as the switch happens', async () => {
    command.mockResolvedValueOnce(opened);
    const opening = openProjectAt('/two');
    await answerLeave(true);
    await expect(opening).resolves.toBe(true);
    expect(command).toHaveBeenCalledWith('project.close', {}, { projectId: 'one' });
    expect(useStore.getState().projectId).toBe('two');
    expect(listUnsaved()).toEqual([]);
  });

  it('keeps the edits when the project close fails after the person chose to discard', async () => {
    command.mockRejectedValueOnce(new Error('Disk unavailable'));
    const closing = closeProject();
    await answerLeave(true);
    await expect(closing).rejects.toThrow('Disk unavailable');
    expect(useStore.getState().projectId).toBe('one');
    expect(listUnsaved()).toHaveLength(1);
  });
});

describe('project lifecycle', () => {
  it('waits for the native close and coalesces repeat clicks before clearing the UI', async () => {
    let finish!: (value: unknown) => void;
    command.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const closing = closeProject();
    const duplicate = closeProject();
    expect(useStore.getState().projectId).toBe('one');
    expect(command).toHaveBeenCalledOnce();
    expect(command).toHaveBeenCalledWith('project.close', {}, { projectId: 'one' });
    finish({ ok: true, result: {} });
    await Promise.all([closing, duplicate]);
    expect(useStore.getState().projectId).toBeNull();
  });

  it('keeps the current project visible if native close fails', async () => {
    command.mockRejectedValueOnce(new Error('Disk unavailable'));
    await expect(closeProject()).rejects.toThrow('Disk unavailable');
    expect(useStore.getState().projectId).toBe('one');
  });

  it('closes the prior native project when switching and preserves read-only status', async () => {
    await enterProject(
      { project: { ...project, id: 'two' }, projectId: 'two', readOnly: true },
      '/two',
    );
    expect(command).toHaveBeenCalledWith('project.close', {}, { projectId: 'one' });
    expect(useStore.getState().projectId).toBe('two');
    expect(useStore.getState().readOnly).toBe(true);
    await expect(startAgent('custom')).rejects.toThrow('read-only');
    expect(command).toHaveBeenCalledOnce();
  });

  it('binds an export to the project that opened the save dialog', async () => {
    api.saveFile.mockImplementationOnce(async () => {
      useStore.setState({ projectId: 'two' });
      return '/export.zip';
    });
    command.mockResolvedValue({ ok: true, result: { files: 2 } });
    await exportProject('archive');
    expect(command).toHaveBeenCalledWith(
      'project.export_archive',
      { destPath: '/export.zip' },
      { projectId: 'one' },
    );
  });

  it('does not retry malformed archives as identity conflicts', async () => {
    command.mockResolvedValueOnce({
      ok: false,
      error: { code: 'VALIDATION', message: 'Bad archive' },
    });
    await expect(importArchive()).rejects.toThrow('Bad archive');
    expect(command).toHaveBeenCalledOnce();
  });

  it('imports a separate copy only for an explicit identity conflict', async () => {
    command
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'REVISION_CONFLICT', message: 'Already open' },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { project: { ...project, id: 'copy' }, projectId: 'copy' },
      });
    await importArchive();
    expect(command).toHaveBeenNthCalledWith(
      2,
      'project.import_archive',
      { archivePath: '/archive.zip', destDir: '/copy', newIdentity: true },
      undefined,
    );
    expect(useStore.getState().projectId).toBe('copy');
  });
});
