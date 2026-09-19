import React, { useEffect, useRef, useState } from 'react';
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
  Plus,
  X,
} from '@phosphor-icons/react';
import { cmd, errMsg, CommandError } from '../api';
import { useStore } from '../store';
import aircraft from '../assets/omenflow-aircraft.png';
import type { Project } from '@omenflow/contracts';
import './welcome.css';

const STEPS = [
  {
    n: '01',
    icon: Lightbulb,
    title: 'Idea → Concept',
    desc: 'Shape your idea into clear requirements with AI.',
    detail:
      'Describe what you want to build. In Requirements, capture what it needs to do, the constraints it must meet, and the assumptions to validate.',
  },
  {
    n: '02',
    icon: Cube,
    title: 'Concept → CAD',
    desc: 'Create parametric models. Preview every revision.',
    detail:
      'Work with your connected agent to create parametric OpenSCAD models from your requirements. Preview rendered models in Artifacts and review changes before accepting them.',
  },
  {
    n: '03',
    icon: Circuitry,
    title: 'Parts & Sourcing',
    desc: 'Find real parts and keep your bill of materials in sync.',
    detail:
      'Use Components to organize parts, compare supplier offers, and track quantities. Export your bill of materials when you are ready to source the build.',
  },
  {
    n: '04',
    icon: GitPullRequest,
    title: 'Review & Build',
    desc: 'Inspect proposed changes. You decide what gets built.',
    detail:
      'Your agent submits proposed changes to Reviews. Inspect the changes and validation results, then accept or reject them before they become part of your project.',
  },
  {
    n: '05',
    icon: ChartLine,
    title: 'Iterate & Improve',
    desc: 'Trace decisions, check dependencies, and refine.',
    detail:
      'Use History and artifact dependencies to follow decisions from requirement to result. See what is out of date when a design changes and rerun the relevant checks.',
  },
];

/** Project launcher. The artwork and typography are bundled for offline use. */
export function WelcomeView() {
  const { set, setActive, toast } = useStore();
  const [recents, setRecents] = useState<string[]>([]);
  const [recentState, setRecentState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [showAllRecents, setShowAllRecents] = useState(false);
  const [recentAttempt, setRecentAttempt] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedStep, setSelectedStep] = useState<(typeof STEPS)[number] | null>(null);
  const [name, setName] = useState('');
  const [intent, setIntent] = useState('');
  const [busy, setBusy] = useState(false);
  const operationPending = useRef(false);
  const newProjectButton = useRef<HTMLButtonElement>(null);
  const stepTrigger = useRef<HTMLButtonElement | null>(null);

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
    set({ project: r.project, projectPath: path, readOnly: !!r.readOnly });
    setActive(r.projectId);
    await useStore.getState().refreshArtifacts();
    await useStore.getState().refreshProposals();
    await useStore.getState().refreshEvents();
    await useStore.getState().refreshSession();
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
        title: 'Import Omen Flow archive',
        filters: [{ name: 'Omen Flow archive', extensions: ['zip', 'omenflow.zip'] }],
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

  return (
    <div className="welcome">
      <header className="welcome-header">
        <div className="welcome-brand">
          <span className="welcome-logo">OMEN FLOW</span>
        </div>
        <div className="welcome-header-main">
          <div className="welcome-steps" aria-label="Engineer, design, source, build">
            <span>ENGINEER</span>
            <span aria-hidden="true">›</span>
            <span>DESIGN</span>
            <span aria-hidden="true">›</span>
            <span>SOURCE</span>
            <span aria-hidden="true">›</span>
            <span>BUILD</span>
          </div>
          <span className="welcome-edition">ENGINEERING WORKSPACE</span>
        </div>
      </header>

      <div className="welcome-body">
        <aside className="welcome-rail" aria-label="Project launcher">
          <nav className="welcome-nav" aria-label="Main navigation">
            <RailItem icon={<House size={20} />} label="Home" active />
            <RailItem
              icon={<FilePlus size={20} />}
              label="New Project"
              onClick={() => setCreateOpen(true)}
              disabled={busy}
            />
            <RailItem
              icon={<FolderOpen size={20} />}
              label="Open Project"
              onClick={() => open()}
              disabled={busy}
            />
            <RailItem
              icon={<Package size={20} />}
              label="Import Archive"
              onClick={importArchive}
              disabled={busy}
            />
          </nav>

          <section
            className="welcome-recents"
            aria-labelledby="recent-projects-title"
            aria-busy={recentState === 'loading'}
          >
            <h2 id="recent-projects-title" className="rail-label">
              Recent Projects
            </h2>
            {recentState === 'loading' ? (
              <div className="recent-skeleton" role="status" aria-label="Loading recent projects">
                <span />
                <span />
                <span />
              </div>
            ) : recentState === 'error' ? (
              <div>
                <p className="rail-empty">
                  Recent projects couldn’t be loaded. Try again or reopen Omen Flow.
                </p>
                <button
                  className="recent-toggle"
                  onClick={() => setRecentAttempt((attempt) => attempt + 1)}
                >
                  Try again <ArrowRight size={14} />
                </button>
              </div>
            ) : recents.length === 0 ? (
              <p className="rail-empty">
                A place for your next idea.
                <br />
                Create or open a project to begin.
              </p>
            ) : (
              <>
                <div className="recent-list">
                  {(showAllRecents ? recents : recents.slice(0, 5)).map((r) => (
                    <button
                      key={r}
                      className="rail-recent"
                      title={r}
                      onClick={() => open(r)}
                      disabled={busy}
                    >
                      <Cube size={18} />
                      <span>{base(r)}</span>
                    </button>
                  ))}
                </div>
                {recents.length > 5 && (
                  <button
                    className="recent-toggle"
                    onClick={() => setShowAllRecents(!showAllRecents)}
                    aria-expanded={showAllRecents}
                  >
                    {showAllRecents ? 'Show less' : 'View all'} <ArrowRight size={14} />
                  </button>
                )}
              </>
            )}
          </section>

          <blockquote className="rail-quote">
            <p>
              “Ideas to reality,
              <br />
              faster.”
            </p>
            <cite>OMEN FLOW</cite>
          </blockquote>
        </aside>

        <main className="welcome-main">
          <section className="welcome-hero" aria-labelledby="welcome-title">
            <div className="hero-art" aria-hidden="true">
              <div className="hero-grid" />
              <div className="hero-aircraft">
                <img
                  src={aircraft}
                  alt=""
                  width="2944"
                  height="1804"
                  loading="eager"
                  draggable="false"
                />
              </div>
              <span className="hero-art-caption">
                IDEAS
                <br />
                TAKE FLIGHT
              </span>
              <span className="hero-art-process">
                CONCEPT
                <br />
                DESIGN
                <br />
                SOURCE
                <br />
                BUILD
                <br />
                IMPROVE
              </span>
            </div>
            <div className="hero-copy">
              <p className="hero-eyebrow">YOUR ENGINEERING CO-PILOT</p>
              <h1 id="welcome-title" className="hero-word">
                OMEN FLOW
              </h1>
              <p className="hero-tag">Turn your ideas into real-world engineering.</p>
              <p className="hero-sub">
                From concept to CAD, parts, wiring and beyond.
                <br className="hero-linebreak" /> Omen Flow helps you design, source, and build,
                powered by AI.
              </p>
              <div className="hero-ctas">
                <button
                  ref={newProjectButton}
                  className="cta-primary"
                  onClick={() => setCreateOpen(true)}
                  disabled={busy}
                >
                  <Plus size={20} />
                  Start New Project
                  <ArrowRight size={18} />
                </button>
                <button className="cta-ghost" onClick={() => open()} disabled={busy}>
                  <FolderOpen size={20} />
                  Open Project
                </button>
              </div>
              <span className="welcome-operation" role="status">
                {busy && !createOpen ? 'Opening your workspace…' : ''}
              </span>
            </div>
          </section>

          <section className="welcome-cards" aria-label="From idea to engineering">
            {STEPS.map((step) => (
              <button
                key={step.n}
                className="step-card"
                onClick={(event) => {
                  stepTrigger.current = event.currentTarget;
                  setSelectedStep(step);
                }}
                aria-haspopup="dialog"
              >
                <span className="step-top">
                  <step.icon size={26} weight="light" />
                  <span className="step-num">{step.n}</span>
                </span>
                <span className="step-title">{step.title}</span>
                <span className="step-desc">{step.desc}</span>
                <ArrowRight size={17} className="step-arrow" aria-hidden="true" />
              </button>
            ))}
          </section>

          <footer className="welcome-footer">
            <span className="welcome-footer-motto">BUILT FOR A BRIGHTER TOMORROW.</span>
            <span>OMEN FLOW&nbsp; // &nbsp;ENGINEERING INTELLIGENCE</span>
          </footer>
        </main>
      </div>

      <Dialog.Root
        open={createOpen}
        onOpenChange={(value) => {
          if (!busy) setCreateOpen(value);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dlg-overlay welcome-dialog-overlay" />
          <Dialog.Content
            className="dlg welcome-dialog"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              newProjectButton.current?.focus();
            }}
          >
            <Dialog.Title className="dlg-title">Start a new project</Dialog.Title>
            <Dialog.Description className="welcome-dialog-description">
              Give your idea a name. Next, choose a folder for your workspace.
            </Dialog.Description>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <label className="dlg-label" htmlFor="project-name">
                Project name
              </label>
              <input
                id="project-name"
                autoFocus
                required
                placeholder="e.g. Sable inspection rover"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
              />
              <label className="dlg-label" htmlFor="project-intent">
                What are you building? <span>Optional</span>
              </label>
              <textarea
                id="project-intent"
                placeholder="Describe your idea and what it needs to do."
                rows={3}
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                disabled={busy}
              />
              <div className="welcome-dialog-actions">
                <Dialog.Close asChild>
                  <button type="button" disabled={busy}>
                    Cancel
                  </button>
                </Dialog.Close>
                <button className="primary" type="submit" disabled={busy || !name.trim()}>
                  {busy ? 'Creating…' : 'Choose folder & create'}
                  <ArrowRight size={16} />
                </button>
              </div>
            </form>
            <Dialog.Close asChild>
              <button
                className="welcome-dialog-close"
                aria-label="Close new project"
                disabled={busy}
              >
                <X size={18} />
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={!!selectedStep}
        onOpenChange={(value) => {
          if (!value) setSelectedStep(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dlg-overlay welcome-dialog-overlay" />
          <Dialog.Content
            className="dlg welcome-dialog"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              stepTrigger.current?.focus();
            }}
          >
            {selectedStep && (
              <>
                <selectedStep.icon size={30} weight="light" className="welcome-dialog-icon" />
                <Dialog.Title className="dlg-title">{selectedStep.title}</Dialog.Title>
                <Dialog.Description className="welcome-dialog-description">
                  {selectedStep.detail}
                </Dialog.Description>
                <div className="welcome-dialog-actions">
                  <button
                    className="primary"
                    onClick={() => {
                      setSelectedStep(null);
                      setCreateOpen(true);
                    }}
                    disabled={busy}
                  >
                    Start New Project
                    <ArrowRight size={16} />
                  </button>
                </div>
              </>
            )}
            <Dialog.Close asChild>
              <button className="welcome-dialog-close" aria-label="Close workflow details">
                <X size={18} />
              </button>
            </Dialog.Close>
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
  disabled?: boolean;
  onClick?: () => void;
}) {
  if (props.active)
    return (
      <div className="rail-item active" aria-current="page">
        {props.icon}
        <span>{props.label}</span>
      </div>
    );
  return (
    <button className="rail-item" onClick={props.onClick} disabled={props.disabled}>
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}
