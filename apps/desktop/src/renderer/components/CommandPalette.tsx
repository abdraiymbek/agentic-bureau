import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, type Nav } from '../store';

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** Cmd+K palette: surfaces, artifacts, actions. Cmd+P = artifact quick open. */
export function CommandPalette() {
  const { paletteOpen, quickOpen, set, artifacts, navigate, selectArtifact } = useStore();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const open = paletteOpen || quickOpen;

  useEffect(() => {
    if (open) {
      setQ('');
      setIdx(0);
      setTimeout(() => input.current?.focus(), 30);
    }
  }, [open]);

  const actions: PaletteItem[] = useMemo(() => {
    const base: PaletteItem[] = [
      { id: 'nav:overview', label: 'Go to Overview', run: () => navigate('overview') },
      { id: 'nav:requirements', label: 'Go to Requirements', run: () => navigate('requirements') },
      { id: 'nav:components', label: 'Go to Components / BOM', run: () => navigate('components') },
      { id: 'nav:reviews', label: 'Go to Reviews', run: () => navigate('reviews') },
      { id: 'nav:history', label: 'Go to History / Graph', run: () => navigate('history') },
      { id: 'nav:files', label: 'Go to Files & export', run: () => navigate('files') },
      { id: 'nav:connections', label: 'Go to Connections', run: () => navigate('connections') },
      {
        id: 'term:focus',
        label: 'Focus terminal',
        hint: '⌘J',
        run: () => window.dispatchEvent(new CustomEvent('stark:focus-terminal')),
      },
      {
        id: 'term:toggle',
        label: 'Toggle terminal',
        hint: '⌘J',
        run: () => set({ terminalExpanded: false }),
      },
      {
        id: 'research:toggle',
        label: 'Toggle research browser',
        run: () => void window.stark.toggleResearch(),
      },
    ];
    if (quickOpen) return [];
    return base;
  }, [navigate, set, quickOpen]);

  const artifactItems: PaletteItem[] = useMemo(
    () =>
      artifacts.map((v) => ({
        id: `a:${v.artifact.id}`,
        label: v.artifact.title,
        hint: v.artifact.type,
        run: () => {
          selectArtifact(v.artifact.id);
          navigate('artifacts');
        },
      })),
    [artifacts, selectArtifact, navigate],
  );

  const items = useMemo(() => {
    const all = quickOpen ? artifactItems : [...actions, ...artifactItems];
    if (!q.trim()) return all.slice(0, 20);
    const needle = q.toLowerCase();
    return all
      .filter(
        (i) => i.label.toLowerCase().includes(needle) || i.hint?.toLowerCase().includes(needle),
      )
      .slice(0, 20);
  }, [q, actions, artifactItems, quickOpen]);

  if (!open) return null;

  const close = () => set({ paletteOpen: false, quickOpen: false });
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        zIndex: 50,
        display: 'flex',
        justifyContent: 'center',
        paddingTop: '12vh',
      }}
      onClick={close}
    >
      <div
        style={{
          width: 520,
          height: 'fit-content',
          maxHeight: '60vh',
          background: 'var(--bg-raised)',
          border: '1px solid var(--border-strong)',
          borderRadius: 6,
          overflow: 'hidden',
          boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={input}
          placeholder={quickOpen ? 'Open artifact…' : 'Search projects, artifacts, commands…'}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setIdx(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            if (e.key === 'ArrowDown') setIdx((i) => Math.min(i + 1, items.length - 1));
            if (e.key === 'ArrowUp') setIdx((i) => Math.max(i - 1, 0));
            if (e.key === 'Enter' && items[idx]) {
              items[idx]!.run();
              close();
            }
          }}
          style={{
            width: '100%',
            height: 40,
            fontSize: 14,
            border: 'none',
            borderBottom: '1px solid var(--border)',
            borderRadius: 0,
            background: 'var(--bg-raised)',
          }}
        />
        <div style={{ overflowY: 'auto', maxHeight: 'calc(60vh - 40px)' }}>
          {items.map((it, i) => (
            <div
              key={it.id}
              role="button"
              tabIndex={-1}
              onClick={() => {
                it.run();
                close();
              }}
              style={{
                padding: '8px 12px',
                cursor: 'pointer',
                display: 'flex',
                justifyContent: 'space-between',
                background: i === idx ? 'var(--bg-main)' : 'transparent',
                fontSize: 13,
              }}
            >
              <span>{it.label}</span>
              {it.hint && <span className="faint">{it.hint}</span>}
            </div>
          ))}
          {items.length === 0 && (
            <div className="faint" style={{ padding: 16, fontSize: 13 }}>
              No matches
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
