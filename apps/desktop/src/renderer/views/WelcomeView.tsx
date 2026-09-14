import React, { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowRight,
  ChartLine,
  Circuitry,
  Cube,
  FilePlus,
  FolderOpen,
  GitPullRequest,
  House,
  Lightbulb,
  Package,
} from '@phosphor-icons/react';
import { cmd, errMsg, CommandError } from '../api';
import { useStore } from '../store';
import { JET_ASCII } from '../components/jetAscii';
import type { Project } from '@stark/contracts';

const STEPS = [
  { n: '01', icon: Lightbulb, title: 'Idea → Requirements', desc: 'Describe what you are building. STARK captures requirements, assumptions, and constraints.' },
  { n: '02', icon: Cube, title: 'Requirements → CAD', desc: 'Parametric OpenSCAD models driven by your spec, previewed in the built-in STL viewport.' },
  { n: '03', icon: Circuitry, title: 'Parts & Sourcing', desc: 'Components with real offers and a bill of materials that stays in sync.' },
  { n: '04', icon: GitPullRequest, title: 'Agent Review Gate', desc: 'Agent work lands as proposals. You approve it before it touches the baseline.' },
  { n: '05', icon: ChartLine, title: 'Trace Everything', desc: 'Dependency graph, staleness, and provenance from requirement to artifact.' },
];

/** First-run surface: landing-style hero with create / open / import / recents. */
export function WelcomeView() {
  const { set, setActive, toast } = useStore();
  const [recents, setRecents] = useState<string[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [intent, setIntent] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void cmd<{ projects: string[] }>('app.recent_projects')
      .then((r) => setRecents(r.projects))
      .catch(() => {});
  }, []);

  const afterOpen = async (
    r: { project: Project; projectId: string; readOnly?: boolean },
    path: string,
  ) => {
    set({ project: r.project, projectPath: path, readOnly: !!r.readOnly });
    setActive(r.projectId);
    await useStore.getState().refreshArtifacts();
    await useStore.getState().refreshProposals();
    await useStore.getState().refreshEvents();
    await useStore.getState().refreshSession();
  };

  const create = async () => {
    if (!name.trim()) return;
    const dir = await window.stark.pickDirectory('Choose project folder');
    if (!dir) return;
    setBusy(true);
    try {
      const r = await cmd<{ project: Project; projectId: string }>('project.create', {
        name,
        path: dir,
        intent,
      });
      setCreateOpen(false);
      await afterOpen({ ...r }, dir);
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const open = async (dir?: string) => {
    const p = dir ?? (await window.stark.pickDirectory('Open STARK project'));
    if (!p) return;
    setBusy(true);
    try {
      const r = await cmd<{ project: Project; projectId: string; readOnly?: boolean }>(
        'project.open',
        { path: p },
      );
      await afterOpen(r, p);
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const importArchive = async () => {
    const archivePath = await window.stark.pickFile({
      title: 'Import STARK archive',
      filters: [{ name: 'STARK archive', extensions: ['zip', 'stark.zip'] }],
    });
    if (!archivePath) return;
    const destDir = await window.stark.pickDirectory('Choose where to extract the project');
    if (!destDir) return;
    setBusy(true);
    try {
      const input = { archivePath, destDir };
      let r: { project: Project; projectId: string };
      try {
        r = await cmd('project.import_archive', input);
      } catch (e) {
        // Same project already open/on disk → import as a copy instead.
        if (!(e instanceof CommandError) || e.code !== 'VALIDATION') throw e;
        r = await cmd('project.import_archive', { ...input, newIdentity: true });
      }
      await afterOpen({ ...r }, destDir);
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

  return (
    <div className="welcome">
      {/* Header */}
      <header className="welcome-header" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <div className="welcome-logo">STARK</div>
        <nav className="welcome-steps dim-mono">
          <span>ENGINEER</span>
          <span className="sep">›</span>
          <span>DESIGN</span>
          <span className="sep">›</span>
          <span>SOURCE</span>
          <span className="sep">›</span>
          <span>BUILD</span>
        </nav>
        <div className="dim-mono">V1.0</div>
      </header>

      <div className="welcome-body">
        {/* Left rail */}
        <aside className="welcome-rail">
          <RailItem icon={<House size={15} />} label="Home" active />
          <RailItem icon={<FilePlus size={15} />} label="New Project" onClick={() => setCreateOpen(true)} />
          <RailItem icon={<FolderOpen size={15} />} label="Open Project" onClick={() => open()} />
          <RailItem icon={<Package size={15} />} label="Import Archive" onClick={importArchive} />

          {recents.length > 0 && (
            <div className="welcome-recents">
              <div className="rail-label dim-mono">Recent Projects</div>
              {recents.slice(0, 6).map((r) => (
                <button key={r} className="rail-recent" title={r} onClick={() => open(r)}>
                  {base(r)}
                </button>
              ))}
            </div>
          )}

          <div className="rail-quote">
            <div className="rail-quote-text">"Ideas to reality, faster."</div>
            <div className="dim-mono" style={{ marginTop: 8 }}>STARK</div>
          </div>
        </aside>

        {/* Hero */}
        <main className="welcome-hero">
          <div className="hero-copy">
            <div className="eyebrow dim-mono">YOUR ENGINEERING CO-PILOT</div>
            <h1 className="hero-word">STARK</h1>
            <div className="hero-tag">Turn your ideas into real-world engineering.</div>
            <p className="hero-sub dim">
              From concept to CAD, parts, wiring and beyond. STARK helps you design, source, and
              build, powered by AI.
            </p>
            <div className="hero-ctas">
              <button className="cta-primary" onClick={() => setCreateOpen(true)} disabled={busy}>
                <FilePlus size={15} weight="bold" />
                Start New Project
                <ArrowRight size={14} />
              </button>
              <button className="cta-ghost" onClick={() => open()} disabled={busy}>
                <FolderOpen size={15} />
                Open Project
              </button>
            </div>
          </div>

          <pre className="hero-jet" aria-hidden="true">
            {JET_ASCII}
          </pre>
        </main>
      </div>

      {/* Workflow cards */}
      <div className="welcome-cards">
        {STEPS.map((s) => (
          <div key={s.n} className="step-card">
            <div className="step-num dim-mono">{s.n}</div>
            <s.icon size={18} className="step-icon" />
            <div className="step-title">{s.title}</div>
            <div className="step-desc dim">{s.desc}</div>
            <ArrowRight size={12} className="step-arrow" />
          </div>
        ))}
      </div>

      {/* Footer strip */}
      <footer className="welcome-footer dim-mono">
        <span>BUILT FOR A BRIGHTER TOMORROW.</span>
        <span>STARK // ENGINEERING INTELLIGENCE</span>
      </footer>

      {/* New-project dialog */}
      <Dialog.Root open={createOpen} onOpenChange={setCreateOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dlg-overlay" />
          <Dialog.Content className="dlg">
            <Dialog.Title className="dlg-title">New project</Dialog.Title>
            <Dialog.Description className="dim" style={{ fontSize: 13, marginBottom: 16 }}>
              Pick a name and a folder. STARK creates the project database and workspace there.
            </Dialog.Description>
            <label className="dlg-label dim-mono">NAME</label>
            <input
              autoFocus
              placeholder="e.g. Sable inspection rover"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
            />
            <label className="dlg-label dim-mono" style={{ marginTop: 12 }}>
              INTENT
            </label>
            <textarea
              placeholder="What are you building?"
              rows={3}
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button onClick={() => setCreateOpen(false)}>Cancel</button>
              <button className="primary" onClick={create} disabled={busy || !name.trim()}>
                {busy ? 'Creating…' : 'Create project'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function RailItem(props: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      className={`rail-item${props.active ? ' active' : ''}`}
      onClick={props.onClick}
      disabled={!props.onClick}
      style={props.active ? { cursor: 'default' } : undefined}
    >
      {props.icon}
      {props.label}
    </button>
  );
}
