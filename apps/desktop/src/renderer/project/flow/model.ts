import type { ArtifactView, Edge } from '@omenflow/contracts';
import { isCausal, linkKey } from '../../lib/graph';

export interface FlowNode {
  id: string;
  type: string;
  title: string;
}

/** One drawn link. Recorded edges between the same two objects in the same direction are one link. */
export interface FlowLink {
  key: string;
  from: string;
  to: string;
  /** At least one of the recorded relationships carries consequence downstream. */
  causal: boolean;
}

/**
 * The shape of the project as the map draws it. `key` changes exactly when the shape does, so
 * layout can be remembered across refreshes that only bring new state.
 */
export interface FlowGraph {
  nodes: FlowNode[];
  links: FlowLink[];
  key: string;
}

/** Objects and links in a canonical order, independent of the order the lists arrived in. */
export function buildGraph(artifacts: ArtifactView[], edges: Edge[]): FlowGraph {
  const nodes = artifacts
    .map(({ artifact }) => ({ id: artifact.id, type: artifact.type, title: artifact.title }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const known = new Set(nodes.map((n) => n.id));
  const byKey = new Map<string, FlowLink>();
  for (const e of edges) {
    const from = e.upstreamArtifactId;
    const to = e.downstreamArtifactId;
    if (from === to || !known.has(from) || !known.has(to)) continue;
    const key = linkKey(from, to);
    const causal = isCausal(e.relationship);
    const existing = byKey.get(key);
    if (existing) existing.causal ||= causal;
    else byKey.set(key, { key, from, to, causal });
  }
  const links = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const key = JSON.stringify([
    nodes.map((n) => [n.id, n.type, n.title]),
    links.map((l) => [l.key, l.causal]),
  ]);
  return { nodes, links, key };
}
