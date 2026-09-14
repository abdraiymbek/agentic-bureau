import React, { useEffect, useRef, useState } from 'react';
import { MagnifyingGlass, Command, PlugsConnected, Globe } from '@phosphor-icons/react';
import { cmd } from '../api';
import { useStore } from '../store';

export function TopBar() {
  const { project, projectId, set, adapters, session } = useStore();
  const connected = adapters.filter((a) => a.available).length;
  const [menuOpen, setMenuOpen] = useState(false);
  const [openProjects, setOpenProjects] = useState<{ id: string; name: string; root: string }[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    void cmd<{ projects: typeof openProjects }>('project.list_open')
      .then((r) => setOpenProjects(r.projects))
      .catch(() => {});
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const closeProject = async () => {
    try {
      await cmd('project.close', {}, { projectId: projectId ?? undefined });
    } catch {
      /* fall through to UI reset either way */
    }
    set({ project: null, projectId: null, selectedArtifactId: null, nav: 'overview' });
    setMenuOpen(false);
  };
  return (
    <div
      style={{
        height: 40,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 12px 0 84px',
        background: 'var(--bg-app)',
        borderBottom: '1px solid var(--border)',
        ...({ WebkitAppRegion: 'drag' } as object),
      }}
    >
      <span style={{ fontWeight: 600, fontSize: 13, letterSpacing: '0.04em' }}>STARK</span>
      <div ref={menuRef} style={{ position: 'relative' }}>
        <button
          style={{ ...({ WebkitAppRegion: 'no-drag' } as object), height: 26, maxWidth: 220 }}
          className="dim"
          title="Switch project"
          onClick={() => setMenuOpen((o) => !o)}
        >
          {project ? project.name : 'No project'} ▾
        </button>
        {menuOpen && (
          <div
            style={{
              position: 'absolute',
              top: 30,
              left: 0,
              minWidth: 240,
              background: 'var(--bg-raised)',
              border: '1px solid var(--border-strong)',
              borderRadius: 6,
              boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
              padding: 4,
              zIndex: 100,
              fontSize: 13,
            }}
          >
            {openProjects
              .filter((p) => p.id !== projectId)
              .map((p) => (
                <MenuItem
                  key={p.id}
                  label={p.name}
                  onClick={() => {
                    const s = useStore.getState();
                    s.set({
                      project: { id: p.id, name: p.name } as typeof project,
                      projectId: p.id,
                      projectPath: p.root,
                      selectedArtifactId: null,
                      nav: 'overview',
                    });
                    void window.stark.setActiveProject(p.id);
                    void s.refreshArtifacts();
                    void s.refreshProposals();
                    void s.refreshEvents();
                    void s.refreshSession();
                    void s.refreshJobs();
                    setMenuOpen(false);
                  }}
                />
              ))}
            {openProjects.length > 1 && <Divider />}
            <MenuItem
              label="Open / import project…"
              onClick={() => {
                set({ project: null, projectId: null, selectedArtifactId: null });
                setMenuOpen(false);
              }}
            />
            <MenuItem label="Close project" onClick={() => void closeProject()} />
          </div>
        )}
      </div>
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
        <button
          style={{ ...({ WebkitAppRegion: 'no-drag' } as object), width: 320, textAlign: 'left' }}
          className="dim"
          onClick={() => set({ paletteOpen: true })}
        >
          <MagnifyingGlass size={12} style={{ marginRight: 6 }} />
          Search / commands
          <span style={{ float: 'right' }} className="faint">
            ⌘K
          </span>
        </button>
      </div>
      <div className="row" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          className="dim"
          style={{ height: 26 }}
          title="Research browser"
          onClick={() => void window.stark.toggleResearch()}
        >
          <Globe size={13} />
        </button>
        <button
          className="dim"
          style={{ height: 26 }}
          title="Connections"
          onClick={() => set({ nav: 'connections' })}
        >
          <PlugsConnected size={13} /> {connected || ''}
        </button>
        <span
          className={`pill ${session?.state === 'running' ? 'current' : ''}`}
          style={{ height: 22 }}
        >
          {session ? `Agent: ${session.adapterId}` : 'No agent'}
        </span>
        <Command size={14} className="faint" />
      </div>
    </div>
  );
}

function MenuItem(props: { label: string; onClick: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={props.onClick}
      onKeyDown={(e) => e.key === 'Enter' && props.onClick()}
      style={{ padding: '6px 10px', borderRadius: 4, cursor: 'pointer' }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-main)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {props.label}
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: 'var(--border)', margin: '4px 6px' }} />;
}
