import { z } from 'zod';
import { idSchema } from './ids.js';

/**
 * CAD verification vocabulary shared by the agent-facing `cad.check` op and
 * the evaluation suite. Units are model units (millimetres by convention).
 */
// Fixed-length arrays instead of zod tuples: tuple JSON schemas (`items: [...]`)
// are rejected by some model tool-schema validators, which silently drops the tool.
const vec3 = z.array(z.number()).length(3).describe('[x, y, z] in mm');
const vec2 = z.array(z.number()).length(2).describe('[a, b] in the two in-plane axes, in mm');
const axis = z.enum(['x', 'y', 'z']);

export const holeSpecSchema = z.object({
  center: vec2.describe(
    'Hole center in the two in-plane axes (x,y for a z-section; x,z for a y-section; y,z for an x-section).',
  ),
  d: z.number().positive().describe('Expected diameter in model units (mm).'),
  tol: z.number().positive().optional().describe('Linear tolerance (default 0.1 mm).'),
});

/**
 * Short-form hole: a point on the hole axis instead of a cutting plane and a
 * two-dimensional centre. The core expands it into a section, a centre and
 * diameter assertion and an empty-space probe before anything is measured.
 */
export const flatHoleSchema = z.object({
  at: vec3.describe('Point on the hole axis inside the material, e.g. at mid-thickness.'),
  d: z.number().positive().describe('Diameter, mm.'),
  axis: axis.optional().describe('Hole direction (default z).'),
});

export const sectionSpecSchema = z.object({
  axis: axis.describe('Axis normal to the cutting plane.'),
  at: z
    .number()
    .describe(
      'Coordinate of the cutting plane along that axis (pick a plane through the middle of the feature, not on a face).',
    ),
  holes: z
    .array(holeSpecSchema)
    .optional()
    .describe('Circular holes that must appear in this plane.'),
  holeCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Exact number of cut-out loops in this plane (catches missing or extra cuts).'),
  outerCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Exact number of separate material regions in this plane.'),
  slots: z
    .array(z.object({ center: vec2, size: vec2, tol: z.number().positive().optional() }))
    .optional()
    .describe('Non-circular cut-outs (slots, pockets, windows) by bounding-box size and center.'),
  polygons: z
    .array(
      z.object({
        center: vec2,
        sides: z.number().int().min(3),
        acrossFlats: z.number().positive(),
        tol: z.number().positive().optional(),
      }),
    )
    .optional()
    .describe(
      'Regular-polygon cut-outs (e.g. hex nut traps) by side count and across-flats width; orientation-independent.',
    ),
  outer: z
    .object({
      size: vec2.optional().describe('Rectangular outline size in the two in-plane axes.'),
      d: z.number().positive().optional().describe('Circular outline diameter.'),
      center: vec2.optional(),
      tol: z.number().positive().optional(),
    })
    .optional()
    .describe('Shape of the largest material region in this plane.'),
  materialArea: z
    .object({ value: z.number().positive(), tolPct: z.number().positive().optional() })
    .optional()
    .describe('Net material area in the plane (mm²).'),
});

/** The assertion groups `expect` takes at the top level and in each spec item. */
const assertionVocabulary = z.object({
  size: vec3.optional().describe('Overall size [x, y, z] in mm, wherever the part sits.'),
  holes: z
    .array(flatHoleSchema)
    .optional()
    .describe('Round holes by a point on the axis and a diameter (short form of sections).'),
  bodies: z.number().int().positive().optional().describe('Separate bodies; same as shells.'),
  tol: z
    .number()
    .positive()
    .optional()
    .describe('Linear tolerance in mm where an assertion gives none (default 0.1).'),
  bbox: z
    .object({ min: vec3, max: vec3, tol: z.number().positive().optional() })
    .optional()
    .describe('Overall envelope: exact min and max corner in mm (default tolerance 0.1 mm).'),
  volume: z
    .object({ value: z.number().positive(), tolPct: z.number().positive().optional() })
    .optional()
    .describe(
      'Expected solid volume in mm³ (default tolerance 1.5 %, which absorbs polygonal circle approximation).',
    ),
  solid: z.array(vec3).optional().describe('Points (x,y,z) that must lie inside material.'),
  empty: z
    .array(vec3)
    .optional()
    .describe(
      'Points (x,y,z) that must lie in empty space (e.g. hole centers, pockets, outside chamfers).',
    ),
  sections: z
    .array(sectionSpecSchema)
    .optional()
    .describe(
      'Cross-section assertions — the primary way to verify holes, bores, slots and wall outlines.',
    ),
  watertight: z.boolean().optional().describe('Require a closed manifold mesh (default true).'),
  shells: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Expected number of disconnected bodies (1 for a single part).'),
  minRoundness: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Minimum roundness for circular features, apothem/radius (default 0.97 ≈ $fn ≥ 13).'),
  maxSelfIntersections: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Fail if more than this many triangle pairs interpenetrate (0 = no self-intersection). Detects overlapping bodies that still look like a valid bbox/volume.',
    ),
  preserve: z
    .object({
      changeRegions: z
        .array(
          z.object({
            center: vec3.describe('Center of a sphere (mm) that is allowed to change.'),
            radius: z.number().positive().describe('Radius of the allowed-change sphere (mm).'),
          }),
        )
        .describe(
          'Regions where the edit is allowed; everything else must match the approved baseline (or initial draft ancestor).',
        ),
    })
    .optional()
    .describe(
      'Require unrelated geometry to match the approved baseline (or initial draft ancestor) (sampled points outside changeRegions).',
    ),
});

/**
 * Keys of a spec item that carry assertions, in the same form as at the top
 * level of `expect`. The core validates them strictly (cad/spec.rs).
 */
export const SPEC_ITEM_ASSERTION_KEYS = [
  'size',
  'holes',
  'bodies',
  'shells',
  'bbox',
  'volume',
  'solid',
  'empty',
  'sections',
] as const;

/**
 * One requested dimension or feature with the assertions that show it. The
 * assertion keys are declared by their outer type only, to keep the tool
 * listing small; the core checks each one against the full vocabulary above.
 */
export const specItemSchema = z.object({
  item: z
    .string()
    .min(1)
    .max(200)
    .describe("One requested dimension or feature, in the request's words."),
  requirementId: idSchema.optional().describe('Requirement it answers.'),
  size: z.array(z.number()).optional(),
  holes: z.array(z.unknown()).optional(),
  bodies: z.number().optional(),
  shells: z.number().optional(),
  bbox: z.record(z.unknown()).optional(),
  volume: z.record(z.unknown()).optional(),
  solid: z.array(z.unknown()).optional(),
  empty: z.array(z.unknown()).optional(),
  sections: z.array(z.unknown()).optional(),
});

export const expectationSchema = assertionVocabulary.extend({
  spec: z
    .array(specItemSchema)
    .optional()
    .describe(
      'The request item by item, each with its assertions (keys above); an item without one stays partial.',
    ),
});

/** Typing aid: the assertion groups a spec item or a requirement feature carries. */
export const specAssertionsSchema = assertionVocabulary.pick({
  size: true,
  holes: true,
  bodies: true,
  shells: true,
  bbox: true,
  volume: true,
  solid: true,
  empty: true,
  sections: true,
});
export type SpecAssertions = z.infer<typeof specAssertionsSchema>;

export type HoleSpec = z.infer<typeof holeSpecSchema>;
export type FlatHole = z.infer<typeof flatHoleSchema>;

/**
 * Keys of the short form. The core normalises them into the canonical
 * assertions; evidence never contains `holes` or `bodies`.
 */
export const EXPECTATION_SHORT_FORM_KEYS = ['size', 'holes', 'bodies', 'tol'] as const;
/** Keys of `expect` only the Rust host understands: the short form and spec items. */
export const EXPECTATION_RUST_ONLY_KEYS = [...EXPECTATION_SHORT_FORM_KEYS, 'spec'] as const;
export type SectionSpec = z.infer<typeof sectionSpecSchema>;
export type Expectation = z.infer<typeof expectationSchema>;

/* ------------------------------------------------------------------ */
/* cad.check spec items: what the result and the evidence report       */
/* ------------------------------------------------------------------ */

/**
 * `passed`, `failed` or `unasserted` (nothing in the check shows it; it keeps
 * the check partial). `not_shown` is a linked requirement no geometry check
 * shows: it never blocks and never passes.
 */
export type CadSpecItemState = 'passed' | 'failed' | 'unasserted' | 'not_shown';

export interface CadSpecItemResult {
  /** The item's words, or the title of a requirement row. */
  item: string;
  /** `listed`: in the check's own list. `requirement`: from a linked requirement. */
  from: 'listed' | 'requirement';
  requirementId?: string;
  /** The row standing for a linked requirement that has no features. */
  statement?: true;
  state: CadSpecItemState;
  /** Names of the check lines that measured this row. */
  checks: string[];
  /** Why no check shows a `not_shown` row. */
  reason?: string;
  /**
   * Whose assertions show a requirement row that has some: `requirement`, the requirement's own
   * (taken when it is linked to this part alone); `listed`, ones listed for it in the check.
   */
  assertedBy?: 'requirement' | 'listed';
}

export interface CadSpecRequirement {
  artifactId: string;
  revisionId: string;
  title: string;
  priority: 'must' | 'should' | 'could';
  /** Review state of the requirement revision the check read. */
  review: 'approved' | 'in_review' | 'draft';
  /** How the requirement reached the check: a revision input, an edge, or named by the check. */
  via: ('input' | 'edge' | 'check' | 'item')[];
  /** Whether a person or an agent made the link. */
  linkedBy: 'person' | 'agent';
  /** `features` and `statement` give rows that block; `advice` rows never do. */
  kind: 'features' | 'statement' | 'advice';
  /** Hash of what the check derived from the requirement. */
  derivedHash: string;
}

export interface CadSpecCounts {
  items: number;
  passed: number;
  failed: number;
  unasserted: number;
  notShown: number;
  /** Rows that keep the check from passing: the unasserted ones. */
  blocking: number;
}

/** `spec` of a cad_check result and of its evidence. */
export interface CadSpecReport {
  /** Who listed the check's own items: the agent session or a person. */
  listedBy: 'agent' | 'person';
  items: CadSpecItemResult[];
  requirements: CadSpecRequirement[];
  counts: CadSpecCounts;
  /**
   * Committed assertions that requirements changed since replace, in words; present only when the
   * check changed the committed scope. Only a person accepts them.
   */
  replaced?: string[];
  /** With `replaced`: the scope changes the check made itself, which repeating the scope restores. */
  checkChanges?: string[];
}

/** How a linked requirement stands against the committed check. */
export type CadSpecLinkChange = 'not_considered' | 'linked_after' | 'revised';

/** `spec` of a verification read: gaps of the recorded report, and links made since. */
export interface CadSpecReadiness {
  counts: CadSpecCounts;
  /** The first rows without an assertion (at most 10; counts.unasserted has them all). */
  missing: { item: string; requirementId?: string; statement?: true }[];
  /** Linked requirements the committed check does not show as they stand (at most 10). */
  linkedSince: {
    requirementId: string;
    revisionId: string;
    title: string;
    change: CadSpecLinkChange;
    kind?: 'features' | 'statement';
    /** A statement requirement's target as it stands, e.g. `25 mm`. */
    target?: string;
  }[];
  linkedSinceCount: number;
  /** Rows without an assertion plus requirements linked or changed since. */
  blocking: number;
  /** Why no check of the part can run: linked requirements state one assertion differently. */
  conflict?: string;
}
