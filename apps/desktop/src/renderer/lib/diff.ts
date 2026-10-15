/**
 * Typed differences between two recorded payloads, for review.
 *
 * Every entry says what changed in words a reviewer can check: a quantity changes as one value
 * (value, unit and bounds together), unknown stays unknown with its reason, list items are
 * matched by identity (id or name) or by content — never by position alone — and long text is a
 * line diff with the changed words marked. Pure: no React, no store, no I/O.
 */
import type { FileRef, MaybeQuantity } from '@omenflow/contracts';
import { formatQty, isUnknown } from '@omenflow/contracts/format';

/* ------------------------------------------------------------------ */
/* Values                                                               */
/* ------------------------------------------------------------------ */

type Obj = Record<string, unknown>;

export interface KnownQuantity {
  value: number;
  unit: string;
  min?: number;
  max?: number;
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const only = (v: Obj, keys: string[]) => Object.keys(v).every((k) => keys.includes(k));

export function isQuantity(v: unknown): v is KnownQuantity {
  return (
    isObj(v) &&
    typeof v.value === 'number' &&
    typeof v.unit === 'string' &&
    only(v, ['value', 'unit', 'min', 'max'])
  );
}

export function isUnknownValue(v: unknown): v is { unknown: true; reason?: string } {
  return isObj(v) && v.unknown === true && only(v, ['unknown', 'reason']);
}

export function isMoney(v: unknown): v is { amount: string; currency: string } {
  return (
    isObj(v) &&
    typeof v.amount === 'string' &&
    typeof v.currency === 'string' &&
    only(v, ['amount', 'currency'])
  );
}

const ATOMIC = (v: unknown) => isQuantity(v) || isUnknownValue(v) || isMoney(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const REF_KEY = /(^id$|Id$|Ids$|Refs?$)/;
/** Text longer than this, or with a line break, is shown stacked with a line diff. */
export const LONG_TEXT = 72;

/** A value as the reviewer sees it. */
export interface Shown {
  text: string;
  /** Not set, or explicitly none. */
  empty?: boolean;
  /** An unknown quantity; `text` carries the reason. */
  unknown?: boolean;
  /** Long or multi-line text: shown stacked, never squeezed into a column. */
  long?: boolean;
  /** The value is an artifact id; the renderer names the object. */
  ref?: string;
  /** The value is a list of artifact ids; the renderer names each object. */
  refs?: string[];
  /** The value is an ISO timestamp; the renderer shows local time and keeps the record. */
  time?: string;
  /** A quantity or an amount: value and unit never wrap apart. */
  quantity?: boolean;
}

const digits = (n: number, precise: boolean) =>
  precise ? String(n) : String(Number(n.toPrecision(4)));

/** `0.5 [0.4–0.6] kg`, `0.5 kg (min 0.4)`. Bounds are part of the quantity. */
export function quantityText(q: KnownQuantity, precise = false): string {
  const v = digits(q.value, precise);
  if (q.min !== undefined && q.max !== undefined)
    return `${v} [${digits(q.min, precise)}–${digits(q.max, precise)}] ${q.unit}`;
  if (q.min !== undefined) return `${v} ${q.unit} (min ${digits(q.min, precise)})`;
  if (q.max !== undefined) return `${v} ${q.unit} (max ${digits(q.max, precise)})`;
  return `${v} ${q.unit}`;
}

/**
 * A recorded quantity in its own unit, unknown included: the contracts' wording, with a bound
 * recorded on one side only kept ("0.3 kg (max 0.35)") rather than dropped.
 */
export function recordedQuantityText(q: MaybeQuantity): string {
  return isUnknown(q) ? formatQty(q) : quantityText(q as KnownQuantity);
}

export function unknownText(v: { reason?: string }): string {
  return v.reason ? `Unknown — ${v.reason}` : 'Unknown';
}

/** How one recorded value reads. `key` is the field it sits in, so ids can be named. */
export function describe(v: unknown, key = '', precise = false): Shown {
  if (v === undefined) return { text: 'Not set', empty: true };
  if (v === null) return { text: 'None', empty: true };
  if (typeof v === 'boolean') return { text: v ? 'Yes' : 'No' };
  if (typeof v === 'number') return { text: String(v) };
  if (typeof v === 'string') {
    if (!v.length) return { text: 'Empty', empty: true };
    if (UUID.test(v) && REF_KEY.test(key)) return { text: v, ref: v };
    if (ISO_TIME.test(v) && !Number.isNaN(Date.parse(v))) return { text: v, time: v };
    return { text: v, long: v.length > LONG_TEXT || v.includes('\n') };
  }
  if (isQuantity(v)) return { text: quantityText(v, precise), quantity: true };
  if (isUnknownValue(v)) return { text: unknownText(v), unknown: true };
  if (isMoney(v)) return { text: `${v.amount} ${v.currency}`, quantity: true };
  if (Array.isArray(v)) {
    if (!v.length) return { text: 'None', empty: true };
    if (REF_KEY.test(key) && v.every((x) => typeof x === 'string' && UUID.test(x)))
      return { text: v.join(', '), refs: v as string[] };
    if (v.every((x) => ['string', 'number', 'boolean'].includes(typeof x))) {
      const text = v.map((x) => describe(x).text).join(', ');
      return { text, long: text.length > LONG_TEXT };
    }
    return { text: `${v.length} ${v.length === 1 ? 'item' : 'items'}` };
  }
  const text = flatten(v)
    .map((f) => `${f.label}: ${f.value.text}`)
    .join('; ');
  return { text, long: text.length > LONG_TEXT };
}

/* ------------------------------------------------------------------ */
/* Labels                                                               */
/* ------------------------------------------------------------------ */

const SCHEMA_KEY = /^[a-z]+([A-Z][a-z]*)*$/;

/** Schema field names (`acceptanceCriterion`) read as words; recorded keys (`V_IN_max`) stay verbatim. */
export function fieldLabel(key: string): string {
  return SCHEMA_KEY.test(key) ? key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() : key;
}

/** A label starts with a capital, unless it starts with a recorded key, which is never altered. */
const capitalise = (key: string, label: string) =>
  SCHEMA_KEY.test(key) && label ? label[0]!.toUpperCase() + label.slice(1) : label;

const LABEL_FIELDS = [
  'name',
  'title',
  'label',
  'pin',
  'partNumber',
  'seller',
  'instruction',
  'observation',
  'statement',
  'signalRole',
];

/** A recognisable name for a list item: its name, title, pin, … else its position. */
export function itemLabel(item: unknown, index: number): string {
  if (isObj(item)) {
    for (const f of LABEL_FIELDS) {
      const v = item[f];
      if (typeof v === 'string' && v.trim()) {
        const t = v.trim();
        return t.length > 48 ? `${t.slice(0, 47)}…` : t;
      }
    }
    if (typeof item.id === 'string') return item.id.slice(0, 8);
  } else if (typeof item === 'string' || typeof item === 'number') {
    const t = String(item);
    return t.length > 48 ? `${t.slice(0, 47)}…` : t;
  }
  return `item ${index + 1}`;
}

/** Leaf fields of an object, quantities kept whole, for showing an item that was added or removed. */
export function flatten(v: unknown, prefix = ''): { label: string; value: Shown }[] {
  if (!isObj(v) || ATOMIC(v)) return [{ label: prefix || 'value', value: describe(v) }];
  const out: { label: string; value: Shown }[] = [];
  for (const [k, x] of Object.entries(v)) {
    const label = prefix ? `${prefix} › ${fieldLabel(k)}` : fieldLabel(k);
    if (isObj(x) && !ATOMIC(x)) out.push(...flatten(x, label));
    else if (Array.isArray(x) && x.some(isObj))
      x.forEach((item, i) => out.push(...flatten(item, `${label} › ${itemLabel(item, i)}`)));
    else out.push({ label, value: describe(x, k) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Sequence diff (Myers)                                                */
/* ------------------------------------------------------------------ */

export type SeqOp =
  { op: '='; a: number; b: number } | { op: '-'; a: number } | { op: '+'; b: number };

/**
 * Shortest edit script between two sequences (Myers, O((N+M)·D)). Returns null when more than
 * `maxEdits` edits would be needed, so callers can say the inputs are too different to align.
 */
export function diffSequence<T>(
  a: readonly T[],
  b: readonly T[],
  eq: (x: T, y: T) => boolean = (x, y) => x === y,
  maxEdits = Infinity,
): SeqOp[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Int32Array(2 * max + 3);
  const off = max + 1;
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    if (d > maxEdits) return null;
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)
          ? v[off + k + 1]!
          : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && eq(a[x]!, b[y]!)) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return backtrack(trace, n, m);
}

function backtrack(trace: Int32Array[], n: number, m: number): SeqOp[] {
  const ops: SeqOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const row = trace[d]!;
    const at = (k: number) => row[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ op: '=', a: x, b: y });
    }
    if (d > 0) {
      if (x === prevX) ops.push({ op: '+', b: prevY });
      else ops.push({ op: '-', a: prevX });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/* ------------------------------------------------------------------ */
/* Text                                                                 */
/* ------------------------------------------------------------------ */

export interface WordSeg {
  text: string;
  changed: boolean;
}
export type LineOp =
  | { op: 'same'; text: string; a: number; b: number }
  | { op: 'removed'; text: string; a: number; words?: WordSeg[] }
  | { op: 'added'; text: string; b: number; words?: WordSeg[] };

const tokens = (s: string) => s.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];

/** Words of one changed line pair, marked where they differ. */
export function diffWords(a: string, b: string): { from: WordSeg[]; to: WordSeg[] } {
  const ta = tokens(a);
  const tb = tokens(b);
  const ops = diffSequence(ta, tb, undefined, 400);
  if (!ops) return { from: [{ text: a, changed: true }], to: [{ text: b, changed: true }] };
  const from: WordSeg[] = [];
  const to: WordSeg[] = [];
  const push = (list: WordSeg[], text: string, changed: boolean) => {
    const last = list[list.length - 1];
    if (last && last.changed === changed) last.text += text;
    else list.push({ text, changed });
  };
  for (const o of ops) {
    if (o.op === '=') {
      push(from, ta[o.a]!, false);
      push(to, tb[o.b]!, false);
    } else if (o.op === '-') push(from, ta[o.a]!, true);
    else push(to, tb[o.b]!, true);
  }
  return { from, to };
}

function similar(a: string, b: string): boolean {
  const wa = new Set(a.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
  const wb = new Set(b.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
  if (!wa.size || !wb.size) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.max(wa.size, wb.size) >= 0.4;
}

/** Lines that differ beyond this many edits are reported as too different to align. */
const MAX_LINE_EDITS = 4000;

/**
 * A line diff. Removed and added lines that face each other and share most of their words carry
 * word marks, so a one-word edit in a long statement is visible at a glance. Null when the texts
 * are too different (or too long) to align line by line.
 */
export function diffLines(a: string, b: string): LineOp[] | null {
  const la = a.split('\n');
  const lb = b.split('\n');
  const ops = diffSequence(la, lb, undefined, MAX_LINE_EDITS);
  if (!ops) return null;
  const out: LineOp[] = [];
  let i = 0;
  while (i < ops.length) {
    const o = ops[i]!;
    if (o.op === '=') {
      out.push({ op: 'same', text: la[o.a]!, a: o.a, b: o.b });
      i++;
      continue;
    }
    const removed: number[] = [];
    const added: number[] = [];
    while (i < ops.length && ops[i]!.op !== '=') {
      const c = ops[i]!;
      if (c.op === '-') removed.push(c.a);
      else if (c.op === '+') added.push(c.b);
      i++;
    }
    const pairs = Math.min(removed.length, added.length);
    const marks = new Map<number, { from: WordSeg[]; to: WordSeg[] }>();
    for (let p = 0; p < pairs; p++) {
      const x = la[removed[p]!]!;
      const y = lb[added[p]!]!;
      if (similar(x, y)) marks.set(p, diffWords(x, y));
    }
    removed.forEach((ai, p) =>
      out.push({ op: 'removed', text: la[ai]!, a: ai, words: marks.get(p)?.from }),
    );
    added.forEach((bi, p) =>
      out.push({ op: 'added', text: lb[bi]!, b: bi, words: marks.get(p)?.to }),
    );
  }
  return out;
}

export type HunkLine = LineOp | { op: 'skip'; count: number; hidden: LineOp[] };

/** Unchanged runs longer than twice the context fold into one "n unchanged lines" marker. */
export function foldUnchanged(ops: LineOp[], context = 3): HunkLine[] {
  const out: HunkLine[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.op !== 'same') {
      out.push(ops[i]!);
      i++;
      continue;
    }
    let j = i;
    while (j < ops.length && ops[j]!.op === 'same') j++;
    const run = ops.slice(i, j);
    const lead = i === 0 ? 0 : context;
    const trail = j === ops.length ? 0 : context;
    if (run.length > lead + trail + 1) {
      out.push(...run.slice(0, lead));
      const hidden = run.slice(lead, run.length - trail);
      out.push({ op: 'skip', count: hidden.length, hidden });
      out.push(...run.slice(run.length - trail));
    } else out.push(...run);
    i = j;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Payload diff                                                         */
/* ------------------------------------------------------------------ */

export type Change = 'changed' | 'added' | 'removed' | 'moved';

export interface DiffEntry {
  /** Stable machine path, e.g. `inputs[payload_mass].quantity`. */
  path: string;
  /** Human path, e.g. `Inputs › payload_mass › quantity`. */
  label: string;
  change: Change;
  /** `item`: a whole list item; `text`: prose; `value`: anything else, quantities included. */
  kind: 'value' | 'text' | 'item';
  from?: Shown;
  to?: Shown;
  /** What kind of change it is, in words: "unit changed from g to kg", "became unknown". */
  notes: string[];
  /** Long text: the line diff (null when too different to align). */
  lines?: LineOp[] | null;
  /** A whole item that was added or removed: its fields. */
  fields?: { label: string; value: Shown }[];
}

interface Seg {
  path: string;
  label: string;
}

const join = (base: Seg, key: string): Seg => ({
  path: base.path ? `${base.path}.${key}` : key,
  label: base.label ? `${base.label} › ${fieldLabel(key)}` : capitalise(key, fieldLabel(key)),
});
const joinItem = (base: Seg, name: string): Seg => ({
  path: `${base.path}[${name}]`,
  label: base.label ? `${base.label} › ${name}` : name,
});

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (isObj(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v) ?? 'undefined';
}
const same = (a: unknown, b: unknown) => a === b || stable(a) === stable(b);

/** Quantity-like: a known quantity or an unknown with its reason. */
const maybeQty = (v: unknown) => isQuantity(v) || isUnknownValue(v);

function quantityNotes(a: unknown, b: unknown): string[] {
  if (isQuantity(a) && isUnknownValue(b))
    return [b.reason ? `became unknown: ${b.reason}` : 'became unknown'];
  if (isUnknownValue(a) && isQuantity(b)) return ['now known'];
  if (isUnknownValue(a) && isUnknownValue(b)) return ['reason for the unknown changed'];
  if (!isQuantity(a) || !isQuantity(b)) return [];
  const notes: string[] = [];
  if (a.unit !== b.unit) notes.push(`unit changed from ${a.unit} to ${b.unit}`);
  if (a.min !== b.min || a.max !== b.max) notes.push('bounds changed');
  return notes;
}

function valueEntry(seg: Seg, key: string, a: unknown, b: unknown): DiffEntry {
  const change: Change = a === undefined ? 'added' : b === undefined ? 'removed' : 'changed';
  let from = a === undefined ? undefined : describe(a, key);
  let to = b === undefined ? undefined : describe(b, key);
  // Rounding must never make a real change look like no change.
  if (from && to && from.text === to.text && !same(a, b)) {
    from = describe(a, key, true);
    to = describe(b, key, true);
  }
  const notes = maybeQty(a) || maybeQty(b) ? quantityNotes(a, b) : [];
  if (from?.long || to?.long) {
    // Text that appears or disappears whole is shown whole; only an edit has lines to compare.
    const lines = typeof a === 'string' && typeof b === 'string' ? diffLines(a, b) : undefined;
    return { ...seg, change, kind: 'text', from, to, notes, lines };
  }
  return { ...seg, change, kind: 'value', from, to, notes };
}

/** Where a list item sits: objects are named by their own fields, plain values by position. */
function itemSeg(seg: Seg, item: unknown, index: number): Seg {
  if (isObj(item) && !ATOMIC(item)) return joinItem(seg, itemLabel(item, index));
  return { path: `${seg.path}[${index}]`, label: seg.label || 'Items' };
}

function itemEntry(
  seg: Seg,
  change: 'added' | 'removed',
  item: unknown,
  key: string,
  positional: Set<string> = new Set(),
): DiffEntry {
  if (isObj(item) && !ATOMIC(item))
    return { ...seg, change, kind: 'item', notes: [], fields: flatten(omit(item, positional)) };
  const shown = describe(item, key);
  return {
    ...seg,
    change,
    kind: 'item',
    notes: [],
    ...(change === 'added' ? { to: shown } : { from: shown }),
  };
}

function movedEntry(seg: Seg, item: unknown, key: string, from: number, to: number): DiffEntry {
  return {
    ...seg,
    change: 'moved',
    kind: 'item',
    notes: [`moved from position ${from + 1} to ${to + 1}`],
    ...(isObj(item) && !ATOMIC(item) ? {} : { to: describe(item, key) }),
  };
}

/** Field names that number list items (`order` of assembly steps, `step` of a test procedure). */
const POSITION_FIELDS = ['order', 'step', 'index', 'position'];

/**
 * Numbering fields whose values only restate each item's position (`order: 1, 2, 3`) on both
 * sides. Inserts and moves explain them, so they neither block matching nor show as changes.
 */
function positionalKeys(a: unknown[], b: unknown[]): Set<string> {
  const all = [...a, ...b];
  const found = new Set<string>();
  if (!all.length || !all.every(isObj)) return found;
  for (const k of POSITION_FIELDS)
    for (const start of [0, 1])
      if ([a, b].every((list) => list.every((x, i) => (x as Obj)[k] === i + start))) found.add(k);
  return found;
}

function omit(v: unknown, keys: Set<string>): unknown {
  if (!keys.size || !isObj(v)) return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => !keys.has(k)));
}

/** Identity of a list item: its id, its name, or for a pin its component and label. */
function identity(item: unknown): string | null {
  if (!isObj(item)) return null;
  if (typeof item.id === 'string' || typeof item.id === 'number') return `id:${item.id}`;
  if (typeof item.name === 'string' && item.name) return `name:${item.name}`;
  if (typeof item.pin === 'string')
    return `pin:${typeof item.componentArtifactId === 'string' ? item.componentArtifactId : ''}:${item.pin}`;
  return null;
}

/** Keys for every item, or null when some item has none or two share one. */
function identities(list: unknown[]): string[] | null {
  const keys = list.map(identity);
  if (keys.some((k) => k === null) || new Set(keys).size !== keys.length) return null;
  return keys as string[];
}

/** How alike two unmatched items are: shared fields count fully, similar prose by half. */
function similarity(a: unknown, b: unknown): number {
  if (typeof a === 'string' && typeof b === 'string') return similar(a, b) ? 1 : 0;
  if (!isObj(a) || !isObj(b)) return 0;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (!keys.size) return 0;
  let score = 0;
  for (const k of keys) {
    if (same(a[k], b[k])) score += 1;
    else if (typeof a[k] === 'string' && typeof b[k] === 'string' && similar(a[k], b[k]))
      score += 0.5;
  }
  return score / keys.size;
}

function diffArray(seg: Seg, key: string, a: unknown[], b: unknown[], out: DiffEntry[]) {
  const ka = identities(a);
  const kb = identities(b);
  if (ka && kb) keyedArray(seg, key, a, b, ka, kb, out);
  else contentArray(seg, key, a, b, out);
}

/** Items with ids or names: matched by them, wherever they sit. */
function keyedArray(
  seg: Seg,
  key: string,
  a: unknown[],
  b: unknown[],
  ka: string[],
  kb: string[],
  out: DiffEntry[],
) {
  const inA = new Map(ka.map((k, i) => [k, i]));
  const inB = new Set(kb);
  for (const o of diffSequence(ka, kb) ?? []) {
    if (o.op === '-') {
      if (!inB.has(ka[o.a]!))
        out.push(itemEntry(itemSeg(seg, a[o.a], o.a), 'removed', a[o.a], key));
      continue;
    }
    const ai = inA.get(kb[o.b]!);
    const at = itemSeg(seg, b[o.b], o.b);
    if (ai === undefined) {
      out.push(itemEntry(at, 'added', b[o.b], key));
      continue;
    }
    // Off the common subsequence means the item changed place.
    if (o.op === '+') out.push(movedEntry(at, b[o.b], key, ai, o.b));
    walk(at, key, a[ai], b[o.b], out);
  }
}

/** Items without identity: matched by content, then edited pairs, then moves. */
function contentArray(seg: Seg, key: string, a: unknown[], b: unknown[], out: DiffEntry[]) {
  const positional = positionalKeys(a, b);
  const ca = a.map((x) => stable(omit(x, positional)));
  const cb = b.map((x) => stable(omit(x, positional)));
  const ops = diffSequence(ca, cb) ?? [];
  const used = new Set<number>();
  // Identical content in a new place is a move, not a removal plus an addition.
  const movedFrom = new Map<number, number>();
  for (const o of ops) {
    if (o.op !== '+') continue;
    const ai = ops.find((r) => r.op === '-' && !used.has(r.a) && ca[r.a] === cb[o.b]);
    if (ai && ai.op === '-') {
      used.add(ai.a);
      movedFrom.set(o.b, ai.a);
    }
  }
  // Within one run of edits, a removed item facing a similar added item is the same item, edited.
  const editedFrom = new Map<number, number>();
  for (let i = 0; i < ops.length;) {
    const removed: number[] = [];
    const added: number[] = [];
    for (; i < ops.length && ops[i]!.op !== '='; i++) {
      const o = ops[i]!;
      if (o.op === '-' && !used.has(o.a)) removed.push(o.a);
      if (o.op === '+' && !movedFrom.has(o.b)) added.push(o.b);
    }
    for (let p = 0; p < Math.min(removed.length, added.length); p++) {
      const [ai, bi] = [removed[p]!, added[p]!];
      if (similarity(omit(a[ai], positional), omit(b[bi], positional)) >= 0.5) {
        used.add(ai);
        editedFrom.set(bi, ai);
      }
    }
    if (i < ops.length) i++;
  }
  for (const o of ops) {
    if (o.op === '=') continue;
    if (o.op === '-') {
      if (!used.has(o.a))
        out.push(itemEntry(itemSeg(seg, a[o.a], o.a), 'removed', a[o.a], key, positional));
      continue;
    }
    const at = itemSeg(seg, b[o.b], o.b);
    const moved = movedFrom.get(o.b);
    const edited = editedFrom.get(o.b);
    if (moved !== undefined) out.push(movedEntry(at, b[o.b], key, moved, o.b));
    else if (edited !== undefined)
      walk(at, key, omit(a[edited], positional), omit(b[o.b], positional), out);
    else out.push(itemEntry(at, 'added', b[o.b], key, positional));
  }
}

function walk(
  seg: Seg,
  key: string,
  a: unknown,
  b: unknown,
  out: DiffEntry[],
  ignore?: Set<string>,
) {
  if (same(a, b)) return;
  if (maybeQty(a) || maybeQty(b) || isMoney(a) || isMoney(b)) {
    out.push(valueEntry(seg, key, a, b));
    return;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    const list = (v: unknown) => (Array.isArray(v) ? v : v == null ? [] : null);
    const [la, lb] = [list(a), list(b)];
    if (la && lb) diffArray(seg, key, la, lb, out);
    else out.push(valueEntry(seg, key, a, b));
    return;
  }
  if ((isObj(a) || a === undefined) && (isObj(b) || b === undefined) && (isObj(a) || isObj(b))) {
    const x = (a ?? {}) as Obj;
    const y = (b ?? {}) as Obj;
    for (const k of [...Object.keys(y), ...Object.keys(x).filter((k) => !(k in y))]) {
      if (ignore?.has(k)) continue;
      walk(join(seg, k), k, x[k], y[k], out);
    }
    return;
  }
  out.push(valueEntry(seg, key, a, b));
}

/**
 * Every difference between two payloads, in the order of the new payload's fields.
 * `ignore` names top-level fields the caller shows another way (e.g. mechanical render records).
 */
export function diffPayload(from: unknown, to: unknown, ignore: string[] = []): DiffEntry[] {
  const out: DiffEntry[] = [];
  walk({ path: '', label: '' }, '', from, to, out, new Set(ignore));
  return out;
}

/* ------------------------------------------------------------------ */
/* Files                                                                */
/* ------------------------------------------------------------------ */

export interface FileChange {
  path: string;
  change: 'added' | 'removed' | 'changed' | 'renamed';
  from?: FileRef;
  to?: FileRef;
  /** For a rename: the old path. */
  previousPath?: string;
}

/** Files of two revisions, matched by path; same bytes under a new path is a rename. */
export function diffFiles(
  base: readonly FileRef[],
  next: readonly FileRef[],
): { changes: FileChange[]; unchanged: number } {
  const byPath = new Map(base.map((f) => [f.path, f]));
  const nextPaths = new Set(next.map((f) => f.path));
  const changes: FileChange[] = [];
  let unchanged = 0;
  const gone = base.filter((f) => !nextPaths.has(f.path));
  const renamedFrom = new Set<string>();
  for (const f of next) {
    const old = byPath.get(f.path);
    if (old) {
      if (old.sha256 === f.sha256 && old.role === f.role && f.sha256) unchanged++;
      else changes.push({ path: f.path, change: 'changed', from: old, to: f });
      continue;
    }
    const twin = gone.find((g) => g.sha256 && g.sha256 === f.sha256 && !renamedFrom.has(g.path));
    if (twin) {
      renamedFrom.add(twin.path);
      changes.push({ path: f.path, change: 'renamed', from: twin, to: f, previousPath: twin.path });
    } else changes.push({ path: f.path, change: 'added', to: f });
  }
  for (const f of gone)
    if (!renamedFrom.has(f.path)) changes.push({ path: f.path, change: 'removed', from: f });
  return { changes, unchanged };
}

/** Text when the bytes are valid UTF-8 without NUL bytes, else null (binary). */
export function textContent(bytes: Uint8Array): string | null {
  const head = bytes.subarray(0, 8000);
  if (head.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** File size with its unit: `812 B`, `12.4 kB`, `3.2 MB` (SI). */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1e6) return `${(n / 1000).toFixed(1)} kB`;
  return `${(n / 1e6).toFixed(1)} MB`;
}
