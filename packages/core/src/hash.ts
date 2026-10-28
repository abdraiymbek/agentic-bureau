import { createHash } from 'node:crypto';
import type { ArtifactType } from '@bureau/contracts';

/**
 * Engineering-content hash. Excludes title and purely presentational
 * metadata so renaming an artifact does not invalidate downstream results.
 */
const PRESENTATIONAL_KEYS = new Set(['title', 'description', 'notes', 'label']);

function stripPresentational(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPresentational);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (PRESENTATIONAL_KEYS.has(k)) continue;
      out[k] = stripPresentational(v);
    }
    return out;
  }
  return value;
}

export function contentHash(_type: ArtifactType, payload: unknown, fileHashes: string[]): string {
  const h = createHash('sha256');
  h.update(JSON.stringify(stripPresentational(payload)));
  for (const fh of [...fileHashes].sort()) h.update(fh);
  return h.digest('hex');
}

/** Deep field-level diff for review comparisons. */
export interface DiffEntry {
  path: string;
  from: unknown;
  to: unknown;
}
export function diffPayloads(a: unknown, b: unknown, base = ''): DiffEntry[] {
  const out: DiffEntry[] = [];
  const walk = (x: unknown, y: unknown, p: string) => {
    if (x === y) return;
    const xo = x !== null && typeof x === 'object';
    const yo = y !== null && typeof y === 'object';
    if (xo && yo) {
      const keys = new Set([...Object.keys(x as object), ...Object.keys(y as object)]);
      for (const k of keys) {
        walk(
          (x as Record<string, unknown>)[k],
          (y as Record<string, unknown>)[k],
          p ? `${p}.${k}` : k,
        );
      }
      return;
    }
    out.push({ path: p || '(root)', from: x, to: y });
  };
  walk(a, b, base);
  return out;
}

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'artifact'
  );
}
