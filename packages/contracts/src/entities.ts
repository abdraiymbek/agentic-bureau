import { z } from 'zod';
import { idSchema, revisionRefSchema, type RevisionRef } from './ids.js';
import { maybeQuantitySchema, moneySchema, quantitySchema } from './units.js';

/* ------------------------------------------------------------------ */
/* Enums: three independent dimensions — review, freshness, evidence.  */
/* ------------------------------------------------------------------ */

export const reviewStates = ['draft', 'proposed', 'approved', 'rejected', 'superseded'] as const;
export const reviewStateSchema = z.enum(reviewStates);
export type ReviewState = z.infer<typeof reviewStateSchema>;

export const freshnessStates = ['current', 'stale', 'missing_input'] as const;
export const freshnessSchema = z.enum(freshnessStates);
export type Freshness = z.infer<typeof freshnessSchema>;

export const evidenceKinds = ['assumed', 'sourced', 'calculated', 'simulated', 'measured'] as const;
export const evidenceKindSchema = z.enum(evidenceKinds);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

export const relationships = [
  'depends_on',
  'derived_from',
  'validates',
  'connects_to',
  'belongs_to',
  'alternative_to',
] as const;
export const relationshipSchema = z.enum(relationships);
export type Relationship = z.infer<typeof relationshipSchema>;

/** Relationships that propagate freshness and must remain acyclic. */
export const EVAL_RELATIONSHIPS: Relationship[] = ['depends_on', 'derived_from', 'validates'];

/* ------------------------------------------------------------------ */
/* Artifact type payloads                                               */
/* ------------------------------------------------------------------ */

export const artifactTypes = [
  'requirement',
  'assumption',
  'architecture',
  'concept',
  'component',
  'source',
  'mechanical',
  'wiring',
  'calculation',
  'software',
  'assembly',
  'test',
  'note',
  'subsystem',
] as const;
export const artifactTypeSchema = z.enum(artifactTypes);
export type ArtifactType = z.infer<typeof artifactTypeSchema>;

const fileRefSchema = z.object({
  /** Project-relative path. */
  path: z.string(),
  sha256: z.string().length(64).optional(),
  role: z.enum(['source', 'output', 'import', 'preview', 'attachment']).default('source'),
});
export type FileRef = z.infer<typeof fileRefSchema>;

const sourcedQuantity = z.object({
  quantity: maybeQuantitySchema,
  sourceId: idSchema.optional(),
  locator: z.string().optional(),
  observedAt: z.string().optional(),
});

/**
 * One dimension or feature a requirement asks of a part. A part linked to the
 * requirement is checked for it: the feature becomes an item of every
 * cad_check of the part, with `expect` as its assertions when the requirement
 * links that one part only; without them it stays unasserted until a check
 * gives it some.
 */
export const requirementFeatureSchema = z.object({
  label: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'The dimension or feature in the words of the requirement, e.g. "Groove bottom Ø50 mm".',
    ),
  quantity: maybeQuantitySchema.optional().describe('The value it states, with its unit.'),
  expect: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'cad_check assertions that show it (size, holes, bodies, bbox, volume, solid, empty, sections), in the frame of the part.',
    ),
});
export type RequirementFeature = z.infer<typeof requirementFeatureSchema>;

export const requirementPayload = z.object({
  statement: z.string(),
  target: maybeQuantitySchema.optional(),
  acceptanceCriterion: z.string(),
  priority: z.enum(['must', 'should', 'could']).default('should'),
  sourceId: idSchema.optional(),
  verification: z.string().optional(),
  features: z
    .array(requirementFeatureSchema)
    .optional()
    .describe('The dimensions and features a linked part must show, one per entry.'),
});
export type RequirementPayload = z.infer<typeof requirementPayload>;

export const assumptionPayload = z.object({
  statement: z.string(),
  value: maybeQuantitySchema.optional(),
  reason: z.string(),
  uncertainty: z.string().optional(),
  owner: z.string(),
  needsValidation: z.boolean().default(true),
});
export type AssumptionPayload = z.infer<typeof assumptionPayload>;

export const architecturePayload = z.object({
  markdown: z.string(),
  diagramSvg: z.string().optional(),
});
export const conceptPayload = z.object({
  description: z.string(),
  systems: z.array(z.string()).default([]),
  approxDimensions: z.record(z.string(), quantitySchema).default({}),
  alternatives: z.array(z.string()).default([]),
  uncertainties: z.array(z.string()).default([]),
  visualFile: fileRefSchema.optional(),
  visualKind: z.enum(['svg_diagram', 'openscad_layout', 'generated_bitmap']).optional(),
});
export type ConceptPayload = z.infer<typeof conceptPayload>;

export const offerSchema = z.object({
  id: idSchema,
  seller: z.string(),
  url: z.string().optional(),
  price: moneySchema.nullable(),
  quantityBasis: z.number().positive().default(1),
  availabilityText: z.string().optional(),
  observedAt: z.string(),
  sourceId: idSchema.optional(),
});
export type Offer = z.infer<typeof offerSchema>;

export const componentPayload = z.object({
  manufacturer: z.string().optional(),
  vendor: z.string().optional(),
  partNumber: z.string(),
  description: z.string().optional(),
  imageUrl: z
    .string()
    .url()
    .regex(/^https?:\/\//)
    .optional(),
  selectionReason: z.string().optional(),
  /** Engineering properties keyed by name; each carries provenance. */
  properties: z.record(z.string(), sourcedQuantity).default({}),
  /** Free-form sourced facts (interface, protocol, mounting pattern…). */
  attributes: z
    .record(
      z.string(),
      z.object({
        value: z.string(),
        sourceId: idSchema.optional(),
        locator: z.string().optional(),
      }),
    )
    .default({}),
  status: z.enum(['candidate', 'selected', 'rejected', 'superseded']).default('candidate'),
  missingFields: z.array(z.string()).default([]),
});
export type ComponentPayload = z.infer<typeof componentPayload>;

export const sourcePayload = z.object({
  kind: z.enum(['url', 'file']),
  url: z.string().optional(),
  fileHash: z.string().optional(),
  title: z.string(),
  publisher: z.string().optional(),
  retrievedAt: z.string(),
  locator: z.string().optional(),
  excerpt: z.string().optional(),
  sourceKind: z
    .enum(['manufacturer', 'supplier', 'datasheet', 'article', 'user_import', 'note', 'other'])
    .default('other'),
});
export type SourcePayload = z.infer<typeof sourcePayload>;

export const mechanicalPayload = z.object({
  scad: fileRefSchema.optional(),
  stl: fileRefSchema.optional(),
  params: z
    .record(z.string(), z.union([quantitySchema, z.number(), z.string(), z.boolean()]))
    .default({}),
  paramManifest: z
    .array(
      z.object({
        name: z.string(),
        unit: z.string().optional(),
        dimension: z.enum(['length', 'angle', 'count', 'boolean', 'text', 'number']).optional(),
        description: z.string().optional(),
      }),
    )
    .default([]),
  modelUnit: z.string().default('mm'),
  bounds: z
    .object({
      min: z.tuple([z.number(), z.number(), z.number()]),
      max: z.tuple([z.number(), z.number(), z.number()]),
    })
    .optional(),
  material: z.string().optional(),
  manufacturing: z.string().optional(),
  renderJobId: idSchema.optional(),
  /** Additive evidence identity; older projects remain readable but need a fresh render. */
  renderIdentity: z
    .object({
      version: z.literal(1),
      sourceHash: z.string(),
      params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
      modelUnit: z.string(),
      frame: z.literal('right-handed-z-up'),
      engine: z.string(),
      engineVersion: z.string(),
      options: z.string(),
      inputFingerprint: z.string(),
      outputHash: z.string(),
      /** Display normalization must not hide inverted geometry from the source. */
      sourceOrientationCorrected: z.boolean().optional(),
    })
    .optional(),
});
export type MechanicalPayload = z.infer<typeof mechanicalPayload>;

export const pinSchema = z.object({
  componentArtifactId: idSchema,
  componentRevisionId: idSchema.optional(),
  pin: z.string().describe('Pin label as printed on the part or its datasheet, e.g. "GND".'),
  name: z.string().optional(),
  type: z
    .enum(['power', 'ground', 'signal', 'data', 'mechanical', 'unknown'])
    .default('unknown')
    .describe('Electrical role. The ground-return check needs power and ground pins typed.'),
  voltageRange: z
    .object({ min: quantitySchema, max: quantitySchema })
    .optional()
    .describe('Allowed voltage as two quantities, e.g. min {"value": 4.5, "unit": "V"}.'),
});
export type Pin = z.infer<typeof pinSchema>;

const connectionEndSchema = z.object({
  componentArtifactId: idSchema,
  /** Filled in by the server when left out: the approved revision, else the newest. */
  componentRevisionId: idSchema.optional(),
  pin: z.string(),
});

export const connectionSchema = z.object({
  /** Assigned by the server when left out. */
  id: idSchema
    .optional()
    .describe('Leave it out: one is assigned. Send an id only to keep an existing connection.'),
  from: connectionEndSchema.describe(
    'End it starts at: componentArtifactId and the pin label. componentRevisionId is optional and defaults to the approved revision of the component, else its newest.',
  ),
  to: connectionEndSchema.describe('End it goes to, same shape as from.'),
  voltage: quantitySchema.optional().describe('Nominal voltage, e.g. {"value": 5, "unit": "V"}.'),
  signalRole: z.string().describe('What it carries, e.g. "power", "ground", "PWM", "UART TX".'),
  polarity: z.enum(['+', '-', 'bidirectional', 'none']).optional(),
  wire: z
    .object({ gauge: z.string().optional(), currentRating: quantitySchema.optional() })
    .optional()
    .describe('Wire gauge, e.g. "22 AWG", and its current rating as a quantity.'),
  notes: z.string().optional(),
});
type ConnectionInput = z.infer<typeof connectionSchema>;
type ConnectionEnd = ConnectionInput['from'] & { componentRevisionId: string };
/** A recorded connection: the id and both component revisions are always present. */
export type WiringConnection = Omit<ConnectionInput, 'id' | 'from' | 'to'> & {
  id: string;
  from: ConnectionEnd;
  to: ConnectionEnd;
};

export const wiringPayload = z.object({
  pins: z.array(pinSchema).default([]),
  connections: z.array(connectionSchema).default([]),
  coverageNote: z.string().optional(),
});
export type WiringPayload = Omit<z.infer<typeof wiringPayload>, 'connections'> & {
  connections: WiringConnection[];
};

export const calculationInputSchema = z.object({
  name: z.string(),
  quantity: maybeQuantitySchema,
  /** Where the value came from — exact revision reference or literal. */
  sourceRef: revisionRefSchema.optional(),
  literal: z.boolean().default(false),
});

export const calculationPayload = z.object({
  templateId: z.string().optional(),
  expression: z.string().optional(),
  inputs: z.array(calculationInputSchema).default([]),
  assumptions: z.array(z.string()).default([]),
  result: z
    .object({
      quantity: maybeQuantitySchema.optional(),
      text: z.string().optional(),
    })
    .optional(),
  /** Unit the caller declared for the result. Absent when the unit was derived. */
  outputUnit: z.string().optional(),
  limitations: z.array(z.string()).default([]),
  toolVersion: z.string().optional(),
  ranAt: z.string().optional(),
  /**
   * Set to 'calculated' by calculation.run. Nothing fills it in for a payload
   * written by hand: a result is calculated only when the engine computed it.
   */
  evidenceKind: evidenceKindSchema.optional(),
});
export type CalculationPayload = z.infer<typeof calculationPayload>;

export const softwarePayload = z.object({
  files: z.array(fileRefSchema).default([]),
  language: z.string().optional(),
  entryPoint: z.string().optional(),
  notes: z.string().optional(),
});
export type SoftwarePayload = z.infer<typeof softwarePayload>;

export const assemblyStepSchema = z.object({
  order: z.number().int().positive(),
  instruction: z.string(),
  componentRefs: z.array(idSchema).default([]),
  tools: z.array(z.string()).default([]),
  calibration: z.string().optional(),
});
export const assemblyPayload = z.object({
  steps: z.array(assemblyStepSchema).default([]),
});
export type AssemblyPayload = z.infer<typeof assemblyPayload>;

export const testResultSchema = z.object({
  id: idSchema,
  requirementRef: revisionRefSchema.optional(),
  evidenceKind: evidenceKindSchema,
  observation: z.string(),
  result: z.enum(['planned', 'not_run', 'passed', 'failed', 'inconclusive']),
  conditions: z.string().optional(),
  units: z.string().optional(),
  attachments: z.array(fileRefSchema).default([]),
  recordedBy: z.string(),
  recordedAt: z.string(),
  /** Originating file/device/person for imported measurements. */
  measurementOrigin: z.string().optional(),
});
export type TestResult = z.infer<typeof testResultSchema>;

export const testPayload = z.object({
  procedure: z
    .array(
      z.object({
        step: z.number().int(),
        instruction: z.string(),
        expected: z.string().optional(),
      }),
    )
    .default([]),
  conditions: z.string().optional(),
  results: z.array(testResultSchema).default([]),
});
export type TestPayload = z.infer<typeof testPayload>;

export const notePayload = z.object({ markdown: z.string() });
export const subsystemPayload = z.object({ description: z.string().default('') });

export const artifactPayloadSchemas: Record<ArtifactType, z.ZodTypeAny> = {
  requirement: requirementPayload,
  assumption: assumptionPayload,
  architecture: architecturePayload,
  concept: conceptPayload,
  component: componentPayload,
  source: sourcePayload,
  mechanical: mechanicalPayload,
  wiring: wiringPayload,
  calculation: calculationPayload,
  software: softwarePayload,
  assembly: assemblyPayload,
  test: testPayload,
  note: notePayload,
  subsystem: subsystemPayload,
};

export function validatePayload(type: ArtifactType, payload: unknown): unknown {
  const schema = artifactPayloadSchemas[type] as z.ZodObject<z.ZodRawShape>;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const keys = Object.keys(payload);
    if (keys.length && !keys.some((key) => key in schema.shape)) {
      throw new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: [],
          message: `No recognized ${type} fields. Call tool_describe with artifactType="${type}" for the payload schema. Expected: ${Object.keys(schema.shape).join(', ')}`,
        },
      ]);
    }
  }
  return schema.parse(payload);
}

/* ------------------------------------------------------------------ */
/* Records                                                              */
/* ------------------------------------------------------------------ */

export const artifactSchema = z.object({
  id: idSchema,
  type: artifactTypeSchema,
  title: z.string(),
  subsystem: z.string().nullable(),
  selectedRevisionId: idSchema.nullable(),
  archived: z.boolean(),
  createdAt: z.string(),
});
export type Artifact = z.infer<typeof artifactSchema>;

/** Recorded input: an upstream revision this revision consumed. */
export const recordedInputSchema = z.object({
  artifactId: idSchema,
  revisionId: idSchema,
  relationship: relationshipSchema.default('depends_on'),
  label: z.string().optional(),
});
export type RecordedInput = z.infer<typeof recordedInputSchema>;

export const revisionSchema = z.object({
  id: idSchema,
  artifactId: idSchema,
  parentId: idSchema.nullable(),
  seq: z.number().int(),
  origin: z.enum(['user', 'agent', 'system']),
  originDetail: z.string().nullable(),
  createdAt: z.string(),
  payload: z.unknown(),
  /** Engineering-content hash — excludes title/presentational metadata. */
  contentHash: z.string().length(64),
  files: z.array(fileRefSchema).default([]),
  inputs: z.array(recordedInputSchema).default([]),
  rationale: z.string().default(''),
  reviewState: reviewStateSchema,
});
export type Revision = z.infer<typeof revisionSchema>;

export const proposedChangeSchema = z.object({
  artifactId: idSchema,
  baseRevisionId: idSchema
    .nullable()
    .optional()
    .describe('Currently approved revision of the artifact. Omit or null when it has none.'),
  newRevisionId: idSchema.describe('Draft revision the human is asked to approve.'),
  kind: z
    .enum(['baseline_update', 'new_artifact', 'component_selection', 'bom_edit', 'archive'])
    .describe(
      'new_artifact when the artifact has no approved revision yet, baseline_update when it has. The other kinds are made by component_propose_selection and bom_propose_edit.',
    ),
  /** For component_selection: artifact being replaced. */
  replacesArtifactId: idSchema.optional(),
  /** For bom_edit / component_selection: BOM lines to apply. */
  bomLines: z
    .array(
      z.object({
        componentArtifactId: idSchema,
        componentRevisionId: idSchema,
        subsystem: z.string().nullable(),
        quantity: z.number().positive(),
        offerId: idSchema.nullable(),
        location: z.string().nullable(),
        notes: z.string().default(''),
      }),
    )
    .optional(),
  /** For bom_edit: line ids to remove. */
  removeBomLineIds: z.array(idSchema).optional(),
});
export type ProposedChange = z.infer<typeof proposedChangeSchema>;

export const proposalSchema = z.object({
  id: idSchema,
  changes: z.array(proposedChangeSchema),
  reason: z.string(),
  impact: z
    .object({
      affectedArtifactIds: z.array(idSchema),
      summary: z.string(),
      supersedesProposalIds: z.array(idSchema).optional(),
      supersededByProposalId: idSchema.optional(),
    })
    .optional(),
  state: z.enum([
    'pending',
    'accepted',
    'rejected',
    'changes_requested',
    'conflicted',
    'cancelled',
    'superseded',
  ]),
  createdBy: z.enum(['user', 'agent', 'system']),
  createdBySession: idSchema.nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolutionRationale: z.string().nullable(),
});
export type Proposal = z.infer<typeof proposalSchema>;

export const decisionSchema = z.object({
  id: idSchema,
  proposalId: idSchema.nullable(),
  action: z.enum(['accepted', 'rejected', 'superseded', 'direct_edit', 'revert']),
  actor: z.string(),
  ts: z.string(),
  rationale: z.string(),
  priorBaseline: z.array(revisionRefSchema),
  newBaseline: z.array(revisionRefSchema),
  eventSeq: z.number().int(),
});
export type Decision = z.infer<typeof decisionSchema>;

export const edgeSchema = z.object({
  id: idSchema,
  upstreamArtifactId: idSchema,
  downstreamArtifactId: idSchema,
  relationship: relationshipSchema,
  /** Pinned upstream revision; null = track selected revision. */
  requiredUpstreamRevisionId: idSchema.nullable(),
  label: z.string().default(''),
  createdBy: z.enum(['user', 'agent', 'system']),
  createdAt: z.string(),
});
export type Edge = z.infer<typeof edgeSchema>;

export const bomLineSchema = z.object({
  id: idSchema,
  componentArtifactId: idSchema,
  componentRevisionId: idSchema,
  subsystem: z.string().nullable(),
  quantity: z.number().positive(),
  offerId: idSchema.nullable(),
  location: z.string().nullable(),
  notes: z.string().default(''),
});
export type BomLine = z.infer<typeof bomLineSchema>;

export const jobStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const jobSchema = z.object({
  id: idSchema,
  kind: z.string(),
  tool: z.string(),
  toolVersion: z.string().nullable(),
  inputs: z.unknown(),
  inputHashes: z.record(z.string(), z.string()).default({}),
  command: z.string().nullable(),
  status: jobStatusSchema,
  log: z.string(),
  outputHashes: z.record(z.string(), z.string()).default({}),
  error: z.unknown().nullable(),
  sessionId: idSchema.nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type Job = z.infer<typeof jobSchema>;

export const eventSchema = z.object({
  seq: z.number().int(),
  id: idSchema,
  type: z.string(),
  origin: z.enum(['user', 'agent', 'system']),
  ts: z.string(),
  data: z.unknown(),
  /** Project the event belongs to. Set on delivery by the Rust host; not stored with the event. */
  projectId: idSchema.optional(),
});
export type ProjectEvent = z.infer<typeof eventSchema>;

export const staleRecordSchema = z.object({
  artifactId: idSchema,
  upstreamArtifactId: idSchema,
  expectedRevisionId: idSchema.nullable(),
  actualRevisionId: idSchema.nullable(),
  /** Chain of artifact ids from the changed input to this artifact. */
  path: z.array(idSchema),
  reason: z.enum(['input_changed', 'missing_input']),
  sinceEventSeq: z.number().int(),
});
export type StaleRecord = z.infer<typeof staleRecordSchema>;

export const projectSchema = z.object({
  id: idSchema,
  name: z.string(),
  intent: z.string(),
  unitsPref: z.string().default('si'),
  currencyPref: z.string().default('USD'),
  schemaVersion: z.number().int(),
  createdAt: z.string(),
});
export type Project = z.infer<typeof projectSchema>;

/* ------------------------------------------------------------------ */
/* Composite views                                                     */
/* ------------------------------------------------------------------ */

export interface ArtifactView {
  artifact: Artifact;
  revision: Revision | null;
  freshness: Freshness;
  staleReasons: StaleRecord[];
  draftCount: number;
  pendingProposal: boolean;
  /** Newest revision still in play, including unapproved work. Optional for older hosts. */
  head?: { id: string; seq: number; reviewState: ReviewState } | null;
}

export interface ImpactPath {
  from: RevisionRef;
  path: { artifactId: string; relationship: Relationship; label: string }[];
  affectedArtifactId: string;
  reason: string;
}

export interface ImpactReport {
  changedRefs: RevisionRef[];
  affected: {
    artifactId: string;
    title: string;
    type: ArtifactType;
    reason: string;
    /** Ordered path; long paths retain the first and last 16 nodes. */
    path: string[];
    pathTruncated?: boolean;
    fullPathLength?: number;
  }[];
  unaffectedSelectedComponentIds: string[];
  totalAffected?: number;
  hasMore?: boolean;
  offset?: number;
}
