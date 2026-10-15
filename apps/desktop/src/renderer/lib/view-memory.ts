/**
 * Navigation continuity: what a view looked like when the person left it, so returning shows
 * it the same way. The frame records the scroll position of every scrolling region inside the
 * stage, keyed by view, and restores it on return. Views keep other transient state (selection,
 * filters, an open section) with `useViewState`, which survives the view unmounting and is
 * forgotten when the project closes.
 */
import { useCallback, useState } from 'react';

/** One key per place the person can return to. Lenses of the project are separate places. */
export function viewKey(
  view:
    | { level: 'agent' | 'system' }
    | { level: 'project'; lens: string }
    | { level: 'object'; id: string }
    | { level: 'decide'; proposalId: string | null },
): string {
  switch (view.level) {
    case 'project':
      return `project:${view.lens}`;
    case 'object':
      return `object:${view.id}`;
    case 'decide':
      return `decide:${view.proposalId ?? ''}`;
    default:
      return view.level;
  }
}

/* ---------------- view state ---------------- */

const state = new Map<string, unknown>();

/** Forget every remembered view state (a different project opened). */
export function clearViewMemory(): void {
  state.clear();
  scrolls.clear();
}

/** Keeps `value` under `key` for the next component that asks with `useViewState`. */
export function rememberViewState(key: string, value: unknown): void {
  state.set(key, value);
}

/**
 * `useState` that outlives the component: the value is kept under `key` and handed back when
 * a component asks for the same key again, until the project closes. Use a key that names the
 * view and the thing remembered, e.g. `parts:picked`.
 */
export function useViewState<T>(
  key: string,
  initial: T | (() => T),
): [T, (next: T | ((current: T) => T)) => void] {
  const [value, setValue] = useState<T>(() =>
    state.has(key)
      ? (state.get(key) as T)
      : typeof initial === 'function'
        ? (initial as () => T)()
        : initial,
  );
  const update = useCallback(
    (next: T | ((current: T) => T)) =>
      setValue((current) => {
        const resolved = typeof next === 'function' ? (next as (current: T) => T)(current) : next;
        rememberViewState(key, resolved);
        return resolved;
      }),
    [key],
  );
  return [value, update];
}

/* ---------------- scroll positions ---------------- */

interface Position {
  top: number;
  left: number;
}

const MAX_VIEWS = 40;
const scrolls = new Map<string, Map<string, Position>>();

/**
 * A path from the stage root to a scrolling element that is stable across remounts: the
 * element's `data-scroll-key` when it has one, otherwise tag and first class of each ancestor.
 */
export function scrollPath(el: Element, root: Element): string | null {
  const keyed = el.closest('[data-scroll-key]');
  if (keyed && root.contains(keyed) && keyed === el)
    return `#${keyed.getAttribute('data-scroll-key')}`;
  const parts: string[] = [];
  for (let node: Element | null = el; node && node !== root; node = node.parentElement) {
    if (!node.parentElement) return null;
    parts.push(`${node.tagName.toLowerCase()}.${node.classList[0] ?? ''}`);
  }
  return parts.reverse().join('>');
}

/** Records where `el` is scrolled while `key` is the current view. */
export function recordScroll(key: string, el: Element, root: Element): void {
  const path = scrollPath(el, root);
  if (!path) return;
  let positions = scrolls.get(key);
  if (!positions) {
    positions = new Map();
    scrolls.set(key, positions);
    // Oldest views are forgotten first.
    while (scrolls.size > MAX_VIEWS) scrolls.delete(scrolls.keys().next().value!);
  }
  if (el.scrollTop === 0 && el.scrollLeft === 0) positions.delete(path);
  else positions.set(path, { top: el.scrollTop, left: el.scrollLeft });
}

export function hasSavedScroll(key: string): boolean {
  return !!scrolls.get(key)?.size;
}

/**
 * Puts every remembered region of `key` back where it was, as far as its content allows yet,
 * and returns how many are not there. Content that arrives late (a chunk, data, images above
 * the fold) moves the position again, so the frame calls this on every frame for a short
 * while after a return, until the person scrolls themselves.
 */
export function restoreScroll(key: string, root: Element): number {
  const positions = scrolls.get(key);
  if (!positions?.size) return 0;
  const targets = new Map<string, Element>();
  for (const el of root.querySelectorAll('*')) {
    if (el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth) continue;
    const path = scrollPath(el, root);
    if (path && positions.has(path) && !targets.has(path)) targets.set(path, el);
  }
  let away = 0;
  for (const [path, pos] of positions) {
    const el = targets.get(path);
    if (!el) {
      away++;
      continue;
    }
    if (Math.abs(el.scrollTop - pos.top) > 1) el.scrollTop = pos.top;
    if (Math.abs(el.scrollLeft - pos.left) > 1) el.scrollLeft = pos.left;
    if (Math.abs(el.scrollTop - pos.top) > 1 || Math.abs(el.scrollLeft - pos.left) > 1) away++;
  }
  return away;
}
