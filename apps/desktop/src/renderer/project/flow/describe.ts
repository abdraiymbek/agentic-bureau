import type { ArtifactView } from '@omenflow/contracts';

/** Engineering state of one object as the map marks it. Each flag is a separate dimension. */
export const FLAG = {
  stale: 1,
  missing: 2,
  review: 4,
  noBaseline: 8,
  draft: 16,
  touched: 32,
  impact: 64,
} as const;

export function flagsOf(view: ArtifactView, touched: boolean, onStalePath: boolean): number {
  const records = view.staleReasons;
  const missing =
    view.freshness === 'missing_input' || records.some((r) => r.reason === 'missing_input');
  return (
    (missing ? FLAG.missing : 0) |
    (!missing && (view.freshness === 'stale' || records.length > 0) ? FLAG.stale : 0) |
    (view.pendingProposal ? FLAG.review : 0) |
    (view.revision ? 0 : FLAG.noBaseline) |
    (view.draftCount > 0 ? FLAG.draft : 0) |
    (touched ? FLAG.touched : 0) |
    (onStalePath ? FLAG.impact : 0)
  );
}

export interface StateWord {
  text: string;
  tone: 'ok' | 'warn' | 'err' | 'signal' | 'neutral';
}

/**
 * The state of one object in words, one per dimension: review, freshness, an open change, and
 * recent agent activity. Approved does not imply current, so both are always said.
 */
export function stateWords(flags: number): StateWord[] {
  const words: StateWord[] = [];
  if (flags & FLAG.noBaseline)
    words.push({
      text: flags & FLAG.draft ? 'Draft, no approved baseline' : 'No approved baseline',
      tone: 'neutral',
    });
  else words.push({ text: 'Approved baseline', tone: 'ok' });
  if (flags & FLAG.missing) words.push({ text: 'Missing input', tone: 'err' });
  else if (flags & FLAG.stale) words.push({ text: 'Out of date', tone: 'warn' });
  else if (!(flags & FLAG.noBaseline)) words.push({ text: 'Current', tone: 'ok' });
  if (flags & FLAG.review) words.push({ text: 'Change in review', tone: 'warn' });
  if (flags & FLAG.touched)
    words.push({ text: 'Changed by the agent in the last 15 minutes', tone: 'signal' });
  return words;
}

/** The accessible name of an object node: its type, title and state in words. */
export function nodeName(typeLabel: string, title: string, flags: number): string {
  const states = stateWords(flags).map((w) => w.text.toLowerCase());
  return `${typeLabel}: ${title}. ${states.join(', ')}.`;
}

/** What a collapsed group holds, counted per state. Only states that occur are named. */
export function groupSummary(memberFlags: number[]): string[] {
  const count = (flag: number) => memberFlags.filter((f) => f & flag).length;
  const parts: [number, string][] = [
    [count(FLAG.missing), 'missing an input'],
    [count(FLAG.stale), 'out of date'],
    [count(FLAG.review), 'in review'],
    [count(FLAG.noBaseline), 'without a baseline'],
    [count(FLAG.touched), 'changed by the agent'],
  ];
  return parts.filter(([n]) => n > 0).map(([n, text]) => `${n} ${text}`);
}

/** The accessible name of a collapsed type group. */
export function groupName(plural: string, memberFlags: number[]): string {
  const size = memberFlags.length;
  const summary = groupSummary(memberFlags);
  return (
    `${plural}: collapsed group of ${size} ${size === 1 ? 'object' : 'objects'}.` +
    (summary.length ? ` ${summary.join(', ')}.` : '')
  );
}

/**
 * The marks a collapsed group shows: every state any member is in, and "no baseline" only when
 * no member has one.
 */
export function groupFlags(memberFlags: number[]): number {
  const any = memberFlags.reduce((a, f) => a | f, 0);
  const all = memberFlags.reduce((a, f) => a & f, FLAG.noBaseline);
  return (any & ~(FLAG.noBaseline | FLAG.draft)) | (memberFlags.length ? all : 0);
}
