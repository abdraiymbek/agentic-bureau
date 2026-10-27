import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ArtifactView, Edge, ProjectEvent } from '@bureau/contracts';
import { useStore } from '../store';
import { causalAdjacency, impactIds, stalePathSteps } from '../lib/graph';
import { typeMeta } from '../ui/kit';
import { Signal } from './flow/chrome';
import { MapController, type MapStatus } from './flow/controller';
import { FLAG, flagsOf, groupFlags, groupName, nodeName } from './flow/describe';
import { collapsedTypes, estimateTextWidth, layoutFlow, type Measure } from './flow/layout';
import {
  KEYBOARD_HELP,
  MapControls,
  MapEdges,
  MapLabels,
  MapLegend,
  MapNode,
  MapPeek,
} from './flow/MapParts';
import { recall, remember } from './flow/memory';
import { buildGraph, type FlowGraph } from './flow/model';
import { agentTouches } from './flow/touch';

/** The same graph object for as long as the shape of the project stays the same. */
function useGraph(artifacts: ArtifactView[], edges: Edge[]): FlowGraph {
  const held = useRef<FlowGraph | null>(null);
  return useMemo(() => {
    const next = buildGraph(artifacts, edges);
    if (held.current?.key !== next.key) held.current = next;
    return held.current;
  }, [artifacts, edges]);
}

function createMeasure(): Measure {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return estimateTextWidth;
  const style = getComputedStyle(document.documentElement);
  const size = style.getPropertyValue('--text-sm').trim();
  const family = style.getPropertyValue('--font-sans').trim();
  if (!size || !family) return estimateTextWidth;
  context.font = `400 ${size} ${family}`;
  const cache = new Map<string, number>();
  return (text) => {
    let width = cache.get(text);
    if (width === undefined) cache.set(text, (width = context.measureText(text).width));
    return width;
  };
}

// Measured against the interface typeface, so it is only final once that has loaded.
let settledMeasure: Measure | null = null;

/** Measures node titles in the type they are drawn in; re-measures once when the font arrives. */
function useTitleMeasure(): Measure {
  const [measure, setMeasure] = useState<Measure>(() => settledMeasure ?? createMeasure());
  useEffect(() => {
    if (settledMeasure) return;
    let live = true;
    void document.fonts.ready.then(() => {
      settledMeasure ??= createMeasure();
      if (live) setMeasure(() => settledMeasure!);
    });
    return () => {
      live = false;
    };
  }, []);
  return measure;
}

/**
 * The previous value while a new one is equal to it, so a store refresh that changes nothing
 * on the map re-renders nothing on it.
 */
function useSame<T>(value: T, equal: (a: T, b: T) => boolean): T {
  const held = useRef(value);
  if (held.current !== value && !equal(held.current, value)) held.current = value;
  return held.current;
}

const sameEntries = <K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>) =>
  a.size === b.size && [...a].every(([key, value]) => b.has(key) && b.get(key) === value);

/** Objects the agent changed in the last 15 minutes. The ring comes off when the time is up. */
function useAgentTouch(events: ProjectEvent[]): ReadonlySet<string> {
  const [now, setNow] = useState(() => Date.now());
  const touches = useMemo(() => agentTouches(events, now), [events, now]);
  useEffect(() => {
    if (touches.nextExpiry === null) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, touches.nextExpiry - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [touches.nextExpiry]);
  return useSame(touches.ids, (a, b) => a.size === b.size && [...a].every((id) => b.has(id)));
}

/** Sequence number of the newest impact event, and the objects it reported as affected. */
function latestImpact(events: ProjectEvent[]): { seq: number; affected: string[] } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== 'impact.propagated') continue;
    const reported = (event.data as { affected?: unknown } | null)?.affected;
    const affected = (Array.isArray(reported) ? reported : [])
      .map((a) => (a as { artifactId?: unknown } | null)?.artifactId)
      .filter((id) => typeof id === 'string');
    return { seq: event.seq, affected };
  }
  return null;
}

/**
 * The flow map: every object as a node in its causal column, every recorded link routed between
 * them. React renders the structure; `MapController` handles pan, zoom, hover and keyboard
 * without rendering.
 */
export function FlowMap({
  head,
  island,
}: {
  /** The project header, which the map passes beneath. */
  head: HTMLElement | null;
  /** A floating island the fitted map keeps clear of, when one is resting on the canvas. */
  island: HTMLElement | null;
}) {
  const projectId = useStore((s) => s.projectId) ?? '';
  const artifacts = useStore((s) => s.artifacts);
  const edges = useStore((s) => s.edges);
  const stale = useStore((s) => s.stale);
  const events = useStore((s) => s.events);
  const helpId = useId();

  const graph = useGraph(artifacts, edges);
  const [choices, setChoices] = useState(() => recall(projectId).groups);
  const collapsed = useMemo(() => collapsedTypes(graph, choices), [graph, choices]);
  const measure = useTitleMeasure();
  const layout = useMemo(
    () => layoutFlow(graph, { collapsed, measure }),
    [graph, collapsed, measure],
  );
  const lineage = useMemo(
    () => ({
      adjacency: causalAdjacency(graph.links),
      causal: new Set(graph.links.filter((l) => l.causal).map((l) => l.key)),
    }),
    [graph],
  );
  const degree = useMemo(() => {
    const counts = new Map<string, { inputs: number; consequences: number }>();
    const of = (id: string) => {
      let entry = counts.get(id);
      if (!entry) counts.set(id, (entry = { inputs: 0, consequences: 0 }));
      return entry;
    };
    for (const link of graph.links) {
      of(link.to).inputs++;
      of(link.from).consequences++;
    }
    return counts;
  }, [graph]);

  const touched = useAgentTouch(events);
  const onPath = useMemo(() => impactIds(stale), [stale]);
  const flags = useSame(
    useMemo(
      () =>
        new Map(
          artifacts.map((v) => [
            v.artifact.id,
            flagsOf(v, touched.has(v.artifact.id), onPath.has(v.artifact.id)),
          ]),
        ),
      [artifacts, touched, onPath],
    ),
    sameEntries,
  );
  const impactSteps = useMemo(() => {
    const steps = stalePathSteps(stale);
    const drawn = new Map<string, number>();
    if (steps.size === 0) return drawn;
    for (const edge of layout.edges) {
      const step = Math.min(...edge.links.map((key) => steps.get(key) ?? Infinity));
      if (Number.isFinite(step)) drawn.set(edge.key, step);
    }
    return drawn;
  }, [layout, stale]);
  const impact = useSame(impactSteps, sameEntries);

  const nodes = useMemo(
    () =>
      layout.nodes.map((node) => {
        if (node.kind === 'group') {
          const members = node.members.map((id) => flags.get(id) ?? 0);
          return (
            <MapNode
              key={node.id}
              node={node}
              flags={groupFlags(members)}
              name={groupName(typeMeta(node.type).plural, members)}
            />
          );
        }
        const own = flags.get(node.id) ?? 0;
        return (
          <MapNode
            key={node.id}
            node={node}
            flags={own}
            name={nodeName(typeMeta(node.type).label, node.title, own)}
          />
        );
      }),
    [layout, flags],
  );
  const present = useMemo(() => {
    let any = 0;
    for (const f of flags.values()) any |= f;
    return {
      flags: any & ~FLAG.impact,
      edges: {
        causal: layout.edges.some((e) => e.causal),
        weak: layout.edges.some((e) => !e.causal),
        back: layout.edges.some((e) => e.kind === 'back'),
        impact: impact.size > 0,
      },
    };
  }, [flags, layout, impact]);

  const root = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const fade = useRef<HTMLDivElement>(null);
  const controller = useRef<MapController | null>(null);
  const [signals] = useState(() => ({
    status: new Signal<MapStatus>({ zoom: 1, outside: 0, canFitAll: false, threadPinned: false }),
    peek: new Signal<string | null>(null),
  }));

  const latest = useRef({ choices, collapsed });
  useLayoutEffect(() => {
    latest.current = { choices, collapsed };
  });
  const toggleGroup = useCallback(
    (type: string) => {
      const next = { ...latest.current.choices, [type]: !latest.current.collapsed.has(type) };
      remember(projectId, { groups: next });
      setChoices(next);
    },
    [projectId],
  );

  useLayoutEffect(() => {
    const memory = recall(projectId);
    const created = new MapController(
      {
        root: root.current!,
        world: world.current!,
        labels: labels.current!,
        grid: grid.current!,
        fade: fade.current!,
      },
      {
        open: (id) => useStore.getState().focus(id),
        toggleGroup,
        status: signals.status.set,
        peek: signals.peek.set,
        remember: (patch) => remember(projectId, patch),
      },
      { viewport: memory.viewport, focusId: memory.focusId },
    );
    controller.current = created;
    return () => {
      created.dispose();
      controller.current = null;
    };
  }, [projectId, signals, toggleGroup]);
  useLayoutEffect(() => {
    controller.current?.setChrome(head, island ? [island] : []);
  }, [head, island, projectId]);
  useLayoutEffect(() => {
    controller.current?.setLayout(layout, lineage.adjacency, lineage.causal);
  }, [layout, lineage, projectId]);

  // When an approval has just made objects out of date, the change is shown travelling to them
  // once. Impact that was already recorded when the map opened is simply shown.
  const impactSeen = useRef<number | null>(null);
  const impactDue = useRef<string[] | null>(null);
  useEffect(() => {
    const newest = latestImpact(events);
    if (impactSeen.current === null) impactSeen.current = newest?.seq ?? 0;
    else if (newest && newest.seq > impactSeen.current) {
      impactSeen.current = newest.seq;
      impactDue.current = newest.affected;
    }
    const due = impactDue.current;
    if (!due || impact.size === 0 || !due.some((id) => (stale[id] ?? []).length > 0)) return;
    impactDue.current = null;
    controller.current?.playImpact();
  }, [events, impact, stale]);

  return (
    <div
      className="map"
      ref={root}
      role="application"
      aria-roledescription="flow map"
      // Recorded links between the same two objects are drawn as one, so this count can be
      // lower than the project header's count of recorded links.
      aria-label={`Project flow: ${graph.nodes.length} objects, ${graph.links.length} drawn links`}
      aria-describedby={helpId}
    >
      <div className="map-grid" ref={grid} aria-hidden="true" />
      <div className="map-world" ref={world}>
        <MapEdges layout={layout} impact={impact} />
        <MapLabels labels={layout.labels} ref={labels} />
        {nodes}
      </div>
      <div className="map-fade" ref={fade} aria-hidden="true" />
      <p id={helpId} className="sr-only">
        {KEYBOARD_HELP}
      </p>
      <div className="map-foot" data-map-ui data-toast-avoid>
        <MapLegend flags={present.flags} edges={present.edges} />
        <MapPeek target={signals.peek} layout={layout} flags={flags} degree={degree} />
        <MapControls status={signals.status} controller={controller} />
      </div>
    </div>
  );
}
