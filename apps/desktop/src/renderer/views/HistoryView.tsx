import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { cmd } from '../api';
import { useStore } from '../store';
import { PageHeader, ArtifactIcon, EmptyState } from '../components/ui';
import { GitBranch, ClockCounterClockwise } from '@phosphor-icons/react';
import type { Edge as GraphEdge } from '@stark/contracts';

/** History: decision log + event stream + dependency graph. */
export function HistoryView() {
  const { events, artifacts, selectArtifact, navigate, stale, theme } = useStore();
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [tab, setTab] = useState<'graph' | 'log'>('graph');
  const [focus, setFocus] = useState<'all' | 'impact'>('impact');
  const impactIds = useMemo(
    () =>
      new Set(Object.values(stale).flatMap((reasons) => reasons.flatMap((reason) => reason.path))),
    [stale],
  );
  const graphEdges = useMemo(
    () =>
      focus === 'impact' && impactIds.size
        ? edges.filter(
            (e) => impactIds.has(e.upstreamArtifactId) && impactIds.has(e.downstreamArtifactId),
          )
        : edges,
    [edges, focus, impactIds],
  );

  useEffect(() => {
    void cmd<{ edges: GraphEdge[] }>('graph.list', {})
      .then((r) => setEdges(r.edges))
      .catch(() => {});
  }, [artifacts]);

  const titleOf = useCallback(
    (id: string) => artifacts.find((v) => v.artifact.id === id)?.artifact.title ?? id.slice(0, 8),
    [artifacts],
  );

  const { nodes, rfEdges } = useMemo(() => {
    const title = titleOf;
    const type = (id: string) =>
      artifacts.find((v) => v.artifact.id === id)?.artifact.type ?? 'note';
    const ids = new Set<string>();
    for (const e of graphEdges) {
      ids.add(e.upstreamArtifactId);
      ids.add(e.downstreamArtifactId);
    }
    // Simple layered layout: topological rank from upstream depth.
    const depth = new Map<string, number>();
    const visiting = new Set<string>();
    const compute = (id: string): number => {
      if (depth.has(id)) return depth.get(id)!;
      if (visiting.has(id)) return 0;
      visiting.add(id);
      const ups = graphEdges.filter(
        (e) => e.downstreamArtifactId === id && e.relationship !== 'connects_to',
      );
      const d = ups.length ? Math.max(...ups.map((e) => compute(e.upstreamArtifactId) + 1)) : 0;
      visiting.delete(id);
      depth.set(id, d);
      return d;
    };
    for (const id of ids) compute(id);
    const rankCount = new Map<number, number>();
    const nodes: Node[] = [...ids].map((id) => {
      const d = depth.get(id) ?? 0;
      const idx = rankCount.get(d) ?? 0;
      rankCount.set(d, idx + 1);
      const isStale = (stale[id] ?? []).length > 0;
      return {
        id,
        type: 'engineering',
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        position: { x: d * 290 + 30, y: idx * 120 + 30 },
        data: { label: title(id), kind: type(id), stale: isStale },
        style: {
          background: 'var(--bg-raised)',
          color: 'var(--text-primary)',
          border: `1px solid ${isStale ? 'var(--warn)' : 'var(--border-strong)'}`,
          borderRadius: 8,
          fontSize: 12,
          width: 220,
        },
      };
    });
    const rfEdges: Edge[] = graphEdges.map((e) => ({
      id: e.id,
      source: e.upstreamArtifactId,
      target: e.downstreamArtifactId,
      animated: false,
      label: e.relationship.replaceAll('_', ' '),
      style: { stroke: e.relationship === 'connects_to' ? 'var(--warn)' : 'var(--border-strong)' },
      labelStyle: { fill: 'var(--text-faint)', fontSize: 10 },
      labelBgStyle: { fill: 'var(--bg-main)', fillOpacity: 1 },
      labelBgPadding: [3, 2] as [number, number],
      markerEnd: { type: 'arrowclosed' as never, color: 'var(--text-faint)' },
    }));
    return { nodes, rfEdges };
  }, [graphEdges, artifacts, stale, titleOf]);

  const decisions = useMemo(() => {
    return events
      .filter((e) =>
        [
          'proposal.resolved',
          'baseline.changed',
          'impact.propagated',
          'revision.committed',
          'project.created',
        ].includes(e.type),
      )
      .slice(-60)
      .reverse();
  }, [events]);

  return (
    <div className="page">
      <PageHeader
        title="History & impact"
        description="Follow a decision from its requirement to every connected result."
      />
      <div className="toolbar">
        <div className="segmented">
          <button aria-pressed={tab === 'graph'} onClick={() => setTab('graph')}>
            <GitBranch size={14} />
            Dependency graph
          </button>
          <button aria-pressed={tab === 'log'} onClick={() => setTab('log')}>
            <ClockCounterClockwise size={14} />
            Change log
          </button>
        </div>
        <span className="grow" />
        {tab === 'graph' && impactIds.size > 0 && (
          <div className="segmented">
            <button aria-pressed={focus === 'impact'} onClick={() => setFocus('impact')}>
              Change impact
            </button>
            <button aria-pressed={focus === 'all'} onClick={() => setFocus('all')}>
              Entire project
            </button>
          </div>
        )}
        <span className="faint" style={{ fontSize: 11 }}>
          {nodes.length} objects
        </span>
      </div>
      {tab === 'graph' ? (
        <div className="graph-canvas">
          {nodes.length === 0 ? (
            <EmptyState
              title="Connect the engineering"
              body="Dependencies appear as your agent links requirements, calculations, parts, and test results."
              icon={<GitBranch size={25} />}
            />
          ) : (
            <ReactFlow
              key={focus + impactIds.size}
              colorMode={theme}
              nodes={nodes}
              edges={rfEdges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              minZoom={0.15}
              onNodeClick={(_e, n) => {
                selectArtifact(n.id);
                navigate(
                  ['requirement', 'assumption'].includes(String(n.data.kind))
                    ? 'requirements'
                    : 'artifacts',
                );
              }}
            >
              <Background color="var(--canvas-grid)" gap={24} size={1} />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
          <div className="graph-legend">
            <span>
              <span className="legend-line" />
              Recorded dependency
            </span>
            <span className="warn">
              <WarningIcon />
              Out of date
            </span>
          </div>
        </div>
      ) : (
        <div className="page-scroll">
          <div className="history-timeline">
            {decisions.length ? (
              decisions.map((e) => (
                <div className="timeline-event" key={e.id}>
                  <div className="timeline-icon">
                    <ClockCounterClockwise size={15} />
                  </div>
                  <div className="grow">
                    <strong>{eventLabels[e.type] ?? e.type.replaceAll('.', ' ')}</strong>
                    <p>{summ(e.data, titleOf)}</p>
                    <small>{new Date(e.ts).toLocaleString()}</small>
                  </div>
                </div>
              ))
            ) : (
              <EmptyState
                title="The record starts here"
                body="Project decisions and accepted revisions appear in this timeline as you work."
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
const eventLabels: Record<string, string> = {
  'proposal.resolved': 'Review decision recorded',
  'baseline.changed': 'Baseline updated',
  'impact.propagated': 'Downstream impact identified',
  'revision.committed': 'Revision recorded',
  'project.created': 'Project created',
};
function WarningIcon() {
  return <span className="legend-node" />;
}
function EngineeringNode({ data }: NodeProps) {
  return (
    <div className="engineering-node">
      <Handle type="target" position={Position.Left} />
      <div className="row">
        <ArtifactIcon type={String(data.kind)} />
        <span className="faint">{String(data.kind)}</span>
        {data.stale ? <span className="review-dot" title="Out of date" /> : null}
      </div>
      <strong>{String(data.label)}</strong>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { engineering: EngineeringNode };

function summ(data: unknown, titleOf: (id: string) => string): string {
  const d = data as Record<string, unknown>;
  if (d.proposalId && d.state) return `proposal ${String(d.state)}`;
  if (d.artifactId) return `artifact ${titleOf(String(d.artifactId))}`;
  if (d.changed) return `impact on ${(d.affected as unknown[])?.length ?? 0} artifact(s)`;
  return JSON.stringify(data).slice(0, 120);
}
