import { afterEach, describe, expect, it } from 'vitest';
import { useStore } from '../../apps/desktop/src/renderer/store';
import {
  focusKind,
  isLayerOpen,
  openLayer,
  topmostLayer,
} from '../../apps/desktop/src/renderer/lib/layers';
import {
  resolveShortcut,
  type KeyInput,
  type ShortcutContext,
} from '../../apps/desktop/src/renderer/lib/shortcuts';

/**
 * A DOM root that answers `querySelector(All)` from a list of present selectors. `state` is the
 * element's `data-state` (for a popper wrapper, its content's).
 */
function root(
  present: { selector: string; tooltip?: boolean; state?: 'open' | 'closed' }[] = [],
): ParentNode {
  const matches = (query: string) =>
    present.filter((p) => query.split(',').some((q) => q.trim() === p.selector));
  const element = (p: (typeof present)[number]) => {
    const attrs = (name: string) => (name === 'data-state' ? (p.state ?? null) : null);
    const content = { getAttribute: attrs } as unknown as Element;
    return {
      getAttribute: p.selector === POPPER ? () => null : attrs,
      firstElementChild: p.selector === POPPER ? content : null,
      querySelector: () => (p.tooltip ? ({} as Element) : null),
    } as unknown as Element;
  };
  return {
    querySelector: (q: string) => (matches(q).length ? element(matches(q)[0]!) : null),
    querySelectorAll: (q: string) => matches(q).map(element),
  } as unknown as ParentNode;
}

const POPPER = '[data-radix-popper-content-wrapper]';
const initial = useStore.getState();
afterEach(() => useStore.setState(initial));

describe('layers', () => {
  it('finds no layer over a plain workspace', () => {
    expect(topmostLayer(root())).toBeNull();
    expect(isLayerOpen(root())).toBe(false);
  });

  it('ignores tooltips but sees menus, popovers and dialogs', () => {
    expect(topmostLayer(root([{ selector: POPPER, tooltip: true }]))).toBeNull();
    expect(topmostLayer(root([{ selector: POPPER }]))).toBe('menu');
    expect(topmostLayer(root([{ selector: '[role="menu"]' }]))).toBe('menu');
    expect(topmostLayer(root([{ selector: '[role="dialog"]' }]))).toBe('dialog');
  });

  it('lets go of a menu or dialog that is closing, so shortcuts work during its exit animation', () => {
    for (const selector of ['[role="dialog"]', '[role="alertdialog"]', '[role="menu"]', POPPER]) {
      expect(topmostLayer(root([{ selector, state: 'closed' }])), selector).toBeNull();
      expect(topmostLayer(root([{ selector, state: 'open' }])), selector).not.toBeNull();
    }
    // A dialog closing over one still open leaves the open one in charge.
    expect(
      topmostLayer(
        root([
          { selector: '[role="dialog"]', state: 'closed' },
          { selector: '[role="alertdialog"]', state: 'open' },
        ]),
      ),
    ).toBe('dialog');
  });

  it('names the omnibar, the settings sheet and the unsaved-work prompt from the store', () => {
    useStore.setState({ omniOpen: true });
    expect(topmostLayer(root([{ selector: '[role="dialog"]' }]))).toBe('omnibar');
    useStore.setState({ omniOpen: false, settingsOpen: true });
    expect(topmostLayer(root())).toBe('settings');
    useStore.setState({ leavePrompt: { action: 'continue', labels: ['x'] } });
    expect(topmostLayer(root())).toBe('prompt');
    // A menu opened inside the sheet sits above it.
    expect(topmostLayer(root([{ selector: POPPER }]))).toBe('menu');
  });

  it('counts layers a surface registers itself', () => {
    const close = openLayer('popover');
    expect(topmostLayer(root())).toBe('custom');
    close();
    expect(topmostLayer(root())).toBeNull();
  });

  it('classifies focus by what typing would do there', () => {
    const el = (tagName: string, opts: { type?: string; in?: string[] } = {}) =>
      ({
        tagName,
        type: opts.type,
        isContentEditable: false,
        closest: (q: string) => ((opts.in ?? []).includes(q) ? {} : null),
      }) as unknown as EventTarget;
    expect(focusKind(el('INPUT', { type: 'text' }))).toBe('field');
    expect(focusKind(el('TEXTAREA'))).toBe('field');
    expect(focusKind(el('INPUT', { type: 'checkbox' }))).toBe('workspace');
    expect(focusKind(el('TEXTAREA', { in: ['.xterm'] }))).toBe('terminal');
    expect(focusKind(el('BUTTON', { in: ['.agent-surface.mode-window'] }))).toBe('agent-window');
    expect(focusKind(el('BUTTON'))).toBe('workspace');
    expect(focusKind(null)).toBe('workspace');
  });
});

const key = (k: string, extra: Partial<KeyInput> = {}): KeyInput => ({
  key: k,
  mod: false,
  shift: false,
  alt: false,
  repeat: false,
  composing: false,
  defaultPrevented: false,
  ...extra,
});
const ctx = (extra: Partial<ShortcutContext> = {}): ShortcutContext => ({
  layer: null,
  focus: 'workspace',
  hasProject: true,
  view: 'object',
  lensFor: (d) => (d === '2' ? 'parts' : undefined),
  ...extra,
});

describe('shortcuts', () => {
  it('does one thing per Escape: nothing more once a layer handled it', () => {
    expect(resolveShortcut(key('Escape'), ctx())).toEqual({ kind: 'zoom-out' });
    expect(resolveShortcut(key('Escape', { defaultPrevented: true }), ctx())).toBeNull();
    for (const layer of ['menu', 'dialog', 'settings', 'omnibar', 'prompt', 'custom'] as const)
      expect(resolveShortcut(key('Escape'), ctx({ layer }))).toBeNull();
  });

  it('leaves Escape to fields and the terminal, and hands focus back from the agent window', () => {
    expect(resolveShortcut(key('Escape'), ctx({ focus: 'field' }))).toBeNull();
    expect(resolveShortcut(key('Escape'), ctx({ focus: 'terminal' }))).toBeNull();
    expect(resolveShortcut(key('Escape'), ctx({ focus: 'agent-window' }))).toEqual({
      kind: 'release-agent-window',
    });
  });

  it('keeps workspace shortcuts away from an open layer, except the layer’s own', () => {
    const mod = { mod: true };
    expect(resolveShortcut(key('2', mod), ctx({ layer: 'omnibar' }))).toBeNull();
    expect(resolveShortcut(key('[', mod), ctx({ layer: 'settings' }))).toBeNull();
    expect(resolveShortcut(key('k', mod), ctx({ layer: 'omnibar' }))).toEqual({ kind: 'omnibar' });
    expect(resolveShortcut(key('k', mod), ctx({ layer: 'settings' }))).toBeNull();
    expect(resolveShortcut(key(',', mod), ctx({ layer: 'settings' }))).toEqual({
      kind: 'settings',
    });
    expect(resolveShortcut(key('j', mod), ctx({ layer: 'menu' }))).toBeNull();
  });

  it('never navigates while typing in a field, but opens overlays from one', () => {
    const field = ctx({ focus: 'field' });
    expect(resolveShortcut(key('2', { mod: true }), field)).toBeNull();
    expect(resolveShortcut(key('[', { mod: true }), field)).toBeNull();
    expect(resolveShortcut(key('d', { mod: true, shift: true }), field)).toBeNull();
    expect(resolveShortcut(key('k', { mod: true }), field)).toEqual({ kind: 'omnibar' });
    expect(resolveShortcut(key('j', { mod: true }), field)).toEqual({ kind: 'agent-window' });
  });

  it('navigates from the terminal with modifier shortcuts', () => {
    const terminal = ctx({ focus: 'terminal', view: 'agent' });
    expect(resolveShortcut(key('2', { mod: true }), terminal)).toEqual({
      kind: 'lens',
      lens: 'parts',
    });
    expect(resolveShortcut(key(']', { mod: true }), terminal)).toEqual({ kind: 'forward' });
    // The agent window does not open over the agent tab.
    expect(resolveShortcut(key('j', { mod: true }), terminal)).toBeNull();
  });

  it('ignores repeats, composition and Option chords', () => {
    expect(resolveShortcut(key('Escape', { repeat: true }), ctx())).toBeNull();
    expect(resolveShortcut(key('k', { mod: true, repeat: true }), ctx())).toBeNull();
    expect(resolveShortcut(key('Escape', { composing: true }), ctx())).toBeNull();
    expect(resolveShortcut(key('2', { mod: true, alt: true }), ctx())).toBeNull();
  });

  it('lets the catalogue opened from the launcher go back without a project', () => {
    const launcher = ctx({ hasProject: false, view: 'system' });
    expect(resolveShortcut(key('Escape'), launcher)).toEqual({ kind: 'zoom-out' });
    expect(resolveShortcut(key('[', { mod: true }), launcher)).toEqual({ kind: 'back' });
    expect(resolveShortcut(key('2', { mod: true }), launcher)).toBeNull();
    expect(resolveShortcut(key('Escape'), ctx({ hasProject: false, view: 'project' }))).toBeNull();
  });

  it('maps the remaining chords', () => {
    expect(resolveShortcut(key('P', { mod: true }), ctx())).toEqual({ kind: 'omnibar' });
    expect(resolveShortcut(key('D', { mod: true, shift: true }), ctx())).toEqual({
      kind: 'decisions',
    });
    expect(resolveShortcut(key('[', { mod: true }), ctx())).toEqual({ kind: 'back' });
    expect(resolveShortcut(key('9', { mod: true }), ctx())).toBeNull();
    expect(resolveShortcut(key('k'), ctx())).toBeNull();
  });
});
