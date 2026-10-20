/**
 * State of the agent surface that is not project data: detection and start progress, the ask
 * queue, the activity feed, and remembered presentation choices. Project data (session,
 * adapters) stays in the main store.
 */
import { create } from 'zustand';
import type { AgentCallRecord, AgentSessionSummary } from '@omenflow/contracts';
import { CALL_LIMIT, mergeCalls } from './activity';
import { parsePrefs, serializePrefs, type WindowPrefs } from './window-geometry';

export type SettingsSection = 'agents' | 'tools' | 'appearance';
export const SETTINGS_SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'agents', label: 'Agents' },
  { id: 'tools', label: 'Engineering tools' },
  { id: 'appearance', label: 'Appearance' },
];

/**
 * `unavailable`: the host does not serve `agent.activity`. `live-only`: it does not, but live
 * records arrive anyway, so the rail shows those and says history is missing.
 */
export type ActivityStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';

export interface ActivityFeed {
  status: ActivityStatus;
  error: string | null;
  /** Oldest first, unique by `seq`. */
  calls: AgentCallRecord[];
  /** A separate, bounded window while browsing back; live calls cannot displace it. */
  history: AgentCallRecord[] | null;
  /** Changes when browsing is reset, cancelling any older page still in flight. */
  historyRevision: number;
  sessions: AgentSessionSummary[];
  /** Highest `seq` covered by `sessions` when they were read. */
  summarySeq: number;
  /** When the last live record arrived (ms since epoch). */
  lastArrival: number | null;
  /** The ledger holds calls older than the oldest loaded one. */
  hasMore: boolean;
  /** Whether earlier calls exist before the latest window, for returning from history. */
  latestHasMore: boolean;
  loadingOlder: boolean;
}

export interface PendingAsk {
  id: number;
  text: string;
  at: number;
}

export type StartState =
  | { status: 'idle' }
  | { status: 'starting'; adapterId: string }
  | { status: 'failed'; adapterId: string; error: string };

export type Detection =
  { status: 'detecting' } | { status: 'ready' } | { status: 'failed'; error: string };

interface AgentUi {
  projectId: string | null;
  /** A request from an earlier visit must not apply after switching away and back. */
  projectEpoch: number;
  detection: Detection;
  /** The host has answered whether this project has a session, so autostart may decide. */
  sessionChecked: boolean;
  start: StartState;
  /** The CLI has shown its prompt: bracketed paste is on and output has settled. */
  inputReady: boolean;
  /**
   * The current session has input already: the person typed into it, or this surface pasted a
   * request (the launcher brief, an ask) for them to send. Starters are offered only before.
   */
  typed: boolean;
  pending: PendingAsk[];
  activity: ActivityFeed;
  railOpen: boolean;
  errorsOnly: boolean;
  window: WindowPrefs;
  settingsSection: SettingsSection;
  /** Session whose starter prompts the person dismissed. */
  startersDismissed: string | null;
  /** Last copy to the clipboard, so the surface can confirm it briefly. */
  copied: { what: 'selection' | 'transcript'; at: number } | null;

  enterProject: (projectId: string | null) => void;
  setDetection: (detection: Detection) => void;
  setSessionChecked: () => void;
  setStart: (start: StartState) => void;
  setInputReady: (ready: boolean) => void;
  setTyped: (typed: boolean) => void;
  enqueue: (text: string) => void;
  takePending: () => PendingAsk[];
  discardPending: (id?: number) => void;
  setActivity: (patch: Partial<ActivityFeed>) => void;
  addCalls: (calls: AgentCallRecord[], source: 'live' | 'latest' | 'older') => void;
  showLatestCalls: () => void;
  setRailOpen: (open: boolean) => void;
  setErrorsOnly: (errorsOnly: boolean) => void;
  setWindow: (patch: Partial<WindowPrefs>) => void;
  setSettingsSection: (section: SettingsSection) => void;
  dismissStarters: (sessionId: string) => void;
  noteCopied: (what: 'selection' | 'transcript') => void;
}

const WINDOW_KEY = 'omen.agentWindow';
const SECTION_KEY = 'omen.settings.section';
const railKey = (projectId: string) => `omen.agentRail.${projectId}`;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* presentation choices are a convenience */
  }
}

/** Open by default where there is room for it beside the terminal. */
function readRail(projectId: string | null): boolean {
  const saved = projectId ? read(railKey(projectId)) : null;
  if (saved === '1' || saved === '0') return saved === '1';
  return typeof window !== 'undefined' && window.innerWidth >= 1280;
}

function readSection(): SettingsSection {
  const saved = read(SECTION_KEY);
  return saved === 'tools' || saved === 'appearance' ? saved : 'agents';
}

export const EMPTY_FEED: ActivityFeed = {
  status: 'idle',
  error: null,
  calls: [],
  history: null,
  historyRevision: 0,
  sessions: [],
  summarySeq: 0,
  lastArrival: null,
  hasMore: false,
  latestHasMore: false,
  loadingOlder: false,
};

let askSeq = 0;

export const useAgentUi = create<AgentUi>((set, get) => ({
  projectId: null,
  projectEpoch: 0,
  detection: { status: 'detecting' },
  sessionChecked: false,
  start: { status: 'idle' },
  inputReady: false,
  typed: false,
  pending: [],
  activity: EMPTY_FEED,
  railOpen: readRail(null),
  errorsOnly: false,
  window: parsePrefs(read(WINDOW_KEY)),
  settingsSection: readSection(),
  startersDismissed: null,
  copied: null,

  enterProject: (projectId) => {
    if (get().projectId === projectId) return;
    set({
      projectId,
      projectEpoch: get().projectEpoch + 1,
      sessionChecked: false,
      start: { status: 'idle' },
      inputReady: false,
      typed: false,
      pending: [],
      activity: EMPTY_FEED,
      railOpen: readRail(projectId),
      errorsOnly: false,
      startersDismissed: null,
    });
  },
  setDetection: (detection) => set({ detection }),
  setSessionChecked: () => {
    if (!get().sessionChecked) set({ sessionChecked: true });
  },
  setStart: (start) => set({ start }),
  setInputReady: (inputReady) => {
    if (get().inputReady !== inputReady) set({ inputReady });
  },
  setTyped: (typed) => {
    if (get().typed !== typed) set({ typed });
  },
  enqueue: (text) =>
    set((s) => ({ pending: [...s.pending, { id: ++askSeq, text, at: Date.now() }] })),
  takePending: () => {
    const taken = get().pending;
    if (taken.length) set({ pending: [] });
    return taken;
  },
  discardPending: (id) =>
    set((s) => ({ pending: id === undefined ? [] : s.pending.filter((p) => p.id !== id) })),
  setActivity: (patch) => set((s) => ({ activity: { ...s.activity, ...patch } })),
  addCalls: (calls, source) =>
    set((s) => {
      if (source === 'older') {
        return {
          activity: {
            ...s.activity,
            history: mergeCalls(
              s.activity.history ?? s.activity.calls,
              calls,
              CALL_LIMIT,
              'oldest',
            ),
          },
        };
      }
      const merged = mergeCalls(s.activity.calls, calls);
      const trimmed =
        merged.length === CALL_LIMIT &&
        !!s.activity.calls.length &&
        merged[0]!.seq > s.activity.calls[0]!.seq;
      const latestHasMore = s.activity.latestHasMore || trimmed;
      return {
        activity: {
          ...s.activity,
          calls: merged,
          history: source === 'latest' ? null : s.activity.history,
          historyRevision: s.activity.historyRevision + (source === 'latest' ? 1 : 0),
          loadingOlder: source === 'latest' ? false : s.activity.loadingOlder,
          latestHasMore,
          hasMore: source === 'live' && !s.activity.history ? latestHasMore : s.activity.hasMore,
          lastArrival: source === 'live' ? Date.now() : s.activity.lastArrival,
        },
      };
    }),
  showLatestCalls: () =>
    set((s) => ({
      activity: {
        ...s.activity,
        history: null,
        historyRevision: s.activity.historyRevision + 1,
        loadingOlder: false,
        hasMore: s.activity.latestHasMore,
      },
    })),
  setRailOpen: (railOpen) => {
    const { projectId } = get();
    if (projectId) write(railKey(projectId), railOpen ? '1' : '0');
    set({ railOpen });
  },
  setErrorsOnly: (errorsOnly) => set({ errorsOnly }),
  setWindow: (patch) => {
    const next = { ...get().window, ...patch };
    write(WINDOW_KEY, serializePrefs(next));
    set({ window: next });
  },
  setSettingsSection: (settingsSection) => {
    write(SECTION_KEY, settingsSection);
    set({ settingsSection });
  },
  dismissStarters: (sessionId) => set({ startersDismissed: sessionId }),
  noteCopied: (what) => set({ copied: { what, at: Date.now() } }),
}));
