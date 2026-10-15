/**
 * Who a proposal is waiting on, as one rule for every surface that counts or lists proposals:
 * the activity-bar badge, the titlebar pill, the omnibar and the decision queue. Pure, with
 * type-only imports, so the entry chunk can use it without loading the decision view.
 */
import type { Proposal } from '@omenflow/contracts';

/** The fields the rule reads. V1 cores add `supersededBy`; older ones record it in `impact`. */
type Waiting = Pick<Proposal, 'state' | 'impact'> & { supersededBy?: string | null };

/** The proposal that replaced this one, when the core recorded one. */
export function supersededBy(p: Pick<Waiting, 'impact' | 'supersededBy'>): string | null {
  return p.supersededBy ?? p.impact?.supersededByProposalId ?? null;
}

/** Waiting on the person: pending and not replaced. */
export const needsYou = <P extends Waiting>(ps: P[]) =>
  ps.filter((p) => p.state === 'pending' && !supersededBy(p));

/** Returned to the agent with a request for changes. */
export const waitingOnAgent = <P extends Waiting>(ps: P[]) =>
  ps.filter((p) => p.state === 'changes_requested' && !supersededBy(p));
