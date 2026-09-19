import React, { useEffect } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useStore } from './store';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { Inspector } from './components/Inspector';
import { TerminalPane } from './components/TerminalPane';
import { CommandPalette } from './components/CommandPalette';
import { WelcomeView } from './views/WelcomeView';
import { OverviewView } from './views/OverviewView';
import { RequirementsView } from './views/RequirementsView';
import { ComponentsView } from './views/ComponentsView';
import { ArtifactsView } from './views/ArtifactsView';
import { ReviewsView } from './views/ReviewsView';
import { HistoryView } from './views/HistoryView';
import { FilesView } from './views/FilesView';
import { ConnectionsView } from './views/ConnectionsView';
import type { ProjectEvent } from '@omenflow/contracts';

export default function App() {
  const { projectId, nav, set, pushEvent, terminalExpanded, toasts } = useStore();

  // Global event stream → store.
  useEffect(() => {
    const un = window.omenflow.onEvent((e) => pushEvent(e as ProjectEvent));
    const unJob = window.omenflow.onJobProgress(() => void useStore.getState().refreshJobs());
    const unTerm = window.omenflow.onTerminalState((s) => set({ session: s as never }));
    return () => {
      un();
      unJob();
      unTerm();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Shortcuts: Cmd/Ctrl+K palette, Cmd/Ctrl+P quick-open, Cmd/Ctrl+J terminal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        set({ paletteOpen: true, quickOpen: false });
      }
      if (mod && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        set({ quickOpen: true, paletteOpen: false });
      }
      if (mod && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        const el = document.querySelector<HTMLElement>('[data-terminal-region]');
        if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
        window.dispatchEvent(new CustomEvent('omenflow:focus-terminal'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [set]);

  if (!projectId) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <WelcomeView />
        <Toasts items={toasts} />
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <TopBar />
      <div style={{ flex: 1, minHeight: 0 }}>
        <PanelGroup direction="horizontal" autoSaveId="omenflow-h">
          <Panel defaultSize={16} minSize={12} maxSize={24}>
            <Sidebar />
          </Panel>
          <PanelResizeHandle className="resize-handle" />
          <Panel minSize={40}>
            <PanelGroup direction="vertical" autoSaveId="omenflow-v">
              <Panel minSize={30}>
                <PanelGroup direction="horizontal" autoSaveId="omenflow-center">
                  <Panel minSize={40}>
                    <div
                      style={{ height: '100%', background: 'var(--bg-main)', overflow: 'hidden' }}
                    >
                      <Surface nav={nav} />
                    </div>
                  </Panel>
                  <PanelResizeHandle className="resize-handle" />
                  <Panel defaultSize={22} minSize={14} maxSize={32} collapsible>
                    <Inspector />
                  </Panel>
                </PanelGroup>
              </Panel>
              <PanelResizeHandle className="resize-handle-h" />
              <Panel
                defaultSize={terminalExpanded ? 55 : 32}
                minSize={15}
                collapsible
                data-terminal-region
              >
                <div data-terminal-region style={{ height: '100%' }}>
                  <TerminalPane />
                </div>
              </Panel>
            </PanelGroup>
          </Panel>
        </PanelGroup>
      </div>
      <StatusBar />
      <CommandPalette />
      <Toasts items={toasts} />
      <style>{`
        .resize-handle { width: 4px; background: var(--border); cursor: col-resize; }
        .resize-handle-h { height: 4px; background: var(--border); cursor: row-resize; }
        .resize-handle:hover, .resize-handle-h:hover { background: var(--accent); }
      `}</style>
    </div>
  );
}

function Surface({ nav }: { nav: string }) {
  switch (nav) {
    case 'overview':
      return <OverviewView />;
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
    default:
      return <OverviewView />;
  }
}

function Toasts({ items }: { items: { id: number; kind: string; text: string }[] }) {
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 40,
        right: 16,
        zIndex: 60,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {items.map((t) => (
        <div
          key={t.id}
          style={{
            background: 'var(--bg-raised)',
            border: `1px solid ${t.kind === 'error' ? 'var(--err)' : t.kind === 'ok' ? 'var(--ok)' : 'var(--border-strong)'}`,
            borderRadius: 6,
            padding: '8px 12px',
            fontSize: 12,
            maxWidth: 380,
          }}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
