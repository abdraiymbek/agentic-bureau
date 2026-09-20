import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  artifactTypeSchema,
  connectionSchema,
  evidenceKindSchema,
  pinSchema,
  proposedChangeSchema,
  relationshipSchema,
  reviewStateSchema,
} from './entities.js';
import { idSchema, revisionRefSchema } from './ids.js';
import { expectationSchema } from './cad.js';
import { maybeQuantitySchema, moneySchema, quantitySchema } from './units.js';

/**
 * Capability levels. `user` ops are never exposed to agent sessions;
 * `both` ops are shared. The bridge enforces this on every call.
 */
export type Capability = 'user' | 'both';

export interface OpDef {
  name: string;
  input: z.ZodTypeAny;
  capability: Capability;
  /** True for ops that mutate project state (require idempotency key). */
  mutating: boolean;
  description: string;
  /**
   * False for ops that remain callable (CLI, GUI, `omenflow call`) but are
   * not listed as agent tools because a clearer tool supersedes them.
   * Keeps the agent's tool vocabulary small and unambiguous.
   */
  agentVisible: boolean;
}

const idem = { idempotencyKey: z.string().optional() };

/* ------------------------------- project ------------------------------- */

const projectCreate = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  intent: z.string().default(''),
});
const projectOpen = z.object({ path: z.string().min(1) });
const projectRename = z.object({ name: z.string().min(1) });
const projectSummary = z.object({ budget: z.number().int().positive().default(6000) });
const projectSearch = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(100).default(20),
});
const projectChangesSince = z.object({ seq: z.number().int().nonnegative() });
const projectExportArchive = z.object({ destPath: z.string().min(1) });
const projectImportArchive = z.object({
  archivePath: z.string().min(1),
  destDir: z.string().min(1),
  newIdentity: z.boolean().default(false),
});
const projectUpdateIntent = z.object({ intent: z.string() });

/* ------------------------------- artifact ------------------------------ */

const artifactList = z.object({
  type: artifactTypeSchema.optional(),
  subsystem: z.string().optional(),
  includeArchived: z.boolean().default(false),
  limit: z.number().int().positive().max(500).default(200),
  offset: z.number().int().nonnegative().default(0),
});
const artifactRead = z.object({ artifactId: idSchema, revisionId: idSchema.optional() });
const artifactHistory = z.object({ artifactId: idSchema });
const artifactCompare = z.object({
  artifactId: idSchema,
  fromRevisionId: idSchema,
  toRevisionId: idSchema,
});
const artifactCreateDraft = z.object({
  type: artifactTypeSchema,
  title: z.string().min(1),
  subsystem: z.string().nullable().optional(),
  payload: z.unknown(),
  files: z
    .array(
      z.object({
        path: z.string(),
        contentBase64: z.string().optional(),
        sourcePath: z.string().optional(),
      }),
    )
    .default([]),
  inputs: z
    .array(
      z.object({
        artifactId: idSchema,
        revisionId: idSchema.optional(),
        relationship: relationshipSchema.optional(),
        label: z.string().optional(),
      }),
    )
    .default([]),
  rationale: z.string().default(''),
  ...idem,
});
const artifactUpdateDraft = z.object({
  artifactId: idSchema,
  /** Required when artifact already has a baseline — the draft must build on it. */
  baseRevisionId: idSchema.optional(),
  draftRevisionId: idSchema.optional(),
  title: z.string().optional(),
  payload: z.unknown().optional(),
  files: z
    .array(
      z.object({
        path: z.string(),
        contentBase64: z.string().optional(),
        sourcePath: z.string().optional(),
      }),
    )
    .optional(),
  inputs: z
    .array(
      z.object({
        artifactId: idSchema,
        revisionId: idSchema.optional(),
        relationship: relationshipSchema.optional(),
        label: z.string().optional(),
      }),
    )
    .optional(),
  rationale: z.string().optional(),
  ...idem,
});
const artifactImportFile = z.object({
  artifactId: idSchema.optional(),
  type: artifactTypeSchema.optional(),
  title: z.string().optional(),
  path: z.string().min(1),
  rationale: z.string().default(''),
  ...idem,
});
/** User-only: accept an existing draft revision as baseline (implicit approve). */
const artifactAcceptDraft = z.object({
  artifactId: idSchema,
  draftRevisionId: idSchema,
  rationale: z.string().default(''),
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
  artifactId: idSchema,
  path: z.string().min(1),
  revisionId: idSchema.optional(),
});
const artifactSetSubsystem = z.object({
  artifactId: idSchema,
  subsystem: z.string().nullable(),
  ...idem,
});

/* ------------------------------- graph --------------------------------- */

const graphNeighbors = z.object({
  artifactId: idSchema,
  direction: z.enum(['upstream', 'downstream', 'both']).default('both'),
  depth: z.number().int().positive().max(10).default(1),
  relationship: relationshipSchema.optional(),
});
const graphImpact = z.object({ refs: z.array(revisionRefSchema).min(1) });
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
    .min(1),
  ...idem,
});
const graphList = z.object({});

/* ------------------------------- sources / research -------------------- */

const sourceCapture = z.object({
  url: z.string().optional(),
  filePath: z.string().optional(),
  title: z.string(),
  publisher: z.string().optional(),
  locator: z.string().optional(),
  excerpt: z.string().optional(),
  sourceKind: z
    .enum(['manufacturer', 'supplier', 'datasheet', 'article', 'user_import', 'note', 'other'])
    .default('other'),
  ...idem,
});
const sourceRead = z.object({ sourceId: idSchema });
const researchSearch = z.object({ query: z.string().min(1), engine: z.string().optional() });
const researchReadPage = z.object({ url: z.string().min(1) });
const browserOpen = z.object({ url: z.string().min(1) });
const browserRead = z.object({});
const browserFollowLink = z.object({ selector: z.string().optional(), url: z.string().optional() });
const browserCapture = z.object({ title: z.string().optional(), excerpt: z.string().optional() });
const browserScreenshot = z.object({});

/* ------------------------------- components / BOM ---------------------- */

const componentAddCandidate = z.object({
  title: z.string().min(1),
  manufacturer: z.string().optional(),
  vendor: z.string().optional(),
  partNumber: z.string().min(1),
  description: z.string().optional(),
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
    .default({}),
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
  offer: z
    .object({
      seller: z.string(),
      url: z.string().optional(),
      price: moneySchema.nullable().default(null),
      quantityBasis: z.number().positive().default(1),
      availabilityText: z.string().optional(),
      sourceId: idSchema.optional(),
    })
    .optional(),
  sourceId: idSchema.optional(),
  alternativeTo: idSchema.optional(),
  ...idem,
});
const componentCompare = z.object({ artifactIds: z.array(idSchema).min(1) });
const componentProposeSelection = z.object({
  artifactId: idSchema,
  revisionId: idSchema,
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
    .min(1),
  replacesArtifactId: idSchema.optional(),
  reason: z.string(),
  ...idem,
});
const componentAddOffer = z.object({
  artifactId: idSchema,
  seller: z.string(),
  url: z.string().optional(),
  price: moneySchema.nullable().default(null),
  quantityBasis: z.number().positive().default(1),
  availabilityText: z.string().optional(),
  sourceId: idSchema.optional(),
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
    .min(1),
  reason: z.string(),
  ...idem,
});
const bomExport = z.object({ format: z.enum(['csv', 'markdown']).default('markdown') });
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
    .describe('Point on an oblique cutting plane [x,y,z] mm. Use with `normal` for inclined holes.'),
  normal: z
    .array(z.number())
    .length(3)
    .optional()
    .describe('Normal of an oblique cutting plane. Use with `origin` when the cut is not axis-aligned.'),
});

const cadWriteSource = z.object({
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
  subsystem: z.string().nullable().optional(),
  rationale: z.string().default('').describe('One line on what this revision changes and why.'),
  timeoutMs: z.number().int().positive().max(300_000).default(90_000).describe('Render timeout.'),
  ...idem,
});
const cadReadSource = z.object({
  artifactId: idSchema,
  revisionId: idSchema.optional().describe('Defaults to the newest revision.'),
});
const cadInspect = z.object({
  artifactId: idSchema,
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
});
const cadCheck = z.object({
  artifactId: idSchema,
  revisionId: idSchema.optional().describe('Defaults to the newest revision.'),
  params: scadParams
    .optional()
    .describe('Check a parameter variant instead of the recorded values (nothing is committed).'),
  expect: expectationSchema.describe(
    'What must be true of the part, taken from the request: envelope, volume, solid/empty points, cross-section holes and outlines.',
  ),
});
const cadExport = z.object({
  artifactId: idSchema,
  destPath: z.string().min(1),
  format: z.enum(['stl', 'scad']).default('stl'),
});
const cadPatchSource = z.object({
  artifactId: idSchema.describe('Existing mechanical part to edit.'),
  oldString: z
    .string()
    .min(1)
    .describe('Exact snippet to replace. Must occur exactly once in the current source.'),
  newString: z.string().describe('Replacement text (may be empty to delete the snippet).'),
  rationale: z.string().default('').describe('One line on what this edit changes and why.'),
  timeoutMs: z.number().int().positive().max(300_000).default(90_000).describe('Render timeout.'),
  ...idem,
});
const cadSetParam = z.object({
  artifactId: idSchema.describe('Existing mechanical part to edit.'),
  name: z
    .string()
    .min(1)
    .describe('File-scope parameter name from cad.read_source (e.g. hole_d).'),
  value: z
    .union([z.number(), z.string(), z.boolean()])
    .describe('New literal value written into the source assignment.'),
  rationale: z.string().default('').describe('One line on why this dimension changed.'),
  timeoutMs: z.number().int().positive().max(300_000).default(90_000).describe('Render timeout.'),
  ...idem,
});
const cadCompose = z.object({
  title: z.string().min(1).describe('Name of the assembled part.'),
  instances: z
    .array(
      z.object({
        artifactId: idSchema.describe('Existing mechanical part to place.'),
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
    .describe('Parts to place. Each source is wrapped in its own module so file-scope names do not collide.'),
  rationale: z.string().default('').describe('One line on why these parts are placed together.'),
  timeoutMs: z.number().int().positive().max(300_000).default(90_000).describe('Render timeout.'),
  ...idem,
});

/* ------------------------------- calculation --------------------------- */

const calculationRun = z.object({
  artifactId: idSchema.optional(),
  templateId: z.string().optional(),
  expression: z.string().optional(),
  inputs: z
    .array(
      z.object({
        name: z.string(),
        quantity: maybeQuantitySchema,
        sourceRef: revisionRefSchema.optional(),
        literal: z.boolean().default(false),
      }),
    )
    .default([]),
  assumptions: z.array(z.string()).default([]),
  title: z.string().optional(),
  submitForReview: z.boolean().default(true),
  ...idem,
});
const calculationExplainInputs = z.object({ artifactId: idSchema });
const calculationTemplates = z.object({});

/* ------------------------------- wiring -------------------------------- */

const wiringValidate = z.object({ artifactId: idSchema, revisionId: idSchema.optional() });
const wiringRender = z.object({ artifactId: idSchema, revisionId: idSchema.optional() });
const wiringSetPins = z.object({
  artifactId: idSchema,
  pins: z.array(pinSchema),
  baseRevisionId: idSchema.optional(),
  ...idem,
});
const wiringSetConnections = z.object({
  artifactId: idSchema,
  connections: z.array(connectionSchema),
  baseRevisionId: idSchema.optional(),
  ...idem,
});

/* ------------------------------- proposals ----------------------------- */

const proposalSubmit = z.object({
  changes: z.array(proposedChangeSchema).min(1),
  reason: z.string(),
  ...idem,
});
const proposalRead = z.object({ proposalId: idSchema });
const proposalWait = z.object({
  proposalId: idSchema,
  timeoutMs: z.number().int().positive().max(600_000).default(60_000),
  cursor: z.number().int().nonnegative().optional(),
});
const proposalList = z.object({
  state: z
    .enum(['pending', 'accepted', 'rejected', 'changes_requested', 'conflicted', 'cancelled'])
    .optional(),
});
const proposalApprove = z.object({
  proposalId: idSchema,
  rationale: z.string().default(''),
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

/* ------------------------------- jobs / tools -------------------------- */

const jobRead = z.object({ jobId: idSchema });
const jobCancel = z.object({ jobId: idSchema });
const jobList = z.object({
  status: z.string().optional(),
  limit: z.number().int().positive().max(200).default(50),
});
const toolList = z.object({});
const toolDoctor = z.object({ toolId: z.string().optional() });
const toolDescribe = z.object({
  op: z.string().min(1).describe('Operation name, e.g. "cad.check" (tool names use `_` for `.`).'),
});

/* ------------------------------- tests --------------------------------- */

const testCreateDraft = z.object({
  title: z.string().min(1),
  procedure: z
    .array(
      z.object({
        step: z.number().int(),
        instruction: z.string(),
        expected: z.string().optional(),
      }),
    )
    .min(1),
  requirementRefs: z.array(revisionRefSchema).default([]),
  conditions: z.string().optional(),
  ...idem,
});
const testRecordResult = z.object({
  artifactId: idSchema,
  requirementRef: revisionRefSchema.optional(),
  evidenceKind: evidenceKindSchema,
  observation: z.string(),
  result: z.enum(['planned', 'not_run', 'passed', 'failed', 'inconclusive']),
  conditions: z.string().optional(),
  attachments: z
    .array(
      z.object({
        path: z.string(),
        sourcePath: z.string().optional(),
        contentBase64: z.string().optional(),
      }),
    )
    .default([]),
  measurementOrigin: z.string().optional(),
  ...idem,
});

/* ------------------------------- build --------------------------------- */

const buildPreview = z.object({});
const buildExport = z.object({
  destPath: z.string().min(1),
  includeDrafts: z.boolean().default(false),
  label: z.string().optional(),
  ...idem,
});

/* ------------------------------- ui ------------------------------------ */

const uiOpenArtifact = z.object({ artifactId: idSchema });
const uiRequestReview = z.object({ proposalId: idSchema });
const uiSuggestAction = z.object({ title: z.string(), detail: z.string().optional() });
const uiFocusTerminal = z.object({});

/* ------------------------------- terminal / connections (user scope) --- */

const terminalStart = z.object({
  adapterId: z.string(),
  executablePath: z.string().optional(),
  args: z.array(z.string()).optional(),
});
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
});

const settingsGet = z.object({ key: z.string().optional() });
const settingsSet = z.object({ key: z.string(), value: z.unknown() });

const appRecentProjects = z.object({});
const appDiagnostics = z.object({});

/* ------------------------------- registry ------------------------------ */

function def(
  name: string,
  input: z.ZodTypeAny,
  capability: Capability,
  mutating: boolean,
  description: string,
  opts?: { agentVisible?: boolean },
): OpDef {
  return {
    name,
    input,
    capability,
    mutating,
    description,
    agentVisible: opts?.agentVisible ?? true,
  };
}

/** Superseded for agents by the cad.* verification vocabulary; still valid ops. */
const legacy = { agentVisible: false };

export const OPS: OpDef[] = [
  def('project.create', projectCreate, 'user', true, 'Create a project at a folder path'),
  def('project.open', projectOpen, 'user', false, 'Open an existing project folder'),
  def('project.rename', projectRename, 'user', true, 'Rename the active project'),
  def('project.update_intent', projectUpdateIntent, 'user', true, 'Update project intent'),
  def('project.summary', projectSummary, 'both', false, 'Bounded structured project summary'),
  def('project.search', projectSearch, 'both', false, 'Full-text search over project records'),
  def(
    'project.changes_since',
    projectChangesSince,
    'both',
    false,
    'Events after a sequence cursor',
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

  def('artifact.list', artifactList, 'both', false, 'List artifacts with freshness'),
  def('artifact.read', artifactRead, 'both', false, 'Read an artifact revision'),
  def('artifact.history', artifactHistory, 'both', false, 'Revision history'),
  def('artifact.compare', artifactCompare, 'both', false, 'Compare two revisions'),
  def(
    'artifact.create_draft',
    artifactCreateDraft,
    'both',
    true,
    'Create a non-CAD artifact (requirement, assumption, component, note, test…) with its first draft revision. For parts use cad.write_source.',
  ),
  def(
    'artifact.update_draft',
    artifactUpdateDraft,
    'both',
    true,
    'Create a new draft revision on an existing non-CAD artifact (payload/files/inputs). For parts use cad.write_source.',
  ),
  def(
    'artifact.import_file',
    artifactImportFile,
    'both',
    true,
    'Import a project file as a draft artifact revision (non-CAD files). For OpenSCAD parts use cad.write_source.',
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
    'Read an artifact file (base64) by project-relative path',
  ),
  def(
    'artifact.set_subsystem',
    artifactSetSubsystem,
    'user',
    true,
    'Move artifact between subsystems',
  ),

  def('graph.neighbors', graphNeighbors, 'both', false, 'Bounded graph neighborhood'),
  def('graph.impact', graphImpact, 'both', false, 'Impact report for changed revisions'),
  def('graph.propose_edges', graphProposeEdges, 'both', true, 'Propose/add dependency edges'),
  def('graph.list', graphList, 'both', false, 'All edges for graph/list views'),

  def('source.capture', sourceCapture, 'both', true, 'Capture a URL/file as a source'),
  def('source.read', sourceRead, 'both', false, 'Read a source record'),
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
    'Read current research page text/links',
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
    'Add a sourced component candidate',
  ),
  def('component.compare', componentCompare, 'both', false, 'Side-by-side property comparison'),
  def(
    'component.propose_selection',
    componentProposeSelection,
    'both',
    true,
    'Propose selecting a component',
  ),
  def('component.add_offer', componentAddOffer, 'both', true, 'Add a seller offer observation'),
  def('bom.read', bomRead, 'both', false, 'Read live BOM with totals'),
  def('bom.propose_edit', bomProposeEdit, 'both', true, 'Propose BOM line changes'),
  def('bom.update_line', bomUpdateLine, 'user', true, 'User inline BOM line edit'),
  def('bom.remove_line', bomRemoveLine, 'user', true, 'User remove BOM line'),
  def('bom.export', bomExport, 'both', false, 'Export BOM as CSV/Markdown'),

  def('cad.probe', cadProbe, 'both', false, 'Probe CAD tool availability', legacy),
  def(
    'cad.validate_source',
    cadValidateSource,
    'both',
    false,
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
    'Create or revise a part from OpenSCAD source. Saves the source as a new draft revision, renders it with OpenSCAD, and returns a measured geometry report (envelope, volume, watertightness, mid-plane cross-sections with holes/outlines, detected parameters, render warnings). Use this for every geometry change; then verify with cad.check.',
  ),
  def(
    'cad.read_source',
    cadReadSource,
    'both',
    false,
    'Read the OpenSCAD source of a part as plain text, with its top-level parameters and revision info. Use before modifying an existing part.',
  ),
  def(
    'cad.inspect',
    cadInspect,
    'both',
    false,
    'Measure a rendered part: envelope, volume, watertightness, body count, cross-sections at chosen planes (axis-aligned axis/at, or oblique origin+normal for inclined holes), and solid/empty classification of probe points. Optionally re-render with parameter overrides. Read-only.',
  ),
  def(
    'cad.check',
    cadCheck,
    'both',
    false,
    'Verify a part against explicit expectations derived from the request (envelope, volume, solid/empty points, holes and outlines in cross-sections, optional preserve vs the parent revision). Returns PASS/FAIL per assertion with measured vs expected values. A part is done only when its checks pass.',
  ),
  def(
    'cad.patch_source',
    cadPatchSource,
    'both',
    true,
    'Replace one unique snippet in an existing part\'s OpenSCAD source and re-render. Use for a small, local edit instead of rewriting the whole file. The snippet must appear exactly once.',
  ),
  def(
    'cad.set_param',
    cadSetParam,
    'both',
    true,
    'Change one file-scope OpenSCAD assignment (name = value;) and re-render. Prefer this over rewriting the whole file when only a dimension changes.',
  ),
  def(
    'cad.compose',
    cadCompose,
    'both',
    true,
    'Place existing parts together with translate/rotate (no mates, no STEP). Each part\'s source is wrapped in a module so its variables stay isolated. Returns a new mechanical artifact with the combined mesh.',
  ),
  def('cad.export', cadExport, 'user', false, 'Export STL/SCAD file to a chosen path'),

  def('calculation.run', calculationRun, 'both', true, 'Run a unit-aware calculation'),
  def(
    'calculation.explain_inputs',
    calculationExplainInputs,
    'both',
    false,
    'Explain inputs and their provenance',
  ),
  def('calculation.templates', calculationTemplates, 'both', false, 'List calculation templates'),

  def('wiring.validate', wiringValidate, 'both', false, 'Run wiring checks'),
  def('wiring.render', wiringRender, 'both', false, 'Derived wiring table + diagram'),
  def('wiring.set_pins', wiringSetPins, 'both', true, 'Set component pins on a wiring draft'),
  def(
    'wiring.set_connections',
    wiringSetConnections,
    'both',
    true,
    'Set connections on a wiring draft',
  ),

  def('proposal.submit', proposalSubmit, 'both', true, 'Submit an immutable proposal'),
  def('proposal.read', proposalRead, 'both', false, 'Read a proposal'),
  def('proposal.wait', proposalWait, 'both', false, 'Bounded wait for proposal resolution'),
  def('proposal.list', proposalList, 'both', false, 'List proposals'),
  def('proposal.approve', proposalApprove, 'user', true, 'Approve a proposal (human only)'),
  def('proposal.reject', proposalReject, 'user', true, 'Reject a proposal (human only)'),
  def(
    'proposal.request_changes',
    proposalRequestChanges,
    'user',
    true,
    'Request changes on a proposal',
  ),

  def('job.read', jobRead, 'both', false, 'Read job status/log', legacy),
  def('job.cancel', jobCancel, 'both', true, 'Cancel an owned job', legacy),
  def('job.list', jobList, 'both', false, 'List jobs', legacy),
  def('tool.list', toolList, 'both', false, 'List agent/tool availability', legacy),
  def('tool.doctor', toolDoctor, 'both', false, 'Run diagnostics for tools'),
  def(
    'tool.describe',
    toolDescribe,
    'both',
    false,
    'Describe an operation: purpose and JSON schema of its input. Use when unsure how to call a tool.',
  ),

  def('test.create_draft', testCreateDraft, 'both', true, 'Create a test procedure draft'),
  def('test.record_result', testRecordResult, 'both', true, 'Record a test result/observation'),

  def('build.preview', buildPreview, 'both', false, 'Preview build package contents/status'),
  def('build.export', buildExport, 'both', true, 'Export a build package ZIP'),

  def('ui.open_artifact', uiOpenArtifact, 'both', false, 'Open an artifact in the workspace'),
  def('ui.request_review', uiRequestReview, 'both', false, 'Surface a proposal for user review'),
  def('ui.suggest_action', uiSuggestAction, 'both', false, 'Add a suggested next action'),
  def('ui.focus_terminal', uiFocusTerminal, 'both', false, 'Focus the agent terminal'),

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
    'Configure adapter executable/args/env',
  ),

  def('settings.get', settingsGet, 'user', false, 'Read application settings'),
  def('settings.set', settingsSet, 'user', true, 'Write an application setting'),
];

export const OPS_BY_NAME = new Map(OPS.map((op) => [op.name, op]));

/** JSON-schema view of an op's input (for CLI --help and tool.describe). */
export function describeOp(name: string): {
  op: string;
  tool: string;
  description: string;
  mutating: boolean;
  inputSchema: unknown;
} | null {
  const op = OPS_BY_NAME.get(name) ?? OPS_BY_NAME.get(name.replace(/_/g, '.'));
  if (!op) return null;
  return {
    op: op.name,
    tool: op.name.replace(/\./g, '_'),
    description: op.description,
    mutating: op.mutating,
    inputSchema: zodToJsonSchema(op.input, { $refStrategy: 'none' }),
  };
}

/** Operations an agent session may call. Everything else is user-only. */
export const AGENT_OPS = new Set(OPS.filter((op) => op.capability === 'both').map((op) => op.name));

/** Subset of AGENT_OPS listed as tools (MCP). Hidden ops stay callable via `omenflow call`. */
export const AGENT_TOOL_OPS = new Set(
  OPS.filter((op) => op.capability === 'both' && op.agentVisible).map((op) => op.name),
);

export function opAllowed(name: string, capability: 'user' | 'agent'): boolean {
  const op = OPS_BY_NAME.get(name);
  if (!op) return false;
  return capability === 'user' || op.capability === 'both';
}
