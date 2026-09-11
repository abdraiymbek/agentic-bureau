import React from 'react';
import { MagnifyingGlass, Command, PlugsConnected, Globe } from '@phosphor-icons/react';
import { useStore } from '../store';

export function TopBar() {
  const { project, set, adapters, session } = useStore();
  const connected = adapters.filter((a) => a.available).length;
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
      <button
        style={{ ...({ WebkitAppRegion: 'no-drag' } as object), height: 26, maxWidth: 220 }}
        className="dim"
        title="Switch project"
        onClick={() => set({ nav: 'overview', selectedArtifactId: null })}
      >
        {project ? project.name : 'No project'} ▾
      </button>
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
        <span className={`pill ${session?.state === 'running' ? 'current' : ''}`} style={{ height: 22 }}>
          {session ? `Agent: ${session.adapterId}` : 'No agent'}
        </span>
        <Command size={14} className="faint" />
      </div>
    </div>
  );
}
