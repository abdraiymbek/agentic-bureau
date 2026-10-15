import {
  ErrorCodes,
  Origin,
  Proposal,
  ProposedChange,
  RevisionRef,
  OmenflowError,
  newId,
} from '@omenflow/contracts';
import type { ProjectContext } from './context.js';
import { promoteRevision } from './artifacts.js';
import { impactReport, propagateFrom, validateSelectedRevisions } from './graph.js';
import { approveCadVerificationScope, latestCadVerification } from './cad-verification.js';

/**
 * Proposal = immutable bound change set. Only the human path resolves it;
 * approval rechecks base bindings before committing.
 */

function submitProposalImpl(
  ctx: ProjectContext,
  input: { changes: ProposedChange[]; reason: string },
  origin: Origin,
): Proposal {
  ctx.assertWritable();
  // Validate every change binds to real drafts and current bases.
  for (const c of input.changes) {
    const artifact = ctx.requireArtifact(c.artifactId);
    const rev = ctx.requireRevision(c.newRevisionId);
    if (rev.artifactId !== artifact.id) {
      throw new OmenflowError(
        ErrorCodes.VALIDATION,
        `Revision ${c.newRevisionId} not on artifact ${c.artifactId}`,
      );
    }
    if (rev.reviewState !== 'draft' && rev.reviewState !== 'proposed') {
      throw new OmenflowError(
        ErrorCodes.VALIDATION,
        `Proposed revision must be a draft (state: ${rev.reviewState})`,
      );
    }
    const cur = artifact.selectedRevisionId;
    if (
      c.baseRevisionId !== (cur ?? null) ||
      (c.kind === 'new_artifact' && cur !== null) ||
      (c.kind === 'baseline_update' && cur === null)
    ) {
      throw new OmenflowError(
        ErrorCodes.REVISION_CONFLICT,
        `Proposal base does not match selected revision`,
        {
          repair: 'Rebuild the proposal against the current baseline.',
          details: { artifactId: c.artifactId, selected: cur, proposed: c.baseRevisionId },
        },
      );
    }
  }
  if (new Set(input.changes.map((c) => c.artifactId)).size !== input.changes.length)
    throw new OmenflowError(
      ErrorCodes.VALIDATION,
      'A proposal cannot change the same artifact twice',
    );
  validateSelectedRevisions(
    ctx,
    input.changes
      .filter((c) => c.kind !== 'archive')
      .map((c) => ctx.requireRevision(c.newRevisionId)),
  );
  for (const c of input.changes) ctx.repo.setRevisionState(c.newRevisionId, 'proposed');
  const refs: RevisionRef[] = input.changes.map((c) => ({
    artifactId: c.artifactId,
    revisionId: c.newRevisionId,
  }));
  const impact = impactReport(ctx, refs);
  const replaced = changesRequestedReplacedBy(ctx, input.changes);
  const proposal: Proposal = {
    id: newId(),
    changes: input.changes,
    reason: input.reason,
    impact: {
      affectedArtifactIds: impact.affected.map((a) => a.artifactId),
      summary: `${impact.affected.length} downstream artifact(s) may be affected`,
      ...(replaced.length ? { supersedesProposalIds: replaced.map((p) => p.id) } : {}),
    },
    state: 'pending',
    createdBy: origin.kind,
    createdBySession: origin.kind === 'agent' ? origin.sessionId : null,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    resolutionRationale: null,
  };
  ctx.repo.insertProposal(proposal);
  retireReplacedChangeRequests(ctx, proposal, replaced, origin.kind);
  ctx.emit('proposal.submitted', origin.kind, {
    proposalId: proposal.id,
    changes: input.changes.length,
    affected: impact.affected.length,
    reason: input.reason,
    supersedesProposalIds: replaced.map((p) => p.id),
  });
  return proposal;
}

function changesRequestedReplacedBy(ctx: ProjectContext, changes: ProposedChange[]): Proposal[] {
  const artifactIds = new Set(changes.map((c) => c.artifactId));
  return ctx.repo
    .listProposals('changes_requested')
    .filter(
      (p) =>
        p.changes.length > 0 && p.changes.every((change) => artifactIds.has(change.artifactId)),
    );
}

function retireReplacedChangeRequests(
  ctx: ProjectContext,
  replacement: Proposal,
  replaced: Proposal[],
  actor: Proposal['createdBy'],
): void {
  for (const previous of replaced) {
    const rationale = `Superseded by replacement proposal ${replacement.id}`;
    ctx.repo.updateProposalState(previous.id, 'superseded', rationale, {
      ...(previous.impact ?? {
        affectedArtifactIds: [],
        summary: previous.reason,
      }),
      supersededByProposalId: replacement.id,
    });
    for (const change of previous.changes) {
      const rev = ctx.repo.getRevision(change.newRevisionId);
      if (rev?.reviewState === 'proposed') ctx.repo.setRevisionState(rev.id, 'superseded');
    }
    const seq = ctx.emit('proposal.resolved', actor, {
      proposalId: previous.id,
      state: 'superseded',
      supersededByProposalId: replacement.id,
    });
    ctx.repo.insertDecision({
      id: newId(),
      proposalId: previous.id,
      action: 'superseded',
      actor,
      ts: new Date().toISOString(),
      rationale,
      priorBaseline: [],
      newBaseline: [],
      eventSeq: seq,
    });
  }
}

export function readProposal(ctx: ProjectContext, proposalId: string) {
  const p = ctx.repo.getProposal(proposalId);
  if (!p) throw new OmenflowError(ErrorCodes.NOT_FOUND, `Proposal not found: ${proposalId}`);
  // Attach resolved revisions so reviewers see concrete content.
  const changes = p.changes.map((c) => {
    const artifact = ctx.repo.getArtifact(c.artifactId);
    const base = c.baseRevisionId ? ctx.repo.getRevision(c.baseRevisionId) : null;
    const next = ctx.repo.getRevision(c.newRevisionId);
    const verification =
      next && artifact?.type === 'mechanical' ? latestCadVerification(ctx, next) : undefined;
    return { change: c, artifact, base, next, verification };
  });
  return { proposal: p, changes };
}

/**
 * Bounded, cancellable wait for resolution. Returns the proposal state, or
 * `pending` on timeout. `cursor` carries an event seq for subsequent waits.
 */
export async function waitProposal(
  ctx: ProjectContext,
  proposalId: string,
  timeoutMs: number,
  _cursor?: number,
): Promise<{ state: Proposal['state']; cursor: number }> {
  const p = ctx.repo.getProposal(proposalId);
  if (!p) throw new OmenflowError(ErrorCodes.NOT_FOUND, `Proposal not found: ${proposalId}`);
  if (p.state !== 'pending') return { state: p.state, cursor: ctx.repo.latestEventSeq() };
  const resolved = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      ctx.proposalWaiters.delete(onEvent);
      resolve(false);
    }, timeoutMs);
    const onEvent = (type: string) => {
      if (type !== 'proposal.resolved') return;
      const cur = ctx.repo.getProposal(proposalId);
      if (cur && cur.state !== 'pending') {
        clearTimeout(timer);
        ctx.proposalWaiters.delete(onEvent);
        resolve(true);
      }
    };
    ctx.proposalWaiters.add(onEvent);
  });
  void resolved;
  const cur = ctx.repo.getProposal(proposalId)!;
  return { state: cur.state, cursor: ctx.repo.latestEventSeq() };
}

function resolveConflicts(ctx: ProjectContext, p: Proposal): void {
  for (const c of p.changes) {
    const artifact = ctx.requireArtifact(c.artifactId);
    const revision = ctx.requireRevision(c.newRevisionId);
    if (
      revision.artifactId !== artifact.id ||
      (c.kind !== 'archive' && !['draft', 'proposed'].includes(revision.reviewState))
    ) {
      throw new OmenflowError(
        ErrorCodes.REVISION_CONFLICT,
        'Proposed revision is no longer an active candidate',
        {
          repair:
            'Refresh the review and submit a current candidate. Rejected or superseded work cannot be promoted.',
        },
      );
    }
    const selected = artifact.selectedRevisionId ?? null;
    if (c.kind === 'new_artifact' && selected !== null)
      throw new OmenflowError(ErrorCodes.REVISION_CONFLICT, 'New artifact now has a baseline');
    if (c.baseRevisionId !== selected) {
      ctx.repo.updateProposalState(
        p.id,
        'conflicted',
        'Base revision changed after proposal was prepared',
      );
      throw new OmenflowError(ErrorCodes.REVISION_CONFLICT, 'Proposal base is stale', {
        repair: 'Refresh the comparison and resubmit.',
        details: { proposalId: p.id, artifactId: c.artifactId, selected, base: c.baseRevisionId },
      });
    }
  }
}

/** Approve a proposal: recheck bindings, promote revisions, apply side effects, propagate. */
function approveProposalImpl(
  ctx: ProjectContext,
  proposalId: string,
  rationale: string,
  verificationEvidence?: Record<string, string>,
) {
  ctx.assertWritable();
  const p = ctx.repo.getProposal(proposalId);
  if (!p) throw new OmenflowError(ErrorCodes.NOT_FOUND, `Proposal not found: ${proposalId}`);
  if (p.state !== 'pending' && p.state !== 'changes_requested') {
    throw new OmenflowError(ErrorCodes.VALIDATION, `Proposal already resolved (${p.state})`);
  }
  resolveConflicts(ctx, p);
  for (const [artifactId, hash] of Object.entries(verificationEvidence ?? {})) {
    const change = p.changes.find((c) => c.artifactId === artifactId && c.kind !== 'archive');
    if (!change)
      throw new OmenflowError(
        ErrorCodes.VALIDATION,
        'Verification scope is not part of this proposal',
      );
    approveCadVerificationScope(ctx, ctx.requireRevision(change.newRevisionId), hash);
  }
  validateSelectedRevisions(
    ctx,
    p.changes.filter((c) => c.kind !== 'archive').map((c) => ctx.requireRevision(c.newRevisionId)),
  );

  const changedArtifactIds: string[] = [];
  const newBaseline: RevisionRef[] = [];
  const priorBaseline: RevisionRef[] = [];
  // The bill of materials changed only if a component, a BOM line or a
  // replaced part did.
  let bomChanged = false;

  ctx.repo.tx(() => {
    for (const c of p.changes) {
      const artifact = ctx.requireArtifact(c.artifactId);
      const rev = ctx.requireRevision(c.newRevisionId);
      if (
        artifact.type === 'component' ||
        c.bomLines?.length ||
        c.removeBomLineIds?.length ||
        c.replacesArtifactId
      ) {
        bomChanged = true;
      }
      if (artifact.selectedRevisionId) {
        priorBaseline.push({ artifactId: artifact.id, revisionId: artifact.selectedRevisionId });
      }
      if (c.kind === 'archive') {
        ctx.repo.setArchived(artifact.id, true);
        changedArtifactIds.push(artifact.id);
        continue;
      }
      promoteRevision(ctx, artifact, rev);
      newBaseline.push({ artifactId: artifact.id, revisionId: rev.id });
      changedArtifactIds.push(artifact.id);

      // Component selection: replaced component is archived (its revision
      // history stays intact; selection is a revisioned decision).
      if (c.kind === 'component_selection' && c.replacesArtifactId) {
        ctx.repo.setArchived(c.replacesArtifactId, true);
        changedArtifactIds.push(c.replacesArtifactId);
      }
      // BOM edits inside the same accepted change.
      if (c.bomLines) {
        for (const l of c.bomLines) {
          ctx.repo.insertBomLine({
            id: newId(),
            componentArtifactId: l.componentArtifactId,
            componentRevisionId: l.componentRevisionId,
            subsystem: l.subsystem,
            quantity: l.quantity,
            offerId: l.offerId,
            location: l.location,
            notes: l.notes,
          });
        }
      }
      if (c.removeBomLineIds) {
        for (const id of c.removeBomLineIds) ctx.repo.deleteBomLine(id);
      }
    }
    const leftover = changesRequestedReplacedBy(ctx, p.changes).filter((prev) => prev.id !== p.id);
    retireReplacedChangeRequests(ctx, p, leftover, 'user');
    ctx.repo.updateProposalState(proposalId, 'accepted', rationale);
    const seq = ctx.emit('proposal.resolved', 'user', { proposalId, state: 'accepted' });
    ctx.repo.insertDecision({
      id: newId(),
      proposalId,
      action: 'accepted',
      actor: 'user',
      ts: new Date().toISOString(),
      rationale: rationale || p.reason,
      priorBaseline,
      newBaseline,
      eventSeq: seq,
    });
    if (changedArtifactIds.length) {
      const affected = propagateFrom(ctx, changedArtifactIds, seq);
      ctx.emit('impact.propagated', 'user', { changed: newBaseline, affected });
      if (bomChanged) ctx.emit('bom.changed', 'system', {});
    }
  });
  return ctx.repo.getProposal(proposalId);
}

function rejectProposalImpl(ctx: ProjectContext, proposalId: string, rationale: string) {
  const p = ctx.repo.getProposal(proposalId);
  if (!p) throw new OmenflowError(ErrorCodes.NOT_FOUND, `Proposal not found: ${proposalId}`);
  if (p.state !== 'pending' && p.state !== 'changes_requested') {
    throw new OmenflowError(ErrorCodes.VALIDATION, `Proposal already resolved (${p.state})`);
  }
  ctx.repo.tx(() => {
    for (const c of p.changes) {
      const rev = ctx.repo.getRevision(c.newRevisionId);
      if (rev?.reviewState === 'proposed') ctx.repo.setRevisionState(rev.id, 'rejected');
    }
    ctx.repo.updateProposalState(proposalId, 'rejected', rationale);
    const seq = ctx.emit('proposal.resolved', 'user', { proposalId, state: 'rejected' });
    ctx.repo.insertDecision({
      id: newId(),
      proposalId,
      action: 'rejected',
      actor: 'user',
      ts: new Date().toISOString(),
      rationale: rationale || p.reason,
      priorBaseline: [],
      newBaseline: [],
      eventSeq: seq,
    });
  });
  return ctx.repo.getProposal(proposalId);
}

function requestChangesProposalImpl(ctx: ProjectContext, proposalId: string, rationale: string) {
  const p = ctx.repo.getProposal(proposalId);
  if (!p) throw new OmenflowError(ErrorCodes.NOT_FOUND, `Proposal not found: ${proposalId}`);
  if (p.state !== 'pending') {
    throw new OmenflowError(ErrorCodes.VALIDATION, `Proposal already resolved (${p.state})`);
  }
  ctx.repo.updateProposalState(proposalId, 'changes_requested', rationale);
  ctx.emit('proposal.resolved', 'user', { proposalId, state: 'changes_requested' });
  return ctx.repo.getProposal(proposalId);
}

export function submitProposal(
  ...args: Parameters<typeof submitProposalImpl>
): ReturnType<typeof submitProposalImpl> {
  args[0].assertWritable();
  return args[0].repo.tx(() => submitProposalImpl(...args));
}

export function approveProposal(
  ...args: Parameters<typeof approveProposalImpl>
): ReturnType<typeof approveProposalImpl> {
  args[0].assertWritable();
  return args[0].repo.tx(() => approveProposalImpl(...args));
}

export function rejectProposal(
  ...args: Parameters<typeof rejectProposalImpl>
): ReturnType<typeof rejectProposalImpl> {
  args[0].assertWritable();
  return args[0].repo.tx(() => rejectProposalImpl(...args));
}

export function requestChangesProposal(
  ...args: Parameters<typeof requestChangesProposalImpl>
): ReturnType<typeof requestChangesProposalImpl> {
  args[0].assertWritable();
  return args[0].repo.tx(() => requestChangesProposalImpl(...args));
}
