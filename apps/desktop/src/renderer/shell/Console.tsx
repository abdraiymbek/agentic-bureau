import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import {
  ArrowUp,
  CaretDown,
  CaretUp,
  Check,
  MagnifyingGlass,
  Pause,
  Play,
  Stop,
  ArrowClockwise,
  X,
  At,
} from '@phosphor-icons/react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import type { AdapterStatus } from '@omenflow/contracts';
import { cmd, errMsg } from '../api';
import { useStore } from '../store';
import { createTerminalRestore } from '../lib/terminal-restore';
import { sendToAgent } from '../lib/actions';
import { IconButton, Pulse, typeMeta, relativeTime } from '../ui/kit';

const SESSION_LABELS: Record<string, string> = {
  starting: 'Starting',
  running: 'Running',
  exited: 'Ended',
  failed: 'Failed',
  interrupted: 'Interrupted',
};

const FALLBACK_ADAPTERS = [
  { adapterId: 'codex', label: 'Codex CLI', available: false },
  { adapterId: 'claude-code', label: 'Claude Code', available: false },
  { adapterId: 'custom', label: 'Custom CLI', available: false },
] as AdapterStatus[];

const HEIGHT_KEY = 'omen.console.height';

/**
 * The agent lives here. The composer types into the real CLI running in the PTY;
 * the terminal above it is the unfiltered session. Nothing is paraphrased.
 */
export function Console() {
  const projectId = useStore((s) => s.projectId)!;
  const session = useStore((s) => s.session);
  const adapters = useStore((s) => s.adapters);
  const open = useStore((s) => s.consoleOpen);
  const view = useStore((s) => s.view);
  const artifacts = useStore((s) => s.artifacts);
  const events = useStore((s) => s.events);
  const seed = useStore((s) => s.composerSeed);
  const theme = useStore((s) => s.theme);
  const { set, toast, refreshSession, refreshAdapters, focus, decide } = useStore.getState();

  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const restored = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [adapterId, setAdapterId] = useState('codex');
  const [starting, setStarting] = useState(false);
  const [sending, setSending] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [dismissedContext, setDismissedContext] = useState<string | null>(null);
  const [height, setHeight] = useState(() => {
    const saved = Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(saved) && saved > 160 ? saved : 360;
  });

  const running = session?.state === 'running' || session?.state === 'starting';
  const live = session?.state === 'running';
  const options = adapters.length ? adapters : FALLBACK_ADAPTERS;
  const adapter = options.find((a) => a.adapterId === adapterId) ?? options[0];

  useEffect(() => {
    if (session?.adapterId) setAdapterId(session.adapterId);
  }, [session?.adapterId]);

  useEffect(() => {
    if (!adapters.length || session) return;
    const current = adapters.find((a) => a.adapterId === adapterId);
    if (!current?.available) {
      const firstAvailable = adapters.find((a) => a.available);
      if (firstAvailable) setAdapterId(firstAvailable.adapterId);
    }
  }, [adapters, adapterId, session]);

  const focused =
    view.level === 'object' ? artifacts.find((v) => v.artifact.id === view.id) : undefined;
  const context = focused && dismissedContext !== focused.artifact.id ? focused : undefined;

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
    const s = new SearchAddon();
    t.loadAddon(f);
    t.loadAddon(s);
    t.open(host.current);
    term.current = t;
    fit.current = f;
    search.current = s;
    t.onData((data) => {
      void cmd('terminal.write', { data }, { projectId }).catch(() => {});
    });
    restored.current = false;
    const history = createTerminalRestore(
      () =>
        cmd<{ session: { scrollback?: string; scrollbackCursor?: number } | null }>(
          'terminal.state',
          {},
          { projectId },
        ),
      (chunk) => {
        if (chunk) t.write(chunk);
        restored.current = true;
      },
    );
    const unData = window.omenflow.onTerminalData((data) => {
      const current = useStore.getState().session;
      if (data.projectId === projectId && (!current || data.sessionId === current.id))
        history.acceptLive({ seq: data.seq, chunk: data.chunk });
    });
    const unState = window.omenflow.onTerminalState((value) => {
      if ((value as { projectId?: string }).projectId === projectId) {
        void refreshSession();
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
    const onFocus = () => {
      set({ consoleOpen: true });
      requestAnimationFrame(() => t.focus());
    };
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

  useEffect(() => {
    void refreshSession().catch(() => {});
    void refreshAdapters().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const lastSessionId = useRef<string | null>(null);
  useEffect(() => {
    const id = session?.id ?? null;
    if (id === lastSessionId.current) return;
    const seenBefore = lastSessionId.current !== null;
    lastSessionId.current = id;
    if (id && seenBefore && restored.current) term.current?.reset();
  }, [session?.id]);

  useEffect(() => {
    if (term.current) term.current.options.theme = terminalTheme();
  }, [theme]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      try {
        fit.current?.fit();
      } catch {
        /* not measurable yet */
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [open, height]);

  useEffect(() => {
    if (host.current) host.current.inert = !session;
  }, [session]);

  useEffect(() => {
    if (!seed) return;
    setText((current) => (seed.text ? seed.text : current));
    requestAnimationFrame(() => input.current?.focus());
  }, [seed]);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  /* ---------------- session control ---------------- */
  const start = async () => {
    setStarting(true);
    try {
      term.current?.reset();
      await cmd('terminal.start', { adapterId }, { projectId });
      await refreshSession();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setStarting(false);
    }
  };
  const stop = async () => {
    await cmd('terminal.stop', {}, { projectId }).catch((e) => toast('error', errMsg(e)));
    await refreshSession();
  };
  const interrupt = async () => {
    await cmd('terminal.interrupt', {}, { projectId }).catch((e) => toast('error', errMsg(e)));
  };
  const restart = async () => {
    term.current?.reset();
    await cmd('terminal.restart', {}, { projectId }).catch((e) => toast('error', errMsg(e)));
    await refreshSession();
  };

  const send = async () => {
    const body = text.trim();
    if (!body || !live || sending) return;
    const message = context
      ? `About the Omen Flow ${typeMeta(context.artifact.type).label.toLowerCase()} "${
          context.artifact.title
        }" (artifact ${context.artifact.id}${
          context.revision ? `, revision ${context.revision.seq}` : ''
        }): ${body}`
      : body;
    setSending(true);
    try {
      await sendToAgent(message);
      setText('');
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setSending(false);
    }
  };

  /* ---------------- resize ---------------- */
  const onResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = height;
      const max = window.innerHeight - 180;
      const move = (ev: PointerEvent) =>
        setHeight(Math.max(180, Math.min(max, startH + (startY - ev.clientY))));
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        setHeight((h) => {
          localStorage.setItem(HEIGHT_KEY, String(h));
          return h;
        });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [height],
  );

  /* ---------------- latest agent activity ---------------- */
  const activity = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.origin !== 'agent') continue;
      const d = (e.data ?? {}) as { artifactId?: string; reason?: string; proposalId?: string };
      if (e.type === 'proposal.submitted')
        return {
          text: `Proposed ${d.reason ? `“${d.reason}”` : 'a change'}`,
          ts: e.ts,
          proposalId: d.proposalId,
        };
      if (e.type === 'revision.committed' && d.artifactId) {
        const title = artifacts.find((v) => v.artifact.id === d.artifactId)?.artifact.title;
        if (title) return { text: `Revised ${title}`, ts: e.ts, artifactId: d.artifactId };
      }
    }
    return null;
  }, [events, artifacts]);

  const status = session ? (SESSION_LABELS[session.state] ?? session.state) : 'Not started';
  const placeholder = live
    ? context
      ? `Ask ${adapter?.label ?? 'the agent'} about ${context.artifact.title}…`
      : `Tell ${adapter?.label ?? 'the agent'} what to do next…`
    : adapter?.available
      ? `Start ${adapter.label} to work in this project`
      : `${adapter?.label ?? 'Agent'} is not detected on this machine`;

  return (
    <section className={`console ${open ? 'open' : ''} ${live ? 'live' : ''}`} aria-label="Agent">
      <div className="console-term" hidden={!open} style={{ height }}>
        <div
          className="console-resize"
          onPointerDown={onResizeStart}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize agent terminal"
        />
        <div className="console-term-head">
          <span
            className={`console-session tone-${live ? 'signal' : session?.state === 'failed' ? 'err' : 'neutral'}`}
          >
            {live && <Pulse />}
            {adapter?.label ?? session?.adapterId} · {status}
          </span>
          {session?.waitingForReview && (
            <button type="button" className="decisions-pill" onClick={() => decide(null)}>
              <span className="state-dot" aria-hidden="true" />
              Waiting for your review
            </button>
          )}
          <span className="grow" />
          {findOpen && (
            <input
              className="console-find"
              aria-label="Find in terminal"
              autoFocus
              placeholder="Find in terminal"
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
          )}
          <IconButton size="sm" label="Find in terminal" onClick={() => setFindOpen((v) => !v)}>
            <MagnifyingGlass size={13} />
          </IconButton>
          {running ? (
            <>
              <IconButton size="sm" label="Interrupt agent" onClick={() => void interrupt()}>
                <Pause size={13} />
              </IconButton>
              <IconButton size="sm" label="Stop agent" onClick={() => void stop()}>
                <Stop size={13} />
              </IconButton>
            </>
          ) : (
            session && (
              <IconButton size="sm" label="Restart agent" onClick={() => void restart()}>
                <ArrowClockwise size={13} />
              </IconButton>
            )
          )}
        </div>
        <div className="console-screen">
          <div
            ref={host}
            className="terminal-host"
            aria-label="Agent terminal"
            aria-hidden={!session}
          />
          {!session && (
            <div className="console-idle">
              <p>
                {adapter?.available
                  ? `${adapter.label} runs here, in the project folder, exactly as in your own terminal.`
                  : `${adapter?.label ?? 'The selected agent'} was not found on this machine.`}
              </p>
              <p className="dim">
                Nothing an agent proposes becomes the baseline until you approve it.
              </p>
            </div>
          )}
        </div>
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <AgentMenu
          options={options}
          adapterId={adapterId}
          setAdapterId={setAdapterId}
          locked={running || starting}
          live={live}
          status={status}
          onSetup={() => set({ settingsOpen: true })}
        />
        <div className="composer-field">
          {context && (
            <span
              className="context-chip"
              title="Sent with your message so the agent knows what you mean"
            >
              <At size={12} />
              <span className="truncate">{context.artifact.title}</span>
              <button
                type="button"
                aria-label="Don’t include this object"
                onClick={() => setDismissedContext(context.artifact.id)}
              >
                <X size={10} />
              </button>
            </span>
          )}
          <textarea
            ref={input}
            rows={1}
            aria-label="Message to the agent"
            placeholder={placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
        </div>
        {!session || !running ? (
          <button
            type="button"
            className="btn btn-signal btn-md composer-start"
            disabled={starting || !adapter?.available}
            onClick={() => void start()}
          >
            <Play size={13} weight="fill" />
            <span className="btn-label">
              {starting ? 'Starting…' : `Start ${shortName(adapter?.label)}`}
            </span>
          </button>
        ) : (
          <button
            type="submit"
            className="composer-send"
            aria-label="Send to agent (Enter)"
            title="Send to agent (Enter)"
            disabled={!live || !text.trim() || sending}
          >
            <ArrowUp size={15} weight="bold" />
          </button>
        )}
        {!open && activity && (
          <button
            type="button"
            className="composer-activity truncate"
            onClick={() =>
              activity.artifactId ? focus(activity.artifactId) : decide(activity.proposalId ?? null)
            }
            title={activity.text}
          >
            {activity.text} · {relativeTime(activity.ts)}
          </button>
        )}
        <IconButton
          label={open ? 'Hide terminal (⌘J)' : 'Show terminal (⌘J)'}
          onClick={() => set({ consoleOpen: !open })}
        >
          {open ? <CaretDown size={14} /> : <CaretUp size={14} />}
        </IconButton>
      </form>
    </section>
  );
}

function shortName(label?: string) {
  return (label ?? 'agent').replace(/ CLI$/, '');
}

function AgentMenu(props: {
  options: AdapterStatus[];
  adapterId: string;
  setAdapterId: (id: string) => void;
  locked: boolean;
  live: boolean;
  status: string;
  onSetup: () => void;
}) {
  const current = props.options.find((a) => a.adapterId === props.adapterId);
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button
          type="button"
          className="agent-chip"
          aria-label={`Agent: ${current?.label}, ${props.status}`}
        >
          <span
            className={`agent-light ${props.live ? 'live' : current?.available ? 'ready' : 'off'}`}
          />
          <span className="agent-chip-name">{shortName(current?.label)}</span>
          <CaretDown size={10} />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="menu" side="top" align="start" sideOffset={8}>
          <div className="menu-label">Agent {props.locked ? '· running' : ''}</div>
          {props.options.map((a) => (
            <Menu.Item
              key={a.adapterId}
              className="menu-item"
              disabled={props.locked}
              onSelect={() => props.setAdapterId(a.adapterId)}
            >
              <span className={`agent-light ${a.available ? 'ready' : 'off'}`} />
              <span className="grow">{a.label}</span>
              <span className="menu-hint">
                {a.available ? (a.version ?? 'Detected') : 'Not detected'}
              </span>
              {a.adapterId === props.adapterId && <Check size={13} />}
            </Menu.Item>
          ))}
          <Menu.Separator className="menu-sep" />
          <Menu.Item className="menu-item" onSelect={props.onSetup}>
            Set up agents and tools…
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
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
