/**
 * Shortcuts are written once, Mac style ("⌘⇧D"). The app accepts Ctrl wherever it accepts ⌘, so
 * other platforms are shown Ctrl, and assistive technology is told the real key names.
 */

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return true;
  return /Mac|iPhone|iPad/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent);
}

/** Modifier symbol → text on other platforms, in the order they are written there. */
const MODIFIER_TEXT: [symbol: string, text: string][] = [
  ['⌘', 'Ctrl'],
  ['⌃', 'Ctrl'],
  ['⌥', 'Alt'],
  ['⇧', 'Shift'],
];

/** Modifier symbol → `aria-keyshortcuts` name. */
const MODIFIER_ARIA: Record<string, string> = {
  '⌘': 'Meta',
  '⌃': 'Control',
  '⌥': 'Alt',
  '⇧': 'Shift',
};

/** Key symbol → `aria-keyshortcuts` name (also the text shown on other platforms). */
const KEY_NAMES: Record<string, string> = {
  '↵': 'Enter',
  '⏎': 'Enter',
  esc: 'Escape',
  '⎋': 'Escape',
  '⌫': 'Backspace',
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  '↑': 'ArrowUp',
  '↓': 'ArrowDown',
};

function split(shortcut: string) {
  let key = shortcut.trim();
  const mods = new Set<string>();
  while (key.length > 1 && MODIFIER_ARIA[key[0]!]) {
    mods.add(key[0]!);
    key = key.slice(1);
  }
  return { mods, key };
}

/** "⌘⇧D" on a Mac, "Ctrl+Shift+D" elsewhere. Text without a modifier passes through. */
export function displayShortcut(shortcut: string, mac = isMacPlatform()): string {
  const { mods, key } = split(shortcut);
  if (mac || !mods.size) return shortcut;
  const words = [...new Set(MODIFIER_TEXT.filter(([s]) => mods.has(s)).map(([, text]) => text))];
  const keyText = key === '↵' || key === '⏎' ? 'Enter' : key;
  return [...words, keyText].join('+');
}

/**
 * The `aria-keyshortcuts` value: "⌘↵" → "Meta+Enter" on a Mac, "Control+Enter" elsewhere.
 * Undefined for text that is not one key ("⌘1–4" names a range).
 */
export function ariaShortcut(shortcut: string, mac = isMacPlatform()): string | undefined {
  const { mods, key } = split(shortcut);
  const name = KEY_NAMES[key] ?? KEY_NAMES[key.toLowerCase()] ?? (key.length === 1 ? key : '');
  if (!name || name === ' ') return undefined;
  const names = new Set(
    [...mods].map((m) => (MODIFIER_ARIA[m] === 'Meta' && !mac ? 'Control' : MODIFIER_ARIA[m]!)),
  );
  return [...names, name.length === 1 ? name.toUpperCase() : name].join('+');
}
