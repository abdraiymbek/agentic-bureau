import type { ArtifactView, Edge, Relationship } from '@bureau/contracts';

/** Relationships that carry engineering consequence from upstream to downstream. */
const CAUSAL: Relationship[] = ['depends_on', 'derived_from', 'validates'];

export const isCausal = (relationship: Relationship) => CAUSAL.includes(relationship);

/** Names one directed link, upstream first. */
export const linkKey = (upstreamId: string, downstreamId: string) =>
  `${upstreamId}>${downstreamId}`;

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

/**
 * The links a recorded change travelled along: each consecutive pair of every stale path, keyed
 * by `linkKey`, with how many steps it is from the changed input (0 = leaves the changed object).
 * Two objects that are merely both out of date do not make the link between them a stale path.
 */
export function stalePathSteps(stale: Record<string, { path: string[] }[]>): Map<string, number> {
  const steps = new Map<string, number>();
  for (const records of Object.values(stale)) {
    for (const { path } of records) {
      for (let i = 0; i + 1 < path.length; i++) {
        const key = linkKey(path[i]!, path[i + 1]!);
        steps.set(key, Math.min(steps.get(key) ?? i, i));
      }
    }
  }
  return steps;
}

export interface Adjacency {
  up: Map<string, string[]>;
  down: Map<string, string[]>;
}

/** Upstream and downstream neighbours per object, over the links that carry consequence. */
export function causalAdjacency(
  links: Iterable<{ from: string; to: string; causal: boolean }>,
): Adjacency {
  const up = new Map<string, string[]>();
  const down = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, value: string) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  for (const link of links) {
    if (!link.causal) continue;
    add(up, link.to, link.from);
    add(down, link.from, link.to);
  }
  return { up, down };
}

/** The full causal thread through one object: everything it rests on and everything it reaches. */
export function threadOf(id: string, adjacency: Adjacency): Set<string> {
  const thread = new Set([id]);
  for (const neighbours of [adjacency.up, adjacency.down]) {
    const queue = [id];
    for (let i = 0; i < queue.length; i++) {
      for (const next of neighbours.get(queue[i]!) ?? []) {
        if (thread.has(next)) continue;
        thread.add(next);
        queue.push(next);
      }
    }
  }
  return thread;
}
