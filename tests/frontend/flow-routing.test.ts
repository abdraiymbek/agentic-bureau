import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../apps/desktop/src/renderer/project/flow/model';
import {
  collapsedTypes,
  layoutFlow,
  type FlowLayout,
} from '../../apps/desktop/src/renderer/project/flow/layout';
import {
  rectsOverlap,
  segmentCrossesRect,
} from '../../apps/desktop/src/renderer/project/flow/geometry';
import { edge, roverGraph, syntheticGraph, view } from './flow-fixtures';

/** Every place a drawn link passes through a node that is not one of its two ends. */
function trespasses(layout: FlowLayout): string[] {
  const found: string[] = [];
  for (const e of layout.edges) {
    for (const node of layout.nodes) {
      if (node.id === e.from || node.id === e.to) continue;
      for (let i = 1; i < e.points.length; i++) {
        if (segmentCrossesRect(e.points[i - 1]!, e.points[i]!, node)) {
          found.push(`${e.key} crosses ${node.title}`);
          break;
        }
      }
    }
  }
  return found;
}

/** Links change height only in the gutters between columns, or just right of the last one. */
function climbsOutsideGutters(layout: FlowLayout): string[] {
  const found: string[] = [];
  const inColumn = (x: number) =>
    layout.columns.some((c) => x > c.x + 0.01 && x < c.x + c.w - 0.01);
  for (const e of layout.edges) {
    for (let i = 1; i < e.points.length; i++) {
      const a = e.points[i - 1]!;
      const b = e.points[i]!;
      if (Math.abs(a.y - b.y) > 0.01 && (inColumn(a.x) || inColumn(b.x))) {
        found.push(e.key);
        break;
      }
    }
  }
  return found;
}

/** The sample halfway along a link's first bend (each bend is sampled in twelve steps). */
const CURVE_HALF = 6;

const rover = () => {
  const { artifacts, edges } = roverGraph();
  return layoutFlow(buildGraph(artifacts, edges));
};

describe('flow link routing', () => {
  it('never runs a link through an unrelated node on the rover project', () => {
    const layout = rover();
    expect(layout.edges).toHaveLength(17);
    expect(trespasses(layout)).toEqual([]);
    expect(climbsOutsideGutters(layout)).toEqual([]);
  });

  it('never runs a link through an unrelated node on random layered graphs', () => {
    for (const seed of [11, 12, 13, 14, 15, 16]) {
      const { artifacts, edges } = syntheticGraph(70, 150, seed, {
        sameColumn: 0.12,
        backward: 0.1,
      });
      const graph = buildGraph(artifacts, edges);
      const layout = layoutFlow(graph);
      expect(layout.edges.some((e) => e.kind === 'same')).toBe(true);
      expect(layout.edges.some((e) => e.kind === 'back')).toBe(true);
      expect(trespasses(layout)).toEqual([]);
      expect(climbsOutsideGutters(layout)).toEqual([]);
      const partly = layoutFlow(graph, { collapsed: new Set(['component', 'mechanical', 'test']) });
      expect(trespasses(partly)).toEqual([]);
    }
  });

  it('holds at 300 objects and 600 links, expanded and collapsed', () => {
    const { artifacts, edges } = syntheticGraph(300, 600, 5);
    const graph = buildGraph(artifacts, edges);
    expect(trespasses(layoutFlow(graph))).toEqual([]);
    expect(trespasses(layoutFlow(graph, { collapsed: collapsedTypes(graph, {}) }))).toEqual([]);
  });

  it('keeps nodes and group headers clear of each other', () => {
    const layout = rover();
    for (const a of layout.nodes)
      for (const b of layout.nodes) if (a !== b) expect(rectsOverlap(a, b)).toBe(false);
  });

  it('puts the arrowhead at the consequence end, whichever way the link runs', () => {
    const artifacts = [
      view(1, 'requirement', 'Target'),
      view(2, 'mechanical', 'Bracket'),
      view(3, 'calculation', 'Stress check'),
      view(4, 'calculation', 'Margin'),
    ];
    // Forward, inside one column, and against the reading order.
    const layout = layoutFlow(buildGraph(artifacts, [edge(1, 2), edge(3, 4), edge(3, 2)]));
    const node = (title: string) => layout.nodes.find((n) => n.title === title)!;
    const link = (from: string, to: string) =>
      layout.edges.find((e) => e.from === node(from).id && e.to === node(to).id)!;
    const tip = (e: { points: { x: number; y: number }[] }) => e.points[e.points.length - 1]!;

    const forward = link('Target', 'Bracket');
    expect(forward.kind).toBe('forward');
    expect(forward.points[0]!.x).toBe(node('Target').x + node('Target').w);
    expect(tip(forward).x).toBeCloseTo(node('Bracket').x - 1.5);
    expect(tip(forward).y).toBe(node('Bracket').y + node('Bracket').h / 2);

    const same = link('Stress check', 'Margin');
    expect(same.kind).toBe('same');
    expect(tip(same).x).toBeCloseTo(node('Margin').x + node('Margin').w + 1.5);
    // The bracket leaves and returns on the right-hand side of its column.
    for (const p of same.points)
      expect(p.x).toBeGreaterThanOrEqual(node('Margin').x + node('Margin').w);

    const back = link('Stress check', 'Bracket');
    expect(back.kind).toBe('back');
    expect(back.points[0]!.x).toBe(node('Stress check').x);
    expect(tip(back).x).toBeCloseTo(node('Bracket').x + node('Bracket').w + 1.5);

    // The arrowhead is an open chevron whose point is the tip of the line.
    for (const e of [forward, same, back]) {
      const [, , , px, py] = /M([-\d.]+),([-\d.]+)L([-\d.]+),([-\d.]+)L/.exec(e.arrow)!.map(Number);
      expect(px).toBeCloseTo(tip(e).x, 1);
      expect(py).toBeCloseTo(tip(e).y, 1);
    }
    expect(forward.length).toBeGreaterThan(0);
  });

  it('bundles links that leave one object and separates links from different objects', () => {
    const artifacts = [
      view(1, 'requirement', 'Reach'),
      view(2, 'requirement', 'Speed'),
      view(3, 'source', 'Datasheet A'),
      view(4, 'source', 'Datasheet B'),
      view(5, 'calculation', 'Range estimate'),
      view(6, 'calculation', 'Gear ratio'),
      view(7, 'test', 'Field run'),
    ];
    const layout = layoutFlow(
      buildGraph(artifacts, [edge(1, 5), edge(1, 7), edge(2, 6), edge(3, 5)]),
    );
    const id = (title: string) => layout.nodes.find((n) => n.title === title)!.id;
    const sources = layout.columns[1]!;
    /** The height at which a link crosses the sources column. */
    const crossing = (from: string, to: string) => {
      const e = layout.edges.find((x) => x.from === id(from) && x.to === id(to))!;
      return e.points.find((p) => p.x === sources.x + sources.w)!.y;
    };
    // Two links out of Reach travel as one line until they part.
    expect(crossing('Reach', 'Range estimate')).toBe(crossing('Reach', 'Field run'));
    // A link out of Speed that shares their gap runs in its own lane.
    const lanes = [crossing('Reach', 'Range estimate'), crossing('Speed', 'Gear ratio')];
    expect(Math.abs(lanes[0]! - lanes[1]!)).toBeGreaterThanOrEqual(3);
    expect(trespasses(layout)).toEqual([]);
  });

  it('gives links from different objects their own lane where they climb the same gutter', () => {
    const artifacts = [
      view(1, 'requirement', 'Reach'),
      view(2, 'requirement', 'Speed'),
      ...[10, 11, 12, 13, 14, 15].map((n) => view(n, 'source', `Datasheet ${n}`)),
    ];
    // Both requirements feed two sources, so the links of both change height in the one gutter.
    const layout = layoutFlow(
      buildGraph(artifacts, [edge(1, 10), edge(1, 15), edge(2, 11), edge(2, 14)]),
    );
    const id = (title: string) => layout.nodes.find((n) => n.title === title)!.id;
    const link = (from: string, to: string) =>
      layout.edges.find((e) => e.from === id(from) && e.to === id(to))!;
    // Halfway along a bend, links in different lanes are apart; links in one lane coincide.
    const half = (from: string, to: string) => link(from, to).points[CURVE_HALF]!.x;
    expect(Math.abs(half('Reach', 'Datasheet 15') - half('Speed', 'Datasheet 11'))).toBeGreaterThan(
      8,
    );
    expect(half('Speed', 'Datasheet 11')).toBeCloseTo(half('Speed', 'Datasheet 14'));
    expect(trespasses(layout)).toEqual([]);
    expect(climbsOutsideGutters(layout)).toEqual([]);
  });

  it('nests brackets that overlap inside one column', () => {
    const artifacts = [1, 2, 3, 4].map((n) => view(n, 'calculation', `Step ${n}`));
    const layout = layoutFlow(buildGraph(artifacts, [edge(1, 4), edge(2, 3)]));
    const reach = (e: { points: { x: number }[] }) => Math.max(...e.points.map((p) => p.x));
    const [outer, inner] = [...layout.edges].sort((a, b) => b.length - a.length);
    expect(reach(outer!)).toBeGreaterThan(reach(inner!));
    expect(layout.bounds.x + layout.bounds.w).toBeGreaterThanOrEqual(reach(outer!));
  });
});
