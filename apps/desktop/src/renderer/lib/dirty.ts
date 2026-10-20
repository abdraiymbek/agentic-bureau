/**
 * Unsaved work, in one registry the whole frame consults. A surface with edits that are not
 * saved registers them with a label in words; every navigation that would unmount it (go,
 * focus, zoom out, back, forward, decide, closing or switching the project) asks before
 * discarding, and a surface can hold incoming data for the objects it is editing so a
 * background refresh never resets what the person is typing.
 *
 *   useUnsavedWork(`requirement:${id}`, dirty, 'Payload capacity: target value', {
 *     holdArtifactIds: [id],
 *   });
 *
 * Other registries join with `addLeaveGuard`, so their prompts run in the same chain.
 */
import { useEffect } from 'react';

export interface UnsavedWork {
  id: string;
  /** What would be lost, in words: "Payload capacity: target value". */
  label: string;
  /** Objects whose incoming updates are held back while this work is unsaved. */
  holdArtifactIds: readonly string[];
}

export interface LeaveRequest {
  /** What the person is about to do, as the end of "Discard and …": "open Camera tray". */
  action: string;
  labels: string[];
  proceed: () => void;
  cancel: () => void;
}

/** A second registry of unsaved work that navigation must also consult. */
export interface LeaveGuard {
  isDirty(): boolean;
  /** Ask the person; call `proceed` to leave, `cancel` (when given) to stay. */
  ask(proceed: () => void, cancel: () => void): void;
}

const entries = new Map<string, UnsavedWork>();
const listeners = new Set<() => void>();
const guards = new Set<LeaveGuard>();
let prompt: ((request: LeaveRequest) => void) | null = null;

const notify = () => {
  for (const listener of [...listeners]) listener();
};

/** Records (or relabels) unsaved work under a stable id. */
export function markUnsaved(
  id: string,
  label: string,
  options: { holdArtifactIds?: readonly string[] } = {},
): void {
  const holdArtifactIds = options.holdArtifactIds ?? [];
  const current = entries.get(id);
  if (
    current &&
    current.label === label &&
    current.holdArtifactIds.length === holdArtifactIds.length &&
    current.holdArtifactIds.every((x, i) => x === holdArtifactIds[i])
  )
    return;
  entries.set(id, { id, label, holdArtifactIds: [...holdArtifactIds] });
  notify();
}

/** The work was saved or discarded. */
export function clearUnsaved(id: string): void {
  if (entries.delete(id)) notify();
}

/** Forget everything: the person chose to discard, or the project closed. */
export function clearAllUnsaved(): void {
  if (!entries.size) return;
  entries.clear();
  notify();
}

export function listUnsaved(): UnsavedWork[] {
  return [...entries.values()];
}

/** Ids of objects whose incoming updates are being held for an editor. */
export function heldArtifactIds(): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries.values()) for (const id of entry.holdArtifactIds) ids.add(id);
  return ids;
}

export function subscribeUnsaved(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Joins another registry's prompt to the navigation guard. */
export function addLeaveGuard(guard: LeaveGuard): () => void {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}

/** Installs the frame's prompt. Without one, the platform's confirm dialog asks. */
export function setLeavePrompt(handler: ((request: LeaveRequest) => void) | null): void {
  prompt = handler;
}

/** True when leaving now would discard something, in this registry or a joined one. */
export function hasUnsavedWork(): boolean {
  return entries.size > 0 || [...guards].some((g) => g.isDirty());
}

/** Asks each joined registry that has unsaved work, once each, in order. */
function askGuards(remaining: LeaveGuard[], proceed: () => void, cancel: () => void): void {
  const i = remaining.findIndex((g) => g.isDirty());
  if (i < 0) proceed();
  else remaining[i]!.ask(() => askGuards(remaining.slice(i + 1), proceed, cancel), cancel);
}

export interface LeaveOptions {
  action?: string;
  cancel?: () => void;
  /** Work held outside the active editor, also lost when the whole app closes. */
  extraLabels?: readonly string[];
  /**
   * The move can still fail or be called off after the person agrees (opening or closing a
   * project), so choosing to discard leaves the work registered; the move clears it once it
   * happens. Without it, discarding clears the registry at once.
   */
  keep?: boolean;
}

/**
 * Runs `proceed` straight away when nothing would be lost; otherwise asks first. Choosing to
 * discard clears this registry, so the next navigation does not ask again before the edited
 * surface has unmounted.
 */
export function guardLeave(proceed: () => void, options: LeaveOptions = {}): void {
  const cancel = options.cancel ?? (() => {});
  const others = () => askGuards([...guards], proceed, cancel);
  const labels = [
    ...new Set([...entries.values()].map((e) => e.label).concat(options.extraLabels ?? [])),
  ];
  if (!labels.length) return others();
  const resume = () => {
    if (!options.keep) clearAllUnsaved();
    others();
  };
  if (prompt) prompt({ action: options.action ?? 'continue', labels, proceed: resume, cancel });
  else if (globalThis.confirm?.(`Discard unsaved changes?\n\n${labels.join('\n')}`)) resume();
  else cancel();
}

/** `guardLeave` as a promise: true when the caller may go ahead. */
export function confirmLeave(
  action?: string,
  options: Pick<LeaveOptions, 'keep' | 'extraLabels'> = {},
): Promise<boolean> {
  return new Promise((resolve) =>
    guardLeave(() => resolve(true), { ...options, action, cancel: () => resolve(false) }),
  );
}

/** Registers unsaved work while `dirty` is true and clears it on unmount. */
export function useUnsavedWork(
  id: string,
  dirty: boolean,
  label: string,
  options: { holdArtifactIds?: readonly string[] } = {},
): void {
  const hold = (options.holdArtifactIds ?? []).join('\u0000');
  useEffect(() => {
    if (!dirty) return;
    markUnsaved(id, label, { holdArtifactIds: hold ? hold.split('\u0000') : [] });
    return () => clearUnsaved(id);
  }, [id, dirty, label, hold]);
}
