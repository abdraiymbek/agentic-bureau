/**
 * Reading the terminal's scrollback: the transcript, search, and web links. Written against the
 * small part of the xterm buffer API it needs so it can be tested without a browser.
 */

export interface BufferLineLike {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}

export interface BufferLike {
  readonly length: number;
  getLine(y: number): BufferLineLike | undefined;
}

/** One line as the program wrote it, possibly spread over several rows of the screen. */
export interface LogicalLine {
  /** Buffer row of its first segment (0-based). */
  row: number;
  text: string;
  /** Length of each row's segment, in order; the last one is right-trimmed. */
  segments: number[];
}

/** The logical line that contains buffer row `y` (0-based). */
export function logicalLineAt(buffer: BufferLike, y: number): LogicalLine | null {
  if (!buffer.getLine(y)) return null;
  let start = y;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
  return readLogical(buffer, start).line;
}

function readLogical(buffer: BufferLike, start: number): { line: LogicalLine; next: number } {
  const parts: string[] = [];
  let row = start;
  for (;;) {
    const line = buffer.getLine(row);
    if (!line) break;
    const following = buffer.getLine(row + 1);
    const continues = !!following?.isWrapped;
    parts.push(line.translateToString(!continues));
    row++;
    if (!continues) break;
  }
  return {
    line: { row: start, text: parts.join(''), segments: parts.map((p) => p.length) },
    next: Math.max(row, start + 1),
  };
}

export function logicalLines(buffer: BufferLike): LogicalLine[] {
  const lines: LogicalLine[] = [];
  let row = 0;
  while (row < buffer.length) {
    const { line, next } = readLogical(buffer, row);
    lines.push(line);
    row = next;
  }
  return lines;
}

/** The whole scrollback as plain text, wrapped rows rejoined, trailing blank lines dropped. */
export function bufferText(buffer: BufferLike): string {
  const lines = logicalLines(buffer).map((l) => l.text.replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.join('\n');
}

/** Map an offset in a logical line to a buffer cell (0-based row and column). */
export function cellAt(line: LogicalLine, offset: number): { row: number; col: number } {
  let rest = offset;
  for (let i = 0; i < line.segments.length; i++) {
    const size = line.segments[i]!;
    if (rest < size || i === line.segments.length - 1) return { row: line.row + i, col: rest };
    rest -= size;
  }
  return { row: line.row, col: offset };
}

export interface BufferMatch {
  row: number;
  col: number;
  length: number;
}

/** Every occurrence of `query`, top to bottom. Matches may span wrapped rows. */
export function findInBuffer(
  buffer: BufferLike,
  query: string,
  caseSensitive = false,
): BufferMatch[] {
  if (!query) return [];
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: BufferMatch[] = [];
  for (const line of logicalLines(buffer)) {
    const hay = caseSensitive ? line.text : line.text.toLowerCase();
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      const cell = cellAt(line, at);
      matches.push({ row: cell.row, col: cell.col, length: needle.length });
      from = at + Math.max(needle.length, 1);
    }
  }
  return matches;
}

/** Index of the match to show next, moving from `current` (or from the bottom when there is none). */
export function stepMatch(total: number, current: number | null, direction: 1 | -1): number {
  if (total <= 0) return -1;
  if (current === null || current < 0 || current >= total) return direction === 1 ? 0 : total - 1;
  return (current + direction + total) % total;
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?'"’”)\]}>]+$/;

/** http(s) links in a line, without the punctuation that usually follows a link in prose. */
export function findUrls(text: string): { start: number; end: number; url: string }[] {
  const found: { start: number; end: number; url: string }[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    let url = match[0];
    const strip = url.match(TRAILING)?.[0] ?? '';
    if (strip) {
      url = url.slice(0, url.length - strip.length);
      // Keep closing brackets the link itself opened, as in a Wikipedia URL.
      for (const close of strip) {
        const open = close === ')' ? '(' : close === ']' ? '[' : null;
        if (!open || count(url, open) <= count(url, close)) break;
        url += close;
      }
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    } catch {
      continue;
    }
    const start = match.index ?? 0;
    found.push({ start, end: start + url.length, url });
  }
  return found;
}

function count(text: string, ch: string): number {
  let n = 0;
  for (const c of text) if (c === ch) n++;
  return n;
}

/**
 * Remove control characters that would let pasted text act as terminal input of its own — an
 * escape could end a bracketed paste early. Line breaks and tabs stay.
 */
export function sanitizePaste(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

/**
 * The text a paste hands to xterm. xterm brackets a paste only when the CLI turned bracketed paste
 * on; without it every line break reaches the CLI as Enter and submits the line before it, or
 * accepts whatever a start-up dialog has selected. A paste is never a submission, so until the CLI
 * asks for bracketed paste the lines are joined with spaces.
 */
export function pasteText(text: string, bracketed: boolean): string {
  const clean = sanitizePaste(text);
  return bracketed ? clean : clean.replace(/[ \t]*\n\s*/g, ' ');
}
