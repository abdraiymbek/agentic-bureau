import { ErrorCodes, Origin, StarkError, TestResult, newId } from '@stark/contracts';
import type { ProjectContext } from './context.js';
import { commitRevision, createDraft, ingestFiles } from './artifacts.js';
import { addEdge } from './graph.js';

/** Tests: procedures + independently-typed results (assumed/measured/…). */
export function createTestDraft(
  ctx: ProjectContext,
  input: {
    title: string;
    procedure: { step: number; instruction: string; expected?: string }[];
    requirementRefs: { artifactId: string; revisionId: string }[];
    conditions?: string;
  },
  origin: Origin,
) {
  const { artifact, revision } = createDraft(
    ctx,
    {
      type: 'test',
      title: input.title,
      payload: { procedure: input.procedure, conditions: input.conditions, results: [] },
      files: [],
      inputs: input.requirementRefs.map((r) => ({
        artifactId: r.artifactId,
        revisionId: r.revisionId,
        relationship: 'validates' as const,
        label: 'test for requirement',
      })),
      rationale: 'test procedure',
    },
    origin,
  );
  for (const r of input.requirementRefs) {
    addEdge(ctx, r.artifactId, artifact.id, 'validates', 'covered by test', origin.kind);
  }
  return { artifact, revision };
}

export function recordResult(
  ctx: ProjectContext,
  input: {
    artifactId: string;
    requirementRef?: { artifactId: string; revisionId: string };
    evidenceKind: TestResult['evidenceKind'];
    observation: string;
    result: TestResult['result'];
    conditions?: string;
    attachments: { path: string; sourcePath?: string; contentBase64?: string }[];
    measurementOrigin?: string;
  },
  origin: Origin,
) {
  const artifact = ctx.requireArtifact(input.artifactId);
  if (artifact.type !== 'test') {
    throw new StarkError(ErrorCodes.VALIDATION, 'Results attach to test artifacts');
  }
  const cur = artifact.selectedRevisionId
    ? ctx.repo.getRevision(artifact.selectedRevisionId)
    : ctx.repo.listRevisions(artifact.id).at(-1);
  if (!cur) throw new StarkError(ErrorCodes.VALIDATION, 'Test has no revision');
  const payload = cur.payload as {
    procedure: unknown[];
    conditions?: string;
    results: TestResult[];
  };
  const files = ingestFiles(ctx, input.attachments);
  const result: TestResult = {
    id: newId(),
    requirementRef: input.requirementRef,
    evidenceKind: input.evidenceKind,
    observation: input.observation,
    result: input.result,
    conditions: input.conditions,
    attachments: files,
    recordedBy: origin.kind === 'agent' ? `agent:${origin.sessionId.slice(0, 8)}` : 'user',
    recordedAt: new Date().toISOString(),
    measurementOrigin: input.measurementOrigin,
  };
  const revision = commitRevision(ctx, {
    artifactId: artifact.id,
    parentId: cur.id,
    origin,
    payload: { ...payload, results: [...payload.results, result] },
    files: cur.files,
    inputs: cur.inputs,
    rationale: `result: ${result.result}`,
    reviewState: cur.reviewState === 'approved' ? 'approved' : 'draft',
  });
  // A failed result stays visible; linked requirement/design goes stale via
  // propagation when the validated revision changes.
  return { result, revision };
}
