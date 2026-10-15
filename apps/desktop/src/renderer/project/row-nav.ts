/**
 * Keyboard navigation for lens rows: one tab stop per list (roving tabindex), arrow keys and
 * Home/End move between rows, Enter opens the row. Controls inside a row keep their own keys.
 */
import type React from 'react';
import { useState } from 'react';

export interface RowProps {
  tabIndex: number;
  'data-row': string;
  onFocus: (e: React.FocusEvent<HTMLElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
}

function rowsOf(row: HTMLElement): HTMLElement[] {
  const list = row.closest<HTMLElement>('[data-rows]');
  return list ? [...list.querySelectorAll<HTMLElement>('[data-row]')] : [row];
}

/** `keys` is the rows' keys in display order; the first is the tab stop until one is focused. */
export function useRowNav(keys: string[]) {
  const [active, setActive] = useState<string | null>(null);
  const stop = active !== null && keys.includes(active) ? active : (keys[0] ?? null);
  return (key: string, open: () => void): RowProps => ({
    tabIndex: key === stop ? 0 : -1,
    'data-row': key,
    onFocus: (e) => {
      if (e.target === e.currentTarget) setActive(key);
    },
    onKeyDown: (e) => {
      if (e.target !== e.currentTarget || e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        open();
        return;
      }
      const rows = rowsOf(e.currentTarget);
      const at = rows.indexOf(e.currentTarget);
      const to =
        e.key === 'ArrowDown'
          ? at + 1
          : e.key === 'ArrowUp'
            ? at - 1
            : e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? rows.length - 1
                : null;
      if (to === null) return;
      e.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, to))]?.focus();
    },
  });
}
