/** Graphs for the flow-map tests and for the synthetic load harness. */
import type { ArtifactType, ArtifactView, Edge, Relationship } from '@omenflow/contracts';

const pad = (n: number) => String(n).padStart(12, '0');
export const nodeId = (n: number) => `00000000-0000-4000-8000-${pad(n)}`;

export function view(
  n: number,
  type: ArtifactType,
  title: string,
  state: Partial<
    Pick<ArtifactView, 'freshness' | 'staleReasons' | 'draftCount' | 'pendingProposal'>
  > & {
    baseline?: boolean;
  } = {},
): ArtifactView {
  const id = nodeId(n);
  return {
    artifact: { id, type, title },
    revision: state.baseline === false ? null : { id: `rev-${n}`, seq: 1 },
    freshness: state.freshness ?? 'current',
    staleReasons: state.staleReasons ?? [],
    draftCount: state.draftCount ?? 0,
    pendingProposal: state.pendingProposal ?? false,
  } as ArtifactView;
}

export function edge(from: number, to: number, relationship: Relationship = 'depends_on'): Edge {
  return {
    id: `edge-${from}-${to}-${relationship}`,
    upstreamArtifactId: nodeId(from),
    downstreamArtifactId: nodeId(to),
    relationship,
    requiredUpstreamRevisionId: null,
    label: '',
    createdBy: 'user',
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}

/**
 * The shape of the Sable rover fixture (`fixtures/rover/rover.fixture.ts`) as the design preview
 * serves it: 26 objects and 18 recorded links, read from `artifact.list` and `graph.list`.
 */
const ROVER_NODES: [ArtifactType, string][] = [
  ['requirement', 'Payload capacity'],
  ['requirement', 'Endurance'],
  ['assumption', 'Wheel radius (loaded)'],
  ['architecture', 'System architecture'],
  ['source', 'Pololu Micro Metal Gearmotor HP 6V, 100:1'],
  ['source', 'Pololu Micro Metal Gearmotor HP 6V, 50:1'],
  ['source', 'Pololu DRV8835 dual motor driver carrier'],
  ['source', 'Raspberry Pi Zero 2 W'],
  ['source', 'Raspberry Pi Camera Module 3 Wide'],
  ['source', 'LiPo 2S 450 mAh pack (supplier listing)'],
  ['source', 'Pololu D24V22F5 5 V step-down regulator'],
  ['component', 'Micro Metal Gearmotor HP 6V 100:1'],
  ['component', 'Micro Metal Gearmotor HP 6V 50:1'],
  ['component', 'DRV8835 dual motor driver carrier'],
  ['component', 'Raspberry Pi Zero 2 W'],
  ['component', 'Raspberry Pi Camera Module 3 Wide'],
  ['component', 'LiPo 2S 450 mAh 30C pack'],
  ['component', 'D24V22F5 5 V step-down regulator'],
  ['mechanical', 'Camera tray'],
  ['calculation', 'Rover mass budget'],
  ['calculation', 'Wheel torque at 15° incline'],
  ['calculation', 'Electrical power budget'],
  ['calculation', 'Usable pack energy'],
  ['wiring', 'Power + signal wiring'],
  ['test', 'Ramp traverse with payload'],
  ['assembly', 'Chassis assembly'],
];
const ROVER_EDGES: [number, number, Relationship][] = [
  [4, 11, 'derived_from'],
  [5, 12, 'derived_from'],
  [6, 13, 'derived_from'],
  [7, 14, 'derived_from'],
  [8, 15, 'derived_from'],
  [9, 16, 'derived_from'],
  [10, 17, 'derived_from'],
  [0, 18, 'depends_on'],
  [0, 19, 'depends_on'],
  [0, 24, 'validates'],
  [15, 18, 'derived_from'],
  [16, 19, 'depends_on'],
  [16, 22, 'depends_on'],
  [16, 22, 'depends_on'],
  [16, 23, 'derived_from'],
  [19, 20, 'depends_on'],
  [13, 23, 'derived_from'],
  [14, 23, 'derived_from'],
];

export function roverGraph(): { artifacts: ArtifactView[]; edges: Edge[] } {
  return {
    artifacts: ROVER_NODES.map(([type, title], i) =>
      view(i, type, title, { baseline: i !== 2, draftCount: i === 2 ? 1 : 0 }),
    ),
    edges: ROVER_EDGES.map(([from, to, relationship], i) => ({
      ...edge(from, to, relationship),
      id: `rover-edge-${i}`,
    })),
  };
}

/** A small deterministic generator, so a seed always gives the same graph. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPES: ArtifactType[] = [
  'requirement',
  'assumption',
  'source',
  'component',
  'concept',
  'architecture',
  'subsystem',
  'mechanical',
  'wiring',
  'software',
  'assembly',
  'note',
  'calculation',
  'test',
];
const WORDS = [
  'Payload',
  'capacity',
  'Endurance',
  'budget',
  'Wheel',
  'torque',
  'Camera',
  'tray',
  'Regulator',
  'thermal',
  'margin',
  'Drive',
  'train',
  'Battery',
  'pack',
  'Chassis',
  'plate',
  'Sensor',
  'mount',
  'Ramp',
  'traverse',
];

/**
 * A random layered graph: `nodes` objects spread over every type and `links` distinct links.
 * Most links run forward along the causal order; `sameColumn` and `backward` set the share that
 * stays inside a column or runs against it, and `related` the share that is not causal.
 */
export function syntheticGraph(
  nodes: number,
  links: number,
  seed = 1,
  mix: { sameColumn?: number; backward?: number; related?: number } = {},
): { artifacts: ArtifactView[]; edges: Edge[] } {
  const next = random(seed);
  const pick = <T>(list: T[]) => list[Math.floor(next() * list.length)]!;
  const artifacts = Array.from({ length: nodes }, (_, i) => {
    const words = 2 + Math.floor(next() * 4);
    const title = Array.from({ length: words }, () => pick(WORDS)).join(' ');
    return view(i, TYPES[i % TYPES.length]!, `${title} ${i}`);
  });
  const order = (i: number) => i % TYPES.length;
  const seen = new Set<string>();
  const edges: Edge[] = [];
  const limit = (nodes * (nodes - 1)) / 2;
  while (edges.length < Math.min(links, limit)) {
    const a = Math.floor(next() * nodes);
    const b = Math.floor(next() * nodes);
    if (a === b) continue;
    const roll = next();
    const same = roll < (mix.sameColumn ?? 0.05);
    const back = !same && roll < (mix.sameColumn ?? 0.05) + (mix.backward ?? 0.03);
    let from = order(a) <= order(b) ? a : b;
    let to = from === a ? b : a;
    if (same) to = (from + TYPES.length) % nodes;
    if (back) [from, to] = [to, from];
    if (from === to || seen.has(`${from}>${to}`) || seen.has(`${to}>${from}`)) continue;
    seen.add(`${from}>${to}`);
    edges.push(edge(from, to, next() < (mix.related ?? 0.1) ? 'connects_to' : 'depends_on'));
  }
  return { artifacts, edges };
}
