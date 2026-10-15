/**
 * A small performance probe for development builds. It places User Timing marks and measures
 * (visible in the browser's performance panel) around startup and every sync request, keeps
 * request counters on `window.__omenSync`, and logs one debug line per request so a
 * regression in refresh volume or latency shows up while working. Production builds compile
 * every call to nothing.
 */

const enabled =
  import.meta.env.DEV &&
  import.meta.env.MODE !== 'test' &&
  typeof performance !== 'undefined' &&
  typeof performance.mark === 'function';

export interface SyncCounters {
  /** Requests per resource since the page loaded. */
  requests: Record<string, number>;
  /** Responses dropped as superseded or stale. */
  dropped: number;
  /** Last request duration per resource, in milliseconds. */
  lastMs: Record<string, number>;
}

const counters: SyncCounters = { requests: {}, dropped: 0, lastMs: {} };
if (enabled) (globalThis as { __omenSync?: SyncCounters }).__omenSync = counters;

export function perfMark(name: string): void {
  if (enabled) performance.mark(`omen:${name}`);
}

/** Measures from the mark `start` to now under `name`. */
export function perfMeasure(name: string, start: string): void {
  if (!enabled) return;
  try {
    performance.measure(`omen:${name}`, `omen:${start}`);
  } catch {
    /* the start mark was not placed in this page */
  }
}

export function perfSync(resource: string, info: { ms: number; applied: boolean; ok: boolean }) {
  if (!enabled) return;
  counters.requests[resource] = (counters.requests[resource] ?? 0) + 1;
  counters.lastMs[resource] = info.ms;
  if (!info.applied) counters.dropped++;
  const outcome = !info.ok ? 'failed' : info.applied ? 'applied' : 'dropped';
  console.debug(
    `[omen sync] ${resource} ${outcome} in ${Math.round(info.ms)} ms · request ${counters.requests[resource]}`,
  );
}
