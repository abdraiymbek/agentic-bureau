import type { Viewport } from './fit';

/** What the map remembers about one project between visits. */
export interface FlowMemory {
  /** Where the user left the map, or null while it follows its own fit. */
  viewport: Viewport | null;
  /** Type groups the user collapsed (true) or expanded (false) themselves. */
  groups: Record<string, boolean>;
  /** The node that last held keyboard focus. Kept for the session only. */
  focusId: string | null;
}

const storageKey = (projectId: string) => `bureau.flow.${projectId}`;
const session = new Map<string, FlowMemory>();

/** Reads what was stored, keeping only values of the right shape. */
export function parseMemory(raw: string | null): Pick<FlowMemory, 'viewport' | 'groups'> {
  const empty = { viewport: null, groups: {} };
  if (!raw) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object') return empty;
  const { viewport, groups } = parsed as { viewport?: unknown; groups?: unknown };
  const v = viewport as Partial<Viewport> | null | undefined;
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  return {
    viewport:
      v && finite(v.x) && finite(v.y) && finite(v.k) && v.k > 0 ? { x: v.x, y: v.y, k: v.k } : null,
    groups:
      groups && typeof groups === 'object'
        ? Object.fromEntries(
            Object.entries(groups).filter(
              (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
            ),
          )
        : {},
  };
}

export function recall(projectId: string): FlowMemory {
  let memory = session.get(projectId);
  if (!memory) {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(storageKey(projectId));
    } catch {
      /* the map still works without storage; it just starts from its fit */
    }
    memory = { ...parseMemory(raw), focusId: null };
    session.set(projectId, memory);
  }
  return memory;
}

export function remember(projectId: string, patch: Partial<FlowMemory>): FlowMemory {
  const memory = { ...recall(projectId), ...patch };
  session.set(projectId, memory);
  if ('viewport' in patch || 'groups' in patch) {
    try {
      localStorage.setItem(
        storageKey(projectId),
        JSON.stringify({ viewport: memory.viewport, groups: memory.groups }),
      );
    } catch {
      /* remembered for this session only */
    }
  }
  return memory;
}
