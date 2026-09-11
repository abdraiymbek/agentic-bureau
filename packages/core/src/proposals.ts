import {
  ErrorCodes,
  Origin,
  Proposal,
  ProposedChange,
  RevisionRef,
  StarkError,
  newId,
} from '@stark/contracts';
import type { ProjectContext } from './context.js';
import { promoteRevision } from './artifacts.js';
import { impactReport, propagateFrom } from './graph.js';

/**
 * Proposal = immutable bound change set. Only the human path resolves it;
 * approval rechecks base bindings before committing.
 */

export function submitProposal(
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
      throw new StarkError(ErrorCodes.VALIDATION, `Revision ${c.newRevisionId} not on artifact ${c.artifactId}`);
    }
    if (rev.reviewState !== 'draft' && rev.reviewState !== 'proposed') {
      throw new StarkError(
        ErrorCodes.VALIDATION,
        `Proposed revision must be a draft (state: ${rev.reviewState})`,
      );
    }
    const cur = artifact.selectedRevisionId;
    if (c.baseRevisionId !== (cur ?? null) && c.kind !== 'new_artifact') {
      throw new StarkError(ErrorCodes.REVISION_CONFLICT, `Proposal base does not match selected revision`, {
        repair: 'Rebuild the proposal against the current baseline.',
        details: { artifactId: c.artifactId, selected: cur, proposed: c.baseRevisionId },
      });
    }
    ctx.repo.setRevisionState(rev.id, 'proposed');
  }
  const refs: RevisionRef[] = input.changes.map((c) => ({ artifactId: c.artifactId, revisionId: c.newRevisionId }));
  const impact = impactReport(ctx, refs);
  const proposal: Proposal = {
    id: newId(),
    changes: input.changes,
    reason: input.reason,
    impact: { affectedArtifactIds: impact.affected.map((a) => a.artifactId), summary: `${impact.affected.length} downstream artifact(s) may be affected` },
    state: 'pending',
    createdBy: origin.kind,
    createdBySession: origin.kind === 'agent' ? origin.sessionId : null,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    resolutionRationale: null,
  };
  ctx.repo.insertProposal(proposal);
  ctx.emit('proposal.submitted', origin.kind, {
    proposalId: proposal.id,
    changes: input.changes.length,
    affected: impact.affected.length,
    reason: input.reason,
  });
  return proposal;
}

export function readProposal(ctx: ProjectContext, proposalId: string) {
  const p = ctx.repo.getProposal(proposalId);
  if (!p) throw new StarkError(ErrorCodes.NOT_FOUND, `Proposal not found: ${proposalId}`);
  // Attach resolved revisions so reviewers see concrete content.
  const changes = p.changes.map((c) => {
    const artifact = ctx.repo.getArtifact(c.artifactId);
    const base = c.baseRevisionId ? ctx.repo.getRevision(c.baseRevisionId) : null;
    const next = ctx.repo.getRevision(c.newRevisionId);
    return { change: c, artifact, base, next };
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
  if (!p) throw new StarkError(ErrorCodes.NOT_FOUND, `Proposal not found: ${proposalId}`);
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
    const selected = artifact.selectedRevisionId ?? null;
    if (c.kind === 'new_artifact') continue;
    if (c.baseRevisionId !== selected) {
      ctx.repo.updateProposalState(p.id, 'conflicted', 'Base revision changed after proposal was prepared');
      throw new StarkError(ErrorCodes.REVISION_CONFLICT, 'Proposal base is stale', {
        repair: 'Refresh the comparison and resubmit.',
        details: { proposalId: p.id, artifactId: c.artifactId, selected, base: c.baseRevisionId },
      });
    }
  }
}

/** Approve a proposal: recheck bindings, promote revisions, apply side effects, propagate. */
export function approveProposal(ctx: ProjectContext, proposalId: string, rationale: string) {
  ctx.assertWritable();
  const p = ctx.repo.getProposal(proposalId);
  if (!p) throw new StarkError(ErrorCodes.NOT_FOUND, `Proposal not found: ${proposalId}`);
  if (p.state !== 'pending' && p.state !== 'changes_requested') {
    throw new StarkError(ErrorCodes.VALIDATION, `Proposal already resolved (${p.state})`);
  }
  resolveConflicts(ctx, p);

  const changedArtifactIds: string[] = [];
  const newBaseline: RevisionRef[] = [];
  const priorBaseline: RevisionRef[] = [];

  ctx.repo.tx(() => {
    for (const c of p.changes) {
      const artifact = ctx.requireArtifact(c.artifactId);
      const rev = ctx.requireRevision(c.newRevisionId);
      if (artifact.selectedRevisionId) {
        priorBaseline.push({ artifactId: artifact.id, revisionId: artifact.selectedRevisionId });
      }
      if (c.kind === 'archive') {
        ctx.repo.setArchived(artifact.id, true);
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
    ctx.repo.updateProposalState(proposalId, 'accepted', rationale);
    const seq = ctx.emit('proposal.resolved', 'user', { proposalId, state: 'accepted' });
    ctx.repo.insertDecision({
      id: newId(),
      proposalId,
      action: 'accepted',
      actor: 'user',
      ts: new Date().toISOString(),
      rationale,
      priorBaseline,
      newBaseline,
      eventSeq: seq,
    });
    if (changedArtifactIds.length) {
      const affected = propagateFrom(ctx, changedArtifactIds, seq);
      ctx.emit('impact.propagated', 'user', { changed: newBaseline, affected });
      ctx.emit('bom.changed', 'system', {});
    }
  });
  return ctx.repo.getProposal(proposalId);
}

export function rejectProposal(ctx: ProjectContext, proposalId: string, rationale: string) {
  const p = ctx.repo.getProposal(proposalId);
  if (!p) throw new StarkError(ErrorCodes.NOT_FOUND, `Proposal not found: ${proposalId}`);
  if (p.state !== 'pending' && p.state !== 'changes_requested') {
    throw new StarkError(ErrorCodes.VALIDATION, `Proposal already resolved (${p.state})`);
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
      rationale,
      priorBaseline: [],
      newBaseline: [],
      eventSeq: seq,
    });
  });
  return ctx.repo.getProposal(proposalId);
}

export function requestChangesProposal(ctx: ProjectContext, proposalId: string, rationale: string) {
  const p = ctx.repo.getProposal(proposalId);
  if (!p) throw new StarkError(ErrorCodes.NOT_FOUND, `Proposal not found: ${proposalId}`);
  if (p.state !== 'pending') {
    throw new StarkError(ErrorCodes.VALIDATION, `Proposal already resolved (${p.state})`);
  }
  ctx.repo.updateProposalState(proposalId, 'changes_requested', rationale);
  ctx.emit('proposal.resolved', 'user', { proposalId, state: 'changes_requested' });
  return ctx.repo.getProposal(proposalId);
}
