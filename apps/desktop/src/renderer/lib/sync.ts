/**
 * The project sync engine. Project events say what changed; this module decides which store
 * resources that makes stale, waits for a burst to settle, asks for each stale resource once,
 * and hands a response to the store only while it is still the newest one for that resource
 * and for the open project. Fetching and applying are the store's business (`store.ts`).
 */

/** Store data that is read from the host and kept in step with project events. */
export type SyncResource = 'artifacts' | 'graph' | 'proposals' | 'events' | 'jobs' | 'session';

export const PROJECT_RESOURCES: readonly SyncResource[] = [
  'artifacts',
  'graph',
  'proposals',
  'events',
  'jobs',
  'session',
];

/** The record a project view is drawn from; loading it is what "the project has loaded" means. */
export const CORE_RESOURCES: readonly SyncResource[] = ['artifacts', 'graph', 'proposals'];

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ResourceLoad {
  /**
   * `loading` only until the first answer for the open project; a later refresh of loaded data
   * keeps `ready` so views never fall back to a skeleton. `error` is the outcome of the last
   * request, whether or not earlier data is still shown.
   */
  status: LoadStatus;
  /** The last failure, as the host worded it. */
  error: string | null;
  /** Data from the open project has been applied at least once. */
  loaded: boolean;
}

export const IDLE_LOAD: ResourceLoad = { status: 'idle', error: null, loaded: false };

const CORE = ['artifacts', 'graph', 'proposals'] as const;

/**
 * Which resources each event type makes stale, and nothing more. Artifact views carry
 * freshness, stale reasons, draft counts and the pending-proposal flag, so anything touching
 * those refreshes `artifacts`. The graph is drawn from baselines and recorded links only, so a
 * draft does not refresh it. A moved baseline can move a pending proposal's base, so it refreshes
 * proposals too. An empty list means the store applies the event itself (or it is navigation).
 */
export const EVENT_RESOURCES: Readonly<Record<string, readonly SyncResource[]>> = {
  'revision.committed': ['artifacts'],
  'baseline.changed': ['artifacts', 'graph', 'proposals'],
  'impact.propagated': ['artifacts'],
  'stale.changed': ['artifacts'],
  'file.external_edit': ['artifacts'],
  'bom.changed': ['artifacts'],
  'component.offer_added': ['artifacts'],
  'cad.scope.accepted': ['artifacts'],
  'artifact.archived': ['artifacts', 'graph'],
  'artifact.renamed': ['artifacts'],
  'graph.changed': ['graph', 'artifacts'],
  'proposal.submitted': ['proposals', 'artifacts'],
  'proposal.resolved': ['proposals', 'artifacts', 'graph'],
  'job.updated': ['jobs'],
  'session.state': ['session'],
  'project.intent_changed': [],
  // An export writes a file and a job; the job arrives as job.updated.
  'cad.exported': [],
  'build.exported': [],
  'project.renamed': [],
  'ui.suggested_action': [],
  'ui.open_artifact': [],
  'ui.request_review': [],
  'ui.focus_terminal': [],
};

/**
 * Resources an event makes stale. An event type this build does not know comes from a newer
 * host and may change anything in the record, so it refreshes the core record rather than
 * leaving the screen silently out of date. `ui.*` events never touch the record.
 */
export function resourcesForEvent(type: string): readonly SyncResource[] {
  const known = EVENT_RESOURCES[type];
  if (known) return known;
  return type.startsWith('ui.') ? [] : CORE;
}

/** Events that change the bill of materials or offers, which views read outside the store. */
export const PARTS_EVENTS: ReadonlySet<string> = new Set([
  'bom.changed',
  'component.offer_added',
  'proposal.resolved',
]);

export interface SyncClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
  queueMicrotask(fn: () => void): void;
}

const systemClock: SyncClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  queueMicrotask: (fn) => queueMicrotask(fn),
};

export interface SyncOptions<R extends string> {
  /** Reads the resource from the host. One call per request; it may page internally. */
  load(resource: R): Promise<unknown>;
  /** Called with a response that is still the newest one for this resource and project. */
  apply(resource: R, value: unknown): void;
  /** A request starts (`loading`), succeeds (`ready`) or fails (`error`). */
  status(resource: R, status: 'loading' | 'ready' | 'error', error?: unknown): void;
  /** Fired after each completed request, applied or dropped, for the development probe. */
  measured?(resource: R, info: { ms: number; applied: boolean; ok: boolean }): void;
  /** Quiet period after the last invalidation before requests go out. */
  delayMs?: number;
  /** Longest an invalidation waits while events keep arriving. */
  maxWaitMs?: number;
  clock?: SyncClock;
}

export interface SyncScheduler<R extends string> {
  /** Increases on every `reset`; responses from an earlier generation are dropped. */
  readonly generation: number;
  /** A different project (or none) is open: forget pending work and drop answers in flight. */
  reset(): void;
  /** Something changed: refresh these after the burst settles. */
  invalidate(resources: Iterable<R>): void;
  /**
   * Refresh these now. Resolves once a request that started after this call has finished
   * (applied, failed, or made obsolete by a reset), so the caller sees data at least as new as
   * the moment it asked. It never rejects: failures are reported through `status`.
   */
  refresh(resources: Iterable<R>): Promise<void>;
  /** The store received a newer value by push: answers to requests already sent are dropped. */
  supersede(resource: R): void;
  /** Send every pending request now instead of waiting for the quiet period. */
  flush(): void;
  /** Resources waiting to be requested. */
  pending(): R[];
  /** Resources with a request on the wire. */
  inFlight(): R[];
}

interface Slot {
  /** Bumped by each need for newer data. */
  wanted: number;
  /** `wanted` when the request in flight (or the last one) started. */
  started: number;
  /** `wanted` of the last finished request. */
  done: number;
  /** Bumped on every start and supersede; a response applies only with the current token. */
  token: number;
  inFlight: boolean;
  waiters: { target: number; resolve: () => void }[];
}

export function createSyncScheduler<R extends string>(options: SyncOptions<R>): SyncScheduler<R> {
  const clock = options.clock ?? systemClock;
  const delay = options.delayMs ?? 80;
  const maxWait = options.maxWaitMs ?? 400;
  let generation = 0;
  let slots = new Map<R, Slot>();
  const dirty = new Set<R>();
  let timer: unknown = null;
  let firstDirtyAt = 0;
  let microtask = false;

  const slot = (resource: R) => {
    let s = slots.get(resource);
    if (!s) {
      s = { wanted: 0, started: 0, done: 0, token: 0, inFlight: false, waiters: [] };
      slots.set(resource, s);
    }
    return s;
  };

  const settle = (s: Slot) => {
    const ready = s.waiters.filter((w) => w.target <= s.done);
    s.waiters = s.waiters.filter((w) => w.target > s.done);
    for (const w of ready) w.resolve();
  };

  const cancelTimer = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };

  const start = (resource: R) => {
    const s = slot(resource);
    const owner = slots;
    const token = ++s.token;
    s.inFlight = true;
    s.started = s.wanted;
    dirty.delete(resource);
    const began = clock.now();
    options.status(resource, 'loading');
    const finish = (ok: boolean, value: unknown, error: unknown) => {
      // A reset replaced the slots: this answer belongs to a project that is no longer open.
      if (owner !== slots) return;
      s.inFlight = false;
      s.done = Math.max(s.done, s.started);
      const current = token === s.token;
      if (current) {
        if (ok) {
          options.apply(resource, value);
          options.status(resource, 'ready');
        } else options.status(resource, 'error', error);
      }
      options.measured?.(resource, { ms: clock.now() - began, applied: current && ok, ok });
      settle(s);
      // Newer data was asked for while this request was out: ask again, unless the quiet
      // period of a burst is still running and will do it.
      if (s.wanted > s.started && timer === null) start(resource);
    };
    let pending: Promise<unknown>;
    try {
      pending = options.load(resource);
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (value) => finish(true, value, null),
      (error: unknown) => finish(false, undefined, error),
    );
  };

  const flush = () => {
    cancelTimer();
    microtask = false;
    for (const resource of [...dirty]) if (!slot(resource).inFlight) start(resource);
  };

  const schedule = () => {
    const now = clock.now();
    if (timer === null) firstDirtyAt = now;
    else clock.clearTimeout(timer);
    const wait = Math.max(0, Math.min(delay, firstDirtyAt + maxWait - now));
    timer = clock.setTimeout(flush, wait);
  };

  return {
    get generation() {
      return generation;
    },
    reset() {
      generation++;
      cancelTimer();
      dirty.clear();
      const previous = slots;
      slots = new Map();
      for (const s of previous.values()) for (const w of s.waiters) w.resolve();
    },
    invalidate(resources) {
      let any = false;
      for (const resource of resources) {
        slot(resource).wanted++;
        dirty.add(resource);
        any = true;
      }
      if (any) schedule();
    },
    refresh(resources) {
      const waits: Promise<void>[] = [];
      for (const resource of resources) {
        const s = slot(resource);
        const target = ++s.wanted;
        dirty.add(resource);
        waits.push(new Promise<void>((resolve) => s.waiters.push({ target, resolve })));
      }
      // Requests asked for in the same task go out together, once each.
      if (waits.length && !microtask) {
        microtask = true;
        clock.queueMicrotask(flush);
      }
      return Promise.all(waits).then(() => undefined);
    },
    supersede(resource) {
      const s = slot(resource);
      s.token++;
      s.done = Math.max(s.done, s.started);
      settle(s);
    },
    flush,
    pending: () => [...dirty],
    inFlight: () => [...slots.entries()].filter(([, s]) => s.inFlight).map(([r]) => r),
  };
}
