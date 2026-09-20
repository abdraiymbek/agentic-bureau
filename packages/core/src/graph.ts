import {
  EVAL_RELATIONSHIPS,
  Edge,
  ErrorCodes,
  ImpactReport,
  MAX_IMPACT_DEPTH,
  Relationship,
  RevisionRef,
  OmenflowError,
  StaleRecord,
  newId,
} from '@omenflow/contracts';
import type { ProjectContext } from './context.js';

/**
 * Dependency graph semantics.
 *
 * - Evaluation edges (depends_on / derived_from / validates) propagate
 *   freshness and must be acyclic.
 * - connects_to may cycle (physical feedback); belongs_to / alternative_to
 *   are organizational/informative.
 */

export function downstreamNeighbors(ctx: ProjectContext, artifactId: string): Edge[] {
  return ctx.repo.edgesFrom(artifactId).filter((e) => EVAL_RELATIONSHIPS.includes(e.relationship));
}
export function upstreamNeighbors(ctx: ProjectContext, artifactId: string): Edge[] {
  return ctx.repo.edgesTo(artifactId).filter((e) => EVAL_RELATIONSHIPS.includes(e.relationship));
}

/** Would adding edge upstream→downstream create an evaluation cycle? */
export function findCycle(
  ctx: ProjectContext,
  upstreamId: string,
  downstreamId: string,
): string[] | null {
  // Search downstream's reachable set for upstream.
  const visited = new Set<string>();
  const parent = new Map<string, string>();
  const queue = [downstreamId];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === upstreamId) {
      const path = [upstreamId];
      let c = cur;
      while (parent.has(c)) {
        c = parent.get(c)!;
        path.unshift(c);
      }
      return path;
    }
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const e of downstreamNeighbors(ctx, cur)) {
      if (!visited.has(e.downstreamArtifactId)) {
        parent.set(e.downstreamArtifactId, cur);
        queue.push(e.downstreamArtifactId);
      }
    }
  }
  return null;
}

export function addEdge(
  ctx: ProjectContext,
  upstreamArtifactId: string,
  downstreamArtifactId: string,
  relationship: Relationship,
  label: string,
  createdBy: 'user' | 'agent' | 'system',
): Edge {
  ctx.requireArtifact(upstreamArtifactId);
  ctx.requireArtifact(downstreamArtifactId);
  if (upstreamArtifactId === downstreamArtifactId) {
    throw new OmenflowError(ErrorCodes.VALIDATION, 'Self-edge not allowed');
  }
  if (EVAL_RELATIONSHIPS.includes(relationship)) {
    const cycle = findCycle(ctx, upstreamArtifactId, downstreamArtifactId);
    if (cycle) {
      throw new OmenflowError(
        ErrorCodes.CYCLE_DETECTED,
        `Adding ${relationship} edge would create a cycle`,
        { details: { path: cycle } },
      );
    }
  }
  const edge: Edge = {
    id: newId(),
    upstreamArtifactId,
    downstreamArtifactId,
    relationship,
    requiredUpstreamRevisionId: null,
    label,
    createdBy,
    createdAt: new Date().toISOString(),
  };
  ctx.repo.insertEdge(edge);
  return edge;
}

/* ------------------------------------------------------------------ */
/* Freshness evaluation                                                 */
/*                                                                     */
/* An artifact is stale when a recorded input revision no longer equals */
/* the upstream artifact's selected revision (input_changed), or when   */
/* a required input is missing (archived / no baseline).                */
/* ------------------------------------------------------------------ */

export interface StaleFinding {
  artifactId: string;
  upstreamArtifactId: string;
  expectedRevisionId: string | null;
  actualRevisionId: string | null;
  path: string[];
  reason: 'input_changed' | 'missing_input';
}

/** Evaluate one artifact's recorded inputs against current selections. */
export function evaluateInputs(ctx: ProjectContext, artifactId: string): StaleFinding[] {
  const artifact = ctx.repo.getArtifact(artifactId);
  if (!artifact || !artifact.selectedRevisionId) return [];
  const rev = ctx.repo.getRevision(artifact.selectedRevisionId);
  if (!rev) return [];
  const findings: StaleFinding[] = [];
  const seenUpstream = new Set<string>();
  for (const input of rev.inputs) {
    // Several named inputs may reference the same upstream artifact (e.g.
    // voltage and capacity from one battery revision) — the stale table keys
    // on (artifact, upstream), so keep the first finding per upstream.
    if (seenUpstream.has(input.artifactId)) continue;
    seenUpstream.add(input.artifactId);
    const up = ctx.repo.getArtifact(input.artifactId);
    const actual = up?.selectedRevisionId ?? null;
    if (!up || up.archived || !actual) {
      findings.push({
        artifactId,
        upstreamArtifactId: input.artifactId,
        expectedRevisionId: input.revisionId,
        actualRevisionId: actual,
        path: [input.artifactId, artifactId],
        reason: 'missing_input',
      });
    } else if (actual !== input.revisionId) {
      findings.push({
        artifactId,
        upstreamArtifactId: input.artifactId,
        expectedRevisionId: input.revisionId,
        actualRevisionId: actual,
        path: [input.artifactId, artifactId],
        reason: 'input_changed',
      });
    }
  }
  return findings;
}

/**
 * Propagate a baseline change: BFS downstream through evaluation edges from
 * each changed artifact; mark mismatched dependents stale with an explanation
 * path; refresh artifacts whose recorded inputs now match again.
 * Returns the full affected set. Caller emits the project event.
 */
export function propagateFrom(
  ctx: ProjectContext,
  changedArtifactIds: string[],
  eventSeq: number,
): { artifactId: string; reason: string; path: string[] }[] {
  const affected = new Map<string, { reason: string; path: string[] }>();
  const visited = new Set<string>();

  interface Frame {
    id: string;
    path: string[];
    depth: number;
  }
  const queue: Frame[] = changedArtifactIds.map((id) => ({ id, path: [id], depth: 0 }));

  while (queue.length) {
    const { id, path, depth } = queue.shift()!;
    if (depth > MAX_IMPACT_DEPTH) break;
    if (visited.has(id)) continue;
    visited.add(id);

    for (const edge of ctx.repo.edgesFrom(id)) {
      const down = edge.downstreamArtifactId;
      const epath = [...path, down];
      if (EVAL_RELATIONSHIPS.includes(edge.relationship)) {
        // Re-evaluate the dependent's inputs now that `id` moved.
        const findings = evaluateInputs(ctx, down);
        if (findings.length > 0) {
          ctx.repo.replaceStale(down, staleToRecord(findings, eventSeq));
          affected.set(down, {
            reason: findings[0]!.reason === 'missing_input' ? 'missing input' : 'input changed',
            path: epath,
          });
          queue.push({ id: down, path: epath, depth: depth + 1 });
        } else {
          // Its inputs now match — it may have recovered.
          const hadStale = ctx.repo.staleFor(down).length > 0;
          ctx.repo.clearStale(down);
          if (hadStale) affected.set(down, { reason: 'inputs restored', path: epath });
          // Continue traversal: dependents may still be stale vs this revision.
          queue.push({ id: down, path: epath, depth: depth + 1 });
        }
      } else if (edge.relationship === 'connects_to') {
        // Informative: continue traversal for reporting but don't mark stale.
        if (!visited.has(down)) queue.push({ id: down, path: epath, depth: depth + 1 });
      }
    }
    // Recorded inputs can exist without explicit edges — dependents whose
    // revisions reference `id` are found via reverse input scan.
    for (const dep of dependentsViaInputs(ctx, id)) {
      if (visited.has(dep)) continue;
      const epath = [...path, dep];
      const findings = evaluateInputs(ctx, dep);
      if (findings.length > 0) {
        ctx.repo.replaceStale(dep, staleToRecord(findings, eventSeq));
        affected.set(dep, {
          reason: findings[0]!.reason === 'missing_input' ? 'missing input' : 'input changed',
          path: epath,
        });
        queue.push({ id: dep, path: epath, depth: depth + 1 });
      }
    }
  }
  return [...affected.entries()].map(([artifactId, v]) => ({ artifactId, ...v }));
}

/** Artifacts whose selected revision records an input on `artifactId`. */
function dependentsViaInputs(ctx: ProjectContext, artifactId: string): string[] {
  const out: string[] = [];
  for (const a of ctx.repo.listArtifacts()) {
    if (!a.selectedRevisionId) continue;
    const rev = ctx.repo.getRevision(a.selectedRevisionId);
    if (rev?.inputs.some((i) => i.artifactId === artifactId)) out.push(a.id);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Queries                                                              */
/* ------------------------------------------------------------------ */

export function neighbors(
  ctx: ProjectContext,
  artifactId: string,
  direction: 'upstream' | 'downstream' | 'both',
  depth: number,
  relationship?: Relationship,
) {
  const seen = new Map<string, { depth: number; via: string }>();
  const edges: Edge[] = [];
  const queue: { id: string; depth: number }[] = [{ id: artifactId, depth: 0 }];
  seen.set(artifactId, { depth: 0, via: '' });
  while (queue.length) {
    const { id, depth: d } = queue.shift()!;
    if (d >= depth) continue;
    const rel = (e: Edge[]) =>
      relationship ? e.filter((x) => x.relationship === relationship) : e;
    const out = direction !== 'upstream' ? rel(ctx.repo.edgesFrom(id)) : [];
    const inc = direction !== 'downstream' ? rel(ctx.repo.edgesTo(id)) : [];
    for (const e of [...out, ...inc]) {
      edges.push(e);
      const next = e.upstreamArtifactId === id ? e.downstreamArtifactId : e.upstreamArtifactId;
      if (!seen.has(next)) {
        seen.set(next, { depth: d + 1, via: e.id });
        queue.push({ id: next, depth: d + 1 });
      }
    }
  }
  const artifacts = [...seen.keys()]
    .map((id) => ctx.repo.getArtifact(id))
    .filter((a): a is NonNullable<typeof a> => !!a)
    .map((a) => ({
      id: a.id,
      title: a.title,
      type: a.type,
      depth: seen.get(a.id)!.depth,
      freshness: ctx.freshnessOf(a.id).freshness,
    }));
  return { artifacts, edges };
}

/** Read-only impact report for a hypothetical change to the given refs. */
export function impactReport(ctx: ProjectContext, refs: RevisionRef[]): ImpactReport {
  const startIds = [...new Set(refs.map((r) => r.artifactId))];
  const affected = new Map<string, { reason: string; path: string[] }>();
  const visited = new Set<string>();
  const queue = startIds.map((id) => ({ id, path: [id], depth: 0 }));
  while (queue.length) {
    const { id, path, depth } = queue.shift()!;
    if (depth > MAX_IMPACT_DEPTH) break;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const e of ctx.repo.edgesFrom(id)) {
      const next = e.downstreamArtifactId;
      if (!visited.has(next)) {
        if (EVAL_RELATIONSHIPS.includes(e.relationship)) {
          // Would this edge see a revision change? If pinned, compare.
          const pinMiss =
            e.requiredUpstreamRevisionId &&
            e.requiredUpstreamRevisionId !== ctx.repo.getArtifact(id)?.selectedRevisionId;
          affected.set(next, {
            reason: pinMiss ? 'pinned input revision changed' : 'upstream input changed',
            path: [...path, next],
          });
        }
        queue.push({ id: next, path: [...path, next], depth: depth + 1 });
      }
    }
    for (const dep of dependentsViaInputs(ctx, id)) {
      if (!visited.has(dep)) {
        affected.set(dep, { reason: 'recorded input revision changed', path: [...path, dep] });
        queue.push({ id: dep, path: [...path, dep], depth: depth + 1 });
      }
    }
  }
  const details = [...affected.entries()].map(([artifactId, v]) => {
    const a = ctx.repo.getArtifact(artifactId);
    return {
      artifactId,
      title: a?.title ?? artifactId,
      type: a?.type ?? ('note' as const),
      reason: v.reason,
      path: v.path,
    };
  });
  return { changedRefs: refs, affected: details, unaffectedSelectedComponentIds: [] };
}

export function staleToRecord(f: StaleFinding[], sinceEventSeq: number): StaleRecord[] {
  return f.map((x) => ({ ...x, sinceEventSeq }));
}
