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
} from '@stark/contracts';
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

export const useStore = create<State>((set, get) => ({
  projectId: null,
  project: null,
  projectPath: null,
  readOnly: false,
  recents: [],
  artifacts: [],
  selectedArtifactId: null,
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

  set: (p) => set(p),
  setActive: (projectId) => {
    set({ projectId });
    void window.stark.setActiveProject(projectId);
  },
  refreshArtifacts: async () => {
    const { projectId } = get();
    if (!projectId) return;
    const r = await cmd<{ artifacts: ArtifactView[] }>(
      'artifact.list',
      { includeArchived: false, limit: 500 },
      { projectId },
    );
    const stale: Record<string, StaleRecord[]> = {};
    for (const v of r.artifacts) stale[v.artifact.id] = v.staleReasons;
    set({ artifacts: r.artifacts, stale });
  },
  refreshProposals: async () => {
    const { projectId } = get();
    if (!projectId) return;
    const r = await cmd<{ proposals: Proposal[] }>('proposal.list', {}, { projectId });
    set({ proposals: r.proposals });
  },
  refreshEvents: async () => {
    const { projectId } = get();
    if (!projectId) return;
    const r = await cmd<{ events: ProjectEvent[] }>(
      'project.changes_since',
      { seq: 0 },
      { projectId },
    );
    set({ events: r.events.slice(-300) });
  },
  refreshJobs: async () => {
    const { projectId } = get();
    if (!projectId) return;
    const r = await cmd<{ jobs: Job[] }>('job.list', { limit: 50 }, { projectId });
    set({ jobs: r.jobs });
  },
  refreshAdapters: async () => {
    const r = await cmd<{ adapters: AdapterStatus[] }>('connection.list', {});
    set({ adapters: r.adapters });
  },
  refreshSession: async () => {
    const { projectId } = get();
    if (!projectId) return;
    const r = await cmd<{ session: SessionInfo | null }>('terminal.state', {}, { projectId });
    set({ session: r.session });
  },
  selectArtifact: (id) => set({ selectedArtifactId: id }),
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
      s.selectArtifact(d.artifactId);
      s.navigate('artifacts');
    }
    if (e.type === 'ui.request_review') {
      s.navigate('reviews');
    }
    if (e.type === 'ui.focus_terminal') {
      window.dispatchEvent(new CustomEvent('stark:focus-terminal'));
    }
  },
}));
