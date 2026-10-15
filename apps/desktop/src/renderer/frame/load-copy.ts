/** Words for load failures, kept apart from the components so they can be tested. */
import type { LoadResource, ResourceLoad } from '../store';
import { CORE_RESOURCES } from '../lib/sync';

/** Resources whose failure the frame reports, in words; the agent surface reports its own. */
const NOUNS = {
  artifacts: 'objects',
  graph: 'links',
  proposals: 'proposals',
  events: 'the timeline',
  jobs: 'tool jobs',
} as const;

export type ReportedResource = keyof typeof NOUNS;
const REPORTED = Object.keys(NOUNS) as ReportedResource[];
/** The record a project view is drawn from: until it loads, the stage waits for it. */
export const RECORD = CORE_RESOURCES.filter((r): r is ReportedResource => r in NOUNS);

export interface LoadFailure {
  resources: ReportedResource[];
  /** The first failure's message, as the host worded it. */
  message: string;
  /** Some of the failed data was loaded before, so what is on screen may be out of date. */
  stale: boolean;
}

export function loadFailure(
  load: Record<LoadResource, ResourceLoad>,
  only: readonly ReportedResource[] = REPORTED,
): LoadFailure | null {
  const failed = only.filter((r) => load[r].status === 'error');
  if (!failed.length) return null;
  return {
    resources: failed,
    message: load[failed[0]!].error ?? 'No error message was recorded.',
    stale: failed.some((r) => load[r].loaded),
  };
}

function list(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** "Could not refresh objects and links." / "Could not load the timeline." */
export function failureSentence(failure: LoadFailure): string {
  const nouns = failure.resources.map((r) => NOUNS[r]);
  return `Could not ${failure.stale ? 'refresh' : 'load'} ${list(nouns)}.`;
}
