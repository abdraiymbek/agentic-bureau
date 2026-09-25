import fs from 'node:fs';
import path from 'node:path';
import {
  Artifact,
  ArtifactType,
  ErrorCodes,
  FileRef,
  MAX_FRAME_BYTES,
  Origin,
  RecordedInput,
  Revision,
  RevisionRef,
  OmenflowError,
  formatQty,
  newId,
  validatePayload,
} from '@omenflow/contracts';
import type { ProjectContext } from './context.js';
import { approveCadVerificationScope } from './cad-verification.js';
import { contentHash, diffPayloads, slugify } from './hash.js';
import {
  propagateFrom,
  validateRevisionInputs,
  syncSelectedInputs,
  validateSelectedRevisions,
} from './graph.js';
import {
  resolveMaterializationPath,
  resolveProjectSourcePath,
  validateObjectHash,
} from '@omenflow/storage';
import { normalizeMechanicalRevision } from './cad-input.js';

export interface DraftFileInput {
  path: string;
  contentBase64?: string;
  sourcePath?: string;
}

/** Aligns file ingest with the 8 MiB transport frame; larger files need a handle. */
export const MAX_INGEST_FILE_BYTES = MAX_FRAME_BYTES;

function assertIngestSize(bytes: number, label: string): void {
  if (bytes > MAX_INGEST_FILE_BYTES) {
    throw new OmenflowError(
      ErrorCodes.VALIDATION,
      `${label} exceeds the ${MAX_INGEST_FILE_BYTES} byte ingest/transport limit`,
      {
        repair: 'Split the file or import it in a smaller supported payload.',
        details: { actual: bytes, limit: MAX_INGEST_FILE_BYTES },
      },
    );
  }
}

/** Ingest draft files into the object store; return FileRefs. */
export function ingestFiles(ctx: ProjectContext, files: DraftFileInput[]): FileRef[] {
  for (const f of files) {
    resolveMaterializationPath(ctx.root, f.path);
    if (f.sourcePath)
      resolveProjectSourcePath(
        ctx.root,
        path.isAbsolute(f.sourcePath) ? path.relative(ctx.root, f.sourcePath) : f.sourcePath,
      );
  }
  const out: FileRef[] = [];
  for (const f of files) {
    let buf: Buffer;
    if (f.contentBase64 !== undefined) {
      const encoded = Buffer.byteLength(f.contentBase64, 'utf8');
      assertIngestSize(Math.ceil((encoded * 3) / 4), f.path);
      buf = Buffer.from(f.contentBase64, 'base64');
    } else if (f.sourcePath) {
      const abs = resolveProjectSourcePath(
        ctx.root,
        path.isAbsolute(f.sourcePath) ? path.relative(ctx.root, f.sourcePath) : f.sourcePath,
      );
      assertIngestSize(fs.statSync(abs).size, f.path);
      buf = fs.readFileSync(abs);
    } else {
      throw new OmenflowError(ErrorCodes.VALIDATION, `File entry has no content: ${f.path}`);
    }
    assertIngestSize(buf.byteLength, f.path);
    const sha256 = ctx.storeContent(buf);
    out.push({ path: f.path, sha256, role: 'source' });
  }
  return out;
}

function materializeFiles(
  ctx: ProjectContext,
  revisionId: string,
  files: FileRef[],
  parent: Revision | null,
): void {
  for (const f of files) {
    if (!f.sha256) continue;
    // Working files materialize into the project so the user/agent sees them.
    ctx.materialize(f.path, f.sha256, revisionId, {
      expectedSha256: parent?.files.find((previous) => previous.path === f.path)?.sha256,
    });
  }
}

function ftsTextOf(type: ArtifactType, payload: unknown): string {
  try {
    return JSON.stringify(payload).slice(0, 20000);
  } catch {
    return String(type);
  }
}

/** Commit a new revision row. Does not touch the baseline pointer. */
function commitRevisionImpl(
  ctx: ProjectContext,
  args: {
    artifactId: string;
    parentId: string | null;
    origin: Origin;
    payload: unknown;
    files: FileRef[];
    inputs: RecordedInput[];
    rationale: string;
    reviewState: Revision['reviewState'];
    skipMaterialize?: boolean;
  },
): Revision {
  ctx.assertWritable();
  const a = ctx.requireArtifact(args.artifactId);
  const parent = args.parentId ? ctx.requireRevision(args.parentId) : null;
  if (parent && parent.artifactId !== a.id)
    throw new OmenflowError(ErrorCodes.VALIDATION, 'Parent revision does not belong to artifact');
  validateRevisionInputs(ctx, a.id, args.inputs);
  if (a.type === 'mechanical') {
    const normalized = normalizeMechanicalRevision(args.payload, args.files, parent, (hash) =>
      ctx.objects.read(hash).toString('utf8'),
    );
    args = { ...args, ...normalized };
  }
  for (const file of args.files) {
    resolveMaterializationPath(ctx.root, file.path);
    if (file.sha256) {
      validateObjectHash(file.sha256);
      ctx.objects.read(file.sha256);
    }
  }
  let payload: unknown;
  try {
    payload = validatePayload(a.type, args.payload ?? {});
  } catch (e) {
    const issues = (e as { issues?: { path: (string | number)[]; message: string }[] }).issues;
    const list = issues?.map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`) ?? [
      String(e),
    ];
    throw new OmenflowError(ErrorCodes.VALIDATION, `Invalid ${a.type} payload — ${list[0]}`, {
      repair:
        a.type === 'mechanical'
          ? 'Use cad.write_source for parts; it builds the mechanical payload from the OpenSCAD source.'
          : `Pass a payload object matching the ${a.type} schema.`,
      details: { issues: list },
    });
  }
  const fileHashes = args.files.map((f) => f.sha256).filter((x): x is string => !!x);
  const rev: Revision = {
    id: newId(),
    artifactId: a.id,
    parentId: args.parentId,
    seq: ctx.repo.nextRevisionSeq(a.id),
    origin: args.origin.kind,
    originDetail: args.origin.kind === 'agent' ? args.origin.sessionId : null,
    createdAt: new Date().toISOString(),
    payload,
    contentHash: contentHash(a.type, payload, fileHashes),
    files: args.files,
    inputs: args.inputs,
    rationale: args.rationale,
    reviewState: args.reviewState,
  };
  ctx.repo.tx(() => {
    ctx.repo.insertRevision(rev);
    ctx.repo.ftsIndex(a.id, rev.id, a.title, ftsTextOf(a.type, payload));
    ctx.emit('revision.committed', args.origin.kind, {
      artifactId: a.id,
      revisionId: rev.id,
      reviewState: rev.reviewState,
    });
  });
  if (!args.skipMaterialize) materializeFiles(ctx, rev.id, args.files, parent);
  return rev;
}

function createDraftImpl(
  ctx: ProjectContext,
  input: {
    type: ArtifactType;
    title: string;
    subsystem?: string | null;
    payload: unknown;
    files: DraftFileInput[];
    inputs: {
      artifactId: string;
      revisionId?: string;
      relationship?: RecordedInput['relationship'];
      label?: string;
    }[];
    rationale: string;
  },
  origin: Origin,
) {
  ctx.assertWritable();
  const files = ingestFiles(ctx, input.files);
  const inputs: RecordedInput[] = input.inputs.map((i) => ({
    artifactId: i.artifactId,
    revisionId:
      i.revisionId ??
      ctx.requireArtifact(i.artifactId).selectedRevisionId ??
      ctx.repo
        .listRevisions(i.artifactId)
        .filter((r) => !['rejected', 'superseded'].includes(r.reviewState))
        .at(-1)?.id ??
      '',
    relationship: i.relationship ?? 'depends_on',
    label: i.label,
  }));
  let artifact: Artifact | undefined;
  let revision!: Revision;
  ctx.repo.tx(() => {
    artifact = {
      id: newId(),
      type: input.type,
      title: input.title,
      subsystem: input.subsystem ?? null,
      selectedRevisionId: null,
      archived: false,
      createdAt: new Date().toISOString(),
    };
    ctx.repo.insertArtifact(artifact);
  });
  revision = commitRevision(ctx, {
    artifactId: artifact!.id,
    parentId: null,
    origin,
    payload: input.payload,
    files,
    inputs,
    rationale: input.rationale,
    reviewState: 'draft',
  });
  materializeReadableView(ctx, artifact!, revision);
  return { artifact: artifact!, revision };
}

function updateDraftImpl(
  ctx: ProjectContext,
  input: {
    artifactId: string;
    baseRevisionId?: string;
    draftRevisionId?: string;
    title?: string;
    payload?: unknown;
    files?: DraftFileInput[];
    inputs?: {
      artifactId: string;
      revisionId?: string;
      relationship?: RecordedInput['relationship'];
      label?: string;
    }[];
    rationale?: string;
  },
  origin: Origin,
) {
  ctx.assertWritable();
  const artifact = ctx.requireArtifact(input.artifactId);

  const parent = input.draftRevisionId
    ? ctx.requireRevision(input.draftRevisionId)
    : input.baseRevisionId
      ? ctx.requireRevision(input.baseRevisionId)
      : artifact.selectedRevisionId
        ? ctx.requireRevision(artifact.selectedRevisionId)
        : (ctx.repo
            .listRevisions(artifact.id)
            .filter((r) => ['draft', 'proposed'].includes(r.reviewState))
            .at(-1) ?? null);
  if (
    input.baseRevisionId &&
    artifact.selectedRevisionId &&
    input.baseRevisionId !== artifact.selectedRevisionId
  ) {
    throw new OmenflowError(ErrorCodes.REVISION_CONFLICT, 'Base revision is no longer selected', {
      repair: 'Refresh the artifact and rebuild the draft on the current baseline.',
      details: { selected: artifact.selectedRevisionId, requested: input.baseRevisionId },
    });
  }

  if (parent && parent.artifactId !== artifact.id)
    throw new OmenflowError(ErrorCodes.VALIDATION, 'Parent revision does not belong to artifact');

  const payload = input.payload !== undefined ? input.payload : (parent?.payload ?? {});
  const files = input.files ? ingestFiles(ctx, input.files) : (parent?.files ?? []);
  const inputs: RecordedInput[] = input.inputs
    ? input.inputs.map((i) => ({
        artifactId: i.artifactId,
        revisionId:
          i.revisionId ??
          ctx.requireArtifact(i.artifactId).selectedRevisionId ??
          ctx.repo
            .listRevisions(i.artifactId)
            .filter((r) => !['rejected', 'superseded'].includes(r.reviewState))
            .at(-1)?.id ??
          '',
        relationship: i.relationship ?? 'depends_on',
        label: i.label,
      }))
    : (parent?.inputs ?? []);

  const rev = commitRevision(ctx, {
    artifactId: artifact.id,
    parentId: parent?.id ?? null,
    origin,
    payload,
    files,
    inputs,
    rationale: input.rationale ?? parent?.rationale ?? '',
    reviewState: 'draft',
  });
  if (input.title) {
    ctx.repo.updateArtifactTitle(artifact.id, input.title);
    artifact.title = input.title;
  }
  materializeReadableView(ctx, artifact, rev);
  return { artifact, revision: rev };
}

/**
 * User direct baseline edit — commits a revision, marks it approved, moves
 * the baseline, writes a decision, and propagates impact. Human only; the
 * dispatcher blocks agents from reaching this handler.
 */
function applyUserEditImpl(
  ctx: ProjectContext,
  input: {
    artifactId: string;
    baseRevisionId: string;
    title?: string;
    payload?: unknown;
    payloadPatch?: Record<string, unknown>;
    fileWrites?: { path: string; contentBase64: string }[];
    rationale: string;
  },
) {
  ctx.assertWritable();
  const artifact = ctx.requireArtifact(input.artifactId);
  if (artifact.selectedRevisionId !== input.baseRevisionId) {
    throw new OmenflowError(ErrorCodes.REVISION_CONFLICT, 'Base revision is no longer selected', {
      repair: 'Refresh the artifact and retry the edit.',
    });
  }
  const parent = ctx.requireRevision(input.baseRevisionId);
  let payload = input.payload;
  if (input.payloadPatch) {
    payload = { ...(parent.payload as Record<string, unknown>), ...input.payloadPatch };
  }
  let files: DraftFileInput[] | undefined;
  if (input.fileWrites?.length) {
    const writes = new Map(input.fileWrites.map((w) => [w.path, w.contentBase64]));
    files = [
      ...parent.files
        .filter((f) => !writes.has(f.path))
        .map((f) => ({ path: f.path, sourcePath: undefined as string | undefined })),
      ...input.fileWrites.map((w) => ({ path: w.path, contentBase64: w.contentBase64 })),
    ];
    // Parent files without content were stored in the object store — re-ingest by sha.
    files = files.map((f) => {
      if (f.sourcePath === undefined && f.contentBase64 === undefined) {
        const pf = parent.files.find((x) => x.path === f.path);
        if (pf?.sha256 && ctx.objects.has(pf.sha256)) {
          return { path: f.path, contentBase64: ctx.objects.read(pf.sha256).toString('base64') };
        }
      }
      return f;
    });
  }
  const draft = updateDraft(
    ctx,
    {
      artifactId: artifact.id,
      baseRevisionId: input.baseRevisionId,
      title: input.title,
      payload,
      files,
      rationale: input.rationale,
    },
    { kind: 'user' },
  );
  const prior: RevisionRef[] = artifact.selectedRevisionId
    ? [{ artifactId: artifact.id, revisionId: artifact.selectedRevisionId }]
    : [];
  const newRefs: RevisionRef[] = [{ artifactId: artifact.id, revisionId: draft.revision.id }];
  ctx.repo.tx(() => {
    promoteRevision(ctx, artifact, draft.revision);
    const seq = ctx.emit('baseline.changed', 'user', {
      artifactId: artifact.id,
      newRevisionId: draft.revision.id,
      priorRevisionId: input.baseRevisionId,
    });
    ctx.repo.insertDecision({
      id: newId(),
      proposalId: null,
      action: 'direct_edit',
      actor: 'user',
      ts: new Date().toISOString(),
      rationale: input.rationale,
      priorBaseline: prior,
      newBaseline: newRefs,
      eventSeq: seq,
    });
    const affected = propagateFrom(ctx, [artifact.id], seq);
    ctx.emit('impact.propagated', 'user', {
      changed: [{ artifactId: artifact.id, revisionId: draft.revision.id }],
      affected,
    });
  });
  materializeReadableView(ctx, ctx.requireArtifact(artifact.id), draft.revision);
  return { artifact: ctx.requireArtifact(artifact.id), revision: draft.revision };
}

/** Promote a revision to the baseline: state transitions + pointer + stale clear. */
export function promoteRevision(ctx: ProjectContext, artifact: Artifact, revision: Revision): void {
  const priorId = artifact.selectedRevisionId;
  if (revision.artifactId !== artifact.id)
    throw new OmenflowError(ErrorCodes.VALIDATION, 'Revision does not belong to artifact');
  if (ctx.requireArtifact(artifact.id).selectedRevisionId !== priorId)
    throw new OmenflowError(ErrorCodes.REVISION_CONFLICT, 'Baseline changed');
  ctx.repo.setRevisionState(revision.id, 'approved');
  ctx.repo.setSelectedRevision(artifact.id, revision.id);
  syncSelectedInputs(ctx, artifact.id);
  if (priorId) {
    const prior = ctx.repo.getRevision(priorId);
    if (prior && prior.id !== revision.id && prior.reviewState === 'approved') {
      ctx.repo.setRevisionState(prior.id, 'superseded');
    }
  }
  // The fresh baseline re-evaluates its own inputs.
  const { evaluateInputs, staleToRecord } = graphFns();
  const findings = evaluateInputs(ctx, artifact.id);
  if (findings.length > 0) {
    ctx.repo.replaceStale(artifact.id, staleToRecord(findings, ctx.repo.latestEventSeq()));
  } else {
    ctx.repo.clearStale(artifact.id);
  }
  artifact.selectedRevisionId = revision.id;
}

// Late import to avoid a hard cycle in module init.
import * as graphModule from './graph.js';
function graphFns() {
  return { evaluateInputs: graphModule.evaluateInputs, staleToRecord: graphModule.staleToRecord };
}

/** User accepts an existing draft revision as the baseline. */
function acceptDraftImpl(
  ctx: ProjectContext,
  input: {
    artifactId: string;
    draftRevisionId: string;
    rationale: string;
    verificationEvidenceHash?: string;
  },
) {
  ctx.assertWritable();
  const artifact = ctx.requireArtifact(input.artifactId);
  const rev = ctx.requireRevision(input.draftRevisionId);
  if (rev.artifactId !== artifact.id) {
    throw new OmenflowError(ErrorCodes.VALIDATION, 'Revision does not belong to artifact');
  }
  if (!['draft', 'proposed'].includes(rev.reviewState))
    throw new OmenflowError(ErrorCodes.VALIDATION, 'Only an active draft can be accepted');
  validateSelectedRevisions(ctx, [rev]);
  // Walk the candidate lineage: a direct edit after it forked requires review/rebase.
  let ancestor: Revision | null = rev;
  while (
    ancestor &&
    ancestor.id !== artifact.selectedRevisionId &&
    ['draft', 'proposed'].includes(ancestor.reviewState)
  )
    ancestor = ancestor.parentId ? ctx.requireRevision(ancestor.parentId) : null;
  if ((ancestor?.id ?? null) !== artifact.selectedRevisionId)
    throw new OmenflowError(ErrorCodes.REVISION_CONFLICT, 'Draft is based on an older baseline');
  const prior: RevisionRef[] = artifact.selectedRevisionId
    ? [{ artifactId: artifact.id, revisionId: artifact.selectedRevisionId }]
    : [];
  ctx.repo.tx(() => {
    validateSelectedRevisions(ctx, [rev]);
    if (input.verificationEvidenceHash)
      approveCadVerificationScope(ctx, rev, input.verificationEvidenceHash);
    promoteRevision(ctx, artifact, rev);
    const seq = ctx.emit('baseline.changed', 'user', {
      artifactId: artifact.id,
      newRevisionId: rev.id,
      priorRevisionId: prior[0]?.revisionId ?? null,
    });
    ctx.repo.insertDecision({
      id: newId(),
      proposalId: null,
      action: 'accepted',
      actor: 'user',
      ts: new Date().toISOString(),
      rationale: input.rationale,
      priorBaseline: prior,
      newBaseline: [{ artifactId: artifact.id, revisionId: rev.id }],
      eventSeq: seq,
    });
    const affected = propagateFrom(ctx, [artifact.id], seq);
    ctx.emit('impact.propagated', 'user', {
      changed: [{ artifactId: artifact.id, revisionId: rev.id }],
      affected,
    });
  });
  materializeReadableView(ctx, artifact, rev);
  return { artifact: ctx.requireArtifact(artifact.id), revision: rev };
}

function revertArtifactImpl(
  ctx: ProjectContext,
  artifactId: string,
  toRevisionId: string,
  rationale: string,
) {
  ctx.assertWritable();
  const artifact = ctx.requireArtifact(artifactId);
  const target = ctx.requireRevision(toRevisionId);
  if (target.artifactId !== artifactId) {
    throw new OmenflowError(ErrorCodes.VALIDATION, 'Revision does not belong to artifact');
  }
  // Revert creates a NEW revision copying historical content (keeps trail).
  const prior: RevisionRef[] = artifact.selectedRevisionId
    ? [{ artifactId, revisionId: artifact.selectedRevisionId }]
    : [];
  const rev = commitRevision(ctx, {
    artifactId,
    parentId: artifact.selectedRevisionId,
    origin: { kind: 'user' },
    payload: target.payload,
    files: target.files,
    inputs: target.inputs,
    rationale: `Revert to revision ${target.seq}: ${rationale}`,
    reviewState: 'approved',
  });
  ctx.repo.tx(() => {
    validateSelectedRevisions(ctx, [rev]);
    promoteRevision(ctx, artifact, rev);
    const seq = ctx.emit('baseline.changed', 'user', {
      artifactId,
      newRevisionId: rev.id,
      reverted: true,
    });
    ctx.repo.insertDecision({
      id: newId(),
      proposalId: null,
      action: 'revert',
      actor: 'user',
      ts: new Date().toISOString(),
      rationale,
      priorBaseline: prior,
      newBaseline: [{ artifactId, revisionId: rev.id }],
      eventSeq: seq,
    });
    const affected = propagateFrom(ctx, [artifactId], seq);
    ctx.emit('impact.propagated', 'user', {
      changed: [{ artifactId, revisionId: rev.id }],
      affected,
    });
  });
  return { artifact: ctx.requireArtifact(artifactId), revision: rev };
}

/* ------------------------------------------------------------------ */
/* Readable views                                                       */
/* ------------------------------------------------------------------ */

const TYPE_DIRS: Record<ArtifactType, string> = {
  requirement: 'requirements',
  assumption: 'requirements',
  architecture: 'concepts',
  concept: 'concepts',
  component: 'components',
  source: 'research',
  mechanical: 'mechanical',
  wiring: 'electronics',
  calculation: 'calculations',
  software: 'software',
  assembly: 'assembly',
  test: 'tests',
  note: 'research',
  subsystem: 'requirements',
};

/** Render a readable view for an artifact revision into artifacts/. */
export function materializeReadableView(
  ctx: ProjectContext,
  artifact: Artifact,
  revision: Revision,
): void {
  const dir = TYPE_DIRS[artifact.type];
  const base = `artifacts/${dir}/${slugify(artifact.title)}`;
  try {
    const rendered = renderView(artifact, revision);
    if (!rendered) return;
    const sha = ctx.storeContent(rendered.content);
    ctx.materialize(`${base}.${rendered.ext}`, sha, revision.id, { overwrite: true });
  } catch {
    /* views are regenerable; failures never block commits */
  }
}

function renderView(
  artifact: Artifact,
  revision: Revision,
): { ext: string; content: string } | null {
  const p = revision.payload as Record<string, unknown>;
  const header = `# ${artifact.title}\n\n<!-- omenflow:artifact=${artifact.id} revision=${revision.id} -->\n\n`;
  switch (artifact.type) {
    case 'requirement': {
      const target = p.target ? `\n**Target:** ${formatQty(p.target as never)}\n` : '';
      return {
        ext: 'md',
        content: `${header}${p.statement}\n${target}\n**Acceptance:** ${p.acceptanceCriterion}\n\n**Priority:** ${p.priority}\n`,
      };
    }
    case 'assumption':
      return {
        ext: 'md',
        content: `${header}${p.statement}\n\n**Reason:** ${p.reason}\n\n**Owner:** ${p.owner}\n`,
      };
    case 'component':
      return {
        ext: 'json',
        content:
          JSON.stringify({ ...p, artifactId: artifact.id, revisionId: revision.id }, null, 2) +
          '\n',
      };
    case 'mechanical':
      // .scad/.stl materialize via revision.files; view is a small json card.
      return {
        ext: 'json',
        content:
          JSON.stringify({ params: p.params, modelUnit: p.modelUnit, bounds: p.bounds }, null, 2) +
          '\n',
      };
    case 'calculation':
      return {
        ext: 'md',
        content: `${header}**Expression:** \`${p.expression ?? p.templateId ?? ''}\`\n\n**Result:** ${p.result ? formatQty((p.result as { quantity?: never }).quantity ?? null) : 'not run'}\n\n**Assumptions:** ${(p.assumptions as string[]).join('; ')}\n\n**Limitations:** ${(p.limitations as string[]).join('; ')}\n`,
      };
    case 'assembly': {
      const steps = (p.steps as { order: number; instruction: string }[])
        .map((s) => `${s.order}. ${s.instruction}`)
        .join('\n');
      return { ext: 'md', content: `${header}${steps}\n` };
    }
    case 'test': {
      const steps = (p.procedure as { step: number; instruction: string; expected?: string }[])
        .map((s) => `${s.step}. ${s.instruction}${s.expected ? ` → _${s.expected}_` : ''}`)
        .join('\n');
      return { ext: 'md', content: `${header}${steps}\n` };
    }
    case 'note':
    case 'architecture':
      return { ext: 'md', content: `${header}${p.markdown ?? ''}\n` };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Compare                                                              */
/* ------------------------------------------------------------------ */

export function compareRevisions(
  ctx: ProjectContext,
  artifactId: string,
  fromId: string,
  toId: string,
) {
  const a = ctx.requireArtifact(artifactId);
  const from = ctx.requireRevision(fromId);
  const to = ctx.requireRevision(toId);
  if (from.artifactId !== a.id || to.artifactId !== a.id) {
    throw new OmenflowError(ErrorCodes.VALIDATION, 'Revisions do not belong to artifact');
  }
  const fileDiff = {
    added: to.files.filter(
      (f) => !from.files.some((g) => g.path === f.path && g.sha256 === f.sha256),
    ),
    removed: from.files.filter(
      (f) => !to.files.some((g) => g.path === f.path && g.sha256 === f.sha256),
    ),
  };
  return {
    artifact: a,
    from,
    to,
    payloadDiff: diffPayloads(from.payload, to.payload),
    fileDiff,
    inputDiff: {
      added: to.inputs.filter(
        (i) =>
          !from.inputs.some((j) => j.artifactId === i.artifactId && j.revisionId === i.revisionId),
      ),
      removed: from.inputs.filter(
        (i) =>
          !to.inputs.some((j) => j.artifactId === i.artifactId && j.revisionId === i.revisionId),
      ),
    },
  };
}

export function commitRevision(
  ...args: Parameters<typeof commitRevisionImpl>
): ReturnType<typeof commitRevisionImpl> {
  return args[0].repo.tx(() => commitRevisionImpl(...args));
}

export function createDraft(
  ...args: Parameters<typeof createDraftImpl>
): ReturnType<typeof createDraftImpl> {
  return args[0].repo.tx(() => createDraftImpl(...args));
}

export function updateDraft(
  ...args: Parameters<typeof updateDraftImpl>
): ReturnType<typeof updateDraftImpl> {
  return args[0].repo.tx(() => updateDraftImpl(...args));
}

export function applyUserEdit(
  ...args: Parameters<typeof applyUserEditImpl>
): ReturnType<typeof applyUserEditImpl> {
  return args[0].repo.tx(() => applyUserEditImpl(...args));
}

export function acceptDraft(
  ...args: Parameters<typeof acceptDraftImpl>
): ReturnType<typeof acceptDraftImpl> {
  return args[0].repo.tx(() => acceptDraftImpl(...args));
}

export function revertArtifact(
  ...args: Parameters<typeof revertArtifactImpl>
): ReturnType<typeof revertArtifactImpl> {
  return args[0].repo.tx(() => revertArtifactImpl(...args));
}
