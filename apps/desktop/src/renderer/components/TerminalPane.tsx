import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowsOutSimple,
  ArrowsInSimple,
  MagnifyingGlass,
  Play,
  Stop,
  Pause,
  ArrowClockwise,
  TerminalWindow,
} from '@phosphor-icons/react';
import { Brand, IconButton } from './ui';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { cmd, errMsg } from '../api';
import { useStore } from '../store';
import '@xterm/xterm/css/xterm.css';

/**
 * Real PTY terminal: bytes flow renderer ↔ main ↔ core (node-pty) untouched
 * by React state. xterm owns the scrollback.
 */
export function TerminalPane() {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const {
    session,
    refreshSession,
    adapters,
    refreshAdapters,
    terminalExpanded,
    set,
    toast,
    projectId,
    project,
    theme,
    sidecarTab,
    sidecarOpen,
  } = useStore();
  const [starting, setStarting] = useState(false);
  const [adapterId, setAdapterId] = useState('codex');
  const restored = useRef(false);
  // Reflect the running session's adapter so the picker doesn't lie.
  useEffect(() => {
    if (session?.adapterId) setAdapterId(session.adapterId);
  }, [session?.adapterId]);

  useEffect(() => {
    if (!host.current) return;
    const t = new Terminal({
      fontFamily: 'IBM Plex Mono, monospace',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      theme: terminalTheme(),
    });
    const f = new FitAddon();
    const s = new SearchAddon();
    t.loadAddon(f);
    t.loadAddon(s);
    t.open(host.current);
    f.fit();
    term.current = t;
    fit.current = f;
    search.current = s;

    t.onData((data) => {
      // Keystrokes go straight to the PTY — terminal semantics preserved.
      void cmd('terminal.write', { data }).catch(() => {});
    });
    const unData = window.omenflow.onTerminalData((chunk) => t.write(chunk));
    const unState = window.omenflow.onTerminalState(() => void refreshSession());
    const ro = new ResizeObserver(() => {
      try {
        f.fit();
        if (term.current) {
          void cmd('terminal.resize', { cols: term.current.cols, rows: term.current.rows }).catch(
            () => {},
          );
        }
      } catch {
        /* hidden */
      }
    });
    ro.observe(host.current);
    const onFocus = () => t.focus();
    window.addEventListener('omenflow:focus-terminal', onFocus);

    // Restore scrollback for a still-running session after reload.
    void (async () => {
      if (restored.current) return;
      restored.current = true;
      try {
        const r = await cmd<{ session: { scrollback?: string } | null }>('terminal.state', {});
        if (r.session?.scrollback) t.write(r.session.scrollback);
      } catch {
        /* core may not be up yet */
      }
    })();

    return () => {
      unData();
      unState();
      ro.disconnect();
      window.removeEventListener('omenflow:focus-terminal', onFocus);
      t.dispose();
      term.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refreshSession();
    void refreshAdapters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // New session id (start/restart/project switch) → drop stale scrollback.
  // Skipped until the mount-time scrollback restore has finished.
  const lastSessionId = useRef<string | null>(null);
  useEffect(() => {
    const id = session?.id ?? null;
    if (id === lastSessionId.current) return;
    const seenBefore = lastSessionId.current !== null;
    lastSessionId.current = id;
    if (id && seenBefore && restored.current) term.current?.reset();
  }, [session?.id]);

  const start = async () => {
    setStarting(true);
    try {
      // A fresh session shouldn't inherit a dead session's scrollback.
      term.current?.reset();
      await cmd('terminal.start', { adapterId });
      await refreshSession();
      term.current?.focus();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setStarting(false);
    }
  };
  const stop = async () => {
    await cmd('terminal.stop', {}).catch(() => {});
    await refreshSession();
  };
  const interrupt = async () => {
    await cmd('terminal.interrupt', {}).catch(() => {});
  };
  const restart = async () => {
    term.current?.reset();
    await cmd('terminal.restart', {}).catch(() => {});
    await refreshSession();
  };

  useEffect(() => {
    if (term.current) term.current.options.theme = terminalTheme();
  }, [theme]);
  useEffect(() => {
    if (sidecarOpen && sidecarTab === 'agent') {
      const frame = requestAnimationFrame(() => {
        fit.current?.fit();
        if (session?.state === 'running') term.current?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [sidecarOpen, sidecarTab, session?.state]);

  useEffect(() => {
    if (host.current) host.current.inert = !session;
  }, [session]);

  const running = session?.state === 'running' || session?.state === 'starting';
  const adapterOptions = adapters.length
    ? adapters
    : ([
        { adapterId: 'codex', label: 'Codex CLI', available: false },
        { adapterId: 'claude-code', label: 'Claude Code', available: false },
        { adapterId: 'custom', label: 'Custom CLI', available: false },
      ] as never[]);

  const currentAdapter = adapterOptions.find((a) => a.adapterId === adapterId);
  return (
    <div className="agent-pane">
      <div className="agent-toolbar">
        <TerminalWindow size={14} className="faint" />
        <select
          aria-label="Agent provider"
          value={adapterId}
          onChange={(e) => setAdapterId(e.target.value)}
          disabled={running || starting}
        >
          {adapterOptions.map((a) => (
            <option key={a.adapterId} value={a.adapterId}>
              {a.label}
            </option>
          ))}
        </select>
        <span className="grow" />
        <IconButton label="Find in terminal" onClick={() => setFindOpen((v) => !v)}>
          <MagnifyingGlass size={14} />
        </IconButton>
        <IconButton
          label={terminalExpanded ? 'Reduce agent panel' : 'Expand agent panel'}
          onClick={() => set({ terminalExpanded: !terminalExpanded })}
        >
          {terminalExpanded ? <ArrowsInSimple size={14} /> : <ArrowsOutSimple size={14} />}
        </IconButton>
      </div>
      {findOpen && (
        <div className="agent-find">
          <input
            aria-label="Find in terminal"
            autoFocus
            placeholder="Find in terminal…"
            value={findQuery}
            onChange={(e) => {
              setFindQuery(e.target.value);
              search.current?.findNext(e.target.value, { incremental: true });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') search.current?.findNext(findQuery);
              if (e.key === 'Escape') setFindOpen(false);
            }}
          />
        </div>
      )}
      {!session && (
        <div className="agent-welcome">
          <Brand compact />
          <h2>No agent session</h2>
          <p>
            {currentAdapter?.available
              ? `Start ${currentAdapter.label} here. It works inside ${project?.name ?? 'this project'} and proposes changes for you to review.`
              : `${currentAdapter?.label ?? 'The selected agent'} is not detected on this machine. Connect it to work on ${project?.name ?? 'this project'} from this terminal.`}
          </p>
          <button
            className="primary"
            onClick={() => void start()}
            disabled={starting || !currentAdapter?.available}
          >
            <Play size={14} />
            {starting ? 'Connecting…' : `Start ${currentAdapter?.label ?? 'agent'}`}
          </button>
          {currentAdapter && !currentAdapter.available && (
            <button className="text-link" onClick={() => set({ nav: 'connections' })}>
              Set up {currentAdapter.label} in Connections
            </button>
          )}
          <span className="agent-boundary">
            Nothing an agent proposes becomes the baseline until you approve it.
          </span>
        </div>
      )}
      <div
        ref={host}
        className={`terminal-host ${!session ? 'terminal-idle' : ''}`}
        aria-label="Agent terminal"
        aria-hidden={!session}
      />
      {session && (
        <div className="agent-session-actions">
          <span
            className={`session-indicator row ${running ? 'ok' : session.state === 'failed' ? 'err' : 'dim'}`}
          >
            {running && <span className="live-dot" aria-hidden="true" />}
            {sessionLabels[session.state] ?? session.state}
            <span className="faint">· {currentAdapter?.label ?? session.adapterId}</span>
          </span>
          <span className="grow" />
          {running ? (
            <>
              <IconButton label="Interrupt agent" onClick={() => void interrupt()}>
                <Pause size={14} />
              </IconButton>
              <IconButton label="Stop agent" onClick={() => void stop()}>
                <Stop size={14} />
              </IconButton>
            </>
          ) : (
            <>
              <button className="primary" onClick={() => void start()} disabled={starting}>
                <Play size={13} />
                Start
              </button>
              <IconButton label="Restart agent" onClick={() => void restart()}>
                <ArrowClockwise size={14} />
              </IconButton>
            </>
          )}
        </div>
      )}
    </div>
  );
}
const sessionLabels: Record<string, string> = {
  starting: 'Starting',
  running: 'Running',
  exited: 'Ended',
  failed: 'Failed',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
};
function terminalTheme() {
  const css = getComputedStyle(document.documentElement);
  const color = (token: string) => css.getPropertyValue(token).trim();
  return {
    background: color('--bg-app'),
    foreground: color('--text-primary'),
    cursor: color('--accent'),
    selectionBackground: color('--accent-soft'),
    black: color('--bg-inset'),
    red: color('--err'),
    green: color('--ok'),
    yellow: color('--warn'),
    blue: color('--accent'),
    magenta: '#b7a3d5',
    cyan: '#90c3ca',
    white: color('--text-primary'),
    brightBlack: color('--text-faint'),
    brightWhite: '#ffffff',
  };
}
