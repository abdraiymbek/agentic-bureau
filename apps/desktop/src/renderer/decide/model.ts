/**
 * The decision level's model: what the core returned for a proposal, who owns the next move,
 * the queue, and what approval would do. Pure: no React, no store, no I/O.
 *
 * Fields added by the V1 core (`baseMoved`, `supersedesProposalIds`, `supersededBy`,
 * `verification`) are read when present and never invented when absent. Where an older core
 * omits `baseMoved`, it is derived from the same recorded fact the core checks on approval:
 * the change's base revision against the artifact's selected revision.
 */
import type {
  Artifact,
  CadSpecReadiness,
  CadSpecReport,
  Proposal,
  ProposedChange,
  Revision,
} from '@omenflow/contracts';
import { needsYou, supersededBy } from '../lib/proposals';

export { needsYou, supersededBy, waitingOnAgent } from '../lib/proposals';

export interface VerificationEvidence {
  expect?: unknown;
  pass?: boolean;
  status?: string;
  exploratory?: boolean;
  scopeChanges?: string[];
  checks?: { name: string; pass: boolean; detail: string }[];
  integrity?: { pass: boolean; detail: string };
  coverage?: {
    units?: string;
    frame?: string;
    assertions?: string[];
    limitations?: string[];
    requirementAuthority?: string;
  };
  /** The check's listed items and linked requirements, when it had any. */
  spec?: CadSpecReport;
}

/** `proposal.read` verification for a mechanical change (`cad::latest_verification`). */
export interface VerificationReview {
  status: string;
  evidenceHash?: string;
  evidence?: VerificationEvidence;
  /** Gaps of the recorded items, and requirements linked or changed since the check. */
  spec?: CadSpecReadiness;
}

export type ReviewChange = ProposedChange & { baseMoved?: boolean };
export type ReviewProposal = Omit<Proposal, 'changes'> & {
  changes: ReviewChange[];
  supersedesProposalIds?: string[];
  supersededBy?: string | null;
};

export interface ChangeDetail {
  change: ReviewChange;
  artifact: Artifact | null;
  base: Revision | null;
  next: Revision | null;
  verification?: VerificationReview;
  baseMoved?: boolean;
}

export interface ProposalDetail {
  proposal: ReviewProposal;
  changes: ChangeDetail[];
}

/* ------------------------------------------------------------------ */
/* Who owns the next move                                               */
/* ------------------------------------------------------------------ */

export type Phase =
  | { kind: 'needs_you' }
  | { kind: 'base_moved'; artifactIds: string[] }
  | { kind: 'waiting_on_agent'; request: string | null; artifactIds: string[] }
  | { kind: 'superseded'; by: string | null }
  | {
      kind: 'decided';
      outcome: 'approved' | 'rejected';
      rationale: string | null;
      at: string | null;
    }
  | { kind: 'conflicted'; reason: string | null }
  | { kind: 'cancelled' }
  | { kind: 'other'; state: string };

export function supersedes(p: ReviewProposal): string[] {
  return p.supersedesProposalIds ?? p.impact?.supersedesProposalIds ?? [];
}

/** The core's `baseMoved` when it sends one; otherwise its approval rule on the recorded ids. */
export function changeBaseMoved(c: ChangeDetail): boolean {
  const flag = c.baseMoved ?? c.change.baseMoved;
  if (typeof flag === 'boolean') return flag;
  if (!c.artifact) return false;
  return (c.artifact.selectedRevisionId ?? null) !== (c.change.baseRevisionId ?? null);
}

const blank = (s: string | null | undefined) => (s?.trim() ? s : null);

function phaseOf(p: ReviewProposal, moved: string[]): Phase {
  const by = supersededBy(p);
  if (p.state === 'superseded' || by) return { kind: 'superseded', by };
  switch (p.state) {
    case 'pending':
      return moved.length ? { kind: 'base_moved', artifactIds: moved } : { kind: 'needs_you' };
    case 'changes_requested':
      return {
        kind: 'waiting_on_agent',
        request: blank(p.resolutionRationale),
        artifactIds: moved,
      };
    case 'accepted':
    case 'rejected':
      return {
        kind: 'decided',
        outcome: p.state === 'accepted' ? 'approved' : 'rejected',
        rationale: blank(p.resolutionRationale),
        at: p.resolvedAt,
      };
    case 'conflicted':
      return { kind: 'conflicted', reason: blank(p.resolutionRationale) };
    case 'cancelled':
      return { kind: 'cancelled' };
    default:
      return { kind: 'other', state: p.state };
  }
}

/** Phase of a loaded proposal. */
export function detailPhase(d: ProposalDetail): Phase {
  return phaseOf(
    d.proposal,
    d.changes.filter(changeBaseMoved).map((c) => c.change.artifactId),
  );
}

/**
 * Phase of a queue entry. `selectedOf` gives an artifact's current baseline from the project
 * list (undefined when the artifact is not listed, e.g. archived).
 */
export function listPhase(
  p: ReviewProposal,
  selectedOf: (artifactId: string) => string | null | undefined,
): Phase {
  const moved = p.changes
    .filter((c) => {
      if (typeof c.baseMoved === 'boolean') return c.baseMoved;
      const selected = selectedOf(c.artifactId);
      return selected !== undefined && selected !== (c.baseRevisionId ?? null);
    })
    .map((c) => c.artifactId);
  return phaseOf(p, moved);
}

export function phaseLabel(phase: Phase): string {
  switch (phase.kind) {
    case 'needs_you':
      return 'Needs you';
    case 'base_moved':
      return 'Base moved';
    case 'waiting_on_agent':
      return 'Waiting on the agent';
    case 'superseded':
      return 'Superseded';
    case 'decided':
      return phase.outcome === 'approved' ? 'Approved' : 'Rejected';
    case 'conflicted':
      return 'Conflicted';
    case 'cancelled':
      return 'Cancelled';
    default:
      return phase.state.replaceAll('_', ' ');
  }
}

export function phaseTone(phase: Phase): 'ok' | 'warn' | 'err' | 'neutral' {
  switch (phase.kind) {
    case 'needs_you':
    case 'base_moved':
    case 'conflicted':
      return 'warn';
    case 'decided':
      return phase.outcome === 'approved' ? 'ok' : 'err';
    default:
      return 'neutral';
  }
}

/** A person can still record a decision: pending, or returned to the agent. */
export const decidable = (phase: Phase) =>
  phase.kind === 'needs_you' || phase.kind === 'base_moved' || phase.kind === 'waiting_on_agent';

/* ------------------------------------------------------------------ */
/* Queue                                                                */
/* ------------------------------------------------------------------ */

export type QueueFilter = 'open' | 'all';

const newestFirst = <T extends { createdAt: string }>(list: T[]) =>
  list.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export function queueList(ps: ReviewProposal[], filter: QueueFilter): ReviewProposal[] {
  return newestFirst(filter === 'open' ? needsYou(ps) : ps);
}

/**
 * Where to go after deciding `decidedId`: the next proposal below it in the queue as it was
 * shown, else the nearest above, else whatever still needs the person, else nothing.
 */
export function nextAfterDecision(
  shownOrder: string[],
  decidedId: string,
  stillOpen: string[],
): string | null {
  const open = new Set(stillOpen.filter((id) => id !== decidedId));
  const at = shownOrder.indexOf(decidedId);
  if (at >= 0) {
    for (let i = at + 1; i < shownOrder.length; i++)
      if (open.has(shownOrder[i]!)) return shownOrder[i]!;
    for (let i = at - 1; i >= 0; i--) if (open.has(shownOrder[i]!)) return shownOrder[i]!;
  }
  return stillOpen.find((id) => id !== decidedId) ?? null;
}

/* ------------------------------------------------------------------ */
/* Changes underneath                                                   */
/* ------------------------------------------------------------------ */

/** Everything about a proposal that a reviewer's reading depends on. */
export function fingerprint(d: ProposalDetail): string {
  return JSON.stringify({
    state: d.proposal.state,
    by: supersededBy(d.proposal),
    changes: d.changes.map((c) => [
      c.change.artifactId,
      c.change.baseRevisionId ?? null,
      c.change.newRevisionId,
      c.next?.contentHash ?? null,
      c.artifact?.selectedRevisionId ?? null,
      changeBaseMoved(c),
      c.verification?.status ?? null,
      c.verification?.evidenceHash ?? null,
    ]),
  });
}

/** A cheap key from list data: when it changes, the open proposal is read again. */
export function listVersion(
  p: ReviewProposal,
  selectedOf: (artifactId: string) => string | null | undefined,
): string {
  return JSON.stringify([
    p.state,
    p.resolvedAt,
    supersededBy(p),
    p.changes.map((c) => [
      c.artifactId,
      c.baseRevisionId ?? null,
      c.newRevisionId,
      c.baseMoved ?? null,
      selectedOf(c.artifactId) ?? null,
    ]),
  ]);
}

const titleOfChange = (c: ChangeDetail) => c.artifact?.title ?? 'An object';

/** What changed between the version the reviewer read and the one the core now returns. */
export function whatChanged(before: ProposalDetail, after: ProposalDetail): string[] {
  const out: string[] = [];
  const was = detailPhase(before);
  const now = detailPhase(after);
  if (was.kind !== now.kind || phaseLabel(was) !== phaseLabel(now)) {
    out.push(
      now.kind === 'superseded'
        ? 'A newer proposal replaced it.'
        : `It is now “${phaseLabel(now)}” (it was “${phaseLabel(was)}”).`,
    );
  }
  if (before.changes.length !== after.changes.length)
    out.push(`It now has ${after.changes.length} changes (it had ${before.changes.length}).`);
  for (const c of after.changes) {
    const old = before.changes.find((x) => x.change.artifactId === c.change.artifactId);
    if (!old) continue;
    const title = titleOfChange(c);
    if (old.change.newRevisionId !== c.change.newRevisionId)
      out.push(
        `${title}: the proposed revision changed (r${old.next?.seq ?? '?'} → r${c.next?.seq ?? '?'}).`,
      );
    if ((old.artifact?.selectedRevisionId ?? null) !== (c.artifact?.selectedRevisionId ?? null))
      out.push(`${title}: its baseline moved while this was open.`);
    if (
      (old.verification?.evidenceHash ?? null) !== (c.verification?.evidenceHash ?? null) ||
      (old.verification?.status ?? null) !== (c.verification?.status ?? null)
    )
      out.push(`${title}: the verification evidence changed.`);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Consequences                                                         */
/* ------------------------------------------------------------------ */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * A bill-of-materials edit carried by an unchanged copy of its component's baseline. Approving it
 * changes the lines, not the component: the core keeps the baseline, retires the copy and marks
 * nothing downstream out of date. The test mirrors the core's (`carrier_baseline`): the copy's
 * parent is the base, and its content and recorded inputs are the base's.
 */
export function isCarrier(c: ChangeDetail): boolean {
  const { base, next } = c;
  return (
    c.change.kind === 'bom_edit' &&
    !!base &&
    !!next &&
    next.parentId === base.id &&
    next.contentHash === base.contentHash &&
    JSON.stringify(next.inputs ?? []) === JSON.stringify(base.inputs ?? [])
  );
}

/**
 * Objects the core lists as possibly out of date after approval. A proposal whose every change
 * is a carried bill-of-materials edit marks nothing: the core computes the impact on submission,
 * but approving it moves no baseline.
 */
export function affectedIds(d: ProposalDetail): string[] {
  if (d.changes.length && d.changes.every(isCarrier)) return [];
  return d.proposal.impact?.affectedArtifactIds ?? [];
}

/** What approving one change does to its object. */
function changeEffect(c: ChangeDetail, title: string): string {
  const next = c.next ? `r${c.next.seq}` : 'the proposed revision';
  if (isCarrier(c))
    return `${title}: the baseline stays r${c.base!.seq}; only its bill of materials changes.`;
  switch (c.change.kind) {
    case 'new_artifact':
      return `${title}: ${next} becomes its first baseline.`;
    case 'archive':
      return `${title} is archived.`;
    case 'component_selection':
      return `${title} is selected for the build; ${next} becomes its baseline.`;
    default:
      return c.base
        ? `${title}: the baseline moves from r${c.base.seq} to ${next}.`
        : `${title}: ${next} becomes the baseline.`;
  }
}

/**
 * What approving does, in words, from the change records and the impact the core computed.
 * `moved` names the objects whose baseline moved after the change was prepared. The core then
 * refuses the whole approval, so only that is said: none of its effects can happen.
 */
export function approvalEffects(
  d: ProposalDetail,
  titleOf: (artifactId: string) => string,
  acceptedScopes: Record<string, string>,
  moved: string[] = [],
): string[] {
  const refused = d.changes
    .filter((c) => moved.includes(c.change.artifactId))
    .map(
      (c) =>
        `${c.artifact?.title ?? titleOf(c.change.artifactId)}: its baseline is newer than ${c.base ? `r${c.base.seq}, ` : ''}the revision this change was prepared on.`,
    );
  if (refused.length) return [...refused, 'Nothing changes until the agent rebuilds the change.'];
  const out: string[] = [];
  for (const c of d.changes) {
    const title = c.artifact?.title ?? titleOf(c.change.artifactId);
    out.push(changeEffect(c, title));
    if (c.change.replacesArtifactId)
      out.push(
        `${titleOf(c.change.replacesArtifactId)} is archived and leaves the bill of materials.`,
      );
    if (c.change.bomLines?.length)
      out.push(
        `Adds ${plural(c.change.bomLines.length, 'bill of materials line', 'bill of materials lines')}.`,
      );
    if (c.change.removeBomLineIds?.length)
      out.push(
        `Removes ${plural(c.change.removeBomLineIds.length, 'bill of materials line', 'bill of materials lines')}.`,
      );
    if (acceptedScopes[c.change.artifactId])
      out.push(`${title}: you accept the declared verification scope.`);
  }
  const affected = affectedIds(d).length;
  if (affected)
    out.push(
      `${plural(affected, 'downstream object', 'downstream objects')} may be marked out of date.`,
    );
  out.push('The decision and your rationale are kept in the record.');
  return out;
}
