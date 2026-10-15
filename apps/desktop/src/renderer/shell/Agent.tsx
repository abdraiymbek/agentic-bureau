import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { flushAsks, startAgentFromSurface as startAdapter } from '../lib/actions';
import { useAgentUi } from './agent/agent-store';
import { ActivityRail, ActivityTicker } from './agent/ActivityRail';
import { detectAgents, loadActivity, subscribeCalls } from './agent/feed';
import { EndedBar, PendingBar, SurfacePanel } from './agent/Onboarding';
import { autostartAdapter, surfacePhase } from './agent/phase';
import { SessionBar, WindowHeader } from './agent/SessionBar';
import { sessionStatus } from './agent/session-view';
import { TerminalEngine } from './agent/terminal';
import { TerminalSearch } from './agent/TerminalSearch';
import { useFloatingWindow } from './agent/useFloatingWindow';

type Mode = 'tab' | 'window' | 'docked' | 'hidden';

/**
 * The one agent surface. It stays mounted for the life of the open project so the terminal, the
 * PTY listeners and the scrollback survive navigation; only its presentation changes — the Agent
 * tab, a floating or docked window, or hidden.
 */
export function AgentSurface() {
  const projectId = useStore((s) => s.projectId)!;
  const session = useStore((s) => s.session);
  const adapters = useStore((s) => s.adapters);
  const agentId = useStore((s) => s.agentId);
  const view = useStore((s) => s.view);
  const windowOpen = useStore((s) => s.agentWindowOpen);
  const readOnly = useStore((s) => s.readOnly);
  const set = useStore((s) => s.set);
  const detection = useAgentUi((s) => s.detection);
  const start = useAgentUi((s) => s.start);
  const sessionChecked = useAgentUi((s) => s.sessionChecked);
  const inputReady = useAgentUi((s) => s.inputReady);
  const pending = useAgentUi((s) => s.pending.length);
  const railOpen = useAgentUi((s) => s.railOpen);

  const root = useRef<HTMLElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<TerminalEngine | null>(null);
  const [searching, setSearching] = useState(false);
  const win = useFloatingWindow(root);
  const { docked, collapsed } = win.prefs;

  const mode: Mode =
    view.level === 'agent' ? 'tab' : windowOpen ? (docked ? 'docked' : 'window') : 'hidden';
  const status = sessionStatus(session);
  const phase = surfacePhase({ readOnly, session, adapters, detection, start, agentId });
  const autoId = autostartAdapter(phase);
  const restartable =
    adapters.find((a) => a.adapterId === session?.adapterId && a.available) ??
    adapters.find((a) => a.adapterId === agentId && a.available) ??
    null;
  const startId = restartable?.adapterId ?? null;

  // The surface lives exactly as long as the open project; so does the agent state it shows.
  useLayoutEffect(() => {
    useAgentUi.getState().enterProject(projectId);
    return () => useAgentUi.getState().enterProject(null);
  }, [projectId]);

  /* ---------------- terminal and host feeds ---------------- */
  useEffect(() => {
    const created = new TerminalEngine(projectId);
    created.open(host.current!);
    setEngine(created);
    const onFocus = () => requestAnimationFrame(() => created.focus());
    window.addEventListener('omenflow:focus-terminal', onFocus);
    void detectAgents();
    void loadActivity(projectId);
    const unsubscribe = subscribeCalls(projectId);
    return () => {
      window.removeEventListener('omenflow:focus-terminal', onFocus);
      unsubscribe?.();
      created.dispose();
      setEngine(null);
    };
  }, [projectId]);

  const sessionId = session?.id ?? null;
  const sessionState = session?.state ?? null;
  useEffect(() => {
    engine?.setSession(sessionId && sessionState ? { id: sessionId, state: sessionState } : null);
  }, [engine, sessionId, sessionState]);

  /* ---------------- autostart and the ask queue ---------------- */
  const autostarted = useRef(false);
  useEffect(() => {
    if (autostarted.current || !sessionChecked || mode === 'hidden' || !autoId || !engine) return;
    autostarted.current = true;
    startAdapter(autoId);
  }, [sessionChecked, mode, autoId, engine]);

  useEffect(() => {
    if (status.live && inputReady && pending) flushAsks();
  }, [status.live, inputReady, pending]);

  /* ---------------- presentation changes and focus ---------------- */
  const previous = useRef<Mode>(mode);
  const returnFocus = useRef<HTMLElement | null>(null);
  const live = status.live;
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = mode;
    if (before === mode) return;
    const active = document.activeElement as HTMLElement | null;
    const inside = !!active && !!root.current?.contains(active);
    if (before === 'hidden') {
      if (active && active !== document.body && !inside) returnFocus.current = active;
      engine?.fit();
      if (live) requestAnimationFrame(() => engine?.focus());
    } else if (mode === 'hidden') {
      setSearching(false);
      // Closing the window must not strand focus on a terminal nobody can see.
      if (before !== 'tab' && (inside || !active || active === document.body)) {
        const back = returnFocus.current?.isConnected
          ? returnFocus.current
          : document.querySelector<HTMLElement>('[data-agent-window-toggle]');
        back?.focus();
      }
      returnFocus.current = null;
    } else {
      engine?.fit();
    }
  }, [mode, engine, live]);

  // A session going live takes focus only if nothing else has it.
  useEffect(() => {
    if (!live || mode === 'hidden') return;
    const active = document.activeElement;
    if (active && active !== document.body && !root.current?.contains(active)) return;
    const frame = requestAnimationFrame(() => engine?.focus());
    return () => cancelAnimationFrame(frame);
  }, [live, mode, engine]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const key = e.key.toLowerCase();
    if (session && key === 'f' && (e.metaKey || (e.ctrlKey && e.shiftKey))) {
      e.preventDefault();
      setSearching(true);
    }
  };

  const style: React.CSSProperties | undefined =
    mode === 'window' && win.rect && win.bounds
      ? {
          left: win.rect.x,
          bottom: win.bounds.height - win.rect.y - win.rect.h,
          width: win.rect.w,
          height: collapsed ? undefined : win.rect.h,
        }
      : mode === 'docked'
        ? { width: win.dockWidth }
        : undefined;

  const floating = mode === 'window' || mode === 'docked';
  return (
    <section
      ref={root}
      className={[
        'agent-surface',
        `mode-${mode}`,
        status.live ? 'live' : '',
        mode === 'window' && collapsed ? 'collapsed' : '',
        win.dragging ? 'dragging' : '',
      ].join(' ')}
      style={style}
      aria-label="Agent"
      onKeyDown={onKeyDown}
    >
      {mode === 'tab' && <SessionBar engine={engine} onSearch={() => setSearching(true)} />}
      {floating && (
        <WindowHeader
          engine={engine}
          onSearch={() => {
            if (collapsed) useAgentUi.getState().setWindow({ collapsed: false });
            setSearching(true);
          }}
          docked={docked}
          collapsed={collapsed}
          onDock={() => useAgentUi.getState().setWindow({ docked: !docked })}
          onCollapse={() => useAgentUi.getState().setWindow({ collapsed: !collapsed })}
          onClose={() => set({ agentWindowOpen: false })}
          onPointerDown={win.onHeaderPointerDown}
          startLabel={restartable?.label ?? null}
          onStart={() => startId && startAdapter(startId)}
        />
      )}
      {floating && <ActivityTicker />}
      <div className="agent-body">
        <div className="agent-screen">
          <div
            ref={host}
            className="terminal-host"
            aria-label="Agent terminal"
            aria-hidden={!session}
          />
          {searching && engine && (
            <TerminalSearch engine={engine} onClose={() => setSearching(false)} />
          )}
          {!session && <SurfacePanel phase={phase} />}
          <EndedBar phase={phase} startId={startId} />
          <PendingBar live={status.live} />
        </div>
        {mode === 'tab' && railOpen && <ActivityRail />}
      </div>
      {mode === 'window' && !collapsed && (
        <button
          type="button"
          className="agent-resize"
          aria-label="Resize agent window (arrow keys)"
          onPointerDown={win.onResizePointerDown}
          onKeyDown={win.onResizeKey}
        />
      )}
      {mode === 'docked' && (
        <button
          type="button"
          className="agent-dock-edge"
          aria-label="Resize docked agent (left and right arrow keys)"
          onPointerDown={win.onDockPointerDown}
          onKeyDown={win.onDockKey}
        />
      )}
    </section>
  );
}
