/**
 * The slice of the project's event record the renderer holds: every event with a sequence
 * number above `from`, oldest first, each once. `from === 0` means the slice reaches the start
 * of the record; anything above zero means older events exist and can be paged in. Nothing is
 * dropped without moving `from`, so a cap is never silent. Until the record has been read once
 * (`unread`) the slice holds only live events and says nothing about where the record starts.
 */
import type { ProjectEvent } from '@bureau/contracts';

export interface EventWindow {
  events: ProjectEvent[];
  /** Exclusive lower bound: the window holds every recorded event with `seq > from`. */
  from: number;
  /** Older pages were loaded on request; they are kept rather than capped away. */
  paged?: boolean;
  /**
   * No tail of the record has been read since the project opened. The events held arrived live,
   * so `from` is not a lower bound and the start of the record is unknown.
   */
  unread?: boolean;
}

export const EMPTY_WINDOW: EventWindow = { events: [], from: 0, unread: true };

/** Events older than the first one held exist, or may: the record has not been read yet. */
export function olderMayExist(window: EventWindow): boolean {
  return !!window.unread || window.from > 0;
}

function indexOfSeq(events: readonly ProjectEvent[], seq: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.seq < seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Keeps the newest `max` events, moving `from` past any that had to go. */
function capped(window: EventWindow, max: number): EventWindow {
  if (window.paged || window.events.length <= max) return window;
  const drop = window.events.length - max;
  return { ...window, events: window.events.slice(drop), from: window.events[drop - 1]!.seq };
}

/**
 * Adds one live event. Returns the same window when the event is already held or too old.
 * Past `max` the oldest events give way, unless the person paged older events in on purpose:
 * those stay until the project closes.
 */
export function insertEvent(window: EventWindow, event: ProjectEvent, max: number): EventWindow {
  if (event.seq <= window.from) return window;
  const i = indexOfSeq(window.events, event.seq);
  if (window.events[i]?.seq === event.seq) return window;
  const events =
    i === window.events.length
      ? [...window.events, event]
      : [...window.events.slice(0, i), event, ...window.events.slice(i)];
  return capped({ ...window, events }, max);
}

function union(a: readonly ProjectEvent[], b: readonly ProjectEvent[]): ProjectEvent[] {
  const bySeq = new Map<number, ProjectEvent>();
  for (const e of a) bySeq.set(e.seq, e);
  for (const e of b) if (!bySeq.has(e.seq)) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
}

/**
 * Merges a freshly read tail of the record (every event above `tail.from`). When it overlaps
 * or touches what is held, the two join and older pages already loaded stay; when there is a
 * gap between them, the held events can no longer be shown as continuous and the tail
 * replaces them. The first tail sets the bound: live events that arrived before it only add
 * what it did not yet hold.
 */
export function mergeTail(window: EventWindow, tail: EventWindow, max: number): EventWindow {
  const kept = tail.events.filter((e) => e.seq > tail.from);
  if (window.unread) {
    const live = window.events.filter((e) => e.seq > tail.from);
    return capped({ events: union(live, kept), from: tail.from }, max);
  }
  const newest = window.events[window.events.length - 1]?.seq ?? window.from;
  if (tail.from > newest) return capped({ events: kept, from: tail.from }, max);
  return capped(
    { ...window, events: union(window.events, kept), from: Math.min(window.from, tail.from) },
    max,
  );
}

/** Adds an older page: every event with `page.from < seq <= window.from`. */
export function prependOlder(window: EventWindow, page: EventWindow): EventWindow {
  if (window.unread || page.from >= window.from) return window;
  const older = page.events.filter((e) => e.seq > page.from && e.seq <= window.from);
  return { events: union(older, window.events), from: page.from, paged: true };
}
