import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterStatus, Project, SessionInfo } from '@bureau/contracts';
import { useStore } from '../../apps/desktop/src/renderer/store';
import {
  askAgent,
  flushAsks,
  sendToAgent,
  startAgent,
  typeIntoAgent,
} from '../../apps/desktop/src/renderer/lib/actions';
import { useAgentUi } from '../../apps/desktop/src/renderer/shell/agent/agent-store';
import { useChat } from '../../apps/desktop/src/renderer/chat/chat-store';
import {
  setTerminalPort,
  type TerminalPort,
} from '../../apps/desktop/src/renderer/shell/agent/terminal-port';

const command = vi.fn();
const initial = useStore.getState();
const initialUi = useAgentUi.getState();
const initialChat = useChat.getState();

function adapter(id: string, available: boolean): AdapterStatus {
  return {
    adapterId: id,
    label: id === 'codex' ? 'Codex CLI' : 'Claude Code',
    available,
    executablePath: available ? `/bin/${id}` : null,
    version: null,
    testedVersionRange: null,
    recognizedVersion: true,
    capabilities: { mcp: true, cli: true, resume: false },
    lastTestAt: null,
    lastTestOk: null,
    lastError: null,
    installHint: null,
  };
}

const running = { id: 's1', adapterId: 'codex', state: 'running' } as SessionInfo;

function fakePort(ready: boolean) {
  const pasted: string[] = [];
  const written: string[] = [];
  const port: TerminalPort = {
    projectId: 'p1',
    paste: (text) => {
      pasted.push(text);
      return true;
    },
    write: async (data) => {
      written.push(data);
    },
    readyForInput: () => ready,
    size: () => ({ cols: 132, rows: 40 }),
    focus: vi.fn(),
  };
  return { port, pasted, written };
}

beforeEach(() => {
  vi.stubGlobal('window', { bureau: { command }, dispatchEvent: vi.fn() });
  vi.stubGlobal(
    'CustomEvent',
    class {
      constructor(public type: string) {}
    },
  );
  command.mockReset();
  command.mockResolvedValue({ ok: true, result: {} });
  useStore.setState({
    ...initial,
    projectId: 'p1',
    project: { id: 'p1', name: 'Rover', intent: '' } as Project,
    view: { level: 'project', lens: 'flow' },
    adapters: [adapter('codex', true), adapter('claude-code', false)],
    agentId: null,
    session: null,
    refreshSession: vi.fn().mockResolvedValue(undefined),
    toast: vi.fn(),
  });
  useAgentUi.setState({
    ...initialUi,
    projectId: 'p1',
    pane: 'terminal',
    detection: { status: 'ready' },
  });
});

afterEach(() => {
  setTerminalPort(null);
  vi.unstubAllGlobals();
  useStore.setState(initial);
  useAgentUi.setState(initialUi);
  useChat.setState(initialChat, true);
});

describe('asking the agent on the conversation pane', () => {
  beforeEach(() => useAgentUi.setState({ pane: 'conversation' }));
  const draft = () => {
    const chat = useChat.getState().projects.p1!;
    return chat.drafts[chat.activeId]?.text;
  };

  it('adds the text to the composer and never pastes, queues or starts a process', () => {
    const { port, pasted } = fakePort(true);
    setTerminalPort(port);
    useStore.setState({ session: running });
    expect(askAgent('Check the mass budget')).toBe('drafted');
    expect(askAgent('and the pack energy')).toBe('drafted');
    expect(draft()).toBe('Check the mass budget\n\nand the pack energy');
    expect(pasted).toEqual([]);
    expect(useAgentUi.getState().pending).toHaveLength(0);
    expect(command).not.toHaveBeenCalled();
    expect(useStore.getState().agentWindowOpen).toBe(true);
  });

  it('only shows the agent for an empty request', () => {
    expect(askAgent('   ')).toBe('shown');
    expect(useChat.getState().projects.p1).toBeUndefined();
  });
});

describe('asking the agent', () => {
  it('queues the text, opens the window, and starts the only available CLI at the terminal size', async () => {
    const { port } = fakePort(false);
    setTerminalPort(port);
    expect(askAgent('About the requirement "Payload capacity": ')).toBe('queued');
    expect(useStore.getState().agentWindowOpen).toBe(true);
    expect(useAgentUi.getState().pending.map((p) => p.text)).toEqual([
      'About the requirement "Payload capacity": ',
    ]);
    await vi.waitFor(() =>
      expect(command).toHaveBeenCalledWith(
        'terminal.start',
        { adapterId: 'codex', cols: 132, rows: 40 },
        { projectId: 'p1' },
      ),
    );
  });

  it('keeps the request pending without starting when several CLIs are installed and none is chosen', () => {
    useStore.setState({ adapters: [adapter('codex', true), adapter('claude-code', true)] });
    askAgent('Check the mass budget');
    expect(useAgentUi.getState().pending).toHaveLength(1);
    expect(command).not.toHaveBeenCalled();
  });

  it('never restarts an ended session on its own', () => {
    useStore.setState({ session: { ...running, state: 'exited' } });
    askAgent('Continue');
    expect(useAgentUi.getState().pending).toHaveLength(1);
    expect(command).not.toHaveBeenCalled();
  });

  it('pastes straight away once the CLI shows its prompt', () => {
    const { port, pasted } = fakePort(true);
    setTerminalPort(port);
    useStore.setState({ session: running });
    expect(askAgent('Explain\u001b[201~ this')).toBe('pasted');
    expect(pasted).toEqual(['Explain[201~ this']);
    expect(useAgentUi.getState().pending).toHaveLength(0);
  });

  it('waits while the CLI is busy and pastes the queue in order when it is ready', () => {
    let ready = false;
    const { port, pasted } = fakePort(false);
    port.readyForInput = () => ready;
    setTerminalPort(port);
    useStore.setState({ session: running });
    askAgent('first');
    askAgent('second');
    expect(flushAsks()).toBe(false);
    expect(useAgentUi.getState().pending).toHaveLength(2);
    ready = true;
    expect(flushAsks()).toBe(true);
    expect(pasted).toEqual(['first\nsecond']);
    expect(useAgentUi.getState().pending).toHaveLength(0);
  });

  it('pastes on "Paste now" before the prompt shows, but never without a running session', () => {
    const { port, pasted } = fakePort(false);
    setTerminalPort(port);
    useStore.setState({ session: { ...running, state: 'exited' } });
    askAgent('hello');
    expect(flushAsks(true)).toBe(false);
    expect(useAgentUi.getState().pending).toHaveLength(1);
    useStore.setState({ session: running });
    expect(flushAsks(true)).toBe(true);
    expect(pasted).toEqual(['hello']);
  });

  it('keeps the queue when the terminal refuses input', () => {
    const { port } = fakePort(true);
    port.paste = () => false;
    setTerminalPort(port);
    useStore.setState({ session: running });
    useAgentUi.getState().enqueue('kept');
    expect(flushAsks()).toBe(false);
    expect(useAgentUi.getState().pending.map((p) => p.text)).toEqual(['kept']);
  });

  it('ignores a port that belongs to another project', () => {
    const { port, pasted } = fakePort(true);
    setTerminalPort({ ...port, projectId: 'other' });
    useStore.setState({ session: running });
    expect(askAgent('hello')).toBe('queued');
    expect(pasted).toEqual([]);
  });

  it('typeIntoAgent goes through the same queue instead of throwing', async () => {
    await expect(typeIntoAgent('no session yet')).resolves.toBeUndefined();
    expect(useAgentUi.getState().pending).toHaveLength(1);
  });

  it('sendToAgent submits after the paste when live, and only queues (never submits) otherwise', async () => {
    const { port, pasted, written } = fakePort(true);
    setTerminalPort(port);
    useStore.setState({ session: running });
    await sendToAgent('Read proposal 1');
    expect(pasted).toEqual(['Read proposal 1']);
    expect(written).toEqual(['\r']);
    useStore.setState({ session: null });
    await sendToAgent('Read proposal 2');
    expect(written).toEqual(['\r']);
    expect(useAgentUi.getState().pending.map((p) => p.text)).toEqual(['Read proposal 2']);
  });
});

describe('starting the agent', () => {
  it('records a failed start with the host error and does not raise it globally', async () => {
    command.mockResolvedValueOnce({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'codex not found on PATH', repair: 'Set a path' },
    });
    await expect(startAgent('codex', { cols: 100, rows: 30 })).rejects.toThrow(
      'codex not found on PATH',
    );
    expect(useAgentUi.getState().start).toEqual({
      status: 'failed',
      adapterId: 'codex',
      error: 'codex not found on PATH — Set a path',
    });
    expect(
      (window as unknown as { dispatchEvent: ReturnType<typeof vi.fn> }).dispatchEvent,
    ).not.toHaveBeenCalled();
  });

  it('returns to idle after a successful start and refreshes the session', async () => {
    await startAgent('codex', { cols: 90, rows: 25 });
    expect(command).toHaveBeenCalledWith(
      'terminal.start',
      { adapterId: 'codex', cols: 90, rows: 25 },
      { projectId: 'p1' },
    );
    expect(useStore.getState().refreshSession).toHaveBeenCalled();
    expect(useAgentUi.getState().start).toEqual({ status: 'idle' });
  });
});
