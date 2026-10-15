/**
 * Layers are what sits above the workspace and owns the keyboard while it is open: menus,
 * dialogs, the settings sheet, the omnibar, the unsaved-work prompt. A shortcut that belongs to
 * the workspace must not fire while one is open, and Escape closes the topmost one first.
 *
 *   if (isLayerOpen()) return;          // in a view's own keydown handler
 *   const close = openLayer('popover'); // for a layer that is not a Radix menu or dialog
 */
import { useStore } from '../store';

export type LayerKind = 'menu' | 'prompt' | 'omnibar' | 'settings' | 'dialog' | 'custom';

const custom = new Set<string>();

/** Registers a layer the DOM checks below cannot see. Call the returned function on close. */
export function openLayer(id: string): () => void {
  custom.add(id);
  return () => {
    custom.delete(id);
  };
}

/**
 * Radix keeps a closing menu or dialog in the document for its exit animation, marked
 * `data-state="closed"`. It no longer holds the keyboard.
 */
const stillOpen = (el: Element | null | undefined) =>
  !!el && el.getAttribute?.('data-state') !== 'closed';

const found = (root: ParentNode | null, selectors: string) =>
  root ? [...root.querySelectorAll(selectors)] : [];

/**
 * The layer that would take the next Escape, or null when the workspace has the keyboard.
 * A menu opened from inside a dialog or sheet sits above it, so menus are checked first.
 */
export function topmostLayer(
  root: ParentNode | null = globalThis.document ?? null,
): LayerKind | null {
  // Radix renders menus, selects and popovers in a popper wrapper around their content; tooltips
  // use one too but never hold the keyboard.
  const poppers = found(root, '[data-radix-popper-content-wrapper]').filter(
    (p) => !p.querySelector('[role="tooltip"]'),
  );
  if (
    found(root, '[role="menu"]').some(stillOpen) ||
    poppers.some((p) => stillOpen(p.firstElementChild ?? p))
  )
    return 'menu';
  const s = useStore.getState();
  if (s.leavePrompt) return 'prompt';
  if (s.omniOpen) return 'omnibar';
  if (s.settingsOpen) return 'settings';
  if (found(root, '[role="dialog"], [role="alertdialog"]').some(stillOpen)) return 'dialog';
  return custom.size ? 'custom' : null;
}

export function isLayerOpen(root?: ParentNode | null): boolean {
  return topmostLayer(root) !== null;
}

/** Where keyboard focus is, as far as shortcuts are concerned. */
export type FocusKind = 'field' | 'terminal' | 'agent-window' | 'workspace';

const NOT_TEXT = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

export function focusKind(target: EventTarget | null): FocusKind {
  const el = target as (HTMLElement & { type?: string }) | null;
  if (!el || typeof el.closest !== 'function') return 'workspace';
  if (el.closest('.xterm')) return 'terminal';
  const tag = el.tagName;
  if (
    (tag === 'INPUT' && !NOT_TEXT.has((el.type ?? '').toLowerCase())) ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable
  )
    return 'field';
  if (el.closest('.agent-surface.mode-window')) return 'agent-window';
  return 'workspace';
}
