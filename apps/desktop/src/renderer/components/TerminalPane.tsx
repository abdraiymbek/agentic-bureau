import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { cmd } from '../api';
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
  } = useStore();
  const [adapterId, setAdapterId] = useState('codex');
  const restored = useRef(false);

  useEffect(() => {
    if (!host.current) return;
    const t = new Terminal({
      fontFamily: 'IBM Plex Mono, monospace',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: '#14161a',
        foreground: '#e6e9ed',
        cursor: '#87afc7',
        selectionBackground: '#343b44',
        black: '#17191c',
        red: '#e29797',
        green: '#9bc49e',
        yellow: '#d7b979',
        blue: '#87afc7',
        magenta: '#b39ddb',
        cyan: '#80cbc4',
        white: '#e6e9ed',
        brightBlack: '#6b7480',
        brightRed: '#e29797',
        brightGreen: '#9bc49e',
        brightYellow: '#d7b979',
        brightBlue: '#87afc7',
        brightWhite: '#ffffff',
      },
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
    const unData = window.stark.onTerminalData((chunk) => t.write(chunk));
    const unState = window.stark.onTerminalState(() => void refreshSession());
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
    window.addEventListener('stark:focus-terminal', onFocus);

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
      window.removeEventListener('stark:focus-terminal', onFocus);
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

  const start = async () => {
    try {
      await cmd('terminal.start', { adapterId });
      await refreshSession();
      term.current?.focus();
    } catch (e) {
      toast('error', (e as Error).message);
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
    await cmd('terminal.restart', {}).catch(() => {});
    await refreshSession();
  };

  const running = session?.state === 'running' || session?.state === 'starting';
  const adapterOptions = adapters.length
    ? adapters
    : ([
        { adapterId: 'codex', label: 'Codex CLI' },
        { adapterId: 'claude-code', label: 'Claude Code' },
        { adapterId: 'custom', label: 'Custom CLI' },
      ] as never[]);

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-inset)',
      }}
    >
      <div
        style={{
          height: 34,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 8px',
          borderTop: '1px solid var(--border)',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-app)',
          fontSize: 12,
          flexShrink: 0,
        }}
      >
        <span className="dim">Agent:</span>
        <select
          value={adapterId}
          onChange={(e) => setAdapterId(e.target.value)}
          style={{ height: 24, fontSize: 12 }}
          disabled={running}
        >
          {adapterOptions.map((a) => (
            <option key={a.adapterId} value={a.adapterId}>
              {a.label}
            </option>
          ))}
        </select>
        <span
          className={`pill ${running ? 'current' : session?.state === 'failed' ? 'missing' : ''}`}
        >
          {session?.state ?? 'stopped'}
        </span>
        <span style={{ flex: 1 }} />
        {findOpen && (
          <input
            autoFocus
            placeholder="Find"
            value={findQuery}
            onChange={(e) => {
              setFindQuery(e.target.value);
              search.current?.findNext(e.target.value, { incremental: true });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') search.current?.findNext(findQuery);
              if (e.key === 'Escape') setFindOpen(false);
            }}
            style={{ height: 24, width: 160, fontSize: 12 }}
          />
        )}
        <button style={{ height: 24, fontSize: 12 }} onClick={() => setFindOpen((v) => !v)}>
          Find
        </button>
        <button
          style={{ height: 24, fontSize: 12 }}
          onClick={() => set({ terminalExpanded: !terminalExpanded })}
        >
          {terminalExpanded ? 'Shrink' : 'Expand'}
        </button>
        {running ? (
          <>
            <button style={{ height: 24, fontSize: 12 }} onClick={interrupt}>
              Interrupt
            </button>
            <button style={{ height: 24, fontSize: 12 }} className="danger" onClick={stop}>
              Stop
            </button>
          </>
        ) : (
          <>
            <button style={{ height: 24, fontSize: 12 }} onClick={start} className="primary">
              Start
            </button>
            {session && (
              <button style={{ height: 24, fontSize: 12 }} onClick={restart}>
                Restart
              </button>
            )}
          </>
        )}
      </div>
      <div ref={host} style={{ flex: 1, minHeight: 0, padding: 4 }} />
    </div>
  );
}
