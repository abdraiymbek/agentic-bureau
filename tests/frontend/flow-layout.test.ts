import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../apps/desktop/src/renderer/project/flow/model';
import {
  collapsedTypes,
  groupNodeId,
  layoutFlow,
  METRICS,
  type FlowLayout,
} from '../../apps/desktop/src/renderer/project/flow/layout';
import { edge, nodeId, random, roverGraph, syntheticGraph, view } from './flow-fixtures';

const rover = () => {
  const { artifacts, edges } = roverGraph();
  return buildGraph(artifacts, edges);
};
const titlesOf = (layout: FlowLayout, col: number) =>
  layout.columns[col]!.nodes.map((id) => layout.byId.get(id)!.title);
/** Everything a drawing depends on, without the lookup maps. */
const drawn = (layout: FlowLayout) => ({
  nodes: layout.nodes.map(({ id, x, y, w, h, lines, row, col }) => [
    id,
    x,
    y,
    w,
    h,
    lines,
    row,
    col,
  ]),
  labels: layout.labels,
  edges: layout.edges.map((e) => [e.key, e.kind, e.line, e.arrow]),
  bounds: layout.bounds,
});

function shuffled<T>(list: T[], seed: number): T[] {
  const next = random(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe('flow layout', () => {
  it('reads causally: intent, sources, components, design, evidence', () => {
    const layout = layoutFlow(rover());
    expect(layout.columns.map((c) => c.layer)).toEqual([
      'intent',
      'parts',
      'parts',
      'design',
      'evidence',
    ]);
    const xs = layout.columns.map((c) => c.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(layout.labels.filter((l) => l.kind === 'column').map((l) => [l.text, l.count])).toEqual([
      ['Intent', 3],
      ['Parts', 14],
      ['Design', 4],
      ['Evidence', 5],
    ]);
    // Sub-columns of one layer sit closer together than layers do.
    expect(xs[2]! - (xs[1]! + layout.columns[1]!.w)).toBe(METRICS.subGutter);
    expect(xs[3]! - (xs[2]! + layout.columns[2]!.w)).toBe(METRICS.gutter);
  });

  it('groups a column by type in the order the layer lists them', () => {
    const layout = layoutFlow(rover());
    expect(layout.columns[3]!.nodes.map((id) => layout.byId.get(id)!.type)).toEqual([
      'architecture',
      'mechanical',
      'wiring',
      'assembly',
    ]);
    expect(titlesOf(layout, 0)).toEqual(['Payload capacity', 'Endurance', 'Wheel radius (loaded)']);
  });

  it('orders rows by the barycentre of their inputs, so one-to-one links run level', () => {
    const layout = layoutFlow(rover());
    const centre = (id: string) => layout.byId.get(id)!.y + layout.byId.get(id)!.h / 2;
    const sourceToComponent = layout.edges.filter(
      (e) => layout.byId.get(e.from)!.type === 'source',
    );
    expect(sourceToComponent).toHaveLength(7);
    for (const e of sourceToComponent) expect(centre(e.to)).toBe(centre(e.from));
    // Payload capacity feeds design and evidence, so it rises above Endurance, which feeds nothing.
    expect(titlesOf(layout, 0).indexOf('Payload capacity')).toBeLessThan(
      titlesOf(layout, 0).indexOf('Endurance'),
    );
  });

  it('gives the same drawing whatever order the project arrives in', () => {
    const { artifacts, edges } = roverGraph();
    const reference = drawn(layoutFlow(buildGraph(artifacts, edges)));
    for (const seed of [1, 2, 3, 4, 5]) {
      const graph = buildGraph(shuffled(artifacts, seed), shuffled(edges, seed + 10));
      expect(drawn(layoutFlow(graph))).toEqual(reference);
    }
    const big = syntheticGraph(120, 240, 7);
    expect(
      drawn(layoutFlow(buildGraph(shuffled(big.artifacts, 3), shuffled(big.edges, 4)))),
    ).toEqual(drawn(layoutFlow(buildGraph(big.artifacts, big.edges))));
  });

  it('keeps the same structure key while only state changes', () => {
    const { artifacts, edges } = roverGraph();
    const before = buildGraph(artifacts, edges);
    const after = buildGraph(
      artifacts.map((v, i) => (i === 0 ? { ...v, pendingProposal: true, freshness: 'stale' } : v)),
      [...edges].reverse(),
    );
    expect(after.key).toBe(before.key);
    const renamed = buildGraph(
      artifacts.map((v, i) =>
        i === 0 ? { ...v, artifact: { ...v.artifact, title: 'Payload' } } : v,
      ),
      edges,
    );
    expect(renamed.key).not.toBe(before.key);
    expect(buildGraph(artifacts, edges.slice(1)).key).not.toBe(before.key);
  });

  it('orders unlinked objects after linked ones, by title, as one consistent order', () => {
    // Two components are each fed by one source; two more are unlinked.
    const artifacts = [
      view(1, 'source', 'Upper source'),
      view(2, 'source', 'Lower source'),
      view(3, 'component', 'Zeta, fed by the lower source'),
      view(4, 'component', 'Alpha, fed by the upper source'),
      view(5, 'component', 'Mango, unlinked'),
      view(6, 'component', 'Banana, unlinked'),
    ];
    const edges = [edge(1, 4), edge(2, 3)];
    for (const seed of [1, 2, 3, 4]) {
      const layout = layoutFlow(buildGraph(shuffled(artifacts, seed), edges));
      const sources = titlesOf(layout, 0);
      const linked = sources[0] === 'Upper source' ? ['Alpha', 'Zeta'] : ['Zeta', 'Alpha'];
      expect(titlesOf(layout, 1).map((t) => t.split(',')[0])).toEqual([
        ...linked,
        'Banana',
        'Mango',
      ]);
    }
  });

  it('places a type it does not know instead of dropping it', () => {
    const { artifacts, edges } = roverGraph();
    const unknown = {
      ...view(900, 'note', 'Thermal survey'),
      artifact: { id: nodeId(900), type: 'survey', title: 'Thermal survey' },
    };
    const layout = layoutFlow(buildGraph([...artifacts, unknown as never], edges));
    const placed = layout.byId.get(nodeId(900));
    expect(placed).toBeDefined();
    expect(layout.columns[placed!.col]!.layer).toBe('design');
    expect(layout.nodes).toHaveLength(27);
  });

  it('sizes columns to their titles and wraps long titles onto a second line', () => {
    const layout = layoutFlow(rover());
    for (const column of layout.columns) {
      expect(column.w).toBeGreaterThanOrEqual(METRICS.minWidth);
      expect(column.w).toBeLessThanOrEqual(METRICS.maxText + METRICS.chrome + 3);
    }
    expect(layout.nodes.filter((n) => n.truncated)).toEqual([]);
    const long = layout.nodes.find((n) => n.title.startsWith('Pololu Micro Metal Gearmotor'))!;
    expect(long.lines).toBe(2);
    expect(long.h).toBe(METRICS.nodeTallHeight);
    const short = layout.nodes.find((n) => n.title === 'Endurance')!;
    expect(short.lines).toBe(1);
    expect(short.h).toBe(METRICS.nodeHeight);
    // Rows never overlap, whatever their heights.
    for (const column of layout.columns) {
      const rows = column.nodes.map((id) => layout.byId.get(id)!);
      for (let i = 1; i < rows.length; i++)
        expect(rows[i]!.y - (rows[i - 1]!.y + rows[i - 1]!.h)).toBeGreaterThanOrEqual(
          METRICS.rowGap,
        );
    }
  });

  it('marks a title that needs more than two lines as truncated', () => {
    const title = Array.from({ length: 14 }, (_, i) => `segment${i}`).join(' ');
    const layout = layoutFlow(buildGraph([view(1, 'note', title)], []));
    expect(layout.nodes[0]).toMatchObject({ lines: 2, truncated: true });
  });

  it('collapses a type group into one summary node and merges its links', () => {
    const graph = rover();
    const layout = layoutFlow(graph, { collapsed: new Set(['component']) });
    const group = layout.byId.get(groupNodeId('component'))!;
    expect(group).toMatchObject({ kind: 'group', title: '7 objects' });
    expect(group.members).toHaveLength(7);
    expect(layout.nodes).toHaveLength(26 - 7 + 1);
    expect(layout.labels.find((l) => l.type === 'component')).toMatchObject({
      count: 7,
      collapsed: true,
    });
    // Seven sources feed the group; the group feeds four objects through six recorded links.
    expect(layout.edges.filter((e) => e.to === group.id)).toHaveLength(7);
    const out = layout.edges.filter((e) => e.from === group.id);
    expect(out.map((e) => layout.byId.get(e.to)!.title).sort()).toEqual([
      'Camera tray',
      'Power + signal wiring',
      'Rover mass budget',
      'Usable pack energy',
    ]);
    expect(
      out.find((e) => layout.byId.get(e.to)!.title === 'Power + signal wiring')!.links,
    ).toHaveLength(3);
    for (const member of group.members) expect(layout.nodeOf.get(member)).toBe(group.id);
    // Every recorded link is still drawn exactly once.
    expect(layout.edges.flatMap((e) => e.links).sort()).toEqual(
      graph.links.map((l) => l.key).sort(),
    );
  });

  it('collapses large groups of a large project until the user opens them', () => {
    const small = rover();
    expect(collapsedTypes(small, {})).toEqual(new Set());
    expect(collapsedTypes(small, { source: true })).toEqual(new Set(['source']));
    const { artifacts, edges } = syntheticGraph(300, 600, 2);
    const large = buildGraph(artifacts, edges);
    const automatic = collapsedTypes(large, {});
    expect(automatic.size).toBe(14);
    expect(layoutFlow(large, { collapsed: automatic }).nodes).toHaveLength(14);
    const opened = collapsedTypes(large, { mechanical: false });
    expect(opened.has('mechanical')).toBe(false);
    expect(opened.size).toBe(13);
  });

  it('lays out 300 objects and 600 links quickly', () => {
    const { artifacts, edges } = syntheticGraph(300, 600, 5);
    const graph = buildGraph(artifacts, edges);
    layoutFlow(graph);
    const started = performance.now();
    const layout = layoutFlow(graph);
    const elapsed = performance.now() - started;
    expect(layout.nodes).toHaveLength(300);
    expect(layout.edges).toHaveLength(600);
    // Generous: the machine running this is shared. Typical is a few milliseconds.
    expect(elapsed).toBeLessThan(250);
  });
});
