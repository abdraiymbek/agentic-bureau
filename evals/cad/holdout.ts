/**
 * Holdout tasks — authored after the harness changes were frozen and never
 * used while modifying the system. Different shapes, features and phrasing
 * from the main suite: an off-axis pin bore with a top pocket, a keyed
 * bushing (non-circular cut-out), a modification that changes wall thickness
 * and adds holes, a pillow block whose bore splits a section, and a chamfered
 * plate.
 */
import type { Task } from './tasks.js';

const PI = Math.PI;
const cyl = (d: number, h: number) => (PI * d * d * h) / 4;

// Keyway area outside the bore: rectangle |x|≤2, 0≤y≤8.5 minus its overlap with the r=6 bore.
const keywayRect = 4 * 8.5;
const keywayInBore = 2 * (1 * Math.sqrt(32) + 18 * Math.asin(1 / 3));
const keywayArea = keywayRect - keywayInBore;

export const HOLDOUT_TASKS: Task[] = [
  {
    id: 'hinge-block',
    category: 'feature-composition',
    prompt:
      'Create a hinge block: a rectangular body 40 mm (X) × 30 mm (Y) × 30 mm (Z) with one corner at the ' +
      'origin (x 0…40, y 0…30, z 0…30). A Ø8 mm pin bore runs through the block along X, centered at ' +
      'y = 15, z = 22. Two Ø4.5 mm mounting holes pass through the block along Z at (x=10, y=6) and ' +
      '(x=30, y=6). On the top face, a rectangular pocket 20 mm (X) × 10 mm (Y) × 4 mm deep is centered at ' +
      'x = 20, y = 25 (so it spans x 10…30, y 20…30, z 26…30).',
    expect: {
      bbox: { min: [0, 0, 0], max: [40, 30, 30] },
      volume: { value: 40 * 30 * 30 - cyl(8, 40) - 2 * cyl(4.5, 30) - 20 * 10 * 4 },
      shells: 1,
      sections: [
        {
          axis: 'x',
          at: 20,
          holeCount: 1,
          holes: [{ center: [15, 22], d: 8 }],
        },
        {
          axis: 'z',
          at: 10,
          holeCount: 2,
          holes: [
            { center: [10, 6], d: 4.5 },
            { center: [30, 6], d: 4.5 },
          ],
          outer: { size: [40, 30], center: [20, 15] },
        },
        { axis: 'x', at: 5, holeCount: 1, outer: { size: [30, 30], center: [15, 15] } },
      ],
      empty: [
        [20, 25, 28],
        [20, 15, 22],
        [10, 6, 15],
        [2, 15, 22],
      ],
      solid: [
        [20, 25, 25],
        [20, 15, 17],
        [10, 12, 15],
        [20, 5, 28],
      ],
    },
  },

  {
    id: 'keyed-bushing',
    category: 'engineering-constraints',
    prompt:
      'Create a keyed bushing with its axis on Z: outer diameter 24 mm, bore 12 mm, length 20 mm (z 0…20), ' +
      'centered on the Z axis. Cut a rectangular keyway into the bore wall along the full length on the +Y ' +
      'side: 4 mm wide (x from −2 to +2) and reaching out to a radius of 8.5 mm from the axis (i.e. the ' +
      'keyway bottom is at y = 8.5, which is 2.5 mm deeper than the bore radius).',
    expect: {
      bbox: { min: [-12, -12, 0], max: [12, 12, 20], tol: 0.15 },
      volume: { value: cyl(24, 20) - cyl(12, 20) - keywayArea * 20 },
      shells: 1,
      sections: [
        {
          axis: 'z',
          at: 10,
          holeCount: 1,
          outer: { d: 24, center: [0, 0], tol: 0.15 },
          slots: [{ center: [0, 1.25], size: [12, 14.5], tol: 0.15 }],
        },
      ],
      empty: [
        [0, 7.5, 10],
        [0, 0, 10],
        [1.5, 8, 10],
      ],
      solid: [
        [0, -7.5, 10],
        [3, 7.5, 10],
        [0, 9.2, 10],
        [-3, 7.5, 10],
      ],
    },
  },

  {
    id: 'battery-tray-modify',
    category: 'modification',
    seed: {
      title: 'Battery tray',
      path: 'artifacts/mechanical/battery-tray.scad',
      scad: [
        '// Battery tray — open-top box, millimetres',
        'outer_x = 70;',
        'outer_y = 50;',
        'outer_z = 20;',
        'wall = 2;',
        'floor_t = 2;',
        '',
        'difference() {',
        '    cube([outer_x, outer_y, outer_z]);',
        '    translate([wall, wall, floor_t])',
        '        cube([outer_x - 2 * wall, outer_y - 2 * wall, outer_z]);',
        '}',
        '',
      ].join('\n'),
    },
    prompt:
      'The project contains the mechanical artifact "Battery tray" (an open-top box 70 × 50 × 20 mm with ' +
      '2 mm walls and a 2 mm floor). Revise it: make the side walls 3 mm thick (the outer dimensions, the ' +
      'floor thickness and the open top stay as they are), and add four Ø3 mm drain holes through the floor ' +
      'at (x=10, y=10), (x=60, y=10), (x=10, y=40) and (x=60, y=40). Record it as a new revision of the same ' +
      'artifact.',
    expect: {
      bbox: { min: [0, 0, 0], max: [70, 50, 20] },
      volume: { value: 70 * 50 * 20 - 64 * 44 * 18 - 4 * cyl(3, 2) },
      shells: 1,
      sections: [
        {
          axis: 'z',
          at: 1,
          holeCount: 4,
          holes: [
            { center: [10, 10], d: 3 },
            { center: [60, 10], d: 3 },
            { center: [10, 40], d: 3 },
            { center: [60, 40], d: 3 },
          ],
          outer: { size: [70, 50], center: [35, 25] },
        },
        {
          axis: 'z',
          at: 10,
          holeCount: 1,
          slots: [{ center: [35, 25], size: [64, 44] }],
          outer: { size: [70, 50], center: [35, 25] },
        },
      ],
      solid: [
        [1.5, 25, 10],
        [35, 48.5, 10],
        [35, 25, 1],
      ],
      empty: [
        [35, 25, 10],
        [10, 10, 1],
        [3.5, 25, 10],
      ],
    },
  },

  {
    id: 'pillow-block',
    category: 'complete-object',
    prompt:
      'Design a pillow-block bearing housing as one part. Base: 70 mm (X) × 30 mm (Y) × 10 mm (Z) with one ' +
      'corner at the origin (x 0…70, y 0…30, z 0…10), with two Ø6.5 mm mounting holes through it along Z at ' +
      '(x=10, y=15) and (x=60, y=15). Upright: a block 30 mm (X) × 30 mm (Y, the full base depth) rising ' +
      'from the base to an overall height of 40 mm, centered on the base in X (x 20…50, y 0…30, z 10…40). ' +
      'Bearing bore: Ø22 mm through the upright along Y, centered at x = 35, z = 28.',
    expect: {
      bbox: { min: [0, 0, 0], max: [70, 30, 40] },
      volume: { value: 70 * 30 * 10 - 2 * cyl(6.5, 10) + 30 * 30 * 30 - cyl(22, 30) },
      shells: 1,
      sections: [
        {
          axis: 'z',
          at: 5,
          holeCount: 2,
          holes: [
            { center: [10, 15], d: 6.5 },
            { center: [60, 15], d: 6.5 },
          ],
          outer: { size: [70, 30], center: [35, 15] },
        },
        { axis: 'z', at: 28, holeCount: 0, outerCount: 2 },
        { axis: 'y', at: 15, holeCount: 1, holes: [{ center: [35, 28], d: 22 }] },
        {
          axis: 'z',
          at: 14,
          holeCount: 0,
          outerCount: 1,
          outer: { size: [30, 30], center: [35, 15] },
        },
      ],
      solid: [
        [35, 15, 12],
        [22, 15, 28],
        [48, 15, 28],
        [35, 15, 39.5],
        [65, 5, 5],
      ],
      empty: [
        [35, 15, 28],
        [10, 15, 5],
        [35, 15, 20],
        [15, 15, 20],
      ],
    },
  },

  {
    id: 'chamfered-plate',
    category: 'spatial',
    prompt:
      'Create a square mounting plate 50 mm × 50 mm × 6 mm thick with one corner at the origin (x 0…50, ' +
      'y 0…50, z 0…6). Four Ø5 mm through-holes at (10,10), (40,10), (10,40) and (40,40). The vertical ' +
      'corner edge at (x=50, y=50) is chamfered at 45° with 10 mm legs — i.e. the triangle with vertices ' +
      '(40,50), (50,50), (50,40) is removed through the full thickness.',
    expect: {
      bbox: { min: [0, 0, 0], max: [50, 50, 6] },
      volume: { value: 50 * 50 * 6 - 0.5 * 10 * 10 * 6 - 4 * cyl(5, 6) },
      shells: 1,
      sections: [
        {
          axis: 'z',
          at: 3,
          holeCount: 4,
          holes: [
            { center: [10, 10], d: 5 },
            { center: [40, 10], d: 5 },
            { center: [10, 40], d: 5 },
            { center: [40, 40], d: 5 },
          ],
          outerCount: 1,
          materialArea: { value: 2500 - 50 - 4 * (PI * 2.5 * 2.5) },
        },
      ],
      empty: [
        [48, 48, 3],
        [46, 46, 3],
        [10, 10, 3],
      ],
      solid: [
        [44, 44, 3],
        [49, 39, 3],
        [39, 49, 3],
        [49, 1, 3],
      ],
    },
  },
];
