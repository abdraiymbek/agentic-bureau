import React, { forwardRef, memo } from 'react';
import {
  CaretDown,
  CaretRight,
  FrameCorners,
  GitBranch,
  Keyboard,
  Minus,
  Plus,
} from '@phosphor-icons/react';
import { Button, IconButton, Kbd, State, Tooltip, TypeGlyph, typeMeta } from '../../ui/kit';
import { useSignal, type Signal } from './chrome';
import type { MapController, MapStatus } from './controller';
import { FLAG, groupSummary, stateWords } from './describe';
import { ZOOM } from './fit';
import type { FlowLayout, LayoutLabel, LayoutNode } from './layout';
import type { LayoutEdge } from './routing';

/** The marks a node carries. Shape tells them apart; the node's name and its peek say them in words. */
function Marks({ flags }: { flags: number }) {
  return (
    <>
      {flags & FLAG.review ? <GitBranch size={12} className="map-mark-review" /> : null}
      {flags & FLAG.missing ? (
        <span className="map-mark missing" />
      ) : flags & FLAG.stale ? (
        <span className="map-mark tone-warn" />
      ) : null}
      {flags & FLAG.noBaseline ? <span className="map-mark hollow" /> : null}
    </>
  );
}

/** One object, or one collapsed type group. Re-renders only when its own state changes. */
export const MapNode = memo(function MapNode({
  node,
  flags,
  name,
}: {
  node: LayoutNode;
  flags: number;
  name: string;
}) {
  const className = [
    'map-node',
    node.lines === 2 && 'tall',
    node.kind === 'group' && 'group',
    flags & FLAG.missing ? 'missing' : flags & FLAG.stale ? 'stale' : '',
    flags & FLAG.review && 'reviewing',
    flags & FLAG.noBaseline && 'unbaselined',
    flags & FLAG.touched && 'touched',
    flags & FLAG.impact && 'impact',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={className}
      data-node={node.id}
      tabIndex={-1}
      aria-label={name}
      aria-expanded={node.kind === 'group' ? false : undefined}
      style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
    >
      <TypeGlyph type={node.type} size={14} />
      <span className="map-node-title">{node.title}</span>
      <Marks flags={flags} />
    </button>
  );
});

const edgeClass = (edge: LayoutEdge, impact: boolean) =>
  `map-edge ${edge.kind}${edge.causal ? '' : ' weak'}${impact ? ' impact' : ''}`;

/**
 * One link and its arrowhead. A solid link is a single path; a dashed or dotted one keeps its
 * arrowhead in a path of its own so the head stays whole.
 */
function EdgeShape({
  edge,
  className,
  name,
}: {
  edge: LayoutEdge;
  className: string;
  name?: string;
}) {
  if (edge.causal && edge.kind !== 'back')
    return <path className={className} data-edge={name} d={edge.line + edge.arrow} />;
  return (
    <g className={className} data-edge={name}>
      <path className="map-edge-line" d={edge.line} />
      <path d={edge.arrow} />
    </g>
  );
}

/**
 * Every link, drawn twice: once on the map, and once above the veil that dims the map while a
 * thread is lit. The upper copy is hidden until the controller marks it.
 */
export const MapEdges = memo(function MapEdges({
  layout,
  impact,
}: {
  layout: FlowLayout;
  /** Drawn links on a recorded stale path, with their distance from the change. */
  impact: ReadonlyMap<string, number>;
}) {
  const { bounds, edges } = layout;
  const frame = { left: bounds.x, top: bounds.y, width: bounds.w, height: bounds.h };
  const viewBox = `${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`;
  return (
    <>
      <svg className="map-edges" style={frame} viewBox={viewBox} aria-hidden="true">
        {edges.map((e) => (
          <EdgeShape key={e.key} edge={e} className={edgeClass(e, impact.has(e.key))} />
        ))}
      </svg>
      <div className="map-veil" aria-hidden="true" />
      <svg className="map-edges over" style={frame} viewBox={viewBox} aria-hidden="true">
        {edges.map((e) => (
          <EdgeShape key={e.key} edge={e} className={edgeClass(e, false)} name={e.key} />
        ))}
        {edges
          .filter((e) => impact.has(e.key))
          .map((e) => (
            <path
              key={`run:${e.key}`}
              className="map-impact-run"
              d={e.line}
              style={
                {
                  '--map-length': Math.ceil(e.length),
                  '--map-step': impact.get(e.key),
                } as React.CSSProperties
              }
            />
          ))}
      </svg>
    </>
  );
});

/** Column names and type-group headers. A group header collapses or expands its group. */
export const MapLabels = memo(
  forwardRef<HTMLDivElement, { labels: LayoutLabel[] }>(function MapLabels({ labels }, ref) {
    return (
      <div className="map-labels" ref={ref}>
        {labels.map((label) =>
          label.kind === 'column' ? (
            <div
              key={label.id}
              className="map-label column"
              style={{ left: label.x, top: label.y }}
            >
              {label.text} <span>{label.count}</span>
            </div>
          ) : (
            <button
              key={label.id}
              type="button"
              tabIndex={-1}
              className="map-label type"
              data-group={label.type}
              aria-expanded={!label.collapsed}
              aria-label={`${label.text}: ${label.count} ${label.count === 1 ? 'object' : 'objects'}, ${
                label.collapsed ? 'collapsed' : 'expanded'
              }`}
              style={{ left: label.x, top: label.y }}
            >
              {label.collapsed ? <CaretRight size={9} /> : <CaretDown size={9} />}
              {label.text} <span>{label.count}</span>
            </button>
          ),
        )}
      </div>
    );
  }),
);

/** What the marks on the map mean. Lists only the marks that are on the map right now. */
export const MapLegend = memo(function MapLegend({
  flags,
  edges,
}: {
  /** Every state flag present on any node. */
  flags: number;
  edges: { causal: boolean; weak: boolean; back: boolean; impact: boolean };
}) {
  const entries: [string, React.ReactNode, string][] = [];
  if (edges.causal) entries.push(['causal', <i className="lg-line" />, 'input → consequence']);
  if (edges.weak) entries.push(['weak', <i className="lg-line weak" />, 'related']);
  if (edges.back) entries.push(['back', <i className="lg-line back" />, 'runs right to left']);
  if (edges.impact) entries.push(['impact', <i className="lg-line impact" />, 'path of a change']);
  if (flags & FLAG.stale)
    entries.push(['stale', <i className="map-mark tone-warn" />, 'out of date']);
  if (flags & FLAG.missing)
    entries.push(['missing', <i className="map-mark missing" />, 'missing input']);
  if (flags & FLAG.review)
    entries.push(['review', <GitBranch size={12} className="map-mark-review" />, 'in review']);
  if (flags & FLAG.noBaseline)
    entries.push(['hollow', <i className="map-mark hollow" />, 'no baseline']);
  if (flags & FLAG.touched)
    entries.push(['touched', <i className="lg-ring" />, 'changed by agent']);
  if (!entries.length) return null;
  return (
    <ul className="map-legend island" aria-label="Map legend">
      {entries.map(([key, mark, text]) => (
        <li key={key}>
          {mark}
          {text}
        </li>
      ))}
    </ul>
  );
});

const SHORTCUTS: [string, string][] = [
  ['← →', 'Follow links upstream and downstream'],
  ['↑ ↓', 'Move within a column'],
  ['↵', 'Open the object'],
  ['T', 'Show the thread for the focused object'],
  ['C', 'Collapse or expand its type group'],
  ['+ −', 'Zoom'],
  ['0', 'Fit at a readable size'],
  ['⇧0', 'Fit the whole map'],
];

/** Spoken description of the keyboard model, for the map's `aria-describedby`. */
export const KEYBOARD_HELP =
  'Arrow left and right follow links upstream and downstream. Arrow up and down move within a column. ' +
  'Enter opens the object. T shows the thread for the focused object. C collapses or expands its type group. ' +
  'Plus and minus zoom, 0 fits the map at a readable size, Shift 0 fits the whole map.';

export function MapControls({
  status,
  controller,
}: {
  status: Signal<MapStatus>;
  controller: React.RefObject<MapController | null>;
}) {
  const { zoom, outside, canFitAll, threadPinned } = useSignal(status);
  return (
    <div className="map-controls island">
      {threadPinned && <span className="map-controls-note">Thread follows focus</span>}
      {outside > 0 && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => controller.current?.fit(canFitAll ? 'all' : 'fit')}
        >
          {outside} off screen
        </Button>
      )}
      <IconButton
        size="sm"
        label="Zoom out (−)"
        disabled={zoom <= ZOOM.min}
        onClick={() => controller.current?.zoomBy(1 / ZOOM.step)}
      >
        <Minus size={13} />
      </IconButton>
      <span className="map-zoom" aria-label={`Zoom ${Math.round(zoom * 100)} percent`}>
        {Math.round(zoom * 100)}%
      </span>
      <IconButton
        size="sm"
        label="Zoom in (+)"
        disabled={zoom >= ZOOM.max}
        onClick={() => controller.current?.zoomBy(ZOOM.step)}
      >
        <Plus size={13} />
      </IconButton>
      <IconButton
        size="sm"
        label="Fit at a readable size (0)"
        onClick={() => controller.current?.fit('fit')}
      >
        <FrameCorners size={13} />
      </IconButton>
      <Tooltip
        label={
          <span className="map-keys">
            {SHORTCUTS.map(([keys, text]) => (
              <React.Fragment key={keys}>
                <Kbd>{keys}</Kbd>
                <span>{text}</span>
              </React.Fragment>
            ))}
          </span>
        }
      >
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Map keyboard shortcuts">
          <Keyboard size={13} />
        </button>
      </Tooltip>
    </div>
  );
}

/**
 * The full title and the state of one node in words, spelled out below the map while the pointer
 * or keyboard focus rests on it. It repeats the node's accessible name, so it is hidden from
 * that tree.
 */
export function MapPeek({
  target,
  layout,
  flags,
  degree,
}: {
  target: Signal<string | null>;
  layout: FlowLayout;
  flags: ReadonlyMap<string, number>;
  degree: ReadonlyMap<string, { inputs: number; consequences: number }>;
}) {
  const id = useSignal(target);
  const node = id ? layout.byId.get(id) : undefined;
  if (!node) return <div className="map-peek-slot" />;
  const meta = typeMeta(node.type);
  const links = degree.get(node.id) ?? { inputs: 0, consequences: 0 };
  const summary =
    node.kind === 'group' ? groupSummary(node.members.map((m) => flags.get(m) ?? 0)) : [];
  return (
    <div className="map-peek-slot" aria-hidden="true">
      <div className="map-peek island">
        <span className="map-peek-type">
          <TypeGlyph type={node.type} size={13} />
          {node.kind === 'group' ? `${meta.plural} · collapsed group` : meta.label}
        </span>
        <strong>{node.title}</strong>
        {node.kind === 'group' ? (
          <span className="map-peek-links">{[...summary, 'Click to expand'].join(' · ')}</span>
        ) : (
          <>
            {stateWords(flags.get(node.id) ?? 0).map((word) => (
              <State key={word.text} state={word.text} label={word.text} tone={word.tone} quiet />
            ))}
            <span className="map-peek-links">
              {links.inputs} {links.inputs === 1 ? 'input' : 'inputs'} · {links.consequences}{' '}
              {links.consequences === 1 ? 'consequence' : 'consequences'}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
