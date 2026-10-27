import { type Expectation, type Revision } from '@bureau/contracts';
import type { ProjectContext } from './context.js';
import {
  hasExplicitScope,
  specHashOf,
  verificationScopeChanges,
  type CadVerificationStatus,
} from './cad-verification.js';

export const ACTIVE_WORK_META = 'work.active';

export type WorkNextAction =
  | 'inspect'
  | 'commit_assertions'
  | 'repair_geometry'
  | 'restore_assertions'
  | 'accept_scope'
  | 'commit_matching_render'
  | 'request_review'
  | 'none';

export interface ActiveWork {
  version: 1;
  artifactId: string;
  baselineRevisionId: string | null;
  candidateRevisionId: string | null;
  requestRevisionId: string | null;
  specHash: string | null;
  expect: Expectation | null;
  nextAction: WorkNextAction;
  updatedAt: string;
}

export function readActiveWork(ctx: ProjectContext): ActiveWork | null {
  const raw = ctx.repo.meta(ACTIVE_WORK_META);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ActiveWork;
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export function writeActiveWork(ctx: ProjectContext, work: ActiveWork): void {
  ctx.repo.setMeta(ACTIVE_WORK_META, JSON.stringify(work));
}

export function requestRevisionIdOf(ctx: ProjectContext, revision: Revision): string | null {
  for (const input of revision.inputs) {
    const artifact = ctx.repo.getArtifact(input.artifactId);
    if (artifact?.type === 'requirement') return input.revisionId;
  }
  return null;
}

export function nextActionFor(status: CadVerificationStatus, exploratory: boolean): WorkNextAction {
  if (exploratory) return 'commit_assertions';
  if (status === 'failed') return 'repair_geometry';
  if (status === 'unverified') return 'commit_matching_render';
  if (status === 'scope_changed') return 'restore_assertions';
  if (status === 'partial') return 'commit_assertions';
  if (status === 'passed') return 'request_review';
  return 'none';
}

/** Bind request-scoped assertions; never replace a committed spec with a reduced one. */
export function recordCommittedCheck(
  ctx: ProjectContext,
  revision: Revision,
  expect: Expectation,
  status: CadVerificationStatus,
  exploratory: boolean,
): ActiveWork {
  const previous = readActiveWork(ctx);
  const sameArtifact = previous?.artifactId === revision.artifactId;
  const newest = ctx.repo.listRevisions(revision.artifactId).at(-1);
  const isCurrentCandidate =
    newest?.id === revision.id || previous?.candidateRevisionId === revision.id;
  const explicit = hasExplicitScope(expect);
  let boundExpect = sameArtifact && isCurrentCandidate ? (previous?.expect ?? null) : null;
  let boundHash = sameArtifact && isCurrentCandidate ? (previous?.specHash ?? null) : null;
  if (!exploratory && explicit && isCurrentCandidate) {
    if (!boundExpect) {
      boundExpect = expect;
      boundHash = specHashOf(expect);
    } else if (verificationScopeChanges(boundExpect, expect).length === 0) {
      boundExpect = expect;
      boundHash = specHashOf(expect);
    }
  } else if (sameArtifact && !isCurrentCandidate) {
    boundExpect = previous?.expect ?? null;
    boundHash = previous?.specHash ?? null;
  }
  const artifact = ctx.repo.getArtifact(revision.artifactId);
  const work: ActiveWork = {
    version: 1,
    artifactId: revision.artifactId,
    baselineRevisionId: artifact?.selectedRevisionId ?? null,
    candidateRevisionId: revision.id,
    requestRevisionId: requestRevisionIdOf(ctx, revision) ?? previous?.requestRevisionId ?? null,
    specHash: boundHash,
    expect: boundExpect,
    nextAction: nextActionFor(status, exploratory),
    updatedAt: new Date().toISOString(),
  };
  writeActiveWork(ctx, work);
  return work;
}

export function activeWorkSummary(work: ActiveWork | null): {
  artifactId: string;
  candidateRevisionId: string | null;
  specHash: string | null;
  nextAction: WorkNextAction;
} | null {
  if (!work) return null;
  return {
    artifactId: work.artifactId,
    candidateRevisionId: work.candidateRevisionId,
    specHash: work.specHash,
    nextAction: work.nextAction,
  };
}
