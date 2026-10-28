/**
 * Text the person hands back to the agent after deciding: what was decided, why, on which
 * records (full ids), and what the agent is expected to do next. It is typed into the running
 * CLI for the person to read and send; nothing here is sent on its own.
 */
import { affectedIds, isCarrier, type ProposalDetail } from './model';

export type DecisionOutcome = 'approved' | 'rejected' | 'changes_requested';

export interface RecordedDecision {
  proposalId: string;
  reason: string;
  outcome: DecisionOutcome;
  rationale: string;
  changes: {
    artifactId: string;
    title: string;
    type: string;
    revisionId: string | null;
    seq: number | null;
    /**
     * A bill-of-materials edit the core carries on the component's baseline: the revision named
     * is that baseline, which approval keeps, not the copy that carried the lines.
     */
    carrier: boolean;
  }[];
  /** Downstream objects the core listed as possibly affected. */
  affected: number;
  /** Titles of objects whose declared verification scope the person accepted. */
  acceptedScopes: string[];
}

export function recordOf(
  d: ProposalDetail,
  outcome: DecisionOutcome,
  rationale: string,
  acceptedScopes: string[],
): RecordedDecision {
  return {
    proposalId: d.proposal.id,
    reason: d.proposal.reason,
    outcome,
    rationale: rationale.trim(),
    changes: d.changes.map((c) => {
      const carrier = isCarrier(c);
      const named = carrier ? c.base : c.next;
      return {
        artifactId: c.change.artifactId,
        title: c.artifact?.title ?? c.change.artifactId,
        type: c.artifact?.type ?? 'object',
        revisionId: named?.id ?? c.change.newRevisionId,
        seq: named?.seq ?? null,
        carrier,
      };
    }),
    affected: affectedIds(d).length,
    acceptedScopes,
  };
}

const VERB: Record<DecisionOutcome, string> = {
  approved: 'Approved',
  rejected: 'Rejected',
  changes_requested: 'Asked for changes on',
};

export function outcomeWords(outcome: DecisionOutcome): string {
  return outcome === 'approved'
    ? 'Approved'
    : outcome === 'rejected'
      ? 'Rejected'
      : 'Changes requested';
}

const NEXT: Record<DecisionOutcome, string> = {
  approved:
    'Approved revisions are now the baseline: build on them. Call work_status to see what is still unfinished, including objects the approval marked out of date.',
  changes_requested:
    'For each proposal returned with changes: revise the draft to address the rationale, then submit a replacement with proposal_submit for the same objects. The replacement supersedes the returned proposal. Do not edit the baseline directly.',
  rejected:
    'Do not resubmit a rejected change as it was. Call work_status, and ask the person before proposing an alternative.',
};

export function handoffText(decisions: RecordedDecision[]): string {
  const lines = [
    `Bureau: the person recorded ${decisions.length === 1 ? 'a review decision' : `${decisions.length} review decisions`}.`,
    '',
  ];
  decisions.forEach((d, i) => {
    lines.push(`${i + 1}. ${VERB[d.outcome]} proposal ${d.proposalId} ("${d.reason}").`);
    lines.push(d.rationale ? `   Rationale: "${d.rationale}"` : '   Rationale: none given.');
    for (const c of d.changes) {
      const revision = c.revisionId ? `${c.seq !== null ? `r${c.seq} ` : ''}${c.revisionId}` : '';
      lines.push(
        `   ${c.type} "${c.title}" (artifact ${c.artifactId}${
          c.carrier
            ? `, bill of materials edit; the baseline stays revision ${revision}`
            : revision
              ? `, revision ${revision}`
              : ''
        })`,
      );
    }
    if (d.outcome === 'approved' && d.affected)
      lines.push(
        `   ${d.affected} downstream ${d.affected === 1 ? 'object' : 'objects'} may now be out of date.`,
      );
    if (d.acceptedScopes.length)
      lines.push(`   Verification scope accepted for: ${d.acceptedScopes.join(', ')}.`);
  });
  lines.push('', 'Next:');
  for (const outcome of ['approved', 'changes_requested', 'rejected'] as const)
    if (decisions.some((d) => d.outcome === outcome)) lines.push(`- ${NEXT[outcome]}`);
  lines.push(
    `Full record: proposal_read {"proposalId":"${decisions[0]!.proposalId}"}${
      decisions.length > 1 ? ' (one call per proposal id above)' : ''
    }; call it through tool_call if proposal_read is not in your tool list.`,
  );
  return lines.join('\n');
}

/** The rebase request typed into the agent when a change's base moved. */
export function rebaseText(
  d: ProposalDetail,
  moved: { title: string; artifactId: string; baseSeq: number | null; currentSeq: number | null }[],
): string {
  const parts = moved.map(
    (m) =>
      `${m.title} (artifact ${m.artifactId}) was proposed on ${m.baseSeq !== null ? `r${m.baseSeq}` : 'no baseline'} but its baseline is now ${m.currentSeq !== null ? `r${m.currentSeq}` : 'a newer revision'}`,
  );
  return [
    `Proposal ${d.proposal.id} ("${d.proposal.reason}") cannot be approved because its base moved: ${parts.join('; ')}.`,
    'Rebuild the change on the current baseline and submit it again with proposal_submit for the same objects; the new proposal supersedes this one. Then call work_status.',
  ].join(' ');
}
