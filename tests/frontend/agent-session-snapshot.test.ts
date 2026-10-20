import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  command: vi.fn(),
  receiveSession: vi.fn(),
  checked: vi.fn(),
  stateListener: null as ((state: unknown) => void) | null,
  projectId: 'project',
}));

vi.mock('../../apps/desktop/src/renderer/store', () => ({
  useStore: {
    getState: () => ({
      projectId: harness.projectId,
      receiveSession: harness.receiveSession,
    }),
  },
}));
vi.mock('../../apps/desktop/src/renderer/shell/agent/agent-store', () => ({
  useAgentUi: { getState: () => ({ setSessionChecked: harness.checked }) },
}));
vi.mock('../../apps/desktop/src/renderer/shell/agent/quiet', () => ({ quiet: harness.command }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options = { fontFamily: 'mono' };
    loadAddon() {}
    onData() {
      return { dispose() {} };
    }
    onWriteParsed() {
      return { dispose() {} };
    }
    onSelectionChange() {
      return { dispose() {} };
    }
    registerLinkProvider() {
      return { dispose() {} };
    }
    attachCustomKeyEventHandler() {}
    write() {}
    reset() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));

import { TerminalEngine } from '../../apps/desktop/src/renderer/shell/agent/terminal';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const snapshot = (id: string, state = 'running') => ({
  ok: true,
  result: { session: { id, state, scrollback: id, scrollbackCursor: 1 } },
});

describe('terminal snapshot metadata', () => {
  let engine: TerminalEngine | undefined;
  beforeEach(() => {
    harness.command.mockReset();
    harness.receiveSession.mockReset();
    harness.checked.mockReset();
    harness.projectId = 'project';
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => 'mono' }));
    vi.stubGlobal('document', { documentElement: {} });
    vi.stubGlobal(
      'MutationObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('window', {
      clearTimeout,
      omenflow: {
        onTerminalData: () => () => {},
        onTerminalState: (listener: (state: unknown) => void) => {
          harness.stateListener = listener;
          return () => {
            harness.stateListener = null;
          };
        },
      },
    });
  });
  afterEach(() => {
    engine?.dispose();
    engine = undefined;
    vi.unstubAllGlobals();
  });

  it('cannot republish an old session after the replacement snapshot resolves', async () => {
    const stale = deferred<ReturnType<typeof snapshot>>();
    harness.command.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(snapshot('new'));
    engine = new TerminalEngine('project');
    harness.stateListener!({ projectId: 'project', session: { id: 'new', state: 'running' } });
    await vi.waitFor(() => expect(harness.receiveSession).toHaveBeenCalledTimes(1));
    stale.resolve(snapshot('old', 'exited'));
    await stale.promise;
    await Promise.resolve();
    expect(harness.receiveSession.mock.calls.map(([session]) => session.id)).toEqual(['new']);
    expect(harness.checked).toHaveBeenCalled();
  });

  it('lets an exit event for the same session outrank an in-flight running snapshot', async () => {
    const first = deferred<ReturnType<typeof snapshot>>();
    const current = deferred<ReturnType<typeof snapshot>>();
    harness.command.mockReturnValueOnce(first.promise).mockReturnValueOnce(current.promise);
    engine = new TerminalEngine('project');
    harness.stateListener!({ projectId: 'project', session: { id: 'same', state: 'running' } });
    harness.stateListener!({ projectId: 'project', session: { id: 'same', state: 'exited' } });
    current.resolve(snapshot('same'));
    first.resolve(snapshot('same'));
    await Promise.all([first.promise, current.promise]);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.receiveSession).not.toHaveBeenCalled();
    expect(harness.checked).toHaveBeenCalled();
  });

  it('does not publish a disposed terminal or a project that is no longer active', async () => {
    const response = deferred<ReturnType<typeof snapshot>>();
    harness.command.mockReturnValueOnce(response.promise);
    engine = new TerminalEngine('project');
    engine.dispose();
    engine = undefined;
    response.resolve(snapshot('disposed'));
    await response.promise;
    await Promise.resolve();
    expect(harness.receiveSession).not.toHaveBeenCalled();

    harness.command.mockResolvedValueOnce(snapshot('inactive'));
    harness.projectId = 'another-project';
    engine = new TerminalEngine('project');
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.receiveSession).not.toHaveBeenCalled();
  });
});
