import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@omenflow/contracts';
import { useStore } from '../../apps/desktop/src/renderer/store';
import {
  closeProject,
  enterProject,
  exportProject,
  importArchive,
  startAgent,
} from '../../apps/desktop/src/renderer/lib/actions';

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
  vi.stubGlobal('window', { omenflow: api, dispatchEvent: vi.fn() });
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
  vi.unstubAllGlobals();
  useStore.setState(initial);
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
