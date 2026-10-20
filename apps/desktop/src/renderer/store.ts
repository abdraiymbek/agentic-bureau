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
import { cmd, errMsg, type RecoverableCommandError } from './api';
import { askAgent, showAgent } from './lib/actions';
import { lensDef, type Lens } from './project/lenses';
import {
  CORE_RESOURCES,
  IDLE_LOAD,
  PARTS_EVENTS,
  PROJECT_RESOURCES,
  createSyncScheduler,
  resourcesForEvent,
  type ResourceLoad,
  type SyncResource,
} from './lib/sync';
import { shareDeep, shareList } from './lib/share';
import {
  EMPTY_WINDOW,
  insertEvent,
  mergeTail,
  olderMayExist,
  prependOlder,
  type EventWindow,
} from './lib/event-window';
import {
  clearAllUnsaved,
  guardLeave,
  hasUnsavedWork,
  heldArtifactIds,
  setLeavePrompt,
  subscribeUnsaved,
  type LeaveRequest,
} from './lib/dirty';
import { unsavedEdits } from './lib/unsaved-edits';
import {
  pushHistory,
  sameView,
  stepBack,
  stepForward,
  zoomOutTarget,
  type History,
} from './lib/navigation';
import {
  DEFAULT_PROJECT_PREFS,
  PREF_KEYS,
  parseProjectPrefs,
  parseRails,
  parseRecents,
  parseTheme,
  readRaw,
  serializeProjectPrefs,
  writeRaw,
  type RailPrefs,
  type SavedView,
} from './lib/preferences';
import { clearViewMemory } from './lib/view-memory';
import { perfSync } from './lib/perf';
import { evidenceArtifactIds } from './lib/evidence-invalidation';

export type { Lens };
export type { LoadStatus, ResourceLoad, SyncResource } from './lib/sync';

/**
 * Where the engineer is. Omen Flow has three zoom levels instead of pages:
 * the whole project (seen through a lens), one object in focus, and one decision.
 * The agent is its own tab on the activity bar, beside the zoom levels.
 */
export type View =
  | { level: 'agent' }
  | { level: 'project'; lens: Lens }
  | { level: 'object'; id: string; revisionId?: string | null }
  | { level: 'decide'; proposalId: string | null }
  | { level: 'system' };

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'ok';
  text: string;
}

/** Resources with a load state: the project's, and the agent CLIs detected on this machine. */
export type LoadResource = SyncResource | 'adapters';

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
  /** The newest project events, oldest first. Older ones page in with `loadOlderEvents`. */
  events: ProjectEvent[];
  session: SessionInfo | null;
  adapters: AdapterStatus[];
  jobs: Job[];
  suggestions: { title: string; detail?: string }[];
  /** Most recently focused objects, newest first; remembered per project. */
  recentIds: string[];

  /** Load state per resource. A refresh of loaded data keeps `ready`; see `ResourceLoad`. */
  load: Record<LoadResource, ResourceLoad>;
  /**
   * The project's record (objects, links, proposals) has loaded once since it opened. Until
   * then an empty list means "not loaded yet", never "empty project".
   */
  firstLoadComplete: boolean;
  /** Events older than the first one in `events` exist and can be loaded. */
  hasOlderEvents: boolean;
  olderEvents: 'idle' | 'loading' | 'error';
  /**
   * Objects whose newer server copy is being held back because an editor registered unsaved
   * work on them (`lib/dirty.ts`). The copy applies when the work is saved or discarded.
   */
  heldUpdates: string[];
  /** Increases whenever the bill of materials or offers may have changed. */
  partsVersion: number;
  /** Completed checks and accepted scope can change a proposal without changing its revisions. */
  evidenceVersions: Record<string, number>;
  /** A proposed revision may depend on any baseline, including an input not yet on the graph. */
  baselineVersion: number;
  /** The last failed operation nothing else reported; shown once by the frame. */
  frameError: RecoverableCommandError | null;

  view: View;
  back: View[];
  forward: View[];
  /** The lens the project level was last seen through; zooming out of an object returns to it. */
  lastLens: Lens;
  /** Leaving would discard unsaved work: the frame asks before it happens. */
  leavePrompt: { action: string; labels: string[] } | null;
  /** The floating agent window is open (on any tab except the Agent tab itself). */
  agentWindowOpen: boolean;
  omniOpen: boolean;
  settingsOpen: boolean;
  theme: 'dark' | 'light';
  /** Folded object rails; persisted as `omen.rails`. */
  rails: RailPrefs;
  /** The adapter the user picked in Settings; persisted as `omen.agent`. */
  agentId: string | null;
  toasts: Toast[];

  set: (p: Partial<State>) => void;
  setActive: (projectId: string | null) => void;
  go: (view: View) => void;
  goBack: () => void;
  goForward: () => void;
  zoomOut: () => void;
  focus: (id: string) => void;
  decide: (proposalId?: string | null) => void;
  resolveLeavePrompt: (discard: boolean) => void;
  /**
   * Opens the agent and hands it the text: pasted unsent once its CLI shows a prompt, waiting in
   * a visible queue until then. Never dropped, never submitted.
   */
  askAbout: (text?: string) => void;
  setAgent: (adapterId: string) => void;
  setRailCollapsed: (rail: keyof RailPrefs, collapsed: boolean) => void;
  /** Saves the project intent, showing it at once and restoring the old text if the save fails. */
  updateIntent: (intent: string) => Promise<void>;
  /**
   * Each refresh resolves once data requested after the call has been applied, or the request
   * failed (the failure is in `load`, not thrown).
   */
  refreshArtifacts: () => Promise<void>;
  refreshGraph: () => Promise<void>;
  refreshProposals: () => Promise<void>;
  refreshEvents: () => Promise<void>;
  refreshJobs: () => Promise<void>;
  refreshAdapters: () => Promise<void>;
  refreshSession: () => Promise<void>;
  refreshAll: () => Promise<void>;
  /** Marks resources out of date; they refresh once the current burst of changes settles. */
  invalidate: (resources: SyncResource[]) => void;
  /** Requests again every resource whose last request failed. */
  retryLoad: () => Promise<void>;
  loadOlderEvents: () => Promise<void>;
  /** A session pushed by the host; it outranks any `terminal.state` answer already on its way. */
  receiveSession: (session: SessionInfo | null) => void;
  toast: (kind: Toast['kind'], text: string) => void;
  reportError: (error: RecoverableCommandError) => void;
  dismissFrameError: () => void;
  pushEvent: (e: ProjectEvent) => void;
}

const ARTIFACT_PAGE = 500;
const EVENT_PAGE = 400;
const EVENT_WINDOW = 2000;
const RECENT_LIMIT = 8;
const HOME: View = { level: 'project', lens: 'flow' };

let toastSeq = 0;
/** Events held for the open project, with the bound below which older ones exist. */
let eventWindow: EventWindow = EMPTY_WINDOW;
/** Sequence numbers of the events already acted on as they arrived live, oldest first. */
const liveSeqs = new Set<number>();
const LIVE_SEQ_MEMORY = 4096;
let olderEventsRequest: Promise<void> | null = null;
/** A saved object or decision view, opened once the record has loaded and shows it exists. */
let pendingRestore: SavedView | null = null;
/** The person moved since the project opened, so a saved view is no longer wanted. */
let navigatedSinceOpen = false;
/** A bill-of-materials event arrived: the next artifact list is handed out as a new array. */
let renewArtifactList = false;
let leaveRequest: LeaveRequest | null = null;

const isLens = (id: string) => !!lensDef(id);

const idleLoads = (): Record<LoadResource, ResourceLoad> => ({
  artifacts: IDLE_LOAD,
  graph: IDLE_LOAD,
  proposals: IDLE_LOAD,
  events: IDLE_LOAD,
  jobs: IDLE_LOAD,
  session: IDLE_LOAD,
  adapters: IDLE_LOAD,
});

function writeRecents(projectId: string | null, ids: string[]) {
  if (projectId) writeRaw(PREF_KEYS.recent(projectId), JSON.stringify(ids));
}

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
  forward: [],
  hasOlderEvents: false,
  olderEvents: 'idle' as const,
  heldUpdates: [],
  firstLoadComplete: false,
  frameError: null,
  evidenceVersions: {},
  baselineVersion: 0,
};

export const openProposals = (proposals: Proposal[]) =>
  proposals.filter((p) => p.state === 'pending' || p.state === 'changes_requested');

interface ArtifactPage {
  artifacts: ArtifactView[];
  hasMore?: boolean;
  nextOffset?: number;
}

/** Every artifact, page by page: `artifact.list` returns at most 500 per call. */
async function listAllArtifacts(projectId: string): Promise<ArtifactView[]> {
  const byId = new Map<string, ArtifactView>();
  let offset = 0;
  for (;;) {
    const page = await cmd<ArtifactPage>(
      'artifact.list',
      { includeArchived: false, limit: ARTIFACT_PAGE, offset },
      { projectId },
    );
    for (const view of page.artifacts) byId.set(view.artifact.id, view);
    // Hosts that report paging say so; an older host signals more by filling the page.
    const more = page.hasMore ?? page.artifacts.length === ARTIFACT_PAGE;
    if (!more || page.artifacts.length === 0) return [...byId.values()];
    offset = page.nextOffset ?? offset + page.artifacts.length;
  }
}

interface ChangesPage {
  events: ProjectEvent[];
  highWater: number;
  hasMore: boolean;
}

/** The newest page of the event record, found without reading it from the start. */
async function loadEventTail(projectId: string): Promise<EventWindow> {
  const probe = await cmd<ChangesPage>(
    'project.changes_since',
    { seq: Number.MAX_SAFE_INTEGER },
    { projectId },
  );
  const from = Math.max(0, probe.highWater - EVENT_PAGE);
  const page = await cmd<ChangesPage>('project.changes_since', { seq: from }, { projectId });
  return { events: page.events, from };
}

/** Session metadata without the scrollback the terminal restores by itself. */
function sessionInfo(raw: unknown): SessionInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const info = { ...(raw as Record<string, unknown>) };
  delete info.scrollback;
  delete info.scrollbackCursor;
  return info as unknown as SessionInfo;
}

export const useStore = create<State>((set, get) => {
  const fetchers: Record<SyncResource, (projectId: string) => Promise<unknown>> = {
    artifacts: listAllArtifacts,
    graph: (projectId) =>
      cmd<{ edges: Edge[] }>('graph.list', {}, { projectId }).then((r) => r.edges),
    proposals: (projectId) =>
      cmd<{ proposals: Proposal[] }>('proposal.list', {}, { projectId }).then((r) => r.proposals),
    events: loadEventTail,
    jobs: (projectId) =>
      cmd<{ jobs: Job[] }>('job.list', { limit: 50 }, { projectId }).then((r) => r.jobs),
    session: (projectId) =>
      cmd<{ session: unknown }>('terminal.state', {}, { projectId }).then((r) =>
        sessionInfo(r.session),
      ),
  };

  const applyArtifacts = (incoming: ArtifactView[]) => {
    const s = get();
    let artifacts = shareList(s.artifacts, incoming, (v) => v.artifact.id);
    const held = heldArtifactIds();
    const heldUpdates: string[] = [];
    if (held.size) {
      const before = new Map(s.artifacts.map((v) => [v.artifact.id, v]));
      artifacts = artifacts.map((v) => {
        const kept = before.get(v.artifact.id);
        if (!kept || kept === v || !held.has(v.artifact.id)) return v;
        heldUpdates.push(v.artifact.id);
        return kept;
      });
      if (
        artifacts.every((v, i) => v === s.artifacts[i]) &&
        artifacts.length === s.artifacts.length
      )
        artifacts = s.artifacts;
    }
    // Views that read the bill of materials or offers outside the store key their reads on
    // this list; after such a change they get a new list, with every unchanged item kept.
    if (renewArtifactList && artifacts === s.artifacts) artifacts = [...artifacts];
    renewArtifactList = false;
    const stale: Record<string, StaleRecord[]> = {};
    for (const v of artifacts) stale[v.artifact.id] = v.staleReasons;
    set({
      artifacts,
      stale: shareDeep(s.stale, stale),
      heldUpdates: shareDeep(s.heldUpdates, heldUpdates),
    });
  };

  const setEventWindow = (next: EventWindow) => {
    eventWindow = next;
    set({
      events: shareList(get().events, next.events, (e) => String(e.seq)),
      hasOlderEvents: olderMayExist(next),
    });
  };

  const appliers: Record<SyncResource, (value: unknown) => void> = {
    artifacts: (value) => applyArtifacts(value as ArtifactView[]),
    graph: (value) => set({ edges: shareList(get().edges, value as Edge[], (e) => e.id) }),
    proposals: (value) =>
      set({ proposals: shareList(get().proposals, value as Proposal[], (p) => p.id) }),
    events: (value) => setEventWindow(mergeTail(eventWindow, value as EventWindow, EVENT_WINDOW)),
    jobs: (value) => set({ jobs: shareList(get().jobs, value as Job[], (j) => j.id) }),
    session: (value) => set({ session: shareDeep(get().session, value as SessionInfo | null) }),
  };

  const restoreSavedView = () => {
    const target = pendingRestore;
    pendingRestore = null;
    if (!target || navigatedSinceOpen) return;
    const s = get();
    const exists =
      target.level === 'object'
        ? s.artifacts.some((v) => v.artifact.id === target.id)
        : target.level !== 'decide' ||
          !target.proposalId ||
          s.proposals.some((p) => p.id === target.proposalId);
    if (exists) set({ view: target, back: [s.view], forward: [] });
  };

  const setLoad = (
    resource: LoadResource,
    status: 'loading' | 'ready' | 'error',
    error?: unknown,
  ) => {
    const s = get();
    const prev = s.load[resource];
    const next: ResourceLoad =
      status === 'loading'
        ? prev.loaded
          ? prev
          : { status: 'loading', error: null, loaded: false }
        : status === 'ready'
          ? { status: 'ready', error: null, loaded: true }
          : { status: 'error', error: errMsg(error), loaded: prev.loaded };
    if (next.status === prev.status && next.error === prev.error && next.loaded === prev.loaded)
      return;
    const load = { ...s.load, [resource]: next };
    const firstLoadComplete = s.firstLoadComplete || CORE_RESOURCES.every((r) => load[r].loaded);
    set({ load, firstLoadComplete });
    if (firstLoadComplete && !s.firstLoadComplete) restoreSavedView();
  };

  const projectSync = createSyncScheduler<SyncResource>({
    load: (resource) => {
      const { projectId } = get();
      return projectId ? fetchers[resource](projectId) : Promise.resolve(undefined);
    },
    apply: (resource, value) => {
      if (get().projectId) appliers[resource](value);
    },
    status: (resource, status, error) => setLoad(resource, status, error),
    measured: perfSync,
  });

  // Detected agent CLIs belong to the machine, not the project: switching projects keeps them.
  const appSync = createSyncScheduler<'adapters'>({
    load: () => cmd<{ adapters: AdapterStatus[] }>('connection.list', {}).then((r) => r.adapters),
    apply: (_resource, value) =>
      set({ adapters: shareList(get().adapters, value as AdapterStatus[], (a) => a.adapterId) }),
    status: (resource, status, error) => setLoad(resource, status, error),
    measured: perfSync,
  });

  const refreshProject = (resources: SyncResource[]) =>
    get().projectId ? projectSync.refresh(resources) : Promise.resolve();

  /** Moves to `view` with the given history, recording what the next visit restores. */
  const arrive = (view: View, history: History) => {
    const { projectId, recentIds, lastLens } = get();
    navigatedSinceOpen = true;
    if (view.level === 'object') {
      const ids = [view.id, ...recentIds.filter((x) => x !== view.id)].slice(0, RECENT_LIMIT);
      writeRecents(projectId, ids);
      set({ recentIds: ids });
    }
    set({
      view,
      back: history.back,
      forward: history.forward,
      lastLens: view.level === 'project' ? view.lens : lastLens,
    });
  };

  setLeavePrompt((request) => {
    leaveRequest?.cancel();
    leaveRequest = request;
    set({ leavePrompt: { action: request.action, labels: request.labels } });
  });

  // When an editor saves or discards, objects it was holding catch up with the host.
  let held = new Set<string>();
  subscribeUnsaved(() => {
    const now = heldArtifactIds();
    const released = [...held].some((id) => !now.has(id));
    held = now;
    if (released && get().heldUpdates.length) projectSync.invalidate(['artifacts']);
  });

  return {
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
    load: idleLoads(),
    firstLoadComplete: false,
    hasOlderEvents: false,
    olderEvents: 'idle',
    heldUpdates: [],
    partsVersion: 0,
    evidenceVersions: {},
    baselineVersion: 0,
    frameError: null,
    view: HOME,
    back: [],
    forward: [],
    lastLens: 'flow',
    leavePrompt: null,
    agentWindowOpen: false,
    omniOpen: false,
    settingsOpen: false,
    theme: parseTheme(readRaw(PREF_KEYS.theme)),
    rails: parseRails(readRaw(PREF_KEYS.rails)),
    agentId: readRaw(PREF_KEYS.agent),
    toasts: [],

    set: (p) => set(p),
    setActive: (projectId) => {
      projectSync.reset();
      eventWindow = EMPTY_WINDOW;
      liveSeqs.clear();
      olderEventsRequest = null;
      renewArtifactList = false;
      navigatedSinceOpen = false;
      clearViewMemory();
      clearAllUnsaved();
      unsavedEdits.clear();
      const prefs = projectId
        ? parseProjectPrefs(readRaw(PREF_KEYS.project(projectId)), isLens)
        : DEFAULT_PROJECT_PREFS;
      const saved = prefs.view;
      const lastLens = prefs.lens ?? 'flow';
      // Lenses and the agent tab open at once; an object or decision waits for the record.
      const view: View =
        saved && (saved.level === 'project' || saved.level === 'agent')
          ? saved
          : { level: 'project', lens: lastLens };
      pendingRestore = saved && saved !== view ? saved : null;
      const { adapters } = get().load;
      set({
        projectId,
        ...emptyProject,
        // Until the record is read, nothing shown is the start of it.
        hasOlderEvents: !!projectId,
        load: { ...idleLoads(), adapters },
        view,
        lastLens,
        agentWindowOpen: prefs.agentWindowOpen,
        recentIds: projectId
          ? parseRecents(readRaw(PREF_KEYS.recent(projectId)), RECENT_LIMIT)
          : [],
      });
      void window.omenflow.setActiveProject(projectId);
    },
    go: (view) => {
      if (sameView(view, get().view)) return;
      guardLeave(() => {
        const s = get();
        if (!sameView(view, s.view)) arrive(view, pushHistory(s, s.view));
      });
    },
    // With nowhere to step, nothing is left and nothing is asked.
    goBack: () => {
      const s = get();
      if (!stepBack(s, s.view)) return;
      guardLeave(() => {
        const now = get();
        const step = stepBack(now, now.view);
        if (step) arrive(step.view, step);
      });
    },
    goForward: () => {
      const s = get();
      if (!stepForward(s, s.view)) return;
      guardLeave(() => {
        const now = get();
        const step = stepForward(now, now.view);
        if (step) arrive(step.view, step);
      });
    },
    zoomOut: () => {
      const s = get();
      const target = zoomOutTarget(s.view, s.back, s.lastLens, !!s.projectId);
      if (target) s.go(target);
    },
    focus: (id) => get().go({ level: 'object', id }),
    decide: (proposalId = null) => get().go({ level: 'decide', proposalId }),
    resolveLeavePrompt: (discard) => {
      const request = leaveRequest;
      leaveRequest = null;
      set({ leavePrompt: null });
      if (discard) request?.proceed();
      else request?.cancel();
    },
    askAbout: (text = '') => {
      askAgent(text);
    },
    setAgent: (adapterId) => {
      writeRaw(PREF_KEYS.agent, adapterId);
      set({ agentId: adapterId });
    },
    setRailCollapsed: (rail, collapsed) => {
      const rails = { ...get().rails, [rail]: collapsed };
      writeRaw(PREF_KEYS.rails, JSON.stringify(rails));
      set({ rails });
    },
    updateIntent: async (intent) => {
      const { project, projectId } = get();
      if (!project || !projectId || intent === project.intent) return;
      const previous = project.intent;
      set({ project: { ...project, intent } });
      try {
        await cmd('project.update_intent', { intent }, { projectId });
      } catch (e) {
        // Put the old text back unless something newer replaced it meanwhile.
        const now = get().project;
        if (get().projectId === projectId && now?.intent === intent)
          set({ project: { ...now, intent: previous } });
        throw e;
      }
    },

    refreshArtifacts: () => refreshProject(['artifacts']),
    refreshGraph: () => refreshProject(['graph']),
    refreshProposals: () => refreshProject(['proposals']),
    refreshEvents: () => refreshProject(['events']),
    refreshJobs: () => refreshProject(['jobs']),
    refreshAdapters: () => appSync.refresh(['adapters']),
    refreshSession: () => refreshProject(['session']),
    refreshAll: () =>
      Promise.all([refreshProject([...PROJECT_RESOURCES]), appSync.refresh(['adapters'])]).then(
        () => undefined,
      ),
    invalidate: (resources) => {
      if (get().projectId) projectSync.invalidate(resources);
    },
    retryLoad: () => {
      const { load } = get();
      const failed = PROJECT_RESOURCES.filter((r) => load[r].status === 'error');
      return Promise.all([
        refreshProject(failed),
        load.adapters.status === 'error' ? appSync.refresh(['adapters']) : undefined,
      ]).then(() => undefined);
    },
    loadOlderEvents: () => {
      const { projectId } = get();
      if (!projectId) return Promise.resolve();
      // Nothing has been read from the record yet: earlier entries come with its newest page.
      if (eventWindow.unread)
        return projectSync.inFlight().includes('events')
          ? Promise.resolve()
          : refreshProject(['events']);
      if (eventWindow.from <= 0) return Promise.resolve();
      if (olderEventsRequest) return olderEventsRequest;
      const generation = projectSync.generation;
      const until = eventWindow.from;
      const from = Math.max(0, until - EVENT_PAGE);
      set({ olderEvents: 'loading' });
      const request = cmd<ChangesPage>('project.changes_since', { seq: from }, { projectId })
        .then(
          (page) => {
            if (generation !== projectSync.generation) return;
            setEventWindow(prependOlder(eventWindow, { events: page.events, from }));
            set({ olderEvents: 'idle' });
          },
          (error: unknown) => {
            if (generation !== projectSync.generation) return;
            set({ olderEvents: 'error' });
            get().toast('error', errMsg(error));
          },
        )
        .finally(() => {
          if (olderEventsRequest === request) olderEventsRequest = null;
        });
      olderEventsRequest = request;
      return request;
    },
    receiveSession: (session) => {
      if (!get().projectId) return;
      projectSync.supersede('session');
      appliers.session(sessionInfo(session));
    },
    toast: (kind, text) => {
      const id = ++toastSeq;
      set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
      setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 5200);
    },
    reportError: (error) => set({ frameError: error }),
    dismissFrameError: () => set({ frameError: null }),
    pushEvent: (e) => {
      const s = get();
      if (!s.projectId || (e.projectId && e.projectId !== s.projectId)) return;
      // Each live event is acted on once. One the tail read already returned still is: the read
      // can overtake the event's delivery, so data loaded beside it may predate the change.
      if (liveSeqs.has(e.seq)) return;
      liveSeqs.add(e.seq);
      if (liveSeqs.size > LIVE_SEQ_MEMORY) liveSeqs.delete(liveSeqs.values().next().value!);
      const next = insertEvent(eventWindow, e, EVENT_WINDOW);
      if (next !== eventWindow) setEventWindow(next);
      const evidenceIds = evidenceArtifactIds(e);
      if (evidenceIds.length) {
        const versions = { ...get().evidenceVersions };
        for (const id of evidenceIds) versions[id] = (versions[id] ?? 0) + 1;
        set({ evidenceVersions: versions });
      }
      if (e.type === 'baseline.changed') set({ baselineVersion: get().baselineVersion + 1 });
      if (PARTS_EVENTS.has(e.type)) {
        renewArtifactList = true;
        set({ partsVersion: get().partsVersion + 1 });
      }
      projectSync.invalidate(resourcesForEvent(e.type));
      if (e.type === 'project.intent_changed' || e.type === 'project.renamed') {
        const d = (e.data ?? {}) as { intent?: string; name?: string };
        const project = get().project;
        if (project)
          set({
            project: {
              ...project,
              ...(typeof d.intent === 'string' ? { intent: d.intent } : {}),
              ...(typeof d.name === 'string' ? { name: d.name } : {}),
            },
          });
      }
      if (e.type === 'ui.suggested_action') {
        const d = e.data as { title: string; detail?: string };
        set((x) => ({ suggestions: [...x.suggestions.slice(-5), d] }));
      }
      if (e.type === 'ui.open_artifact' || e.type === 'ui.request_review') {
        // The agent asks; it does not get to discard what the person is typing.
        if (hasUnsavedWork()) {
          get().toast(
            'info',
            e.type === 'ui.open_artifact'
              ? 'The agent asked to open an object. You have unsaved changes, so the view stayed.'
              : 'The agent asked for your review. You have unsaved changes, so the view stayed.',
          );
          return;
        }
        if (e.type === 'ui.open_artifact')
          get().focus((e.data as { artifactId: string }).artifactId);
        else get().decide(((e.data ?? {}) as { proposalId?: string }).proposalId ?? null);
      }
      if (e.type === 'ui.focus_terminal') showAgent();
    },
  };
});

// Preferences follow the state they describe. Writes wait for the first load so the view a
// project opens on is never saved over the one it was asked to restore.
useStore.subscribe((s, prev) => {
  if (s.theme !== prev.theme) writeRaw(PREF_KEYS.theme, s.theme);
  if (!s.projectId || s.projectId !== prev.projectId || !s.firstLoadComplete) return;
  if (
    s.view === prev.view &&
    s.lastLens === prev.lastLens &&
    s.agentWindowOpen === prev.agentWindowOpen &&
    s.firstLoadComplete === prev.firstLoadComplete
  )
    return;
  const saved = parseProjectPrefs(readRaw(PREF_KEYS.project(s.projectId)), isLens);
  writeRaw(
    PREF_KEYS.project(s.projectId),
    serializeProjectPrefs({
      view: s.view.level === 'system' ? saved.view : s.view,
      lens: s.lastLens,
      agentWindowOpen: s.agentWindowOpen,
    }),
  );
});
