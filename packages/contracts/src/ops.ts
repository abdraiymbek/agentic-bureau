import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  artifactTypeSchema,
  artifactPayloadSchemas,
  type ArtifactType,
  connectionSchema,
  evidenceKindSchema,
  pinSchema,
  proposedChangeSchema,
  relationshipSchema,
} from './entities.js';
import { idSchema, revisionRefSchema } from './ids.js';
import { expectationSchema } from './cad.js';
import { profileSettingSchema } from './session.js';
import { maybeQuantitySchema, moneySchema, quantitySchema } from './units.js';

/**
 * Capability levels. `user` ops are never exposed to agent sessions;
 * `both` ops are shared. The bridge enforces this on every call.
 */
export type Capability = 'user' | 'both';

/**
 * Smallest capability profile that lists an agent tool: `compact` lists
 * `core`, `standard` adds `standard`, `full` lists every agent tool. Every
 * agent-allowed op stays callable in every profile through `tool_call`.
 */
export const opTiers = ['core', 'standard', 'full'] as const;
export type OpTier = (typeof opTiers)[number];

/** Group an op is catalogued under by `tool_describe`. */
export const opPacks = [
  'core',
  'cad',
  'parts',
  'wiring',
  'analysis',
  'graph',
  'review',
  'files',
  'ui',
  'system',
] as const;
export type OpPack = (typeof opPacks)[number];

export interface OpDef {
  name: string;
  /** Name the op is listed under as an agent tool: the op name with `_` for `.`. */
  toolName: string;
  input: z.ZodTypeAny;
  capability: Capability;
  /** True for ops that mutate project state (require idempotency key). */
  mutating: boolean;
  /** What the op does, when to use it and what it returns. Names other tools by tool name. */
  description: string;
  /**
   * False for ops that remain callable (CLI, GUI, `omenflow call`) but are
   * not listed as agent tools because a clearer tool supersedes them.
   * Keeps the agent's tool vocabulary small and unambiguous.
   */
  agentVisible: boolean;
  tier: OpTier;
  pack: OpPack;
  /** One imperative line of at most 90 characters, for catalogues and the compact listing. */
  summary: string;
  /** Minimal valid input, or null. Returned by `tool_describe` and with validation errors. */
  example: Record<string, unknown> | null;
  /**
   * Listing overlay for the compact profile: the same field names as `input`
   * with fewer optional fields. Presentation only; calls are always validated
   * against `input`.
   */
  compactSchema: z.ZodTypeAny | null;
}

const idem = {
  idempotencyKey: z
    .string()
    .optional()
    .describe('Optional; reuse the same key only when retrying the identical call.'),
};

/** Ids used in examples. They are well-formed placeholders: real ids come from earlier results. */
const EX = {
  artifact: '00000000-0000-4000-8000-000000000001',
  revision: '00000000-0000-4000-8000-000000000002',
  otherArtifact: '00000000-0000-4000-8000-000000000003',
  otherRevision: '00000000-0000-4000-8000-000000000004',
  thirdArtifact: '00000000-0000-4000-8000-000000000005',
  source: '00000000-0000-4000-8000-000000000007',
  proposal: '00000000-0000-4000-8000-000000000008',
};

/* ------------------------------- project ------------------------------- */

const projectCreate = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  intent: z.string().default(''),
});
const projectOpen = z.object({ path: z.string().min(1) });
const projectRename = z.object({ name: z.string().min(1) });
const projectSummary = z.object({
  budget: z
    .number()
    .int()
    .positive()
    .default(6000)
    .describe('Size cap in characters. Lists are cut to fit and truncated is set to true.'),
});
const projectSearch = z.object({
  query: z.string().min(1).describe('Words to look for in artifact titles and content.'),
  limit: z.number().int().positive().max(100).default(20).describe('Maximum number of matches.'),
});
const projectChangesSince = z.object({
  seq: z
    .number()
    .int()
    .nonnegative()
    .describe('Return events after this sequence number: 0 at first, then the last nextCursor.'),
});
const projectExportArchive = z.object({
  destPath: z.string().min(1),
  includeTerminalHistory: z.boolean().default(false),
  grantTerminalExportConsent: z.boolean().default(false),
});
const projectImportArchive = z.object({
  archivePath: z.string().min(1),
  destDir: z.string().min(1),
  newIdentity: z.boolean().default(false),
});
const projectUpdateIntent = z.object({ intent: z.string() });
const projectCoverage = z.object({});

/* ------------------------------- artifact ------------------------------ */

const fileInput = z.object({
  path: z.string(),
  contentBase64: z.string().optional(),
  sourcePath: z.string().optional(),
});
const FILES_SHAPE =
  'each {path, contentBase64 or sourcePath}: path is project-relative, sourcePath an existing project file to copy';
const inputLink = z.object({
  artifactId: idSchema,
  revisionId: idSchema.optional(),
  relationship: relationshipSchema.optional(),
  label: z.string().optional(),
});
const INPUTS_SHAPE =
  'each {artifactId, relationship}: relationship defaults to depends_on, revisionId to the current revision';

const artifactList = z.object({
  type: artifactTypeSchema.optional().describe('Only artifacts of this type.'),
  subsystem: z.string().optional().describe('Only artifacts in this subsystem.'),
  includeArchived: z.boolean().default(false).describe('Also list archived artifacts.'),
  limit: z.number().int().positive().max(500).default(200).describe('Page size.'),
  offset: z.number().int().nonnegative().default(0).describe('Artifacts to skip, for paging.'),
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe('nextCursor of the previous page. Continues the listing; replaces offset.'),
  fields: z
    .enum(['full', 'summary'])
    .optional()
    .describe(
      'summary (the default for agents): headers and state without payloads. full: each approved revision with payload, files and inputs.',
    ),
});
const artifactRead = z.object({
  artifactId: idSchema.describe('Artifact id, from artifact_list or an earlier result.'),
  revisionId: idSchema
    .optional()
    .describe('Revision to read. Defaults to the approved one, or the newest when none is.'),
  detail: z
    .enum(['brief', 'full'])
    .optional()
    .describe(
      'brief (the default for agents): open drafts only, long text shortened. full: every draft and the complete text.',
    ),
});
const artifactHistory = z.object({
  artifactId: idSchema.describe('Artifact to list revisions of.'),
  fields: z
    .enum(['full', 'summary'])
    .optional()
    .describe(
      'summary: revision headers without payload, files or inputs. Omit for full revisions.',
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe('Revisions per page. Omit both limit and cursor for the complete history.'),
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe(
      'nextCursor of the previous history page. Continues after that revision; defaults limit to 200.',
    ),
});
const artifactCompare = z.object({
  artifactId: idSchema.describe('Artifact both revisions belong to.'),
  fromRevisionId: idSchema.describe('Revision to compare from (the "before").'),
  toRevisionId: idSchema.describe('Revision to compare to (the "after").'),
});
const artifactCreateDraft = z.object({
  type: artifactTypeSchema.describe(
    'Artifact type. Electrical work is "wiring". Parts are made with cad_write_source, not here.',
  ),
  title: z.string().min(1).describe('Short name shown in the workspace, e.g. "Payload capacity".'),
  subsystem: z
    .string()
    .nullable()
    .optional()
    .describe('Subsystem to group the artifact under. Omit for none.'),
  payload: z
    .unknown()
    .describe(
      'Structured fields for this artifact type, as an object. Call tool_describe with artifactType to get the exact payload schema before authoring. Quantities are {value, unit}; an unknown value is {"unknown": true, "reason": "…"}. Prose in an unrecognized field is not rendered.',
    ),
  files: z.array(fileInput).default([]).describe(`Files to attach, ${FILES_SHAPE}.`),
  inputs: z
    .array(inputLink)
    .default([])
    .describe(`Upstream artifacts this one uses, ${INPUTS_SHAPE}.`),
  rationale: z.string().default('').describe('One line on what this draft is for.'),
  ...idem,
});
const artifactUpdateDraft = z.object({
  artifactId: idSchema.describe('Artifact to revise.'),
  /** Required when artifact already has a baseline — the draft must build on it. */
  baseRevisionId: idSchema
    .optional()
    .describe('Approved revision you started from. The call fails if it is no longer current.'),
  draftRevisionId: idSchema
    .optional()
    .describe('Draft to continue from. Defaults to the approved revision, else the newest draft.'),
  title: z.string().optional().describe('New title. Omit to keep the current one.'),
  payload: z
    .unknown()
    .optional()
    .describe(
      'Complete payload for the artifact type, as an object. It replaces the previous payload. Omit to keep the previous one.',
    ),
  files: z
    .array(fileInput)
    .optional()
    .describe(`Replaces the attached files, ${FILES_SHAPE}. Omit to keep them.`),
  inputs: z
    .array(inputLink)
    .optional()
    .describe(`Replaces the upstream links, ${INPUTS_SHAPE}. Omit to keep them.`),
  rationale: z.string().optional().describe('One line on what this revision changes and why.'),
  ...idem,
});
const artifactImportFile = z.object({
  artifactId: idSchema
    .optional()
    .describe('Artifact to attach the file to. Omit to create a new artifact.'),
  type: artifactTypeSchema.optional().describe('Type of the new artifact; needed with title.'),
  title: z.string().optional().describe('Title of the new artifact; needed with type.'),
  path: z.string().min(1).describe('Path of a file inside the project folder.'),
  rationale: z.string().default('').describe('One line on why the file is attached.'),
  ...idem,
});
/** User-only: accept an existing draft revision as baseline (implicit approve). */
const artifactAcceptDraft = z.object({
  artifactId: idSchema,
  draftRevisionId: idSchema,
  rationale: z.string().default(''),
  verificationEvidenceHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  ...idem,
});
/** User-only direct baseline edit. Agents receive APPROVAL_REQUIRED. */
const artifactApplyEdit = z.object({
  artifactId: idSchema,
  baseRevisionId: idSchema,
  title: z.string().optional(),
  payload: z.unknown().optional(),
  /** Shallow-merged into payload (convenience for single-field edits). */
  payloadPatch: z.record(z.unknown()).optional(),
  /** File writes merged onto the parent's file list by path. */
  fileWrites: z.array(z.object({ path: z.string(), contentBase64: z.string() })).optional(),
  rationale: z.string().default(''),
  ...idem,
});
const artifactRevert = z.object({
  artifactId: idSchema,
  toRevisionId: idSchema,
  rationale: z.string().default(''),
  ...idem,
});
const artifactArchive = z.object({ artifactId: idSchema, archived: z.boolean(), ...idem });
const artifactReveal = z.object({ artifactId: idSchema });
/** Read a file that belongs to an artifact revision (project-scoped). */
const artifactReadFile = z.object({
  artifactId: idSchema.describe('Artifact the file is attached to.'),
  path: z.string().min(1).describe('Project-relative path, as listed in the revision files.'),
  revisionId: idSchema.optional().describe('Revision to read from. Defaults to the current one.'),
});
const artifactSetSubsystem = z.object({
  artifactId: idSchema,
  subsystem: z.string().nullable(),
  ...idem,
});

/* ------------------------------- graph --------------------------------- */

const graphNeighbors = z.object({
  artifactId: idSchema.describe('Artifact to start from.'),
  direction: z
    .enum(['upstream', 'downstream', 'both'])
    .default('both')
    .describe('upstream: what it depends on. downstream: what depends on it.'),
  depth: z.number().int().positive().max(10).default(1).describe('How many links to follow.'),
  relationship: relationshipSchema.optional().describe('Follow only links of this kind.'),
});
const graphImpact = z.object({
  refs: z
    .array(revisionRefSchema)
    .min(1)
    .describe('Changed revisions, each as {artifactId, revisionId}.'),
  limit: z.number().int().positive().max(2000).default(200).describe('Page size.'),
  offset: z.number().int().nonnegative().default(0).describe('Affected artifacts to skip.'),
  includePaths: z
    .boolean()
    .default(true)
    .describe('Include the dependency path from the change to each affected artifact.'),
});
const graphProposeEdges = z.object({
  edges: z
    .array(
      z.object({
        upstreamArtifactId: idSchema,
        downstreamArtifactId: idSchema,
        relationship: relationshipSchema,
        label: z.string().default(''),
      }),
    )
    .min(1)
    .describe(
      'Links to add. The downstream artifact depends on the upstream one; relationship reads downstream to upstream, e.g. a test (downstream) validates a requirement (upstream).',
    ),
  ...idem,
});
const graphRemoveEdges = z.object({
  edgeIds: z
    .array(idSchema)
    .min(1)
    .describe('Ids of the links to remove, from graph_list or graph_neighbors.'),
  ...idem,
});
const graphList = z.object({});

/* ------------------------------- sources / research -------------------- */

const sourceCapture = z.object({
  url: z.string().optional().describe('Address of the page. Give this or filePath.'),
  filePath: z
    .string()
    .optional()
    .describe('Project-relative path of a file to record as the source. Give this or url.'),
  title: z.string().describe('Title of the page or document.'),
  publisher: z.string().optional().describe('Who published it, e.g. the manufacturer or shop.'),
  locator: z.string().optional().describe('Where in the source the fact is, e.g. "page 3".'),
  excerpt: z
    .string()
    .optional()
    .describe('The facts as observed: name, price, pack size, availability.'),
  sourceKind: z
    .enum(['manufacturer', 'supplier', 'datasheet', 'article', 'user_import', 'note', 'other'])
    .default('other')
    .describe('Kind of source. Use supplier for a shop product page.'),
  ...idem,
});
const sourceRead = z.object({ sourceId: idSchema.describe('Id of a source artifact.') });
const researchSearch = z.object({ query: z.string().min(1), engine: z.string().optional() });
const researchReadPage = z.object({
  url: z.string().min(1).describe('Exact public http(s) address of the page to read.'),
});
const browserOpen = z.object({ url: z.string().min(1) });
const browserRead = z.object({});
const browserFollowLink = z.object({ selector: z.string().optional(), url: z.string().optional() });
const browserCapture = z.object({ title: z.string().optional(), excerpt: z.string().optional() });
const browserScreenshot = z.object({});

/* ------------------------------- components / BOM ---------------------- */

const offerUrl = z
  .string()
  .url()
  .regex(/^https?:\/\//)
  .optional()
  .describe('Address of the exact product page.');
const offerPrice = moneySchema
  .nullable()
  .default(null)
  .describe('Observed price, e.g. {"amount": "12.50", "currency": "USD"}; amount is a string.');
const offerQuantityBasis = z
  .number()
  .positive()
  .default(1)
  .describe('Units the price covers, e.g. 10 for a pack of ten.');
const offerAvailability = z.string().optional().describe('Availability as shown, e.g. "In stock".');

const componentAddCandidate = z.object({
  title: z.string().min(1).describe('Name of the part as it should appear in the parts list.'),
  manufacturer: z.string().optional().describe('Who makes it. Give this or vendor.'),
  vendor: z.string().optional().describe('Brand or vendor. Give this or manufacturer.'),
  partNumber: z.string().min(1).describe('Manufacturer part number or model.'),
  description: z.string().optional().describe('One line on what the part is.'),
  imageUrl: z
    .string()
    .url()
    .regex(/^https?:\/\//)
    .optional()
    .describe('Address of the actual product photo from the page. Never a generated image.'),
  selectionReason: z.string().optional().describe('Why this part suits this project.'),
  properties: z
    .record(
      z.string(),
      z.object({
        quantity: maybeQuantitySchema,
        sourceId: idSchema.optional(),
        locator: z.string().optional(),
        observedAt: z.string().optional(),
      }),
    )
    .default({})
    .describe(
      'Engineering values by name, e.g. {"mass": {"quantity": {"value": 55, "unit": "g"}, "sourceId": "…"}}. A value that was not found is {"quantity": {"unknown": true, "reason": "…"}}.',
    ),
  attributes: z
    .record(
      z.string(),
      z.object({
        value: z.string(),
        sourceId: idSchema.optional(),
        locator: z.string().optional(),
      }),
    )
    .default({})
    .describe('Facts without units by name, e.g. {"interface": {"value": "PWM"}}.'),
  offer: z
    .object({
      seller: z.string(),
      url: offerUrl,
      price: offerPrice,
      quantityBasis: offerQuantityBasis,
      availabilityText: offerAvailability,
      sourceId: idSchema.optional(),
    })
    .optional()
    .describe('One seller offer you observed. Add more with component_add_offer.'),
  sourceId: idSchema
    .optional()
    .describe('Source from source_capture. Needed unless source or an offer url is given.'),
  source: z
    .object({
      url: z
        .string()
        .url()
        .regex(/^https?:\/\//),
      title: z.string().min(1),
      publisher: z.string().optional(),
      excerpt: z.string().optional(),
      locator: z.string().optional(),
      sourceKind: z
        .enum(['manufacturer', 'supplier', 'datasheet', 'article', 'user_import', 'note', 'other'])
        .default('supplier'),
    })
    .optional()
    .describe(
      'The page the facts came from, as {url, title, excerpt}. It is recorded as a source for you, so source_capture is not needed. Ignored when sourceId is given.',
    ),
  alternativeTo: idSchema.optional().describe('Component this one is an alternative to.'),
  ...idem,
});
const componentCompare = z.object({
  artifactIds: z.array(idSchema).min(1).describe('Component artifacts to compare.'),
});
const componentProposeSelection = z.object({
  artifactId: idSchema.describe('Component to select.'),
  revisionId: idSchema
    .optional()
    .describe('Revision of that component to select. Defaults to its newest draft.'),
  bomLines: z
    .array(
      z.object({
        subsystem: z.string().nullable().default(null),
        quantity: z.number().positive(),
        offerId: idSchema.nullable().default(null),
        location: z.string().nullable().default(null),
        notes: z.string().default(''),
      }),
    )
    .min(1)
    .describe(
      'BOM lines to add on approval: quantity needed and optionally offerId, subsystem, location and notes. Without offerId the only offer of the component is used; with several offers, name one.',
    ),
  replacesArtifactId: idSchema
    .optional()
    .describe('Component this selection replaces. Its BOM lines are removed on approval.'),
  reason: z.string().describe('Why this component, in a sentence the reviewer can check.'),
  ...idem,
});
const componentAddOffer = z.object({
  artifactId: idSchema.describe('Component the offer is for.'),
  seller: z.string().describe('Shop or distributor name.'),
  url: offerUrl,
  price: offerPrice,
  quantityBasis: offerQuantityBasis,
  availabilityText: offerAvailability,
  sourceId: idSchema.optional().describe('Source captured from the offer page.'),
  ...idem,
});
const bomRead = z.object({});
const bomProposeEdit = z.object({
  lines: z
    .array(
      z.object({
        componentArtifactId: idSchema,
        componentRevisionId: idSchema.optional(),
        subsystem: z.string().nullable().default(null),
        quantity: z.number().positive(),
        offerId: idSchema.nullable().default(null),
        location: z.string().nullable().default(null),
        notes: z.string().default(''),
      }),
    )
    .default([])
    .describe(
      'BOM lines to add on approval: the component, quantity needed, offerId to buy from (from component_compare), and optionally subsystem, location and notes.',
    ),
  removeLineIds: z
    .array(idSchema)
    .default([])
    .describe('Ids of BOM lines (from bom_read) to remove on approval.'),
  reason: z.string().describe('Why the BOM should change.'),
  ...idem,
});
const bomExport = z.object({
  format: z.enum(['csv', 'markdown']).default('markdown').describe('Text format to return.'),
  destPath: z
    .string()
    .min(1)
    .optional()
    .describe('Also write the text to this file. A path inside the project when you are an agent.'),
});
const bomUpdateLine = z.object({
  lineId: idSchema,
  quantity: z.number().positive().optional(),
  offerId: idSchema.nullable().optional(),
  location: z.string().nullable().optional(),
  notes: z.string().optional(),
  ...idem,
});
const bomRemoveLine = z.object({ lineId: idSchema, ...idem });

/* ------------------------------- CAD ----------------------------------- */

const cadProbe = z.object({});
const cadValidateSource = z.object({ artifactId: idSchema, revisionId: idSchema.optional() });
const cadRender = z.object({
  artifactId: idSchema,
  revisionId: idSchema.optional(),
  params: z
    .record(z.string(), z.union([quantitySchema, z.number(), z.string(), z.boolean()]))
    .optional(),
  timeoutMs: z.number().int().positive().max(600_000).default(120_000),
  ...idem,
});

/** Plain `-D` overrides: numbers, strings, booleans keyed by top-level variable name. */
const scadParams = z
  .record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
  .describe(
    'Overrides for top-level OpenSCAD variables, e.g. {"hole_d": 6.6}. Keys must be top-level assignments in the source; values are plain numbers/strings/booleans in model units (mm).',
  );

/** How much of a CAD result to return. */
const cadDetail = z
  .enum(['brief', 'full'])
  .optional()
  .describe('Result size: brief (outcome, failures, next step) or full (default).');

const sectionRequest = z.object({
  axis: z
    .enum(['x', 'y', 'z'])
    .optional()
    .describe('Axis normal to the cutting plane (axis-aligned cut).'),
  at: z
    .number()
    .optional()
    .describe(
      'Plane coordinate along that axis, in mm. Cut through the middle of the feature you want to see, not exactly on a face.',
    ),
  origin: z
    .array(z.number())
    .length(3)
    .optional()
    .describe(
      'Point on an oblique cutting plane [x,y,z] mm. Use with `normal` for inclined holes.',
    ),
  normal: z
    .array(z.number())
    .length(3)
    .optional()
    .describe(
      'Normal of an oblique cutting plane. Use with `origin` when the cut is not axis-aligned.',
    ),
});

const cadWriteSource = z.object({
  expectedRevisionId: idSchema
    .optional()
    .describe('Revision read before this edit; conflicts fail without overwriting newer work.'),
  artifactId: idSchema
    .optional()
    .describe('Existing mechanical artifact to revise. Omit to create a new part.'),
  title: z
    .string()
    .min(1)
    .optional()
    .describe('Part name; required when creating a new part (e.g. "Motor mount plate").'),
  source: z
    .string()
    .min(1)
    .describe(
      'Complete OpenSCAD source as plain text (not base64). Model units are millimetres; +Z is up; the origin is the reference the request uses.',
    ),
  params: scadParams
    .optional()
    .describe('Optional parameter values to render with and record on the revision.'),
  subsystem: z
    .string()
    .nullable()
    .optional()
    .describe('Subsystem to group a new part under. Omit for none.'),
  rationale: z.string().default('').describe('One line on what this revision changes and why.'),
  timeoutMs: z.number().int().positive().max(300_000).default(90_000).describe('Render timeout.'),
  detail: cadDetail,
  ...idem,
});
const cadReadSource = z.object({
  artifactId: idSchema.describe('Mechanical part to read.'),
  revisionId: idSchema.optional().describe('Defaults to the newest revision.'),
});
const cadInspect = z.object({
  artifactId: idSchema.describe('Mechanical part to measure.'),
  revisionId: idSchema.optional().describe('Defaults to the newest revision.'),
  params: scadParams
    .optional()
    .describe('Re-render with these overrides before measuring (nothing is committed).'),
  sections: z
    .array(sectionRequest)
    .max(12)
    .optional()
    .describe('Extra cutting planes to report, beyond the automatic mid-planes.'),
  probes: z
    .array(z.array(z.number()).length(3))
    .max(64)
    .optional()
    .describe('Points (x,y,z) in mm to classify as solid or empty.'),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(300_000)
    .optional()
    .describe('Render timeout if the part must be rendered again (default 90000).'),
  detail: cadDetail,
});
const cadCheck = z.object({
  artifactId: idSchema.describe('Mechanical part to verify.'),
  revisionId: idSchema.optional().describe('Defaults to the newest revision.'),
  params: scadParams
    .optional()
    .describe('Check a parameter variant instead of the recorded values (nothing is committed).'),
  expect: expectationSchema.describe(
    'What must be true of the part, taken from the request: size, bodies and holes, or envelope, volume, points and cross-sections for more detail.',
  ),
  autoCommit: z
    .boolean()
    .optional()
    .describe(
      'true: trial the complete check and commit it in the same call only when everything passes and no committed assertion is dropped or changed. A failing run binds nothing.',
    ),
  exploratory: z
    .boolean()
    .optional()
    .describe(
      'true: trial only, never binds. Omitted or false without autoCommit: commit the expectations even if they fail; they then stay binding.',
    ),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(300_000)
    .optional()
    .describe('Render timeout if the part must be rendered again (default 90000).'),
  detail: cadDetail,
});
const cadExport = z.object({
  artifactId: idSchema,
  destPath: z.string().min(1),
  format: z.enum(['stl', 'scad']).default('stl'),
});
const cadPatchSource = z.object({
  expectedRevisionId: idSchema
    .optional()
    .describe('Revision read before this edit; conflicts fail without overwriting newer work.'),
  artifactId: idSchema.describe('Existing mechanical part to edit.'),
  oldString: z
    .string()
    .min(1)
    .describe('Exact snippet to replace. Must occur exactly once in the current source.'),
  newString: z.string().describe('Replacement text (may be empty to delete the snippet).'),
  rationale: z.string().default('').describe('One line on what this edit changes and why.'),
  timeoutMs: z.number().int().positive().max(300_000).default(90_000).describe('Render timeout.'),
  detail: cadDetail,
  ...idem,
});
const cadSetParam = z.object({
  expectedRevisionId: idSchema
    .optional()
    .describe('Revision read before this edit; conflicts fail without overwriting newer work.'),
  artifactId: idSchema.describe('Existing mechanical part to edit.'),
  name: z.string().min(1).describe('File-scope parameter name from cad_read_source (e.g. hole_d).'),
  value: z
    .union([z.number(), z.string(), z.boolean()])
    .describe('New literal value written into the source assignment.'),
  rationale: z.string().default('').describe('One line on why this dimension changed.'),
  timeoutMs: z.number().int().positive().max(300_000).default(90_000).describe('Render timeout.'),
  detail: cadDetail,
  ...idem,
});
const cadCompose = z.object({
  title: z.string().min(1).describe('Name of the assembled part.'),
  instances: z
    .array(
      z.object({
        artifactId: idSchema.describe('Existing mechanical part to place.'),
        revisionId: idSchema.optional().describe('Pin the part revision placed in this snapshot.'),
        translate: z
          .array(z.number())
          .length(3)
          .optional()
          .describe('Translation [x,y,z] mm applied after rotate.'),
        rotate: z
          .array(z.number())
          .length(3)
          .optional()
          .describe('OpenSCAD Euler rotation [x,y,z] degrees.'),
      }),
    )
    .min(1)
    .max(32)
    .describe(
      'Parts to place. Each source is wrapped in its own module so file-scope names do not collide.',
    ),
  rationale: z.string().default('').describe('One line on why these parts are placed together.'),
  timeoutMs: z.number().int().positive().max(300_000).default(90_000).describe('Render timeout.'),
  detail: cadDetail,
  ...idem,
});

/* ------------------------------- calculation --------------------------- */

const calculationRun = z.object({
  artifactId: idSchema
    .optional()
    .describe('Existing calculation to re-run as a new revision. Omit to create one.'),
  templateId: z
    .string()
    .optional()
    .describe('Template id from calculation_templates. Give this or expression.'),
  expression: z
    .string()
    .optional()
    .describe('Formula over the input names, e.g. "mass * g". Give this or templateId.'),
  inputs: z
    .array(
      z.object({
        name: z.string(),
        quantity: maybeQuantitySchema,
        sourceRef: revisionRefSchema.optional(),
        literal: z.boolean().default(false),
      }),
    )
    .default([])
    .describe(
      'Input values, each {name, quantity: {value, unit}}: name is the variable used in the expression. Add sourceRef {artifactId, revisionId} when the value came from an artifact.',
    ),
  outputUnit: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Unit to report the result in, e.g. "Wh". Omit it and the unit follows from the expression; a result that could be energy or torque needs it.',
    ),
  assumptions: z.array(z.string()).default([]).describe('Assumptions the result depends on.'),
  title: z.string().optional().describe('Title for a new calculation artifact.'),
  submitForReview: z
    .boolean()
    .default(true)
    .describe('Also submit the result as a proposal. Pass false to keep it a draft.'),
  ...idem,
});
const calculationExplainInputs = z.object({
  artifactId: idSchema.describe('Calculation artifact to explain.'),
});
const calculationTemplates = z.object({});

/* ------------------------------- wiring -------------------------------- */

const wiringArtifactId = idSchema.describe('Wiring artifact.');
const wiringRevisionId = idSchema
  .optional()
  .describe('Revision to use. Defaults to the newest draft, else the approved one.');
const wiringBaseRevisionId = idSchema
  .optional()
  .describe('Revision to build on. Defaults to the newest draft, else the approved one.');

const wiringValidate = z.object({ artifactId: wiringArtifactId, revisionId: wiringRevisionId });
const wiringRender = z.object({ artifactId: wiringArtifactId, revisionId: wiringRevisionId });
const wiringSetPins = z.object({
  artifactId: wiringArtifactId,
  pins: z.array(pinSchema).describe('Every pin of the wiring; replaces the previous list.'),
  baseRevisionId: wiringBaseRevisionId,
  ...idem,
});
const wiringSetConnections = z.object({
  artifactId: wiringArtifactId,
  connections: z
    .array(connectionSchema)
    .describe('Every connection of the wiring; replaces the previous list.'),
  baseRevisionId: wiringBaseRevisionId,
  ...idem,
});

/* ------------------------------- proposals ----------------------------- */

const proposalStateSchema = z.enum([
  'pending',
  'accepted',
  'rejected',
  'changes_requested',
  'conflicted',
  'cancelled',
  'superseded',
]);

const proposalSubmit = z.object({
  changes: z
    .array(proposedChangeSchema)
    .min(1)
    .describe('Draft revisions to review, one entry per artifact.'),
  reason: z.string().describe('What is proposed and why, in a sentence the reviewer can check.'),
  ...idem,
});
const proposalRead = z.object({ proposalId: idSchema.describe('Proposal to read.') });
const proposalWait = z.object({
  proposalId: idSchema.describe('Proposal to wait for.'),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .default(60_000)
    .describe('Longest time to wait, in milliseconds.'),
  cursor: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Cursor from a previous proposal_wait result.'),
});
const proposalList = z.object({
  state: proposalStateSchema.optional().describe('Only proposals in this state.'),
});
const proposalApprove = z.object({
  proposalId: idSchema,
  rationale: z.string().default(''),
  verificationEvidence: z.record(z.string().regex(/^[a-f0-9]{64}$/)).optional(),
  ...idem,
});
const proposalReject = z.object({
  proposalId: idSchema,
  rationale: z.string().default(''),
  ...idem,
});
const proposalRequestChanges = z.object({
  proposalId: idSchema,
  rationale: z.string().default(''),
  ...idem,
});

/* ------------------------------- work / guidance ----------------------- */

const workStatus = z.object({
  scope: z
    .enum(['session', 'project'])
    .optional()
    .describe(
      'session: work from this agent session (the default for agents). project: everything unfinished in the project.',
    ),
});

/** Playbook topics served by `guide.read`. */
export const guideTopics = [
  'start',
  'requirements',
  'parts',
  'cad',
  'cad-verify',
  'wiring',
  'calculation',
  'tests',
  'review',
  'finish',
] as const;
export type GuideTopic = (typeof guideTopics)[number];

const guideRead = z.object({
  topic: z
    .string()
    .optional()
    .describe(`One of: ${guideTopics.join(', ')}. Omit for start.`),
});

/* ------------------------------- jobs / tools -------------------------- */

const jobRead = z.object({ jobId: idSchema });
const jobCancel = z.object({ jobId: idSchema });
const jobList = z.object({
  status: z.string().optional(),
  limit: z.number().int().positive().max(200).default(50),
});
const toolList = z.object({});
const toolDoctor = z.object({
  toolId: z.string().optional().describe('Tool to check, e.g. "openscad". Omit for all.'),
});
const toolDescribe = z.object({
  tool: z
    .string()
    .min(1)
    .optional()
    .describe('Tool name, e.g. "cad_check". Omit to list every tool.'),
  op: z.string().min(1).optional().describe('Same as tool. Give one of the two, not both.'),
  artifactType: artifactTypeSchema
    .optional()
    .describe(
      'Include the payload schema for this artifact type when authoring or updating artifacts.',
    ),
});
const toolCall = z.object({
  tool: z.string().min(1).describe('Name of the tool to call, e.g. "wiring_validate".'),
  input: z
    .record(z.unknown())
    .optional()
    .describe("That tool's arguments, as an object. Omit when it takes none."),
});

/* ------------------------------- tests --------------------------------- */

const requirementRef = z.object({
  artifactId: idSchema,
  revisionId: idSchema.optional(),
});
const testCreateDraft = z.object({
  title: z.string().min(1).describe('Name of the test, e.g. "Payload lift test".'),
  procedure: z
    .array(
      z.object({
        step: z.number().int(),
        instruction: z.string(),
        expected: z.string().optional(),
      }),
    )
    .min(1)
    .describe('Ordered steps, each {step, instruction, expected}; step numbers start at 1.'),
  requirementRefs: z
    .array(requirementRef)
    .default([])
    .describe(
      'Requirements this test validates, each as {artifactId}. revisionId is optional and defaults to the approved revision of the requirement, else its newest.',
    ),
  conditions: z.string().optional().describe('Setup and conditions the test is run under.'),
  ...idem,
});
const testRecordResult = z.object({
  artifactId: idSchema.describe('Test artifact the result belongs to.'),
  expectedRevisionId: idSchema
    .optional()
    .describe(
      'Revision this observation was entered against. Refuse if the revision the result would extend has changed, so the observation can be reviewed before retrying.',
    ),
  requirementRef: requirementRef
    .optional()
    .describe(
      'Requirement the result speaks to, as {artifactId}. It must be one the test validates; revisionId defaults to the revision the test was written for.',
    ),
  evidenceKind: evidenceKindSchema.describe(
    'How the result was obtained. measured only for a real physical measurement.',
  ),
  observation: z.string().describe('What was actually observed, with values and units.'),
  result: z
    .enum(['planned', 'not_run', 'passed', 'failed', 'inconclusive'])
    .describe('Outcome. Use not_run or planned when nothing was observed.'),
  conditions: z.string().optional().describe('Conditions during the run.'),
  attachments: z
    .array(
      z.object({
        path: z.string(),
        sourcePath: z.string().optional(),
        contentBase64: z.string().optional(),
      }),
    )
    .default([])
    .describe(`Evidence files such as logs or photos, ${FILES_SHAPE}.`),
  measurementOrigin: z
    .string()
    .optional()
    .describe('File, instrument or person the measurement came from.'),
  ...idem,
});

/* ------------------------------- build --------------------------------- */

const buildPreview = z.object({});
const buildExport = z.object({
  destPath: z.string().min(1).describe('Path of the ZIP file to write.'),
  includeDrafts: z
    .boolean()
    .default(false)
    .describe('Export although issues remain; the package is then labelled DRAFT.'),
  label: z.string().optional().describe('Label recorded in the package manifest.'),
  ...idem,
});

/* ------------------------------- ui ------------------------------------ */

const uiOpenArtifact = z.object({ artifactId: idSchema.describe('Artifact to show.') });
const uiRequestReview = z.object({
  proposalId: idSchema.describe('Pending proposal to bring to the person.'),
});
const uiSuggestAction = z.object({
  title: z.string().describe('The suggested step, as a short imperative line.'),
  detail: z.string().optional().describe('One more line of context.'),
});
const uiFocusTerminal = z.object({});

/* ------------------------------- terminal / connections (user scope) --- */

const terminalStart = z.object({
  adapterId: z.string(),
  executablePath: z.string().optional(),
  args: z.array(z.string()).optional(),
  /** Initial terminal size, so the CLI lays out once at the size the person sees. */
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  /** Model id passed to the CLI. Defaults to the adapter's configured model. */
  model: z.string().optional(),
  /** Capability profile for this session. Defaults to the adapter's setting. */
  profile: profileSettingSchema.optional(),
});
const richText = z.string().min(1).max(240);
const chatPart = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('artifact'), artifactId: idSchema, revisionId: idSchema.optional() })
    .strict(),
  z.object({ kind: z.literal('review'), proposalId: idSchema }).strict(),
  z
    .object({
      kind: z.literal('chart'),
      title: richText,
      xLabel: richText,
      xUnit: z.string().max(32),
      yLabel: richText,
      yUnit: z.string().max(32),
      source: richText,
      provenance: z.literal('illustrative'),
      points: z
        .array(z.object({ x: z.number().finite(), y: z.number().finite() }).strict())
        .min(2)
        .max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal('form'),
      title: richText,
      fields: z
        .array(
          z
            .object({
              name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
              label: richText,
              unit: z.string().max(32),
              value: z.number().finite().nullable(),
              reason: z.string().max(500).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(16),
    })
    .strict(),
  z
    .object({
      kind: z.literal('choices'),
      title: richText,
      options: z
        .array(z.object({ label: richText, prompt: z.string().min(1).max(2000) }).strict())
        .min(1)
        .max(8),
    })
    .strict(),
]);
const chatPresent = z.object({ part: chatPart });
const chatOpen = z.object({
  conversationId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  part: chatPart,
});
const chatInput = z
  .object({
    artifactId: idSchema.optional(),
    revisionId: idSchema.optional(),
    title: richText,
    intent: z.enum(['render', 'evaluate']),
    fields: z
      .array(
        z
          .object({
            name: z.string().min(1).max(100),
            text: z.string().max(2000),
            unit: z.string().max(32),
            unknown: z.boolean(),
            reason: z.string().max(500).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict();
const chatRead = z.object({});
const chatSend = z.object({
  conversationId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  adapterId: z.enum(['codex', 'claude-code']),
  text: z.string().min(1).max(32000).regex(/\S/),
  input: chatInput.optional(),
  continues: z
    .object({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/) })
    .strict()
    .optional()
    .describe(
      'The latest turn of this conversation that this request continues. The host strips any other key: only Omen Flow sends an automatic continuation.',
    ),
});
const chatCancel = z.object({ conversationId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/) });
const terminalWrite = z.object({ data: z.string() });
const terminalResize = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
const terminalInterrupt = z.object({});
const terminalStop = z.object({});
const terminalRestart = z.object({});
const terminalState = z.object({});

const connectionList = z.object({});
const connectionTest = z.object({ adapterId: z.string() });
const connectionConfigure = z.object({
  adapterId: z.string(),
  executablePath: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  /** Launch model for this adapter; null clears it so the CLI chooses. */
  model: z.string().nullable().optional(),
  profile: profileSettingSchema.optional(),
});

const agentActivity = z.object({
  limit: z.number().int().positive().max(500).default(100),
  sessionId: idSchema.optional(),
  /** Return calls recorded before this sequence number, to page back. */
  beforeSeq: z.number().int().nonnegative().optional(),
});

const settingsGet = z.object({ key: z.string().optional() });
const settingsSet = z.object({ key: z.string(), value: z.unknown() });

const appRecentProjects = z.object({});
const appDiagnostics = z.object({});

/* ------------------------------- compact overlays ---------------------- */

/*
 * Schemas listed to compact-profile sessions, one per core tool. Each is a
 * subset of the real input: the same field names and nesting with fewer
 * optional fields and shorter text. `ops.test.ts` checks the subset relation
 * and that every example fits its overlay.
 */

const vec3Compact = z.array(z.number()).length(3);

const projectSummaryCompact = z.object({});
const artifactListCompact = z.object({
  type: artifactTypeSchema.optional(),
  limit: z.number().int().optional().describe('Page size, default 200.'),
  offset: z.number().int().optional().describe('Artifacts to skip.'),
});
const artifactReadCompact = z.object({
  artifactId: z.string().describe('Id from artifact_list or an earlier result.'),
});
const artifactCreateDraftCompact = z.object({
  type: artifactTypeSchema,
  title: z.string(),
  payload: z
    .record(z.unknown())
    .describe('Fields of this type; get them from tool_describe with artifactType.'),
  rationale: z.string().optional(),
});
const artifactUpdateDraftCompact = z.object({
  artifactId: z.string(),
  payload: z.record(z.unknown()).describe('Complete payload; replaces the previous one.'),
  title: z.string().optional(),
  rationale: z.string().optional(),
});
const cadWriteSourceCompact = z.object({
  source: z.string().describe('Complete OpenSCAD file as plain text. Units mm, +Z up.'),
  title: z.string().optional().describe('Name, for a new part.'),
  artifactId: z.string().optional().describe('Existing part to revise.'),
  rationale: z.string().optional(),
});
const cadReadSourceCompact = z.object({ artifactId: z.string() });
const cadCheckCompact = z.object({
  artifactId: z.string(),
  expect: z
    .object({
      size: vec3Compact.optional().describe('Overall size [x,y,z], mm.'),
      bodies: z.number().int().optional().describe('Separate bodies; 1 for one part.'),
      holes: z
        .array(
          z.object({
            at: vec3Compact.describe('Point on the hole axis, inside the material.'),
            d: z.number().describe('Diameter, mm.'),
            axis: z.enum(['x', 'y', 'z']).optional().describe('Hole direction, default z.'),
          }),
        )
        .optional()
        .describe('Round holes.'),
      bbox: z
        .object({ min: vec3Compact, max: vec3Compact })
        .optional()
        .describe('Envelope corners, when position matters.'),
      volume: z.object({ value: z.number() }).optional().describe('Solid volume, mm³.'),
      solid: z.array(vec3Compact).optional().describe('Points [x,y,z] inside material.'),
      empty: z.array(vec3Compact).optional().describe('Points [x,y,z] in empty space.'),
    })
    .describe('From the request, never copied from the report.'),
  autoCommit: z.boolean().optional().describe('true: commit when everything passes.'),
});
const proposalSubmitCompact = z.object({
  changes: z
    .array(
      z.object({
        artifactId: z.string(),
        newRevisionId: z.string().describe('Draft revision to approve.'),
        kind: z
          .enum(['new_artifact', 'baseline_update'])
          .describe('new_artifact when nothing is approved yet.'),
        baseRevisionId: z.string().optional().describe('Approved revision, for baseline_update.'),
      }),
    )
    .min(1),
  reason: z.string(),
});
const workStatusCompact = z.object({
  scope: z
    .enum(['session', 'project'])
    .optional()
    .describe('session (default): your work. project: everything unfinished.'),
});
const guideReadCompact = z.object({ topic: z.enum(guideTopics).optional() });
const toolDescribeCompact = z.object({
  tool: z.string().optional().describe('Omit to list every tool.'),
  artifactType: artifactTypeSchema.optional().describe('Also return its payload fields.'),
});
const toolCallCompact = z.object({
  tool: z.string().describe('Tool name from the tool_describe catalogue.'),
  input: z.record(z.unknown()).optional().describe("That tool's arguments."),
});

/* ------------------------------- registry ------------------------------ */

/** Pack an op belongs to when its definition does not name one, by op-name prefix. */
const PACK_BY_PREFIX: Record<string, OpPack> = {
  project: 'system',
  app: 'system',
  artifact: 'core',
  graph: 'graph',
  source: 'parts',
  research: 'parts',
  browser: 'parts',
  component: 'parts',
  bom: 'parts',
  cad: 'cad',
  calculation: 'analysis',
  test: 'analysis',
  wiring: 'wiring',
  proposal: 'review',
  work: 'core',
  guide: 'core',
  job: 'system',
  tool: 'system',
  build: 'files',
  ui: 'ui',
  terminal: 'system',
  connection: 'system',
  agent: 'system',
  chat: 'system',
  settings: 'system',
};

interface OpMeta {
  agentVisible?: boolean;
  tier?: OpTier;
  pack?: OpPack;
  summary?: string;
  example?: Record<string, unknown>;
  compactSchema?: z.ZodTypeAny;
}

function def(
  name: string,
  input: z.ZodTypeAny,
  capability: Capability,
  mutating: boolean,
  description: string,
  meta: OpMeta = {},
): OpDef {
  const pack = meta.pack ?? PACK_BY_PREFIX[name.slice(0, name.indexOf('.'))];
  if (!pack) throw new Error(`No pack for operation ${name}`);
  return {
    name,
    toolName: name.replace(/\./g, '_'),
    input,
    capability,
    mutating,
    description,
    agentVisible: meta.agentVisible ?? true,
    tier: meta.tier ?? 'full',
    pack,
    summary: meta.summary ?? description,
    example: meta.example ?? null,
    compactSchema: meta.compactSchema ?? null,
  };
}

/** Superseded for agents by the cad_* verification vocabulary; still valid ops. */
const legacy = { agentVisible: false };

export const OPS: OpDef[] = [
  def('project.create', projectCreate, 'user', true, 'Create a project at a folder path'),
  def('project.open', projectOpen, 'user', false, 'Open an existing project folder'),
  def('project.rename', projectRename, 'user', true, 'Rename the active project'),
  def('project.update_intent', projectUpdateIntent, 'user', true, 'Update project intent'),
  def(
    'project.summary',
    projectSummary,
    'both',
    false,
    'Start here. Returns the project intent, artifact counts by type, requirements and assumptions, pending proposals, stale artifacts, recent decisions and your unfinished work with the next tool to call. Call it once at the start of a session, then use artifact_list and artifact_read for detail.',
    {
      tier: 'core',
      pack: 'core',
      summary: 'Start here: intent, counts, requirements, pending proposals, unfinished work.',
      example: {},
      compactSchema: projectSummaryCompact,
    },
  ),
  def(
    'project.search',
    projectSearch,
    'both',
    false,
    'Search artifact titles and content for words. Use it to find an artifact when you know a term but not its id. Returns the best matches with artifactId, revisionId, type, title and a snippet.',
    {
      tier: 'standard',
      pack: 'graph',
      summary: 'Search artifact titles and content for words.',
      example: { query: 'payload mass' },
    },
  ),
  def(
    'project.changes_since',
    projectChangesSince,
    'both',
    false,
    'List project events (drafts, proposals, decisions, staleness) recorded after a sequence number. Use it to catch up on what changed since you last looked. Returns up to 500 events with nextCursor and hasMore.',
    {
      pack: 'graph',
      summary: 'List project events recorded after a sequence number.',
      example: { seq: 0 },
    },
  ),
  def(
    'project.coverage',
    projectCoverage,
    'both',
    false,
    'List each requirement with its coverage (covered, partial, stale or none) and the calculations, tests and parts linked as evidence, with their state and recorded result. Use it to find requirements that still need evidence. A pass or fail verdict appears only where a test result recorded one.',
    {
      tier: 'standard',
      pack: 'analysis',
      summary: 'List requirements with their linked evidence and coverage state.',
      example: {},
    },
  ),
  def(
    'project.export_archive',
    projectExportArchive,
    'user',
    false,
    'Lossless project archive export',
  ),
  def('project.import_archive', projectImportArchive, 'user', true, 'Import a project archive'),
  def('project.list_open', z.object({}), 'user', false, 'List open projects'),
  def('project.close', z.object({}), 'user', true, 'Close an open project'),
  def('app.recent_projects', appRecentProjects, 'user', false, 'List recent project folders'),
  def('app.diagnostics', appDiagnostics, 'user', false, 'Previewable diagnostic bundle'),

  def(
    'artifact.list',
    artifactList,
    'both',
    false,
    'List artifacts with their id, type, title, review state and freshness. Use it to find the ids other tools need; filter by type to keep the result small. Returns artifacts in creation order, each with its approved revision when it has one, its draft count and whether a proposal is pending. Page with limit and offset.',
    {
      tier: 'core',
      summary: 'List artifacts with id, type, title and state; filter by type.',
      example: { type: 'requirement' },
      compactSchema: artifactListCompact,
    },
  ),
  def(
    'artifact.read',
    artifactRead,
    'both',
    false,
    'Read one artifact: its header, the approved revision (or the newest one when nothing is approved yet) and every open draft, each with payload, files, inputs and review state. Use it before updating an artifact, and after creating one to confirm the content was saved as intended.',
    {
      tier: 'core',
      summary: 'Read one artifact: its current content, open drafts and state.',
      example: { artifactId: EX.artifact },
      compactSchema: artifactReadCompact,
    },
  ),
  def(
    'artifact.history',
    artifactHistory,
    'both',
    false,
    'List every revision of an artifact, oldest first, with origin, time, rationale and review state. Use it to see how an artifact changed or to find revision ids for artifact_compare. Returns the revisions.',
    {
      pack: 'graph',
      summary: 'List every revision of an artifact, oldest first.',
      example: { artifactId: EX.artifact },
    },
  ),
  def(
    'artifact.compare',
    artifactCompare,
    'both',
    false,
    'Compare two revisions of one artifact. Returns both revisions and the differences in payload fields, attached files and upstream inputs. Use it to explain what a draft changes relative to the approved revision.',
    {
      pack: 'graph',
      summary: 'Compare two revisions of an artifact field by field.',
      example: {
        artifactId: EX.artifact,
        fromRevisionId: EX.revision,
        toRevisionId: EX.otherRevision,
      },
    },
  ),
  def(
    'artifact.create_draft',
    artifactCreateDraft,
    'both',
    true,
    'Create a new artifact of any type except a part (requirement, assumption, note, concept, component, wiring, calculation, test…) with its first draft revision. The payload must use the fields of that type: call tool_describe with artifactType first unless you already know them. Returns the artifact and revision with their ids. A draft is not approved until a human accepts a proposal. For parts use cad_write_source. Example: {"type":"requirement","title":"Payload capacity","payload":{"statement":"Carry a 0.3 kg payload","target":{"value":0.3,"unit":"kg"},"acceptanceCriterion":"Lifts 0.3 kg for 60 s","priority":"must"}}',
    {
      tier: 'core',
      summary: 'Create a non-CAD artifact (requirement, note, component, test…) as a draft.',
      example: {
        type: 'requirement',
        title: 'Payload capacity',
        payload: {
          statement: 'Carry a 0.3 kg payload',
          target: { value: 0.3, unit: 'kg' },
          acceptanceCriterion: 'Lifts 0.3 kg for 60 s',
          priority: 'must',
        },
      },
      compactSchema: artifactCreateDraftCompact,
    },
  ),
  def(
    'artifact.update_draft',
    artifactUpdateDraft,
    'both',
    true,
    'Save a new draft revision of an existing non-CAD artifact. Send the complete payload: it replaces the previous one and is not merged. Payload, files or inputs you omit are carried over from the previous revision. Returns the artifact and the new revision. For parts use cad_write_source, cad_set_param or cad_patch_source.',
    {
      tier: 'core',
      summary: 'Save a new draft revision of a non-CAD artifact; send the whole payload.',
      example: {
        artifactId: EX.artifact,
        payload: {
          statement: 'Carry a 0.5 kg payload',
          target: { value: 0.5, unit: 'kg' },
          acceptanceCriterion: 'Lifts 0.5 kg for 60 s',
          priority: 'must',
        },
        rationale: 'Payload raised to 0.5 kg',
      },
      compactSchema: artifactUpdateDraftCompact,
    },
  ),
  def(
    'artifact.import_file',
    artifactImportFile,
    'both',
    true,
    'Attach a file that already exists in the project folder to an artifact as a new draft revision: give artifactId, or type and title to create one. Returns the artifact and revision. For OpenSCAD parts use cad_write_source.',
    {
      pack: 'files',
      summary: 'Attach an existing project file to an artifact as a draft.',
      example: { type: 'note', title: 'Motor datasheet', path: 'docs/motor-datasheet.pdf' },
    },
  ),
  def(
    'artifact.apply_edit',
    artifactApplyEdit,
    'user',
    true,
    'User direct baseline edit (decision + propagation)',
  ),
  def(
    'artifact.accept_draft',
    artifactAcceptDraft,
    'user',
    true,
    'Accept a draft revision as the baseline',
  ),
  def('artifact.revert', artifactRevert, 'user', true, 'Revert baseline to a historical revision'),
  def('artifact.archive', artifactArchive, 'user', true, 'Archive/unarchive an artifact'),
  def('artifact.reveal', artifactReveal, 'user', false, 'Reveal artifact files in OS file manager'),
  def(
    'artifact.read_file',
    artifactReadFile,
    'both',
    false,
    "Read the bytes of a file attached to an artifact revision, by its project-relative path. Returns contentBase64 and sha256. Use it for small attached files; for a part's source use cad_read_source.",
    {
      pack: 'files',
      summary: 'Read a file attached to an artifact revision (base64).',
      example: { artifactId: EX.artifact, path: 'docs/motor-datasheet.pdf' },
    },
  ),
  def(
    'artifact.set_subsystem',
    artifactSetSubsystem,
    'user',
    true,
    'Move artifact between subsystems',
  ),

  def(
    'graph.neighbors',
    graphNeighbors,
    'both',
    false,
    'List the artifacts linked to one artifact: upstream (what it depends on), downstream (what depends on it) or both, to a given depth. Returns the artifacts with type, depth and freshness, and the edges between them.',
    {
      tier: 'standard',
      summary: 'List artifacts linked to one artifact, upstream or downstream.',
      example: { artifactId: EX.artifact, direction: 'downstream' },
    },
  ),
  def(
    'graph.impact',
    graphImpact,
    'both',
    false,
    'Report which downstream artifacts are affected when the given revisions change. Use it before proposing a change to see what it would make stale. Returns the affected artifacts with the reason and the dependency path to each.',
    {
      tier: 'standard',
      summary: 'Show which downstream artifacts a change to given revisions affects.',
      example: { refs: [{ artifactId: EX.artifact, revisionId: EX.revision }] },
    },
  ),
  def(
    'graph.propose_edges',
    graphProposeEdges,
    'both',
    true,
    'Add dependency links between artifacts, for example that a test validates a requirement or a part is derived from a concept. A link that would create a dependency cycle is refused. Returns the added edges.',
    {
      tier: 'standard',
      summary: 'Add dependency links between artifacts, upstream to downstream.',
      example: {
        edges: [
          {
            upstreamArtifactId: EX.artifact,
            downstreamArtifactId: EX.otherArtifact,
            relationship: 'validates',
          },
        ],
      },
    },
  ),
  def(
    'graph.remove_edges',
    graphRemoveEdges,
    'both',
    true,
    "Remove dependency links that were added with graph_propose_edges, for example one added by mistake. You can remove links an agent added; links a person added are theirs to remove. Links that come from an artifact's recorded inputs are not removed here. Returns the removed edges.",
    {
      // The undo of graph_propose_edges: callable through tool_call, named in
      // that tool's result, and kept out of the listed tool sets.
      agentVisible: false,
      summary: 'Remove dependency links added with graph_propose_edges.',
      example: { edgeIds: [EX.artifact] },
    },
  ),
  def(
    'graph.list',
    graphList,
    'both',
    false,
    'List every dependency edge in the project with its upstream and downstream artifact ids and relationship. Use graph_neighbors instead when you only need the links around one artifact.',
    { summary: 'List every dependency edge in the project.', example: {} },
  ),

  def(
    'source.capture',
    sourceCapture,
    'both',
    true,
    'Record where a fact came from: a web page (url) or a project file (filePath), with its title, publisher and a factual excerpt. Give url or filePath. Returns a source artifact whose id you pass as sourceId when recording components and offers.',
    {
      tier: 'standard',
      summary: 'Record a web page or file as a source that facts can cite.',
      example: {
        url: 'https://example.com/products/mg996r',
        title: 'MG996R servo product page',
        publisher: 'Example Robotics',
        sourceKind: 'supplier',
        excerpt: 'MG996R metal gear servo, 12.50 USD each, in stock',
      },
    },
  ),
  def(
    'source.read',
    sourceRead,
    'both',
    false,
    'Read a captured source: its address or file hash, title, publisher, excerpt and when it was retrieved. Use it to check what a sourceId refers to. Returns the source artifact and its payload.',
    {
      tier: 'standard',
      summary: 'Read a captured source record by id.',
      example: { sourceId: EX.source },
    },
  ),
  def(
    'research.search',
    researchSearch,
    'both',
    false,
    'Navigate research browser to a search query',
  ),
  def(
    'research.read_page',
    researchReadPage,
    'both',
    false,
    "Open one exact public web page and read it: text, links, images and structured product data such as price and availability. Use it on a seller's product page before recording a component or offer, and check the part, variant, price, pack size and availability. It does not search.",
    {
      tier: 'standard',
      summary: 'Read one public web page: text, links, images and product pricing.',
      example: { url: 'https://example.com/products/mg996r' },
    },
  ),
  def('browser.open', browserOpen, 'both', false, 'Open URL in the isolated research browser'),
  def('browser.read', browserRead, 'both', false, 'Read current page text'),
  def('browser.follow_link', browserFollowLink, 'both', false, 'Follow a link on the current page'),
  def('browser.capture', browserCapture, 'both', true, 'Capture current page as a source'),
  def('browser.screenshot', browserScreenshot, 'both', false, 'Screenshot current page'),

  def(
    'component.add_candidate',
    componentAddCandidate,
    'both',
    true,
    'Record a purchasable part as a component candidate with its sourced properties and one seller offer. It needs a manufacturer or vendor, and where it came from: source, sourceId or an offer url. Record only what you observed. Returns the artifact, its draft revision and the saved offer.',
    {
      tier: 'standard',
      summary: 'Record a purchasable part as a component candidate with its source.',
      example: {
        title: 'MG996R servo',
        manufacturer: 'TowerPro',
        partNumber: 'MG996R',
        source: {
          url: 'https://example.com/products/mg996r',
          title: 'MG996R servo product page',
          excerpt: 'MG996R metal gear servo, 55 g, 12.50 USD each, in stock',
        },
        properties: { mass: { quantity: { value: 55, unit: 'g' } } },
        offer: {
          seller: 'Example Robotics',
          url: 'https://example.com/products/mg996r',
          price: { amount: '12.50', currency: 'USD' },
          quantityBasis: 1,
        },
      },
    },
  ),
  def(
    'component.compare',
    componentCompare,
    'both',
    false,
    'Compare components side by side. Returns each with its payload and saved offers (ids, prices, addresses) and a matrix of their properties. Use it to read back what was saved and to get the offerId for component_propose_selection.',
    {
      tier: 'standard',
      summary: 'Compare components side by side with their offers and properties.',
      example: { artifactIds: [EX.artifact, EX.otherArtifact] },
    },
  ),
  def(
    'component.propose_selection',
    componentProposeSelection,
    'both',
    true,
    'Propose selecting a component for the build, with the BOM lines it adds. It marks the component selected in a new draft and submits a proposal; nothing is selected until the human accepts. A line without offerId uses the only offer of the component. Returns {proposal, notes}.',
    {
      tier: 'standard',
      summary: 'Propose selecting a component with its BOM lines, for human approval.',
      example: {
        artifactId: EX.artifact,
        bomLines: [{ quantity: 2, notes: 'One per steering axle' }],
        reason: 'Meets the 9 kg·cm torque requirement at the lowest observed price',
      },
    },
  ),
  def(
    'component.add_offer',
    componentAddOffer,
    'both',
    true,
    'Add another seller offer (price, pack size, availability, address) to an existing component. Use it for each further seller you actually observed. Offers are separate records and do not create a revision. Returns the saved offer with its id.',
    {
      tier: 'standard',
      summary: 'Add a seller offer (price, address, availability) to a component.',
      example: {
        artifactId: EX.artifact,
        seller: 'Example Robotics',
        url: 'https://example.com/products/mg996r',
        price: { amount: '12.50', currency: 'USD' },
        quantityBasis: 1,
        availabilityText: 'In stock',
      },
    },
  ),
  def(
    'bom.read',
    bomRead,
    'both',
    false,
    'Read the bill of materials: each line with its component, quantity, chosen offer and line total, plus totals for cost by currency and known mass. Lines are added when the human approves a selection or a BOM proposal.',
    {
      tier: 'standard',
      summary: 'Read the bill of materials with quantities, offers and totals.',
      example: {},
    },
  ),
  def(
    'bom.propose_edit',
    bomProposeEdit,
    'both',
    true,
    'Propose adding BOM lines for approved components, removing lines by id, or both. It submits a proposal; the BOM does not change until the human accepts. Each new line names the component, a quantity and optionally the offer to buy from. Returns {proposal}.',
    {
      tier: 'standard',
      summary: 'Propose adding or removing BOM lines, for human approval.',
      example: {
        lines: [{ componentArtifactId: EX.artifact, quantity: 4 }],
        reason: 'Four wheel motors are needed',
      },
    },
  ),
  def('bom.update_line', bomUpdateLine, 'user', true, 'User inline BOM line edit'),
  def('bom.remove_line', bomRemoveLine, 'user', true, 'User remove BOM line'),
  def(
    'bom.export',
    bomExport,
    'both',
    false,
    'Return the bill of materials as CSV or Markdown text. Use it when the person asks for the BOM as text. It returns the content, and also writes it to destPath when you give one.',
    { summary: 'Return the bill of materials as CSV or Markdown text.', example: {} },
  ),

  def('cad.probe', cadProbe, 'both', false, 'Probe CAD tool availability', legacy),
  def(
    'cad.validate_source',
    cadValidateSource,
    'both',
    true,
    'Validate .scad source parses',
    legacy,
  ),
  def(
    'cad.render',
    cadRender,
    'both',
    true,
    'Render .scad → .stl via real OpenSCAD (background job)',
    legacy,
  ),
  def(
    'cad.write_source',
    cadWriteSource,
    'both',
    true,
    'Create a part (give title) or revise one (give artifactId) from complete OpenSCAD source. Saves the source as a new draft revision, renders it with OpenSCAD and returns a measured geometry report: envelope, volume, watertightness, body count, mid-plane cross-sections with holes and outlines, detected parameters and render warnings. Use it for every geometry change, compare the report with the request, then verify with cad_check. Example: {"title":"Motor mount plate","source":"$fn = 64;\\ndifference() {\\n  cube([40, 30, 5]);\\n  translate([10, 10, -1]) cylinder(d = 4, h = 7);\\n}"}',
    {
      tier: 'core',
      summary: 'Create (title) or revise (artifactId) a part from complete OpenSCAD source.',
      example: {
        title: 'Motor mount plate',
        source:
          '$fn = 64;\ndifference() {\n  cube([40, 30, 5]);\n  translate([10, 10, -1]) cylinder(d = 4, h = 7);\n}',
      },
      compactSchema: cadWriteSourceCompact,
    },
  ),
  def(
    'cad.read_source',
    cadReadSource,
    'both',
    false,
    "Read a part's OpenSCAD source as plain text, with its top-level parameters, revision id and whether it has a render. Use it before changing an existing part so your edit starts from the current source.",
    {
      tier: 'core',
      summary: "Read a part's OpenSCAD source and parameters before changing it.",
      example: { artifactId: EX.artifact },
      compactSchema: cadReadSourceCompact,
    },
  ),
  def(
    'cad.inspect',
    cadInspect,
    'both',
    true,
    'Measure a rendered part for debugging: envelope, volume, watertightness, body count, cross-sections on the planes you ask for, and whether probe points are solid or empty. Use it to find why a cad_check assertion fails. Diagnostic only: it does not bind request assertions or establish verification.',
    {
      tier: 'standard',
      summary: 'Measure a part for debugging (sections, probe points); not verification.',
      example: {
        artifactId: EX.artifact,
        sections: [{ axis: 'z', at: 2.5 }],
        probes: [[10, 10, 2.5]],
      },
    },
  ),
  def(
    'cad.check',
    cadCheck,
    'both',
    true,
    'Verify a part against expectations taken from the request, never copied from the measured report: overall size, bodies, holes by position and diameter and, for more detail, envelope corners, volume, solid and empty points, cross-section outlines and preservation of unrelated geometry. Call it with autoCommit true: the complete check runs as a trial and is committed as the verification only when everything passes. A failing run binds nothing, so fix the part or the mistaken assertion and call again. Returns each assertion result, ready, verificationStatus, the normalized expectation and the next action. Only ready true is verified; do not claim completion on failed, scope_changed, partial or unverified. Example: {"artifactId":"<part id>","autoCommit":true,"expect":{"size":[40,30,5],"bodies":1,"holes":[{"at":[10,10,2.5],"d":4}]}}',
    {
      tier: 'core',
      summary: 'Verify a part against request dimensions; autoCommit binds only a passing check.',
      example: {
        artifactId: EX.artifact,
        autoCommit: true,
        expect: {
          size: [40, 30, 5],
          bodies: 1,
          holes: [{ at: [10, 10, 2.5], d: 4 }],
        },
      },
      compactSchema: cadCheckCompact,
    },
  ),
  def(
    'cad.patch_source',
    cadPatchSource,
    'both',
    true,
    "Replace one snippet in an existing part's OpenSCAD source and re-render. Use it for a small local edit instead of rewriting the file; the snippet must occur exactly once in the current source. Saves a new draft revision and returns the same measured report as cad_write_source.",
    {
      tier: 'standard',
      summary: "Replace one unique snippet in a part's source and re-render.",
      example: {
        artifactId: EX.artifact,
        oldString: 'cylinder(d = 4, h = 7)',
        newString: 'cylinder(d = 5, h = 7)',
        rationale: 'Clearance hole for M5',
      },
    },
  ),
  def(
    'cad.set_param',
    cadSetParam,
    'both',
    true,
    'Change one top-level OpenSCAD assignment (name = value;) of an existing part and re-render. Prefer it over rewriting the file when only a dimension changes. Saves a new draft revision and returns the same measured report as cad_write_source.',
    {
      tier: 'standard',
      summary: 'Change one top-level OpenSCAD parameter of a part and re-render.',
      example: { artifactId: EX.artifact, name: 'hole_d', value: 5 },
    },
  ),
  def(
    'cad.compose',
    cadCompose,
    'both',
    true,
    "Place existing parts together with translate and rotate to make one combined part (no mates, no STEP). Each part's source is wrapped in its own module so variable names do not collide. Returns a new mechanical artifact with the combined mesh and its measured report.",
    {
      tier: 'standard',
      summary: 'Place existing parts together by translate and rotate as one new part.',
      example: {
        title: 'Mount with bracket',
        instances: [
          { artifactId: EX.artifact },
          { artifactId: EX.otherArtifact, translate: [0, 0, 5] },
        ],
      },
    },
  ),
  def('cad.export', cadExport, 'user', false, 'Export STL/SCAD file to a chosen path'),

  def(
    'calculation.run',
    calculationRun,
    'both',
    true,
    'Run a unit-aware calculation and save it as a calculation artifact. Give templateId or expression, and named inputs with units. Returns the result with its unit, the revision and its limitations; unchanged is true when a re-run reproduced the recorded result. By default it is submitted for review.',
    {
      tier: 'standard',
      summary: 'Run a unit-aware calculation from a template or expression and save it.',
      example: {
        title: 'Rover mass budget',
        expression: 'chassis + battery',
        inputs: [
          { name: 'chassis', quantity: { value: 1.2, unit: 'kg' }, literal: true },
          { name: 'battery', quantity: { value: 0.4, unit: 'kg' }, literal: true },
        ],
        submitForReview: false,
      },
    },
  ),
  def(
    'calculation.explain_inputs',
    calculationExplainInputs,
    'both',
    false,
    'List the inputs of a saved calculation with where each value came from and whether its source has moved on since. Use it to see why a calculation is stale or to audit its inputs. Returns the inputs, expression and freshness. Experimental.',
    {
      tier: 'standard',
      summary: "Explain a calculation's inputs and where each value came from.",
      example: { artifactId: EX.artifact },
    },
  ),
  def(
    'calculation.templates',
    calculationTemplates,
    'both',
    false,
    'List the calculation templates: id, title, expression, the inputs each needs with units, output unit, assumptions and limitations. Call it before calculation_run to pick a templateId and its input names. Experimental: a result is not verified evidence.',
    {
      tier: 'standard',
      summary: 'List calculation templates with their inputs and units.',
      example: {},
    },
  ),

  def(
    'wiring.validate',
    wiringValidate,
    'both',
    false,
    'Run the wiring checks on a wiring artifact: voltage ranges, ground return, shared signal pins, changed components and pins it knows nothing about. Returns the revision checked, findings with severity and what the checks cover. It is not a full electrical rule check and does not prove safety.',
    {
      tier: 'standard',
      summary: 'Run wiring checks (voltage, ground, pin conflicts) and list findings.',
      example: { artifactId: EX.artifact },
    },
  ),
  def(
    'wiring.render',
    wiringRender,
    'both',
    false,
    'Build the connection table and an SVG diagram for a wiring artifact. Use it to review what was recorded. A diagram is not validation: call wiring_validate for the checks. Returns the table and the diagram.',
    {
      tier: 'standard',
      summary: 'Render a wiring artifact as a connection table and SVG diagram.',
      example: { artifactId: EX.artifact },
    },
  ),
  def(
    'wiring.set_pins',
    wiringSetPins,
    'both',
    true,
    'Set the pin list of a wiring artifact. The list you send replaces every existing pin, so include them all. Create the wiring artifact first with artifact_create_draft (type "wiring") and the components before that. Saves a new draft revision and returns it.',
    {
      tier: 'standard',
      summary: 'Replace the pin list of a wiring artifact (send every pin).',
      example: {
        artifactId: EX.artifact,
        pins: [
          {
            componentArtifactId: EX.otherArtifact,
            pin: 'VCC',
            type: 'power',
            voltageRange: { min: { value: 4.8, unit: 'V' }, max: { value: 7.2, unit: 'V' } },
          },
          { componentArtifactId: EX.otherArtifact, pin: 'GND', type: 'ground' },
        ],
      },
    },
  ),
  def(
    'wiring.set_connections',
    wiringSetConnections,
    'both',
    true,
    'Set the connections of a wiring artifact. The list you send replaces every existing connection, so include them all. Each has a from and to end (component and pin) and a signal role; ids are assigned for you. Saves a new draft revision and returns it; then call wiring_validate.',
    {
      tier: 'standard',
      summary: 'Replace the connections of a wiring artifact (send every connection).',
      example: {
        artifactId: EX.artifact,
        connections: [
          {
            from: { componentArtifactId: EX.otherArtifact, pin: '5V' },
            to: { componentArtifactId: EX.thirdArtifact, pin: 'VCC' },
            voltage: { value: 5, unit: 'V' },
            signalRole: 'power',
          },
        ],
      },
    },
  ),

  def(
    'proposal.submit',
    proposalSubmit,
    'both',
    true,
    'Ask the human to review draft revisions. Use it only when the person asked for review or approval; a proposal cannot be changed once submitted and you can never approve it yourself. Each change names an artifact and the draft revision to approve: kind is "new_artifact" when the artifact has no approved revision yet, otherwise "baseline_update" with baseRevisionId set to the currently approved revision. Returns the pending proposal with its downstream impact. Example: {"changes":[{"artifactId":"<artifact id>","newRevisionId":"<draft revision id>","kind":"new_artifact"}],"reason":"First draft of the payload requirement"}',
    {
      tier: 'core',
      summary: 'Ask the human to review draft revisions; only when review was requested.',
      example: {
        changes: [{ artifactId: EX.artifact, newRevisionId: EX.revision, kind: 'new_artifact' }],
        reason: 'First draft of the payload requirement',
      },
      compactSchema: proposalSubmitCompact,
    },
  ),
  def(
    'proposal.read',
    proposalRead,
    'both',
    false,
    'Read one proposal: its state, reason, impact and, for each change, the artifact with its approved revision and the proposed one. Use it to see what the reviewer was asked or what they answered. Returns the proposal and its changes.',
    {
      tier: 'standard',
      summary: "Read a proposal: state, changes, impact and the reviewer's answer.",
      example: { proposalId: EX.proposal },
    },
  ),
  def(
    'proposal.wait',
    proposalWait,
    'both',
    false,
    'Wait until the human resolves a proposal or the timeout passes, whichever comes first. Returns the proposal state; "pending" means the wait timed out and nothing was decided. Use it only after proposal_submit, when you were asked to continue after review.',
    {
      tier: 'standard',
      summary: 'Wait for the human to resolve a proposal, up to a timeout.',
      example: { proposalId: EX.proposal },
    },
  ),
  def(
    'proposal.list',
    proposalList,
    'both',
    false,
    'List proposals, newest first, optionally only those in one state. Use it to find pending reviews or the ones the reviewer sent back with changes requested. Returns each proposal with its changes, reason and state.',
    {
      tier: 'standard',
      summary: 'List proposals, optionally filtered by state.',
      example: { state: 'pending' },
    },
  ),
  def('proposal.approve', proposalApprove, 'user', true, 'Approve a proposal (human only)'),
  def('proposal.reject', proposalReject, 'user', true, 'Reject a proposal (human only)'),
  def(
    'proposal.request_changes',
    proposalRequestChanges,
    'user',
    true,
    'Request changes on a proposal',
  ),

  def(
    'work.status',
    workStatus,
    'both',
    false,
    'Check what is still unfinished before you say the work is done. Returns ready, a one-line summary, and each outstanding item (unverified or failing parts, components without a source or offer, unvalidated wiring, calculations not run, changes the reviewer requested, empty drafts) with the exact tool call that resolves it, plus the proposals waiting on the human. Call it before your final answer and again after fixing items. Finish only when ready is true, or name every remaining blocker.',
    {
      tier: 'core',
      summary: 'Call before your final answer: lists unfinished work and the next call for each.',
      example: {},
      compactSchema: workStatusCompact,
    },
  ),
  def(
    'guide.read',
    guideRead,
    'both',
    false,
    `Read a short numbered playbook for one kind of work. Topics: ${guideTopics.join(', ')}. Read a topic once before your first task of that kind; with no topic it returns the start guide. Returns the text and the list of all topics with when to use each.`,
    {
      tier: 'core',
      summary: 'Read a short step-by-step playbook for one kind of work.',
      example: { topic: 'cad' },
      compactSchema: guideReadCompact,
    },
  ),

  def('job.read', jobRead, 'both', false, 'Read job status/log', legacy),
  def('job.cancel', jobCancel, 'both', true, 'Cancel an owned job', legacy),
  def('job.list', jobList, 'both', false, 'List jobs', legacy),
  def('tool.list', toolList, 'both', false, 'List agent/tool availability', legacy),
  def(
    'tool.doctor',
    toolDoctor,
    'both',
    false,
    'Check that the engineering tools are installed and working (currently OpenSCAD): path, version and any error. Use it when a CAD call fails because a tool is missing. Returns one result per tool.',
    { summary: 'Check that OpenSCAD is installed and working.', example: {} },
  ),
  def(
    'tool.describe',
    toolDescribe,
    'both',
    false,
    'Look up tools. With no arguments it returns the catalogue: every tool with its pack and a one-line summary. With tool it returns the full input schema of that tool and an example call. Add artifactType to also get the payload fields of that artifact type, which you need before artifact_create_draft or artifact_update_draft. Example: {"tool":"artifact_create_draft","artifactType":"requirement"}',
    {
      tier: 'core',
      pack: 'core',
      summary: 'List every tool, or with tool get its schema, an example and payload fields.',
      example: { tool: 'artifact_create_draft', artifactType: 'requirement' },
      compactSchema: toolDescribeCompact,
    },
  ),
  def(
    'tool.call',
    toolCall,
    'both',
    true,
    'Call any Omen Flow tool by name, including the ones not listed for this session. Take the name from the tool_describe catalogue and its arguments from tool_describe with that tool, then pass them as input. Returns exactly what the named tool returns, including its errors. Tools reserved for the human, such as approving a proposal, are refused. Example: {"tool":"wiring_validate","input":{"artifactId":"<wiring artifact id>"}}',
    {
      tier: 'core',
      pack: 'core',
      summary: 'Call any tool by name with its arguments, including tools not listed here.',
      example: { tool: 'wiring_validate', input: { artifactId: EX.artifact } },
      compactSchema: toolCallCompact,
    },
  ),

  def(
    'test.create_draft',
    testCreateDraft,
    'both',
    true,
    'Create a test artifact: a numbered procedure with expected outcomes and conditions, linked to the requirements it validates. It records the plan only. Returns the test artifact and its draft revision; record observations later with test_record_result.',
    {
      tier: 'standard',
      summary: 'Create a test procedure draft linked to the requirements it validates.',
      example: {
        title: 'Payload lift test',
        procedure: [
          {
            step: 1,
            instruction: 'Load 0.3 kg on the tray and drive 5 m',
            expected: 'Completes the run without tipping',
          },
        ],
        requirementRefs: [{ artifactId: EX.artifact }],
      },
    },
  ),
  def(
    'test.record_result',
    testRecordResult,
    'both',
    true,
    'Record one observation on a test artifact: what was observed, the outcome and the kind of evidence. Record only what was actually observed or measured, and never invent a run. Your result is saved as a draft revision for the human to review; earlier results are kept.',
    {
      tier: 'standard',
      summary: 'Record an actual observation and outcome on a test artifact.',
      example: {
        artifactId: EX.artifact,
        evidenceKind: 'measured',
        observation: 'Carried 0.3 kg for 5 m in 12 s without tipping',
        result: 'passed',
      },
    },
  ),

  def(
    'build.preview',
    buildPreview,
    'both',
    false,
    'Preview the build package: every artifact with the revision that would be exported and the issues that hold it back (no approved revision, stale inputs, unverified CAD, unresolved assumption, pending proposal). Read-only. Returns the items and counts.',
    { summary: 'Preview the build package and the issues that hold it back.', example: {} },
  ),
  def(
    'build.export',
    buildExport,
    'both',
    true,
    'Export the build package as a ZIP file. Use it only when the person asked for an export. It fails while issues remain unless includeDrafts is true, and the package is then labelled DRAFT. Returns the path, file count and status.',
    {
      summary: 'Export the build package as a ZIP; only when asked.',
      example: { destPath: 'exports/rover-build.zip' },
    },
  ),

  def(
    'ui.open_artifact',
    uiOpenArtifact,
    'both',
    false,
    "Open an artifact in the person's workspace so they can see it. Use it sparingly, when the person asked to be shown something. Returns ok.",
    {
      summary: "Open an artifact in the person's workspace.",
      example: { artifactId: EX.artifact },
    },
  ),
  def(
    'ui.request_review',
    uiRequestReview,
    'both',
    false,
    "Bring a pending proposal to the person's attention in the workspace. Use it after proposal_submit when review was requested. It does not approve anything. Returns ok.",
    {
      summary: "Bring a pending proposal to the person's attention.",
      example: { proposalId: EX.proposal },
    },
  ),
  def(
    'ui.suggest_action',
    uiSuggestAction,
    'both',
    false,
    'Show the person a short suggested next step in the workspace, with an optional line of detail. Use it for a decision or action only the person can take. Returns ok.',
    {
      summary: 'Show the person a suggested next step in the workspace.',
      example: {
        title: 'Weigh the assembled chassis',
        detail: 'The mass budget uses an estimate.',
      },
    },
  ),
  def(
    'ui.focus_terminal',
    uiFocusTerminal,
    'both',
    false,
    'Bring the agent terminal to the front of the workspace. Use it when you need the person to read or answer something there. Returns ok.',
    { summary: 'Bring the agent terminal to the front.', example: {} },
  ),

  def(
    'chat.present',
    chatPresent,
    'both',
    true,
    'Present a safe inline card in your owning conversation turn. Artifact references are resolved to exact project revisions. Charts are explicitly illustrative, never evidence. Only supported declarative kinds are accepted; no HTML or code. Does not launch work or approve anything.',
    {
      agentVisible: false,
      pack: 'ui',
      summary: 'Present an inline artifact, chart, form, choice or human review.',
      example: { part: { kind: 'artifact', artifactId: EX.artifact } },
    },
  ),
  def(
    'chat.open',
    chatOpen,
    'user',
    true,
    'Add a compact recorded card to a conversation without starting an agent',
  ),
  def(
    'chat.read',
    chatRead,
    'user',
    false,
    'Read durable project conversations and actual run state',
  ),
  def(
    'chat.send',
    chatSend,
    'user',
    true,
    'Accept one deduplicated request and run a structured headless agent',
  ),
  def(
    'chat.cancel',
    chatCancel,
    'user',
    true,
    'Cancel and settle the owned conversation process tree',
  ),
  def('terminal.start', terminalStart, 'user', true, 'Start an agent session in the PTY'),
  def('terminal.write', terminalWrite, 'user', true, 'Write input bytes to the PTY'),
  def('terminal.resize', terminalResize, 'user', true, 'Resize the PTY'),
  def('terminal.interrupt', terminalInterrupt, 'user', true, 'Send interrupt to the session'),
  def('terminal.stop', terminalStop, 'user', true, 'Stop the owned session tree'),
  def('terminal.restart', terminalRestart, 'user', true, 'Restart the agent session'),
  def('terminal.state', terminalState, 'user', false, 'Read terminal/session state'),

  def('connection.list', connectionList, 'user', false, 'List adapter/tool connection status'),
  def('connection.test', connectionTest, 'user', true, 'Run a live bridge connection test'),
  def(
    'connection.configure',
    connectionConfigure,
    'user',
    true,
    'Configure adapter executable, args, env, model and capability profile',
  ),
  def(
    'agent.activity',
    agentActivity,
    'user',
    false,
    'Read the recorded agent calls and per-session summaries',
  ),

  def('settings.get', settingsGet, 'user', false, 'Read application settings'),
  def('settings.set', settingsSet, 'user', true, 'Write an application setting'),
];

export const OPS_BY_NAME = new Map(OPS.map((op) => [op.name, op]));
const OPS_BY_TOOL = new Map(OPS.map((op) => [op.toolName, op]));

/** Find an op by its dotted name or its underscore tool name. */
export function resolveOp(name: string): OpDef | undefined {
  return OPS_BY_NAME.get(name) ?? OPS_BY_TOOL.get(name);
}

/**
 * Operations added in V1 that only the Rust host implements. The legacy
 * TypeScript core answers them with a typed error instead of a result.
 */
export const RUST_HOST_OPS: ReadonlySet<string> = new Set([
  'work.status',
  'project.coverage',
  'guide.read',
  'tool.call',
  'agent.activity',
  'graph.remove_edges',
  'chat.read',
  'chat.present',
  'chat.open',
  'chat.send',
  'chat.cancel',
]);

/** JSON-schema view of an op's input (for CLI --help and tool_describe). Accepts either name form. */
export function describeOp(
  name: string,
  artifactType?: ArtifactType,
): {
  op: string;
  tool: string;
  description: string;
  mutating: boolean;
  tier: OpTier;
  pack: OpPack;
  summary: string;
  example: Record<string, unknown> | null;
  inputSchema: unknown;
  payloadSchema?: unknown;
} | null {
  const op = resolveOp(name);
  if (!op) return null;
  return {
    op: op.name,
    tool: op.toolName,
    description: op.description,
    mutating: op.mutating,
    tier: op.tier,
    pack: op.pack,
    summary: op.summary,
    example: op.example,
    inputSchema: zodToJsonSchema(op.input, { $refStrategy: 'none' }),
    ...(artifactType
      ? {
          payloadSchema: zodToJsonSchema(artifactPayloadSchemas[artifactType], {
            $refStrategy: 'none',
          }),
        }
      : {}),
  };
}

/** Shared ops an agent may call: everything `both` except the interactive research browser. */
function agentAllowed(op: OpDef): boolean {
  return (
    op.capability === 'both' &&
    (!/^(browser|research)\./.test(op.name) || op.name === 'research.read_page')
  );
}

/** Operations an agent session may call. Everything else is user-only. */
export const AGENT_OPS = new Set(OPS.filter(agentAllowed).map((op) => op.name));

/** Subset of AGENT_OPS listed as tools (MCP). Hidden ops stay callable via `omenflow call`. */
export const AGENT_TOOL_OPS = new Set(
  OPS.filter((op) => agentAllowed(op) && op.agentVisible).map((op) => op.name),
);

export function opAllowed(name: string, capability: 'user' | 'agent'): boolean {
  const op = OPS_BY_NAME.get(name);
  if (!op) return false;
  return capability === 'user' || agentAllowed(op);
}
