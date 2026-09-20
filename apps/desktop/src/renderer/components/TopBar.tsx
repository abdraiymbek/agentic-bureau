import React from 'react';
import {
  MagnifyingGlass,
  SidebarSimple,
  Globe,
  Moon,
  Sun,
  TerminalWindow,
  SquaresFour,
} from '@phosphor-icons/react';
import { useStore } from '../store';
import { Brand, IconButton } from './ui';

export function TopBar() {
  const { set, sidebarOpen, sidecarOpen, theme, projectId } = useStore();
  return (
    <header className="titlebar">
      <Brand />
      {import.meta.env.DEV && new URLSearchParams(location.search).has('design-preview') && (
        <span className="preview-label">Design preview</span>
      )}
      <IconButton label="Toggle sidebar" onClick={() => set({ sidebarOpen: !sidebarOpen })}>
        <SidebarSimple size={17} />
      </IconButton>
      <button
        className="titlebar-search"
        onClick={() => set({ paletteOpen: true, quickOpen: false })}
      >
        <MagnifyingGlass size={14} />
        <span className="truncate">Search anything in your workspace</span>
        <kbd>⌘ K</kbd>
      </button>
      <div className="titlebar-actions">
        <IconButton
          label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={() => set({ theme: theme === 'dark' ? 'light' : 'dark' })}
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </IconButton>
        {projectId && (
          <>
            <IconButton
              label="Research browser"
              className="hide-narrow"
              onClick={() => void window.omenflow.toggleResearch()}
            >
              <Globe size={16} />
            </IconButton>
            <IconButton
              label="Toggle agent panel (⌘ J)"
              className={sidecarOpen ? 'active' : ''}
              onClick={() => set({ sidecarOpen: !sidecarOpen, sidecarTab: 'agent' })}
            >
              <TerminalWindow size={16} />
            </IconButton>
          </>
        )}
        <IconButton label="Design system" onClick={() => set({ nav: 'design-system' })}>
          <SquaresFour size={16} />
        </IconButton>
      </div>
    </header>
  );
}
