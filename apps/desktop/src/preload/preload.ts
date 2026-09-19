import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '@omenflow/contracts';

/**
 * Narrow renderer API. The renderer can invoke named ops and subscribe to
 * push channels — no filesystem, shell, or generic IPC.
 */
const api = {
  command: (op: string, payload: unknown, opts?: { projectId?: string; idempotencyKey?: string }) =>
    ipcRenderer.invoke(IPC.command, {
      op,
      payload,
      projectId: opts?.projectId,
      idempotencyKey: opts?.idempotencyKey,
    }),

  setActiveProject: (id: string | null) => ipcRenderer.invoke('omenflow:set-active-project', id),

  onEvent: (cb: (e: unknown) => void) => {
    const l = (_: unknown, data: unknown) => cb(data);
    ipcRenderer.on(IPC.event, l);
    return () => ipcRenderer.removeListener(IPC.event, l);
  },
  onTerminalData: (cb: (chunk: string) => void) => {
    const l = (_: unknown, data: unknown) => cb(data as string);
    ipcRenderer.on(IPC.terminalData, l);
    return () => ipcRenderer.removeListener(IPC.terminalData, l);
  },
  onTerminalState: (cb: (s: unknown) => void) => {
    const l = (_: unknown, data: unknown) => cb(data);
    ipcRenderer.on(IPC.terminalState, l);
    return () => ipcRenderer.removeListener(IPC.terminalState, l);
  },
  onJobProgress: (cb: (d: unknown) => void) => {
    const l = (_: unknown, data: unknown) => cb(data);
    ipcRenderer.on(IPC.jobProgress, l);
    return () => ipcRenderer.removeListener(IPC.jobProgress, l);
  },

  pickDirectory: (title?: string) => ipcRenderer.invoke(IPC.pickDirectory, { title }),
  pickFile: (opts?: { title?: string; filters?: { name: string; extensions: string[] }[] }) =>
    ipcRenderer.invoke(IPC.pickFile, opts),
  saveFile: (opts?: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) =>
    ipcRenderer.invoke(IPC.saveFile, opts),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
  revealPath: (p: string) => ipcRenderer.invoke(IPC.openPath, p),
  toggleResearch: () => ipcRenderer.invoke('omenflow:toggle-research'),
};

export type OmenflowApi = typeof api;
contextBridge.exposeInMainWorld('omenflow', api);
