/** Development-only bridge. Uses real core operations on disposable fixture projects. */
import type { OmenflowApi } from './api';
import { useStore, type Lens } from './store';
import type { Project } from '@omenflow/contracts';
export async function installDesignPreview() {
  const bootstrap = (await fetch('/__omen_preview/bootstrap').then((r) => r.json())) as {
    token: string;
    path: string;
    projectId: string;
    previewRoot: string;
  };
  const events = new Set<(event: unknown) => void>();
  const source = new EventSource(`/__omen_preview/events?token=${bootstrap.token}`);
  source.onmessage = (message) => {
    for (const listener of events) listener(JSON.parse(message.data));
  };
  const hint = () => {
    useStore
      .getState()
      .toast(
        'info',
        'Available in the desktop app. This preview uses disposable example projects.',
      );
    return Promise.resolve();
  };
  const api: OmenflowApi = {
    command: (op, payload, opts) =>
      fetch('/__omen_preview/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Omen-Preview': bootstrap.token },
        body: JSON.stringify({ op, payload, opts }),
      }).then((r) => r.json()),
    setActiveProject: async (id) => {
      await api.command('__active', { id });
    },
    onEvent: (cb) => {
      events.add(cb);
      return () => {
        events.delete(cb);
      };
    },
    onTerminalData: () => () => {},
    onTerminalState: () => () => {},
    onJobProgress: () => () => {},
    pickDirectory: async (title) =>
      title === 'Choose project folder'
        ? `${bootstrap.previewRoot}/project-${crypto.randomUUID()}`
        : bootstrap.path,
    pickFile: async () => {
      await hint();
      return null;
    },
    saveFile: async (opts) =>
      `${bootstrap.previewRoot}/exports/${opts?.defaultPath ?? 'export.zip'}`,
    openExternal: async (url) => {
      const parsed = new URL(url);
      if (['http:', 'https:'].includes(parsed.protocol))
        window.open(url, '_blank', 'noopener,noreferrer');
    },
    revealPath: hint,
    toggleResearch: hint,
  };
  window.omenflow = api;
  document.documentElement.dataset.preview = 'true';
  const params = new URLSearchParams(location.search);
  const screen = params.get('screen');
  if (screen === 'launcher') return;
  const result = await api.command('project.open', { path: bootstrap.path });
  if (!result.ok) throw new Error('Could not open preview project');
  const opened = result.result as { project: Project; projectId: string };
  const state = useStore.getState();
  state.set({ project: opened.project, projectPath: bootstrap.path });
  state.setActive(opened.projectId);
  await useStore.getState().refreshAll();
  if (params.get('theme') === 'light' || params.get('theme') === 'dark')
    state.set({ theme: params.get('theme') as 'light' | 'dark' });
  if (screen && ['parts', 'timeline', 'files'].includes(screen))
    state.go({ level: 'project', lens: screen as Lens });
  if (screen === 'decide') state.decide(null);
  if (screen === 'agent') state.go({ level: 'agent' });
  if (screen === 'system') state.go({ level: 'system' });
  const type = params.get('object');
  const target = type ? useStore.getState().artifacts.find((v) => v.artifact.type === type) : null;
  if (target) state.focus(target.artifact.id);
  if (params.get('console') === 'open') state.set({ agentWindowOpen: true });
}
