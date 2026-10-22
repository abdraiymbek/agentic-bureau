/**
 * cad_check assertions in words, for a requirement feature or a spec item: each assertion group
 * as one line with its unit. Recorded values are shown exactly as recorded (no rounding), and a
 * key this reader does not know is shown as it is rather than dropped. Pure.
 */
import { formatNumber } from '../ui/format';

/** Exact enough to show what was recorded, without float noise. */
const exact = (value: unknown) =>
  typeof value === 'number' ? formatNumber(value, 12) : JSON.stringify(value);

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const point = (value: unknown) => `(${list(value).map(exact).join(', ')})`;
const by = (value: unknown) => list(value).map(exact).join(' × ');
const fields = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function section(value: unknown): string {
  const s = fields(value);
  const parts: string[] = [];
  const outer = fields(s.outer);
  if (outer.d !== undefined) parts.push(`outer Ø${exact(outer.d)} mm`);
  else if (outer.size !== undefined) parts.push(`outer ${by(outer.size)} mm`);
  for (const hole of list(s.holes)) {
    const h = fields(hole);
    parts.push(`hole Ø${exact(h.d)} mm at ${point(h.center)}`);
  }
  for (const slot of list(s.slots)) {
    const c = fields(slot);
    parts.push(`cut-out ${by(c.size)} mm at ${point(c.center)}`);
  }
  for (const polygon of list(s.polygons)) {
    const p = fields(polygon);
    parts.push(
      `${exact(p.sides)}-gon ${exact(p.acrossFlats)} mm across flats at ${point(p.center)}`,
    );
  }
  if (typeof s.holeCount === 'number') parts.push(count(s.holeCount, 'cut-out', 'cut-outs'));
  if (typeof s.outerCount === 'number')
    parts.push(count(s.outerCount, 'material region', 'material regions'));
  const area = fields(s.materialArea);
  if (area.value !== undefined) parts.push(`material area ${exact(area.value)} mm²`);
  const known = new Set([
    'axis',
    'at',
    'outer',
    'holes',
    'slots',
    'polygons',
    'holeCount',
    'outerCount',
    'materialArea',
  ]);
  for (const [key, other] of Object.entries(s))
    if (!known.has(key)) parts.push(`${key} ${JSON.stringify(other)}`);
  const plane = `section ${String(s.axis ?? '?')} = ${exact(s.at)} mm`;
  return parts.length ? `${plane}: ${parts.join(', ')}` : `${plane}: nothing asserted`;
}

/** One line per assertion group, in the order they were recorded. */
export function describeAssertions(expect: Record<string, unknown> | undefined): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(expect ?? {})) {
    switch (key) {
      case 'size':
        out.push(`size ${by(value)} mm`);
        break;
      case 'bbox': {
        const box = fields(value);
        out.push(`envelope ${point(box.min)} to ${point(box.max)} mm`);
        break;
      }
      case 'volume':
        out.push(`volume ${exact(fields(value).value)} mm³`);
        break;
      case 'bodies':
      case 'shells':
        out.push(
          typeof value === 'number' ? count(value, 'body', 'bodies') : `${key} ${exact(value)}`,
        );
        break;
      case 'holes':
        for (const hole of list(value)) {
          const h = fields(hole);
          const along = h.axis && h.axis !== 'z' ? ` along ${String(h.axis)}` : '';
          out.push(`hole Ø${exact(h.d)} mm at ${point(h.at)} mm${along}`);
        }
        break;
      case 'solid':
        out.push(`material at ${list(value).map(point).join(', ')} mm`);
        break;
      case 'empty':
        out.push(`empty space at ${list(value).map(point).join(', ')} mm`);
        break;
      case 'sections':
        for (const s of list(value)) out.push(section(s));
        break;
      default:
        out.push(`${key} ${JSON.stringify(value)}`);
    }
  }
  return out;
}
