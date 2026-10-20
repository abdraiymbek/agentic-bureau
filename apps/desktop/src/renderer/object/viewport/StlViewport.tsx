import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  ArrowCounterClockwise,
  ArrowsOut,
  BoundingBox,
  Cube,
  Eye,
  Keyboard,
  Ruler,
  SquareHalf,
} from '@phosphor-icons/react';
import { Button, Kbd, Menu, Segmented, Spinner, Tooltip } from '../../ui/kit';
import type { ParsedMesh } from '../../lib/stl-parse';
import {
  AXES,
  STANDARD_VIEWS,
  VIEW_ORDER,
  boundsSize,
  drawnExtent,
  formatEnvelope,
  formatLength,
  gridSpacing,
  measure,
  sectionCoordinate,
  type Axis,
  type PickedPoint,
  type SectionSetting,
  type StandardView,
  type Vec3,
} from '../../lib/viewport-math';
import { meshFromBytes } from './mesh-client';
import { ViewportScene, type CompareMode, type SceneTheme, type ScreenPoint } from './scene';

export interface StlViewportProps {
  /** Raw STL bytes of the part. */
  stlData?: ArrayBuffer | null;
  /** The part already parsed through the mesh cache; used instead of `stlData`. */
  mesh?: ParsedMesh | null;
  /** A second part to compare against, as bytes or already parsed. */
  compareData?: ArrayBuffer | null;
  compareMesh?: ParsedMesh | null;
  modelUnit: string;
  /** Names for the two parts while a comparison is shown. */
  label?: string;
  compareLabel?: string;
  /** A standing label for geometry that is not what it might be taken for. */
  notice?: string | null;
  /** Told what the viewport shows of the part, whenever that changes. */
  onStatus?: (status: ViewportStatus) => void;
  /** Report again for a different revision, even when its mesh bytes are identical. */
  reviewKey?: string;
}

/**
 * What the viewport shows of the part: nothing given, still being parsed, on screen, or not
 * showable (an unreadable file, or no 3D view on this machine). Only `shown` means a person
 * could have looked at the geometry.
 */
export type ViewportStatus =
  | { state: 'empty' }
  | { state: 'parsing' }
  | { state: 'shown' }
  | { state: 'error'; reason: string };

/** The status for a parse result and the scene's state. */
export function viewportStatus(
  part: { mesh: ParsedMesh | null; error: string | null; parsing: boolean },
  scene: { ready: boolean; failure: string | null; drawnMesh: ParsedMesh | null },
): ViewportStatus {
  if (scene.failure)
    return { state: 'error', reason: `The 3D view is not available: ${scene.failure}` };
  if (part.error)
    return { state: 'error', reason: `The file is not a readable STL: ${part.error}` };
  if (part.parsing) return { state: 'parsing' };
  if (!part.mesh) return { state: 'empty' };
  return scene.ready && scene.drawnMesh === part.mesh ? { state: 'shown' } : { state: 'parsing' };
}

const ORBIT_STEP = Math.PI / 12;
const PAN_STEP = 0.06;
const ZOOM_STEP = 1.2;
const HOVER_INTENT_MS = 450;
const CLICK_SLOP = 4;
const DEFAULT_DISPLAY = { grid: true, edges: true, wireframe: false, bounds: false };
const VIEW_BY_KEY = Object.fromEntries(
  VIEW_ORDER.map((view) => [STANDARD_VIEWS[view].key, view]),
) as Record<string, StandardView>;

function readTheme(): SceneTheme {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(name).trim();
  return {
    background: token('--canvas-bg'),
    grid: token('--canvas-grid'),
    gridMajor: token('--canvas-grid-major'),
    axes: token('--text-3'),
    model: token('--model-color'),
    compare: token('--model-compare'),
    edge: token('--canvas-bg'),
    sectionFill: token('--text-2'),
    outline: token('--text-2'),
    measure: token('--signal'),
  };
}

interface Parsed {
  mesh: ParsedMesh | null;
  error: string | null;
  parsing: boolean;
}

/** Bytes to a mesh, off the interface thread and at most once per buffer. */
function useParsed(given: ParsedMesh | null | undefined, bytes: ArrayBuffer | null | undefined) {
  const [state, setState] = useState<{
    bytes: ArrayBuffer;
    mesh?: ParsedMesh;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (given || !bytes) return;
    let active = true;
    meshFromBytes(bytes).then(
      (mesh) => active && setState({ bytes, mesh }),
      (error: Error) => active && setState({ bytes, error: error.message }),
    );
    return () => {
      active = false;
    };
  }, [given, bytes]);
  if (given) return { mesh: given, error: null, parsing: false } satisfies Parsed;
  if (!bytes) return { mesh: null, error: null, parsing: false } satisfies Parsed;
  const current = state?.bytes === bytes ? state : null;
  return {
    mesh: current?.mesh ?? null,
    error: current?.error ?? null,
    parsing: !current,
  } satisfies Parsed;
}

type TagName = Axis | 'p0' | 'p1' | 'distance' | 'part' | 'compare';

const place = (element: HTMLElement | null | undefined, at: ScreenPoint | null) => {
  if (!element) return;
  element.hidden = !at?.visible;
  if (at?.visible) element.style.transform = `translate(${at.x}px, ${at.y}px)`;
};

const coordinates = (p: Vec3) => p.map((v) => v.toFixed(2)).join(', ');

/**
 * The part as an engineering object: standard views, projection, a section plane, a
 * point-to-point measure, the envelope with its dimensions, and an optional comparison.
 * Every number shown is read from the mesh and carries the model unit.
 */
export function StlViewport(props: StlViewportProps) {
  const { modelUnit } = props;
  const part = useParsed(props.mesh, props.stlData);
  const other = useParsed(props.compareMesh, props.compareData);
  const mount = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ViewportScene | null>(null);
  const tags = useRef<Partial<Record<TagName, HTMLElement | null>>>({});
  const axes = useRef<(SVGGElement | null)[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [sceneReady, setSceneReady] = useState(false);
  const [drawnMesh, setDrawnMesh] = useState<ParsedMesh | null>(null);
  const [generation, setGeneration] = useState(0);
  const [ortho, setOrtho] = useState(false);
  const [display, setDisplay] = useState(DEFAULT_DISPLAY);
  const [section, setSection] = useState<SectionSetting | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [points, setPoints] = useState<PickedPoint[]>([]);
  const [compareMode, setCompareMode] = useState<CompareMode>('overlay');
  const [keysOpen, setKeysOpen] = useState(false);
  const [zoomHint, setZoomHint] = useState(false);
  const helpId = useId();

  // What the frame callback needs, without re-creating the scene when it changes.
  const live = useRef({ part: part.mesh, points, display });
  live.current = { part: part.mesh, points, display };
  const scratch = useRef({
    at: { x: 0, y: 0, visible: false } as ScreenPoint,
    axis: { x: 0, y: 0, toward: 0 },
  });

  const layout = useCallback(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const { at, axis } = scratch.current;
    const tag = tags.current;
    const { part: mesh, points: picked, display: shown } = live.current;
    const bounds = shown.bounds && mesh ? mesh.bounds : null;
    const mid = (a: number, b: number) => (a + b) / 2;
    place(
      tag.x,
      bounds && scene.project(mid(bounds.min[0], bounds.max[0]), bounds.min[1], bounds.min[2], at),
    );
    place(
      tag.y,
      bounds && scene.project(bounds.max[0], mid(bounds.min[1], bounds.max[1]), bounds.min[2], at),
    );
    place(
      tag.z,
      bounds && scene.project(bounds.min[0], bounds.min[1], mid(bounds.min[2], bounds.max[2]), at),
    );
    const a = picked[0]?.point;
    const b = picked[1]?.point;
    place(tag.p0, a ? scene.project(a[0], a[1], a[2], at) : null);
    place(tag.p1, b ? scene.project(b[0], b[1], b[2], at) : null);
    place(
      tag.distance,
      a && b ? scene.project(mid(a[0], b[0]), mid(a[1], b[1]), mid(a[2], b[2]), at) : null,
    );
    place(tag.part, scene.projectName('part', at));
    place(tag.compare, scene.projectName('compare', at));
    axes.current.forEach((group, i) => {
      if (!group) return;
      scene.axisOnScreen(i as 0 | 1 | 2, axis);
      const line = group.firstElementChild as SVGLineElement;
      const text = group.lastElementChild as SVGTextElement;
      line.setAttribute('x2', String(28 + axis.x * 18));
      line.setAttribute('y2', String(28 + axis.y * 18));
      text.setAttribute('x', String(28 + axis.x * 25));
      text.setAttribute('y', String(28 + axis.y * 25));
      group.style.opacity = axis.toward < -0.2 ? '0.45' : '1';
    });
  }, []);

  useEffect(() => {
    const element = mount.current;
    if (!element) return;
    let scene: ViewportScene;
    try {
      scene = new ViewportScene(element, readTheme(), {
        onFrame: (mesh) => {
          layout();
          setDrawnMesh(mesh);
        },
        onContextLost: () => setFailure('The graphics context was lost.'),
      });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      return;
    }
    sceneRef.current = scene;
    setFailure(null);
    setSceneReady(true);
    // The theme is read from the document itself, after whoever sets it has set it.
    const themeWatch = new MutationObserver(() => scene.setTheme(readTheme()));
    themeWatch.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    // Scroll zooms only for someone who means the viewport: it has focus, the pointer has
    // rested on it, or the gesture is a pinch. Otherwise the wheel scrolls the stage.
    let intent = false;
    let timer = 0;
    let hintTimer = 0;
    const settle = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => (intent = true), HOVER_INTENT_MS);
    };
    const onWheel = (event: WheelEvent) => {
      const allowed =
        intent || event.ctrlKey || event.metaKey || document.activeElement === element;
      scene.setZoomEnabled(allowed);
      if (allowed) return;
      settle();
      setZoomHint(true);
      window.clearTimeout(hintTimer);
      hintTimer = window.setTimeout(() => setZoomHint(false), 1800);
    };
    const onLeave = () => {
      intent = false;
      window.clearTimeout(timer);
    };
    element.addEventListener('wheel', onWheel, { capture: true, passive: true });
    element.addEventListener('pointerenter', settle);
    element.addEventListener('pointerleave', onLeave);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(hintTimer);
      element.removeEventListener('wheel', onWheel, { capture: true });
      element.removeEventListener('pointerenter', settle);
      element.removeEventListener('pointerleave', onLeave);
      themeWatch.disconnect();
      sceneRef.current = null;
      setSceneReady(false);
      setDrawnMesh(null);
      scene.dispose();
    };
  }, [layout, generation]);

  const status = viewportStatus(part, { ready: sceneReady, failure, drawnMesh });
  const report = useRef(props.onStatus);
  report.current = props.onStatus;
  const { state } = status;
  const reason = status.state === 'error' ? status.reason : '';
  useEffect(() => {
    report.current?.(state === 'error' ? { state, reason } : { state });
  }, [state, reason, part.mesh, props.reviewKey]);

  useEffect(() => {
    sceneRef.current?.setMesh(part.mesh);
    setPoints([]);
  }, [part.mesh, generation]);
  useEffect(() => {
    sceneRef.current?.setCompare(other.mesh, compareMode);
  }, [other.mesh, compareMode, generation]);
  useEffect(() => sceneRef.current?.setDisplay(display), [display, generation]);
  useEffect(() => sceneRef.current?.setSection(section), [section, part.mesh, generation]);
  useEffect(() => sceneRef.current?.setProjection(ortho), [ortho, generation]);
  useEffect(() => {
    sceneRef.current?.setMeasure(points.map((p) => p.point));
  }, [points, generation]);

  const toggle = (key: keyof typeof DEFAULT_DISPLAY) =>
    setDisplay((d) => ({ ...d, [key]: !d[key] }));
  const toggleSection = () =>
    setSection((s) => (s ? null : { axis: 'z', fraction: 0.5, flipped: false }));
  const toggleMeasure = () => {
    setMeasuring((on) => !on);
    setPoints([]);
  };
  const reset = () => {
    setOrtho(false);
    sceneRef.current?.setProjection(false);
    sceneRef.current?.setView('iso');
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const scene = sceneRef.current;
    if (!scene || event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const pan = event.shiftKey;
    const handled = (() => {
      switch (key) {
        // The eye moves the way the arrow points, as it does when dragging with OrbitControls keys.
        case 'ArrowLeft':
          return pan ? scene.pan(-PAN_STEP, 0) : scene.orbit(-ORBIT_STEP, 0);
        case 'ArrowRight':
          return pan ? scene.pan(PAN_STEP, 0) : scene.orbit(ORBIT_STEP, 0);
        case 'ArrowUp':
          return pan ? scene.pan(0, PAN_STEP) : scene.orbit(0, -ORBIT_STEP);
        case 'ArrowDown':
          return pan ? scene.pan(0, -PAN_STEP) : scene.orbit(0, ORBIT_STEP);
        case '+':
        case '=':
          return scene.zoom(ZOOM_STEP);
        case '-':
        case '_':
          return scene.zoom(1 / ZOOM_STEP);
        case 'f':
          return scene.fit();
        case '0':
          return reset();
        case 'o':
          return setOrtho((o) => !o);
        case 's':
          return toggleSection();
        case 'm':
          return toggleMeasure();
        case 'b':
          return toggle('bounds');
        case 'e':
          return toggle('edges');
        case 'w':
          return toggle('wireframe');
        case 'g':
          return toggle('grid');
        case 'Escape':
          if (!measuring) return false;
          setMeasuring(false);
          setPoints([]);
          return;
        default:
          if (!VIEW_BY_KEY[key]) return false;
          return scene.setView(VIEW_BY_KEY[key]);
      }
    })();
    if (handled === false) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const press = useRef<{ x: number; y: number } | null>(null);
  const onPointerUp = (event: React.PointerEvent) => {
    const start = press.current;
    press.current = null;
    if (!measuring || !start || event.button !== 0) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP) return;
    const picked = sceneRef.current?.pick(event.clientX, event.clientY);
    if (picked) setPoints((current) => (current.length >= 2 ? [picked] : [...current, picked]));
  };

  const mesh = part.mesh;
  const measured = points.length === 2 ? measure(points[0]!.point, points[1]!.point) : null;
  const size = mesh ? boundsSize(mesh.bounds) : null;
  const sectionAt = mesh && section ? sectionCoordinate(mesh.bounds, section) : null;
  const comparing = !!other.mesh;
  const grid =
    mesh && display.grid
      ? gridSpacing(
          drawnExtent(mesh.bounds, other.mesh?.bounds ?? null, compareMode === 'side-by-side'),
        )
      : null;

  return (
    <div className="viewport">
      <div
        ref={mount}
        className={`viewport-canvas ${measuring ? 'measuring' : ''}`}
        tabIndex={0}
        role="application"
        aria-label="3D model viewport"
        aria-describedby={helpId}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => {
          press.current = { x: event.clientX, y: event.clientY };
          mount.current?.focus({ preventScroll: true });
        }}
        onPointerUp={onPointerUp}
      />
      <p id={helpId} className="sr-only">
        Arrow keys orbit, Shift with arrow keys pans, plus and minus zoom, F fits, 0 resets, 1 to 7
        choose a standard view, O switches projection. Measuring needs a pointer.
      </p>

      <div className="viewport-overlay" aria-hidden="true">
        {AXES.map((axis, i) => (
          <span
            key={axis}
            className="viewport-tag num"
            ref={(element) => {
              tags.current[axis] = element;
            }}
            hidden
          >
            {size ? formatLength(size[i]!, modelUnit) : ''}
          </span>
        ))}
        {(['p0', 'p1'] as const).map((name) => (
          <span
            key={name}
            className="viewport-dot"
            ref={(element) => {
              tags.current[name] = element;
            }}
            hidden
          />
        ))}
        <span
          className="viewport-tag measure num"
          ref={(element) => {
            tags.current.distance = element;
          }}
          hidden
        >
          {measured ? formatLength(measured.distance, modelUnit) : ''}
        </span>
        <span
          className="viewport-tag"
          ref={(element) => {
            tags.current.part = element;
          }}
          hidden
        >
          {props.label ?? 'Shown'}
        </span>
        <span
          className="viewport-tag"
          ref={(element) => {
            tags.current.compare = element;
          }}
          hidden
        >
          {props.compareLabel ?? 'Comparison'}
        </span>
      </div>

      {failure ? (
        <div className="mech-empty">
          <strong>The 3D view is not available</strong>
          <span>{failure}</span>
          <Button size="sm" onClick={() => setGeneration((n) => n + 1)}>
            Try again
          </Button>
        </div>
      ) : part.error ? (
        <div className="mech-empty" role="alert">
          <strong>This file is not a readable STL</strong>
          <span>{part.error}</span>
        </div>
      ) : (
        part.parsing && (
          <div className="mech-empty" role="status">
            <Spinner size={16} />
            <strong>Reading the mesh</strong>
          </div>
        )
      )}

      {(props.notice || other.error) && (
        <div className="viewport-corner">
          {props.notice && <span className="viewport-chip">{props.notice}</span>}
          {other.error && (
            <span className="viewport-chip" role="alert">
              The comparison mesh could not be read: {other.error}
            </span>
          )}
        </div>
      )}

      {mesh && (
        <div className="viewport-side">
          <div className="viewport-tools island" role="toolbar" aria-label="Viewport tools">
            <Tooltip label="Fit to view (F)">
              <button
                type="button"
                aria-label="Fit to view"
                onClick={() => sceneRef.current?.fit()}
              >
                <ArrowsOut size={14} />
              </button>
            </Tooltip>
            <Tooltip label="Reset view (0)">
              <button type="button" aria-label="Reset view" onClick={reset}>
                <ArrowCounterClockwise size={14} />
              </button>
            </Tooltip>
            <Menu
              align="end"
              trigger={
                <button type="button" aria-label="Standard views">
                  <Cube size={14} />
                  <span className="viewport-tools-label">View</span>
                </button>
              }
              items={VIEW_ORDER.map((view) => ({
                label: STANDARD_VIEWS[view].label,
                shortcut: STANDARD_VIEWS[view].key,
                onSelect: () => sceneRef.current?.setView(view),
              }))}
            />
            <Tooltip label="Switch projection (O)">
              <button
                type="button"
                aria-label={`Projection: ${ortho ? 'orthographic' : 'perspective'}`}
                onClick={() => setOrtho((o) => !o)}
              >
                <span>{ortho ? 'Ortho' : 'Persp'}</span>
              </button>
            </Tooltip>
            <span className="viewport-tools-rule" aria-hidden="true" />
            <Tooltip label="Section plane (S)">
              <button
                type="button"
                aria-label="Section plane"
                aria-pressed={!!section}
                onClick={toggleSection}
              >
                <SquareHalf size={14} />
              </button>
            </Tooltip>
            <Tooltip label="Measure between two points (M)">
              <button
                type="button"
                aria-label="Measure"
                aria-pressed={measuring}
                onClick={toggleMeasure}
              >
                <Ruler size={14} />
              </button>
            </Tooltip>
            <Tooltip label="Envelope dimensions (B)">
              <button
                type="button"
                aria-label="Envelope dimensions"
                aria-pressed={display.bounds}
                onClick={() => toggle('bounds')}
              >
                <BoundingBox size={14} />
              </button>
            </Tooltip>
            <Menu
              align="end"
              trigger={
                <button type="button" aria-label="Display options">
                  <Eye size={14} />
                </button>
              }
              items={[
                {
                  label: `${display.edges ? 'Hide' : 'Show'} feature edges`,
                  shortcut: 'E',
                  onSelect: () => toggle('edges'),
                },
                {
                  label: `${display.wireframe ? 'Hide' : 'Show'} mesh wireframe`,
                  shortcut: 'W',
                  onSelect: () => toggle('wireframe'),
                },
                {
                  label: `${display.grid ? 'Hide' : 'Show'} grid and axes`,
                  shortcut: 'G',
                  onSelect: () => toggle('grid'),
                },
              ]}
            />
            <Tooltip label="Keyboard controls">
              <button
                type="button"
                aria-label="Keyboard controls"
                aria-expanded={keysOpen}
                onClick={() => setKeysOpen((open) => !open)}
              >
                <Keyboard size={14} />
              </button>
            </Tooltip>
          </div>

          {comparing && (
            <div className="island viewport-compare">
              <span className="viewport-key" aria-hidden="true" />
              <span>{props.compareLabel ?? 'Comparison'}</span>
              <Segmented
                label="Comparison layout"
                value={compareMode}
                onChange={setCompareMode}
                options={[
                  { value: 'overlay', label: 'Overlay' },
                  { value: 'side-by-side', label: 'Side by side' },
                ]}
              />
            </div>
          )}

          {section && mesh && (
            <div className="viewport-panel island">
              <div className="viewport-panel-row">
                <Segmented<Axis>
                  label="Section axis"
                  value={section.axis}
                  onChange={(axis) => setSection({ ...section, axis })}
                  options={AXES.map((axis) => ({ value: axis, label: axis.toUpperCase() }))}
                />
                <button
                  type="button"
                  className="viewport-panel-button"
                  aria-pressed={section.flipped}
                  onClick={() => setSection({ ...section, flipped: !section.flipped })}
                >
                  Flip
                </button>
              </div>
              <input
                type="range"
                aria-label={`Section position along ${section.axis.toUpperCase()}`}
                aria-valuetext={sectionAt !== null ? formatLength(sectionAt, modelUnit) : undefined}
                min={0}
                max={1}
                step={0.002}
                value={section.fraction}
                onChange={(e) => setSection({ ...section, fraction: Number(e.target.value) })}
              />
              <span className="viewport-panel-read num">
                {section.axis.toUpperCase()} ={' '}
                {sectionAt !== null ? formatLength(sectionAt, modelUnit) : '—'} · showing the{' '}
                {section.flipped ? 'high' : 'low'} side
              </span>
            </div>
          )}

          {measuring && (
            <div className="viewport-panel island" role="status">
              {measured ? (
                <>
                  <span className="viewport-panel-value num">
                    {formatLength(measured.distance, modelUnit)}
                  </span>
                  <span className="viewport-panel-read num">
                    {AXES.map(
                      (axis, i) => `Δ${axis.toUpperCase()} ${measured.delta[i]!.toFixed(2)}`,
                    ).join(' · ')}{' '}
                    {modelUnit}
                  </span>
                  {points.map((p, i) => (
                    <span key={i} className="viewport-panel-read num">
                      {i + 1} · {p.onVertex ? 'mesh corner' : 'point on a face'} · (
                      {coordinates(p.point)})
                    </span>
                  ))}
                </>
              ) : (
                <span className="viewport-panel-read">
                  {points.length
                    ? `First point (${coordinates(points[0]!.point)}), ${points[0]!.onVertex ? 'a mesh corner' : 'on a face'}. Click the second.`
                    : 'Click two points on the part. A click near a mesh corner snaps to it.'}
                </span>
              )}
              <div className="viewport-panel-row">
                <button
                  type="button"
                  className="viewport-panel-button"
                  disabled={!points.length}
                  onClick={() => setPoints([])}
                >
                  Clear
                </button>
                <button type="button" className="viewport-panel-button" onClick={toggleMeasure}>
                  Done
                </button>
              </div>
            </div>
          )}

          {keysOpen && (
            <div className="viewport-panel island viewport-keys">
              <dl>
                <dt>
                  <Kbd>←</Kbd> <Kbd>→</Kbd> <Kbd>↑</Kbd> <Kbd>↓</Kbd>
                </dt>
                <dd>Orbit</dd>
                <dt>
                  <Kbd>⇧</Kbd> + arrows
                </dt>
                <dd>Pan</dd>
                <dt>
                  <Kbd>+</Kbd> <Kbd>−</Kbd>
                </dt>
                <dd>Zoom</dd>
                <dt>
                  <Kbd>1</Kbd>–<Kbd>7</Kbd>
                </dt>
                <dd>Front, back, left, right, top, bottom, isometric</dd>
                <dt>
                  <Kbd>F</Kbd> <Kbd>0</Kbd> <Kbd>O</Kbd>
                </dt>
                <dd>Fit, reset, projection</dd>
                <dt>
                  <Kbd>S</Kbd> <Kbd>M</Kbd> <Kbd>B</Kbd>
                </dt>
                <dd>Section, measure, envelope</dd>
                <dt>
                  <Kbd>E</Kbd> <Kbd>W</Kbd> <Kbd>G</Kbd>
                </dt>
                <dd>Edges, wireframe, grid</dd>
              </dl>
              <p>
                Click the model first. Scroll zooms once it has focus or the pointer rests on it;
                drag orbits, right-drag pans. Measuring needs a pointer.
              </p>
            </div>
          )}
        </div>
      )}

      {zoomHint && (
        <p className="viewport-hint" role="status">
          Click the model, or rest the pointer on it, to zoom with scroll.
        </p>
      )}

      {mesh && (
        <div className="viewport-dims mono">
          <span>{formatEnvelope(mesh.bounds, modelUnit)}</span>
          {display.bounds && (
            <span className="viewport-dims-sub">
              min ({coordinates(mesh.bounds.min)}) · max ({coordinates(mesh.bounds.max)})
            </span>
          )}
          <span className="viewport-dims-sub">
            {mesh.triangles.toLocaleString()} triangles
            {grid !== null ? ` · grid ${grid} ${modelUnit}` : ''}
          </span>
        </div>
      )}

      {mesh && (
        <svg
          className="viewport-triad"
          viewBox="0 0 56 56"
          role="img"
          aria-label="Model axes as seen from the current view"
        >
          {AXES.map((axis, i) => (
            <g
              key={axis}
              ref={(element) => {
                axes.current[i] = element;
              }}
            >
              <line x1="28" y1="28" x2="28" y2="28" />
              <text x="28" y="28">
                {axis.toUpperCase()}
              </text>
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}
