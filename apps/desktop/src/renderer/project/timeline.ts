/**
 * The Timeline lens's model of the project record: which events become rows, how adjacent events
 * merge, and where recorded agent tool calls sit between record events. The store holds the
 * record's window and pages older events in.
 */
import type { AgentCallRecord, ProjectEvent, Proposal } from '@bureau/contracts';

const LABELS: Record<string, string> = {
  'proposal.submitted': 'Proposed',
  'proposal.resolved': 'Decided',
  'baseline.changed': 'Baseline updated',
  'impact.propagated': 'Impact reached',
  'revision.committed': 'Revised',
  'project.created': 'Project created',
  'project.intent_changed': 'Intent changed',
  'build.exported': 'Build exported',
  'cad.exported': 'Exported',
  'bom.changed': 'Bill of materials changed',
  'artifact.archived': 'Archived',
};

export type Actor = 'all' | ProjectEvent['origin'];

export const ACTOR_LABEL: Record<ProjectEvent['origin'], string> = {
  user: 'You',
  agent: 'Agent',
  system: 'System',
};

/** Event data is recorded per event type; every field is read defensively. */
interface EventData {
  artifactId?: unknown;
  proposalId?: unknown;
  reviewState?: unknown;
  changed?: unknown;
  affected?: unknown;
  state?: unknown;
  format?: unknown;
  method?: unknown;
}

const data = (e: ProjectEvent) => (e.data ?? {}) as EventData;

/**
 * Objects an impact reached beyond the ones that changed. A changed object that stays out of date
 * because of its own older inputs is listed among the affected, but nothing reached it.
 */
function reached(d: EventData): number | null {
  if (!Array.isArray(d.affected)) return null;
  const changed = new Set(idsIn(d.changed));
  return d.affected.length - idsIn(d.affected).filter((id) => changed.has(id)).length;
}

/** The row label for an event, or null when the event is not part of the record view. */
export function eventLabel(e: ProjectEvent): string | null {
  const label = LABELS[e.type];
  if (!label) return null;
  const d = data(e);
  if (e.type === 'impact.propagated' && reached(d) === 0) return null;
  if (e.type === 'revision.committed' && d.reviewState === 'draft') return 'Drafted';
  if (e.type === 'cad.exported')
    return `Exported ${(text(d.format) ?? 'file').toUpperCase()}${d.method === 'faceted' ? ' (faceted)' : ''}`;
  return label;
}

const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** Ids from a list of ids or of `{ artifactId }` objects; anything else holds none. */
function idsIn(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((a) =>
      typeof a === 'string'
        ? a
        : a && typeof a === 'object' && 'artifactId' in a
          ? String((a as { artifactId: unknown }).artifactId)
          : null,
    )
    .filter((x): x is string => !!x);
}

/** The fields the Timeline shows, each present only when recorded with the expected type. */
export function eventFields(e: ProjectEvent) {
  const d = data(e) as EventData & Record<string, unknown>;
  return {
    artifactId: text(d.artifactId),
    proposalId: text(d.proposalId),
    changed: idsIn(d.changed),
    affected: reached(d),
    state: text(d.state),
    reason: text(d.reason),
    rationale: text(d.rationale),
    intent: text(d.intent),
    destPath: text(d.destPath),
    format: text(d.format),
    method: text(d.method),
  };
}

/** Every object an event is about, including the objects a proposal changes. */
export function eventArtifactIds(e: ProjectEvent, proposals: Proposal[]): string[] {
  const d = data(e);
  const ids = new Set<string>();
  const subject = text(d.artifactId);
  if (subject) ids.add(subject);
  for (const id of [...idsIn(d.changed), ...idsIn(d.affected)]) ids.add(id);
  const proposalId = text(d.proposalId);
  if (proposalId)
    for (const c of proposals.find((p) => p.id === proposalId)?.changes ?? [])
      ids.add(c.artifactId);
  return [...ids];
}

export interface TimelineFilter {
  actor: Actor;
  objectId: string | null;
}

/** Whether approving this proposal can change the bill of materials. */
function touchesBom(p: Proposal, componentIds: ReadonlySet<string>): boolean {
  return p.changes.some(
    (c) =>
      c.kind === 'component_selection' ||
      c.kind === 'bom_edit' ||
      !!c.replacesArtifactId ||
      !!c.bomLines?.length ||
      !!c.removeBomLineIds?.length ||
      componentIds.has(c.artifactId),
  );
}

/**
 * Earlier builds of the core announced a bill of materials change, with nothing recorded about
 * it, after every approval, and those events stay in the record of every project they wrote.
 * After an approval that touched no component and no line nothing in the bill changed, so that
 * row would state something that did not happen. Anything else is kept: an approval outside the
 * loaded window, or one whose proposal is not loaded, cannot be judged.
 */
function bomUnchangedSet(
  events: ProjectEvent[],
  proposals: Proposal[],
  componentIds: ReadonlySet<string> | undefined,
): Set<number> {
  const unchanged = new Set<number>();
  if (!componentIds) return unchanged;
  const bySeq = [...events].sort((a, b) => a.seq - b.seq);
  bySeq.forEach((e, i) => {
    if (e.type !== 'bom.changed' || Object.keys(e.data ?? {}).length) return;
    for (let j = i - 1; j >= 0; j--) {
      const before = bySeq[j]!;
      if (before.seq !== bySeq[j + 1]!.seq - 1) return;
      const accepted = before.type === 'proposal.resolved' && data(before).state === 'accepted';
      if (before.type === 'impact.propagated' || (before.type === 'proposal.resolved' && !accepted))
        continue;
      if (!accepted) return;
      const approved = proposals.find((p) => p.id === text(data(before).proposalId));
      if (approved && !touchesBom(approved, componentIds)) unchanged.add(e.seq);
      return;
    }
  });
  return unchanged;
}

/**
 * Events that become rows. `componentIds` (the project's components) lets an approval's bill of
 * materials announcement be judged; without it every announcement is kept.
 */
export function filterEvents(
  events: ProjectEvent[],
  filter: TimelineFilter,
  proposals: Proposal[],
  componentIds?: ReadonlySet<string>,
): ProjectEvent[] {
  const bomUnchanged = bomUnchangedSet(events, proposals, componentIds);
  return events.filter(
    (e) =>
      eventLabel(e) !== null &&
      !bomUnchanged.has(e.seq) &&
      (filter.actor === 'all' || e.origin === filter.actor) &&
      (!filter.objectId || eventArtifactIds(e, proposals).includes(filter.objectId)),
  );
}

export interface TimelineEntry {
  kind: 'event';
  key: string;
  event: ProjectEvent;
  labels: string[];
  /** How many events of the same kind this row stands for. */
  count: number;
}

export interface CallRun {
  kind: 'calls';
  key: string;
  calls: AgentCallRecord[];
}

export type TimelineItem = TimelineEntry | CallRun;

const SAME_CHANGE_MS = 10_000;
const SAME_BURST_MS = 60_000;

const REVISION_LABELS = ['Drafted', 'Revised'];
/** Two revisions of one object stay two rows; only different kinds of event merge. */
const sameKind = (a: string, b: string) =>
  a === b || (REVISION_LABELS.includes(a) && REVISION_LABELS.includes(b));

const apart = (a: string, b: string) => Math.abs(new Date(a).getTime() - new Date(b).getTime());

/**
 * Rows, newest first. A revision and the baseline move that follows it are one row; repeated
 * events with no subject (bill of materials changes) within a minute are one row with a count.
 * Events are read oldest first so that a consequence joins the change that caused it.
 */
export function timelineRows(events: ProjectEvent[]): TimelineEntry[] {
  const rows: TimelineEntry[] = [];
  let latest = '';
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const label = eventLabel(e);
    if (!label) continue;
    const last = rows[rows.length - 1];
    const id = text(data(e).artifactId);
    if (last && last.event.origin === e.origin) {
      const lastId = text(data(last.event).artifactId);
      if (
        id &&
        id === lastId &&
        apart(latest, e.ts) < SAME_CHANGE_MS &&
        !last.labels.some((l) => sameKind(l, label))
      ) {
        last.labels.push(label);
        // A draft that became the baseline in the same moment is a revision.
        if (label === 'Baseline updated')
          last.labels = last.labels.map((l) => (l === 'Drafted' ? 'Revised' : l));
        latest = e.ts;
        continue;
      }
      if (
        !id &&
        !lastId &&
        last.event.type === e.type &&
        e.type === 'bom.changed' &&
        apart(latest, e.ts) < SAME_BURST_MS
      ) {
        last.count++;
        latest = e.ts;
        continue;
      }
    }
    rows.push({ kind: 'event', key: e.id, event: e, labels: [label], count: 1 });
    latest = e.ts;
  }
  return rows.reverse();
}

const itemTime = (item: TimelineItem) =>
  new Date(item.kind === 'event' ? item.event.ts : item.calls[0]!.at).getTime();

/**
 * Places recorded agent calls between the record rows by time. Consecutive calls with no record
 * row between them form one run. Calls older than `since` are left out until the record reaches
 * back that far; `since` null means the record is complete.
 */
export function interleaveCalls(
  rows: TimelineEntry[],
  calls: AgentCallRecord[],
  since: string | null,
): TimelineItem[] {
  const floor = since === null ? -Infinity : new Date(since).getTime();
  const sorted = calls
    .filter((c) => new Date(c.at).getTime() >= floor)
    .sort((a, b) => b.seq - a.seq);
  const out: TimelineItem[] = [];
  let i = 0;
  const pushCall = (c: AgentCallRecord) => {
    const last = out[out.length - 1];
    if (last?.kind === 'calls') last.calls.push(c);
    else out.push({ kind: 'calls', key: `calls-${c.seq}`, calls: [c] });
  };
  for (const row of rows) {
    const t = itemTime(row);
    while (i < sorted.length && new Date(sorted[i]!.at).getTime() > t) pushCall(sorted[i++]!);
    out.push(row);
  }
  while (i < sorted.length) pushCall(sorted[i++]!);
  return out;
}

export interface TimelineDay {
  key: string;
  label: string;
  items: TimelineItem[];
}

/** "Tuesday, October 13", with the year when it is not the current one. */
export function dayLabel(when: Date | string, now = new Date()): string {
  const d = new Date(when);
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

export function groupByDay(items: TimelineItem[], now = new Date()): TimelineDay[] {
  const days: TimelineDay[] = [];
  for (const item of items) {
    const d = new Date(itemTime(item));
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const last = days[days.length - 1];
    if (last?.key === key) last.items.push(item);
    else days.push({ key, label: dayLabel(d, now), items: [item] });
  }
  return days;
}
