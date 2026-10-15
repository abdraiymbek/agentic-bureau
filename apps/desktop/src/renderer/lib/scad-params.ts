/**
 * The parameters an OpenSCAD part actually declares, read from its source: file-scope
 * `name = value;` statements. Arguments of calls, assignments inside modules and text inside
 * comments or strings are not parameters and are never reported.
 */
import type { MechanicalPayload } from '@omenflow/contracts';
import { convert, unitDef } from '../ui/units';

export type ScadValue = number | boolean | string;

export interface ScadParameter {
  name: string;
  /** `expression` is computed from other values: it can be read but not overridden. */
  kind: 'number' | 'boolean' | 'string' | 'expression';
  /** The literal value; null for an expression. */
  value: ScadValue | null;
  /** The right-hand side exactly as written. */
  expr: string;
  /** The `//` comment that follows the statement on its line. */
  comment?: string;
  /** 1-based line of the statement. */
  line: number;
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const ASSIGNMENT = /^([A-Za-z_$][A-Za-z0-9_]*)\s*=(?!=)\s*([\s\S]+)$/;

function literal(expr: string): Pick<ScadParameter, 'kind' | 'value'> {
  if (expr === 'true' || expr === 'false') return { kind: 'boolean', value: expr === 'true' };
  if (NUMBER.test(expr)) return { kind: 'number', value: Number(expr) };
  const text = /^"((?:[^"\\]|\\.)*)"$/.exec(expr);
  if (text) return { kind: 'string', value: text[1]!.replace(/\\(.)/g, '$1') };
  return { kind: 'expression', value: null };
}

/** Scans once, tracking comments, strings and every bracket kind. */
export function scanScadParameters(source: string): ScadParameter[] {
  const found = new Map<string, ScadParameter>();
  let statement = '';
  let statementLine = 1;
  let line = 1;
  let braces = 0;
  let nested = 0;
  let i = 0;
  const finish = (endIndex: number) => {
    const match = ASSIGNMENT.exec(statement.trim());
    if (match && braces === 0 && nested === 0) {
      const name = match[1]!;
      const expr = match[2]!.trim();
      const lineEnd = source.indexOf('\n', endIndex);
      const rest = source.slice(endIndex, lineEnd < 0 ? source.length : lineEnd);
      const comment = /^\s*\/\/\s*(.*\S)\s*$/.exec(rest)?.[1];
      // OpenSCAD uses the last file-scope assignment of a name; it keeps the first position.
      found.set(name, {
        name,
        ...literal(expr),
        expr,
        ...(comment ? { comment } : {}),
        line: statementLine,
      });
    }
    statement = '';
  };
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      line += source.slice(i, stop).split('\n').length - 1;
      i = stop;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === '\\' ? 2 : 1;
      const text = source.slice(i, Math.min(j + 1, source.length));
      if (!statement.trim()) statementLine = line;
      statement += text;
      line += text.split('\n').length - 1;
      i = j + 1;
      continue;
    }
    if (ch === '\n') line++;
    if (ch === ';' && nested === 0) {
      finish(i + 1);
    } else if (ch === '{' && nested === 0) {
      braces++;
      statement = '';
    } else if (ch === '}' && nested === 0) {
      braces = Math.max(0, braces - 1);
      statement = '';
    } else {
      if (ch === '(' || ch === '[') nested++;
      if (ch === ')' || ch === ']') nested = Math.max(0, nested - 1);
      if (!statement.trim() && ch.trim()) statementLine = line;
      statement += ch;
    }
    i++;
  }
  return [...found.values()];
}

const UNIT_WORD = 'mm|cm|m|in|deg|°|rad|%';
// Only unambiguous placements count: the whole comment or its lead-in ("mm", "mm, outer"),
// a bracketed unit ("wall (mm)"), or the phrase "in mm". Anything looser could mislabel a value.
const COMMENT_UNIT = new RegExp(
  `(?:^\\s*(${UNIT_WORD})\\s*(?:$|[,;:–—-])|[\\[(]\\s*(${UNIT_WORD})\\s*[\\])]|\\bin\\s+(${UNIT_WORD})(?![A-Za-z0-9_]))`,
  'i',
);

/** A unit the source author wrote beside the value: `// mm`, `// wall (mm)`, `// in deg`. */
export function unitFromComment(comment: string | undefined): string | null {
  const match = comment ? COMMENT_UNIT.exec(comment) : null;
  const unit = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!unit) return null;
  return unit === '°' ? 'deg' : unit.toLowerCase();
}

export interface ParameterRow {
  name: string;
  /** How the source declares it; null when only a recorded override names it. */
  declared: ScadParameter | null;
  /** The value this revision renders with: the override when there is one, else the default. */
  value: ScadValue | null;
  /** This revision records a value for it that replaces the source default. */
  overridden: boolean;
  /** Empty when no unit is known. A bare number is never assumed to be a length. */
  unit: string;
  unitSource: 'recorded' | 'manifest' | 'source-comment' | null;
  description?: string;
  /** Literals declared in the source can be overridden; expressions and strays cannot. */
  editable: boolean;
}

type Manifest = MechanicalPayload['paramManifest'];

/**
 * OpenSCAD renders lengths in millimetres and angles in degrees; a plain number sent to
 * `cad.write_source` is read that way. The core converts a recorded quantity by the same rule
 * (`quantity_in_model_units`, crates/core/src/cad/params.rs); other dimensions have no model unit.
 */
const MODEL_UNIT: Record<string, string> = { length: 'mm', angle: 'deg', dimensionless: '1' };

/** `value` in `unit` as the plain number the part renders with, or null when it has none. */
export function inModelUnits(value: number, unit: string): number | null {
  const def = unitDef(unit);
  const target = def ? MODEL_UNIT[def.dim] : undefined;
  const plain = target ? convert({ value, unit }, target)?.value : undefined;
  // Twelve significant digits drop the binary noise of the scale factors (0.1 in → 2.54 mm).
  return plain === undefined || !Number.isFinite(plain) ? null : Number(plain.toPrecision(12));
}

const isQuantity = (value: unknown): value is { value: unknown; unit: unknown } =>
  !!value && typeof value === 'object' && 'unit' in value;

/** What a recorded value renders as, in model units, for comparing with the source default. */
function rendered(value: unknown): ScadValue | null {
  const plain = scalar(value);
  return isQuantity(value) && typeof plain === 'number'
    ? inModelUnits(plain, String(value.unit))
    : plain;
}

function scalar(value: unknown): ScadValue | null {
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string')
    return value;
  if (value && typeof value === 'object' && 'value' in value) {
    const inner = (value as { value: unknown }).value;
    return typeof inner === 'number' ? inner : null;
  }
  return null;
}

/**
 * One row per parameter the source declares, in source order, then any recorded override the
 * source no longer declares. `source` is null when it could not be read: only the recorded
 * overrides are known then.
 */
export function parameterRows(
  source: string | null,
  recorded: Record<string, unknown>,
  manifest: Manifest,
): ParameterRow[] {
  const declared = source === null ? [] : scanScadParameters(source);
  const unitOf = (name: string, comment?: string): Pick<ParameterRow, 'unit' | 'unitSource'> => {
    const value = recorded[name];
    if (isQuantity(value)) return { unit: String(value.unit), unitSource: 'recorded' };
    const entry = manifest.find((m) => m.name === name);
    if (entry?.unit) return { unit: entry.unit, unitSource: 'manifest' };
    if (entry?.dimension === 'count') return { unit: 'count', unitSource: 'manifest' };
    const written = unitFromComment(comment);
    return written
      ? { unit: written, unitSource: 'source-comment' }
      : { unit: '', unitSource: null };
  };
  const rows: ParameterRow[] = declared.map((p) => {
    const overridden = p.name in recorded && p.kind !== 'expression';
    const description = manifest.find((m) => m.name === p.name)?.description ?? p.comment;
    return {
      name: p.name,
      declared: p,
      value: overridden ? scalar(recorded[p.name]) : p.value,
      // A recorded quantity overrides the default unless it renders as exactly that value.
      overridden: overridden && !Object.is(rendered(recorded[p.name]), p.value),
      ...unitOf(p.name, p.comment),
      ...(description ? { description } : {}),
      editable: p.kind !== 'expression',
    };
  });
  const names = new Set(declared.map((p) => p.name));
  for (const [name, value] of Object.entries(recorded)) {
    if (names.has(name)) continue;
    const description = manifest.find((m) => m.name === name)?.description;
    rows.push({
      name,
      declared: null,
      value: scalar(value),
      overridden: true,
      ...unitOf(name),
      ...(description ? { description } : {}),
      editable: false,
    });
  }
  return rows;
}

/** The text an input shows for a parameter value. */
export function parameterText(value: ScadValue | null): string {
  return value === null ? '' : String(value);
}

export type ParameterForm = Record<string, string>;

export function parameterForm(rows: ParameterRow[]): ParameterForm {
  return Object.fromEntries(
    rows.filter((r) => r.editable).map((r) => [r.name, parameterText(r.value)]),
  );
}

export type ParameterEdit =
  { ok: true; params: Record<string, ScadValue> } | { ok: false; name: string; message: string };

/**
 * The overrides to render with: every override already recorded on a declared literal, plus
 * each edited field, as the plain values `cad.write_source` takes. Text that is not a value of the
 * declared kind is refused, never coerced. A number shown in a recorded unit ("wall (in)") is
 * converted to model units; one whose unit has none is refused rather than sent as millimetres.
 */
export function parameterOverrides(rows: ParameterRow[], form: ParameterForm): ParameterEdit {
  const params: Record<string, ScadValue> = {};
  for (const row of rows) {
    if (!row.editable || !row.declared) continue;
    const text = form[row.name] ?? parameterText(row.value);
    const edited = text !== parameterText(row.value);
    if (!edited && !row.overridden) continue;
    let value: ScadValue;
    if (!edited) {
      if (row.value === null) continue;
      value = row.value;
    } else if (row.declared.kind === 'number') {
      if (!NUMBER.test(text.trim()))
        return { ok: false, name: row.name, message: `${row.name} needs a number, got “${text}”.` };
      value = Number(text.trim());
    } else if (row.declared.kind === 'boolean') {
      if (text !== 'true' && text !== 'false')
        return { ok: false, name: row.name, message: `${row.name} is true or false.` };
      value = text === 'true';
    } else {
      value = text;
    }
    if (row.unitSource === 'recorded' && typeof value === 'number') {
      const plain = inModelUnits(value, row.unit);
      if (plain === null)
        return {
          ok: false,
          name: row.name,
          message: `${row.name} is recorded in “${row.unit}”, which a part cannot render: parameters are lengths (mm), angles (degrees) or plain numbers.`,
        };
      value = plain;
    }
    params[row.name] = value;
  }
  return { ok: true, params };
}
