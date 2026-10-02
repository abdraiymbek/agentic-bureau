import { create } from 'zustand';
import type {
  AdapterStatus,
  ArtifactView,
  Edge,
  Job,
  Project,
  ProjectEvent,
  Proposal,
  SessionInfo,
  StaleRecord,
} from '@omenflow/contracts';
import { cmd, errMsg } from './api';
import { showAgent, typeIntoAgent } from './lib/actions';

/** Projections of the whole project. */
export type Lens = 'flow' | 'parts' | 'timeline' | 'files';

/**
 * Where the engineer is. Omen Flow has three zoom levels instead of pages:
 * the whole project (seen through a lens), one object in focus, and one decision.
 * The agent is its own tab on the activity bar, beside the zoom levels.
 */
export type View =
  | { level: 'agent' }
  | { level: 'project'; lens: Lens }
  | { level: 'object'; id: string }
  | { level: 'decide'; proposalId: string | null }
  | { level: 'system' };

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'ok';
  text: string;
}

/** Listed until `connection.list` answers, so the agent choice survives a slow detection. */
export const FALLBACK_ADAPTERS = [
  { adapterId: 'codex', label: 'Codex CLI', available: false },
  { adapterId: 'claude-code', label: 'Claude Code', available: false },
  { adapterId: 'custom', label: 'Custom CLI', available: false },
] as AdapterStatus[];

/** The adapter that should run: the chosen one, else the first detected, else the first row. */
export function preferredAdapter(
  adapters: AdapterStatus[],
  agentId: string | null,
): AdapterStatus | undefined {
  if (!adapters.length) return undefined;
  const chosen = agentId ? adapters.find((a) => a.adapterId === agentId) : undefined;
  return chosen ?? adapters.find((a) => a.available) ?? adapters[0];
}

interface State {
  projectId: string | null;
  project: Project | null;
  projectPath: string | null;
  readOnly: boolean;
  artifacts: ArtifactView[];
  edges: Edge[];
  stale: Record<string, StaleRecord[]>;
  proposals: Proposal[];
  events: ProjectEvent[];
  session: SessionInfo | null;
  adapters: AdapterStatus[];
  jobs: Job[];
  suggestions: { title: string; detail?: string }[];
  /** Most recently focused objects, newest first; remembered per project. */
  recentIds: string[];

  view: View;
  back: View[];
  /** The floating agent window is open (on any tab except the Agent tab itself). */
  agentWindowOpen: boolean;
  omniOpen: boolean;
  settingsOpen: boolean;
  theme: 'dark' | 'light';
  /** The adapter the user picked in Settings; persisted as `omen.agent`. */
  agentId: string | null;
  toasts: Toast[];

  set: (p: Partial<State>) => void;
  setActive: (projectId: string | null) => void;
  go: (view: View) => void;
  goBack: () => void;
  zoomOut: () => void;
  focus: (id: string) => void;
  decide: (proposalId?: string | null) => void;
  askAbout: (text?: string) => void;
  setAgent: (adapterId: string) => void;
  refreshArtifacts: () => Promise<void>;
  refreshGraph: () => Promise<void>;
  refreshProposals: () => Promise<void>;
  refreshEvents: () => Promise<void>;
  refreshJobs: () => Promise<void>;
  refreshAdapters: () => Promise<void>;
  refreshSession: () => Promise<void>;
  refreshAll: () => Promise<void>;
  toast: (kind: Toast['kind'], text: string) => void;
  pushEvent: (e: ProjectEvent) => void;
}

function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

let toastSeq = 0;
let projectGeneration = 0;

const RECENT_LIMIT = 8;
const recentKey = (projectId: string) => `omen.recent.${projectId}`;
function readRecents(projectId: string | null): string[] {
  if (!projectId) return [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(recentKey(projectId)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function writeRecents(projectId: string | null, ids: string[]) {
  if (!projectId) return;
  try {
    localStorage.setItem(recentKey(projectId), JSON.stringify(ids));
  } catch {
    /* the working set is a convenience */
  }
}

const sameView = (a: View, b: View) => JSON.stringify(a) === JSON.stringify(b);
const HOME: View = { level: 'project', lens: 'flow' };
const emptyProject = {
  artifacts: [],
  edges: [],
  proposals: [],
  events: [],
  jobs: [],
  session: null,
  stale: {},
  suggestions: [],
  back: [],
};

export const openProposals = (proposals: Proposal[]) =>
  proposals.filter((p) => p.state === 'pending' || p.state === 'changes_requested');

export const useStore = create<State>((set, get) => ({
  projectId: null,
  project: null,
  projectPath: null,
  readOnly: false,
  artifacts: [],
  edges: [],
  stale: {},
  proposals: [],
  events: [],
  session: null,
  adapters: [],
  jobs: [],
  suggestions: [],
  recentIds: [],
  view: HOME,
  back: [],
  agentWindowOpen: false,
  omniOpen: false,
  settingsOpen: false,
  theme: readPreference('omen.theme') === 'light' ? 'light' : 'dark',
  agentId: readPreference('omen.agent'),
  toasts: [],

  set: (p) => set(p),
  setActive: (projectId) => {
    projectGeneration++;
    set({ projectId, ...emptyProject, view: HOME, recentIds: readRecents(projectId) });
    void window.omenflow.setActiveProject(projectId);
  },
  go: (view) => {
    const { view: current, back, projectId, recentIds } = get();
    if (sameView(view, current)) return;
    if (view.level === 'object') {
      const ids = [view.id, ...recentIds.filter((x) => x !== view.id)].slice(0, RECENT_LIMIT);
      writeRecents(projectId, ids);
      set({ recentIds: ids });
    }
    set({ view, back: [...back.slice(-40), current] });
  },
  goBack: () => {
    const { back } = get();
    const previous = back[back.length - 1];
    set({ view: previous ?? HOME, back: back.slice(0, -1) });
  },
  zoomOut: () => {
    const { view, go } = get();
    if (view.level !== 'project') go(HOME);
    else if (view.lens !== 'flow') go(HOME);
  },
  focus: (id) => get().go({ level: 'object', id }),
  decide: (proposalId = null) => get().go({ level: 'decide', proposalId }),
  askAbout: (text = '') => {
    showAgent();
    const { session } = get();
    if (text && session?.state === 'running')
      void typeIntoAgent(text).catch((e) => get().toast('error', errMsg(e)));
  },
  setAgent: (adapterId) => {
    try {
      localStorage.setItem('omen.agent', adapterId);
    } catch {
      /* preferences remain usable without storage */
    }
    set({ agentId: adapterId });
  },

  refreshArtifacts: async () => {
    const { projectId } = get();
    const generation = projectGeneration;
    if (!projectId) return;
    const r = await cmd<{ artifacts: ArtifactView[] }>(
      'artifact.list',
      { includeArchived: false, limit: 500 },
      { projectId },
    );
    if (generation !== projectGeneration) return;
    const stale: Record<string, StaleRecord[]> = {};
    for (const v of r.artifacts) stale[v.artifact.id] = v.staleReasons;
    set({ artifacts: r.artifacts, stale });
  },
  refreshGraph: async () => {
    const { projectId } = get();
    const generation = projectGeneration;
    if (!projectId) return;
    const r = await cmd<{ edges: Edge[] }>('graph.list', {}, { projectId });
    if (generation === projectGeneration) set({ edges: r.edges });
  },
  refreshProposals: async () => {
    const { projectId } = get();
    const generation = projectGeneration;
    if (!projectId) return;
    const r = await cmd<{ proposals: Proposal[] }>('proposal.list', {}, { projectId });
    if (generation === projectGeneration) set({ proposals: r.proposals });
  },
  refreshEvents: async () => {
    const { projectId } = get();
    const generation = projectGeneration;
    if (!projectId) return;
    let r = await cmd<{ events: ProjectEvent[]; highWater: number; hasMore: boolean }>(
      'project.changes_since',
      { seq: 0 },
      { projectId },
    );
    if (r.hasMore)
      r = await cmd(
        'project.changes_since',
        { seq: Math.max(0, r.highWater - 300) },
        { projectId },
      );
    if (generation === projectGeneration) set({ events: r.events.slice(-300) });
  },
  refreshJobs: async () => {
    const { projectId } = get();
    const generation = projectGeneration;
    if (!projectId) return;
    const r = await cmd<{ jobs: Job[] }>('job.list', { limit: 50 }, { projectId });
    if (generation === projectGeneration) set({ jobs: r.jobs });
  },
  refreshAdapters: async () => {
    const r = await cmd<{ adapters: AdapterStatus[] }>('connection.list', {});
    set({ adapters: r.adapters });
  },
  refreshSession: async () => {
    const { projectId } = get();
    const generation = projectGeneration;
    if (!projectId) return;
    const r = await cmd<{ session: SessionInfo | null }>('terminal.state', {}, { projectId });
    if (generation === projectGeneration) set({ session: r.session });
  },
  refreshAll: async () => {
    const s = get();
    await Promise.all([
      s.refreshArtifacts(),
      s.refreshGraph(),
      s.refreshProposals(),
      s.refreshEvents(),
      s.refreshJobs(),
      s.refreshSession().catch(() => {}),
      s.refreshAdapters().catch(() => {}),
    ]);
  },
  toast: (kind, text) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 5200);
  },
  pushEvent: (e) => {
    set((s) => ({ events: [...s.events.slice(-299), e] }));
    const s = get();
    if (
      [
        'revision.committed',
        'baseline.changed',
        'impact.propagated',
        'file.external_edit',
        'bom.changed',
        'component.offer_added',
        'artifact.archived',
      ].includes(e.type)
    ) {
      void s.refreshArtifacts();
      void s.refreshGraph();
    }
    if (['proposal.submitted', 'proposal.resolved'].includes(e.type)) {
      void s.refreshProposals();
      void s.refreshArtifacts();
      void s.refreshGraph();
    }
    if (e.type === 'project.intent_changed' || e.type === 'project.renamed') {
      const d = (e.data ?? {}) as { intent?: string; name?: string };
      if (s.project)
        set({
          project: {
            ...s.project,
            ...(typeof d.intent === 'string' ? { intent: d.intent } : {}),
            ...(typeof d.name === 'string' ? { name: d.name } : {}),
          },
        });
    }
    if (e.type === 'job.updated') void s.refreshJobs();
    if (e.type === 'ui.suggested_action') {
      const d = e.data as { title: string; detail?: string };
      set((x) => ({ suggestions: [...x.suggestions.slice(-5), d] }));
    }
    if (e.type === 'ui.open_artifact') s.focus((e.data as { artifactId: string }).artifactId);
    if (e.type === 'ui.request_review') {
      const d = (e.data ?? {}) as { proposalId?: string };
      s.decide(d.proposalId ?? null);
    }
    if (e.type === 'ui.focus_terminal') showAgent();
  },
}));
