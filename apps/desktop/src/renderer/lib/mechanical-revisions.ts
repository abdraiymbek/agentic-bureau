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
