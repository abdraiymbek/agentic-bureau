import fs from 'node:fs';
import path from 'node:path';
import {
  ErrorCodes,
  EXPECTATION_SHORT_FORM_KEYS,
  OPS_BY_NAME,
  Origin,
  RUST_HOST_OPS,
  describeOp,
  OmenflowError,
  okResponse,
  errResponse,
  type ResponseEnvelope,
  type OmenflowErrorBody,
} from '@omenflow/contracts';
import type { ProjectContext } from './context.js';
import * as artifacts from './artifacts.js';
import * as proposals from './proposals.js';
import * as components from './components.js';
import * as graph from './graph.js';
import * as sources from './sources.js';
import * as research from './research.js';
import * as cad from './cad.js';
import * as calc from './calc.js';
import * as wiring from './wiring.js';
import * as tests from './tests.js';
import * as build from './build.js';
import * as summary from './summary.js';
import { newId } from '@omenflow/contracts';
import {
  clearResultJournal,
  hashRequest,
  readResultJournal,
  runDurabilityHooks,
  writeResultJournal,
} from './durability.js';

export interface DispatchInput {
  op: string;
  payload: unknown;
  origin: Origin;
  idempotencyKey?: string;
  requestId?: string;
}

type Handler = (ctx: ProjectContext, input: never, origin: Origin) => unknown | Promise<unknown>;

const H: Record<string, Handler> = {
  /* context */
  'project.summary': (c, i: { budget: number }) => summary.projectSummary(c, i.budget),
  'project.search': (c, i: { query: string; limit: number }) => summary.search(c, i.query, i.limit),
  'project.changes_since': (c, i: { seq: number }) => summary.changesSince(c, i.seq),
  'project.export_archive': (
    c,
    i: { destPath: string; includeTerminalHistory: boolean; grantTerminalExportConsent: boolean },
  ) =>
    build.exportArchive(c, i.destPath, {
      includeTerminalHistory: i.includeTerminalHistory,
      grantTerminalExportConsent: i.grantTerminalExportConsent,
    }),

  /* artifacts */
  'artifact.list': (
    c,
    i: {
      type?: string;
      subsystem?: string;
      includeArchived: boolean;
      limit: number;
      offset: number;
    },
  ) => {
    const list = c.repo
      .listArtifacts({ type: i.type, subsystem: i.subsystem, includeArchived: i.includeArchived })
      .slice(i.offset, i.offset + i.limit)
      .map((a) => c.artifactView(a));
    return { artifacts: list };
  },
  'artifact.read': (c, i: { artifactId: string; revisionId?: string }) => {
    const a = c.requireArtifact(i.artifactId);
    const rev = i.revisionId
      ? c.requireRevision(i.revisionId)
      : a.selectedRevisionId
        ? c.repo.getRevision(a.selectedRevisionId)
        : (c.repo.listRevisions(a.id).at(-1) ?? null);
    if (rev && rev.artifactId !== a.id)
      throw new OmenflowError(ErrorCodes.VALIDATION, 'Revision does not belong to artifact');
    return { view: c.artifactView(a), revision: rev, drafts: c.repo.listDrafts(a.id) };
  },
  'artifact.history': (c, i: { artifactId: string }) => ({
    revisions: c.repo.listRevisions(i.artifactId),
  }),
  'artifact.compare': (
    c,
    i: { artifactId: string; fromRevisionId: string; toRevisionId: string },
  ) => artifacts.compareRevisions(c, i.artifactId, i.fromRevisionId, i.toRevisionId),
  'artifact.create_draft': (c, i: never, o) => artifacts.createDraft(c, i as never, o),
  'artifact.update_draft': (c, i: never, o) => artifacts.updateDraft(c, i as never, o),
  'artifact.import_file': (
    c,
    i: { artifactId?: string; type?: string; title?: string; path: string; rationale: string },
    o,
  ) => {
    const abs = c.resolvePath(i.path);
    if (i.artifactId) {
      return artifacts.updateDraft(
        c,
        {
          artifactId: i.artifactId,
          files: [{ path: i.path, sourcePath: abs }],
          rationale: i.rationale,
        },
        o,
      );
    }
    if (!i.type || !i.title)
      throw new OmenflowError(
        ErrorCodes.VALIDATION,
        'import_file needs type+title for new artifacts',
      );
    return artifacts.createDraft(
      c,
      {
        type: i.type as never,
        title: i.title,
        payload: {},
        files: [{ path: i.path, sourcePath: abs }],
        inputs: [],
        rationale: i.rationale,
      },
      o,
    );
  },
  'artifact.apply_edit': (c, i: never) => artifacts.applyUserEdit(c, i as never),
  'artifact.accept_draft': (c, i: never) => artifacts.acceptDraft(c, i as never),
  'artifact.revert': (c, i: { artifactId: string; toRevisionId: string; rationale: string }) =>
    artifacts.revertArtifact(c, i.artifactId, i.toRevisionId, i.rationale),
  'artifact.archive': (c, i: { artifactId: string; archived: boolean }) =>
    c.repo.tx(() => {
      c.assertWritable();
      c.requireArtifact(i.artifactId);
      c.repo.setArchived(i.artifactId, i.archived);
      const seq = c.emit('artifact.archived', 'user', i);
      graph.propagateFrom(c, [i.artifactId], seq);
      return { ok: true };
    }),
  'artifact.reveal': async (c, i: { artifactId: string }) => {
    const a = c.requireArtifact(i.artifactId);
    const rev = a.selectedRevisionId ? c.repo.getRevision(a.selectedRevisionId) : null;
    const f = rev?.files[0];
    if (!f) throw new OmenflowError(ErrorCodes.NOT_FOUND, 'Artifact has no file to reveal');
    await c.host.revealPath(c.resolvePath(f.path));
    return { ok: true };
  },
  'artifact.set_subsystem': (c, i: { artifactId: string; subsystem: string | null }) => {
    c.assertWritable();
    c.repo.updateArtifactSubsystem(i.artifactId, i.subsystem);
    return { ok: true };
  },
  'artifact.read_file': (c, i: { artifactId: string; path: string; revisionId?: string }) => {
    const a = c.requireArtifact(i.artifactId);
    const rev = i.revisionId
      ? c.requireRevision(i.revisionId)
      : a.selectedRevisionId
        ? c.repo.getRevision(a.selectedRevisionId)
        : c.repo
            .listRevisions(a.id)
            .slice()
            .reverse()
            .find((r) => !['rejected', 'superseded'].includes(r.reviewState));
    if (rev && rev.artifactId !== a.id)
      throw new OmenflowError(ErrorCodes.VALIDATION, 'Revision does not belong to artifact');
    const f = rev?.files.find((x) => x.path === i.path);
    if (!f) throw new OmenflowError(ErrorCodes.NOT_FOUND, `File not on revision: ${i.path}`);
    if (!f.sha256)
      throw new OmenflowError(
        ErrorCodes.NOT_FOUND,
        `Revision has no immutable bytes for ${i.path}; import the source to repair it`,
      );
    // A revision promises immutable bytes; a mutable working file cannot substitute for them.
    return { contentBase64: c.objects.read(f.sha256).toString('base64'), sha256: f.sha256 };
  },

  /* graph */
  'graph.neighbors': (
    c,
    i: {
      artifactId: string;
      direction: 'upstream' | 'downstream' | 'both';
      depth: number;
      relationship?: never;
    },
  ) => graph.neighbors(c, i.artifactId, i.direction, i.depth, i.relationship),
  'graph.impact': (
    c,
    i: { refs: never; limit?: number; offset?: number; includePaths?: boolean },
  ) =>
    graph.impactReport(c, i.refs, {
      limit: i.limit,
      offset: i.offset,
      includePaths: i.includePaths,
    }),
  'graph.propose_edges': (
    c,
    i: {
      edges: {
        upstreamArtifactId: string;
        downstreamArtifactId: string;
        relationship: never;
        label: string;
      }[];
    },
    o,
  ) => {
    c.assertWritable();
    return {
      edges: i.edges.map((e) =>
        graph.addEdge(
          c,
          e.upstreamArtifactId,
          e.downstreamArtifactId,
          e.relationship,
          e.label,
          o.kind,
        ),
      ),
    };
  },
  'graph.list': (c) => ({ edges: graph.listEdges(c) }),

  /* sources + research + browser */
  'source.capture': (c, i: never, o) => sources.captureSource(c, i as never, o),
  'source.read': (c, i: { sourceId: string }) => sources.readSource(c, i.sourceId),
  'research.search': (c, i: { query: string; engine?: string }) =>
    research.researchSearch(c, i.query, i.engine),
  'research.read_page': (c, i: { url: string }) => research.researchReadPage(c, i.url),
  'browser.open': (c, i: { url: string }) => research.browserOpen(c, i.url),
  'browser.read': (c) => research.browserRead(c),
  'browser.follow_link': (c, i: never) => research.browserFollowLink(c, i as never),
  'browser.capture': (c, i: never, o) => research.browserCapture(c, i as never, o),
  'browser.screenshot': (c) => research.browserScreenshot(c),

  /* components + bom */
  'component.add_candidate': (c, i: never, o) => components.addCandidate(c, i as never, o),
  'component.compare': (c, i: { artifactIds: string[] }) =>
    components.compareComponents(c, i.artifactIds),
  'component.propose_selection': (c, i: never, o) => components.proposeSelection(c, i as never, o),
  'component.add_offer': (c, i: never, o) => components.addOffer(c, i as never, o),
  'bom.read': (c) => components.readBom(c),
  'bom.propose_edit': (
    c,
    i: {
      lines: {
        componentArtifactId: string;
        componentRevisionId?: string;
        subsystem: string | null;
        quantity: number;
        offerId: string | null;
        location: string | null;
        notes: string;
      }[];
      reason: string;
    },
    o,
  ) => {
    // Represent BOM edits as a proposal carrying line sets.
    const lines = i.lines.map((l) => ({
      componentArtifactId: l.componentArtifactId,
      componentRevisionId:
        l.componentRevisionId ?? c.requireArtifact(l.componentArtifactId).selectedRevisionId!,
      subsystem: l.subsystem,
      quantity: l.quantity,
      offerId: l.offerId,
      location: l.location,
      notes: l.notes,
    }));
    // Anchor the proposal on a real artifact (first line's component) so the
    // change-set binds properly.
    const anchor = lines[0];
    if (!anchor) throw new OmenflowError(ErrorCodes.VALIDATION, 'No BOM lines');
    const comp = c.requireArtifact(anchor.componentArtifactId);
    const rev = c.requireRevision(anchor.componentRevisionId);
    const draft = artifacts.commitRevision(c, {
      artifactId: comp.id,
      parentId: rev.id,
      origin: o,
      payload: rev.payload,
      files: rev.files,
      inputs: rev.inputs,
      rationale: i.reason,
      reviewState: 'draft',
    });
    return proposals.submitProposal(
      c,
      {
        changes: [
          {
            artifactId: comp.id,
            baseRevisionId: rev.id,
            newRevisionId: draft.id,
            kind: 'bom_edit',
            bomLines: lines,
          },
        ],
        reason: i.reason,
      },
      o,
    );
  },
  'bom.update_line': (
    c,
    i: {
      lineId: string;
      quantity?: number;
      offerId?: string | null;
      location?: string | null;
      notes?: string;
    },
  ) => {
    c.assertWritable();
    c.repo.updateBomLine(i.lineId, i);
    c.emit('bom.changed', 'user', { lineId: i.lineId });
    return { ok: true };
  },
  'bom.remove_line': (c, i: { lineId: string }) => {
    c.assertWritable();
    c.repo.deleteBomLine(i.lineId);
    c.emit('bom.changed', 'user', { removed: i.lineId });
    return { ok: true };
  },
  'bom.export': (c, i: { format: 'csv' | 'markdown' }) =>
    i.format === 'csv' ? { content: components.bomCsv(c) } : { content: components.bomMarkdown(c) },

  /* cad */
  'cad.probe': (c) => cad.cadProbe(c),
  'cad.validate_source': (c, i: { artifactId: string; revisionId?: string }) =>
    cad.cadValidateSource(c, i.artifactId, i.revisionId),
  'cad.render': (c, i: never, o) => cad.cadRender(c, i as never, o),
  'cad.write_source': (c, i: never, o) => cad.cadWriteSource(c, i as never, o),
  'cad.read_source': (c, i: never) => cad.cadReadSource(c, i as never),
  'cad.inspect': (c, i: never, o) => cad.cadInspect(c, i as never, o),
  'cad.check': (c, i: never, o) => cad.cadCheck(c, i as never, o),
  'cad.patch_source': (c, i: never, o) => cad.cadPatchSource(c, i as never, o),
  'cad.set_param': (c, i: never, o) => cad.cadSetParam(c, i as never, o),
  'cad.compose': (c, i: never, o) => cad.cadCompose(c, i as never, o),
  'cad.export': (c, i: { artifactId: string; destPath: string; format: 'stl' | 'scad' }) => {
    const a = c.requireArtifact(i.artifactId);
    const rev = a.selectedRevisionId ? c.repo.getRevision(a.selectedRevisionId) : null;
    const f = rev?.files.find((x) => x.path.endsWith(`.${i.format}`));
    if (!f?.sha256) throw new OmenflowError(ErrorCodes.NOT_FOUND, `No .${i.format} on baseline`);
    fs.mkdirSync(path.dirname(i.destPath), { recursive: true });
    fs.writeFileSync(i.destPath, c.objects.read(f.sha256));
    return { path: i.destPath };
  },

  /* calculation */
  'calculation.run': (c, i: never, o) => calc.runCalculation(c, i as never, o),
  'calculation.explain_inputs': (c, i: { artifactId: string }) =>
    calc.explainInputs(c, i.artifactId),
  'calculation.templates': (c) => ({ templates: calc.listTemplates(c) }),

  /* wiring */
  'wiring.validate': (c, i: { artifactId: string; revisionId?: string }) =>
    wiring.wiringValidate(c, i.artifactId, i.revisionId),
  'wiring.render': (c, i: { artifactId: string; revisionId?: string }) =>
    wiring.wiringRender(c, i.artifactId, i.revisionId),
  'wiring.set_pins': (c, i: never, o) => wiring.wiringSetPins(c, i as never, o),
  'wiring.set_connections': (c, i: never, o) => wiring.wiringSetConnections(c, i as never, o),

  /* proposals */
  'proposal.submit': (c, i: never, o) => proposals.submitProposal(c, i as never, o),
  'proposal.read': (c, i: { proposalId: string }) => proposals.readProposal(c, i.proposalId),
  'proposal.wait': (c, i: { proposalId: string; timeoutMs: number; cursor?: number }) =>
    proposals.waitProposal(c, i.proposalId, i.timeoutMs, i.cursor),
  'proposal.list': (c, i: { state?: string }) => ({ proposals: c.repo.listProposals(i.state) }),
  'proposal.approve': (
    c,
    i: { proposalId: string; rationale: string; verificationEvidence?: Record<string, string> },
  ) => proposals.approveProposal(c, i.proposalId, i.rationale, i.verificationEvidence),
  'proposal.reject': (c, i: { proposalId: string; rationale: string }) =>
    proposals.rejectProposal(c, i.proposalId, i.rationale),
  'proposal.request_changes': (c, i: { proposalId: string; rationale: string }) =>
    proposals.requestChangesProposal(c, i.proposalId, i.rationale),

  /* jobs + tools */
  'job.read': (c, i: { jobId: string }) => {
    const j = c.repo.getJob(i.jobId);
    if (!j) throw new OmenflowError(ErrorCodes.NOT_FOUND, `Job not found: ${i.jobId}`);
    return { job: j };
  },
  'job.cancel': (c, i: { jobId: string }, origin) => {
    const j = c.repo.getJob(i.jobId);
    if (!j) throw new OmenflowError(ErrorCodes.NOT_FOUND, `Job not found: ${i.jobId}`);
    if (origin.kind === 'agent' && j.sessionId !== origin.sessionId)
      throw new OmenflowError(
        ErrorCodes.CAPABILITY_DENIED,
        'An agent can only cancel its own jobs',
      );
    c.cancelJob(i.jobId);
    return { job: c.repo.getJob(i.jobId) };
  },
  'job.list': (c, i: { status?: string; limit: number }) => ({
    jobs: c.repo.listJobs(i.limit, i.status),
  }),
  'tool.list': (c) => {
    const tools: {
      toolId: string;
      kind: string;
      available: boolean | null;
      version: string | null;
    }[] = [];
    if (c.tools.cad)
      tools.push({ toolId: 'openscad', kind: 'cad', available: null, version: null });
    return { tools, note: 'Probe individual tools for live availability.' };
  },
  'tool.describe': (
    _c,
    i: { tool?: string; op?: string; artifactType?: import('@omenflow/contracts').ArtifactType },
  ) => {
    const name = i.tool ?? i.op;
    if (!name)
      throw new OmenflowError(
        ErrorCodes.VALIDATION,
        'tool.describe without a tool name (the tool catalogue) is implemented by the Rust host',
        {
          repair: 'Pass tool, e.g. {"tool": "cad_check"}.',
          details: { op: 'tool.describe', implementedBy: 'rust-host' },
        },
      );
    const d = describeOp(name, i.artifactType);
    if (!d) throw new OmenflowError(ErrorCodes.NOT_FOUND, `Unknown operation: ${name}`);
    return d;
  },
  'tool.doctor': async (c, i: { toolId?: string }) => {
    const results: Record<string, unknown> = {};
    if ((!i.toolId || i.toolId === 'openscad') && c.tools.cad) {
      results.openscad = await (c.tools.cad as { probe(): Promise<unknown> }).probe();
    }
    return { results };
  },

  /* tests */
  'test.create_draft': (c, i: never, o) => tests.createTestDraft(c, i as never, o),
  'test.record_result': (c, i: never, o) => tests.recordResult(c, i as never, o),

  /* build */
  'build.preview': (c) => build.buildPreview(c),
  'build.export': (c, i: never, o) => build.exportBuildPackage(c, i as never, o),

  /* ui */
  'ui.open_artifact': (c, i: { artifactId: string }) => {
    c.emit('ui.open_artifact', 'agent', { artifactId: i.artifactId });
    return { ok: true };
  },
  'ui.request_review': (c, i: { proposalId: string }) => {
    c.emit('ui.request_review', 'agent', { proposalId: i.proposalId });
    return { ok: true };
  },
  'ui.suggest_action': (c, i: { title: string; detail?: string }) => {
    c.emit('ui.suggested_action', 'agent', { title: i.title, detail: i.detail });
    return { ok: true };
  },
  'ui.focus_terminal': (c) => {
    c.emit('ui.focus_terminal', 'agent', {});
    return { ok: true };
  },
};

function requestHash(op: string, payload: unknown): string {
  return hashRequest(op, payload);
}

/**
 * V1 operations that only the Rust host serves. This TypeScript core backs
 * the design preview, fixtures and evals; it says so rather than answer them.
 */
export function assertServedByLegacyCore(op: string): void {
  if (!RUST_HOST_OPS.has(op)) return;
  throw new OmenflowError(ErrorCodes.VALIDATION, `${op} is implemented by the Rust host`, {
    repair: 'Call it through the desktop app; the TypeScript core does not serve it.',
    details: { op, implementedBy: 'rust-host' },
  });
}

/** A parsed input read loosely: any field may be absent. */
type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields =>
  value !== null && typeof value === 'object' ? (value as Fields) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * Inputs only the Rust host understands, per operation, as the paths that
 * name them. This core would ignore them and do less than was asked: verify
 * less, drop an inline source, keep a line it was asked to remove, write no
 * file, page from the start again, or store a connection or a requirement
 * reference without the id the Rust host fills in. It refuses instead.
 */
const RUST_HOST_INPUTS: Record<string, (input: Fields) => string[]> = {
  'cad.check': (input) => [
    ...(input.autoCommit === undefined ? [] : ['autoCommit']),
    ...EXPECTATION_SHORT_FORM_KEYS.filter((key) => fields(input.expect)[key] !== undefined).map(
      (key) => `expect.${key}`,
    ),
  ],
  'artifact.list': (input) => (input.cursor === undefined ? [] : ['cursor']),
  'artifact.create_draft': (input) => wiringIdsOmitted(fields(input.payload).connections),
  'artifact.update_draft': (input) => wiringIdsOmitted(fields(input.payload).connections),
  'wiring.set_connections': (input) => wiringIdsOmitted(input.connections),
  'component.add_candidate': (input) => (input.source === undefined ? [] : ['source']),
  'component.propose_selection': (input) =>
    input.revisionId === undefined ? ['revisionId omitted'] : [],
  'bom.propose_edit': (input) => (list(input.removeLineIds).length ? ['removeLineIds'] : []),
  'bom.export': (input) => (input.destPath === undefined ? [] : ['destPath']),
  'test.create_draft': (input) =>
    list(input.requirementRefs).flatMap((ref, index) =>
      fields(ref).revisionId === undefined ? [`requirementRefs[${index}].revisionId omitted`] : [],
    ),
  'test.record_result': (input) =>
    input.requirementRef !== undefined && fields(input.requirementRef).revisionId === undefined
      ? ['requirementRef.revisionId omitted']
      : [],
};

function wiringIdsOmitted(connections: unknown): string[] {
  return list(connections).flatMap((value, index) => {
    const connection = fields(value);
    return [
      ...(connection.id === undefined ? [`connections[${index}].id omitted`] : []),
      ...['from', 'to']
        .filter(
          (end) =>
            connection[end] !== undefined &&
            fields(connection[end]).componentRevisionId === undefined,
        )
        .map((end) => `connections[${index}].${end}.componentRevisionId omitted`),
    ];
  });
}

function assertLegacyInputs(op: string, input: unknown): void {
  const unsupported = RUST_HOST_INPUTS[op]?.(fields(input)) ?? [];
  if (!unsupported.length) return;
  throw new OmenflowError(
    ErrorCodes.VALIDATION,
    `${op} with ${unsupported.join(', ')} is implemented by the Rust host`,
    {
      repair:
        op === 'cad.check'
          ? 'Call it through the desktop app, or send the canonical expectation (bbox, shells, sections) with exploratory.'
          : 'Call it through the desktop app, or send the complete input this core needs (ids and revision ids written out, no Rust-only fields).',
      details: { op, unsupported, implementedBy: 'rust-host' },
    },
  );
}

/**
 * Single dispatch point used by GUI, MCP, and CLI. Origin is assigned by the
 * caller's trusted layer — agents never reach user-only handlers.
 */
export async function dispatch(ctx: ProjectContext, req: DispatchInput): Promise<unknown> {
  const op = OPS_BY_NAME.get(req.op);
  if (!op) throw new OmenflowError(ErrorCodes.VALIDATION, `Unknown operation: ${req.op}`);
  if (
    req.origin.kind === 'agent' &&
    (op.capability === 'user' ||
      (/^(browser|research)\./.test(req.op) && req.op !== 'research.read_page'))
  ) {
    const code =
      req.op === 'artifact.apply_edit'
        ? ErrorCodes.APPROVAL_REQUIRED
        : ErrorCodes.CAPABILITY_DENIED;
    throw new OmenflowError(code, `Agents cannot call ${req.op}`, {
      repair: req.op === 'artifact.apply_edit' ? 'Submit a proposal instead.' : undefined,
    });
  }
  assertServedByLegacyCore(req.op);
  let input: never;
  try {
    input = op.input.parse(req.payload ?? {}) as never;
  } catch (e) {
    // Humanize Zod failures — raw issue JSON is unreadable in toasts.
    const issues = (e as { issues?: { path: (string | number)[]; message: string }[] }).issues;
    if (issues?.length) {
      const first = issues[0]!;
      const where = first.path.length ? `${first.path.join('.')}: ` : '';
      throw new OmenflowError(ErrorCodes.VALIDATION, `Invalid input — ${where}${first.message}`, {
        details: { issues: issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      });
    }
    throw e;
  }
  assertLegacyInputs(req.op, input);
  if (op.mutating) ctx.assertWritable();

  const handler = H[req.op];
  if (!handler)
    throw new OmenflowError(ErrorCodes.VALIDATION, `Operation not implemented: ${req.op}`);
  const key =
    op.mutating && req.idempotencyKey
      ? `${req.origin.kind === 'agent' ? req.origin.sessionId : 'user'}:${req.op}:${req.idempotencyKey}`
      : null;
  const hash = requestHash(req.op, req.payload);
  if (key) {
    const pending = ctx.inFlightRequests.get(key);
    if (pending) {
      if (pending.hash !== hash)
        throw new OmenflowError(
          ErrorCodes.VALIDATION,
          'Idempotency key reused with different payload',
        );
      return pending.result;
    }
    const prior = ctx.repo.getIdempotent(key);
    if (prior) {
      if (prior.requestHash !== hash)
        throw new OmenflowError(
          ErrorCodes.VALIDATION,
          'Idempotency key reused with different payload',
        );
      if ((prior.response as { operationPending?: boolean })?.operationPending) {
        const journal = readResultJournal(ctx.root, key, hash);
        if (journal) {
          ctx.repo.putIdempotent(key, hash, journal.response);
          clearResultJournal(ctx.root, key);
          return { ...(journal.response as object), idempotent: true, recovered: true };
        }
        throw new OmenflowError(
          ErrorCodes.REVISION_CONFLICT,
          'Previous attempt was interrupted; inspect its jobs/revisions before retrying with a new key',
        );
      }
      const failure = (prior.response as { operationFailure?: OmenflowErrorBody })
        ?.operationFailure;
      if (failure) throw OmenflowError.fromBody(failure);
      return { ...(prior.response as object), idempotent: true };
    }
  }
  const syncMutation =
    /^(artifact\.(create_draft|update_draft|import_file|apply_edit|accept_draft|revert|archive|set_subsystem)|proposal\.(submit|approve|reject|request_changes)|graph\.|test\.)/.test(
      req.op,
    );
  const run = async () => {
    if (syncMutation)
      return ctx.repo.tx(() => {
        const result = handler(ctx, input, req.origin);
        if (result instanceof Promise)
          throw new Error('Synchronous command unexpectedly returned a promise');
        if (key) ctx.repo.putIdempotent(key, hash, result);
        return result;
      });
    // Reserve asynchronous attempts durably. An interrupted result is explicit,
    // never silently re-executed after restart.
    if (key) ctx.repo.putIdempotent(key, hash, { operationPending: true });
    try {
      const result = await handler(ctx, input, req.origin);
      runDurabilityHooks(ctx.durabilityHooks, 'dispatch.after-domain-before-result', {
        op: req.op,
      });
      if (key) {
        writeResultJournal(ctx.root, {
          key,
          requestHash: hash,
          response: result,
          writtenAt: new Date().toISOString(),
        });
        runDurabilityHooks(ctx.durabilityHooks, 'dispatch.after-result-journal', { op: req.op });
        ctx.repo.putIdempotent(key, hash, result);
        clearResultJournal(ctx.root, key);
      }
      return result;
    } catch (error) {
      // A completed failure is different from a process dying mid-command.
      // Replay it faithfully; retrying the same key must never rerun partial
      // side effects, or relabel a known cancellation as an unknown interruption.
      if (key && !ctx.closed && ctx.handle.pdb.db.open && !readResultJournal(ctx.root, key, hash)) {
        try {
          ctx.repo.putIdempotent(key, hash, {
            operationFailure: OmenflowError.from(error).toBody(),
          });
        } catch {
          /* preserve the pending marker if durable completion itself failed */
        }
      }
      throw error;
    }
  };
  const result = Promise.resolve().then(run);
  if (key) ctx.inFlightRequests.set(key, { hash, result });
  try {
    return await result;
  } finally {
    if (key) ctx.inFlightRequests.delete(key);
  }
}

export function envelopeResult(requestId: string, result: unknown): ResponseEnvelope {
  return okResponse(requestId, result);
}
export function envelopeError(requestId: string, err: unknown): ResponseEnvelope {
  const e = err instanceof OmenflowError ? err : OmenflowError.from(err);
  return errResponse(requestId, e.code, e.message, e.repair, e.details);
}
export { newId };
