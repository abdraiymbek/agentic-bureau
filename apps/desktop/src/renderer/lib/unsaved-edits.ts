/**
 * Unsaved edits across the object level, in one place, so navigation can ask before it
 * discards them.
 *
 * An editor registers while it holds edits. Every entry whose editor is on screen is also
 * unsaved work in the frame's registry (`lib/dirty.ts`), so every navigation the frame makes
 * (go, focus, decide, zoom out, back, forward, closing or switching the project) asks first,
 * with the frame's one prompt. Anything else about to take the person away within the object
 * calls `requestLeave(proceed)`, which asks the same way. Choosing to discard there drops the
 * edits here too.
 *
 * An editor that is unmounted without being asked (navigation the frame did not make) leaves
 * its edits parked here, and picks them up again when the object is reopened.
 */
import { clearUnsaved, guardLeave, listUnsaved, markUnsaved, subscribeUnsaved } from './dirty';

export interface UnsavedEntry {
  /** `${projectId}:${artifactId}:${slot}` */
  key: string;
  /** What the edits belong to, for the prompt: "requirement Payload capacity". */
  label: string;
  /** False once the editor unmounted with the edits still unsaved. */
  mounted: boolean;
  /** The editor's own state, returned to it when it mounts again. */
  snapshot: unknown;
}

const entries = new Map<string, UnsavedEntry>();
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

/** The entry's id in the frame's registry. */
const workId = (key: string) => `object-edit:${key}`;

// The frame's prompt discards by clearing its registry: edits whose editor was on screen when
// the person chose "Discard" go with it. Parked edits were not part of the question.
subscribeUnsaved(() => {
  const listed = new Set(listUnsaved().map((work) => work.id));
  let dropped = false;
  for (const [key, entry] of entries)
    if (entry.mounted && !listed.has(workId(key))) {
      entries.delete(key);
      dropped = true;
    }
  if (dropped) changed();
});

export const unsavedEdits = {
  put(entry: UnsavedEntry) {
    entries.set(entry.key, entry);
    if (entry.mounted) markUnsaved(workId(entry.key), entry.label);
    else clearUnsaved(workId(entry.key));
    changed();
  },
  drop(key: string) {
    if (!entries.delete(key)) return;
    clearUnsaved(workId(key));
    changed();
  },
  /** The editor went away with edits still unsaved; keep them for its return. */
  park(key: string) {
    const entry = entries.get(key);
    if (!entry?.mounted) return;
    entries.set(key, { ...entry, mounted: false });
    clearUnsaved(workId(key));
    changed();
  },
  peek(key: string): UnsavedEntry | undefined {
    return entries.get(key);
  },
  list(): UnsavedEntry[] {
    return [...entries.values()];
  },
  /** Edits in an editor that is on screen now: what leaving would interrupt. */
  open(): UnsavedEntry[] {
    return [...entries.values()].filter((e) => e.mounted);
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Forget everything, parked edits included, for a project that is closing. */
  clear() {
    if (!entries.size) return;
    const keys = [...entries.keys()];
    entries.clear();
    for (const key of keys) clearUnsaved(workId(key));
    changed();
  },
};

/**
 * Run `proceed` now when no editor on screen holds unsaved edits; otherwise ask first, with the
 * frame's prompt, and run it only if the person chooses to discard. `action` completes
 * "Discard and …", for example "show r3".
 */
export function requestLeave(proceed: () => void, action?: string): void {
  guardLeave(proceed, { action });
}

// Closing or reloading the window would drop every unsaved edit, parked ones included.
if (typeof window !== 'undefined')
  window.addEventListener('beforeunload', (event) => {
    if (!entries.size) return;
    event.preventDefault();
    event.returnValue = '';
  });
