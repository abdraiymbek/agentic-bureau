import React, { useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { cmd } from '../api';
import { useStore } from '../store';
import type { Edge as GraphEdge } from '@stark/contracts';

/** History: decision log + event stream + dependency graph. */
export function HistoryView() {
  const { events, artifacts, selectArtifact, navigate } = useStore();
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [tab, setTab] = useState<'graph' | 'log'>('graph');

  useEffect(() => {
    void cmd<{ edges: GraphEdge[] }>('graph.list', {}).then((r) => setEdges(r.edges)).catch(() => {});
  }, [artifacts.length]);

  const { nodes, rfEdges } = useMemo(() => {
    const title = (id: string) => artifacts.find((v) => v.artifact.id === id)?.artifact.title ?? id.slice(0, 8);
    const type = (id: string) => artifacts.find((v) => v.artifact.id === id)?.artifact.type ?? 'note';
    const ids = new Set<string>();
    for (const e of edges) {
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
      const ups = edges.filter((e) => e.downstreamArtifactId === id && e.relationship !== 'connects_to');
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
      return {
        id,
        position: { x: idx * 200 + 20, y: d * 90 + 20 },
        data: { label: `${title(id)} · ${type(id)}` },
        style: {
          background: '#262a30',
          color: '#e6e9ed',
          border: '1px solid #343b44',
          borderRadius: 4,
          fontSize: 12,
          width: 180,
        },
      };
    });
    const rfEdges: Edge[] = edges.map((e) => ({
      id: e.id,
      source: e.upstreamArtifactId,
      target: e.downstreamArtifactId,
      animated: false,
      label: e.relationship === 'connects_to' ? 'connects' : e.relationship,
      style: { stroke: e.relationship === 'connects_to' ? '#d7b979' : '#87afc7' },
      labelStyle: { fill: '#a5adb8', fontSize: 10 },
      markerEnd: { type: 'arrowclosed' as never, color: '#87afc7' },
    }));
    return { nodes, rfEdges };
  }, [edges, artifacts]);

  const decisions = useMemo(() => {
    return events
      .filter((e) => ['proposal.resolved', 'baseline.changed', 'impact.propagated', 'revision.committed', 'project.created'].includes(e.type))
      .slice(-60)
      .reverse();
  }, [events]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="row" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
        <button style={{ height: 26, fontSize: 12 }} onClick={() => setTab('graph')} className={tab === 'graph' ? 'primary' : ''}>Dependency graph</button>
        <button style={{ height: 26, fontSize: 12 }} onClick={() => setTab('log')} className={tab === 'log' ? 'primary' : ''}>Change log</button>
      </div>
      {tab === 'graph' ? (
        <div style={{ flex: 1 }}>
          {nodes.length === 0 ? (
            <div className="faint" style={{ padding: 24, fontSize: 13 }}>No graph edges yet — agents wire dependencies as artifacts land.</div>
          ) : (
            <ReactFlow
              nodes={nodes}
              edges={rfEdges}
              fitView
              proOptions={{ hideAttribution: true }}
              onNodeClick={(_e, n) => {
                selectArtifact(n.id);
                navigate('artifacts');
              }}
            >
              <Background color="#262a30" gap={24} />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', padding: 12, fontSize: 12 }}>
          {decisions.map((e) => (
            <div key={e.id} style={{ padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
              <span className="faint mono">{e.ts.slice(0, 19).replace('T', ' ')}</span>
              <span className="dim" style={{ margin: '0 8px' }}>{e.type}</span>
              <span>{summ(e.data)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function summ(data: unknown): string {
  const d = data as Record<string, unknown>;
  if (d.artifactId) return `artifact ${String(d.artifactId).slice(0, 8)}`;
  if (d.changed) return `impact on ${(d.affected as unknown[])?.length ?? 0} artifact(s)`;
  return JSON.stringify(data).slice(0, 120);
}
