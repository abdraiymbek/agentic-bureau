import { bottom, right, type Point, type Rect } from './geometry';

/** What routing needs to know about a node: where it is and which column holds it. */
export interface RouteNode extends Rect {
  id: string;
  col: number;
}

/** A column and everything a link must not be drawn over, top to bottom. */
export interface RouteColumn {
  x: number;
  w: number;
  blocks: Rect[];
}

export interface RouteLink {
  key: string;
  from: string;
  to: string;
  causal: boolean;
  /** The recorded links this drawn link stands for. */
  links: string[];
}

export interface LayoutEdge extends RouteLink {
  /** Forward follows the causal reading order; `same` stays in one column; `back` runs against it. */
  kind: 'forward' | 'same' | 'back';
  /** The line from the input to the consequence, as SVG path data. */
  line: string;
  /** The arrowhead at the consequence end, as SVG path data. */
  arrow: string;
  /** The line as a polyline, for geometry checks. */
  points: Point[];
  /** Length of the line in map units. */
  length: number;
}

/** How far the tip of an arrowhead stops short of the node it points at. */
const TIP_GAP = 1.5;
const ARROW_LENGTH = 6;
const ARROW_HALF_WIDTH = 4;
/** Space a link keeps from the nodes above and below the gap it crosses. */
const CLEARANCE = 2.5;
const EDGE_SLOT_OFFSET = 12;
const BRACKET_DEPTH = 14;
const BRACKET_STEP = 9;
const BRACKET_LANES = 3;
const CURVE_SAMPLES = 12;

/**
 * A horizontal gap in a column that links may cross. Links that leave the same object share a
 * lane; other links take their own until the gap is full, then bundle.
 */
interface Slot {
  y: number;
  step: number;
  /** Lanes on each side of the centre line (or beyond it, for the gaps above and below a column). */
  side: number;
  direction: -1 | 0 | 1;
  lanes: Map<string, number>;
}

function slotsOf(column: RouteColumn): Slot[] {
  const slots: Slot[] = [];
  const edge = (y: number, direction: -1 | 1): Slot => ({
    y,
    step: 4,
    side: 2,
    direction,
    lanes: new Map(),
  });
  const first = column.blocks[0];
  const last = column.blocks[column.blocks.length - 1];
  if (!first || !last) return [edge(0, -1)];
  slots.push(edge(first.y - EDGE_SLOT_OFFSET, -1));
  for (let i = 0; i + 1 < column.blocks.length; i++) {
    const gap = column.blocks[i + 1]!.y - bottom(column.blocks[i]!);
    if (gap < 2 * CLEARANCE + 1) continue;
    const step = gap >= 16 ? 4 : 3.5;
    slots.push({
      y: bottom(column.blocks[i]!) + gap / 2,
      step,
      side: Math.floor((gap / 2 - CLEARANCE) / step),
      direction: 0,
      lanes: new Map(),
    });
  }
  slots.push(edge(bottom(last) + EDGE_SLOT_OFFSET, 1));
  return slots;
}

function nearestSlot(slots: Slot[], y: number): Slot {
  let best = slots[0]!;
  for (const slot of slots) if (Math.abs(slot.y - y) < Math.abs(best.y - y)) best = slot;
  return best;
}

function laneY(slot: Slot, trunk: string): number {
  let lane = slot.lanes.get(trunk);
  if (lane === undefined) {
    lane = slot.lanes.size;
    slot.lanes.set(trunk, lane);
  }
  if (slot.direction !== 0) return slot.y + slot.direction * slot.step * Math.min(lane, slot.side);
  const index = lane % (1 + 2 * slot.side);
  return slot.y + (index % 2 ? -1 : 1) * Math.ceil(index / 2) * slot.step;
}

const fmt = (n: number) => String(Math.round(n * 10) / 10);

class Path {
  private d: string[] = [];
  readonly points: Point[] = [];
  private at: Point;
  private head = '';

  constructor(start: Point) {
    this.at = start;
    this.d.push(`M${fmt(start.x)},${fmt(start.y)}`);
    this.points.push(start);
  }

  line(to: Point) {
    if (to.x === this.at.x && to.y === this.at.y) return;
    this.d.push(`L${fmt(to.x)},${fmt(to.y)}`);
    this.points.push(to);
    this.at = to;
  }

  /** A cubic with the given control points, sampled so its geometry can be checked. */
  curve(c1: Point, c2: Point, to: Point) {
    const from = this.at;
    this.d.push(`C${fmt(c1.x)},${fmt(c1.y)} ${fmt(c2.x)},${fmt(c2.y)} ${fmt(to.x)},${fmt(to.y)}`);
    for (let i = 1; i <= CURVE_SAMPLES; i++) {
      const t = i / CURVE_SAMPLES;
      const u = 1 - t;
      const a = u * u * u;
      const b = 3 * u * u * t;
      const c = 3 * u * t * t;
      const e = t * t * t;
      this.points.push({
        x: a * from.x + b * c1.x + c * c2.x + e * to.x,
        y: a * from.y + b * c1.y + c * c2.y + e * to.y,
      });
    }
    this.at = to;
  }

  /**
   * Leaves and arrives level, changing height inside the gutter between two columns. The bend
   * sits at `lane`, so links that climb the same gutter side by side stay apart.
   */
  sweep(to: Point, lane: number) {
    if (to.y === this.at.y) return this.line(to);
    this.curve({ x: lane, y: this.at.y }, { x: lane, y: to.y }, to);
  }

  /** An open chevron whose tip is the current point, pointing along `direction` (1 = rightwards). */
  arrow(direction: 1 | -1) {
    const { x, y } = this.at;
    const back = x - direction * ARROW_LENGTH;
    this.head = `M${fmt(back)},${fmt(y - ARROW_HALF_WIDTH)}L${fmt(x)},${fmt(y)}L${fmt(back)},${fmt(y + ARROW_HALF_WIDTH)}`;
  }

  /** The drawn geometry, ready to spread into an edge. */
  done() {
    let length = 0;
    for (let i = 1; i < this.points.length; i++) {
      length += Math.hypot(
        this.points[i]!.x - this.points[i - 1]!.x,
        this.points[i]!.y - this.points[i - 1]!.y,
      );
    }
    return { line: this.d.join(''), arrow: this.head, points: this.points, length };
  }
}

const centreY = (r: Rect) => r.y + r.h / 2;

/**
 * Draws every link without running it through a node it does not belong to. Between neighbouring
 * columns a link changes height inside the gutter; to pass a column it takes the nearest gap
 * between two of that column's rows. A link inside one column bends out to the right and back.
 */
export function routeLinks(
  columns: RouteColumn[],
  nodes: ReadonlyMap<string, RouteNode>,
  links: RouteLink[],
): LayoutEdge[] {
  const slots = columns.map(slotsOf);
  const ordered = links
    .filter((l) => nodes.has(l.from) && nodes.has(l.to))
    .sort((a, b) => {
      const af = nodes.get(a.from)!;
      const bf = nodes.get(b.from)!;
      const at = nodes.get(a.to)!;
      const bt = nodes.get(b.to)!;
      return (
        centreY(af) - centreY(bf) ||
        (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) ||
        centreY(at) - centreY(bt) ||
        (a.to < b.to ? -1 : a.to > b.to ? 1 : 0)
      );
    });

  // Brackets that overlap vertically nest at different depths, shortest span innermost.
  const bracketLane = new Map<string, number>();
  for (let col = 0; col < columns.length; col++) {
    const placed: { top: number; bottom: number; lane: number }[] = [];
    const inColumn = ordered
      .filter((l) => nodes.get(l.from)!.col === col && nodes.get(l.to)!.col === col)
      .map((l) => {
        const a = centreY(nodes.get(l.from)!);
        const b = centreY(nodes.get(l.to)!);
        return { key: l.key, top: Math.min(a, b), bottom: Math.max(a, b) };
      })
      .sort((a, b) => a.bottom - a.top - (b.bottom - b.top) || a.top - b.top);
    for (const span of inColumn) {
      const taken = new Set(
        placed.filter((p) => p.top < span.bottom && span.top < p.bottom).map((p) => p.lane),
      );
      let lane = 0;
      while (taken.has(lane) && lane < BRACKET_LANES - 1) lane++;
      placed.push({ ...span, lane });
      bracketLane.set(span.key, lane);
    }
  }

  // First the course of every link between columns: where it crosses each column on the way.
  type Sweep = { gutter: number; from: Point; to: Point; group: string };
  const courses = ordered.map((link) => {
    const from = nodes.get(link.from)!;
    const to = nodes.get(link.to)!;
    if (from.col === to.col) return { link, from, to, direction: 0 as const, steps: [] };
    const direction: 1 | -1 = to.col > from.col ? 1 : -1;
    const trunk = `${direction}:${link.from}`;
    // The side of a column a link reaches first when travelling in `direction`, and the far side.
    const near = (c: RouteColumn) => (direction === 1 ? c.x : c.x + c.w);
    const far = (c: RouteColumn) => (direction === 1 ? c.x + c.w : c.x);
    const steps: (Sweep | { line: Point })[] = [];
    let at = { x: direction === 1 ? right(from) : from.x, y: centreY(from) };
    const sweep = (target: Point, gutter: number) => {
      // Links leaving one point together share a lane until they part.
      steps.push({ gutter, from: at, to: target, group: `${gutter}|${trunk}|${at.y}` });
      at = target;
    };
    for (let col = from.col + direction; col !== to.col; col += direction) {
      const y = laneY(nearestSlot(slots[col]!, at.y), trunk);
      sweep({ x: near(columns[col]!), y }, direction === 1 ? col - 1 : col);
      steps.push({ line: (at = { x: far(columns[col]!), y }) });
    }
    sweep(
      { x: direction === 1 ? to.x - TIP_GAP : right(to) + TIP_GAP, y: centreY(to) },
      direction === 1 ? to.col - 1 : to.col,
    );
    return { link, from, to, direction, steps };
  });

  // Then a lane in each gutter for every group of links that changes height there. Groups whose
  // heights overlap take different lanes, spread evenly across the gutter.
  const lanes = new Map<string, number>();
  const groups = new Map<string, { gutter: number; top: number; bottom: number }>();
  for (const course of courses) {
    for (const step of course.steps) {
      if (!('group' in step) || step.from.y === step.to.y) continue;
      const top = Math.min(step.from.y, step.to.y);
      const bottom = Math.max(step.from.y, step.to.y);
      const group = groups.get(step.group);
      if (group) {
        group.top = Math.min(group.top, top);
        group.bottom = Math.max(group.bottom, bottom);
      } else groups.set(step.group, { gutter: step.gutter, top, bottom });
    }
  }
  const laneCount = new Map<number, number>();
  const byGutter = new Map<number, [string, { top: number; bottom: number }][]>();
  for (const [key, group] of groups) {
    const list = byGutter.get(group.gutter);
    if (list) list.push([key, group]);
    else byGutter.set(group.gutter, [[key, group]]);
  }
  for (const [gutter, list] of byGutter) {
    list.sort(([ka, a], [kb, b]) => a.top - b.top || a.bottom - b.bottom || (ka < kb ? -1 : 1));
    const ends: number[] = [];
    for (const [key, group] of list) {
      let lane = ends.findIndex((end) => end < group.top);
      if (lane < 0) lane = ends.length;
      ends[lane] = group.bottom;
      lanes.set(key, lane);
    }
    laneCount.set(gutter, ends.length);
  }
  const laneX = (step: Sweep) => {
    const left = Math.min(step.from.x, step.to.x);
    const width = Math.abs(step.to.x - step.from.x);
    const count = laneCount.get(step.gutter) ?? 1;
    return left + (width * ((lanes.get(step.group) ?? 0) + 1)) / (count + 1);
  };

  return courses.map(({ link, from, to, direction, steps }) => {
    if (direction === 0) {
      const x = right(from);
      const reach = (BRACKET_DEPTH + BRACKET_STEP * (bracketLane.get(link.key) ?? 0)) / 0.75;
      const path = new Path({ x, y: centreY(from) });
      path.curve(
        { x: x + reach, y: centreY(from) },
        { x: x + reach, y: centreY(to) },
        { x: right(to) + TIP_GAP, y: centreY(to) },
      );
      path.arrow(-1);
      return { ...link, kind: 'same' as const, ...path.done() };
    }
    const path = new Path({ x: direction === 1 ? right(from) : from.x, y: centreY(from) });
    for (const step of steps) {
      if ('line' in step) path.line(step.line);
      else path.sweep(step.to, laneX(step));
    }
    path.arrow(direction);
    return {
      ...link,
      kind: direction === 1 ? ('forward' as const) : ('back' as const),
      ...path.done(),
    };
  });
}
