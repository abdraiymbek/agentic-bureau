import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatTurn } from '@bureau/contracts';
import { paneFor, useAgentUi } from '../../apps/desktop/src/renderer/shell/agent/agent-store';
import type { ProjectChat } from '../../apps/desktop/src/renderer/chat/chat-store';
import {
  conversationRunning,
  conversationThreads,
} from '../../apps/desktop/src/renderer/chat/threads';

const initialUi = useAgentUi.getState();

describe('the agent pane', () => {
  let saved: Map<string, string>;
  beforeEach(() => {
    saved = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
      removeItem: (key: string) => void saved.delete(key),
    });
    useAgentUi.setState({ ...initialUi, projectId: null });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useAgentUi.setState(initialUi);
  });

  it('opens a project not seen before on the conversation', () => {
    useAgentUi.getState().enterProject('p1');
    expect(useAgentUi.getState().pane).toBe('conversation');
    expect(paneFor('p2')).toBe('conversation');
  });

  it('remembers the pane per project, also before its surface mounts', () => {
    useAgentUi.getState().enterProject('p1');
    useAgentUi.getState().setRecordOpen(true);
    useAgentUi.getState().setPane('terminal');
    expect(useAgentUi.getState().recordOpen).toBe(false);
    expect(saved.get('bureau.agentPane.p1')).toBe('terminal');
    useAgentUi.getState().enterProject('p2');
    expect(useAgentUi.getState().pane).toBe('conversation');
    expect(paneFor('p1')).toBe('terminal');
    useAgentUi.getState().enterProject('p1');
    expect(useAgentUi.getState().pane).toBe('terminal');
  });
});

describe('conversation threads', () => {
  const turn = (state: ChatTurn['state']) =>
    ({ requestId: `r-${state}`, text: 'Ask', response: '', state }) as ChatTurn;
  const chat = (patch: Partial<ProjectChat>): ProjectChat => ({
    record: { version: 1, conversations: [] },
    inspections: {},
    activeId: 'new',
    drafts: {},
    pending: {},
    sending: {},
    refused: {},
    loading: false,
    loaded: true,
    error: null,
    storageError: false,
    ...patch,
  });

  it('lists recorded conversations, inspections and unsent drafts once each', () => {
    const state = chat({
      record: {
        version: 1,
        conversations: [{ id: 'c1', title: 'Spacer', turns: [turn('completed')] }],
      },
      inspections: { i1: { title: 'Camera tray', cards: [] }, c1: { title: 'Dup', cards: [] } },
      drafts: {
        d1: { text: 'Size the battery bracket', version: 1 },
        d2: { text: '   ', version: 1 },
        c1: { text: 'Follow-up', version: 2 },
      },
    });
    expect(conversationThreads(state).map((t) => [t.id, t.title])).toEqual([
      ['c1', 'Spacer'],
      ['i1', 'Camera tray'],
      ['d1', 'Draft · Size the battery bracket'],
    ]);
    expect(conversationThreads(undefined)).toEqual([]);
  });

  it('knows when a response runs in any conversation of the project', () => {
    const idle = chat({
      record: { version: 1, conversations: [{ id: 'c1', title: 'A', turns: [turn('failed')] }] },
    });
    expect(conversationRunning(idle)).toBe(false);
    const busy = chat({
      record: {
        version: 1,
        conversations: [
          { id: 'c1', title: 'A', turns: [turn('completed')] },
          { id: 'c2', title: 'B', turns: [turn('running')] },
        ],
      },
    });
    expect(conversationRunning(busy)).toBe(true);
  });
});
