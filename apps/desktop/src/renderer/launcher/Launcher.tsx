import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  FolderOpen,
  FolderSimple,
  Package,
  HardDrive,
  MagnifyingGlass,
} from '@phosphor-icons/react';
import type { Project } from '@omenflow/contracts';
import { errMsg } from '../api';
import { useStore } from '../store';
import { Button, Empty, Kbd, Mark, Notice, Tooltip, relativeTime } from '../ui/kit';
import { enterProject, importArchive, openProjectAt } from '../lib/actions';
import { optionalCommand } from '../project/optional-op';
import { useRowNav, type RowProps } from '../project/row-nav';
import { shortPath } from '../project/files';
import { firstPromptFor, offerFirstPrompt } from './first-prompt';
import {
  baseName,
  createRefusal,
  defaultLocation,
  folderNameFor,
  nextFolderName,
  parentOf,
  placement,
  readRecents,
  type RecentProject,
} from './folders';

const RECENT_SHOWN = 6;
const RECENT_TIMEOUT_MS = 8000;

/** A problem with the planned folder, shown in place of a toast so it can be resolved here. */
type Problem =
  | { kind: 'exists'; path: string; name: string | null }
  | { kind: 'taken'; folder: string }
  | { kind: 'failed'; message: string };

/** The only screen without a project: one question, then your recent work. */
export function Launcher() {
  const toast = useStore((s) => s.toast);
  const go = useStore((s) => s.go);
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  const [location, setLocation] = useState<string | null>(null);
  const [folderOverride, setFolderOverride] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [nameHint, setNameHint] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const pending = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const briefRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    const timeout = window.setTimeout(() => !cancelled && setState('error'), RECENT_TIMEOUT_MS);
    void optionalCommand<unknown>('app.recent_projects', {})
      .then((r) => {
        if (cancelled) return;
        if (r.status !== 'ok') return setState('error');
        const list = readRecents(r.value);
        setRecents(list);
        setLocation((l) => l ?? defaultLocation(list.filter((p) => p.exists).map((p) => p.path)));
        setState('ready');
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [attempt]);

  useEffect(() => {
    const el = briefRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 52), 200)}px`;
  }, [brief]);

  const run = async (label: string, op: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(label);
    try {
      await op();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      pending.current = false;
      setBusy(null);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void run('open', () => openProjectAt());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const folder = folderOverride ?? folderNameFor(name);
  const plan = location && name.trim() ? placement(location, folder, recents) : null;

  const chooseLocation = async () => {
    const dir = await window.omenflow.pickDirectory('Choose where to create the project folder');
    if (!dir) return;
    setLocation(dir);
    setFolderOverride(null);
    setProblem(null);
  };

  const create = async () => {
    if (!name.trim()) {
      setNameHint(true);
      nameRef.current?.focus();
      return;
    }
    if (!location) return chooseLocation();
    if (!plan || plan.kind !== 'create') return;
    setProblem(null);
    const r = await optionalCommand<{ project: Project; projectId: string }>('project.create', {
      name: name.trim(),
      path: plan.path,
      intent: brief.trim(),
    });
    if (r.status !== 'ok') {
      const message = r.status === 'error' ? errMsg(r.error) : 'This build cannot create projects.';
      const refusal = r.status === 'error' ? createRefusal(r.error.message) : null;
      if (refusal === 'project-exists') setProblem({ kind: 'exists', path: plan.path, name: null });
      else if (refusal === 'folder-not-empty') {
        setProblem({ kind: 'taken', folder });
        setFolderOverride(nextFolderName(folder));
      } else setProblem({ kind: 'failed', message });
      return;
    }
    await enterProject(r.value, plan.path);
    if (brief.trim()) {
      offerFirstPrompt(r.value.projectId, firstPromptFor(brief));
      useStore.getState().go({ level: 'agent' });
    }
  };

  const visible = recents.filter((r) =>
    `${r.name ?? ''} ${baseName(r.path)} ${r.path}`.toLowerCase().includes(query.toLowerCase()),
  );
  const shown = showAll ? visible : visible.slice(0, RECENT_SHOWN);
  const rowProps = useRowNav(shown.map((r) => r.path));
  const exists = plan?.kind === 'exists' ? plan : problem?.kind === 'exists' ? problem : null;
  const primary = !location ? 'Choose location' : exists ? 'Open project' : 'Create project';

  const submit = () => {
    if (busy) return;
    if (exists) void run('create', () => openProjectAt(exists.path));
    else void run('create', create);
  };

  return (
    <div className="launcher">
      <div className="launcher-col">
        <div className="launcher-hero">
          <Mark size={34} className="launcher-mark" />
          <h1>What are you building?</h1>
          <p>
            Describe it once. Your agent drafts the engineering. You decide what becomes the design.
          </p>
        </div>

        <form
          className="launcher-composer"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            ref={nameRef}
            className="launcher-name"
            aria-label="Project name"
            aria-describedby={nameHint && !name.trim() ? 'launcher-name-hint' : undefined}
            placeholder="Project name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setFolderOverride(null);
              setProblem(null);
            }}
            disabled={!!busy}
          />
          <textarea
            ref={briefRef}
            className="launcher-brief"
            aria-label="Project brief"
            placeholder="A compact inspection rover with a removable camera tray, 300 g payload, 45 minutes of runtime…"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
            disabled={!!busy}
          />
          <div className="launcher-composer-foot">
            <span className="launcher-local">
              <HardDrive size={13} />
              {location ? (
                <span className="launcher-plan">
                  {name.trim() ? (
                    <>
                      {exists ? 'Existing project' : 'New folder'} <strong>{folder}</strong> in
                    </>
                  ) : (
                    'In'
                  )}
                  <Tooltip label={`${location} · choose another location`}>
                    <button
                      type="button"
                      className="launcher-location"
                      disabled={!!busy}
                      onClick={() => void chooseLocation()}
                    >
                      <FolderSimple size={12} />
                      <span className="truncate">{shortPath(location)}</span>
                    </button>
                  </Tooltip>
                </span>
              ) : (
                'Lives in its own folder, in a location you choose'
              )}
            </span>
            <Button
              type="submit"
              variant="primary"
              disabled={!!busy || plan?.kind === 'inside-project'}
              busy={busy === 'create'}
              shortcut="↵"
            >
              {primary}
            </Button>
          </div>
          {nameHint && !name.trim() && (
            <p id="launcher-name-hint" className="launcher-hint" role="status">
              Name the project to create it. The name is also its folder’s name.
            </p>
          )}
        </form>

        {plan?.kind === 'inside-project' && (
          <Notice
            tone="warn"
            role="status"
            action={
              <Button
                size="sm"
                onClick={() => {
                  setLocation(parentOf(plan.project));
                  setFolderOverride(null);
                }}
              >
                Create beside it
              </Button>
            }
          >
            The location is the project <strong>{plan.name ?? baseName(plan.project)}</strong>. A
            new project does not go inside another one.
          </Notice>
        )}
        {exists && (
          <Notice tone="neutral" role="status">
            <strong>{exists.name ?? baseName(exists.path)}</strong> is already an Omen Flow project
            at <span className="mono">{exists.path}</span>. Open it, or give the new project another
            name.
          </Notice>
        )}
        {problem?.kind === 'taken' && (
          <Notice tone="neutral" role="status">
            A folder named <strong>{problem.folder}</strong> already holds other files there. The
            project will get its own folder, <strong>{folder}</strong>, instead.
          </Notice>
        )}
        {problem?.kind === 'failed' && (
          <Notice
            tone="err"
            role="alert"
            action={
              <Button size="sm" onClick={() => void chooseLocation()}>
                Choose another location
              </Button>
            }
          >
            <strong>The project was not created.</strong> {problem.message}
          </Notice>
        )}

        <div className="launcher-alt">
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void run('open', () => openProjectAt())}
          >
            <FolderOpen size={14} />
            Open a project folder
            <Kbd>⌘O</Kbd>
          </button>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void run('import', () => importArchive())}
          >
            <Package size={14} />
            Import an archive
          </button>
        </div>

        <section
          className="launcher-recents"
          aria-busy={state === 'loading'}
          aria-label="Recent projects"
        >
          <header>
            <h2>Recent</h2>
            {recents.length > RECENT_SHOWN && (
              <label className="launcher-search">
                <MagnifyingGlass size={13} />
                <input
                  aria-label="Find a project"
                  placeholder="Find"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
            )}
          </header>
          {state === 'loading' ? (
            <p className="launcher-muted" role="status">
              Loading your projects…
            </p>
          ) : state === 'error' ? (
            <Empty
              title="Recent projects didn’t load"
              body="Try again, or open a project folder directly."
              action={<Button onClick={() => setAttempt((x) => x + 1)}>Try again</Button>}
            />
          ) : !recents.length ? (
            <p className="launcher-muted">Nothing yet. Your projects will gather here.</p>
          ) : !visible.length ? (
            <p className="launcher-muted">No project matches “{query}”.</p>
          ) : (
            <ul className="recent-list" data-rows="">
              {shown.map((r) => (
                <li key={r.path}>
                  <RecentRow
                    recent={r}
                    busy={busy}
                    rowProps={rowProps(r.path, () => {
                      if (r.exists) void run(r.path, () => openProjectAt(r.path));
                    })}
                    onOpen={() => void run(r.path, () => openProjectAt(r.path))}
                  />
                </li>
              ))}
            </ul>
          )}
          {visible.length > RECENT_SHOWN && (
            <button type="button" className="link" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Show fewer' : `Show all ${visible.length}`}
            </button>
          )}
        </section>

        <footer className="launcher-foot">
          <span>Local by design. No account, no cloud copy.</span>
          <button type="button" className="link" onClick={() => go({ level: 'system' })}>
            Design system
          </button>
        </footer>
      </div>
    </div>
  );
}

function RecentRow({
  recent: r,
  busy,
  rowProps,
  onOpen,
}: {
  recent: RecentProject;
  busy: string | null;
  rowProps: RowProps;
  onOpen: () => void;
}) {
  const name = r.name ?? baseName(r.path);
  return (
    <button
      {...rowProps}
      type="button"
      className={`recent ${r.exists ? '' : 'missing'}`}
      disabled={!!busy}
      aria-disabled={!r.exists || undefined}
      title={r.path}
      onClick={() => r.exists && onOpen()}
    >
      <span className="recent-initial" aria-hidden="true">
        {name.slice(0, 1).toUpperCase()}
      </span>
      <span className="recent-copy">
        <strong className="truncate">{name}</strong>
        <small className="truncate">{shortPath(r.path, 3)}</small>
      </span>
      <span className="recent-meta">
        {!r.exists ? (
          <span className="tone-warn-text">Folder not found</span>
        ) : r.lastOpenedAt ? (
          <span className="dim">Opened {relativeTime(r.lastOpenedAt)}</span>
        ) : null}
      </span>
      <span className="recent-go">{busy === r.path ? 'Opening…' : <ArrowRight size={14} />}</span>
    </button>
  );
}
