/**
 * The project's one terminal: an xterm instance wired to the real PTY. The Agent tab and the
 * floating window show this same instance, so scrollback and the running CLI survive navigation.
 *
 * It owns everything between the screen and the host: restore and live output, ordered input,
 * size at start and debounced resize, the token palette, web links, search and the transcript.
 */
import { Terminal, type ILink } from '@xterm/xterm';
import type { SessionInfo } from '@omenflow/contracts';
import { FitAddon } from '@xterm/addon-fit';
import { useStore } from '../../store';
import { createTerminalRestore } from '../../lib/terminal-restore';
import { useAgentUi } from './agent-store';
import {
  bufferText,
  cellAt,
  findInBuffer,
  findUrls,
  logicalLineAt,
  pasteText,
  stepMatch,
  type BufferMatch,
} from './buffer';
import { copyText } from './clipboard';
import { documentPalette } from './palette';
import { quiet } from './quiet';
import { setTerminalPort, type TerminalPort } from './terminal-port';
import { createOrderedWriter, type OrderedWriter } from './writer';

/** Resize messages wait this long for the drag or layout change to settle. */
const RESIZE_DEBOUNCE_MS = 90;
/** Output must pause this long before the prompt counts as shown. */
const SETTLE_MS = 700;
const SCROLLBACK_LINES = 5000;
/** A blinking cursor is motion; it stays still for people who asked the system for less. */
const calm = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

type TerminalSnapshotFields = { scrollback?: string; scrollbackCursor?: number };

export interface SearchResult {
  index: number;
  total: number;
}

function openWeb(url: string) {
  void window.omenflow.openExternal(url).catch(() => {});
}

export class TerminalEngine implements TerminalPort {
  readonly term: Terminal;
  private readonly fitter = new FitAddon();
  private readonly writer: OrderedWriter;
  private readonly history: ReturnType<typeof createTerminalRestore>;
  private readonly cleanup: (() => void)[] = [];
  private host: HTMLElement | null = null;
  private sessionId: string | null = null;
  /** Every host state event outranks snapshots already in flight, even for the same session. */
  private stateRevision = 0;
  private live = false;
  private sentSize: string | null = null;
  private resizeTimer: number | undefined;
  private settleTimer: number | undefined;
  private copyTimer: number | undefined;
  private selecting = false;
  private search: { query: string; matches: BufferMatch[]; index: number } | null = null;
  private disposed = false;

  constructor(readonly projectId: string) {
    const mono = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
    this.term = new Terminal({
      fontFamily: mono || '"IBM Plex Mono", ui-monospace, monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: !calm(),
      scrollback: SCROLLBACK_LINES,
      disableStdin: true,
      theme: documentPalette(),
      // OSC 8 hyperlinks written by the CLI.
      linkHandler: { activate: (_event, text) => openWeb(text), allowNonHttpProtocols: false },
    });
    this.term.loadAddon(this.fitter);
    // A write the host refuses (the session just ended) is dropped; the session state says why.
    this.writer = createOrderedWriter((data) =>
      quiet('terminal.write', { data }, { projectId: this.projectId }),
    );
    this.history = createTerminalRestore(
      async () => {
        const stateRevision = this.stateRevision;
        const r = await quiet<{ session: (SessionInfo & TerminalSnapshotFields) | null }>(
          'terminal.state',
          {},
          { projectId },
        );
        if (!r.ok) throw new Error(r.error.message);
        return { ...r.result, stateRevision };
      },
      (chunk) => {
        if (chunk) this.term.write(chunk);
      },
      () => this.term.reset(),
      (snapshot) => {
        if (useStore.getState().projectId !== projectId) return;
        // A live event can supersede the metadata without changing the
        // session ID (for example, running → exited while this read waits).
        if (snapshot.stateRevision === this.stateRevision)
          useStore.getState().receiveSession(snapshot.session);
        useAgentUi.getState().setSessionChecked();
      },
    );
    this.wire();
    setTerminalPort(this);
  }

  private wire() {
    const t = this.term;
    const subs = [
      t.onData((data) => void this.writer.write(data)),
      t.onWriteParsed(() => this.outputSettling()),
      t.onSelectionChange(() => this.copySelectionSoon()),
      t.registerLinkProvider({
        provideLinks: (y, callback) => callback(this.linksAt(y - 1)),
      }),
    ];
    this.cleanup.push(() => subs.forEach((s) => s.dispose()));
    // Keys the person presses, not replies xterm sends on its own; `paste` marks its own input.
    t.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && !event.metaKey) useAgentUi.getState().setTyped(true);
      return true;
    });

    const unData = window.omenflow.onTerminalData((data) => {
      if (data.projectId === this.projectId)
        this.history.acceptLive({ sessionId: data.sessionId, seq: data.seq, chunk: data.chunk });
    });
    const unState = window.omenflow.onTerminalState((value) => {
      const v = value as { projectId?: string; session?: { id?: string } | null };
      if (v.projectId !== this.projectId) return;
      this.stateRevision++;
      useAgentUi.getState().setSessionChecked();
      if (v.session?.id) this.history.selectSession(v.session.id);
      void this.history.restore();
    });
    this.cleanup.push(unData, unState);

    // The palette follows the theme as soon as the document switches, not one render later.
    const themeWatch = new MutationObserver(() => {
      this.term.options.theme = documentPalette();
    });
    themeWatch.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    this.cleanup.push(() => themeWatch.disconnect());

    // xterm measures its cells when the font option changes. If the vendored font was still
    // loading, measure again once it is in: the appended generic family changes nothing else.
    const family = this.term.options.fontFamily ?? '';
    if (document.fonts && !document.fonts.check(`12.5px ${family}`))
      void document.fonts.ready.then(() => {
        if (this.disposed) return;
        this.term.options.fontFamily = `${family}, monospace`;
        this.fit();
      });
    void this.history.restore();
  }

  /** Attach to its host element once; presentation changes move the host, never the terminal. */
  open(host: HTMLElement) {
    if (this.host) return;
    this.host = host;
    this.term.open(host);
    const observer = new ResizeObserver(() => this.fit());
    observer.observe(host);
    this.cleanup.push(() => observer.disconnect());
  }

  /** Fit to the host now and tell the PTY once the size has settled. */
  fit() {
    if (!this.host || this.host.clientHeight < 40 || this.host.clientWidth < 80) return;
    try {
      this.fitter.fit();
    } catch {
      return;
    }
    window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => this.sendSize(), RESIZE_DEBOUNCE_MS);
  }

  private sendSize() {
    if (!this.live || !this.sessionId) return;
    const { cols, rows } = this.term;
    const key = `${this.sessionId}:${cols}x${rows}`;
    if (key === this.sentSize) return;
    this.sentSize = key;
    void quiet('terminal.resize', { cols, rows }, { projectId: this.projectId });
  }

  /** The host's view of the session. A new session gets the current size and a fresh readiness. */
  setSession(session: { id: string; state: string } | null) {
    const live = session?.state === 'running' || session?.state === 'starting';
    const id = session?.id ?? null;
    const changed = id !== this.sessionId;
    this.sessionId = id;
    this.live = live;
    // An ended session keeps its scrollback readable and selectable; only input stops.
    this.term.options.disableStdin = session?.state !== 'running';
    this.term.options.cursorBlink = live && !calm();
    if (changed) {
      this.sentSize = null;
      useAgentUi.getState().setInputReady(false);
      useAgentUi.getState().setTyped(false);
      this.search = null;
    }
    if (!live) {
      window.clearTimeout(this.settleTimer);
      useAgentUi.getState().setInputReady(false);
      this.writer.clear();
      return;
    }
    // A restarted session reuses its previous start size; send the size the terminal has now.
    this.fit();
    this.sendSize();
  }

  private outputSettling() {
    if (!this.live) return;
    useAgentUi.getState().setInputReady(false);
    window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      useAgentUi.getState().setInputReady(this.live && this.term.modes.bracketedPasteMode);
    }, SETTLE_MS);
  }

  /* ---------------- TerminalPort ---------------- */

  paste(text: string): boolean {
    if (this.term.options.disableStdin) return false;
    const clean = pasteText(text, this.term.modes.bracketedPasteMode);
    if (!clean) return false;
    // A pasted request is the session's first instruction as much as typing is.
    useAgentUi.getState().setTyped(true);
    this.term.paste(clean);
    return true;
  }

  write(data: string): Promise<void> {
    return this.writer.write(data);
  }

  readyForInput(): boolean {
    return this.live && !this.term.options.disableStdin && useAgentUi.getState().inputReady;
  }

  size(): { cols: number; rows: number } | null {
    const proposed =
      this.host && this.host.clientHeight >= 40 ? this.fitter.proposeDimensions() : undefined;
    if (proposed && proposed.cols > 0 && proposed.rows > 0) return proposed;
    return this.term.cols > 0 && this.term.rows > 0
      ? { cols: this.term.cols, rows: this.term.rows }
      : null;
  }

  focus() {
    this.term.focus();
  }

  /* ---------------- reading the scrollback ---------------- */

  transcript(): string {
    return bufferText(this.term.buffer.active);
  }

  clear() {
    this.term.clear();
    this.search = null;
  }

  /** Select the next (or previous) match and scroll it into view. */
  find(query: string, direction: 1 | -1, caseSensitive = false): SearchResult {
    if (!query) {
      this.clearSearch();
      return { index: -1, total: 0 };
    }
    const fresh = !this.search || this.search.query !== query;
    const matches = findInBuffer(this.term.buffer.active, query, caseSensitive);
    const previous = fresh ? null : this.search!.index;
    const index = fresh
      ? direction === 1
        ? firstMatchFrom(matches, this.term.buffer.active.viewportY)
        : stepMatch(matches.length, null, -1)
      : stepMatch(matches.length, previous, direction);
    this.search = { query, matches, index };
    const match = matches[index];
    if (!match) {
      this.term.clearSelection();
      return { index: -1, total: matches.length };
    }
    this.selecting = true;
    this.term.select(match.col, match.row, match.length);
    this.term.scrollToLine(Math.max(0, match.row - Math.floor(this.term.rows / 2)));
    queueMicrotask(() => (this.selecting = false));
    return { index, total: matches.length };
  }

  clearSearch() {
    if (this.search) this.term.clearSelection();
    this.search = null;
  }

  private linksAt(row: number): ILink[] | undefined {
    const buffer = this.term.buffer.active;
    const line = logicalLineAt(buffer, row);
    if (!line) return undefined;
    const links: ILink[] = [];
    for (const found of findUrls(line.text)) {
      const start = cellAt(line, found.start);
      const end = cellAt(line, found.end - 1);
      if (row < start.row || row > end.row) continue;
      links.push({
        range: {
          start: { x: start.col + 1, y: start.row + 1 },
          end: { x: end.col + 1, y: end.row + 1 },
        },
        text: found.url,
        activate: () => openWeb(found.url),
      });
    }
    return links.length ? links : undefined;
  }

  private copySelectionSoon() {
    // Matches selected by search are not copies the person asked for.
    if (this.selecting || this.search) return;
    window.clearTimeout(this.copyTimer);
    this.copyTimer = window.setTimeout(() => {
      const text = this.term.getSelection();
      if (text.trim())
        void copyText(text).then((ok) => ok && useAgentUi.getState().noteCopied('selection'));
    }, 180);
  }

  dispose() {
    this.disposed = true;
    window.clearTimeout(this.resizeTimer);
    window.clearTimeout(this.settleTimer);
    window.clearTimeout(this.copyTimer);
    this.history.dispose();
    this.writer.clear();
    for (const undo of this.cleanup.splice(0)) undo();
    setTerminalPort(null, this);
    this.term.dispose();
  }
}

/** First match at or below the top of the viewport, so a new search starts where the person looks. */
function firstMatchFrom(matches: BufferMatch[], viewportTop: number): number {
  const below = matches.findIndex((m) => m.row >= viewportTop);
  return below >= 0 ? below : matches.length - 1;
}
