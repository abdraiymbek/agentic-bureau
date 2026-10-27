// The Sable rover's Flow map (Intent → Parts → Design → Evidence), the same
// deterministic layout as the trailer: 26 objects, the fixture's recorded links, the Payload capacity thread and the stale path an approval
// sends through it. World units are pixels at 100 % zoom.
export const TYPE_ICON = {
  requirement: 'list-checks', assumption: 'question', source: 'link', component: 'package',
  architecture: 'tree-structure', mechanical: 'cube', wiring: 'circuitry', assembly: 'wrench',
  calculation: 'calculator', test: 'flask',
};
export const NW = 250;
export const NH = 46;
export const WC = [770, 266]; // world centre
export const NODES = [
  ['endurance', 'requirement', 'Endurance', 0, 92],
  ['payload', 'requirement', 'Payload capacity', 0, 150],
  ['wheel', 'assumption', 'Wheel radius (loaded)', 0, 240],
  ['s_batt', 'source', 'LiPo 2S 450 mAh pack (supplier listing)', 330, 92],
  ['s_reg', 'source', 'Pololu D24V22F5 5 V step-down regulator', 330, 150],
  ['s_drv', 'source', 'Pololu DRV8835 dual motor driver carrier', 330, 208],
  ['s_m100', 'source', 'Pololu Micro Metal Gearmotor HP 6V, 100:1', 330, 266],
  ['s_m50', 'source', 'Pololu Micro Metal Gearmotor HP 6V, 50:1', 330, 324],
  ['s_cam', 'source', 'Raspberry Pi Camera Module 3 Wide', 330, 382],
  ['s_pi', 'source', 'Raspberry Pi Zero 2 W', 330, 440],
  ['c_batt', 'component', 'LiPo 2S 450 mAh 30C pack', 630, 92],
  ['c_reg', 'component', 'D24V22F5 5 V step-down regulator', 630, 150],
  ['c_drv', 'component', 'DRV8835 dual motor driver carrier', 630, 208],
  ['c_m100', 'component', 'Micro Metal Gearmotor HP 6V 100:1', 630, 266],
  ['c_m50', 'component', 'Micro Metal Gearmotor HP 6V 50:1', 630, 324],
  ['c_cam', 'component', 'Raspberry Pi Camera Module 3 Wide', 630, 382],
  ['c_pi', 'component', 'Raspberry Pi Zero 2 W', 630, 440],
  ['arch', 'architecture', 'System architecture', 960, 92],
  ['tray', 'mechanical', 'Camera tray', 960, 182],
  ['wiring', 'wiring', 'Power + signal wiring', 960, 272],
  ['chassis', 'assembly', 'Chassis assembly', 960, 362],
  ['power', 'calculation', 'Electrical power budget', 1290, 92],
  ['energy', 'calculation', 'Usable pack energy', 1290, 150],
  ['mass', 'calculation', 'Rover mass budget', 1290, 208],
  ['torque', 'calculation', 'Wheel torque at 15° incline', 1290, 266],
  ['ramp', 'test', 'Ramp traverse with payload', 1290, 356],
].map(([id, type, label, x, y]) => ({ id, type, label, x, y, cx: x + NW / 2, cy: y + NH / 2 }));
export const NODE = Object.fromEntries(NODES.map((n) => [n.id, n]));
export const COL_INDEX = { 0: 0, 330: 1, 630: 2, 960: 3, 1290: 4 };
export const HEADS = [
  [0, 'Intent', 3], [330, 'Parts', 14], [960, 'Design', 4], [1290, 'Evidence', 5],
];
export const GROUPS = [
  [0, 66, 'Requirements', 2], [0, 214, 'Assumptions', 1], [330, 66, 'Sources', 7],
  [630, 66, 'Components', 7], [960, 66, 'Architecture', 1], [960, 156, 'Mechanical', 1],
  [960, 246, 'Electronics', 1], [960, 336, 'Assembly', 1], [1290, 66, 'Calculations', 4],
  [1290, 330, 'Tests', 1],
];
// Only the links the fixture records (fixtures/rover/rover.fixture.ts): each
// component derives from its captured source; the tray depends on Payload
// capacity and derives from the camera; the calculations take their sourced
// inputs (power and torque's other terms are literals); the wiring derives from
// the pack, driver and Pi; the ramp test validates Payload capacity
// (requirementRefs → a "validates" input). Assembly steps and the architecture
// record no inputs.
export const LINKS = [
  ['s_batt', 'c_batt'], ['s_reg', 'c_reg'], ['s_drv', 'c_drv'], ['s_m100', 'c_m100'],
  ['s_m50', 'c_m50'], ['s_cam', 'c_cam'], ['s_pi', 'c_pi'],
  ['payload', 'tray'], ['c_cam', 'tray'],
  ['payload', 'mass'], ['c_batt', 'mass'], ['mass', 'torque'], ['c_batt', 'energy'],
  ['c_batt', 'wiring'], ['c_drv', 'wiring'], ['c_pi', 'wiring'],
  ['payload', 'ramp'],
].map(([a, b]) => ({ a: NODE[a], b: NODE[b], key: `${a}>${b}` }));

// Hovering Payload capacity lights its downstream thread.
export const THREAD_NODES = new Set(['payload', 'tray', 'mass', 'torque', 'ramp']);
export const THREAD_LINKS = new Set(['payload>tray', 'payload>mass', 'payload>ramp', 'mass>torque']);

const COL_X = [0, 330, 630, 960, 1290];
const COLUMN = COL_X.map((x) => NODES.filter((n) => n.x === x).sort((p, q) => p.y - q.y));
/**
 * Horizontal lanes through a column: the gaps between its rows, plus above and
 * below. A gap that holds a type-group label keeps its lane in the clear band
 * above the label, so a link never strikes through or starts at a label.
 */
const LABEL_H = 18;
const LANES = COLUMN.map((col, c) => {
  if (!col.length) return [];
  const labels = GROUPS.filter(([x]) => x === COL_X[c]).map(([, y]) => y);
  const lane = (top, bottom) => {
    const label = labels.find((y) => y >= top - 1 && y < bottom);
    return label == null ? (top + bottom) / 2 : (top + label) / 2;
  };
  const first = col[0].y;
  const above = labels.find((y) => y < first && y + LABEL_H > first - 24);
  const lanes = [above == null ? first - 14 : above - 8];
  for (let i = 1; i < col.length; i++) lanes.push(lane(col[i - 1].y + NH, col[i].y));
  lanes.push(col.at(-1).y + NH + 14);
  return lanes;
});

/**
 * A link's path. Links change height only inside the gutters between columns
 * and cross a column through the gaps between its rows; a link within one
 * column is a bracket on the column's right.
 */
export function linkPath(l) {
  const { a, b } = l;
  if (a.x === b.x) {
    const x = a.x + NW;
    return `M${x} ${a.cy} C${x + 46} ${a.cy} ${x + 46} ${b.cy} ${x} ${b.cy}`;
  }
  const ca = COL_INDEX[a.x];
  const cb = COL_INDEX[b.x];
  let y = a.cy;
  let d = `M${a.x + NW} ${y}`;
  for (let g = ca; g < cb; g++) {
    const xs = COL_X[g] + NW;
    const xe = COL_X[g + 1];
    const last = g + 1 === cb;
    const target = last
      ? b.cy
      : LANES[g + 1].reduce((best, lane) =>
          Math.abs(lane - y) + 0.5 * Math.abs(lane - b.cy) < Math.abs(best - y) + 0.5 * Math.abs(best - b.cy) ? lane : best,
        );
    const xm = (xs + xe) / 2;
    d += Math.abs(target - y) < 0.5 ? ` L${xe} ${target}` : ` L${xs} ${y} C${xm} ${y} ${xm} ${target} ${xe} ${target}`;
    if (!last) d += ` L${xe + NW} ${target}`;
    y = target;
  }
  return d;
}

/** Objects an approval of Payload capacity 0.3 → 0.5 kg marks out of date, in travel order. */
export const STALE_ORDER = [
  ['payload>tray', 'payload>mass', 'payload>ramp'],
  ['mass>torque'],
];
export const STALE_NODES = ['tray', 'mass', 'torque', 'ramp'];
