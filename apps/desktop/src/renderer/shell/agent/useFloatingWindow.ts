import React, { useCallback, useLayoutEffect, useState } from 'react';
import { useAgentUi } from './agent-store';
import {
  bottomReserve,
  clampDock,
  clampRect,
  keyResize,
  KEY_STEP,
  KEY_STEP_LARGE,
  unplaced,
  type Bounds,
  type Box,
  type Rect,
} from './window-geometry';

const INTERACTIVE = 'button, a, input, select, textarea, [role="menuitem"]';

/** Follow a pointer drag from `e` and report each position, then the last one. */
function track(
  e: React.PointerEvent,
  onMove: (dx: number, dy: number) => void,
  onEnd: (dx: number, dy: number) => void,
) {
  e.preventDefault();
  const x0 = e.clientX;
  const y0 = e.clientY;
  let last = { dx: 0, dy: 0 };
  const move = (ev: PointerEvent) => {
    last = { dx: ev.clientX - x0, dy: ev.clientY - y0 };
    onMove(last.dx, last.dy);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    onEnd(last.dx, last.dy);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

const sameBoxes = (a: Box[], b: Box[]) =>
  a.length === b.length &&
  a.every(
    (x, i) =>
      x.left === b[i]!.left &&
      x.right === b[i]!.right &&
      x.top === b[i]!.top &&
      x.bottom === b[i]!.bottom,
  );

/** Controls in the area that the window must not cover by default, measured from its corner. */
function avoidedBoxes(
  area: HTMLElement,
  surface: HTMLElement,
): { elements: Element[]; boxes: Box[] } {
  const origin = area.getBoundingClientRect();
  const elements = [...area.querySelectorAll('[data-toast-avoid]')].filter(
    (el) => !surface.contains(el),
  );
  const boxes = elements.map((el) => {
    const r = el.getBoundingClientRect();
    return {
      left: r.left - origin.left,
      right: r.right - origin.left,
      top: r.top - origin.top,
      bottom: r.bottom - origin.top,
    };
  });
  return { elements, boxes };
}

/**
 * Geometry of the floating agent window: measured against the area it floats over, kept inside
 * it and within its allowed share, moved by its header, resized from its corner by pointer or
 * keyboard, and remembered when a gesture ends. Until the person places it, it sits above the
 * controls pinned along the bottom of the area (the flow map's legend and peek strip).
 */
export function useFloatingWindow(root: React.RefObject<HTMLElement | null>) {
  const prefs = useAgentUi((s) => s.window);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [avoid, setAvoid] = useState<Box[]>([]);
  const [shownHeight, setShownHeight] = useState(0);
  const [dragRect, setDragRect] = useState<Rect | null>(null);
  const [dragDock, setDragDock] = useState<number | null>(null);

  useLayoutEffect(() => {
    const surface = root.current;
    const area = surface?.parentElement;
    if (!surface || !area) return;
    let frame = 0;
    const observed = new Set<Element>();
    const measure = () => {
      frame = 0;
      const width = area.clientWidth;
      const height = area.clientHeight;
      setBounds((b) => (b && b.width === width && b.height === height ? b : { width, height }));
      const { elements, boxes } = avoidedBoxes(area, surface);
      for (const el of elements)
        if (!observed.has(el)) {
          observed.add(el);
          sizes.observe(el);
        }
      setAvoid((before) => (sameBoxes(before, boxes) ? before : boxes));
      setShownHeight(surface.offsetHeight);
    };
    const soon = () => {
      frame ||= requestAnimationFrame(measure);
    };
    const sizes = new ResizeObserver(soon);
    sizes.observe(area);
    sizes.observe(surface);
    // Pinned controls come and go with the view; the terminal's own redraws are not of interest.
    const tree = new MutationObserver((records) => {
      if (records.some((r) => !surface.contains(r.target))) soon();
    });
    tree.observe(area, { childList: true, subtree: true });
    measure();
    return () => {
      cancelAnimationFrame(frame);
      sizes.disconnect();
      tree.disconnect();
    };
  }, [root]);

  const placed = dragRect ?? prefs.rect;
  const fitted = bounds ? clampRect(placed, bounds) : null;
  const reserve =
    bounds && fitted && unplaced(placed)
      ? bottomReserve(
          bounds,
          { x: fitted.x, w: fitted.w, height: prefs.collapsed ? shownHeight : fitted.h },
          avoid,
        )
      : 0;
  const rect = bounds && fitted ? (reserve ? clampRect(placed, bounds, reserve) : fitted) : null;
  const dockWidth = bounds ? clampDock(dragDock ?? prefs.dockWidth, bounds) : prefs.dockWidth;

  const save = useCallback((next: Rect) => useAgentUi.getState().setWindow({ rect: next }), []);

  const onHeaderPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!rect || !bounds || prefs.docked || e.button !== 0) return;
      if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
      const from = rect;
      const at = (dx: number, dy: number) =>
        clampRect({ ...from, x: from.x + dx, y: from.y + dy }, bounds);
      track(
        e,
        (dx, dy) => setDragRect(at(dx, dy)),
        (dx, dy) => {
          setDragRect(null);
          save(at(dx, dy));
        },
      );
    },
    [rect, bounds, prefs.docked, save],
  );

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!rect || !bounds || e.button !== 0) return;
      const from = rect;
      const bottom = from.y + from.h;
      const at = (dx: number, dy: number) => {
        const next = clampRect({ ...from, w: from.w + dx, h: from.h - dy }, bounds);
        return clampRect({ ...next, y: bottom - next.h }, bounds);
      };
      track(
        e,
        (dx, dy) => setDragRect(at(dx, dy)),
        (dx, dy) => {
          setDragRect(null);
          save(at(dx, dy));
        },
      );
    },
    [rect, bounds, save],
  );

  const onResizeKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (!rect || !bounds) return;
      const next = keyResize(rect, e.key, e.shiftKey, bounds);
      if (!next) return;
      e.preventDefault();
      e.stopPropagation();
      save(next);
    },
    [rect, bounds, save],
  );

  const onDockPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!bounds || e.button !== 0) return;
      const from = dockWidth;
      track(
        e,
        (dx) => setDragDock(clampDock(from - dx, bounds)),
        (dx) => {
          setDragDock(null);
          useAgentUi.getState().setWindow({ dockWidth: clampDock(from - dx, bounds) });
        },
      );
    },
    [bounds, dockWidth],
  );

  const onDockKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (!bounds || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      e.stopPropagation();
      const step = (e.shiftKey ? KEY_STEP_LARGE : KEY_STEP) * (e.key === 'ArrowLeft' ? 1 : -1);
      useAgentUi.getState().setWindow({ dockWidth: clampDock(dockWidth + step, bounds) });
    },
    [bounds, dockWidth],
  );

  return {
    prefs,
    bounds,
    rect,
    dockWidth,
    dragging: dragRect !== null || dragDock !== null,
    onHeaderPointerDown,
    onResizePointerDown,
    onResizeKey,
    onDockPointerDown,
    onDockKey,
  };
}
