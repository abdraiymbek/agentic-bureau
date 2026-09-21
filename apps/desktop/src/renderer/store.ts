import { create } from 'zustand';
import type {
  AdapterStatus,
  ArtifactView,
  Job,
  Project,
  ProjectEvent,
  Proposal,
  SessionInfo,
  StaleRecord,
} from '@omenflow/contracts';
import { cmd } from './api';

export type Nav =
  | 'overview'
  | 'requirements'
  | 'components'
  | 'artifacts'
  | 'reviews'
  | 'history'
  | 'files'
  | 'connections'
  | 'design-system';

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'ok';
  text: string;
}

interface State {
  projectId: string | null;
  project: Project | null;
  projectPath: string | null;
  readOnly: boolean;
  recents: string[];
  artifacts: ArtifactView[];
  selectedArtifactId: string | null;
  /** Most recently worked-on objects, newest first. The sidebar shows these as the working set. */
  recentArtifactIds: string[];
  nav: Nav;
  proposals: Proposal[];
  events: ProjectEvent[];
  session: SessionInfo | null;
  adapters: AdapterStatus[];
  stale: Record<string, StaleRecord[]>;
  jobs: Job[];
  suggestions: { title: string; detail?: string }[];
  terminalExpanded: boolean;
  sidecarOpen: boolean;
  sidecarTab: 'agent' | 'inspector';
  sidebarOpen: boolean;
  theme: 'dark' | 'light';
  density: 'comfortable' | 'compact';
  paletteOpen: boolean;
  quickOpen: boolean;
  toasts: Toast[];

  setActive: (projectId: string | null) => void;
  set: (p: Partial<State>) => void;
  refreshArtifacts: () => Promise<void>;
  refreshProposals: () => Promise<void>;
  refreshEvents: () => Promise<void>;
  refreshJobs: () => Promise<void>;
  refreshAdapters: () => Promise<void>;
  refreshSession: () => Promise<void>;
  selectArtifact: (id: string | null) => void;
  /** Select an object and move to the workspace that edits its type. */
  openArtifact: (id: string, type: string) => void;
  navigate: (n: Nav) => void;
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

const RECENT_LIMIT = 6;
const recentKey = (projectId: string) => `omen.recent.${projectId}`;
function readRecents(projectId: string | null): string[] {
  if (!projectId) return [];
  try {
    const raw = localStorage.getItem(recentKey(projectId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
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
    /* the working set is a convenience; storage failure is not an error */
  }
}

/** The workspace that edits an object of this type. */
export function navForType(type: string): Nav {
  if (type === 'requirement' || type === 'assumption') return 'requirements';
  return 'artifacts';
}

export const useStore = create<State>((set, get) => ({
  projectId: null,
  project: null,
  projectPath: null,
  readOnly: false,
  recents: [],
  artifacts: [],
  selectedArtifactId: null,
  recentArtifactIds: [],
  nav: 'overview',
  proposals: [],
  events: [],
  session: null,
  adapters: [],
  stale: {},
  jobs: [],
  suggestions: [],
  terminalExpanded: false,
  sidecarOpen: true,
  sidecarTab: 'agent',
  sidebarOpen: true,
  theme: readPreference('omen.theme') === 'light' ? 'light' : 'dark',
  density: readPreference('omen.density') === 'compact' ? 'compact' : 'comfortable',
  paletteOpen: false,
  quickOpen: false,
  toasts: [],

  set: (p) => {
    // Opening or switching projects swaps the remembered working set with it.
    if ('projectId' in p && p.projectId !== get().projectId) {
      projectGeneration++;
      set({
        artifacts: [],
        proposals: [],
        events: [],
        jobs: [],
        session: null,
        stale: {},
        selectedArtifactId: null,
        ...p,
        recentArtifactIds: readRecents(p.projectId ?? null),
      });
      return;
    }
    set(p);
  },
  setActive: (projectId) => {
    projectGeneration++;
    set({
      projectId,
      artifacts: [],
      proposals: [],
      events: [],
      jobs: [],
      session: null,
      stale: {},
      selectedArtifactId: null,
      recentArtifactIds: readRecents(projectId),
    });
    void window.omenflow.setActiveProject(projectId);
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
  refreshProposals: async () => {
    const { projectId } = get();
    const generation = projectGeneration;
    if (!projectId) return;
    const r = await cmd<{ proposals: Proposal[] }>('proposal.list', {}, { projectId });
    if (generation !== projectGeneration) return;
    set({ proposals: r.proposals });
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
    if (generation !== projectGeneration) return;
    set({ events: r.events.slice(-300) });
  },
  refreshJobs: async () => {
    const { projectId } = get();
    const generation = projectGeneration;
    if (!projectId) return;
    const r = await cmd<{ jobs: Job[] }>('job.list', { limit: 50 }, { projectId });
    if (generation !== projectGeneration) return;
    set({ jobs: r.jobs });
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
    if (generation !== projectGeneration) return;
    set({ session: r.session });
  },
  selectArtifact: (id) => {
    if (!id) {
      set({ selectedArtifactId: null });
      return;
    }
    const { projectId, recentArtifactIds } = get();
    const recentIds = [id, ...recentArtifactIds.filter((x) => x !== id)].slice(0, RECENT_LIMIT);
    writeRecents(projectId, recentIds);
    set({ selectedArtifactId: id, recentArtifactIds: recentIds });
  },
  openArtifact: (id, type) => {
    get().selectArtifact(id);
    set({ nav: navForType(type) });
  },
  navigate: (nav) => set({ nav }),
  toast: (kind, text) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 5000);
  },
  pushEvent: (e) => {
    set((s) => ({ events: [...s.events.slice(-299), e] }));
    const s = get();
    // Refresh derived state on domain events.
    if (
      [
        'revision.committed',
        'baseline.changed',
        'impact.propagated',
        'file.external_edit',
        'bom.changed',
      ].includes(e.type)
    ) {
      void s.refreshArtifacts();
    }
    if (['proposal.submitted', 'proposal.resolved'].includes(e.type)) {
      void s.refreshProposals();
      void s.refreshArtifacts();
    }
    if (e.type === 'job.updated') void s.refreshJobs();
    if (e.type === 'ui.suggested_action') {
      const d = e.data as { title: string; detail?: string };
      set((x) => ({ suggestions: [...x.suggestions.slice(-9), d] }));
    }
    if (e.type === 'ui.open_artifact') {
      const d = e.data as { artifactId: string };
      const type = s.artifacts.find((v) => v.artifact.id === d.artifactId)?.artifact.type;
      s.openArtifact(d.artifactId, type ?? 'note');
    }
    if (e.type === 'ui.request_review') {
      s.navigate('reviews');
    }
    if (e.type === 'ui.focus_terminal') {
      window.dispatchEvent(new CustomEvent('omenflow:focus-terminal'));
    }
  },
}));
