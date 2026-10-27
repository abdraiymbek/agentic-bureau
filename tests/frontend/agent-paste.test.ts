/**
 * The real terminal engine on the real xterm: a paste must never reach the CLI as Enter, whether or
 * not the CLI has turned bracketed paste on ("Paste now" before the prompt shows).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { pasteText } from '../../apps/desktop/src/renderer/shell/agent/buffer';
import { useAgentUi } from '../../apps/desktop/src/renderer/shell/agent/agent-store';

const command = vi.fn();

beforeAll(() => {
  // xterm and the engine need a little of the browser; nothing here is opened or drawn.
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('self', globalThis);
  vi.stubGlobal('navigator', { userAgent: 'node', platform: 'MacIntel' });
  vi.stubGlobal('document', {
    documentElement: {},
    createElement: () => ({ getContext: () => null, style: {} }),
    addEventListener() {},
  });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.assign(globalThis, {
    addEventListener() {},
    removeEventListener() {},
    bureau: {
      command,
      onTerminalData: () => () => {},
      onTerminalState: () => () => {},
    },
  });
});

afterEach(() => {
  command.mockReset();
});

const handoff =
  'Bureau: the person recorded a review decision.\n\n1. Approved proposal p1.\n   Rationale: none given.\n\nNext:\n- Build on the baseline.';

async function engineFor(bracketed: boolean) {
  command.mockImplementation(async (op: string) =>
    op === 'terminal.state' ? { ok: true, result: { session: null } } : { ok: true, result: {} },
  );
  const { TerminalEngine } = await import('../../apps/desktop/src/renderer/shell/agent/terminal');
  const engine = new TerminalEngine('p1');
  engine.setSession({ id: 's1', state: 'running' });
  if (bracketed) await new Promise<void>((done) => engine.term.write('\x1b[?2004h', done));
  return engine;
}

/** Everything the engine wrote to the PTY. */
async function written(): Promise<string> {
  await vi.waitFor(() =>
    expect(command.mock.calls.some(([op]) => op === 'terminal.write')).toBe(true),
  );
  return command.mock.calls
    .filter(([op]) => op === 'terminal.write')
    .map(([, input]) => (input as { data: string }).data)
    .join('');
}

function pasteIn(engine: { paste(text: string): boolean }, text: string) {
  // Before open() xterm has no textarea to clear once it has sent the data.
  try {
    return engine.paste(text);
  } catch {
    return true;
  }
}

describe('pasting into the agent terminal', () => {
  it('sends no Enter when the CLI has not turned bracketed paste on', async () => {
    const engine = await engineFor(false);
    expect(engine.term.modes.bracketedPasteMode).toBe(false);
    expect(pasteIn(engine, handoff)).toBe(true);
    const data = await written();
    expect(data).not.toMatch(/[\r\n]/);
    expect(data).toBe(
      'Bureau: the person recorded a review decision. 1. Approved proposal p1. Rationale: none given. Next: - Build on the baseline.',
    );
    engine.dispose();
  });

  it('counts a pasted request as the session’s input, so starters are no longer offered', async () => {
    const engine = await engineFor(true);
    expect(useAgentUi.getState().typed).toBe(false);
    pasteIn(engine, 'Read the project intent and draft the first requirements.');
    expect(useAgentUi.getState().typed).toBe(true);
    engine.dispose();
  });

  it('keeps the lines inside the bracket once the CLI asks for bracketed paste', async () => {
    const engine = await engineFor(true);
    expect(pasteIn(engine, 'first\nsecond')).toBe(true);
    expect(await written()).toBe('\x1b[200~first\rsecond\x1b[201~');
    engine.dispose();
  });

  it('joins lines only when the paste is not bracketed, keeping the text the person continues', () => {
    expect(pasteText('About "Payload": ', false)).toBe('About "Payload": ');
    expect(pasteText('a \n\n  b\r\nc\n', false)).toBe('a b c ');
    expect(pasteText('a\n\nb', true)).toBe('a\n\nb');
    expect(pasteText('Explain\u001b[201~ this', false)).toBe('Explain[201~ this');
  });
});
