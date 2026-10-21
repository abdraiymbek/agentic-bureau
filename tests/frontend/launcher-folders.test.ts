import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '@omenflow/contracts';
import {
  baseName,
  createRefusal,
  defaultLocation,
  folderNameFor,
  joinPath,
  nextFolderName,
  parentOf,
  placement,
  readRecents,
} from '../../apps/desktop/src/renderer/launcher/folders';
import {
  MAX_WAIT_MS,
  QUIET_MS,
  firstPromptFor,
  offerFirstPrompt,
} from '../../apps/desktop/src/renderer/launcher/first-prompt';
import { useStore } from '../../apps/desktop/src/renderer/store';
import { useAgentUi } from '../../apps/desktop/src/renderer/shell/agent/agent-store';
import { useChat } from '../../apps/desktop/src/renderer/chat/chat-store';
import { setTerminalPort } from '../../apps/desktop/src/renderer/shell/agent/terminal-port';

describe('project folder resolution', () => {
  it('turns a project name into a folder name without path characters', () => {
    expect(folderNameFor('Sable inspection rover')).toBe('Sable inspection rover');
    expect(folderNameFor('  Rover: v2 / tray?  ')).toBe('Rover v2 tray');
    expect(folderNameFor('..hidden')).toBe('hidden');
    expect(folderNameFor('Name. ')).toBe('Name');
    expect(folderNameFor('///')).toBe('Untitled project');
    expect(folderNameFor('x'.repeat(200))).toHaveLength(80);
  });

  it('joins and splits paths on either separator', () => {
    expect(joinPath('/Users/a/Projects', 'Rover')).toBe('/Users/a/Projects/Rover');
    expect(joinPath('/Users/a/Projects/', 'Rover')).toBe('/Users/a/Projects/Rover');
    expect(joinPath('/', 'Rover')).toBe('/Rover');
    expect(joinPath('C:\\Users\\a', 'Rover')).toBe('C:\\Users\\a\\Rover');
    expect(parentOf('/Users/a/Projects/Rover')).toBe('/Users/a/Projects');
    expect(parentOf('/Rover')).toBe('/');
    expect(parentOf('/')).toBeNull();
    expect(parentOf('C:\\Users\\a\\Rover')).toBe('C:\\Users\\a');
    expect(baseName('/Users/a/Projects/Rover/')).toBe('Rover');
  });

  it('proposes the folder of the most recent project as the location', () => {
    expect(defaultLocation(['/Users/a/Projects/Rover', '/Users/a/Other/Drone'])).toBe(
      '/Users/a/Projects',
    );
    expect(defaultLocation([])).toBeNull();
  });

  it('creates a named subfolder in any location, and offers a known project instead', () => {
    const known = [{ path: '/Users/a/Projects/Rover', name: 'Sable rover' }];
    expect(placement('/Users/a/Documents', 'Drone', known)).toEqual({
      kind: 'create',
      path: '/Users/a/Documents/Drone',
      folder: 'Drone',
    });
    expect(placement('/Users/a/Projects', 'Rover', known)).toEqual({
      kind: 'exists',
      path: '/Users/a/Projects/Rover',
      name: 'Sable rover',
    });
    expect(placement('/Users/a/Projects/Rover/', 'Tray', known)).toEqual({
      kind: 'inside-project',
      project: '/Users/a/Projects/Rover',
      name: 'Sable rover',
    });
  });

  it('numbers a folder that is taken and recognises the create refusals', () => {
    expect(nextFolderName('Rover')).toBe('Rover 2');
    expect(nextFolderName('Rover 2')).toBe('Rover 3');
    expect(createRefusal('Project already exists')).toBe('project-exists');
    expect(createRefusal('Folder is not empty: /Users/a/Rover')).toBe('folder-not-empty');
    expect(createRefusal('Permission denied')).toBeNull();
  });

  it('reads recent projects from both host shapes', () => {
    expect(
      readRecents({
        projects: ['/p/Rover', '/p/Drone'],
        projectNames: { '/p/Rover': 'Sable rover', '/p/Drone': '  ' },
      }),
    ).toEqual([
      { path: '/p/Rover', name: 'Sable rover', lastOpenedAt: null, exists: true },
      { path: '/p/Drone', name: null, lastOpenedAt: null, exists: true },
    ]);
    expect(
      readRecents({
        entries: [
          {
            path: '/p/Rover',
            name: 'Sable rover',
            lastOpenedAt: '2026-10-13T10:00:00Z',
            exists: true,
          },
          { path: '/p/Gone', exists: false },
          { name: 'no path' },
        ],
      }),
    ).toEqual([
      { path: '/p/Rover', name: 'Sable rover', lastOpenedAt: '2026-10-13T10:00:00Z', exists: true },
      { path: '/p/Gone', name: null, lastOpenedAt: null, exists: false },
    ]);
    expect(readRecents(null)).toEqual([]);
  });
});

describe('the brief as the first prompt', () => {
  const command = vi.fn();
  let data: ((d: { projectId: string; sessionId: string; chunk: string }) => void) | null = null;
  const initial = useStore.getState();
  const initialUi = useAgentUi.getState();
  const initialChat = useChat.getState();
  const toast = vi.fn();
  const session = (state: SessionInfo['state']) => ({ state }) as SessionInfo;
  // The terminal the brief is pasted into: xterm adds the bracketed-paste markers itself.
  let pastes: string[] = [];
  let ready = true;
  const port = {
    projectId: 'p1',
    paste: (text: string) => {
      pastes.push(text);
      return true;
    },
    write: async () => {},
    readyForInput: () => ready,
    size: () => null,
    focus: () => {},
  };

  beforeEach(() => {
    vi.useFakeTimers();
    command.mockReset().mockResolvedValue({ ok: true, result: {} });
    toast.mockReset();
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      dispatchEvent: vi.fn(),
      omenflow: {
        command,
        onTerminalData: (cb: typeof data) => {
          data = cb;
          return () => (data = null);
        },
      },
    });
    useStore.setState({ ...initial, projectId: 'p1', session: null, toast });
    useAgentUi.setState({ ...initialUi, projectId: 'p1', pane: 'terminal' });
    pastes = [];
    ready = true;
    setTerminalPort(port);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setTerminalPort(null);
    useStore.setState(initial);
    useAgentUi.setState(initialUi);
  });

  // Typing goes through the agent's ask path (lib/actions `askAgent`), which pastes into the
  // terminal; it never writes a Return.
  const pasted = () => pastes;

  it('pastes the brief once the CLI has gone quiet, without pressing Enter', async () => {
    offerFirstPrompt('p1', firstPromptFor('  A rover  '));
    useStore.setState({ session: session('starting') });
    await vi.advanceTimersByTimeAsync(QUIET_MS * 2);
    expect(pasted()).toEqual([]);
    useStore.setState({ session: session('running') });
    data?.({ projectId: 'p1', sessionId: 's', chunk: 'Welcome' });
    await vi.advanceTimersByTimeAsync(QUIET_MS - 100);
    data?.({ projectId: 'p1', sessionId: 's', chunk: '> ' });
    await vi.advanceTimersByTimeAsync(QUIET_MS - 100);
    expect(pasted()).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(pasted()).toEqual([
      'Read the project intent and draft the first requirements with measurable targets and acceptance criteria. Intent: A rover',
    ]);
    expect(pasted().some((p) => p.includes('\r'))).toBe(false);
    expect(command.mock.calls.some(([op]) => op === 'terminal.write')).toBe(false);
    expect(toast).toHaveBeenCalledWith('info', expect.stringContaining('press Enter'));
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS);
    expect(pasted()).toHaveLength(1);
  });

  it('gives up when the project changes or the session ends before it is ready', async () => {
    offerFirstPrompt('p1', 'brief');
    useStore.setState({ projectId: 'p2' });
    useStore.setState({ projectId: 'p1', session: session('running') });
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS);
    expect(pasted()).toEqual([]);

    offerFirstPrompt('p1', 'brief');
    useStore.setState({ session: session('running') });
    useStore.setState({ session: session('exited') });
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS);
    expect(pasted()).toEqual([]);
  });

  it('waits in the ask queue, unsent, when the CLI has not shown its prompt yet', async () => {
    ready = false;
    offerFirstPrompt('p1', 'brief');
    useStore.setState({ session: session('running') });
    await vi.advanceTimersByTimeAsync(QUIET_MS + 100);
    expect(pasted()).toEqual([]);
    expect(useAgentUi.getState().pending.map((p) => p.text)).toEqual(['brief']);
    expect(toast).toHaveBeenCalledWith('info', expect.stringContaining('once the agent is ready'));
  });

  it('puts the brief in the conversation composer at once on the conversation pane', async () => {
    useAgentUi.setState({ pane: 'conversation' });
    offerFirstPrompt('p1', firstPromptFor('A rover'));
    const chat = useChat.getState().projects.p1!;
    expect(chat.drafts[chat.activeId]?.text).toBe(firstPromptFor('A rover'));
    expect(toast).toHaveBeenCalledWith('info', expect.stringContaining('press Send'));
    useStore.setState({ session: session('running') });
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS);
    expect(pasted()).toEqual([]);
    expect(command).not.toHaveBeenCalled();
    useChat.setState(initialChat, true);
  });

  it('types it anyway after the longest wait when the CLI keeps drawing', async () => {
    offerFirstPrompt('p1', 'brief');
    useStore.setState({ session: session('running') });
    for (let t = 0; t < MAX_WAIT_MS; t += QUIET_MS / 2) {
      data?.({ projectId: 'p1', sessionId: 's', chunk: '.' });
      await vi.advanceTimersByTimeAsync(QUIET_MS / 2);
    }
    expect(pasted()).toHaveLength(1);
  });
});
