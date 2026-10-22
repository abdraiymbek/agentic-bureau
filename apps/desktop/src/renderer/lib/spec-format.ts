/**
 * cad_check assertions in words, for a requirement feature or a spec item: each assertion group
 * as one line with its unit. Every recorded field is shown: values, centres and positions exactly
 * as recorded (no rounding), each with its unit, and every tolerance that was recorded, since a
 * looser one checks less. A key this reader has no words for, at any depth, is shown as it is
 * rather than dropped. Pure.
 */
import { UNIT_JOIN, formatNumber, formatQuantity } from '../ui/format';

/** Significant digits that show what was recorded, without float noise. */
const EXACT = 12;

const exact = (value: unknown) =>
  typeof value === 'number'
    ? formatNumber(value, EXACT)
    : value === undefined
      ? '?'
      : JSON.stringify(value);
/** A value joined to its unit, as the quantity formatter joins them. */
const unit = (text: string, name: string) => `${text}${UNIT_JOIN}${name}`;
/** A recorded number in a unit, through the one quantity formatter. */
const quantity = (value: unknown, name: string) =>
  typeof value === 'number'
    ? formatQuantity({ value, unit: name }, EXACT)
    : unit(exact(value), name);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const raw = (key: string, value: unknown) => `${key} ${JSON.stringify(value)}`;
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const point = (value: unknown) =>
  Array.isArray(value) ? `(${value.map(exact).join(', ')})` : exact(value);
const by = (value: unknown) => (Array.isArray(value) ? value.map(exact).join(' × ') : exact(value));
/** A position, with its unit (in-plane centres too). */
const at = (value: unknown) => unit(point(value), 'mm');
const points = (value: unknown[]) => unit(value.map(point).join(', '), 'mm');
/** A recorded linear tolerance, or nothing when none was recorded (the check's default applies). */
const within = (tol: unknown) => (tol === undefined ? '' : ` ± ${quantity(tol, 'mm')}`);
/** A recorded percentage tolerance, or nothing when none was recorded. */
const withinPct = (tolPct: unknown) => (tolPct === undefined ? '' : ` ± ${quantity(tolPct, '%')}`);

/** The fields of `value` that `shown` does not cover, as recorded. */
function rest(value: Record<string, unknown>, shown: readonly string[]): string {
  const others = Object.entries(value)
    .filter(([key]) => !shown.includes(key))
    .map(([key, other]) => raw(key, other));
  return others.length ? `, ${others.join(', ')}` : '';
}

/** A cut-out or outline in a section plane: its shape, then where it sits, then its tolerance. */
function shape(what: string, value: Record<string, unknown>, shown: readonly string[]): string {
  const where = value.center !== undefined ? ` at ${at(value.center)}` : '';
  return `${what}${where}${within(value.tol)}${rest(value, [...shown, 'center', 'tol'])}`;
}

function outer(value: unknown): string {
  if (!isRecord(value)) return raw('outer', value);
  // The check reads a rectangle when `size` is recorded and a circle from `d` otherwise; a `d`
  // recorded beside a size is shown as it is.
  const form =
    value.size !== undefined
      ? ` ${unit(by(value.size), 'mm')}`
      : value.d !== undefined
        ? ` Ø${quantity(value.d, 'mm')}`
        : '';
  return shape(`outer${form}`, value, value.size !== undefined ? ['size'] : ['d']);
}

const SECTION_KEYS = [
  'axis',
  'at',
  'outer',
  'holes',
  'slots',
  'polygons',
  'holeCount',
  'outerCount',
  'materialArea',
] as const;

function section(value: unknown): string {
  if (!isRecord(value)) return raw('section', value);
  const s = value;
  const parts: string[] = [];
  if (s.outer !== undefined) parts.push(outer(s.outer));
  for (const hole of list(s.holes)) {
    if (!isRecord(hole)) parts.push(raw('hole', hole));
    else parts.push(shape(`hole Ø${quantity(hole.d, 'mm')}`, hole, ['d']));
  }
  for (const slot of list(s.slots)) {
    if (!isRecord(slot)) parts.push(raw('cut-out', slot));
    else parts.push(shape(`cut-out ${unit(by(slot.size), 'mm')}`, slot, ['size']));
  }
  for (const polygon of list(s.polygons)) {
    if (!isRecord(polygon)) {
      parts.push(raw('polygon', polygon));
      continue;
    }
    const p = polygon;
    parts.push(
      shape(`${exact(p.sides)}-gon ${quantity(p.acrossFlats, 'mm')} across flats`, p, [
        'sides',
        'acrossFlats',
      ]),
    );
  }
  for (const kind of ['holes', 'slots', 'polygons'] as const)
    if (s[kind] !== undefined && !Array.isArray(s[kind])) parts.push(raw(kind, s[kind]));
  if (typeof s.holeCount === 'number') parts.push(count(s.holeCount, 'cut-out', 'cut-outs'));
  else if (s.holeCount !== undefined) parts.push(raw('holeCount', s.holeCount));
  if (typeof s.outerCount === 'number')
    parts.push(count(s.outerCount, 'material region', 'material regions'));
  else if (s.outerCount !== undefined) parts.push(raw('outerCount', s.outerCount));
  if (s.materialArea !== undefined) {
    const area = s.materialArea;
    parts.push(
      isRecord(area)
        ? `material area ${quantity(area.value, 'mm²')}${withinPct(area.tolPct)}${rest(area, ['value', 'tolPct'])}`
        : raw('materialArea', area),
    );
  }
  for (const [key, other] of Object.entries(s))
    if (!(SECTION_KEYS as readonly string[]).includes(key)) parts.push(raw(key, other));
  const plane = `section ${String(s.axis ?? '?')} = ${quantity(s.at, 'mm')}`;
  return parts.length ? `${plane}: ${parts.join(', ')}` : `${plane}: nothing asserted`;
}

/** One line per assertion group, in the order they were recorded. */
export function describeAssertions(expect: Record<string, unknown> | undefined): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(expect ?? {})) {
    switch (key) {
      case 'size':
        out.push(Array.isArray(value) ? `size ${unit(by(value), 'mm')}` : raw(key, value));
        break;
      case 'bbox':
        out.push(
          isRecord(value)
            ? `envelope ${point(value.min)} to ${at(value.max)}${within(value.tol)}${rest(value, ['min', 'max', 'tol'])}`
            : raw(key, value),
        );
        break;
      case 'volume':
        out.push(
          isRecord(value)
            ? `volume ${quantity(value.value, 'mm³')}${withinPct(value.tolPct)}${rest(value, ['value', 'tolPct'])}`
            : raw(key, value),
        );
        break;
      case 'tol':
        out.push(`tolerance ± ${quantity(value, 'mm')} where an assertion gives none`);
        break;
      case 'bodies':
      case 'shells':
        out.push(typeof value === 'number' ? count(value, 'body', 'bodies') : raw(key, value));
        break;
      case 'holes':
        if (!Array.isArray(value)) {
          out.push(raw(key, value));
          break;
        }
        for (const hole of value) {
          if (!isRecord(hole)) {
            out.push(raw('hole', hole));
            continue;
          }
          const h = hole;
          const along = h.axis !== undefined ? ` along ${String(h.axis)}` : '';
          out.push(
            `hole Ø${quantity(h.d, 'mm')} at ${at(h.at)}${along}${rest(h, ['d', 'at', 'axis'])}`,
          );
        }
        break;
      case 'solid':
        out.push(Array.isArray(value) ? `material at ${points(value)}` : raw(key, value));
        break;
      case 'empty':
        out.push(Array.isArray(value) ? `empty space at ${points(value)}` : raw(key, value));
        break;
      case 'sections':
        if (!Array.isArray(value)) out.push(raw(key, value));
        else for (const s of value) out.push(section(s));
        break;
      default:
        out.push(raw(key, value));
    }
  }
  return out;
}
