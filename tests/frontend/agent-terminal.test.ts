import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  bufferText,
  cellAt,
  findInBuffer,
  findUrls,
  logicalLineAt,
  sanitizePaste,
  stepMatch,
  type BufferLike,
} from '../../apps/desktop/src/renderer/shell/agent/buffer';
import { createOrderedWriter } from '../../apps/desktop/src/renderer/shell/agent/writer';
import { terminalPalette } from '../../apps/desktop/src/renderer/shell/agent/palette';
import {
  clampDock,
  bottomReserve,
  clampRect,
  keyResize,
  maxSize,
  parsePrefs,
  serializePrefs,
  unplaced,
} from '../../apps/desktop/src/renderer/shell/agent/window-geometry';

/** A fake xterm buffer: rows of `cols` cells; `wrapped` marks a row that continues the previous. */
function buffer(rows: { text: string; wrapped?: boolean }[], cols = 10): BufferLike {
  return {
    length: rows.length,
    getLine: (y) => {
      const row = rows[y];
      if (!row) return undefined;
      return {
        isWrapped: !!row.wrapped,
        translateToString: (trim?: boolean) =>
          trim ? row.text.replace(/\s+$/, '') : row.text.padEnd(cols),
      };
    },
  };
}

describe('scrollback', () => {
  const b = buffer([
    { text: 'npm run' },
    { text: 'abcdefghij' },
    { text: 'klm', wrapped: true },
    { text: '' },
    { text: 'done  ' },
    { text: '' },
  ]);

  it('rejoins wrapped rows into the transcript and drops trailing blank lines', () => {
    expect(bufferText(b)).toBe('npm run\nabcdefghijklm\n\ndone');
  });

  it('finds matches across wrapped rows and maps them to cells', () => {
    expect(findInBuffer(b, 'IJK')).toEqual([{ row: 1, col: 8, length: 3 }]);
    expect(findInBuffer(b, 'IJK', true)).toEqual([]);
    expect(findInBuffer(b, 'n')).toEqual([
      { row: 0, col: 0, length: 1 },
      { row: 0, col: 6, length: 1 },
      { row: 4, col: 2, length: 1 },
    ]);
    expect(findInBuffer(b, '')).toEqual([]);
    const line = logicalLineAt(b, 2)!;
    expect(line.row).toBe(1);
    expect(cellAt(line, 11)).toEqual({ row: 2, col: 1 });
  });

  it('steps through matches with wrapping', () => {
    expect(stepMatch(3, null, 1)).toBe(0);
    expect(stepMatch(3, null, -1)).toBe(2);
    expect(stepMatch(3, 2, 1)).toBe(0);
    expect(stepMatch(3, 0, -1)).toBe(2);
    expect(stepMatch(0, null, 1)).toBe(-1);
  });

  it('finds web links without the punctuation around them', () => {
    expect(findUrls('see https://example.org/a?b=1. and (http://x.io/y)')).toEqual([
      { start: 4, end: 29, url: 'https://example.org/a?b=1' },
      { start: 36, end: 49, url: 'http://x.io/y' },
    ]);
    expect(findUrls('https://en.wikipedia.org/wiki/Foo_(bar)).')[0]!.url).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    );
    expect(findUrls('file:///etc/passwd javascript:alert(1) ftp://x')).toEqual([]);
  });

  it('strips control characters that could end a bracketed paste early', () => {
    expect(sanitizePaste('a\u001b[201~\rb\r\nc\td\u0007')).toBe('a[201~\nb\nc\td');
  });
});

describe('ordered input', () => {
  it('sends writes one at a time, in order, batching what arrives while one is in flight', async () => {
    const sent: string[] = [];
    let release!: () => void;
    const send = vi.fn(
      (data: string) =>
        new Promise<void>((resolve) => {
          sent.push(data);
          release = resolve;
        }),
    );
    const writer = createOrderedWriter(send);
    const first = writer.write('a');
    const second = writer.write('b');
    const third = writer.write('c');
    expect(sent).toEqual(['a']);
    release();
    await first;
    await vi.waitFor(() => expect(sent).toEqual(['a', 'bc']));
    release();
    await Promise.all([second, third]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('reports a failed send and carries on with the next input', async () => {
    const errors: unknown[] = [];
    const sent: string[] = [];
    const writer = createOrderedWriter(
      async (data) => {
        sent.push(data);
        if (data === 'x') throw new Error('session ended');
      },
      (e) => errors.push(e),
    );
    await writer.write('x');
    await writer.write('y');
    expect(sent).toEqual(['x', 'y']);
    expect(errors).toHaveLength(1);
  });

  it('drops queued input on clear without stranding callers', async () => {
    let release!: () => void;
    const sent: string[] = [];
    const writer = createOrderedWriter(
      (data) =>
        new Promise<void>((resolve) => {
          sent.push(data);
          release = resolve;
        }),
    );
    const first = writer.write('a');
    const queued = writer.write('b');
    writer.clear();
    await queued;
    release();
    await first;
    expect(sent).toEqual(['a']);
  });
});

describe('terminal palette', () => {
  it('uses the terminal tokens', () => {
    const tokens: Record<string, string> = {
      '--terminal-bg': '#000001',
      '--terminal-fg': '#000002',
      '--terminal-cursor': '#000003',
      '--terminal-selection': '#000004',
      '--scrollbar-thumb': '#000005',
      '--scrollbar-thumb-hover': '#000006',
      '--ansi-red': '#100000',
      '--ansi-bright-red': '#200000',
    };
    const p = terminalPalette((t) => tokens[t] ?? '');
    expect(p).toMatchObject({
      background: '#000001',
      foreground: '#000002',
      cursor: '#000003',
      cursorAccent: '#000001',
      selectionBackground: '#000004',
      scrollbarSliderBackground: '#000005',
      scrollbarSliderHoverBackground: '#000006',
      red: '#100000',
      brightRed: '#200000',
    });
  });

  // Every colour comes from tokens.css in both themes, so none is left to xterm's defaults.
  it('sets every colour from tokens.css in Graphite and in Paper', () => {
    const css = fs.readFileSync(new URL('../../design-system/tokens.css', import.meta.url), 'utf8');
    const theme = (selector: string) => {
      const open = css.indexOf('{', css.indexOf(selector));
      const body = css.slice(open + 1, css.indexOf('\n}', open));
      return Object.fromEntries(
        [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
      );
    };
    for (const selector of [":root,\n[data-theme='dark'] {", "[data-theme='light'] {"]) {
      const tokens = theme(selector);
      const p = terminalPalette((t) => tokens[t] ?? '') as Record<string, string>;
      expect(Object.keys(p)).toHaveLength(24);
      for (const [key, value] of Object.entries(p))
        expect(value, `${selector} ${key}`).not.toBe('');
      expect(p.brightYellow).toBe(tokens['--ansi-bright-yellow']);
    }
  });
});

describe('floating window geometry', () => {
  const small = { width: 976, height: 652 };
  const large = { width: 1392, height: 852 };

  it('never covers more than half the width or 56 % of the height', () => {
    expect(maxSize(small)).toEqual({ w: 488, h: 365 });
    const r = clampRect(null, small);
    expect(r).toEqual({ w: 488, h: 365, x: 12, y: 652 - 365 - 12 });
    expect((r.w * r.h) / (small.width * small.height)).toBeLessThan(0.3);
    expect(clampRect(null, large)).toEqual({ w: 560, h: 380, x: 12, y: 852 - 380 - 12 });
  });

  it('keeps a saved place on screen when the area shrinks', () => {
    const saved = { x: 700, y: 400, w: 560, h: 380 };
    expect(clampRect(saved, large)).toEqual(saved);
    const moved = clampRect(saved, small);
    expect(moved.x + moved.w).toBeLessThanOrEqual(small.width - 12);
    expect(moved.y + moved.h).toBeLessThanOrEqual(small.height - 12);
  });

  it('resizes from the keyboard like the corner handle: up grows and keeps the bottom edge', () => {
    const r = { x: 12, y: 400, w: 400, h: 300 };
    expect(keyResize(r, 'ArrowUp', false, large)).toEqual({ x: 12, y: 384, w: 400, h: 316 });
    expect(keyResize(r, 'ArrowRight', true, large)).toEqual({ x: 12, y: 400, w: 464, h: 300 });
    expect(keyResize({ ...r, w: 360 }, 'ArrowLeft', false, large)!.w).toBe(360);
    expect(keyResize(r, 'Enter', false, large)).toBeNull();
  });

  it('sits above the controls pinned along the bottom until the person places it', () => {
    // The flow map's footer row: legend at the left, peek strip in the middle, controls right.
    const foot = { left: 16, right: 1376, top: 852 - 16 - 32, bottom: 852 - 16 };
    const expanded = bottomReserve(large, { x: 12, w: 560, height: 380 }, [foot]);
    expect(expanded).toBe(852 - 12 - foot.top + 8);
    const r = clampRect(null, large, expanded);
    expect(r.y + r.h).toBe(foot.top - 8);
    // Collapsed to its header, it still clears the legend.
    expect(bottomReserve(large, { x: 12, w: 560, height: 40 }, [foot])).toBe(expanded);
    // Older preferences saved only a size: the place is still the default one.
    expect(unplaced(parsePrefs('{"w":600,"h":400}').rect)).toBe(true);
    expect(clampRect(parsePrefs('{"w":600,"h":400}').rect, large, expanded).y).toBe(
      foot.top - 8 - 400,
    );
    expect(unplaced({ x: 40, y: 50, w: 500, h: 300 })).toBe(false);
  });

  it('ignores controls beside the window or away from the bottom edge', () => {
    const right = { left: 900, right: 1376, top: 800, bottom: 836 };
    expect(bottomReserve(large, { x: 12, w: 560, height: 380 }, [right])).toBe(0);
    // A save bar in the middle of a short stage does not lift the window over the stage.
    const middle = { left: 16, right: 1376, top: 400, bottom: 440 };
    expect(bottomReserve(large, { x: 12, w: 560, height: 380 }, [middle])).toBe(0);
    // Pinned controls stacked at the bottom are all cleared, lowest first.
    const bar = { left: 16, right: 1376, top: 852 - 96, bottom: 852 - 8 };
    const above = { left: 16, right: 1376, top: 852 - 130, bottom: 852 - 40 };
    expect(bottomReserve(large, { x: 12, w: 560, height: 380 }, [above, bar])).toBe(
      852 - 12 - above.top + 8,
    );
  });

  it('bounds the docked width', () => {
    expect(clampDock(900, small)).toBe(439);
    expect(clampDock(100, small)).toBe(320);
  });

  it('reads the earlier {w, h} preference and round-trips the new one', () => {
    const legacy = parsePrefs('{"w":600,"h":400}');
    expect(legacy.rect).toMatchObject({ w: 600, h: 400 });
    expect(clampRect(legacy.rect, large).y).toBe(852 - 400 - 12);
    const prefs = {
      rect: { x: 40, y: 50, w: 500, h: 300 },
      docked: true,
      dockWidth: 380,
      collapsed: true,
    };
    expect(parsePrefs(serializePrefs(prefs))).toEqual(prefs);
    expect(parsePrefs('nonsense').rect).toBeNull();
    expect(parsePrefs(null).docked).toBe(false);
  });
});

describe('terminal restore while the host is unreachable', () => {
  it('holds a bounded number of live frames and replays the newest after the snapshot', async () => {
    const { createTerminalRestore, MAX_BUFFERED_FRAMES } =
      await import('../../apps/desktop/src/renderer/lib/terminal-restore');
    const written: string[] = [];
    const history = createTerminalRestore(
      async () => ({ session: { id: 's', scrollback: 'snap', scrollbackCursor: 10 } }),
      (text) => written.push(text),
    );
    for (let seq = 1; seq <= MAX_BUFFERED_FRAMES + 20; seq++)
      history.acceptLive({ sessionId: 's', seq, chunk: String(seq) });
    await history.restore();
    expect(written[0]).toBe('snap');
    expect(written[1]).toBe('21');
    expect(written).toHaveLength(MAX_BUFFERED_FRAMES + 1);
  });
});
