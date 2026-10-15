/**
 * Preferences kept in local storage. Every reader is tolerant: a missing key, storage that
 * throws, malformed JSON, or a value from an older or newer build yields the default for the
 * part that cannot be read and keeps the parts that can. Preferences are conveniences; nothing
 * in the engineering record depends on them.
 */
import type { Lens } from '../project/lenses';

export type Theme = 'dark' | 'light';

export const PREF_KEYS = {
  theme: 'omen.theme',
  agent: 'omen.agent',
  rails: 'omen.rails',
  project: (projectId: string) => `omen.project.${projectId}`,
  recent: (projectId: string) => `omen.recent.${projectId}`,
} as const;

/** A view worth returning to when the project opens again. */
export type SavedView =
  | { level: 'agent' }
  | { level: 'project'; lens: Lens }
  | { level: 'object'; id: string }
  | { level: 'decide'; proposalId: string | null };

export interface ProjectPrefs {
  view: SavedView | null;
  /** The lens Escape returns to from an object. */
  lens: Lens | null;
  agentWindowOpen: boolean;
}

export interface RailPrefs {
  /** "Depends on" (left) and "Affects" (right) rails folded to their edge. */
  inputs: boolean;
  consequences: boolean;
}

export const DEFAULT_PROJECT_PREFS: ProjectPrefs = {
  view: null,
  lens: null,
  agentWindowOpen: false,
};
export const DEFAULT_RAILS: RailPrefs = { inputs: false, consequences: false };

export function readRaw(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeRaw(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* preferences remain usable without storage */
  }
}

function parseJson(raw: string | null): unknown {
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseTheme(raw: string | null): Theme {
  return raw === 'light' ? 'light' : 'dark';
}

export function parseView(value: unknown, isLens: (id: string) => boolean): SavedView | null {
  if (!isRecord(value)) return null;
  switch (value.level) {
    case 'agent':
      return { level: 'agent' };
    case 'project':
      return typeof value.lens === 'string' && isLens(value.lens)
        ? { level: 'project', lens: value.lens as Lens }
        : null;
    case 'object':
      return typeof value.id === 'string' && value.id ? { level: 'object', id: value.id } : null;
    case 'decide':
      return {
        level: 'decide',
        proposalId: typeof value.proposalId === 'string' ? value.proposalId : null,
      };
    default:
      return null;
  }
}

export function parseProjectPrefs(
  raw: string | null,
  isLens: (id: string) => boolean,
): ProjectPrefs {
  const value = parseJson(raw);
  if (!isRecord(value)) return DEFAULT_PROJECT_PREFS;
  return {
    view: parseView(value.view, isLens),
    lens: typeof value.lens === 'string' && isLens(value.lens) ? (value.lens as Lens) : null,
    agentWindowOpen: value.agentWindowOpen === true,
  };
}

export function serializeProjectPrefs(prefs: ProjectPrefs): string {
  return JSON.stringify(prefs);
}

export function parseRails(raw: string | null): RailPrefs {
  const value = parseJson(raw);
  if (!isRecord(value)) return DEFAULT_RAILS;
  return { inputs: value.inputs === true, consequences: value.consequences === true };
}

/** Ids of recently focused objects, newest first. */
export function parseRecents(raw: string | null, limit: number): string[] {
  const value = parseJson(raw);
  return Array.isArray(value)
    ? value.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, limit)
    : [];
}
