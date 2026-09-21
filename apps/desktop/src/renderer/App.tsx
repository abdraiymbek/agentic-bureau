import React, { useEffect, useRef, useState } from 'react';
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from 'react-resizable-panels';
import {
  CaretRight,
  Cube,
  TerminalWindow,
  SlidersHorizontal,
  X,
  CheckCircle,
  WarningCircle,
} from '@phosphor-icons/react';
import { useStore } from './store';
import { TopBar } from './components/TopBar';
import { Sidebar, NAV_ITEMS } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { Inspector } from './components/Inspector';
import { TerminalPane } from './components/TerminalPane';
import { CommandPalette } from './components/CommandPalette';
import { ArtifactIcon, IconButton } from './components/ui';
import { WelcomeView } from './views/WelcomeView';
import { OverviewView } from './views/OverviewView';
import { RequirementsView } from './views/RequirementsView';
import { ComponentsView } from './views/ComponentsView';
import { ArtifactsView } from './views/ArtifactsView';
import { ReviewsView } from './views/ReviewsView';
import { HistoryView } from './views/HistoryView';
import { FilesView } from './views/FilesView';
import { ConnectionsView } from './views/ConnectionsView';
import { DesignSystemView } from './views/DesignSystemView';
import type { ProjectEvent } from '@omenflow/contracts';
import { COMMAND_ERROR_EVENT, formatRecoverableError, type RecoverableCommandError } from './api';

export default function App() {
  const {
    projectId,
    project,
    nav,
    set,
    pushEvent,
    terminalExpanded,
    toasts,
    theme,
    density,
    sidecarOpen,
    sidecarTab,
    sidebarOpen,
    artifacts,
    selectedArtifactId,
    session,
    navigate,
  } = useStore();
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<RecoverableCommandError | null>(null);
  const sidePanel = useRef<ImperativePanelHandle>(null);
  // The breadcrumb names the object being worked on, not just the section.
  const selected =
    nav === 'artifacts' || nav === 'requirements'
      ? artifacts.find((v) => v.artifact.id === selectedArtifactId)
      : undefined;
  const agentRunning = session?.state === 'running' || session?.state === 'starting';
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.density = density;
    try {
      localStorage.setItem('omen.theme', theme);
      localStorage.setItem('omen.density', density);
    } catch {
      /* preferences remain usable without storage */
    }
  }, [theme, density]);
  useEffect(() => {
    sidePanel.current?.resize(terminalExpanded ? 50 : 29);
  }, [terminalExpanded]);
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
    return () => {
      unService?.();
      un();
      unJob();
      unTerm();
    };
  }, [pushEvent, set]);
  useEffect(() => {
    const focusAgent = () => set({ sidecarOpen: true, sidecarTab: 'agent' });
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'k' || key === 'p') {
        e.preventDefault();
        set({ paletteOpen: key === 'k', quickOpen: key === 'p' });
      }
      if (key === 'j') {
        e.preventDefault();
        set({ sidecarOpen: !useStore.getState().sidecarOpen, sidecarTab: 'agent' });
      }
      if (key === 'b') {
        e.preventDefault();
        set({ sidebarOpen: !useStore.getState().sidebarOpen });
      }
      if (key === 'i' && e.shiftKey) {
        e.preventDefault();
        set({ sidecarOpen: true, sidecarTab: 'inspector' });
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('omenflow:focus-terminal', focusAgent);
    const onCommandError = (event: Event) => {
      const detail = (event as CustomEvent<RecoverableCommandError>).detail;
      if (detail?.code && detail.message) setCommandError(detail);
    };
    window.addEventListener(COMMAND_ERROR_EVENT, onCommandError);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('omenflow:focus-terminal', focusAgent);
      window.removeEventListener(COMMAND_ERROR_EVENT, onCommandError);
    };
  }, [set]);
  return (
    <div className="app-shell">
      <TopBar />
      {serviceError && (
        <div role="alert" className="inline-notice warning">
          {serviceError}
        </div>
      )}
      {commandError && (
        <div role="alert" className="inline-notice warning">
          <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
            <span>
              {commandError.op}: {formatRecoverableError(commandError)}
              <span className="mono dim"> {commandError.code}</span>
            </span>
            <IconButton label="Dismiss command error" onClick={() => setCommandError(null)}>
              <X size={14} />
            </IconButton>
          </div>
        </div>
      )}
      {!projectId ? (
        nav === 'design-system' ? (
          <div className="page-scroll">
            <button className="ghost" onClick={() => set({ nav: 'overview' })}>
              Back to projects
            </button>
            <DesignSystemView />
          </div>
        ) : (
          <WelcomeView />
        )
      ) : (
        <>
          <div className="workspace-shell">
            {sidebarOpen && <Sidebar />}
            <div className="workspace-content">
              <PanelGroup direction="horizontal" autoSaveId="omen-workspace-v1">
                <Panel minSize={40}>
                  <main className="main-panel">
                    <nav className="breadcrumb-bar" aria-label="Location">
                      <Cube size={14} />
                      <button
                        className="crumb truncate"
                        onClick={() => navigate('overview')}
                        title={project?.name}
                      >
                        {project?.name}
                      </button>
                      <CaretRight size={11} />
                      <span className={selected ? 'crumb' : 'crumb current'}>
                        {NAV_ITEMS.find((n) => n.id === nav)?.label}
                      </span>
                      {selected && (
                        <>
                          <CaretRight size={11} />
                          <span className="crumb current truncate" title={selected.artifact.title}>
                            <ArtifactIcon type={selected.artifact.type} size={13} />
                            {selected.artifact.title}
                          </span>
                        </>
                      )}
                    </nav>
                    <div className="surface">
                      <Surface nav={nav} />
                    </div>
                  </main>
                </Panel>
                <PanelResizeHandle className="resize-handle" hidden={!sidecarOpen} />
                <Panel
                  ref={sidePanel}
                  defaultSize={29}
                  minSize={22}
                  maxSize={55}
                  style={!sidecarOpen ? { display: 'none' } : undefined}
                >
                  <aside className="sidecar" aria-label="Agent and inspector">
                    <div className="sidecar-tabs">
                      <button
                        className={`sidecar-tab ${sidecarTab === 'agent' ? 'active' : ''}`}
                        aria-pressed={sidecarTab === 'agent'}
                        onClick={() => set({ sidecarTab: 'agent' })}
                      >
                        <TerminalWindow size={14} />
                        Agent
                        {agentRunning && (
                          <span className="live-dot" aria-label="Agent session running" />
                        )}
                      </button>
                      <button
                        className={`sidecar-tab ${sidecarTab === 'inspector' ? 'active' : ''}`}
                        aria-pressed={sidecarTab === 'inspector'}
                        onClick={() => set({ sidecarTab: 'inspector' })}
                      >
                        <SlidersHorizontal size={14} />
                        Inspector
                      </button>
                      <span className="grow" />
                      <IconButton
                        label="Close side panel"
                        onClick={() => set({ sidecarOpen: false })}
                      >
                        <X size={14} />
                      </IconButton>
                    </div>
                    <div className="sidecar-content" hidden={sidecarTab !== 'agent'}>
                      <TerminalPane key={projectId} />
                    </div>
                    <div className="sidecar-content" hidden={sidecarTab !== 'inspector'}>
                      <Inspector />
                    </div>
                  </aside>
                </Panel>
              </PanelGroup>
            </div>
          </div>
          <StatusBar />
        </>
      )}
      <CommandPalette />
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast" role={t.kind === 'error' ? 'alert' : 'status'}>
            {t.kind === 'error' ? (
              <WarningCircle size={16} className="err" />
            ) : (
              <CheckCircle size={16} className={t.kind === 'ok' ? 'ok' : 'dim'} />
            )}
            <span>{t.text}</span>
            <IconButton
              label="Dismiss notification"
              onClick={() =>
                set({ toasts: useStore.getState().toasts.filter((x) => x.id !== t.id) })
              }
            >
              <X size={13} />
            </IconButton>
          </div>
        ))}
      </div>
    </div>
  );
}
function Surface({ nav }: { nav: string }) {
  switch (nav) {
    case 'requirements':
      return <RequirementsView />;
    case 'components':
      return <ComponentsView />;
    case 'artifacts':
      return <ArtifactsView />;
    case 'reviews':
      return <ReviewsView />;
    case 'history':
      return <HistoryView />;
    case 'files':
      return <FilesView />;
    case 'connections':
      return <ConnectionsView />;
    case 'design-system':
      return <DesignSystemView />;
    default:
      return <OverviewView />;
  }
}
