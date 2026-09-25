import type { ArtifactView, Edge, Relationship } from '@omenflow/contracts';

/** Relationships that carry engineering consequence from upstream to downstream. */
const CAUSAL: Relationship[] = ['depends_on', 'derived_from', 'validates'];

export interface Link {
  id: string;
  relationship: Relationship | 'recorded_input';
  label?: string;
  /** A recorded input pins a revision; the edge only names the dependency. */
  pinnedRevisionId?: string;
}

export interface Lineage {
  upstream: Link[];
  downstream: Link[];
  related: Link[];
}

/**
 * The causal neighbourhood of one object: what it consumes (left), what consumes it
 * (right), and non-causal relations such as connections and alternatives.
 */
export function lineageOf(id: string, edges: Edge[], view?: ArtifactView): Lineage {
  const upstream = new Map<string, Link>();
  const downstream = new Map<string, Link>();
  const related = new Map<string, Link>();
  for (const e of edges) {
    const causal = CAUSAL.includes(e.relationship);
    if (e.downstreamArtifactId === id) {
      (causal ? upstream : related).set(e.upstreamArtifactId, {
        id: e.upstreamArtifactId,
        relationship: e.relationship,
        label: e.label || undefined,
      });
    } else if (e.upstreamArtifactId === id) {
      (causal ? downstream : related).set(e.downstreamArtifactId, {
        id: e.downstreamArtifactId,
        relationship: e.relationship,
        label: e.label || undefined,
      });
    }
  }
  for (const input of view?.revision?.inputs ?? []) {
    const existing = upstream.get(input.artifactId);
    upstream.set(input.artifactId, {
      id: input.artifactId,
      relationship: existing?.relationship ?? input.relationship ?? 'recorded_input',
      label: input.label ?? existing?.label,
      pinnedRevisionId: input.revisionId,
    });
    related.delete(input.artifactId);
  }
  for (const k of upstream.keys()) related.delete(k);
  for (const k of downstream.keys()) related.delete(k);
  return {
    upstream: [...upstream.values()],
    downstream: [...downstream.values()],
    related: [...related.values()],
  };
}

export function relationshipLabel(r: Link['relationship']): string {
  switch (r) {
    case 'depends_on':
      return 'depends on';
    case 'derived_from':
      return 'derived from';
    case 'validates':
      return 'validates';
    case 'connects_to':
      return 'connects to';
    case 'belongs_to':
      return 'belongs to';
    case 'alternative_to':
      return 'alternative to';
    default:
      return 'recorded input';
  }
}

/** Ids on any recorded stale path: the part of the project a change is travelling through. */
export function impactIds(stale: Record<string, { path: string[] }[]>): Set<string> {
  return new Set(Object.values(stale).flatMap((reasons) => reasons.flatMap((r) => r.path)));
}
