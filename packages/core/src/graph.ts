import { createHash } from 'node:crypto';
import {
  Artifact,
  EVAL_RELATIONSHIPS,
  Edge,
  ErrorCodes,
  ImpactReport,
  Relationship,
  RecordedInput,
  Revision,
  RevisionRef,
  BureauError,
  StaleRecord,
  newId,
} from '@bureau/contracts';
import type { ProjectContext } from './context.js';

/**
 * Baseline dependency views come from selected immutable revision inputs.
 * Persisted pinned edges are only a compatibility projection: older releases
 * changed those rows while drafting, so they must never be authoritative.
 * Unpinned explicit graph relationships remain supported for navigation.
 */
interface GraphSnapshot {
  artifacts: Map<string, Artifact>;
  selected: Map<string, { revisionId: string; inputs: RecordedInput[] }>;
  outgoing: Map<string, Edge[]>;
  incoming: Map<string, Edge[]>;
}

function inputEdge(
  artifact: Artifact,
  revisionId: string,
  input: RecordedInput,
  index: number,
): Edge {
  const h = createHash('sha256').update(`${revisionId}:${index}`).digest('hex');
  return {
    id: `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`,
    upstreamArtifactId: input.artifactId,
    downstreamArtifactId: artifact.id,
    relationship: input.relationship,
    requiredUpstreamRevisionId: input.revisionId,
    label: input.label ?? '',
    createdBy: 'system',
    createdAt: artifact.createdAt,
  };
}

function snapshot(
  ctx: ProjectContext,
  overrides: Map<string, { revisionId: string; inputs: RecordedInput[] }> = new Map(),
): GraphSnapshot {
  const artifacts = new Map(
    ctx.repo.listArtifacts({ includeArchived: true }).map((a) => [a.id, a]),
  );
  const selected = new Map(ctx.repo.selectedRevisionInputs().map((r) => [r.artifactId, r]));
  for (const [id, r] of overrides) selected.set(id, { artifactId: id, ...r });
  const outgoing = new Map<string, Edge[]>();
  const incoming = new Map<string, Edge[]>();
  const add = (edge: Edge) => {
    const out = outgoing.get(edge.upstreamArtifactId) ?? [];
    out.push(edge);
    outgoing.set(edge.upstreamArtifactId, out);
    const inc = incoming.get(edge.downstreamArtifactId) ?? [];
    inc.push(edge);
    incoming.set(edge.downstreamArtifactId, inc);
  };
  for (const [id, revision] of selected) {
    const artifact = artifacts.get(id);
    if (artifact)
      revision.inputs.forEach((input, i) =>
        add(inputEdge(artifact, revision.revisionId, input, i)),
      );
  }
  for (const edge of ctx.repo.allEdges()) {
    if (edge.requiredUpstreamRevisionId === null) add(edge);
  }
  return { artifacts, selected, outgoing, incoming };
}

const evaluating = (edges: Edge[] = []) =>
  edges.filter((e) => EVAL_RELATIONSHIPS.includes(e.relationship));

export function downstreamNeighbors(ctx: ProjectContext, artifactId: string): Edge[] {
  return evaluating(snapshot(ctx).outgoing.get(artifactId));
}
export function upstreamNeighbors(ctx: ProjectContext, artifactId: string): Edge[] {
  return evaluating(snapshot(ctx).incoming.get(artifactId));
}

/** Public baseline graph view, including compatibility-only explicit relationships. */
export function listEdges(ctx: ProjectContext): Edge[] {
  return [...snapshot(ctx).outgoing.values()].flat();
}

function reachablePath(graph: GraphSnapshot, start: string, target: string): string[] | null {
  const parent = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    if (id === target) {
      const path: string[] = [];
      let cur: string | null = id;
      while (cur !== null) {
        path.push(cur);
        cur = parent.get(cur) ?? null;
      }
      return path.reverse();
    }
    for (const edge of evaluating(graph.outgoing.get(id))) {
      if (!parent.has(edge.downstreamArtifactId)) {
        parent.set(edge.downstreamArtifactId, id);
        queue.push(edge.downstreamArtifactId);
      }
    }
  }
  return null;
}

/** Would adding upstream→downstream create an evaluation cycle? */
export function findCycle(
  ctx: ProjectContext,
  upstreamId: string,
  downstreamId: string,
): string[] | null {
  return reachablePath(snapshot(ctx), downstreamId, upstreamId);
}

function requireValidReferences(
  ctx: ProjectContext,
  artifactId: string,
  inputs: RecordedInput[],
): void {
  ctx.requireArtifact(artifactId);
  for (const input of inputs) {
    ctx.requireArtifact(input.artifactId);
    const revision = ctx.requireRevision(input.revisionId);
    if (revision.artifactId !== input.artifactId) {
      throw new BureauError(
        ErrorCodes.VALIDATION,
        'Input revision does not belong to its artifact',
        {
          details: { artifactId, inputArtifactId: input.artifactId, revisionId: input.revisionId },
        },
      );
    }
    if (input.artifactId === artifactId && EVAL_RELATIONSHIPS.includes(input.relationship)) {
      throw new BureauError(ErrorCodes.CYCLE_DETECTED, 'An artifact cannot depend on itself', {
        details: { path: [artifactId, artifactId] },
      });
    }
  }
}

function assertNoCycles(graph: GraphSnapshot): void {
  // Iterative DFS: long dependency chains must not depend on the JS call stack.
  const state = new Map<string, 'visiting' | 'done'>();
  for (const start of graph.artifacts.keys()) {
    if (state.has(start)) continue;
    const stack: { id: string; next: number; edges: Edge[] }[] = [
      { id: start, next: 0, edges: evaluating(graph.outgoing.get(start)) },
    ];
    state.set(start, 'visiting');
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const edge = frame.edges[frame.next++];
      if (!edge) {
        state.set(frame.id, 'done');
        stack.pop();
        continue;
      }
      const id = edge.downstreamArtifactId;
      if (state.get(id) === 'visiting') {
        const first = stack.findIndex((f) => f.id === id);
        throw new BureauError(
          ErrorCodes.CYCLE_DETECTED,
          'Revision inputs would create a dependency cycle',
          {
            details: { path: [...stack.slice(first).map((f) => f.id), id] },
          },
        );
      }
      if (!state.has(id)) {
        state.set(id, 'visiting');
        stack.push({ id, next: 0, edges: evaluating(graph.outgoing.get(id)) });
      }
    }
  }
}

/** Validate every revision-writing route before any revision/edge mutation. */
export function validateRevisionInputs(
  ctx: ProjectContext,
  artifactId: string,
  inputs: RecordedInput[],
): void {
  requireValidReferences(ctx, artifactId, inputs);
  const overrides = new Map([[artifactId, { revisionId: '', inputs }]]);
  // Unselected input artifacts still have a candidate dependency graph. Include
  // their exact pinned revisions; never replace an existing baseline with drafts.
  const queue = [...inputs];
  const visited = new Set<string>([artifactId]);
  for (let i = 0; i < queue.length; i++) {
    const input = queue[i]!;
    if (visited.has(input.artifactId)) continue;
    visited.add(input.artifactId);
    const artifact = ctx.requireArtifact(input.artifactId);
    if (artifact.selectedRevisionId) continue;
    const revision = ctx.requireRevision(input.revisionId);
    requireValidReferences(ctx, artifact.id, revision.inputs);
    overrides.set(artifact.id, { revisionId: revision.id, inputs: revision.inputs });
    queue.push(...revision.inputs);
  }
  assertNoCycles(snapshot(ctx, overrides));
}

/** Revalidate the entire proposed selection together at the approval boundary. */
export function validateSelectedRevisions(ctx: ProjectContext, revisions: Revision[]): void {
  const overrides = new Map<string, { revisionId: string; inputs: RecordedInput[] }>();
  for (const revision of revisions) {
    requireValidReferences(ctx, revision.artifactId, revision.inputs);
    overrides.set(revision.artifactId, { revisionId: revision.id, inputs: revision.inputs });
  }
  assertNoCycles(snapshot(ctx, overrides));
}

/** Rebuild the compatibility projection only after selecting a baseline. */
export function syncSelectedInputs(ctx: ProjectContext, artifactId: string): void {
  const artifact = ctx.requireArtifact(artifactId);
  for (const edge of ctx.repo.edgesTo(artifactId)) {
    if (edge.requiredUpstreamRevisionId !== null) ctx.repo.deleteEdge(edge.id);
  }
  if (!artifact.selectedRevisionId) return;
  const revision = ctx.requireRevision(artifact.selectedRevisionId);
  revision.inputs.forEach((input, i) =>
    ctx.repo.insertEdge(inputEdge(artifact, revision.id, input, i)),
  );
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
    throw new BureauError(ErrorCodes.VALIDATION, 'Self-edge not allowed');
  }
  if (EVAL_RELATIONSHIPS.includes(relationship)) {
    const cycle = findCycle(ctx, upstreamArtifactId, downstreamArtifactId);
    if (cycle) {
      throw new BureauError(
        ErrorCodes.CYCLE_DETECTED,
        `Adding ${relationship} edge would create a cycle`,
        {
          details: { path: [...cycle, downstreamArtifactId] },
        },
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

export interface StaleFinding {
  artifactId: string;
  upstreamArtifactId: string;
  expectedRevisionId: string | null;
  actualRevisionId: string | null;
  path: string[];
  reason: 'input_changed' | 'missing_input';
}

/** Compute freshness once in upstream-first order, independent of persisted stale rows. */
function evaluateSnapshot(graph: GraphSnapshot): Map<string, StaleFinding[]> {
  assertNoCycles(graph);
  const findings = new Map<string, StaleFinding[]>();
  const remaining = new Map<string, number>();
  const queue: string[] = [];
  for (const id of graph.artifacts.keys()) {
    // Missing upstream nodes are findings, not blockers for topological traversal.
    const degree = evaluating(graph.incoming.get(id)).filter((e) =>
      graph.artifacts.has(e.upstreamArtifactId),
    ).length;
    remaining.set(id, degree);
    if (!degree) queue.push(id);
  }
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    const artifact = graph.artifacts.get(id)!;
    const records = new Map<string, StaleFinding>();
    const revision = graph.selected.get(id);
    if (artifact.selectedRevisionId && !revision) {
      records.set(id, {
        artifactId: id,
        upstreamArtifactId: id,
        expectedRevisionId: artifact.selectedRevisionId,
        actualRevisionId: null,
        path: [id],
        reason: 'missing_input',
      });
    }
    for (const input of revision?.inputs ?? []) {
      if (!EVAL_RELATIONSHIPS.includes(input.relationship)) continue;
      const upstream = graph.artifacts.get(input.artifactId);
      const actual = upstream?.selectedRevisionId ?? null;
      const missing =
        !upstream || upstream.archived || !actual || !graph.selected.has(input.artifactId);
      if (missing || actual !== input.revisionId) {
        const finding: StaleFinding = {
          artifactId: id,
          upstreamArtifactId: input.artifactId,
          expectedRevisionId: input.revisionId,
          actualRevisionId: actual,
          path: [input.artifactId, id],
          reason: missing ? 'missing_input' : 'input_changed',
        };
        // An artifact can consume multiple historical revisions of one upstream;
        // no matching first input may hide a later obsolete input.
        if (!records.has(input.artifactId) || missing) records.set(input.artifactId, finding);
      }
      for (const cause of findings.get(input.artifactId) ?? []) {
        if (!records.has(cause.upstreamArtifactId)) {
          records.set(cause.upstreamArtifactId, {
            ...cause,
            artifactId: id,
            path: [...cause.path, id],
          });
        }
      }
    }
    findings.set(id, [...records.values()]);
    for (const edge of evaluating(graph.outgoing.get(id))) {
      const next = edge.downstreamArtifactId;
      const degree = (remaining.get(next) ?? 0) - 1;
      remaining.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }
  return findings;
}

export function evaluateInputs(ctx: ProjectContext, artifactId: string): StaleFinding[] {
  return evaluateSnapshot(snapshot(ctx)).get(artifactId) ?? [];
}

/** Only compress displayed explanations, never traversal or persisted stale evidence. */
function diagnosticPath(path: string[]): {
  path: string[];
  pathTruncated?: boolean;
  fullPathLength?: number;
} {
  if (path.length <= 32) return { path };
  return {
    path: [...path.slice(0, 16), ...path.slice(-16)],
    pathTruncated: true,
    fullPathLength: path.length,
  };
}

/** Recompute changed selections and every downstream baseline, including restored inputs. */
export function propagateFrom(
  ctx: ProjectContext,
  changedArtifactIds: string[],
  eventSeq: number,
): {
  artifactId: string;
  reason: string;
  path: string[];
  pathTruncated?: boolean;
  fullPathLength?: number;
}[] {
  const graph = snapshot(ctx);
  const findings = evaluateSnapshot(graph);
  const affected: ReturnType<typeof propagateFrom> = [];
  const visited = new Set<string>(changedArtifactIds);
  const queue = changedArtifactIds.map((id) => ({ id, path: [id] }));
  for (let i = 0; i < queue.length; i++) {
    const { id, path } = queue[i]!;
    const current = findings.get(id) ?? [];
    const hadStale = ctx.repo.staleFor(id).length > 0;
    if (current.length) {
      ctx.repo.replaceStale(id, staleToRecord(current, eventSeq));
      affected.push({
        artifactId: id,
        reason: current[0]!.reason === 'missing_input' ? 'missing input' : 'input changed',
        ...diagnosticPath(current[0]!.path),
      });
    } else if (hadStale) {
      ctx.repo.clearStale(id);
      affected.push({ artifactId: id, reason: 'inputs restored', ...diagnosticPath(path) });
    }
    for (const edge of evaluating(graph.outgoing.get(id))) {
      const next = edge.downstreamArtifactId;
      if (!visited.has(next)) {
        visited.add(next);
        queue.push({ id: next, path: [...path, next] });
      }
    }
  }
  return affected;
}

export function neighbors(
  ctx: ProjectContext,
  artifactId: string,
  direction: 'upstream' | 'downstream' | 'both',
  depth: number,
  relationship?: Relationship,
) {
  const graph = snapshot(ctx);
  const seen = new Map([[artifactId, { depth: 0 }]]);
  const edges = new Map<string, Edge>();
  const queue = [{ id: artifactId, depth: 0 }];
  for (let i = 0; i < queue.length; i++) {
    const { id, depth: d } = queue[i]!;
    if (d >= depth) continue;
    const out = direction !== 'upstream' ? (graph.outgoing.get(id) ?? []) : [];
    const inc = direction !== 'downstream' ? (graph.incoming.get(id) ?? []) : [];
    for (const edge of [...out, ...inc]) {
      if (relationship && edge.relationship !== relationship) continue;
      edges.set(edge.id, edge);
      const next =
        edge.upstreamArtifactId === id ? edge.downstreamArtifactId : edge.upstreamArtifactId;
      if (!seen.has(next)) {
        seen.set(next, { depth: d + 1 });
        queue.push({ id: next, depth: d + 1 });
      }
    }
  }
  const artifacts = [...seen.keys()]
    .map((id) => graph.artifacts.get(id))
    .filter((a): a is Artifact => !!a)
    .map((a) => ({
      id: a.id,
      title: a.title,
      type: a.type,
      depth: seen.get(a.id)!.depth,
      freshness: ctx.freshnessOf(a.id).freshness,
    }));
  return { artifacts, edges: [...edges.values()] };
}

function reconstructPath(parent: Map<string, string | null>, id: string): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    path.push(cur);
    cur = parent.has(cur) ? parent.get(cur)! : null;
  }
  return path.reverse();
}

/** Complete impact traversal; no implicit depth limit or per-node database scan. */
export function impactReport(
  ctx: ProjectContext,
  refs: RevisionRef[],
  opts?: { limit?: number; offset?: number; includePaths?: boolean },
): ImpactReport {
  const graph = snapshot(ctx);
  const startIds = [...new Set(refs.map((r) => r.artifactId))];
  const visited = new Set(startIds);
  const parent = new Map<string, string | null>(startIds.map((id) => [id, null]));
  const queue = [...startIds];
  const edges: Edge[] = [];
  for (let i = 0; i < queue.length; i++) {
    for (const edge of evaluating(graph.outgoing.get(queue[i]!))) {
      const next = edge.downstreamArtifactId;
      if (visited.has(next)) continue;
      visited.add(next);
      parent.set(next, queue[i]!);
      edges.push(edge);
      queue.push(next);
    }
  }
  const offset = opts?.offset ?? 0;
  const end =
    opts?.limit === undefined ? edges.length : Math.min(edges.length, offset + opts.limit);
  const result: ImpactReport = {
    changedRefs: refs,
    affected: [],
    unaffectedSelectedComponentIds: [],
    totalAffected: edges.length,
    hasMore: false,
    offset,
  };
  // Commands supply a limit; internal proposal impact retains the complete list.
  // Traverse every node but build expensive path explanations only for the page.
  const budget = opts?.limit === undefined ? Infinity : 32 * 1024;
  let bytes = Buffer.byteLength(JSON.stringify(result));
  for (let i = offset; i < end; i++) {
    const edge = edges[i]!;
    const next = edge.downstreamArtifactId;
    const artifact = graph.artifacts.get(next);
    const row: ImpactReport['affected'][number] = {
      artifactId: next,
      title: artifact?.title ?? next,
      type: artifact?.type ?? 'note',
      reason: edge.requiredUpstreamRevisionId
        ? 'recorded input revision changed'
        : 'upstream input changed',
      ...(opts?.includePaths === false
        ? { path: [next] }
        : diagnosticPath(reconstructPath(parent, next))),
    };
    const rowBytes = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (bytes + rowBytes > budget) {
      if (result.affected.length === 0)
        throw new BureauError(
          ErrorCodes.VALIDATION,
          'Impact page exceeds the response budget; use fewer changed refs or includePaths: false',
        );
      break;
    }
    result.affected.push(row);
    bytes += rowBytes;
  }
  result.hasMore = offset + result.affected.length < edges.length;
  return result;
}

export function staleToRecord(findings: StaleFinding[], sinceEventSeq: number): StaleRecord[] {
  return findings.map((finding) => ({ ...finding, sinceEventSeq }));
}
