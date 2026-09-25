import React, { useCallback, useMemo, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Handle,
  Position,
  useReactFlow,
  type Edge as FlowEdge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowsOut, Minus, Plus } from '@phosphor-icons/react';
import type { ArtifactType, ArtifactView, Edge } from '@omenflow/contracts';
import { useStore } from '../store';
import { impactIds } from '../lib/graph';
import { IconButton, TypeGlyph, TYPES, typeMeta, type Layer } from '../ui/kit';

/**
 * Causal reading order: human intent and world sources on the left, evidence on the right.
 * A layer may span sub-columns so its internal links run horizontally.
 */
const COLUMNS: { layer: Layer; label: string; types: ArtifactType[] }[] = [
  { layer: 'intent', label: 'Intent', types: ['requirement', 'assumption'] },
  { layer: 'parts', label: 'Parts', types: ['source'] },
  { layer: 'parts', label: 'Parts', types: ['component'] },
  {
    layer: 'design',
    label: 'Design',
    types: [
      'concept',
      'architecture',
      'subsystem',
      'mechanical',
      'wiring',
      'software',
      'assembly',
      'note',
    ],
  },
  { layer: 'evidence', label: 'Evidence', types: ['calculation', 'test'] },
];
const NODE_W = 216;
const NODE_H = 40;
const ROW = 50;
const GROUP_GAP = 30;
const COL_GAP = 104;
const LAYER_GAP = 52;
const CAUSAL = new Set(['depends_on', 'derived_from', 'validates']);
const TOUCH_WINDOW_MS = 15 * 60 * 1000;

interface ObjectData extends Record<string, unknown> {
  view: ArtifactView;
  stale: boolean;
  touched: boolean;
  dim: boolean;
  lit: boolean;
  impact: boolean;
}

function columnOf(type: string) {
  const i = COLUMNS.findIndex((c) => c.types.includes(type as ArtifactType));
  return i < 0 ? 3 : i;
}

type Positions = Map<string, { x: number; y: number; col: number }>;

/**
 * Deterministic layered layout: columns by layer, groups by type, rows ordered by the
 * barycentre of upstream neighbours (or downstream ones for pure inputs such as sources).
 */
function layout(artifacts: ArtifactView[], edges: Edge[]) {
  const upstream = new Map<string, string[]>();
  const downstream = new Map<string, string[]>();
  for (const e of edges) {
    if (!upstream.has(e.downstreamArtifactId)) upstream.set(e.downstreamArtifactId, []);
    upstream.get(e.downstreamArtifactId)!.push(e.upstreamArtifactId);
    if (!downstream.has(e.upstreamArtifactId)) downstream.set(e.upstreamArtifactId, []);
    downstream.get(e.upstreamArtifactId)!.push(e.downstreamArtifactId);
  }
  const active = COLUMNS.map((c, i) => ({ ...c, index: i })).filter((c) =>
    artifacts.some((v) => columnOf(v.artifact.type) === c.index),
  );
  const xs: number[] = [];
  active.forEach((column, slot) => {
    const prev = active[slot - 1];
    xs.push(
      slot === 0
        ? 0
        : xs[slot - 1]! + NODE_W + (prev?.layer === column.layer ? LAYER_GAP : COL_GAP),
    );
  });
  const pass = (previous: Positions | null) => {
    const pos: Positions = new Map();
    const labels: {
      id: string;
      x: number;
      y: number;
      text: string;
      kind: 'column' | 'type';
      count?: number;
    }[] = [];
    active.forEach((column, slot) => {
      const x = xs[slot]!;
      const members = artifacts.filter((v) => columnOf(v.artifact.type) === column.index);
      if (active[slot - 1]?.layer !== column.layer) {
        const count = artifacts.filter(
          (v) => TYPES[v.artifact.type]?.layer === column.layer,
        ).length;
        labels.push({
          id: `col:${column.index}`,
          x,
          y: -58,
          text: column.label,
          kind: 'column',
          count,
        });
      }
      let y = 0;
      for (const type of column.types) {
        const group = members.filter((v) => v.artifact.type === type);
        if (!group.length) continue;
        const mean = (ids: string[] | undefined, from: Positions | null) => {
          const ys = (ids ?? [])
            .map((id) => from?.get(id)?.y)
            .filter((n): n is number => n !== undefined);
          return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Number.POSITIVE_INFINITY;
        };
        const key = (v: ArtifactView) => {
          const up = mean(upstream.get(v.artifact.id), pos);
          return Number.isFinite(up) ? up : mean(downstream.get(v.artifact.id), previous);
        };
        group.sort((a, b) => {
          const d = key(a) - key(b);
          return Number.isFinite(d) && d !== 0
            ? d
            : a.artifact.title.localeCompare(b.artifact.title);
        });
        labels.push({
          id: `type:${type}`,
          x,
          y,
          text: TYPES[type].plural,
          kind: 'type',
          count: group.length,
        });
        y += 24;
        for (const v of group) {
          pos.set(v.artifact.id, { x, y, col: slot });
          y += ROW;
        }
        y += GROUP_GAP - (ROW - NODE_H);
      }
    });
    return { pos, labels };
  };
  return pass(pass(null).pos);
}

function ObjectNode({ data }: NodeProps<Node<ObjectData>>) {
  const { view, stale, touched, dim, lit, impact } = data;
  const noBaseline = !view.revision;
  return (
    <div
      className={`map-node ${stale ? 'stale' : ''} ${touched ? 'touched' : ''} ${dim ? 'dim' : ''} ${lit ? 'lit' : ''} ${impact ? 'impact' : ''}`}
      title={`${typeMeta(view.artifact.type).label} · ${view.artifact.title}`}
    >
      <Handle type="target" id="l" position={Position.Left} />
      <Handle type="target" id="r-in" position={Position.Right} />
      <TypeGlyph type={view.artifact.type} size={14} />
      <span className="map-node-title">{view.artifact.title}</span>
      {view.pendingProposal ? (
        <span className="map-mark tone-warn" aria-label="In review" />
      ) : stale ? (
        <span className="map-mark tone-warn" aria-label="Out of date" />
      ) : noBaseline ? (
        <span className="map-mark hollow" aria-label="No baseline" />
      ) : null}
      <Handle type="source" id="r" position={Position.Right} />
      <Handle type="source" id="l-out" position={Position.Left} />
    </div>
  );
}

function LabelNode({ data }: NodeProps<Node<{ text: string; kind: string; count?: number }>>) {
  return (
    <div className={`map-label ${data.kind}`}>
      {data.text}
      {data.count !== undefined && <span>{data.count}</span>}
    </div>
  );
}

const nodeTypes = { object: ObjectNode, label: LabelNode };

function FlowCanvas({ reserveRight }: { reserveRight: number }) {
  const artifacts = useStore((s) => s.artifacts);
  const edges = useStore((s) => s.edges);
  const stale = useStore((s) => s.stale);
  const events = useStore((s) => s.events);
  const theme = useStore((s) => s.theme);
  const focus = useStore((s) => s.focus);
  const [hovered, setHovered] = useState<string | null>(null);
  const flow = useReactFlow();

  const known = useMemo(() => new Set(artifacts.map((v) => v.artifact.id)), [artifacts]);
  const liveEdges = useMemo(
    () => edges.filter((e) => known.has(e.upstreamArtifactId) && known.has(e.downstreamArtifactId)),
    [edges, known],
  );
  const { pos, labels } = useMemo(() => layout(artifacts, liveEdges), [artifacts, liveEdges]);
  const impact = useMemo(() => impactIds(stale), [stale]);

  const touched = useMemo(() => {
    const now = Date.now();
    const ids = new Set<string>();
    for (const e of events) {
      if (e.origin !== 'agent' || now - new Date(e.ts).getTime() > TOUCH_WINDOW_MS) continue;
      const id = (e.data as { artifactId?: string } | null)?.artifactId;
      if (id) ids.add(id);
    }
    return ids;
  }, [events]);

  /** The full causal thread through the hovered object, both directions. */
  const thread = useMemo(() => {
    if (!hovered) return null;
    const ids = new Set([hovered]);
    const walk = (dir: 'up' | 'down') => {
      const queue = [hovered];
      while (queue.length) {
        const id = queue.shift()!;
        for (const e of liveEdges) {
          if (!CAUSAL.has(e.relationship)) continue;
          const next =
            dir === 'up'
              ? e.downstreamArtifactId === id && e.upstreamArtifactId
              : e.upstreamArtifactId === id && e.downstreamArtifactId;
          if (next && !ids.has(next)) {
            ids.add(next);
            queue.push(next);
          }
        }
      }
    };
    walk('up');
    walk('down');
    return ids;
  }, [hovered, liveEdges]);

  const nodes = useMemo<Node[]>(() => {
    const list: Node[] = labels.map((l) => ({
      id: l.id,
      type: 'label',
      position: { x: l.x, y: l.y },
      data: { text: l.text, kind: l.kind, count: l.count },
      selectable: false,
      draggable: false,
      focusable: false,
    }));
    for (const v of artifacts) {
      const p = pos.get(v.artifact.id);
      if (!p) continue;
      const id = v.artifact.id;
      list.push({
        id,
        type: 'object',
        position: { x: p.x, y: p.y },
        width: NODE_W,
        height: NODE_H,
        draggable: false,
        ariaLabel: `${typeMeta(v.artifact.type).label}: ${v.artifact.title}`,
        data: {
          view: v,
          stale: (stale[id] ?? []).length > 0,
          touched: touched.has(id),
          dim: !!thread && !thread.has(id),
          lit: !!thread && thread.has(id),
          impact: !thread && impact.has(id),
        } satisfies ObjectData,
      });
    }
    return list;
  }, [artifacts, pos, labels, stale, touched, thread, impact]);

  const flowEdges = useMemo<FlowEdge[]>(
    () =>
      liveEdges.map((e) => {
        const a = pos.get(e.upstreamArtifactId);
        const b = pos.get(e.downstreamArtifactId);
        const same = a && b && a.col === b.col;
        const backwards = a && b && b.col < a.col;
        const inThread = thread?.has(e.upstreamArtifactId) && thread?.has(e.downstreamArtifactId);
        const onImpact = impact.has(e.upstreamArtifactId) && impact.has(e.downstreamArtifactId);
        return {
          id: e.id,
          source: e.upstreamArtifactId,
          target: e.downstreamArtifactId,
          sourceHandle: backwards ? 'l-out' : 'r',
          targetHandle: same || backwards ? 'r-in' : 'l',
          className: [
            'map-edge',
            CAUSAL.has(e.relationship) ? '' : 'weak',
            thread ? (inThread ? 'lit' : 'dim') : onImpact ? 'impact' : '',
          ].join(' '),
          focusable: false,
        };
      }),
    [liveEdges, pos, thread, impact],
  );

  const onEnter = useCallback((_: unknown, n: Node) => n.type === 'object' && setHovered(n.id), []);
  const onLeave = useCallback(() => setHovered(null), []);

  return (
    <div className="map">
      <ReactFlow
        colorMode={theme}
        nodes={nodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{
          padding: { top: '150px', bottom: '64px', left: '48px', right: `${reserveRight}px` },
          maxZoom: 1.05,
        }}
        minZoom={0.2}
        maxZoom={1.8}
        nodesDraggable={false}
        nodesConnectable={false}
        panOnScroll
        zoomOnPinch
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => n.type === 'object' && focus(n.id)}
        onNodeMouseEnter={onEnter}
        onNodeMouseLeave={onLeave}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.1} color="var(--map-dot)" />
      </ReactFlow>
      <div className="map-legend" aria-hidden="true">
        <span>
          <i className="lg-line" /> depends on
        </span>
        <span>
          <i className="lg-dot warn" /> out of date / in review
        </span>
        <span>
          <i className="lg-dot hollow" /> no baseline
        </span>
        <span>
          <i className="lg-ring" /> changed by agent
        </span>
      </div>
      <div className="map-controls island">
        <IconButton size="sm" label="Zoom out" onClick={() => void flow.zoomOut({ duration: 160 })}>
          <Minus size={13} />
        </IconButton>
        <IconButton size="sm" label="Zoom in" onClick={() => void flow.zoomIn({ duration: 160 })}>
          <Plus size={13} />
        </IconButton>
        <IconButton
          size="sm"
          label="Fit project"
          onClick={() =>
            void flow.fitView({
              duration: 240,
              padding: { top: '150px', bottom: '64px', left: '48px', right: `${reserveRight}px` },
            })
          }
        >
          <ArrowsOut size={13} />
        </IconButton>
      </div>
    </div>
  );
}

export function FlowMap({ reserveRight = 48 }: { reserveRight?: number }) {
  return (
    <ReactFlowProvider>
      <FlowCanvas reserveRight={reserveRight} />
    </ReactFlowProvider>
  );
}
