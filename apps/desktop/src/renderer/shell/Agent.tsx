import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowsOut, Minus } from '@phosphor-icons/react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { cmd, errMsg } from '../api';
import { FALLBACK_ADAPTERS, preferredAdapter, useStore } from '../store';
import { createTerminalRestore } from '../lib/terminal-restore';
import { startAgent } from '../lib/actions';
import { Button, IconButton, State } from '../ui/kit';

const SESSION_LABELS: Record<string, string> = {
  starting: 'Starting',
  running: 'Running',
  exited: 'Ended',
  failed: 'Failed',
  interrupted: 'Interrupted',
};

const SIZE_KEY = 'omen.agentWindow';
const MIN_W = 360;
const MIN_H = 220;

function readSize(): { w: number; h: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(SIZE_KEY) ?? 'null') as {
      w?: number;
      h?: number;
    } | null;
    if (
      saved &&
      typeof saved.w === 'number' &&
      typeof saved.h === 'number' &&
      saved.w >= MIN_W &&
      saved.h >= MIN_H
    )
      return { w: saved.w, h: saved.h };
  } catch {
    /* default size */
  }
  return { w: 560, h: 380 };
}

/**
 * The one agent terminal. It stays mounted for the life of the open project so
 * the xterm instance, PTY listeners, and scrollback survive tab switches; only
 * its presentation changes — a full tab, a floating window, or hidden.
 */
export function AgentSurface() {
  const projectId = useStore((s) => s.projectId)!;
  const session = useStore((s) => s.session);
  const adapters = useStore((s) => s.adapters);
  const agentId = useStore((s) => s.agentId);
  const view = useStore((s) => s.view);
  const windowOpen = useStore((s) => s.agentWindowOpen);
  const theme = useStore((s) => s.theme);
  const { set, go, decide, refreshSession, refreshAdapters } = useStore.getState();

  const root = useRef<HTMLElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const readOnly = useStore((s) => s.readOnly);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [size, setSize] = useState(readSize);

  const mode = view.level === 'agent' ? 'tab' : windowOpen ? 'window' : 'hidden';
  const running = session?.state === 'running' || session?.state === 'starting';
  const live = session?.state === 'running';
  const options = adapters.length ? adapters : FALLBACK_ADAPTERS;
  const preferred = preferredAdapter(options, agentId);
  const label = session
    ? (adapters.find((a) => a.adapterId === session.adapterId)?.label ?? session.adapterId)
    : (preferred?.label ?? 'Agent');
  const status = session ? (SESSION_LABELS[session.state] ?? session.state) : 'Not started';

  /* ---------------- terminal lifetime ---------------- */
  useEffect(() => {
    if (!host.current) return;
    const t = new Terminal({
      fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: true,
      theme: terminalTheme(),
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current);
    term.current = t;
    fit.current = f;
    t.onData((data) => {
      void cmd('terminal.write', { data }, { projectId }).catch(() => {});
    });
    const history = createTerminalRestore(
      () =>
        cmd<{ session: { id: string; scrollback?: string; scrollbackCursor?: number } | null }>(
          'terminal.state',
          {},
          { projectId },
        ),
      (chunk) => {
        if (chunk) t.write(chunk);
      },
      () => t.reset(),
    );
    const unData = window.omenflow.onTerminalData((data) => {
      const current = useStore.getState().session;
      if (data.projectId === projectId && (!current || data.sessionId === current.id))
        history.acceptLive({ sessionId: data.sessionId, seq: data.seq, chunk: data.chunk });
    });
    const unState = window.omenflow.onTerminalState((value) => {
      if ((value as { projectId?: string }).projectId === projectId) {
        const next = (value as { session?: { id?: string } }).session?.id;
        if (next) history.selectSession(next);
        void refreshSession().catch(() => {});
        void history.restore();
      }
    });
    const ro = new ResizeObserver(() => {
      if (!host.current || host.current.clientHeight < 40) return;
      try {
        f.fit();
        void cmd('terminal.resize', { cols: t.cols, rows: t.rows }, { projectId }).catch(() => {});
      } catch {
        /* hidden */
      }
    });
    ro.observe(host.current);
    const onFocus = () => requestAnimationFrame(() => t.focus());
    window.addEventListener('omenflow:focus-terminal', onFocus);
    void history.restore();
    return () => {
      history.dispose();
      unData();
      unState();
      ro.disconnect();
      window.removeEventListener('omenflow:focus-terminal', onFocus);
      t.dispose();
      term.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = useCallback(async (adapterId: string) => {
    setStarting(true);
    setStartError(null);
    try {
      await startAgent(adapterId);
    } catch (error) {
      setStartError(errMsg(error));
    } finally {
      setStarting(false);
    }
  }, []);

  /* ---------------- autostart ---------------- */
  const sessionReady = useRef(false);
  const autostarted = useRef(false);
  const [, setReady] = useState(false);
  useEffect(() => {
    void refreshSession()
      .catch(() => {})
      .then(() => {
        sessionReady.current = true;
        setReady(true);
      });
    void refreshAdapters().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    if (autostarted.current || !sessionReady.current) return;
    if (readOnly || mode === 'hidden' || session !== null || !preferred?.available) return;
    autostarted.current = true;
    void start(preferred.adapterId);
  }, [mode, session, preferred, readOnly, start]);

  useEffect(() => {
    if (term.current) term.current.options.theme = terminalTheme();
  }, [theme]);

  /* Fit, resize, and focus when the surface goes from hidden to visible. */
  const wasHidden = useRef(true);
  useEffect(() => {
    if (mode === 'hidden') {
      wasHidden.current = true;
      return;
    }
    if (!wasHidden.current) return;
    wasHidden.current = false;
    const frame = requestAnimationFrame(() => {
      try {
        fit.current?.fit();
        const t = term.current;
        if (t)
          void cmd('terminal.resize', { cols: t.cols, rows: t.rows }, { projectId }).catch(
            () => {},
          );
        t?.focus();
      } catch {
        /* not measurable yet */
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [mode, projectId]);

  useEffect(() => {
    if (host.current) host.current.inert = !live || readOnly;
    if (!live || readOnly || mode === 'hidden') return;
    const frame = requestAnimationFrame(() => term.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [live, readOnly, mode]);

  /* ---------------- window resize ---------------- */
  const onResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const bounds = root.current?.parentElement;
      const maxW = Math.max(MIN_W, (bounds?.clientWidth ?? 1200) - 24);
      const maxH = Math.max(MIN_H, (bounds?.clientHeight ?? 800) - 24);
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = size.w;
      const startH = size.h;
      const move = (ev: PointerEvent) =>
        setSize({
          w: Math.max(MIN_W, Math.min(maxW, startW + (ev.clientX - startX))),
          h: Math.max(MIN_H, Math.min(maxH, startH + (startY - ev.clientY))),
        });
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        setSize((s) => {
          try {
            localStorage.setItem(SIZE_KEY, JSON.stringify(s));
          } catch {
            /* convenience only */
          }
          return s;
        });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [size],
  );

  const reviewPill = session?.waitingForReview && (
    <button type="button" className="decisions-pill" onClick={() => decide(null)}>
      <span className="state-dot" aria-hidden="true" />
      Waiting for your review
    </button>
  );

  return (
    <section
      ref={root}
      className={`agent-surface mode-${mode} ${live ? 'live' : ''}`}
      style={mode === 'window' ? { width: size.w, height: size.h } : undefined}
      aria-label="Agent"
    >
      {mode === 'window' && (
        <header className="agent-head">
          <span
            className={`agent-light ${live ? 'live' : session || preferred?.available ? 'ready' : 'off'}`}
          />
          <span className="agent-name truncate">{label}</span>
          <span className="agent-status">{status}</span>
          <span className="grow" />
          {reviewPill}
          <IconButton size="sm" label="Open agent tab" onClick={() => go({ level: 'agent' })}>
            <ArrowsOut size={13} />
          </IconButton>
          <IconButton
            size="sm"
            label="Close agent window (⌘J)"
            onClick={() => set({ agentWindowOpen: false })}
          >
            <Minus size={13} />
          </IconButton>
        </header>
      )}
      <div className="agent-screen">
        <div
          ref={host}
          className="terminal-host"
          aria-label="Agent terminal"
          aria-hidden={!session}
        />
        {mode === 'tab' && reviewPill && <div className="agent-review">{reviewPill}</div>}
        {!readOnly && !session && preferred && !preferred.available && (
          <div className="agent-empty">
            <p>{preferred.label} was not found on this machine.</p>
            <Button size="sm" onClick={() => set({ settingsOpen: true })}>
              Choose an agent in Settings
            </Button>
          </div>
        )}
        {readOnly && (
          <div className="agent-empty">
            <p>This project is read-only. Agent sessions are disabled.</p>
          </div>
        )}
        {!readOnly && !session && preferred?.available && (
          <div className="agent-empty" role="status">
            <p>
              {startError ??
                (starting ? `Starting ${preferred.label}…` : 'Ready to start your agent.')}
            </p>
            {!starting && (
              <Button size="sm" onClick={() => void start(preferred.adapterId)}>
                Start agent
              </Button>
            )}
          </div>
        )}
        {!readOnly && session && !running && (
          <div className="agent-ended">
            <State
              state={session.state}
              tone={session.state === 'failed' ? 'err' : 'neutral'}
              label={`${label} · ${status}`}
            />
            <Button
              size="sm"
              disabled={!preferred?.available || starting}
              onClick={() => preferred && void start(preferred.adapterId)}
            >
              Start again
            </Button>
          </div>
        )}
      </div>
      {mode === 'window' && (
        <div
          className="agent-resize"
          onPointerDown={onResizeStart}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize agent window"
        />
      )}
    </section>
  );
}

function terminalTheme() {
  const css = getComputedStyle(document.documentElement);
  const c = (token: string) => css.getPropertyValue(token).trim();
  const light = document.documentElement.dataset.theme === 'light';
  return {
    background: c('--terminal-bg'),
    foreground: c('--text'),
    cursor: c('--focus'),
    cursorAccent: c('--terminal-bg'),
    selectionBackground: c('--selection'),
    black: light ? '#2b2e33' : '#1b1d21',
    red: c('--err'),
    green: c('--ok'),
    yellow: c('--warn'),
    blue: light ? '#2f64b3' : '#8ab4f0',
    magenta: light ? '#8a4fb0' : '#c3a6e3',
    cyan: light ? '#1f7f8a' : '#8fcfd6',
    white: c('--text-2'),
    brightBlack: c('--text-3'),
    brightWhite: c('--text'),
  };
}
