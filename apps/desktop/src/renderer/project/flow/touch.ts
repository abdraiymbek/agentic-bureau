import type { ProjectEvent } from '@omenflow/contracts';

/** How long an object keeps the agent-touch ring after the agent last changed it. */
export const TOUCH_WINDOW_MS = 15 * 60 * 1000;

export interface AgentTouches {
  /** Objects the agent changed within the window. */
  ids: Set<string>;
  /** When the earliest of those touches lapses, so the ring can be taken off on time. */
  nextExpiry: number | null;
}

/**
 * Objects named by an agent-origin event in the last `windowMs`. Only recorded events count;
 * nothing is inferred from what the agent might be doing.
 */
export function agentTouches(
  events: Pick<ProjectEvent, 'origin' | 'ts' | 'data'>[],
  now: number,
  windowMs = TOUCH_WINDOW_MS,
): AgentTouches {
  const latest = new Map<string, number>();
  for (const event of events) {
    if (event.origin !== 'agent') continue;
    const id = (event.data as { artifactId?: unknown } | null)?.artifactId;
    const at = new Date(event.ts).getTime();
    if (typeof id !== 'string' || !Number.isFinite(at)) continue;
    latest.set(id, Math.max(latest.get(id) ?? at, at));
  }
  const ids = new Set<string>();
  let nextExpiry: number | null = null;
  for (const [id, at] of latest) {
    const expires = at + windowMs;
    if (expires <= now) continue;
    ids.add(id);
    nextExpiry = nextExpiry === null ? expires : Math.min(nextExpiry, expires);
  }
  return { ids, nextExpiry };
}
