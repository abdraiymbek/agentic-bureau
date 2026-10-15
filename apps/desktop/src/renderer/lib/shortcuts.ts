/**
 * The workspace's global shortcuts as one pure decision, so the rules can be read and tested
 * in one place:
 *
 * - An event a layer or control already handled (`defaultPrevented`) does nothing more, so one
 *   Escape does one thing.
 * - While a layer is open only that layer's own shortcut works (⌘K closes the omnibar, ⌘,
 *   closes Settings); nothing reaches the workspace behind it.
 * - Shortcuts that only open an overlay (⌘K, ⌘,, ⌘J) work from a text field or the terminal.
 *   Shortcuts that navigate never fire while typing in a field; from the terminal they do,
 *   except Escape, which belongs to the CLI.
 * - Escape with focus in the floating agent window's own controls hands focus back to the
 *   workspace; otherwise it zooms out one level.
 */
import type { Lens } from '../project/lenses';
import type { FocusKind, LayerKind } from './layers';

export type ShortcutAction =
  | { kind: 'omnibar' }
  | { kind: 'settings' }
  | { kind: 'agent-window' }
  | { kind: 'release-agent-window' }
  | { kind: 'back' }
  | { kind: 'forward' }
  | { kind: 'decisions' }
  | { kind: 'lens'; lens: Lens }
  | { kind: 'zoom-out' };

export interface KeyInput {
  key: string;
  /** ⌘ on macOS, Ctrl elsewhere. */
  mod: boolean;
  shift: boolean;
  alt: boolean;
  repeat: boolean;
  composing: boolean;
  defaultPrevented: boolean;
}

export interface ShortcutContext {
  layer: LayerKind | null;
  focus: FocusKind;
  hasProject: boolean;
  view: 'agent' | 'project' | 'object' | 'decide' | 'system';
  /** The lens bound to ⌘n, if any. */
  lensFor: (digit: string) => Lens | undefined;
}

export function resolveShortcut(input: KeyInput, ctx: ShortcutContext): ShortcutAction | null {
  // A held key repeats: one press is one action.
  if (input.defaultPrevented || input.composing || input.alt || input.repeat) return null;
  const key = input.key.toLowerCase();
  const omnibar = input.mod && !input.shift && (key === 'k' || key === 'p');
  const settings = input.mod && !input.shift && key === ',';

  if (ctx.layer) {
    if (ctx.layer === 'omnibar' && omnibar) return { kind: 'omnibar' };
    if (ctx.layer === 'settings' && settings) return { kind: 'settings' };
    return null;
  }
  if (omnibar) return { kind: 'omnibar' };
  if (settings) return { kind: 'settings' };
  if (input.mod && !input.shift && key === 'j')
    return ctx.hasProject && ctx.view !== 'agent' ? { kind: 'agent-window' } : null;

  if (ctx.focus === 'field') return null;
  // Without a project only the catalogue, opened from the launcher, has somewhere to go back to.
  const navigable = ctx.hasProject || ctx.view === 'system';
  if (input.mod && !input.shift && key === '[') return navigable ? { kind: 'back' } : null;
  if (input.mod && !input.shift && key === ']') return navigable ? { kind: 'forward' } : null;
  if (!ctx.hasProject) {
    return !input.mod && key === 'escape' && ctx.view === 'system' && ctx.focus === 'workspace'
      ? { kind: 'zoom-out' }
      : null;
  }
  if (input.mod && input.shift && key === 'd') return { kind: 'decisions' };
  if (input.mod && !input.shift) {
    const lens = ctx.lensFor(key);
    if (lens) return { kind: 'lens', lens };
  }
  if (!input.mod && !input.shift && key === 'escape') {
    if (ctx.focus === 'terminal') return null;
    if (ctx.focus === 'agent-window') return { kind: 'release-agent-window' };
    return { kind: 'zoom-out' };
  }
  return null;
}
