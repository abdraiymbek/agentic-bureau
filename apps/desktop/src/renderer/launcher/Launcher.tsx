import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  ArrowUp,
  FolderOpen,
  Package,
  HardDrive,
  MagnifyingGlass,
} from '@phosphor-icons/react';
import { cmd, errMsg } from '../api';
import { useStore } from '../store';
import { Button, Empty, Mark } from '../ui/kit';
import { createProject, importArchive, openProjectAt } from '../lib/actions';

/** The only screen without a project: one question, then your recent work. */
export function Launcher() {
  const toast = useStore((s) => s.toast);
  const go = useStore((s) => s.go);
  const [recents, setRecents] = useState<string[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const pending = useRef(false);
  const briefRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    const timeout = window.setTimeout(() => !cancelled && setState('error'), 8000);
    void cmd<{ projects: string[]; projectNames?: Record<string, string> }>('app.recent_projects')
      .then((r) => {
        if (cancelled) return;
        setRecents(r.projects);
        setNames(r.projectNames ?? {});
        setState('ready');
      })
      .catch(() => !cancelled && setState('error'))
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

  const base = (path: string) =>
    names[path] ||
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ||
    path;
  const visible = recents.filter((r) =>
    `${base(r)} ${r}`.toLowerCase().includes(query.toLowerCase()),
  );
  const shown = showAll ? visible : visible.slice(0, 6);
  const canCreate = !!name.trim() && !busy;

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
            if (canCreate) void run('create', () => createProject(name, brief));
          }}
        >
          <input
            className="launcher-name"
            aria-label="Project name"
            placeholder="Project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
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
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canCreate) {
                e.preventDefault();
                void run('create', () => createProject(name, brief));
              }
            }}
            disabled={!!busy}
          />
          <div className="launcher-composer-foot">
            <span className="launcher-local">
              <HardDrive size={13} />
              Lives in a folder you choose
            </span>
            <Button
              type="submit"
              variant="primary"
              disabled={!canCreate}
              trailing={<ArrowUp size={14} weight="bold" />}
            >
              {busy === 'create' ? 'Creating…' : 'Choose folder & create'}
            </Button>
          </div>
        </form>

        <div className="launcher-alt">
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void run('open', () => openProjectAt())}
          >
            <FolderOpen size={14} />
            Open a project folder
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
            {recents.length > 6 && (
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
            <ul className="recent-list">
              {shown.map((r) => (
                <li key={r}>
                  <button
                    type="button"
                    className="recent"
                    disabled={!!busy}
                    onClick={() => void run(r, () => openProjectAt(r))}
                  >
                    <span className="recent-initial" aria-hidden="true">
                      {base(r).slice(0, 1).toUpperCase()}
                    </span>
                    <span className="recent-copy">
                      <strong className="truncate">{base(r)}</strong>
                      <small className="truncate">{r}</small>
                    </span>
                    <span className="recent-go">
                      {busy === r ? 'Opening…' : <ArrowRight size={14} />}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {visible.length > 6 && (
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
