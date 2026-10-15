/**
 * The single state vocabulary. Review, freshness, evidence and execution are independent
 * dimensions; each state has one word and one tone. `State` and `Pulse` render from here, and
 * nothing else should spell a state.
 */

export type Tone = 'ok' | 'warn' | 'err' | 'signal' | 'neutral';

export type StateDimension =
  /** A revision's review: draft, in review, approved, changes requested. */
  | 'review'
  /** A proposal's resolution. Same words as review, plus what only proposals can be. */
  | 'proposal'
  /** Whether a baseline still matches its inputs: current, out of date. */
  | 'freshness'
  /** How a value is known, and what recorded evidence says about a requirement. */
  | 'evidence'
  /** A recorded test result. Only a recorded result can say passed or failed. */
  | 'result'
  /** A committed CAD verification. */
  | 'verification'
  /** Work running now: agent sessions and jobs. */
  | 'execution'
  /** A component's place in selection. */
  | 'part';

export interface StateWord {
  label: string;
  tone: Tone;
}

const w = (label: string, tone: Tone): StateWord => ({ label, tone });

export const VOCABULARY: Record<StateDimension, Record<string, StateWord>> = {
  review: {
    draft: w('Draft', 'neutral'),
    proposed: w('In review', 'warn'),
    approved: w('Approved', 'ok'),
    changes_requested: w('Changes requested', 'warn'),
    rejected: w('Rejected', 'err'),
    superseded: w('Superseded', 'neutral'),
  },
  proposal: {
    pending: w('In review', 'warn'),
    accepted: w('Approved', 'ok'),
    changes_requested: w('Changes requested', 'warn'),
    rejected: w('Rejected', 'err'),
    conflicted: w('Conflicted', 'warn'),
    cancelled: w('Cancelled', 'neutral'),
    superseded: w('Superseded', 'neutral'),
  },
  freshness: {
    current: w('Current', 'ok'),
    stale: w('Out of date', 'warn'),
    missing_input: w('Missing input', 'err'),
  },
  evidence: {
    assumed: w('Assumed', 'neutral'),
    sourced: w('Sourced', 'neutral'),
    calculated: w('Calculated', 'neutral'),
    simulated: w('Simulated', 'neutral'),
    measured: w('Measured', 'neutral'),
    experimental: w('Experimental', 'warn'),
    covered: w('Covered', 'ok'),
    partial: w('Partly covered', 'warn'),
    none: w('No evidence', 'err'),
    no_result: w('No result', 'neutral'),
  },
  result: {
    planned: w('Planned', 'neutral'),
    not_run: w('Not run', 'neutral'),
    passed: w('Passed', 'ok'),
    failed: w('Failed', 'err'),
    inconclusive: w('Inconclusive', 'warn'),
  },
  verification: {
    unverified: w('Unverified', 'warn'),
    passed: w('Verified', 'ok'),
    verified: w('Verified', 'ok'),
    partial: w('Partly verified', 'warn'),
    scope_changed: w('Scope changed', 'warn'),
    failed: w('Check failed', 'err'),
  },
  execution: {
    queued: w('Queued', 'neutral'),
    starting: w('Starting', 'signal'),
    running: w('Running', 'signal'),
    succeeded: w('Succeeded', 'ok'),
    failed: w('Failed', 'err'),
    interrupted: w('Interrupted', 'warn'),
    cancelled: w('Cancelled', 'neutral'),
    exited: w('Ended', 'neutral'),
  },
  part: {
    candidate: w('Candidate', 'neutral'),
    selected: w('Selected', 'ok'),
    rejected: w('Rejected', 'err'),
    superseded: w('Superseded', 'neutral'),
  },
};

/** Where a state word is looked up when the caller does not name its dimension. */
const SEARCH_ORDER: StateDimension[] = [
  'review',
  'proposal',
  'freshness',
  'result',
  'execution',
  'part',
  'evidence',
  'verification',
];

export function stateWord(state: string, dimension?: StateDimension): StateWord {
  const found = dimension
    ? VOCABULARY[dimension][state]
    : SEARCH_ORDER.map((d) => VOCABULARY[d][state]).find(Boolean);
  if (found) return found;
  const words = state.replaceAll(/[_-]+/g, ' ').trim();
  return w(words ? words[0]!.toUpperCase() + words.slice(1) : 'Unknown state', 'neutral');
}

export function stateLabel(state: string, dimension?: StateDimension): string {
  return stateWord(state, dimension).label;
}

export function stateTone(state: string, dimension?: StateDimension): Tone {
  return stateWord(state, dimension).tone;
}
