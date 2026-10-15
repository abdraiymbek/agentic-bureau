/**
 * The terminal's colours, read from the design tokens: `--terminal-*` for the surface, cursor and
 * selection, the sixteen `--ansi-*` colours, and the themed scrollbar. Every colour is set, so
 * xterm's own defaults (unreadable on Paper) never show.
 */
import type { ITheme } from '@xterm/xterm';

type Read = (token: string) => string;

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;
type AnsiName = (typeof ANSI)[number];

const brightName = (name: AnsiName) =>
  `bright${name.charAt(0).toUpperCase()}${name.slice(1)}` as `bright${Capitalize<AnsiName>}`;

export function terminalPalette(read: Read): ITheme {
  const background = read('--terminal-bg');
  return {
    background,
    foreground: read('--terminal-fg'),
    cursor: read('--terminal-cursor'),
    cursorAccent: background,
    selectionBackground: read('--terminal-selection'),
    scrollbarSliderBackground: read('--scrollbar-thumb'),
    scrollbarSliderHoverBackground: read('--scrollbar-thumb-hover'),
    scrollbarSliderActiveBackground: read('--scrollbar-thumb-hover'),
    ...Object.fromEntries(ANSI.map((name) => [name, read(`--ansi-${name}`)])),
    ...Object.fromEntries(ANSI.map((name) => [brightName(name), read(`--ansi-bright-${name}`)])),
  };
}

/** The palette for the theme the document shows right now. */
export function documentPalette(): ITheme {
  const css = getComputedStyle(document.documentElement);
  return terminalPalette((token) => css.getPropertyValue(token).trim());
}
