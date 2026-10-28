/**
 * The introduction's order of scenes and the pure decisions around it: what the keyboard does,
 * how the map fits the window, and what the engine and settings copy say on each platform.
 */
import type { FocusKind } from '../lib/layers';

export type SceneId =
  'arrive' | 'whole' | 'one' | 'decide' | 'agent' | 'engine' | 'look' | 'keys' | 'local';

export interface Scene {
  id: SceneId;
  /** Acts play the product; setup steps ask something of the person. */
  kind: 'act' | 'setup';
  /** The act's title or the step's heading. */
  title: string;
  /** The short word on the progress rail. */
  short: string;
  /** The act's caption under its title. */
  caption?: string;
}

export const SCENES: Scene[] = [
  { id: 'arrive', kind: 'act', title: 'Bureau', short: 'Bureau' },
  {
    id: 'whole',
    kind: 'act',
    title: 'See the whole.',
    short: 'See the whole',
    caption: 'Level 0 · the whole project, intent to evidence',
  },
  {
    id: 'one',
    kind: 'act',
    title: 'Focus on one.',
    short: 'Focus on one',
    caption: 'Level 1 · one object between its inputs and its consequences',
  },
  {
    id: 'decide',
    kind: 'act',
    title: 'Decide.',
    short: 'Decide',
    caption: 'Level 2 · one proposal and its impact',
  },
  { id: 'agent', kind: 'setup', title: 'Your agent', short: 'Agent' },
  { id: 'engine', kind: 'setup', title: 'Your engine', short: 'Engine' },
  { id: 'look', kind: 'setup', title: 'Your look', short: 'Look' },
  { id: 'keys', kind: 'setup', title: 'Your keys', short: 'Keys' },
  { id: 'local', kind: 'setup', title: 'Local by design', short: 'Local' },
];

export const sceneIndex = (id: SceneId) => SCENES.findIndex((s) => s.id === id);
export const sceneDef = (id: SceneId) => SCENES[sceneIndex(id)]!;
export const nextScene = (id: SceneId): SceneId | null => SCENES[sceneIndex(id) + 1]?.id ?? null;
export const prevScene = (id: SceneId): SceneId | null => SCENES[sceneIndex(id) - 1]?.id ?? null;

/** How long the arrival plays before Continue is offered, in milliseconds. */
export const ARRIVE_MS = 1900;
/** How long the map draws before the thread lights. */
export const DRAW_MS = 2100;
/** After approval, how long the decision stays before the impact travels the map. */
export const APPROVED_MS = 1300;
/** How long the impact takes to reach the last dependent. */
export const IMPACT_MS = 1700;

/** The map's scale so the whole project fits the window beside the acts' titles and the rail. */
export function fitScale(
  viewport: { width: number; height: number },
  world: { width: number; height: number },
): number {
  const byWidth = (viewport.width - 96) / world.width;
  const byHeight = (viewport.height - 330) / world.height;
  return Math.min(1.1, Math.max(0.42, Math.min(byWidth, byHeight)));
}

export interface PrimerKey {
  id: string;
  shortcut: string;
  label: string;
}

/** The shortcuts the keys step asks the person to press. */
export const PRIMER: PrimerKey[] = [
  { id: 'omnibar', shortcut: '⌘K', label: 'Find anything: objects, commands, revision content' },
  {
    id: 'flow',
    shortcut: '⌘1',
    label: 'The Flow lens; ⌘2 to ⌘5 for Parts, Timeline, Files, Evidence',
  },
  { id: 'agent', shortcut: '⌘J', label: 'The agent window, over any lens' },
  {
    id: 'decisions',
    shortcut: '⌘⇧D',
    label: 'Decisions: what the agent proposed, with its impact',
  },
  { id: 'escape', shortcut: 'Esc', label: 'Zoom out one level, to where you came from' },
];

export interface KeyPress {
  key: string;
  /** ⌘ on macOS, Ctrl elsewhere. */
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

/** Which primer row a press lights, if any. */
export function primerFor(press: KeyPress): string | null {
  if (press.alt) return null;
  const key = press.key.toLowerCase();
  if (press.mod && !press.shift && key === 'k') return 'omnibar';
  if (press.mod && !press.shift && key === '1') return 'flow';
  if (press.mod && !press.shift && key === 'j') return 'agent';
  if (press.mod && press.shift && key === 'd') return 'decisions';
  if (!press.mod && !press.shift && key === 'escape') return 'escape';
  return null;
}

export type IntroNav = 'next' | 'back' | 'skip';

/**
 * What a key does in the introduction: → and Enter continue, ← goes back, Escape skips.
 * Enter is left to a focused control, and every key is left to a text field except Escape.
 */
export function introNavKey(press: KeyPress, focus: FocusKind | 'button'): IntroNav | null {
  if (press.mod || press.alt || press.shift) return null;
  const key = press.key.toLowerCase();
  if (key === 'escape') return 'skip';
  if (focus === 'field') return null;
  if (key === 'arrowright') return 'next';
  if (key === 'arrowleft') return 'back';
  if (key === 'enter' && focus !== 'button') return 'next';
  return null;
}

export type Platform = 'mac' | 'linux' | 'other';

export function platformOf(ua: string, platform: string): Platform {
  if (/Mac|iPhone|iPad/.test(platform) || /Mac OS X/.test(ua)) return 'mac';
  if (/Linux|X11/.test(platform) || /Linux/.test(ua)) return 'linux';
  return 'other';
}

/** How to install OpenSCAD here. The command is shown as is, never run. */
export function engineInstallHint(platform: Platform): { command: string | null; words: string } {
  switch (platform) {
    case 'mac':
      return {
        command: 'brew install --cask openscad@snapshot',
        words: 'The development snapshot renders large parts in seconds.',
      };
    case 'linux':
      return {
        command: 'sudo apt install openscad',
        words: 'Or your distribution’s package (sudo dnf install openscad on Fedora).',
      };
    default:
      return { command: null, words: 'Install OpenSCAD from openscad.org, then locate it here.' };
  }
}

/** Where the app keeps its own settings, so the person knows what is theirs. */
export function settingsFolder(platform: Platform): string {
  switch (platform) {
    case 'mac':
      return '~/Library/Application Support/app.agenticbureau.desktop';
    case 'linux':
      return '~/.local/share/app.agenticbureau.desktop';
    default:
      return 'the app’s data folder';
  }
}
