import { threadOf, type Adjacency } from '../../lib/graph';
import {
  clampViewport,
  countOutside,
  detailAt,
  fitViewport,
  labelScale,
  reveal,
  zoomAt,
  ZOOM,
  type Viewport,
} from './fit';
import { bottom, clamp, rectsOverlap, type Rect } from './geometry';
import { groupNodeId, type FlowLayout, type LayoutNode } from './layout';
import { navModel, nextFocus, type Move, type NavModel } from './navigation';
import type { LayoutEdge } from './routing';

/** The parts of the map the controller writes to directly. */
export interface MapElements {
  root: HTMLElement;
  /** Holds every node and link; pan and zoom are one transform on it. */
  world: HTMLElement;
  labels: HTMLElement;
  grid: HTMLElement;
  /** Covers the band under the project header, so the map passes beneath it. */
  fade: HTMLElement;
}

export interface MapStatus {
  zoom: number;
  /** Nodes that are entirely off the canvas. */
  outside: number;
  /** The map does not fit at a readable size, so "fit all" would show more. */
  canFitAll: boolean;
  /** The thread follows keyboard focus. */
  threadPinned: boolean;
}

export interface MapCallbacks {
  open(id: string): void;
  toggleGroup(type: string): void;
  status(status: MapStatus): void;
  /** The node whose full title and state are spelled out below the map, or null for none. */
  peek(id: string | null): void;
  remember(patch: { viewport?: Viewport | null; focusId?: string | null }): void;
}

/** How long the pointer or focus rests on a node before it is spelled out below the map. */
const PEEK_DWELL_MS = 120;
/** How long after the last movement the map counts as at rest. */
const SETTLE_MS = 140;
const DRAG_SLOP = 4;
const GRID = 22;
/** How far the dot grid reaches past each edge of the canvas (`.map-grid` in flow.css); more than one cell at any zoom. */
const GRID_OVERSCAN = 48;
/** Room kept free of the map at the canvas edges: for the controls, and so nothing touches the frame. */
const INSET = { top: 4, right: 16, bottom: 56 };
const WHEEL_LINE = 16;
/** How far past the canvas the veil reaches, as a share of the canvas, so a pan never outruns it. */
const VEIL_MARGIN = 0.5;

const mod = (n: number, m: number) => ((n % m) + m) % m;

/**
 * Everything on the map that must not cost a render: pan and zoom, the hover thread, keyboard
 * movement and focus. It writes classes, attributes and one transform; React owns the structure.
 */
export class MapController {
  private layout: FlowLayout | null = null;
  private nav: NavModel | null = null;
  private adjacency: Adjacency = { up: new Map(), down: new Map() };
  private nodeEls = new Map<string, HTMLElement>();
  private edgeEls = new Map<string, Element>();
  private outgoing = new Map<string, LayoutEdge[]>();
  /** Per drawn link, the causal recorded links it stands for. */
  private recorded = new Map<string, [string, string][]>();
  private veil: HTMLElement | null = null;

  private viewport: Viewport;
  /** `fit` and `all` follow the canvas; `manual` is where the user left it. */
  private mode: 'fit' | 'all' | 'manual';
  private origin = { left: 0, top: 0 };
  private canvas = { w: 0, h: 0 };
  private region: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private floating: Rect[] = [];
  private head: HTMLElement | null = null;
  private obstructions: HTMLElement[] = [];
  private observer: ResizeObserver;

  private frame = 0;
  private settleTimer = 0;
  private glideTimer = 0;
  private peekTimer = 0;
  private moving = false;
  /** False until the first frame is on screen; nothing animates before then. */
  private shown = false;
  private detail = '';
  private scale = 0;
  private strokeZoom = 0;
  /** Where the dot grid was last drawn, so a gesture can slide it rather than redraw it. */
  private grid = { x: 0, y: 0, step: GRID };
  private edgeLayers: SVGElement[] = [];

  private hoverId: string | null = null;
  private focusId: string | null;
  private focusInside = false;
  private pinned = false;
  private threadOrigin: string | null = null;
  private lit: Element[] = [];
  private cameFrom = new Map<string, string>();
  private drag: { pointer: number; x: number; y: number; moved: boolean } | null = null;
  private suppressClick = false;
  private pendingFocusType: string | null = null;
  private restoreFocus: boolean;
  private pinch = 1;

  constructor(
    private els: MapElements,
    private callbacks: MapCallbacks,
    remembered: { viewport: Viewport | null; focusId: string | null },
  ) {
    this.viewport = remembered.viewport ?? { x: 0, y: 0, k: 1 };
    this.mode = remembered.viewport ? 'manual' : 'fit';
    this.focusId = remembered.focusId;
    this.restoreFocus = remembered.focusId !== null;
    this.observer = new ResizeObserver(() => this.resized());
    this.observer.observe(els.root);
    for (const [type, listener, options] of this.listeners)
      els.root.addEventListener(type, listener, options);
    requestAnimationFrame(() => (this.shown = true));
  }

  dispose() {
    this.observer.disconnect();
    for (const [type, listener, options] of this.listeners)
      this.els.root.removeEventListener(type, listener, options);
    cancelAnimationFrame(this.frame);
    clearTimeout(this.settleTimer);
    clearTimeout(this.glideTimer);
    clearTimeout(this.peekTimer);
  }

  /** Every listener lives on the map's root; nodes and links have none of their own. */
  private get listeners(): [string, EventListener, AddEventListenerOptions?][] {
    return [
      ['wheel', this.onWheel as EventListener, { passive: false }],
      ['gesturestart', this.onGestureStart],
      ['gesturechange', this.onGestureChange],
      ['pointerdown', this.onPointerDown as EventListener],
      ['pointermove', this.onPointerMove as EventListener],
      ['pointerup', this.onPointerUp as EventListener],
      ['pointercancel', this.onPointerUp as EventListener],
      ['pointerover', this.onPointerOver as EventListener],
      ['pointerout', this.onPointerOut as EventListener],
      ['pointerleave', this.onPointerLeave],
      ['click', this.onClick as EventListener, { capture: true }],
      ['keydown', this.onKeyDown as EventListener],
      ['focusin', this.onFocusIn as EventListener],
      ['focusout', this.onFocusOut as EventListener],
    ];
  }

  /* ---------------------------------------------------------------- */
  /* Structure                                                          */
  /* ---------------------------------------------------------------- */

  /** What floats over the canvas: the project header and any island the map must stay clear of. */
  setChrome(head: HTMLElement | null, obstructions: HTMLElement[]) {
    for (const el of [this.head, ...this.obstructions]) if (el) this.observer.unobserve(el);
    this.head = head;
    this.obstructions = obstructions;
    for (const el of [head, ...obstructions]) if (el) this.observer.observe(el);
    if (this.layout) this.resized();
  }

  /** Called once React has committed the nodes and links of a layout. */
  setLayout(layout: FlowLayout, adjacency: Adjacency, causalLinks: ReadonlySet<string>) {
    const first = !this.layout;
    this.layout = layout;
    this.adjacency = adjacency;
    this.nav = navModel(layout);
    this.nodeEls.clear();
    this.edgeEls.clear();
    for (const el of this.els.world.querySelectorAll<HTMLElement>('[data-node]'))
      this.nodeEls.set(el.dataset.node!, el);
    for (const el of this.els.world.querySelectorAll('[data-edge]'))
      this.edgeEls.set(el.getAttribute('data-edge')!, el);
    this.veil = this.els.world.querySelector<HTMLElement>('.map-veil');
    this.edgeLayers = [...this.els.world.querySelectorAll<SVGElement>('.map-edges')];
    this.strokeZoom = 0;
    this.outgoing.clear();
    this.recorded.clear();
    for (const edge of layout.edges) {
      const list = this.outgoing.get(edge.from);
      if (list) list.push(edge);
      else this.outgoing.set(edge.from, [edge]);
      this.recorded.set(
        edge.key,
        edge.links.filter((k) => causalLinks.has(k)).map((k) => k.split('>') as [string, string]),
      );
    }

    // The thread and the tab stop are re-established against the new nodes.
    if (this.hoverId && !layout.byId.has(this.hoverId)) this.hoverId = null;
    this.threadOrigin = null;
    this.lit = [];
    this.els.root.removeAttribute('data-threaded');
    for (const el of this.els.world.querySelectorAll('[data-thread], [data-lit]')) {
      el.removeAttribute('data-thread');
      el.removeAttribute('data-lit');
    }
    const pending = this.pendingFocusType;
    this.pendingFocusType = null;
    const target = pending
      ? (layout.byId.get(groupNodeId(pending)) ??
        layout.nodes.filter((n) => n.type === pending).sort((a, b) => a.row - b.row)[0])
      : undefined;
    if (!this.focusId || !layout.byId.has(this.focusId))
      this.focusId = layout.columns[0]?.nodes[0] ?? null;
    if (target) this.focusId = target.id;
    for (const [id, el] of this.nodeEls) el.tabIndex = id === this.focusId ? 0 : -1;

    this.measure();
    if (this.mode === 'manual')
      this.set(clampViewport(this.viewport, layout.bounds, this.region), false);
    else this.applyFit(!first);

    if (target) this.nodeEls.get(target.id)?.focus({ preventScroll: true });
    else if (first && this.restoreFocus && document.activeElement === document.body)
      this.nodeEls.get(this.focusId ?? '')?.focus({ preventScroll: true });
    this.restoreFocus = false;
    this.updateThread();
    this.emitStatus();
  }

  /* ---------------------------------------------------------------- */
  /* Viewport                                                           */
  /* ---------------------------------------------------------------- */

  /** Reads the canvas, the header band and the floating islands. Runs on resize, never on a pointer move. */
  private measure() {
    const { root, fade } = this.els;
    const box = root.getBoundingClientRect();
    this.origin = { left: box.left, top: box.top };
    this.canvas = { w: box.width, h: box.height };
    let top = 0;
    let left = INSET.right;
    if (this.head) {
      const head = this.head.getBoundingClientRect();
      top = Math.max(0, head.bottom - box.top);
      const lead = this.head.firstElementChild?.getBoundingClientRect();
      if (lead) left = Math.max(0, lead.left - box.left);
    }
    fade.style.height = `${top}px`;
    this.region = {
      x: left,
      y: top + INSET.top,
      w: Math.max(0, box.width - left - INSET.right),
      h: Math.max(0, box.height - top - INSET.top - INSET.bottom),
    };
    this.floating = this.obstructions.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height };
    });
  }

  private resized() {
    if (!this.layout) return;
    this.measure();
    if (this.mode === 'manual')
      this.set(clampViewport(this.viewport, this.layout.bounds, this.region), false);
    else this.applyFit(false);
    this.emitStatus();
  }

  private limits(mode: 'fit' | 'all') {
    return { min: mode === 'all' ? ZOOM.min : ZOOM.readable, max: ZOOM.fit };
  }

  private applyFit(animate: boolean) {
    if (!this.layout || this.mode === 'manual') return;
    const fit = fitViewport(this.layout.bounds, this.region, this.floating, this.limits(this.mode));
    this.set(fit.viewport, animate);
  }

  /** Fits the map: at a readable size, or all of it however small that makes it. */
  fit(mode: 'fit' | 'all') {
    this.mode = mode;
    this.applyFit(true);
  }

  zoomBy(factor: number) {
    if (!this.layout) return;
    this.mode = 'manual';
    const next = zoomAt(
      this.viewport,
      this.viewport.k * factor,
      this.region.x + this.region.w / 2,
      this.region.y + this.region.h / 2,
    );
    this.set(clampViewport(next, this.layout.bounds, this.region), true);
  }

  /** Moves the map in one step, gliding there when asked and already on screen. */
  private set(viewport: Viewport, animate: boolean) {
    // Whole pixels, so borders and text are drawn sharp.
    const next = { k: viewport.k, x: Math.round(viewport.x), y: Math.round(viewport.y) };
    const same =
      next.x === this.viewport.x && next.y === this.viewport.y && next.k === this.viewport.k;
    this.viewport = next;
    const { root } = this.els;
    clearTimeout(this.glideTimer);
    if (animate && this.shown && !same) {
      root.classList.add('gliding');
      const glide = parseFloat(getComputedStyle(root).getPropertyValue('--t-slow')) || 0;
      this.glideTimer = window.setTimeout(() => root.classList.remove('gliding'), glide + 60);
    } else root.classList.remove('gliding');
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.paint();
    this.refine();
    this.settleSoon();
  }

  /** Follows a gesture: at most one write per frame, and the layer is promoted while it lasts. */
  private move(viewport: Viewport) {
    if (!this.layout) return;
    this.mode = 'manual';
    this.viewport = clampViewport(viewport, this.layout.bounds, this.region);
    const { root } = this.els;
    if (!this.moving) {
      this.moving = true;
      root.classList.remove('gliding');
      root.classList.add('moving');
    }
    if (!this.frame)
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.paint();
      });
    this.settleSoon();
  }

  /**
   * The per-frame work: one transform on the map, and one on the dot grid, which slides by less
   * than one cell so its pattern lines up. The grid is redrawn to the new zoom at rest.
   */
  private paint() {
    const { x, y, k } = this.viewport;
    this.els.world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    const { step } = this.grid;
    this.els.grid.style.transform = `translate(${mod(x - this.grid.x, step)}px, ${mod(y - this.grid.y, step)}px)`;
    if (this.threadOrigin) this.placeVeil();
  }

  /**
   * What depends on the zoom but not on every frame of it: how much detail nodes carry, how
   * large the headers are drawn, and the width of links. Done when the map comes to rest, so a
   * gesture itself stays a transform.
   */
  private refine() {
    const { x, y, k } = this.viewport;
    const step = GRID * k * (k < 0.3 ? 4 : k < 0.6 ? 2 : 1);
    const { grid } = this.els;
    grid.style.backgroundSize = `${step}px ${step}px`;
    grid.style.backgroundPosition = `${mod(x + GRID_OVERSCAN, step)}px ${mod(y + GRID_OVERSCAN, step)}px`;
    grid.style.transform = '';
    this.grid = { x, y, step };
    const detail = detailAt(k);
    if (detail !== this.detail) this.els.root.dataset.detail = this.detail = detail;
    const scale = Math.round(labelScale(k) * 100) / 100;
    if (scale !== this.scale) {
      this.scale = scale;
      this.els.labels.style.setProperty('--map-label-scale', String(scale));
    }
    if (k !== this.strokeZoom) {
      this.strokeZoom = k;
      for (const layer of this.edgeLayers) layer.style.setProperty('--map-inverse', String(1 / k));
    }
  }

  /** Stretches the veil over the canvas, in map units, so it dims whatever is in view. */
  private placeVeil() {
    if (!this.veil) return;
    const { x, y, k } = this.viewport;
    const { w, h } = this.canvas;
    const left = (-x - w * VEIL_MARGIN) / k;
    const top = (-y - h * VEIL_MARGIN) / k;
    const span = (1 + 2 * VEIL_MARGIN) / k;
    this.veil.style.transform = `translate(${left}px, ${top}px) scale(${w * span}, ${h * span})`;
  }

  private settleSoon() {
    clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => this.settle(), SETTLE_MS);
  }

  /** At rest the map sits on whole pixels and its layer is released, so text is drawn sharp. */
  private settle() {
    if (this.moving) {
      this.moving = false;
      this.els.root.classList.remove('moving');
      this.viewport = {
        ...this.viewport,
        x: Math.round(this.viewport.x),
        y: Math.round(this.viewport.y),
      };
      this.paint();
      this.refine();
    }
    this.callbacks.remember({ viewport: this.mode === 'manual' ? this.viewport : null });
    this.emitStatus();
  }

  private emitStatus() {
    if (!this.layout) return;
    const visible = { x: 0, y: this.region.y, w: this.canvas.w, h: this.canvas.h - this.region.y };
    this.callbacks.status({
      zoom: this.viewport.k,
      outside: countOutside(this.viewport, this.layout.nodes, visible),
      canFitAll: fitViewport(this.layout.bounds, this.region, this.floating, this.limits('fit'))
        .overflow,
      threadPinned: this.pinned,
    });
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? WHEEL_LINE : e.deltaMode === 2 ? this.region.h : 1;
    if (e.ctrlKey || e.metaKey) {
      // One notch of a wheel is a far larger step than one frame of a pinch; bound it.
      const k = this.viewport.k * Math.exp(-clamp(e.deltaY * unit, -50, 50) * 0.01);
      this.move(
        zoomAt(this.viewport, k, e.clientX - this.origin.left, e.clientY - this.origin.top),
      );
    } else {
      this.move({
        ...this.viewport,
        x: this.viewport.x - e.deltaX * unit,
        y: this.viewport.y - e.deltaY * unit,
      });
    }
  };

  // WebKit reports a trackpad pinch as gesture events rather than as a wheel with a modifier.
  private onGestureStart = (e: Event) => {
    e.preventDefault();
    this.pinch = this.viewport.k;
  };

  private onGestureChange = (e: Event) => {
    e.preventDefault();
    const gesture = e as Event & { scale: number; clientX: number; clientY: number };
    this.move(
      zoomAt(
        this.viewport,
        this.pinch * gesture.scale,
        gesture.clientX - this.origin.left,
        gesture.clientY - this.origin.top,
      ),
    );
  };

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest('[data-map-ui]')) return;
    this.drag = { pointer: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  };

  private onPointerMove = (e: PointerEvent) => {
    const drag = this.drag;
    if (!drag || drag.pointer !== e.pointerId) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_SLOP) return;
      drag.moved = true;
      this.els.root.setPointerCapture(e.pointerId);
      this.els.root.classList.add('panning');
      this.hover(null);
    }
    this.move({
      ...this.viewport,
      x: this.viewport.x + e.clientX - drag.x,
      y: this.viewport.y + e.clientY - drag.y,
    });
    drag.x = e.clientX;
    drag.y = e.clientY;
  };

  private onPointerUp = (e: PointerEvent) => {
    const drag = this.drag;
    if (!drag || drag.pointer !== e.pointerId) return;
    this.drag = null;
    if (!drag.moved) return;
    this.els.root.classList.remove('panning');
    if (this.els.root.hasPointerCapture(e.pointerId))
      this.els.root.releasePointerCapture(e.pointerId);
    // The click that ends a drag is not a click on whatever was under the pointer.
    this.suppressClick = true;
    window.setTimeout(() => (this.suppressClick = false));
  };

  /* ---------------------------------------------------------------- */
  /* Thread and peek                                                    */
  /* ---------------------------------------------------------------- */

  private nodeAt(target: EventTarget | null): string | null {
    const el = (target as Element | null)?.closest?.('[data-node]');
    return el?.getAttribute('data-node') ?? null;
  }

  private onPointerOver = (e: PointerEvent) => {
    if (this.drag?.moved || e.pointerType === 'touch') return;
    this.hover(this.nodeAt(e.target));
  };

  private onPointerOut = (e: PointerEvent) => {
    if (!this.nodeAt(e.relatedTarget)) this.hover(null);
  };

  private onPointerLeave = () => this.hover(null);

  private hover(id: string | null) {
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.updateThread();
    this.peekSoon();
  }

  /** Lights the thread through the hovered node, or through the focused one while pinned. */
  private updateThread() {
    const { layout } = this;
    if (!layout) return;
    const origin = this.hoverId ?? (this.pinned && this.focusInside ? this.focusId : null);
    if (origin === this.threadOrigin) return;
    for (const el of this.lit) {
      el.removeAttribute('data-thread');
      el.removeAttribute('data-lit');
    }
    this.lit = [];
    const node = origin ? layout.byId.get(origin) : undefined;
    this.threadOrigin = node ? origin : null;
    if (!node) {
      this.els.root.removeAttribute('data-threaded');
      return;
    }
    const objects = new Set<string>();
    for (const member of node.members)
      for (const id of threadOf(member, this.adjacency)) objects.add(id);
    const nodes = new Set<string>([node.id]);
    for (const id of objects) {
      const drawn = layout.nodeOf.get(id);
      if (drawn) nodes.add(drawn);
    }
    for (const id of nodes) {
      const el = this.nodeEls.get(id);
      if (el) {
        el.setAttribute('data-thread', id === node.id ? 'origin' : 'lit');
        this.lit.push(el);
      }
      for (const edge of this.outgoing.get(id) ?? []) {
        if (!nodes.has(edge.to)) continue;
        const carries = this.recorded
          .get(edge.key)
          ?.some(([from, to]) => objects.has(from) && objects.has(to));
        const el = carries ? this.edgeEls.get(edge.key) : undefined;
        if (el) {
          el.setAttribute('data-lit', '');
          this.lit.push(el);
        }
      }
    }
    this.placeVeil();
    this.els.root.setAttribute('data-threaded', '');
  }

  private peekSoon() {
    clearTimeout(this.peekTimer);
    const keyboard =
      this.focusInside && this.focusId && this.nodeEls.get(this.focusId)?.matches(':focus-visible');
    const id = this.hoverId ?? (keyboard ? this.focusId : null);
    this.peekTimer = window.setTimeout(() => this.callbacks.peek(id), PEEK_DWELL_MS);
  }

  /** Runs the one-off animation of a change travelling along the links it made out of date. */
  playImpact() {
    const { root, world } = this.els;
    root.classList.add('impact-run');
    const running = world.getAnimations({ subtree: true });
    void Promise.allSettled(running.map((a) => a.finished)).then(() =>
      root.classList.remove('impact-run'),
    );
  }

  /* ---------------------------------------------------------------- */
  /* Activation, keyboard and focus                                     */
  /* ---------------------------------------------------------------- */

  private onClick = (e: MouseEvent) => {
    if (this.suppressClick) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const target = e.target as Element;
    const group = target.closest('[data-group]')?.getAttribute('data-group');
    if (group) return this.callbacks.toggleGroup(group);
    const node = this.layout?.byId.get(this.nodeAt(target) ?? '');
    if (!node) return;
    if (node.kind === 'group') {
      // Opened from the keyboard, focus lands on the group's first object.
      if (e.detail === 0) this.pendingFocusType = node.type;
      this.callbacks.toggleGroup(node.type);
    } else this.callbacks.open(node.id);
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const id = this.nodeAt(e.target);
    if (!id) return;
    const moves: Record<string, Move> = {
      ArrowLeft: 'left',
      ArrowRight: 'right',
      ArrowUp: 'up',
      ArrowDown: 'down',
      Home: 'first',
      End: 'last',
    };
    const move = moves[e.key];
    if (move) this.step(id, move);
    else if (e.key === '+' || e.key === '=') this.zoomBy(ZOOM.step);
    else if (e.key === '-' || e.key === '_') this.zoomBy(1 / ZOOM.step);
    else if (e.code === 'Digit0' || e.key === '0') this.fit(e.shiftKey ? 'all' : 'fit');
    else if (e.key === 't' || e.key === 'T') {
      this.pinned = !this.pinned;
      this.updateThread();
      this.emitStatus();
    } else if (e.key === 'c' || e.key === 'C') {
      const node = this.layout?.byId.get(id);
      if (!node) return;
      this.pendingFocusType = node.type;
      this.callbacks.toggleGroup(node.type);
    } else if (e.key === 'Escape' && this.pinned) {
      this.pinned = false;
      this.updateThread();
      this.emitStatus();
      e.stopPropagation();
    } else return;
    e.preventDefault();
  };

  private step(from: string, move: Move) {
    if (!this.nav) return;
    const next = nextFocus(this.nav, from, move, this.cameFrom.get(from) ?? null);
    if (!next) return;
    if (move === 'left' || move === 'right') this.cameFrom.set(next, from);
    this.nodeEls.get(next)?.focus({ preventScroll: true });
  }

  private onFocusIn = (e: FocusEvent) => {
    const id = this.nodeAt(e.target);
    if (!id) return;
    this.focusInside = true;
    if (id !== this.focusId) {
      const previous = this.focusId ? this.nodeEls.get(this.focusId) : undefined;
      if (previous) previous.tabIndex = -1;
      this.focusId = id;
      this.callbacks.remember({ focusId: id });
    }
    const el = this.nodeEls.get(id);
    if (el) el.tabIndex = 0;
    if (el?.matches(':focus-visible') && !this.restoreFocus) this.bringIntoView(id);
    this.updateThread();
    if (!this.restoreFocus) this.peekSoon();
  };

  private onFocusOut = (e: FocusEvent) => {
    if (this.nodeAt(e.relatedTarget)) return;
    this.focusInside = false;
    this.updateThread();
    this.peekSoon();
  };

  /** Pans just far enough that the focused node is on the canvas and clear of any island. */
  private bringIntoView(id: string) {
    const node: LayoutNode | undefined = this.layout?.byId.get(id);
    if (!this.layout || !node) return;
    let next = reveal(this.viewport, node, this.region);
    for (const island of this.floating) {
      const screen = {
        x: node.x * next.k + next.x,
        y: node.y * next.k + next.y,
        w: node.w * next.k,
        h: node.h * next.k,
      };
      if (rectsOverlap(screen, island))
        next = { ...next, y: next.y + bottom(island) + 12 - screen.y };
    }
    if (next.x === this.viewport.x && next.y === this.viewport.y) return;
    this.mode = 'manual';
    this.set(clampViewport(next, this.layout.bounds, this.region), true);
  }
}
