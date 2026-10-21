/**
 * The project the introduction draws: the Sable inspection rover, the same objects the trailer and
 * the rover fixture use, placed left to right by causal layer the way the Flow lens places them.
 * Positions are in map units; the introduction scales the whole map to the window.
 */
import type { ArtifactType } from '@omenflow/contracts';

export const NODE_W = 216;
export const NODE_H = 40;
/** Column origins: Intent, Sources, Components, Design, Evidence. */
export const COLS = [0, 290, 580, 870, 1160] as const;
const ROW = 52;
const FIRST_ROW = 84;

export const WORLD = { width: COLS[4] + NODE_W, height: 420 } as const;

export interface RoverNode {
  id: string;
  type: ArtifactType;
  label: string;
  x: number;
  y: number;
  cx: number;
  cy: number;
  col: number;
  /** Seconds after the map starts drawing that this node appears. */
  delay: number;
}

const row = (n: number) => FIRST_ROW + n * ROW;

const SPEC: [id: string, type: ArtifactType, label: string, col: number, y: number][] = [
  ['endurance', 'requirement', 'Endurance', 0, row(0)],
  ['payload', 'requirement', 'Payload capacity', 0, row(1)],
  ['wheel', 'assumption', 'Wheel radius (loaded)', 0, 230],
  ['s_batt', 'source', 'LiPo 2S 450 mAh pack (supplier listing)', 1, row(0)],
  ['s_reg', 'source', 'Pololu D24V22F5 5 V step-down regulator', 1, row(1)],
  ['s_drv', 'source', 'Pololu DRV8835 dual motor driver carrier', 1, row(2)],
  ['s_m100', 'source', 'Pololu Micro Metal Gearmotor HP 6V, 100:1', 1, row(3)],
  ['s_m50', 'source', 'Pololu Micro Metal Gearmotor HP 6V, 50:1', 1, row(4)],
  ['s_cam', 'source', 'Raspberry Pi Camera Module 3 Wide', 1, row(5)],
  ['s_pi', 'source', 'Raspberry Pi Zero 2 W', 1, row(6)],
  ['c_batt', 'component', 'LiPo 2S 450 mAh 30C pack', 2, row(0)],
  ['c_reg', 'component', 'D24V22F5 5 V step-down regulator', 2, row(1)],
  ['c_drv', 'component', 'DRV8835 dual motor driver carrier', 2, row(2)],
  ['c_m100', 'component', 'Micro Metal Gearmotor HP 6V 100:1', 2, row(3)],
  ['c_m50', 'component', 'Micro Metal Gearmotor HP 6V 50:1', 2, row(4)],
  ['c_cam', 'component', 'Raspberry Pi Camera Module 3 Wide', 2, row(5)],
  ['c_pi', 'component', 'Raspberry Pi Zero 2 W', 2, row(6)],
  ['arch', 'architecture', 'System architecture', 3, row(0)],
  ['tray', 'mechanical', 'Camera tray', 3, 178],
  ['wiring', 'wiring', 'Power + signal wiring', 3, 272],
  ['chassis', 'assembly', 'Chassis assembly', 3, 366],
  ['power', 'calculation', 'Electrical power budget', 4, row(0)],
  ['energy', 'calculation', 'Usable pack energy', 4, row(1)],
  ['mass', 'calculation', 'Rover mass budget', 4, row(2)],
  ['torque', 'calculation', 'Wheel torque at 15° incline', 4, row(3)],
  ['ramp', 'test', 'Ramp traverse with payload', 4, 334],
];

const rowsSeen: Record<number, number> = {};
export const NODES: RoverNode[] = SPEC.map(([id, type, label, col, y]) => {
  const n = rowsSeen[col] ?? 0;
  rowsSeen[col] = n + 1;
  const x = COLS[col]!;
  return {
    id,
    type,
    label,
    x,
    y,
    cx: x + NODE_W / 2,
    cy: y + NODE_H / 2,
    col,
    delay: 0.1 + col * 0.17 + n * 0.045,
  };
});
export const NODE: Record<string, RoverNode> = Object.fromEntries(NODES.map((n) => [n.id, n]));

export interface MapLabel {
  x: number;
  y: number;
  label: string;
  count: number;
  delay: number;
}

const head = (col: number, label: string, count: number): MapLabel => ({
  x: COLS[col]!,
  y: 14,
  label,
  count,
  delay: 0.04 + col * 0.17,
});
export const HEADS: MapLabel[] = [
  head(0, 'Intent', 3),
  head(1, 'Parts', 14),
  head(3, 'Design', 4),
  head(4, 'Evidence', 5),
];

const group = (col: number, y: number, label: string, count: number): MapLabel => ({
  x: COLS[col]!,
  y,
  label,
  count,
  delay: 0.06 + col * 0.17,
});
export const GROUPS: MapLabel[] = [
  group(0, 60, 'Requirements', 2),
  group(0, 206, 'Assumptions', 1),
  group(1, 60, 'Sources', 7),
  group(2, 60, 'Components', 7),
  group(3, 60, 'Architecture', 1),
  group(3, 154, 'Mechanical', 1),
  group(3, 248, 'Electronics', 1),
  group(3, 342, 'Assembly', 1),
  group(4, 60, 'Calculations', 4),
  group(4, 310, 'Tests', 1),
];

export interface RoverLink {
  key: string;
  a: RoverNode;
  b: RoverNode;
  d: string;
  delay: number;
}

/**
 * A link leaves the right edge of its input and arrives at the left edge of its consequence.
 * Two objects in the same column (a calculation feeding another) loop out on the right.
 */
export function linkPath(a: RoverNode, b: RoverNode): string {
  const x1 = a.x + NODE_W;
  const x2 = b.x;
  if (a.x === b.x) return `M${x1} ${a.cy} C${x1 + 46} ${a.cy} ${x1 + 46} ${b.cy} ${x1} ${b.cy}`;
  const dx = Math.max(40, (x2 - x1) * 0.5);
  return `M${x1} ${a.cy} C${x1 + dx} ${a.cy} ${x2 - dx} ${b.cy} ${x2} ${b.cy}`;
}

const LINK_SPEC: [from: string, to: string][] = [
  ['s_batt', 'c_batt'],
  ['s_reg', 'c_reg'],
  ['s_drv', 'c_drv'],
  ['s_m100', 'c_m100'],
  ['s_m50', 'c_m50'],
  ['s_cam', 'c_cam'],
  ['s_pi', 'c_pi'],
  ['payload', 'tray'],
  ['payload', 'mass'],
  ['c_cam', 'tray'],
  ['c_batt', 'arch'],
  ['c_batt', 'wiring'],
  ['c_batt', 'energy'],
  ['c_batt', 'mass'],
  ['c_reg', 'wiring'],
  ['c_drv', 'wiring'],
  ['c_pi', 'wiring'],
  ['c_drv', 'arch'],
  ['c_m100', 'chassis'],
  ['c_pi', 'arch'],
  ['mass', 'torque'],
  ['wheel', 'torque'],
  ['torque', 'ramp'],
  ['endurance', 'energy'],
  ['wiring', 'power'],
  ['arch', 'power'],
];

export const LINKS: RoverLink[] = LINK_SPEC.map(([from, to]) => {
  const a = NODE[from]!;
  const b = NODE[to]!;
  return { key: `${from}>${to}`, a, b, d: linkPath(a, b), delay: Math.max(a.delay, b.delay) + 0.2 };
});

export interface Thread {
  nodes: Set<string>;
  links: Set<string>;
  /** Breadth-first distance from the origin, for nodes and links; the origin is wave 0. */
  wave: Record<string, number>;
}

/** Everything downstream of `id` along recorded links, the way the Flow lens lights a thread. */
export function downstream(id: string): Thread {
  const nodes = new Set<string>([id]);
  const links = new Set<string>();
  const wave: Record<string, number> = { [id]: 0 };
  let frontier = [id];
  let depth = 0;
  while (frontier.length) {
    depth += 1;
    const next: string[] = [];
    for (const from of frontier)
      for (const l of LINKS)
        if (l.a.id === from) {
          links.add(l.key);
          wave[l.key] = depth - 1;
          if (!nodes.has(l.b.id)) {
            nodes.add(l.b.id);
            wave[l.b.id] = depth;
            next.push(l.b.id);
          }
        }
    frontier = next;
  }
  return { nodes, links, wave };
}

/** The thread the introduction lights, and the baseline that changes when it decides. */
export const ORIGIN = 'payload';
/** The object the introduction focuses on. */
export const FOCUS = 'tray';
