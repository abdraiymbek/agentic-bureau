import fs from 'node:fs';
import path from 'node:path';
import {
  ErrorCodes,
  OPS_BY_NAME,
  Origin,
  describeOp,
  OmenflowError,
  okResponse,
  errResponse,
  type ResponseEnvelope,
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
import { createHash } from 'node:crypto';

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
  'project.export_archive': (c, i: { destPath: string }) => build.exportArchive(c, i.destPath),

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
  'artifact.archive': (c, i: { artifactId: string; archived: boolean }) => {
    c.assertWritable();
    c.repo.setArchived(i.artifactId, i.archived);
    return { ok: true };
  },
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
        : c.repo.listRevisions(a.id).at(-1);
    const f = rev?.files.find((x) => x.path === i.path);
    if (!f) throw new OmenflowError(ErrorCodes.NOT_FOUND, `File not on revision: ${i.path}`);
    // Object store is authoritative; fall back to working file.
    if (f.sha256 && c.objects.has(f.sha256)) {
      return { contentBase64: c.objects.read(f.sha256).toString('base64'), sha256: f.sha256 };
    }
    const abs = c.resolvePath(i.path);
    if (!fs.existsSync(abs))
      throw new OmenflowError(ErrorCodes.NOT_FOUND, `File missing: ${i.path}`);
    return { contentBase64: fs.readFileSync(abs).toString('base64') };
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
  'graph.impact': (c, i: { refs: never }) => graph.impactReport(c, i.refs),
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
  'graph.list': (c) => ({ edges: c.repo.allEdges() }),

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
  'component.add_offer': (c, i: never) => components.addOffer(c, i as never),
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
  'proposal.approve': (c, i: { proposalId: string; rationale: string }) =>
    proposals.approveProposal(c, i.proposalId, i.rationale),
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
  'job.cancel': (c, i: { jobId: string }) => {
    const j = c.repo.getJob(i.jobId);
    if (!j) throw new OmenflowError(ErrorCodes.NOT_FOUND, `Job not found: ${i.jobId}`);
    const cancel = c.jobCancels.get(i.jobId);
    if (cancel) cancel();
    if (j.status === 'running' || j.status === 'queued') {
      c.jobStatus(i.jobId, 'cancelled');
    }
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
  'tool.describe': (_c, i: { op: string }) => {
    const d = describeOp(i.op);
    if (!d) throw new OmenflowError(ErrorCodes.NOT_FOUND, `Unknown operation: ${i.op}`);
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
  return createHash('sha256').update(JSON.stringify({ op, payload })).digest('hex');
}

/**
 * Single dispatch point used by GUI, MCP, and CLI. Origin is assigned by the
 * caller's trusted layer — agents never reach user-only handlers.
 */
export async function dispatch(ctx: ProjectContext, req: DispatchInput): Promise<unknown> {
  const op = OPS_BY_NAME.get(req.op);
  if (!op) throw new OmenflowError(ErrorCodes.VALIDATION, `Unknown operation: ${req.op}`);
  if (req.origin.kind === 'agent' && op.capability === 'user') {
    const code =
      req.op === 'artifact.apply_edit'
        ? ErrorCodes.APPROVAL_REQUIRED
        : ErrorCodes.CAPABILITY_DENIED;
    throw new OmenflowError(code, `Agents cannot call ${req.op}`, {
      repair: req.op === 'artifact.apply_edit' ? 'Submit a proposal instead.' : undefined,
    });
  }
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
  if (op.mutating) ctx.assertWritable();

  // Idempotency: same key + same request hash returns the stored response.
  if (op.mutating && req.idempotencyKey) {
    const prior = ctx.repo.getIdempotent(req.idempotencyKey);
    if (prior) {
      if (prior.requestHash !== requestHash(req.op, req.payload)) {
        throw new OmenflowError(
          ErrorCodes.VALIDATION,
          `Idempotency key reused with different payload: ${req.idempotencyKey}`,
        );
      }
      return { ...(prior.response as object), idempotent: true };
    }
  }

  const handler = H[req.op];
  if (!handler)
    throw new OmenflowError(ErrorCodes.VALIDATION, `Operation not implemented: ${req.op}`);
  const result = await handler(ctx, input, req.origin);

  if (op.mutating && req.idempotencyKey) {
    ctx.repo.putIdempotent(req.idempotencyKey, requestHash(req.op, req.payload), result);
  }
  return result;
}

export function envelopeResult(requestId: string, result: unknown): ResponseEnvelope {
  return okResponse(requestId, result);
}
export function envelopeError(requestId: string, err: unknown): ResponseEnvelope {
  const e = err instanceof OmenflowError ? err : OmenflowError.from(err);
  return errResponse(requestId, e.code, e.message, e.repair, e.details);
}
export { newId };
