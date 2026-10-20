import React, { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ProjectEvent, SessionInfo } from '@omenflow/contracts';
import { useStore, type View } from './store';
import { LENSES } from './project/lenses';
import { CommandError } from './api';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { Titlebar } from './shell/Titlebar';
import { ActivityBar } from './shell/ActivityBar';
import { Launcher } from './launcher/Launcher';
import { ProjectView } from './project/ProjectView';
import { FrameStrip } from './frame/FrameStrip';
import { LeavePrompt } from './frame/LeavePrompt';
import { ProjectLoading, StageFallback } from './frame/StageStates';
import { Toasts } from './frame/Toasts';
import { focusKind, topmostLayer } from './lib/layers';
import { resolveShortcut, type ShortcutAction } from './lib/shortcuts';
import { hasSavedScroll, recordScroll, restoreScroll, viewKey } from './lib/view-memory';
import { lazyView } from './lib/lazy-view';
import { perfMeasure } from './lib/perf';
import { installNativeShutdownGuard } from './lib/native-shutdown';

// Heavy, rarely-first views load on demand: three.js and the stages, the decision view,
// the catalogue, xterm, the omnibar and settings. The launcher and the project lenses' frame
// stay in the entry.
const ObjectView = lazyView(() => import('./object/ObjectView').then((m) => m.ObjectView));
const DecideView = lazyView(() => import('./decide/DecideView').then((m) => m.DecideView));
const DesignSystemView = lazyView(() =>
  import('./system/DesignSystemView').then((m) => m.DesignSystemView),
);
const AgentSurface = lazyView(() => import('./shell/Agent').then((m) => m.AgentSurface));
// The omnibar and the settings sheet mount the first time they open, from chunks fetched
// ahead with the views above.
const Omnibar = lazyView(() => import('./shell/Omnibar').then((m) => m.Omnibar));
const Settings = lazyView(() => import('./shell/Settings').then((m) => m.Settings));

/** True from the first time `open` is true: a layer stays mounted so it can animate closed. */
function useOpened(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened || open;
}

const mac =
  typeof navigator !== 'undefined' &&
  (/Mac|iPhone|iPad/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent));

/** How long a returning view's scroll position is held while its content arrives. */
const RESTORE_MS = 1500;

const lensFor = (digit: string) => LENSES.find((l) => String(l.shortcut) === digit)?.id;

/** How deep each place sits in the zoom model: project, then one object, then one decision. */
const DEPTH: Record<View['level'], number> = {
  agent: 0,
  project: 0,
  system: 0,
  object: 1,
  decide: 2,
};

/** A press this recent is where a zoom in started from (the node, link or row pressed). */
const ORIGIN_MS = 1000;

/** The error boundary for the stage starts afresh for each place, not for each lens switch. */
function stageKey(view: View) {
  return view.level === 'object' ? `object:${view.id}` : view.level;
}

const STAGE_LABELS: Record<View['level'], string> = {
  agent: 'The agent tab',
  project: 'The project view',
  object: 'This object',
  decide: 'The decision view',
  system: 'The design system view',
};

function Stage({ view, projectId }: { view: View; projectId: string | null }) {
  const firstLoadComplete = useStore((s) => s.firstLoadComplete);
  if (view.level === 'agent') return null;
  if (view.level === 'system') return <DesignSystemView.Component />;
  if (!projectId) return <Launcher />;
  if (!firstLoadComplete) return <ProjectLoading />;
  if (view.level === 'object') return <ObjectView.Component key={view.id} id={view.id} />;
  if (view.level === 'decide') return <DecideView.Component />;
  return <ProjectView lens={view.lens} />;
}

export default function App() {
  const projectId = useStore((s) => s.projectId);
  const view = useStore((s) => s.view);
  const firstLoadComplete = useStore((s) => s.firstLoadComplete);
  const omnibarOpened = useOpened(useStore((s) => s.omniOpen));
  const settingsOpened = useOpened(useStore((s) => s.settingsOpen));
  const [serviceError, setServiceError] = useState<string | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const key = viewKey(view);
  const currentKey = useRef(key);
  const restoring = useRef(false);
  /** The last element outside the agent window that had focus, to hand focus back to. */
  const workspaceFocus = useRef<HTMLElement | null>(null);
  /** Where the last press in the stage landed, as a transform origin for the next zoom in. */
  const press = useRef<{ origin: string; at: number } | null>(null);
  useEffect(() => installNativeShutdownGuard(window.omenflow), []);
  // Arriving at a deeper level zooms in (from the press that asked for it), arriving at a wider
  // one zooms out; moving across a level does not move the stage.
  const motion = useRef<{ key: string; depth: number; zoom?: 'in' | 'out'; origin?: string }>({
    key,
    depth: DEPTH[view.level],
  });
  if (motion.current.key !== key) {
    const depth = DEPTH[view.level];
    const from = motion.current.depth;
    const zoom = depth > from ? 'in' : depth < from ? 'out' : undefined;
    const recent = press.current && performance.now() - press.current.at < ORIGIN_MS;
    motion.current = {
      key,
      depth,
      zoom,
      origin: zoom === 'in' && recent ? press.current!.origin : undefined,
    };
  }

  useEffect(() => {
    perfMeasure('first-render', 'start');
    // Fetch the views a person opens next once the first screen is up.
    const timer = setTimeout(() => {
      for (const view of [ObjectView, DecideView, Omnibar, Settings])
        void view.preload().catch(() => {});
    }, 1500);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const s = useStore.getState();
    const mine = (value: unknown) => {
      const id = (value as { projectId?: string } | null)?.projectId;
      return !id || id === useStore.getState().projectId;
    };
    const un = window.omenflow.onEvent((e) => {
      if (mine(e)) s.pushEvent(e as ProjectEvent);
    });
    const unJob = window.omenflow.onJobProgress((e) => {
      if (mine(e)) s.invalidate(['jobs']);
    });
    const unTerm = window.omenflow.onTerminalState((value) => {
      if (mine(value))
        s.receiveSession(
          (value && typeof value === 'object' && 'session' in value
            ? value.session
            : value) as SessionInfo | null,
        );
    });
    const unService = window.omenflow.onServiceState?.((state) =>
      setServiceError(state.available ? null : (state.message ?? 'Workspace service unavailable')),
    );
    // An operation that failed with nobody to tell the person reaches the frame once.
    const onRejection = (event: PromiseRejectionEvent) => {
      const error: unknown = event.reason;
      if (!(error instanceof CommandError)) return;
      useStore.getState().reportError({
        op: error.op ?? 'operation',
        code: error.code,
        message: error.message,
        repair: error.repair,
      });
    };
    const onFocusIn = (event: FocusEvent) => {
      const el = event.target as HTMLElement | null;
      if (el?.closest && !el.closest('.agent-surface')) workspaceFocus.current = el;
    };
    window.addEventListener('unhandledrejection', onRejection);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      unService?.();
      un();
      unJob();
      unTerm();
      window.removeEventListener('unhandledrejection', onRejection);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, []);

  useEffect(() => {
    /** Gives focus back to where it was before the agent window took it. */
    const returnFocus = () => {
      const target = workspaceFocus.current;
      if (target?.isConnected) target.focus();
      else stage.current?.focus();
    };
    const run = (action: ShortcutAction) => {
      const s = useStore.getState();
      switch (action.kind) {
        case 'omnibar':
          return s.set({ omniOpen: !s.omniOpen });
        case 'settings':
          return s.set({ settingsOpen: !s.settingsOpen });
        case 'agent-window':
          if (s.agentWindowOpen && document.activeElement?.closest('.agent-surface')) returnFocus();
          return s.set({ agentWindowOpen: !s.agentWindowOpen });
        case 'release-agent-window':
          return returnFocus();
        case 'back':
          return s.goBack();
        case 'forward':
          return s.goForward();
        case 'decisions':
          return s.decide(null);
        case 'lens':
          return s.go({ level: 'project', lens: action.lens });
        case 'zoom-out':
          return s.zoomOut();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const action = resolveShortcut(
        {
          key: e.key,
          mod: mac ? e.metaKey : e.ctrlKey,
          shift: e.shiftKey,
          alt: e.altKey,
          repeat: e.repeat,
          composing: e.isComposing,
          defaultPrevented: e.defaultPrevented,
        },
        {
          layer: topmostLayer(),
          focus: focusKind(e.target),
          hasProject: !!s.projectId,
          view: s.view.level,
          lensFor,
        },
      );
      if (!action) return;
      e.preventDefault();
      run(action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Remember where each scrolling region of the stage was, per view. While a return is being
  // restored, scrolls come from late content, not the person, and are not recorded.
  useLayoutEffect(() => {
    currentKey.current = key;
  }, [key]);
  useEffect(() => {
    const root = stage.current;
    if (!root) return;
    const onScroll = (event: Event) => {
      if (!restoring.current && event.target instanceof Element && root.contains(event.target))
        recordScroll(currentKey.current, event.target, root);
    };
    root.addEventListener('scroll', onScroll, true);
    return () => root.removeEventListener('scroll', onScroll, true);
  }, []);
  // On return, hold the remembered position while the view's content arrives, until the person
  // scrolls or the content has had time to settle.
  useLayoutEffect(() => {
    const root = stage.current;
    if (!root || !hasSavedScroll(key)) return;
    const until = performance.now() + RESTORE_MS;
    let frame = 0;
    const stop = () => {
      restoring.current = false;
      cancelAnimationFrame(frame);
      for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
        root.removeEventListener(type, stop, true);
    };
    const step = () => {
      restoreScroll(key, root);
      if (performance.now() < until) frame = requestAnimationFrame(step);
      else stop();
    };
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
      root.addEventListener(type, stop, true);
    restoring.current = true;
    step();
    return stop;
  }, [key, firstLoadComplete]);

  return (
    <div className="app">
      <ErrorBoundary label="The title bar">
        <Titlebar />
      </ErrorBoundary>
      <FrameStrip serviceError={serviceError} />
      <div className="workbench">
        {projectId && (
          <ErrorBoundary label="The activity bar">
            <ActivityBar />
          </ErrorBoundary>
        )}
        <div className="workbench-main">
          <div
            className="stage-area"
            ref={stage}
            tabIndex={-1}
            data-zoom={motion.current.zoom}
            style={
              motion.current.origin
                ? ({ '--zoom-origin': motion.current.origin } as React.CSSProperties)
                : undefined
            }
            onPointerDownCapture={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              press.current = {
                origin: `${Math.round(e.clientX - box.left)}px ${Math.round(e.clientY - box.top)}px`,
                at: performance.now(),
              };
            }}
          >
            <ErrorBoundary key={stageKey(view)} label={STAGE_LABELS[view.level]}>
              <Suspense fallback={<StageFallback />}>
                <Stage view={view} projectId={projectId} />
              </Suspense>
            </ErrorBoundary>
          </div>
          {projectId && (
            <ErrorBoundary key={projectId} label="The agent terminal">
              <Suspense fallback={view.level === 'agent' ? <StageFallback /> : null}>
                <AgentSurface.Component />
              </Suspense>
            </ErrorBoundary>
          )}
        </div>
      </div>
      {omnibarOpened && (
        <ErrorBoundary label="The omnibar">
          <Suspense fallback={null}>
            <Omnibar.Component />
          </Suspense>
        </ErrorBoundary>
      )}
      {settingsOpened && (
        <ErrorBoundary label="Settings">
          <Suspense fallback={null}>
            <Settings.Component />
          </Suspense>
        </ErrorBoundary>
      )}
      <LeavePrompt />
      <Toasts />
    </div>
  );
}
