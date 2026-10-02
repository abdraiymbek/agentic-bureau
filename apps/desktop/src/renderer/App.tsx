import React, { useEffect, useState } from 'react';
import { CheckCircle, WarningCircle, Info, X } from '@phosphor-icons/react';
import type { ProjectEvent } from '@omenflow/contracts';
import { useStore } from './store';
import { COMMAND_ERROR_EVENT, formatRecoverableError, type RecoverableCommandError } from './api';
import { IconButton } from './ui/kit';
import { Titlebar } from './shell/Titlebar';
import { ActivityBar } from './shell/ActivityBar';
import { Omnibar } from './shell/Omnibar';
import { AgentSurface } from './shell/Agent';
import { Settings } from './shell/Settings';
import { Launcher } from './launcher/Launcher';
import { ProjectView } from './project/ProjectView';
import { ObjectView } from './object/ObjectView';
import { DecideView } from './decide/DecideView';
import { DesignSystemView } from './system/DesignSystemView';

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) ||
    el.isContentEditable ||
    !!el.closest?.('.xterm')
  );
}

export default function App() {
  const projectId = useStore((s) => s.projectId);
  const view = useStore((s) => s.view);
  const theme = useStore((s) => s.theme);
  const toasts = useStore((s) => s.toasts);
  const set = useStore((s) => s.set);
  const pushEvent = useStore((s) => s.pushEvent);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<RecoverableCommandError | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('omen.theme', theme);
    } catch {
      /* preferences remain usable without storage */
    }
  }, [theme]);

  useEffect(() => {
    const native = '__TAURI_INTERNALS__' in window;
    const mac = /Mac/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent);
    if (native && mac) document.documentElement.dataset.chrome = 'mac-overlay';
  }, []);

  useEffect(() => {
    const matches = (e: unknown) =>
      !(e as { projectId?: string })?.projectId ||
      (e as { projectId: string }).projectId === useStore.getState().projectId;
    const un = window.omenflow.onEvent((e) => {
      if (matches(e)) pushEvent(e as ProjectEvent);
    });
    const unJob = window.omenflow.onJobProgress((e) => {
      if (matches(e))
        void useStore
          .getState()
          .refreshJobs()
          .catch(() => {});
    });
    const unTerm = window.omenflow.onTerminalState((s) => {
      if (matches(s))
        set({ session: (s && typeof s === 'object' && 'session' in s ? s.session : s) as never });
    });
    const unService = window.omenflow.onServiceState?.((state) =>
      setServiceError(state.available ? null : (state.message ?? 'Workspace service unavailable')),
    );
    const onCommandError = (event: Event) => {
      const detail = (event as CustomEvent<RecoverableCommandError>).detail;
      if (detail?.code && detail.message) setCommandError(detail);
    };
    window.addEventListener(COMMAND_ERROR_EVENT, onCommandError);
    return () => {
      unService?.();
      un();
      unJob();
      unTerm();
      window.removeEventListener(COMMAND_ERROR_EVENT, onCommandError);
    };
  }, [pushEvent, set]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && (key === 'k' || key === 'p')) {
        e.preventDefault();
        set({ omniOpen: !s.omniOpen });
        return;
      }
      if (mod && key === ',') {
        e.preventDefault();
        set({ settingsOpen: true });
        return;
      }
      if (!s.projectId) return;
      if (mod && key === 'j') {
        e.preventDefault();
        if (s.view.level !== 'agent') set({ agentWindowOpen: !s.agentWindowOpen });
        return;
      }
      if (mod && key === '[') {
        e.preventDefault();
        s.goBack();
        return;
      }
      if (mod && e.shiftKey && key === 'd') {
        e.preventDefault();
        s.decide(null);
        return;
      }
      if (mod && ['1', '2', '3', '4'].includes(key)) {
        e.preventDefault();
        const lens = (['flow', 'parts', 'timeline', 'files'] as const)[Number(key) - 1]!;
        s.go({ level: 'project', lens });
        return;
      }
      if (
        key === 'escape' &&
        !mod &&
        !s.omniOpen &&
        !s.settingsOpen &&
        !isTyping(e.target) &&
        !document.querySelector('[role="dialog"]')
      ) {
        s.zoomOut();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [set]);

  return (
    <div className="app">
      <Titlebar />
      {(serviceError || commandError) && (
        <div className="system-strip" role="alert">
          <WarningCircle size={14} />
          <span className="grow">
            {serviceError ??
              (commandError && (
                <>
                  {formatRecoverableError(commandError)}
                  <span className="mono dim"> · {commandError.op}</span>
                </>
              ))}
          </span>
          {commandError && !serviceError && (
            <IconButton size="sm" label="Dismiss" onClick={() => setCommandError(null)}>
              <X size={12} />
            </IconButton>
          )}
        </div>
      )}
      <div className="workbench">
        {projectId && <ActivityBar />}
        <div className="workbench-main">
          <div className="stage-area">
            {view.level === 'agent' ? null : view.level === 'system' ? (
              <DesignSystemView />
            ) : !projectId ? (
              <Launcher />
            ) : view.level === 'object' ? (
              <ObjectView key={view.id} id={view.id} />
            ) : view.level === 'decide' ? (
              <DecideView />
            ) : (
              <ProjectView lens={view.lens} />
            )}
          </div>
          {projectId && <AgentSurface key={projectId} />}
        </div>
      </div>
      <Omnibar />
      <Settings />
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast tone-${t.kind}`}
            role={t.kind === 'error' ? 'alert' : 'status'}
          >
            {t.kind === 'error' ? (
              <WarningCircle size={15} />
            ) : t.kind === 'ok' ? (
              <CheckCircle size={15} />
            ) : (
              <Info size={15} />
            )}
            <span>{t.text}</span>
            <IconButton
              size="sm"
              label="Dismiss notification"
              onClick={() =>
                set({ toasts: useStore.getState().toasts.filter((x) => x.id !== t.id) })
              }
            >
              <X size={12} />
            </IconButton>
          </div>
        ))}
      </div>
    </div>
  );
}
