import React, { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowRight,
  ArrowUp,
  FolderOpen,
  Plus,
  Package,
  House,
  HardDrive,
  Cube,
  ListChecks,
  GitBranch,
  X,
  SquaresFour,
  MagnifyingGlass,
} from '@phosphor-icons/react';
import { cmd, errMsg, CommandError } from '../api';
import { useStore } from '../store';
import { Brand, FormField, IconButton, EmptyState, SearchField } from '../components/ui';
import type { Project } from '@omenflow/contracts';
import './welcome.css';

export function WelcomeView() {
  const { set, setActive, toast, sidebarOpen } = useStore();
  const [recents, setRecents] = useState<string[]>([]);
  const [recentState, setRecentState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [showAllRecents, setShowAllRecents] = useState(false);
  const [recentAttempt, setRecentAttempt] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [intent, setIntent] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const operationPending = useRef(false);
  const newProjectButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let cancelled = false;
    setRecentState('loading');
    const timeout = window.setTimeout(() => {
      if (!cancelled) setRecentState('error');
    }, 8000);
    void cmd<{ projects: string[] }>('app.recent_projects')
      .then((r) => {
        window.clearTimeout(timeout);
        if (!cancelled) {
          setRecents(r.projects);
          setRecentState('ready');
        }
      })
      .catch(() => {
        window.clearTimeout(timeout);
        if (!cancelled) setRecentState('error');
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [recentAttempt]);

  const afterOpen = async (
    r: { project: Project; projectId: string; readOnly?: boolean },
    path: string,
  ) => {
    set({
      project: r.project,
      projectPath: path,
      readOnly: !!r.readOnly,
      nav: 'overview',
      selectedArtifactId: null,
      artifacts: [],
      proposals: [],
      events: [],
      jobs: [],
      session: null,
    });
    setActive(r.projectId);
    await useStore.getState().refreshArtifacts();
    await useStore.getState().refreshProposals();
    await useStore.getState().refreshEvents();
    await useStore.getState().refreshSession();
    await useStore.getState().refreshJobs();
    await useStore.getState().refreshAdapters();
  };

  // Include native pickers in the operation, so cancellation and picker failures
  // release the controls and repeated clicks cannot launch duplicate dialogs.
  const run = async (operation: () => Promise<void>) => {
    if (operationPending.current) return;
    operationPending.current = true;
    setBusy(true);
    try {
      await operation();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  };

  const create = () =>
    run(async () => {
      if (!name.trim()) return;
      const dir = await window.omenflow.pickDirectory('Choose project folder');
      if (!dir) return;
      const r = await cmd<{ project: Project; projectId: string }>('project.create', {
        name: name.trim(),
        path: dir,
        intent: intent.trim(),
      });
      setCreateOpen(false);
      await afterOpen(r, dir);
    });

  const open = (dir?: string) =>
    run(async () => {
      const path = dir ?? (await window.omenflow.pickDirectory('Open Omen Flow project'));
      if (!path) return;
      const r = await cmd<{ project: Project; projectId: string; readOnly?: boolean }>(
        'project.open',
        { path },
      );
      await afterOpen(r, path);
    });

  const importArchive = () =>
    run(async () => {
      const archivePath = await window.omenflow.pickFile({
        title: 'Import project archive',
        filters: [{ name: 'Project archive', extensions: ['zip', 'omenflow.zip'] }],
      });
      if (!archivePath) return;
      const destDir = await window.omenflow.pickDirectory('Choose where to extract the project');
      if (!destDir) return;
      const input = { archivePath, destDir };
      let r: { project: Project; projectId: string };
      try {
        r = await cmd('project.import_archive', input);
      } catch (e) {
        if (!(e instanceof CommandError) || e.code !== 'VALIDATION') throw e;
        r = await cmd('project.import_archive', { ...input, newIdentity: true });
      }
      await afterOpen(r, destDir);
    });

  const base = (path: string) =>
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || path;

  const visibleRecents = recents.filter((r) => base(r).toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="launcher">
      {sidebarOpen && (
        <aside className="sidebar launcher-sidebar">
          <div className="launcher-space">
            <span className="project-avatar">O</span>
            <div>
              <strong>Personal workspace</strong>
              <small>On this device</small>
            </div>
          </div>
          <nav className="nav-group" aria-label="Project launcher">
            <button className="nav-item active" aria-current="page">
              <House size={16} />
              Projects
            </button>
            <button className="nav-item" onClick={() => setCreateOpen(true)} disabled={busy}>
              <Plus size={16} />
              New project
            </button>
            <button className="nav-item" onClick={() => void open()} disabled={busy}>
              <FolderOpen size={16} />
              Open project
            </button>
            <button className="nav-item" onClick={() => void importArchive()} disabled={busy}>
              <Package size={16} />
              Import archive
            </button>
          </nav>
          <div className="nav-label">Recently opened</div>
          {recents.slice(0, 5).map((r) => (
            <button
              className="nav-item"
              key={r}
              onClick={() => void open(r)}
              title={r}
              disabled={busy}
            >
              <Cube size={14} />
              <span>{base(r)}</span>
            </button>
          ))}
          <div className="sidebar-bottom">
            <button className="nav-item" onClick={() => set({ nav: 'design-system' })}>
              <SquaresFour size={16} />
              Design system
            </button>
            <div className="sidebar-note">
              <HardDrive size={13} />
              Local by design
            </div>
          </div>
        </aside>
      )}
      <main className="launcher-main">
        <div className="launcher-content">
          <div className="launcher-heading">
            <span>Projects</span>
            <button className="ghost" onClick={() => void open()} disabled={busy}>
              <FolderOpen size={15} />
              Open folder
            </button>
          </div>
          <section className="launcher-intro">
            <Brand compact />
            <h1>Build what comes next.</h1>
            <p>One workspace for your ideas, your AI, and the engineering behind them.</p>
            <form
              className="project-composer"
              onSubmit={(e) => {
                e.preventDefault();
                setCreateOpen(true);
              }}
            >
              <label className="sr-only" htmlFor="project-brief">
                What are you building?
              </label>
              <textarea
                id="project-brief"
                placeholder="What are you building?"
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                rows={2}
              />
              <div className="project-composer-footer">
                <span>
                  <Cube size={14} />
                  Start from an idea. Build with evidence.
                </span>
                <button ref={newProjectButton} className="primary" disabled={busy}>
                  Create project
                  <ArrowUp size={15} />
                </button>
              </div>
            </form>
            <div className="launcher-domains">
              <span>
                <ListChecks size={14} />
                Requirements
              </span>
              <span>
                <Cube size={14} />
                Design & engineering
              </span>
              <span>
                <GitBranch size={14} />
                Review & iterate
              </span>
            </div>
          </section>
          <section className="launcher-recents" aria-busy={recentState === 'loading'}>
            <div className="section-heading">
              <h2>
                Recent projects <span className="count">{recents.length}</span>
              </h2>
              {recents.length > 0 && (
                <SearchField value={query} onChange={setQuery} placeholder="Find a project" />
              )}
            </div>
            {recentState === 'loading' ? (
              <div className="recent-loading" role="status">
                Loading your projects…
              </div>
            ) : recentState === 'error' ? (
              <EmptyState
                title="Couldn’t load recent projects"
                body="Try again, or open a project folder directly."
                action={<button onClick={() => setRecentAttempt((x) => x + 1)}>Try again</button>}
              />
            ) : !recents.length ? (
              <div className="launcher-empty">
                <FolderOpen size={23} weight="light" />
                <div>
                  <strong>Your next project starts here.</strong>
                  <p>Create a project above or open an existing folder.</p>
                </div>
                <button onClick={() => void open()} disabled={busy}>
                  Open project
                  <ArrowRight size={14} />
                </button>
              </div>
            ) : !visibleRecents.length ? (
              <EmptyState
                title="No matching projects"
                body="Try another name or clear the filter."
                icon={<MagnifyingGlass size={24} />}
              />
            ) : (
              <div className="recent-project-list">
                {(showAllRecents ? visibleRecents : visibleRecents.slice(0, 5)).map((r) => (
                  <button
                    className="recent-project"
                    key={r}
                    onClick={() => void open(r)}
                    disabled={busy}
                  >
                    <span className="project-avatar">
                      <Cube size={18} />
                    </span>
                    <span className="grow">
                      <strong>{base(r)}</strong>
                      <small className="truncate">{r}</small>
                    </span>
                    <span className="recent-location">Local project</span>
                    <ArrowRight size={15} />
                  </button>
                ))}
              </div>
            )}
            {visibleRecents.length > 5 && (
              <button className="text-link" onClick={() => setShowAllRecents(!showAllRecents)}>
                {showAllRecents ? 'Show fewer projects' : 'Show all projects'}
              </button>
            )}
          </section>
          <footer className="launcher-footer">
            <span>
              <HardDrive size={13} />
              Your files and engineering record stay with your project.
            </span>
            <button className="text-link" onClick={() => set({ nav: 'design-system' })}>
              Explore the design system
              <ArrowRight size={13} />
            </button>
          </footer>
          <div className="launcher-operation" role="status">
            {busy && !createOpen ? 'Opening your workspace…' : ''}
          </div>
        </div>
      </main>
      <Dialog.Root
        open={createOpen}
        onOpenChange={(value) => {
          if (!busy) setCreateOpen(value);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dlg-overlay" />
          <Dialog.Content
            className="dlg"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              newProjectButton.current?.focus();
            }}
          >
            <span className="dialog-symbol">
              <Cube size={22} />
            </span>
            <Dialog.Title className="dlg-title">A new space to build.</Dialog.Title>
            <Dialog.Description className="dlg-description">
              Name your project, then choose where it lives. Your AI and engineering tools will
              share this workspace.
            </Dialog.Description>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <FormField label="Project name">
                <input
                  required
                  placeholder="e.g. Sable inspection rover"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={busy}
                />
              </FormField>
              <FormField
                label="What are you building?"
                hint="Optional. Your agent can use this as the project brief."
              >
                <textarea
                  placeholder="Describe the idea and what it needs to do."
                  rows={3}
                  value={intent}
                  onChange={(e) => setIntent(e.target.value)}
                  disabled={busy}
                />
              </FormField>
              <div className="dlg-actions">
                <Dialog.Close asChild>
                  <button type="button" className="ghost" disabled={busy}>
                    Cancel
                  </button>
                </Dialog.Close>
                <button className="primary" type="submit" disabled={busy || !name.trim()}>
                  {busy ? 'Creating…' : 'Choose folder & create'}
                  <ArrowRight size={15} />
                </button>
              </div>
            </form>
            <Dialog.Close asChild>
              <IconButton label="Close new project" className="dlg-close" disabled={busy}>
                <X size={16} />
              </IconButton>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
