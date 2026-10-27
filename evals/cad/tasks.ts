/**
 * CAD evaluation suite — engineering intent → OpenSCAD part, judged by
 * deterministic geometry checks (evals/cad/checks.ts).
 *
 * Every task states dimensions in millimetres with an explicit coordinate
 * frame, the way a careful engineer would brief a colleague. Expectations are
 * closed-form (volumes are analytic; polygonal circle approximation is
 * absorbed by the 1.5 % volume tolerance and 0.1 mm linear tolerance).
 */
import type { Expectation } from './checks.js';
import type { Vec3 } from '@bureau/core';

export interface SeedArtifact {
  title: string;
  scad: string;
  path: string;
  params?: Record<string, unknown>;
}

export interface Variant {
  /** `-D name=value` overrides to re-render the delivered source with. */
  params: Record<string, number>;
  expect: Expectation;
}

export interface Task {
  id: string;
  category:
    | 'basic'
    | 'parametric'
    | 'feature-composition'
    | 'spatial'
    | 'engineering-constraints'
    | 'modification'
    | 'complete-object';
  prompt: string;
  expect: Expectation;
  /** Parametric tasks: the source must respond to these `-D` overrides. */
  variants?: Variant[];
  /** Modification tasks: an artifact that exists before the agent starts. */
  seed?: SeedArtifact;
  /** Modification tasks: regions where geometry is allowed to change (for preservation sampling). */
  changeRegions?: { center: Vec3; radius: number }[];
  /** Expected number of mechanical artifacts after the run (default: 1). */
  artifactCount?: number;
}

const PI = Math.PI;
const cyl = (d: number, h: number) => (PI * d * d * h) / 4;

/* ------------------------------------------------------------------ */

export const TASKS: Task[] = [
  {
    id: 'basic-plate',
    category: 'basic',
    prompt:
      'Create a rectangular plate 100 mm long (X) × 40 mm wide (Y) × 6 mm thick (Z). ' +
      'Place one corner at the origin so the plate occupies x 0…100, y 0…40, z 0…6.',
    expect: {
      bbox: { min: [0, 0, 0], max: [100, 40, 6] },
      volume: { value: 24000 },
      shells: 1,
      solid: [[50, 20, 3]],
    },
  },

  {
    id: 'spacer-ring',
    category: 'basic',
    prompt:
      'Create a cylindrical spacer: outer diameter 20 mm, through-bore 8.4 mm (clearance for an M8 bolt), ' +
      'height 12 mm. Axis along Z, centered on the Z axis, sitting on the XY plane (z from 0 to 12).',
    expect: {
      bbox: { min: [-10, -10, 0], max: [10, 10, 12], tol: 0.15 },
      volume: { value: cyl(20, 12) - cyl(8.4, 12) },
      shells: 1,
      sections: [
        {
          axis: 'z',
          at: 6,
          holeCount: 1,
          holes: [{ center: [0, 0], d: 8.4 }],
          outer: { d: 20, center: [0, 0], tol: 0.15 },
        },
      ],
      empty: [
        [0, 0, 6],
        [0, 0, -1],
      ],
      solid: [
        [7, 0, 6],
        [0, -7, 6],
      ],
    },
  },

  {
    id: 'l-bracket-parametric',
    category: 'parametric',
    prompt:
      'Create a parametric L-bracket. Base plate: base_length = 60 mm along X, base_width = 40 mm along Y, ' +
      'thickness = 5 mm, occupying x 0…60, y 0…40, z 0…5. A vertical plate of the same thickness rises from ' +
      'the back edge of the base (its outer face flush with y = 40, so it occupies y 35…40) across the full ' +
      'base_length, up to an overall height = 45 mm (z 0…45). Two through-holes of diameter hole_d = 6 mm go ' +
      'through the base plate (along Z) centered at (x=15, y=17.5) and (x=45, y=17.5). ' +
      'Expose base_length, base_width, thickness, height and hole_d as top-level OpenSCAD variables with ' +
      'exactly those names so the part can be re-sized.',
    expect: {
      bbox: { min: [0, 0, 0], max: [60, 40, 45] },
      volume: { value: 60 * 40 * 5 + 60 * 5 * 40 - 2 * cyl(6, 5) },
      shells: 1,
      sections: [
        {
          axis: 'z',
          at: 2.5,
          holeCount: 2,
          holes: [
            { center: [15, 17.5], d: 6 },
            { center: [45, 17.5], d: 6 },
          ],
          outer: { size: [60, 40], center: [30, 20] },
        },
        {
          axis: 'z',
          at: 25,
          holeCount: 0,
          outerCount: 1,
          outer: { size: [60, 5], center: [30, 37.5] },
        },
      ],
      solid: [[30, 37.5, 25]],
      empty: [
        [30, 20, 25],
        [15, 17.5, 2.5],
      ],
    },
    variants: [
      {
        params: { base_length: 80, height: 60 },
        expect: {
          bbox: { min: [0, 0, 0], max: [80, 40, 60] },
          volume: { value: 80 * 40 * 5 + 80 * 5 * 55 - 2 * cyl(6, 5) },
          sections: [{ axis: 'z', at: 2.5, holeCount: 2 }],
        },
      },
    ],
  },

  {
    id: 'flanged-hub',
    category: 'feature-composition',
    prompt:
      'Create a flanged hub centered on the Z axis: a flange disc Ø50 mm × 6 mm thick (z 0…6); a concentric ' +
      'boss Ø24 mm rising from the flange to an overall height of 22 mm (z 6…22); a Ø10 mm bore through the ' +
      'entire part along Z; and four Ø5 mm bolt holes through the flange only, on a 38 mm pitch-circle ' +
      'diameter at 0°, 90°, 180° and 270° (the first one on the +X axis).',
    expect: {
      bbox: { min: [-25, -25, 0], max: [25, 25, 22], tol: 0.3 },
      volume: { value: cyl(50, 6) + cyl(24, 16) - cyl(10, 22) - 4 * cyl(5, 6) },
      shells: 1,
      sections: [
        {
          axis: 'z',
          at: 3,
          holeCount: 5,
          holes: [
            { center: [0, 0], d: 10 },
            { center: [19, 0], d: 5 },
            { center: [0, 19], d: 5 },
            { center: [-19, 0], d: 5 },
            { center: [0, -19], d: 5 },
          ],
          outer: { d: 50, center: [0, 0], tol: 0.3 },
        },
        {
          axis: 'z',
          at: 14,
          holeCount: 1,
          holes: [{ center: [0, 0], d: 10 }],
          outer: { d: 24, center: [0, 0], tol: 0.2 },
        },
      ],
      solid: [
        [8, 0, 14],
        [22, 5, 3],
      ],
      empty: [
        [19, 0, 3],
        [0, 0, 10],
        [20, 0, 14],
      ],
    },
  },

  {
    id: 'standoff-plate',
    category: 'spatial',
    prompt:
      'Create a base plate 80 mm (X) × 50 mm (Y) × 4 mm thick, centered on the origin in X and Y with its ' +
      'bottom face on z = 0. On top of the plate add four cylindrical standoffs Ø6 mm, 10 mm tall, whose ' +
      'centers sit at the corners of a 60 mm × 34 mm rectangle that is also centered on the origin. Each ' +
      'standoff has a Ø2.5 mm blind hole drilled 8 mm deep from its top face along its axis.',
    expect: {
      bbox: { min: [-40, -25, 0], max: [40, 25, 14], tol: 0.15 },
      volume: { value: 80 * 50 * 4 + 4 * cyl(6, 10) - 4 * cyl(2.5, 8) },
      shells: 1,
      sections: [
        {
          axis: 'z',
          at: 10,
          outerCount: 4,
          holeCount: 4,
          holes: [
            { center: [30, 17], d: 2.5 },
            { center: [-30, 17], d: 2.5 },
            { center: [30, -17], d: 2.5 },
            { center: [-30, -17], d: 2.5 },
          ],
        },
        {
          axis: 'z',
          at: 2,
          holeCount: 0,
          outerCount: 1,
          outer: { size: [80, 50], center: [0, 0] },
        },
      ],
      solid: [
        [30, 17, 5],
        [32.2, 17, 10],
      ],
      empty: [
        [30, 17, 10],
        [0, 0, 8],
      ],
    },
  },

  {
    id: 'slotted-link',
    category: 'engineering-constraints',
    prompt:
      'Create a flat slotted link 6 mm thick (z 0…6), lying in the XY plane and centered on the origin. ' +
      'The link is 20 mm wide with fully rounded ends (end radius equal to half the width) and an overall ' +
      'length of 90 mm tip to tip along X. Through the link runs a centered slot 5 mm wide with rounded ' +
      'ends, whose end-centers are 40 mm apart along X (so the slot is symmetric about the origin).',
    expect: {
      bbox: { min: [-45, -10, 0], max: [45, 10, 6], tol: 0.15 },
      volume: { value: (70 * 20 + PI * 100 - (40 * 5 + PI * 2.5 * 2.5)) * 6 },
      shells: 1,
      sections: [
        {
          axis: 'z',
          at: 3,
          holeCount: 1,
          outerCount: 1,
          slots: [{ center: [0, 0], size: [45, 5], tol: 0.15 }],
        },
      ],
      solid: [
        [-40, 0, 3],
        [0, 7, 3],
      ],
      empty: [
        [0, 0, 3],
        [20, 0, 3],
        [-22, 0, 3],
        [-44, 9, 3],
      ],
    },
  },

  {
    id: 'sensor-plate-modify',
    category: 'modification',
    seed: {
      title: 'Sensor mount plate',
      path: 'artifacts/mechanical/sensor-mount-plate.scad',
      scad: [
        '// Sensor mount plate — millimetres',
        'plate_w = 60;',
        'plate_d = 40;',
        'plate_t = 4;',
        'hole_d  = 2.5;',
        'inset   = 5;',
        'boss_d  = 10;',
        'boss_h  = 6;',
        '',
        'difference() {',
        '    cube([plate_w, plate_d, plate_t]);',
        '    for (x = [inset, plate_w - inset])',
        '        for (y = [inset, plate_d - inset])',
        '            translate([x, y, -1]) cylinder(d = hole_d, h = plate_t + 2, $fn = 32);',
        '}',
        '// connector boss',
        'translate([45, 20, plate_t]) cylinder(d = boss_d, h = boss_h, $fn = 48);',
        '',
      ].join('\n'),
      params: { plate_w: 60, plate_d: 40, plate_t: 4 },
    },
    prompt:
      'The project already contains the mechanical artifact "Sensor mount plate". Modify it: change the four ' +
      'corner mounting holes from Ø2.5 mm to Ø3.4 mm (M3 clearance) and add a fifth Ø3.4 mm through-hole at ' +
      'the plate center (x=30, y=20). Do not change anything else — the plate size, thickness and the ' +
      'connector boss must stay exactly as they are. Record the change as a new revision of the same artifact.',
    expect: {
      bbox: { min: [0, 0, 0], max: [60, 40, 10] },
      volume: { value: 60 * 40 * 4 - 5 * cyl(3.4, 4) + cyl(10, 6) },
      shells: 1,
      sections: [
        {
          axis: 'z',
          at: 2,
          holeCount: 5,
          holes: [
            { center: [5, 5], d: 3.4 },
            { center: [55, 5], d: 3.4 },
            { center: [5, 35], d: 3.4 },
            { center: [55, 35], d: 3.4 },
            { center: [30, 20], d: 3.4 },
          ],
          outer: { size: [60, 40], center: [30, 20] },
        },
        { axis: 'z', at: 7, holeCount: 0, outerCount: 1, outer: { d: 10, center: [45, 20] } },
      ],
    },
    changeRegions: [
      { center: [5, 5, 2], radius: 3.5 },
      { center: [55, 5, 2], radius: 3.5 },
      { center: [5, 35, 2], radius: 3.5 },
      { center: [55, 35, 2], radius: 3.5 },
      { center: [30, 20, 2], radius: 3.5 },
    ],
  },

  {
    id: 'nema17-motor-mount',
    category: 'complete-object',
    prompt:
      'Design a NEMA 17 stepper motor mount as one part. Mounting plate: 60 mm × 60 mm × 5 mm thick, centered ' +
      'on the origin in X and Y, bottom face on z = 0. Through the plate along Z: a central Ø22.5 mm clearance ' +
      'hole for the motor pilot, and four Ø3.4 mm holes for M3 screws on a 31 mm × 31 mm square pattern ' +
      'centered on the origin (i.e. at x = ±15.5, y = ±15.5). Two side walls rise from the plate: each is ' +
      '60 mm long (X) × 5 mm thick (Y) and reaches an overall height of 30 mm (z 0…30), flush with the outer ' +
      'edges at y = +30 and y = −30 (so they occupy y 25…30 and y −30…−25). Each wall has two Ø4.5 mm ' +
      'mounting holes drilled through it along Y, centered at x = ±20 and z = 20.',
    expect: {
      bbox: { min: [-30, -30, 0], max: [30, 30, 30] },
      volume: {
        value: 60 * 60 * 5 - cyl(22.5, 5) - 4 * cyl(3.4, 5) + 2 * (60 * 5 * 25) - 4 * cyl(4.5, 5),
      },
      shells: 1,
      sections: [
        {
          axis: 'z',
          at: 2.5,
          holeCount: 5,
          holes: [
            { center: [0, 0], d: 22.5 },
            { center: [15.5, 15.5], d: 3.4 },
            { center: [-15.5, 15.5], d: 3.4 },
            { center: [15.5, -15.5], d: 3.4 },
            { center: [-15.5, -15.5], d: 3.4 },
          ],
          outer: { size: [60, 60], center: [0, 0] },
        },
        {
          axis: 'y',
          at: 27.5,
          holeCount: 2,
          holes: [
            { center: [20, 20], d: 4.5 },
            { center: [-20, 20], d: 4.5 },
          ],
          outer: { size: [60, 30], center: [0, 15] },
        },
        {
          axis: 'y',
          at: -27.5,
          holeCount: 2,
          holes: [
            { center: [20, 20], d: 4.5 },
            { center: [-20, 20], d: 4.5 },
          ],
        },
        { axis: 'z', at: 15, outerCount: 2, holeCount: 0 },
      ],
      solid: [
        [20, 27.5, 12],
        [0, 27.5, 20],
        [25, 0, 2.5],
      ],
      empty: [
        [20, 27.5, 20],
        [-20, -27.5, 20],
        [0, 0, 2.5],
        [0, 0, 15],
      ],
    },
  },
];

/* ---------------- harder tier ---------------- */

const hexArea = (acrossFlats: number) => 2 * Math.sqrt(3) * (acrossFlats / 2) ** 2;
const frustum = (r1: number, r2: number, h: number) => (PI * h * (r1 * r1 + r1 * r2 + r2 * r2)) / 3;

TASKS.push(
  {
    id: 'stepped-shaft',
    category: 'spatial',
    prompt:
      'Create a stepped shaft with its axis along the X axis. Section 1: Ø12 mm, 30 mm long, from x = 0 to ' +
      'x = 30. Section 2: Ø8 mm, 20 mm long, from x = 30 to x = 50. The free end of the Ø8 section (at x = 50) ' +
      'has a 1 mm × 45° chamfer (the end face diameter is therefore 6 mm). The shaft is centered on the X axis ' +
      '(y = 0, z = 0).',
    expect: {
      bbox: { min: [0, -6, -6], max: [50, 6, 6], tol: 0.15 },
      volume: { value: cyl(12, 30) + cyl(8, 19) + frustum(4, 3, 1) },
      shells: 1,
      sections: [
        { axis: 'x', at: 15, holeCount: 0, outerCount: 1, outer: { d: 12, center: [0, 0] } },
        { axis: 'x', at: 40, holeCount: 0, outerCount: 1, outer: { d: 8, center: [0, 0] } },
        {
          axis: 'x',
          at: 49.5,
          holeCount: 0,
          outerCount: 1,
          outer: { d: 7, center: [0, 0], tol: 0.15 },
        },
      ],
      solid: [
        [15, 0, 0],
        [40, 3.5, 0],
      ],
      empty: [
        [40, 4.5, 0],
        [49.8, 3.5, 0],
        [-0.5, 0, 0],
      ],
    },
  },

  {
    id: 'open-box',
    category: 'feature-composition',
    prompt:
      'Create an open-top box: outer footprint 80 mm (X) × 60 mm (Y), overall height 30 mm, one corner at the ' +
      'origin (x 0…80, y 0…60, z 0…30). Walls 2.5 mm thick, floor 3 mm thick, open at the top. Four Ø3.2 mm ' +
      'through-holes in the floor, inset 6 mm from each outer corner (centers at (6,6), (74,6), (6,54), (74,54)). ' +
      'A rectangular cable cut-out through the +X wall (the wall at x = 77.5…80): 20 mm wide (Y) × 10 mm tall (Z), ' +
      'centered on that wall in Y (y 20…40) with its bottom edge at z = 10 (z 10…20).',
    expect: {
      bbox: { min: [0, 0, 0], max: [80, 60, 30] },
      volume: { value: 80 * 60 * 30 - 75 * 55 * 27 - 4 * cyl(3.2, 3) - 20 * 10 * 2.5 },
      shells: 1,
      sections: [
        {
          axis: 'z',
          at: 1.5,
          holeCount: 4,
          holes: [
            { center: [6, 6], d: 3.2 },
            { center: [74, 6], d: 3.2 },
            { center: [6, 54], d: 3.2 },
            { center: [74, 54], d: 3.2 },
          ],
          outer: { size: [80, 60], center: [40, 30] },
        },
        {
          axis: 'z',
          at: 25,
          holeCount: 1,
          slots: [{ center: [40, 30], size: [75, 55] }],
          outer: { size: [80, 60], center: [40, 30] },
        },
        {
          axis: 'x',
          at: 78.75,
          holeCount: 1,
          slots: [{ center: [30, 15], size: [20, 10] }],
          outer: { size: [60, 30], center: [30, 15] },
        },
        { axis: 'x', at: 1.25, holeCount: 0, outer: { size: [60, 30], center: [30, 15] } },
      ],
      solid: [
        [40, 30, 1.5],
        [1.25, 30, 15],
        [78.75, 10, 15],
      ],
      empty: [
        [40, 30, 15],
        [78.75, 30, 15],
        [6, 6, 1.5],
      ],
    },
  },

  {
    id: 'nut-trap-plate',
    category: 'engineering-constraints',
    prompt:
      'Create a square plate 40 mm × 40 mm × 5 mm thick, one corner at the origin (x 0…40, y 0…40, z 0…5). ' +
      'In the center of the plate add a nut trap for an M5 hex nut: a hexagonal pocket with 8.0 mm across the ' +
      'flats, 4 mm deep from the top face (z 1…5), plus a Ø5.5 mm clearance hole through the remaining ' +
      'thickness so a bolt can pass all the way through. Pocket and hole are concentric at (x=20, y=20).',
    expect: {
      bbox: { min: [0, 0, 0], max: [40, 40, 5] },
      volume: { value: 40 * 40 * 5 - hexArea(8) * 4 - cyl(5.5, 1) },
      shells: 1,
      sections: [
        {
          axis: 'z',
          at: 3,
          holeCount: 1,
          polygons: [{ center: [20, 20], sides: 6, acrossFlats: 8 }],
          outer: { size: [40, 40], center: [20, 20] },
        },
        { axis: 'z', at: 0.5, holeCount: 1, holes: [{ center: [20, 20], d: 5.5 }] },
      ],
      solid: [
        [20, 24.7, 3],
        [20, 23, 0.5],
        [24.7, 20, 3],
      ],
      empty: [
        [20, 20, 3],
        [20, 20, 0.5],
        [20, 23.5, 3],
      ],
    },
  },
);

/* ---------------- hardest tier: oblique features, revolved profiles, patterns, derived modifications ---------------- */

const N_INCL: Vec3 = [10 / Math.hypot(10, 40), 0, 40 / Math.hypot(10, 40)]; // outward normal of the inclined face
const along = (t: number): Vec3 => [20 + t * N_INCL[0], 15, 15 + t * N_INCL[2]];
const RADIAL_INCL: Vec3 = [N_INCL[2], 0, -N_INCL[0]]; // in-plane direction perpendicular to the hole axis (XZ plane)
const offsetRadial = (p: Vec3, d: number): Vec3 => [
  p[0] + d * RADIAL_INCL[0],
  p[1],
  p[2] + d * RADIAL_INCL[2],
];

TASKS.push(
  {
    id: 'inclined-foot',
    category: 'spatial',
    prompt:
      'Create a wedge-shaped foot: footprint 40 mm (X) × 30 mm (Y) with one corner at the origin (x 0…40, ' +
      'y 0…30), bottom face on z = 0. The top face is a single inclined plane that runs from z = 20 at x = 0 ' +
      'down to z = 10 at x = 40 (the end faces at x = 0 and x = 40 are vertical). Drill one Ø6 mm hole ' +
      'perpendicular to the inclined top face, entering at the center of that face (x = 20, y = 15, z = 15) ' +
      'and passing all the way through the part to exit the bottom face.',
    expect: {
      bbox: { min: [0, 0, 0], max: [40, 30, 20] },
      volume: { value: 30 * 40 * 15 - cyl(6, 15 / N_INCL[2]) },
      shells: 1,
      empty: [along(-0.2), along(-2), along(-8), along(-13), [39, 15, 12]],
      solid: [
        offsetRadial(along(-8), 3.6),
        offsetRadial(along(-8), -3.6),
        [along(-8)[0], 18.6, along(-8)[2]],
        [1, 15, 19.5],
        [38, 5, 5],
      ],
    },
  },

  {
    id: 'v-pulley',
    category: 'engineering-constraints',
    prompt:
      'Create a V-belt pulley with its axis on Z: outer diameter 60 mm, overall width 16 mm (z 0…16), and a ' +
      'Ø8 mm bore through the full width. Cut a symmetric V-groove around the circumference, centered at ' +
      'z = 8: the groove is 8 mm wide at the outer diameter (z 4…12 at Ø60) and comes to a sharp bottom at ' +
      'Ø50 (5 mm deep). Both flanks are straight.',
    expect: {
      bbox: { min: [-30, -30, 0], max: [30, 30, 16], tol: 0.2 },
      volume: { value: cyl(60, 16) - 2 * PI * ((30 + 30 + 25) / 3) * (0.5 * 8 * 5) - cyl(8, 16) },
      shells: 1,
      sections: [
        {
          axis: 'z',
          at: 2,
          holeCount: 1,
          holes: [{ center: [0, 0], d: 8 }],
          outer: { d: 60, center: [0, 0], tol: 0.2 },
        },
        { axis: 'z', at: 8, holeCount: 1, outer: { d: 50, center: [0, 0], tol: 0.2 } },
        { axis: 'z', at: 10, holeCount: 1, outer: { d: 55, center: [0, 0], tol: 0.2 } },
        { axis: 'z', at: 14, holeCount: 1, outer: { d: 60, center: [0, 0], tol: 0.2 } },
      ],
      solid: [
        [29, 0, 2],
        [0, 26, 11],
        [24, 0, 8],
      ],
      empty: [
        [27, 0, 8],
        [0, 0, 8],
        [0, 29, 10],
      ],
    },
  },

  {
    id: 'slotted-disc',
    category: 'spatial',
    prompt:
      'Create a disc Ø80 mm × 5 mm thick (z 0…5), centered on the Z axis, with a Ø10 mm central bore. Cut ' +
      '12 identical radial slots through the disc, equally spaced every 30° starting on the +X axis. Each ' +
      'slot is 3 mm wide with fully rounded (semicircular) ends and spans from radius 20 mm to radius 35 mm ' +
      'measured to the extreme ends of the slot (so the end-cap centers sit at radii 21.5 mm and 33.5 mm).',
    expect: {
      bbox: { min: [-40, -40, 0], max: [40, 40, 5], tol: 0.2 },
      volume: { value: cyl(80, 5) - cyl(10, 5) - 12 * (12 * 3 + PI * 1.5 * 1.5) * 5 },
      shells: 1,
      sections: [
        {
          axis: 'z',
          at: 2.5,
          holeCount: 13,
          holes: [{ center: [0, 0], d: 10 }],
          slots: [
            { center: [27.5, 0], size: [15, 3], tol: 0.15 },
            { center: [0, 27.5], size: [3, 15], tol: 0.15 },
            { center: [-27.5, 0], size: [15, 3], tol: 0.15 },
            { center: [0, -27.5], size: [3, 15], tol: 0.15 },
          ],
          outer: { d: 80, center: [0, 0], tol: 0.2 },
        },
      ],
      empty: [
        [27.5 * Math.cos(Math.PI / 6), 27.5 * Math.sin(Math.PI / 6), 2.5],
        [21.5 * Math.cos(Math.PI / 6), 21.5 * Math.sin(Math.PI / 6), 2.5],
        [27.5 * Math.cos(Math.PI / 3), 27.5 * Math.sin(Math.PI / 3), 2.5],
        [27.5 * Math.cos((7 * Math.PI) / 6), 27.5 * Math.sin((7 * Math.PI) / 6), 2.5],
      ],
      solid: [
        [19.5 * Math.cos(Math.PI / 6), 19.5 * Math.sin(Math.PI / 6), 2.5],
        [27.5 * Math.cos(Math.PI / 4), 27.5 * Math.sin(Math.PI / 4), 2.5],
        [37, 0, 2.5],
        [10, 0, 2.5],
      ],
    },
  },

  {
    id: 'bracket-thicken',
    category: 'modification',
    seed: {
      title: 'Shelf bracket',
      path: 'artifacts/mechanical/shelf-bracket.scad',
      scad: [
        '// Shelf bracket — millimetres. Base 60 x 40, vertical plate on the back edge.',
        '$fn = 64;',
        'difference() {',
        '    union() {',
        '        cube([60, 40, 5]);                    // base plate',
        '        translate([0, 35, 0]) cube([60, 5, 45]); // vertical plate, flush with y = 40',
        '    }',
        '    for (x = [15, 45]) translate([x, 17.5, -1]) cylinder(d = 6, h = 7);',
        '}',
        '',
      ].join('\n'),
    },
    prompt:
      'The project contains the mechanical artifact "Shelf bracket" (an L-bracket 5 mm thick). Increase the ' +
      'material thickness to 8 mm for both the base plate and the vertical plate, while keeping the outer ' +
      'envelope exactly the same (60 × 40 × 45 mm: the vertical plate stays flush with the back face at ' +
      'y = 40 and the overall height stays 45), and keep the two Ø6 mm holes at their current positions ' +
      '(x = 15 and x = 45, y = 17.5), still passing through the base plate. Record it as a new revision of ' +
      'the same artifact.',
    expect: {
      bbox: { min: [0, 0, 0], max: [60, 40, 45] },
      volume: { value: 60 * 40 * 8 + 60 * 8 * 37 - 2 * cyl(6, 8) },
      shells: 1,
      sections: [
        {
          axis: 'z',
          at: 4,
          holeCount: 2,
          holes: [
            { center: [15, 17.5], d: 6 },
            { center: [45, 17.5], d: 6 },
          ],
          outer: { size: [60, 40], center: [30, 20] },
        },
        {
          axis: 'z',
          at: 25,
          holeCount: 0,
          outerCount: 1,
          outer: { size: [60, 8], center: [30, 36] },
        },
      ],
      solid: [
        [30, 33, 25],
        [30, 20, 7.5],
      ],
      empty: [
        [30, 31, 25],
        [15, 17.5, 4],
        [30, 20, 8.5],
      ],
    },
  },
);

export function taskById(id: string): Task | undefined {
  return TASKS.find((t) => t.id === id);
}
