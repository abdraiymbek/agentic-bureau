import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { MagnifyingGlass, ArrowRight } from '@phosphor-icons/react';
import { useStore } from '../store';
import { NAV_ITEMS } from './Sidebar';

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}
export function CommandPalette() {
  const { paletteOpen, quickOpen, set, artifacts, navigate, selectArtifact, projectId } =
    useStore();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const open = paletteOpen || quickOpen;
  useEffect(() => {
    if (open) {
      setQ('');
      setIdx(0);
    }
  }, [open]);
  const items = useMemo(() => {
    const actions: PaletteItem[] = quickOpen
      ? []
      : [
          ...NAV_ITEMS.filter((n) => projectId || n.id === 'design-system').map((n) => ({
            id: n.id,
            label: `Open ${n.label.toLowerCase()}`,
            run: () => navigate(n.id),
            hint: 'Workspace',
          })),
          ...(projectId
            ? [
                {
                  id: 'agent',
                  label: 'Focus agent',
                  hint: '⌘ J',
                  run: () => {
                    set({ sidecarOpen: true, sidecarTab: 'agent' });
                    window.dispatchEvent(new CustomEvent('omenflow:focus-terminal'));
                  },
                },
                {
                  id: 'inspector',
                  label: 'Open inspector',
                  hint: '⌘ ⇧ I',
                  run: () => set({ sidecarOpen: true, sidecarTab: 'inspector' }),
                },
              ]
            : []),
          {
            id: 'theme',
            label: 'Switch appearance',
            hint: 'Light / dark',
            run: () => set({ theme: useStore.getState().theme === 'dark' ? 'light' : 'dark' }),
          },
        ];
    const objects: PaletteItem[] = projectId
      ? artifacts.map((v) => ({
          id: v.artifact.id,
          label: v.artifact.title,
          hint: v.artifact.type,
          run: () => {
            selectArtifact(v.artifact.id);
            navigate(
              ['requirement', 'assumption'].includes(v.artifact.type)
                ? 'requirements'
                : 'artifacts',
            );
          },
        }))
      : [];
    return [...actions, ...objects]
      .filter((i) => `${i.label} ${i.hint ?? ''}`.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 50);
  }, [q, quickOpen, projectId, artifacts, set, navigate, selectArtifact]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${idx}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [idx]);
  const close = () => set({ paletteOpen: false, quickOpen: false });
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dlg-overlay" />
        <Dialog.Content className="dlg command-dialog">
          <Dialog.Title className="sr-only">
            {quickOpen ? 'Open an object' : 'Search workspace commands'}
          </Dialog.Title>
          <Dialog.Description className="sr-only">
            Use the arrow keys to select a result and Enter to open it.
          </Dialog.Description>
          <div className="command-input">
            <MagnifyingGlass size={20} />
            <input
              autoFocus
              role="combobox"
              aria-label={quickOpen ? 'Find an object' : 'Search commands and objects'}
              aria-expanded="true"
              aria-controls="command-results"
              aria-activedescendant={items[idx] ? `command-${idx}` : undefined}
              placeholder={quickOpen ? 'Find an object…' : 'Where would you like to go?'}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setIdx(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setIdx((i) => Math.min(i + 1, Math.max(items.length - 1, 0)));
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setIdx((i) => Math.max(i - 1, 0));
                }
                if (e.key === 'Enter' && items[idx]) {
                  e.preventDefault();
                  items[idx]?.run();
                  close();
                }
              }}
            />
            <kbd>esc</kbd>
          </div>
          <div
            ref={list}
            className="command-list"
            id="command-results"
            role="listbox"
            aria-label="Search results"
          >
            {items.map((item, i) => (
              <div role="option" aria-selected={i === idx} id={`command-${i}`} key={item.id}>
                <button
                  tabIndex={-1}
                  data-index={i}
                  className={`command-item ${i === idx ? 'active' : ''}`}
                  onMouseMove={() => setIdx(i)}
                  onClick={() => {
                    item.run();
                    close();
                  }}
                >
                  <ArrowRight size={14} className="faint" />
                  <span className="grow">{item.label}</span>
                  <span className="faint">{item.hint}</span>
                </button>
              </div>
            ))}
            {!items.length && (
              <div className="empty-state">
                <h3>No matches</h3>
                <p>Try an object name or a workspace command.</p>
              </div>
            )}
          </div>
          <div className="command-footer">
            <span>
              <kbd>↑</kbd> <kbd>↓</kbd> to navigate
            </span>
            <span>
              <kbd>↵</kbd> to open
            </span>
            <span className="grow" />
            <span>Omen Flow</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
