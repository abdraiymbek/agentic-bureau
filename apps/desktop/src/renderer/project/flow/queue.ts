import type { ArtifactView, Proposal, StaleRecord } from '@omenflow/contracts';
import { needsYou, waitingOnAgent } from '../../lib/proposals';

export interface Suggestion {
  title: string;
  detail?: string;
}

/** An object whose recorded inputs no longer match the project. */
export interface OutdatedItem {
  id: string;
  type: string;
  title: string;
  reason: StaleRecord['reason'];
  /** What changed or is missing, named where the record names it. */
  why: string;
  /** Sequence number of the approved revision, for references typed to the agent. */
  revision: number | null;
}

/** Everything the Needs-you island shows, in the order it shows it. */
export interface NeedsQueue {
  /** Proposals waiting on a human decision, newest first: the order of the decision queue. */
  review: Proposal[];
  /** Proposals a human sent back. The next move is the agent's, so they are not counted. */
  returned: Proposal[];
  /** Missing inputs first, then the objects closest to the change. */
  outdated: OutdatedItem[];
  suggestions: Suggestion[];
  /** What waits on a human: proposals to review and objects out of date. */
  count: number;
  /** Objects with no approved baseline. */
  withoutBaseline: number;
  /** Objects with draft revisions that are in no open proposal. */
  unproposedDrafts: number;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function explain(record: StaleRecord, self: string, byId: Map<string, ArtifactView>): string {
  const cause = byId.get(record.upstreamArtifactId);
  const via = record.path.length > 2 ? byId.get(record.path[record.path.length - 2]!) : undefined;
  const through = via ? `, through ${via.artifact.title}` : '';
  if (record.reason === 'input_changed')
    return cause
      ? `${cause.artifact.title} changed${through}`
      : 'An input changed since it was recorded';
  if (record.upstreamArtifactId === self) return 'Its approved revision is missing';
  if (!cause) return 'An input is archived or missing';
  return cause.revision
    ? `${cause.artifact.title} is missing${through}`
    : `${cause.artifact.title} has no approved baseline${through}`;
}

export function needsQueue(input: {
  proposals: Proposal[];
  artifacts: ArtifactView[];
  stale: Record<string, StaleRecord[]>;
  suggestions: Suggestion[];
}): NeedsQueue {
  const newestFirst = (a: Proposal, b: Proposal) =>
    b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
  const review = needsYou(input.proposals).sort(newestFirst);
  const returned = waitingOnAgent(input.proposals).sort(newestFirst);

  const byId = new Map(input.artifacts.map((v) => [v.artifact.id, v]));
  const ranked = input.artifacts.flatMap((view) => {
    const records = [...(input.stale[view.artifact.id] ?? [])].sort(
      (a, b) =>
        Number(b.reason === 'missing_input') - Number(a.reason === 'missing_input') ||
        a.path.length - b.path.length ||
        a.upstreamArtifactId.localeCompare(b.upstreamArtifactId),
    );
    const first = records[0];
    if (!first) return [];
    const others = new Set(records.map((r) => r.upstreamArtifactId)).size - 1;
    const item: OutdatedItem = {
      id: view.artifact.id,
      type: view.artifact.type,
      title: view.artifact.title,
      reason: first.reason,
      why:
        explain(first, view.artifact.id, byId) +
        (others > 0 ? ` · ${others} more ${others === 1 ? 'input' : 'inputs'}` : ''),
      revision: view.revision?.seq ?? null,
    };
    return [{ item, steps: first.path.length }];
  });
  ranked.sort(
    (a, b) =>
      Number(b.item.reason === 'missing_input') - Number(a.item.reason === 'missing_input') ||
      a.steps - b.steps ||
      collator.compare(a.item.title, b.item.title) ||
      a.item.id.localeCompare(b.item.id),
  );
  const outdated = ranked.map((r) => r.item);

  const seen = new Set<string>();
  const suggestions = input.suggestions.filter((s) => {
    const key = `${s.title}\n${s.detail ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const inOpenProposal = new Set(
    [...review, ...returned].flatMap((p) => p.changes.map((c) => c.artifactId)),
  );
  return {
    review,
    returned,
    outdated,
    suggestions,
    count: review.length + outdated.length,
    withoutBaseline: input.artifacts.filter((v) => !v.revision).length,
    unproposedDrafts: input.artifacts.filter(
      (v) => v.draftCount > 0 && !inOpenProposal.has(v.artifact.id),
    ).length,
  };
}

/** True when the island has rows to show; otherwise it is one quiet line. */
export function hasRows(queue: NeedsQueue): boolean {
  return queue.count + queue.returned.length + queue.suggestions.length > 0;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The one line shown when nothing waits on a human. It claims that every baseline is current
 * and reviewed only when every object has an approved baseline, none is out of date, no
 * proposal is open and no draft is waiting to be proposed. Otherwise it says what is unfinished.
 */
export function quietLine(queue: NeedsQueue): { settled: boolean; text: string } {
  const open: string[] = [];
  if (queue.returned.length)
    open.push(
      `${plural(queue.returned.length, 'proposal is', 'proposals are')} back with the agent`,
    );
  if (queue.withoutBaseline)
    open.push(`${plural(queue.withoutBaseline, 'object has', 'objects have')} no baseline`);
  if (queue.unproposedDrafts)
    open.push(`${plural(queue.unproposedDrafts, 'draft is', 'drafts are')} not proposed`);
  if (queue.count === 0 && open.length === 0)
    return { settled: true, text: 'Every baseline is current and reviewed' };
  return {
    settled: false,
    text: [queue.count ? `${queue.count} waiting on you` : 'Nothing waits on you', ...open].join(
      ' · ',
    ),
  };
}

export type NeedsRow =
  { kind: 'review'; proposal: Proposal } | { kind: 'outdated'; item: OutdatedItem };

/** The rows that wait on a human, proposals first, cut to `limit` with the rest counted. */
export function needsRows(queue: NeedsQueue, limit: number): { rows: NeedsRow[]; hidden: number } {
  const all: NeedsRow[] = [
    ...queue.review.map((proposal) => ({ kind: 'review' as const, proposal })),
    ...queue.outdated.map((item) => ({ kind: 'outdated' as const, item })),
  ];
  return { rows: all.slice(0, limit), hidden: Math.max(0, all.length - limit) };
}
