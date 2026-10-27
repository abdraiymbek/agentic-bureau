/**
 * Development-only bridge. Runs the real Rust host on disposable fixture
 * projects: commands, project events, agent terminals, agent call records and
 * conversation changes all come from `bureau-host` through the preview server.
 */
import type { ChatChange, BureauApi } from './api';
import { useStore } from './store';
import { useChat } from './chat/chat-store';
import { lensDef } from './project/lenses';
import type { Project, SessionInfo } from '@bureau/contracts';

type Listener<T> = (value: T) => void;

/** Listeners for one kind of host event. */
function channel<T>() {
  const listeners = new Set<Listener<T>>();
  return {
    emit: (value: T) => {
      for (const listener of listeners) listener(value);
    },
    subscribe: (listener: Listener<T>) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export async function installDesignPreview() {
  const bootstrap = (await fetch('/__bureau_preview/bootstrap').then((r) => r.json())) as {
    token: string;
    path: string;
    projectId: string;
    previewRoot: string;
  };
  const events = channel<unknown>();
  const terminalData = channel<Parameters<Parameters<BureauApi['onTerminalData']>[0]>[0]>();
  const terminalState = channel<unknown>();
  const agentCalls = channel<unknown>();
  const chatChanges = channel<ChatChange>();
  const service = channel<{ available: boolean; message?: string }>();

  const hint = () => {
    useStore
      .getState()
      .toast(
        'info',
        'Available in the desktop app. This preview uses disposable example projects.',
      );
    return Promise.resolve();
  };
  const api: BureauApi = {
    command: (op, payload, opts) =>
      fetch('/__bureau_preview/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bureau-Preview': bootstrap.token },
        body: JSON.stringify({ op, payload, opts }),
      }).then((r) => r.json()),
    setActiveProject: async (id) => {
      await api.command('__active', { id });
    },
    onEvent: events.subscribe,
    onTerminalData: terminalData.subscribe,
    onTerminalState: terminalState.subscribe,
    onJobProgress: () => () => {},
    onServiceState: service.subscribe,
    onAgentCall: agentCalls.subscribe,
    onChat: chatChanges.subscribe,
    // The launcher picks where a new project folder goes; the preview offers its own root, so a
    // new project lands beside the fixtures. Opening a project picks the rover.
    pickDirectory: async (title) =>
      title === 'Choose where to create the project folder'
        ? bootstrap.previewRoot
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

  const source = new EventSource(`/__bureau_preview/events?token=${bootstrap.token}`);
  const on = <T>(name: string, deliver: Listener<T>) =>
    source.addEventListener(name, (message) => deliver(JSON.parse(message.data) as T));
  on('event', events.emit);
  on('terminal-data', terminalData.emit);
  on('terminal-state', terminalState.emit);
  on('agent-call', agentCalls.emit);
  on('chat', chatChanges.emit);
  // The host could not replay what this page missed: read the state again
  // instead of trusting a stream with a hole in it.
  on('resync', () => {
    const state = useStore.getState();
    void state.refreshAll().catch(() => {});
    const projectId = state.projectId;
    if (!projectId) return;
    if (useChat.getState().projects[projectId]) void useChat.getState().refresh(projectId);
    void api.command('terminal.state', {}, { projectId }).then((response) => {
      if (!response.ok) return;
      const session = (response.result as { session: SessionInfo | null }).session;
      terminalState.emit({ projectId, session });
    });
  });
  source.onopen = () => service.emit({ available: true });
  source.onerror = () =>
    service.emit({ available: false, message: 'The preview host is not answering. Reconnecting.' });

  window.bureau = api;
  document.documentElement.dataset.preview = 'true';
  const params = new URLSearchParams(location.search);
  const screen = params.get('screen');
  // The preview's browser profile may have seen the introduction: `screen=intro` plays it over
  // the launcher regardless, and every other screen starts without it.
  useStore.getState().set({ introOpen: screen === 'intro' });
  if (screen === 'launcher' || screen === 'intro') return;
  const result = await api.command('project.open', { path: bootstrap.path });
  if (!result.ok) throw new Error('Could not open preview project');
  const opened = result.result as { project: Project; projectId: string };
  const state = useStore.getState();
  state.set({ project: opened.project, projectPath: bootstrap.path });
  state.setActive(opened.projectId);
  await useStore.getState().refreshAll();
  if (params.get('theme') === 'light' || params.get('theme') === 'dark')
    state.set({ theme: params.get('theme') as 'light' | 'dark' });
  const lens = screen ? lensDef(screen) : undefined;
  if (lens) state.go({ level: 'project', lens: lens.id });
  if (screen === 'decide') state.decide(null);
  if (screen === 'agent') state.go({ level: 'agent' });
  if (screen === 'system') state.go({ level: 'system' });
  const type = params.get('object');
  const target = type ? useStore.getState().artifacts.find((v) => v.artifact.type === type) : null;
  if (target) state.focus(target.artifact.id);
  if (params.get('console') === 'open') state.set({ agentWindowOpen: true });
}
