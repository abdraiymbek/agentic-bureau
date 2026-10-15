import type { ArtifactType } from '@omenflow/contracts';
import { linkKey } from '../../lib/graph';
import { typeMeta, type Layer } from '../../ui/kit';
import { bottom, right, type Rect } from './geometry';
import type { FlowGraph } from './model';
import { routeLinks, type LayoutEdge, type RouteLink } from './routing';

/**
 * Causal reading order: human intent and world sources on the left, evidence on the right.
 * A layer may span sub-columns so its internal links run horizontally.
 */
const COLUMNS: { layer: Layer; label: string; types: ArtifactType[] }[] = [
  { layer: 'intent', label: 'Intent', types: ['requirement', 'assumption'] },
  { layer: 'parts', label: 'Parts', types: ['source'] },
  { layer: 'parts', label: 'Parts', types: ['component'] },
  {
    layer: 'design',
    label: 'Design',
    types: [
      'concept',
      'architecture',
      'subsystem',
      'mechanical',
      'wiring',
      'software',
      'assembly',
      'note',
    ],
  },
  { layer: 'evidence', label: 'Evidence', types: ['calculation', 'test'] },
];
/** Where a type the map does not know yet is placed, so a new type is never dropped. */
const FALLBACK_COLUMN = 3;

/** Every size the map is drawn with, in map units (pixels at 100 % zoom). */
export const METRICS = {
  nodeHeight: 40,
  /** A node whose title takes two lines. */
  nodeTallHeight: 54,
  rowGap: 12,
  /** Between the last node of a type group and the header of the next. */
  groupGap: 20,
  groupHead: 26,
  columnHead: 46,
  gutter: 72,
  /** Between sub-columns of one layer. */
  subGutter: 52,
  minWidth: 176,
  /** The widest a column grows to keep a title on one line; longer titles take two. */
  maxText: 168,
  /** Everything in a node that is not its title: padding, glyph, gaps and one state mark. */
  chrome: 68,
  /** Extra room a collapsed group needs for its count. */
  groupExtra: 12,
  /** A node moves down by up to this much when that makes the link from its inputs level. */
  straighten: 16,
} as const;

/** Width of a title at the node's type size, in map units. */
export type Measure = (text: string) => number;

const NARROW = new Set("iljtfrI.,:;'|!()[] ");
const WIDE = new Set('mwMW@%');

/** Used where no text can be measured. Close to Geist at the map's type size. */
export const estimateTextWidth: Measure = (text) => {
  let width = 0;
  for (const ch of text) {
    if (NARROW.has(ch)) width += 3.6;
    else if (WIDE.has(ch)) width += 10.4;
    else if (ch >= 'A' && ch <= 'Z') width += 8.4;
    else if (ch >= '0' && ch <= '9') width += 7.4;
    else width += 6.8;
  }
  return width;
};

export const groupNodeId = (type: string) => `group:${type}`;

/** Past this many objects, a type group this large starts collapsed until the user opens it. */
const AUTO_COLLAPSE = { objects: 80, group: 12 };

/**
 * The type groups drawn as one summary node: the user's own choices where they made one,
 * otherwise large groups of a large project, so hundreds of objects stay navigable.
 */
export function collapsedTypes(
  graph: FlowGraph,
  choices: Readonly<Record<string, boolean>>,
): Set<string> {
  const sizes = new Map<string, number>();
  for (const n of graph.nodes) sizes.set(n.type, (sizes.get(n.type) ?? 0) + 1);
  const collapsed = new Set<string>();
  for (const [type, size] of sizes) {
    const automatic = graph.nodes.length > AUTO_COLLAPSE.objects && size > AUTO_COLLAPSE.group;
    if (choices[type] ?? automatic) collapsed.add(type);
  }
  return collapsed;
}

export interface LayoutNode extends Rect {
  id: string;
  /** A collapsed type group is one node standing for all of its members. */
  kind: 'object' | 'group';
  type: string;
  title: string;
  col: number;
  row: number;
  lines: 1 | 2;
  /** The title needs more than its two lines; the full title is one hover or focus away. */
  truncated: boolean;
  /** The objects this node stands for: itself, or every member of a collapsed group. */
  members: string[];
}

export interface LayoutLabel {
  id: string;
  kind: 'column' | 'type';
  x: number;
  y: number;
  w: number;
  text: string;
  /** Objects under this label, counted even when the group is collapsed. */
  count: number;
  type?: string;
  collapsed?: boolean;
}

export interface LayoutColumn extends Rect {
  layer: Layer;
  /** Node ids, top to bottom. */
  nodes: string[];
}

export interface FlowLayout {
  nodes: LayoutNode[];
  byId: Map<string, LayoutNode>;
  /** The node each object is drawn as: itself, or its collapsed group. */
  nodeOf: Map<string, string>;
  labels: LayoutLabel[];
  columns: LayoutColumn[];
  edges: LayoutEdge[];
  bounds: Rect;
}

export interface LayoutOptions {
  /** Types drawn as one summary node. */
  collapsed?: ReadonlySet<string>;
  measure?: Measure;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function columnOf(type: string) {
  const i = COLUMNS.findIndex((c) => c.types.includes(type as ArtifactType));
  return i < 0 ? FALLBACK_COLUMN : i;
}

/** The width a title needs on one line, and the narrowest width that holds it in two. */
function titleWidths(title: string, measure: Measure, space: number) {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const single = measure(words.join(' '));
  if (words.length < 2) return { single, double: single };
  const widths = words.map(measure);
  const total = widths.reduce((a, b) => a + b, 0) + space * (words.length - 1);
  let double = single;
  let first = 0;
  for (let i = 0; i + 1 < words.length; i++) {
    first += widths[i]! + (i ? space : 0);
    double = Math.min(double, Math.max(first, total - first - space));
  }
  return { single, double };
}

interface Draft {
  id: string;
  kind: 'object' | 'group';
  type: string;
  title: string;
  members: string[];
  single: number;
  double: number;
  h: number;
  lines: 1 | 2;
  truncated: boolean;
}

/**
 * Deterministic layered layout: columns by layer, groups by type, rows ordered by the barycentre
 * of upstream neighbours (or downstream ones for pure inputs such as sources). Column widths
 * follow their titles; links are routed through the gutters. The result depends only on the
 * graph, the collapsed groups and the text measure, never on the order of the input.
 */
export function layoutFlow(graph: FlowGraph, options: LayoutOptions = {}): FlowLayout {
  const measure = options.measure ?? estimateTextWidth;
  const collapsed = options.collapsed ?? new Set<string>();
  const space = measure('a a') - measure('aa');

  const membersByType = new Map<string, { id: string; title: string }[]>();
  for (const n of graph.nodes) {
    const list = membersByType.get(n.type);
    if (list) list.push(n);
    else membersByType.set(n.type, [n]);
  }

  // What is drawn: one node per object, or one per collapsed type group.
  const nodeOf = new Map<string, string>();
  const draftsByType = new Map<string, Draft[]>();
  for (const [type, members] of membersByType) {
    const draft = (id: string, kind: Draft['kind'], title: string, ids: string[]): Draft => ({
      id,
      kind,
      type,
      title,
      members: ids,
      ...titleWidths(title, measure, space),
      h: METRICS.nodeHeight,
      lines: 1,
      truncated: false,
    });
    if (collapsed.has(type)) {
      const id = groupNodeId(type);
      const title = `${members.length} ${members.length === 1 ? 'object' : 'objects'}`;
      const group = draft(id, 'group', title, members.map((m) => m.id).sort(byId));
      group.single += METRICS.groupExtra;
      draftsByType.set(type, [group]);
      for (const m of members) nodeOf.set(m.id, id);
    } else {
      draftsByType.set(
        type,
        members.map((m) => draft(m.id, 'object', m.title, [m.id])),
      );
      for (const m of members) nodeOf.set(m.id, m.id);
    }
  }

  // Recorded links between the same two drawn nodes become one drawn link.
  const merged = new Map<string, RouteLink>();
  for (const link of graph.links) {
    const from = nodeOf.get(link.from);
    const to = nodeOf.get(link.to);
    if (!from || !to || from === to) continue;
    const key = linkKey(from, to);
    const existing = merged.get(key);
    if (existing) {
      existing.causal ||= link.causal;
      existing.links.push(link.key);
    } else merged.set(key, { key, from, to, causal: link.causal, links: [link.key] });
  }
  const links = [...merged.values()];
  const upstream = new Map<string, string[]>();
  const downstream = new Map<string, string[]>();
  for (const l of links) {
    upstream.set(l.to, [...(upstream.get(l.to) ?? []), l.from]);
    downstream.set(l.from, [...(downstream.get(l.from) ?? []), l.to]);
  }

  // Columns that hold something, each with its types in reading order.
  const active = COLUMNS.map((column, index) => {
    const extra = [...draftsByType.keys()]
      .filter((t) => columnOf(t) === index && !column.types.includes(t as ArtifactType))
      .sort(byId);
    const types = [...column.types, ...extra].filter((t) => draftsByType.has(t));
    return { layer: column.layer, label: column.label, types };
  }).filter((c) => c.types.length > 0);

  // Width follows the titles: one line where it fits, two where it does not.
  const widths = active.map((column) => {
    let text = 0;
    for (const type of column.types) {
      for (const d of draftsByType.get(type)!) {
        text = Math.max(
          text,
          d.single <= METRICS.maxText ? d.single : Math.min(d.double, METRICS.maxText),
        );
      }
    }
    const w = Math.max(METRICS.minWidth, Math.ceil(text + 2) + METRICS.chrome);
    for (const type of column.types) {
      for (const d of draftsByType.get(type)!) {
        d.lines = d.single <= w - METRICS.chrome ? 1 : 2;
        d.truncated = d.lines === 2 && d.double > w - METRICS.chrome;
        d.h = d.lines === 2 ? METRICS.nodeTallHeight : METRICS.nodeHeight;
      }
    }
    return w;
  });

  const xs: number[] = [];
  active.forEach((column, slot) => {
    const previous = active[slot - 1];
    xs.push(
      previous
        ? xs[slot - 1]! +
            widths[slot - 1]! +
            (previous.layer === column.layer ? METRICS.subGutter : METRICS.gutter)
        : 0,
    );
  });

  /** One top-to-bottom sweep. `previous` holds the centre heights of the sweep before it. */
  const sweep = (previous: Map<string, number> | null) => {
    const centre = new Map<string, number>();
    const placed: { draft: Draft; col: number; row: number; y: number }[] = [];
    const heads: { type: string; col: number; y: number; count: number }[] = [];
    active.forEach((column, col) => {
      let y = 0;
      let row = 0;
      for (const type of column.types) {
        const group = draftsByType.get(type)!;
        const mean = (ids: string[] | undefined, from: Map<string, number> | null) => {
          const ys = (ids ?? []).map((id) => from?.get(id)).filter((n) => n !== undefined);
          return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Number.POSITIVE_INFINITY;
        };
        const keys = new Map<string, number>();
        const inputs = new Map<string, number>();
        for (const d of group) {
          const up = mean(upstream.get(d.id), centre);
          if (Number.isFinite(up)) inputs.set(d.id, up);
          keys.set(d.id, Number.isFinite(up) ? up : mean(downstream.get(d.id), previous));
        }
        // Linked objects first by barycentre, then the unlinked ones by title: one total order.
        const ordered = [...group].sort((a, b) => {
          const ka = keys.get(a.id)!;
          const kb = keys.get(b.id)!;
          if (Number.isFinite(ka) !== Number.isFinite(kb)) return Number.isFinite(ka) ? -1 : 1;
          if (Number.isFinite(ka) && ka !== kb) return ka - kb;
          return collator.compare(a.title, b.title) || byId(a.id, b.id);
        });
        // A node drops a little when that makes the link from its inputs run level. The
        // first node of a group takes its header down with it.
        const drop = (draft: Draft, top: number) => {
          const level = (inputs.get(draft.id) ?? Number.NaN) - draft.h / 2 - top;
          return level > 0 && level <= METRICS.straighten ? Math.round(level) : 0;
        };
        y += drop(ordered[0]!, y + METRICS.groupHead);
        heads.push({
          type,
          col,
          y,
          count: group.reduce((n, d) => n + d.members.length, 0),
        });
        y += METRICS.groupHead;
        for (const draft of ordered) {
          y += drop(draft, y);
          placed.push({ draft, col, row: row++, y });
          centre.set(draft.id, y + draft.h / 2);
          y += draft.h + METRICS.rowGap;
        }
        y += METRICS.groupGap - METRICS.rowGap;
      }
    });
    return { centre, placed, heads };
  };
  const { placed, heads } = sweep(sweep(null).centre);

  const nodes: LayoutNode[] = placed.map(({ draft, col, row, y }) => ({
    id: draft.id,
    kind: draft.kind,
    type: draft.type,
    title: draft.title,
    members: draft.members,
    lines: draft.lines,
    truncated: draft.truncated,
    col,
    row,
    x: xs[col]!,
    y,
    w: widths[col]!,
    h: draft.h,
  }));
  const nodesById = new Map(nodes.map((n) => [n.id, n]));

  const labels: LayoutLabel[] = [];
  active.forEach((column, col) => {
    if (active[col - 1]?.layer === column.layer) return;
    let span = 0;
    let count = 0;
    for (let i = col; i < active.length && active[i]!.layer === column.layer; i++) {
      span = xs[i]! + widths[i]! - xs[col]!;
      count += heads.filter((h) => h.col === i).reduce((n, h) => n + h.count, 0);
    }
    labels.push({
      id: `column:${column.layer}`,
      kind: 'column',
      x: xs[col]!,
      y: -METRICS.columnHead,
      w: span,
      text: column.label,
      count,
    });
  });
  for (const head of heads) {
    labels.push({
      id: `type:${head.type}`,
      kind: 'type',
      x: xs[head.col]!,
      y: head.y,
      w: widths[head.col]!,
      text: typeMeta(head.type).plural,
      count: head.count,
      type: head.type,
      collapsed: collapsed.has(head.type),
    });
  }

  const columns: LayoutColumn[] = active.map((column, col) => {
    const members = nodes.filter((n) => n.col === col).sort((a, b) => a.row - b.row);
    return {
      layer: column.layer,
      x: xs[col]!,
      w: widths[col]!,
      y: 0,
      h: Math.max(...members.map(bottom)),
      nodes: members.map((n) => n.id),
    };
  });

  const edges = routeLinks(
    columns.map((column, col) => ({
      x: column.x,
      w: column.w,
      blocks: [
        ...nodes.filter((n) => n.col === col),
        ...heads
          .filter((h) => h.col === col)
          .map((h) => ({ x: column.x, y: h.y, w: column.w, h: METRICS.groupHead })),
      ].sort((a, b) => a.y - b.y),
    })),
    nodesById,
    links,
  );

  const lastColumn = columns[columns.length - 1];
  let minX = 0;
  let minY = -METRICS.columnHead;
  let maxX = lastColumn ? right(lastColumn) : 0;
  let maxY = Math.max(0, ...columns.map(bottom));
  for (const edge of edges) {
    for (const p of edge.points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  const bounds = {
    x: Math.floor(minX),
    y: Math.floor(minY),
    w: Math.ceil(maxX) - Math.floor(minX),
    h: Math.ceil(maxY) - Math.floor(minY),
  };

  return { nodes, byId: nodesById, nodeOf, labels, columns, edges, bounds };
}
