import type { MechanicalPayload, Revision } from '@omenflow/contracts';

function revisionById(revisions: Revision[]): Map<string, Revision> {
  return new Map(revisions.map((revision) => [revision.id, revision]));
}

/** Current-work drafts sit on the accepted baseline; leftover older proposals do not. */
export function belongsToCurrentMechanicalWork(
  revision: Revision,
  baseline: Revision | null,
  revisions: Revision[],
): boolean {
  if (!['draft', 'proposed'].includes(revision.reviewState)) return false;
  if (!baseline) return true;
  if (revision.id === baseline.id || revision.seq <= baseline.seq) return false;
  const byId = revisionById(revisions);
  const seen = new Set<string>();
  let current: Revision | undefined = revision;
  while (current && !seen.has(current.id)) {
    if (current.parentId === baseline.id) return true;
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  // Monotonic seq still treats later work as current when parent links are absent.
  return revision.seq > baseline.seq && !revision.parentId;
}

export function mechanicalCandidates(revisions: Revision[], baselineId: string | null): Revision[] {
  const baseline = baselineId ? (revisions.find((r) => r.id === baselineId) ?? null) : null;
  return revisions
    .filter((revision) => revision.id !== baselineId)
    .filter((revision) => belongsToCurrentMechanicalWork(revision, baseline, revisions))
    .sort((a, b) => b.seq - a.seq);
}

export function displayedMechanicalRevision(
  revisions: Revision[],
  baselineId: string | null,
  selectedId: string | null,
): Revision | null {
  if (selectedId) return revisions.find((r) => r.id === selectedId) ?? null;
  return (
    mechanicalCandidates(revisions, baselineId)[0] ??
    revisions.find((r) => r.id === baselineId) ??
    null
  );
}

/**
 * What the person asked to see. "Latest work" and "Baseline" follow the record as it moves;
 * a named revision stays put until the pick is changed.
 */
export type RevisionPick =
  { kind: 'latest' } | { kind: 'baseline' } | { kind: 'revision'; id: string };

export const LATEST_WORK: RevisionPick = { kind: 'latest' };

/** How a revision stands relative to the baseline pointer. */
export type RevisionRole = 'baseline' | 'candidate' | 'history';

export function revisionRole(
  revision: Revision,
  revisions: Revision[],
  baselineId: string | null,
): RevisionRole {
  if (revision.id === baselineId) return 'baseline';
  return mechanicalCandidates(revisions, baselineId).some((r) => r.id === revision.id)
    ? 'candidate'
    : 'history';
}

export interface DisplayedRevision {
  revision: Revision | null;
  role: RevisionRole | null;
  /**
   * The loaded history does not contain the revision the rules point at yet: the baseline
   * pointer or the pick is newer than the list. Callers keep what they showed and wait.
   */
  pending: boolean;
}

/**
 * The one resolution rule for every stage.
 *
 * - Latest work: the newest draft or proposed revision descended from the current baseline,
 *   else the baseline. Rejected, superseded and orphaned work is never chosen automatically.
 * - Baseline: whatever the baseline pointer names now.
 * - A named revision: exactly that revision.
 */
export function resolveDisplayedRevision(
  revisions: Revision[],
  baselineId: string | null,
  pick: RevisionPick,
): DisplayedRevision {
  const baseline = baselineId ? (revisions.find((r) => r.id === baselineId) ?? null) : null;
  if (baselineId && !baseline) return { revision: null, role: null, pending: true };
  if (pick.kind === 'revision') {
    const revision = revisions.find((r) => r.id === pick.id);
    return revision
      ? { revision, role: revisionRole(revision, revisions, baselineId), pending: false }
      : { revision: null, role: null, pending: true };
  }
  const candidate = pick.kind === 'latest' ? mechanicalCandidates(revisions, baselineId)[0] : null;
  if (candidate) return { revision: candidate, role: 'candidate', pending: false };
  return { revision: baseline, role: baseline ? 'baseline' : null, pending: false };
}

/**
 * The revision a new CAD candidate must be built on: the newest one that was neither rejected
 * nor superseded. The core refuses source and parameter writes based on anything else.
 */
export function newestActiveRevision(revisions: Revision[]): Revision | null {
  return (
    revisions
      .filter((r) => r.reviewState !== 'rejected' && r.reviewState !== 'superseded')
      .sort((a, b) => b.seq - a.seq)[0] ?? null
  );
}

/** Drafts on the current baseline other than the one on screen. */
export function otherDraftCount(
  revisions: Revision[],
  baselineId: string | null,
  displayedId: string | null,
): number {
  return mechanicalCandidates(revisions, baselineId).filter(
    (r) => r.reviewState === 'draft' && r.id !== displayedId,
  ).length;
}

/** Numbers alone carry no dimension: never infer length from the model unit. */
export function mechanicalParameterUnit(
  name: string,
  value: unknown,
  manifest: MechanicalPayload['paramManifest'],
): string {
  if (value && typeof value === 'object' && 'unit' in value) return String(value.unit);
  const declared = manifest.find((p) => p.name === name);
  if (declared?.unit) return declared.unit;
  if (declared?.dimension === 'count') return 'count';
  if (declared?.dimension === 'angle') return 'angle · unit unspecified';
  if (declared?.dimension === 'number') return 'unit unspecified';
  return typeof value === 'number' ? 'unit unspecified' : '—';
}
