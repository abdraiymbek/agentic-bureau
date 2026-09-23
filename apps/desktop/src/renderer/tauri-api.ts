/** Narrow Tauri transport for the existing renderer contract. */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import type { OmenflowApi } from './api';

function subscription<T>(name: string, callback: (value: T) => void): () => void {
  let active = true;
  let unlisten: (() => void) | undefined;
  void listen<T>(name, (event) => {
    if (active) callback(event.payload);
  }).then((fn) => {
    if (active) unlisten = fn;
    else fn();
  });
  return () => {
    active = false;
    unlisten?.();
  };
}

export async function installTauriApi(): Promise<void> {
  let activeProject: string | null = null;
  const api: OmenflowApi = {
    command: (op, payload, opts) =>
      invoke('omenflow_command', {
        op,
        payload,
        projectId: opts?.projectId ?? activeProject,
        idempotencyKey: opts?.idempotencyKey,
      }),
    setActiveProject: async (id) => {
      activeProject = id;
    },
    onEvent: (callback) => subscription('omenflow:event', callback),
    onTerminalData: (callback) => subscription('omenflow:terminal:data', callback),
    onTerminalState: (callback) => subscription('omenflow:terminal:state', callback),
    onJobProgress: (callback) => subscription('omenflow:job:progress', callback),
    onServiceState: (callback) => {
      callback({ available: true });
      return subscription('omenflow:service-state', callback);
    },
    pickDirectory: (title) => open({ directory: true, multiple: false, title }),
    pickFile: (opts) =>
      open({ directory: false, multiple: false, title: opts?.title, filters: opts?.filters }),
    saveFile: (opts) => save({ defaultPath: opts?.defaultPath, filters: opts?.filters }),
    openExternal: async (url) => {
      const parsed = new URL(url);
      if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Unsupported URL');
      await openUrl(parsed.href);
    },
    revealPath: (path) => revealItemInDir(path),
    toggleResearch: () => invoke('toggle_research'),
  };
  window.omenflow = api;
}
