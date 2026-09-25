import React from 'react';
import { formatQty, isUnknown } from '@omenflow/contracts';

export function summarize(payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  if (p.statement) return String(p.statement).slice(0, 180);
  if (p.partNumber) return `${p.partNumber} (${p.manufacturer ?? p.vendor ?? ''})`;
  if (typeof p.markdown === 'string') return p.markdown.slice(0, 180);
  if (typeof p.text === 'string') return p.text.slice(0, 180);
  if (p.url) return String(p.url).slice(0, 180);
  return JSON.stringify(payload).slice(0, 180);
}

const isQty = (v: unknown): v is { value: number; unit: string } =>
  !!v && typeof v === 'object' && 'value' in v && 'unit' in v;

function fmt(v: unknown): string {
  if (isQty(v)) return formatQty(v as never);
  if (v && typeof v === 'object' && isUnknown(v as never)) return 'unknown';
  if (v === undefined) return 'Not set';
  if (v === null) return 'None';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function label(path: string) {
  return path
    .replace(/\[(.+?)\]/g, ' › $1')
    .replace(/\./g, ' › ')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
}

/** Field-level difference; quantities change atomically — 0.3 kg → 0.5 kg. */
export function PayloadDiff({ from, to }: { from: unknown; to: unknown }) {
  const diffs: { path: string; from: unknown; to: unknown }[] = [];
  const walk = (a: unknown, b: unknown, path: string) => {
    if (a === b) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const item = b[i] ?? a[i];
        const key =
          item && typeof item === 'object' && 'name' in item ? String(item.name) : String(i + 1);
        walk(a[i], b[i], `${path}[${key}]`);
      }
      return;
    }
    if (isQty(a) && isQty(b)) {
      if (a.value !== b.value || a.unit !== b.unit) diffs.push({ path, from: a, to: b });
      return;
    }
    if (
      a &&
      b &&
      typeof a === 'object' &&
      typeof b === 'object' &&
      !Array.isArray(a) &&
      !Array.isArray(b)
    ) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
        walk(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
          path ? `${path}.${k}` : k,
        );
      return;
    }
    diffs.push({ path: path || '(value)', from: a, to: b });
  };
  walk(from, to, '');
  if (!diffs.length) return <p className="dim">No field changes in the payload.</p>;
  return (
    <div className="diff">
      {diffs.map((d, i) => (
        <div className="diff-row" key={i}>
          <span className="diff-field" title={d.path}>
            {label(d.path)}
          </span>
          <span className="diff-from">{fmt(d.from)}</span>
          <span className="diff-arrow" aria-label="becomes">
            →
          </span>
          <span className="diff-to">{fmt(d.to)}</span>
        </div>
      ))}
    </div>
  );
}
