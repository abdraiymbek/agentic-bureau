import React from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import {
  ArrowLeft,
  CaretDown,
  CaretRight,
  FolderOpen,
  GearSix,
  MagnifyingGlass,
  Export,
  Archive,
  FolderSimple,
  SignOut,
  Globe,
} from '@phosphor-icons/react';
import { openProposals, useStore } from '../store';
import { IconButton, Kbd, Mark, Spinner, typeMeta } from '../ui/kit';
import { closeProject, exportProject, openProjectAt } from '../lib/actions';
import { errMsg } from '../api';

const JOB_VERBS: Record<string, string> = {
  'cad.render': 'Rendering',
  'wiring.render': 'Drawing wiring',
  'calculation.run': 'Calculating',
  'build.export': 'Exporting build',
};

export function Titlebar() {
  const project = useStore((s) => s.project);
  const view = useStore((s) => s.view);
  const back = useStore((s) => s.back);
  const artifacts = useStore((s) => s.artifacts);
  const proposals = useStore((s) => s.proposals);
  const jobs = useStore((s) => s.jobs);
  const readOnly = useStore((s) => s.readOnly);
  const { set, go, goBack, decide } = useStore.getState();
  const pending = openProposals(proposals).length;
  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued');
  const focused = view.level === 'object' ? artifacts.find((v) => v.artifact.id === view.id) : null;
  const preview = import.meta.env.DEV && new URLSearchParams(location.search).has('design-preview');

  return (
    <header className="titlebar" data-tauri-drag-region>
      <span className="traffic-space" data-tauri-drag-region />
      <button
        type="button"
        className="titlebar-mark"
        aria-label={project ? 'Project flow' : 'Omen Flow'}
        title={project ? 'Project flow' : 'Omen Flow'}
        onClick={() =>
          project
            ? go({ level: 'project', lens: 'flow' })
            : set({ view: { level: 'project', lens: 'flow' } })
        }
      >
        <Mark size={17} />
      </button>
      {project && <ProjectMenu name={project.name} readOnly={readOnly} />}
      {preview && <span className="titlebar-tag">Design preview</span>}

      <nav className="trail" aria-label="Location" data-tauri-drag-region>
        {back.length > 0 && (project || view.level === 'system') && view.level !== 'project' && (
          <IconButton size="sm" label="Back (⌘[)" onClick={goBack}>
            <ArrowLeft size={13} />
          </IconButton>
        )}
        {focused && (
          <>
            <CaretRight size={11} className="trail-sep" />
            <span className="trail-kind">{typeMeta(focused.artifact.type).label}</span>
            <CaretRight size={11} className="trail-sep" />
            <span className="trail-current truncate" title={focused.artifact.title}>
              {focused.artifact.title}
            </span>
          </>
        )}
        {view.level === 'decide' && (
          <>
            <CaretRight size={11} className="trail-sep" />
            <span className="trail-current">Decisions</span>
          </>
        )}
        {view.level === 'system' && (
          <>
            <CaretRight size={11} className="trail-sep" />
            <span className="trail-current">Design system</span>
          </>
        )}
      </nav>

      <div className="titlebar-actions">
        {active.length > 0 && (
          <span className="titlebar-job" role="status">
            <Spinner />
            {active.length === 1
              ? `${JOB_VERBS[active[0]!.kind] ?? 'Running'} · ${active[0]!.tool}`
              : `${active.length} tool jobs`}
          </span>
        )}
        {project && pending > 0 && view.level !== 'decide' && (
          <button type="button" className="decisions-pill" onClick={() => decide(null)}>
            <span className="state-dot" aria-hidden="true" />
            {pending} to review
          </button>
        )}
        <button type="button" className="omni-trigger" onClick={() => set({ omniOpen: true })}>
          <MagnifyingGlass size={13} />
          <span>{project ? 'Go to or ask' : 'Search'}</span>
          <Kbd>⌘K</Kbd>
        </button>
        <IconButton label="Settings (⌘,)" onClick={() => set({ settingsOpen: true })}>
          <GearSix size={15} />
        </IconButton>
      </div>
    </header>
  );
}

function ProjectMenu({ name, readOnly }: { name: string; readOnly: boolean }) {
  const projectPath = useStore((s) => s.projectPath);
  const toast = useStore((s) => s.toast);
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button type="button" className="project-switch" title={projectPath ?? name}>
          <span className="truncate">{name}</span>
          {readOnly && <span className="titlebar-tag">Read-only</span>}
          <CaretDown size={11} />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="menu" align="start" sideOffset={6}>
          <div className="menu-label truncate">{projectPath}</div>
          <Menu.Item
            className="menu-item"
            onSelect={() => {
              if (projectPath) void window.omenflow.revealPath(projectPath);
            }}
          >
            <FolderSimple size={14} /> Reveal project folder
          </Menu.Item>
          <Menu.Item className="menu-item" onSelect={() => void exportProject('build')}>
            <Export size={14} /> Export build package…
          </Menu.Item>
          <Menu.Item className="menu-item" onSelect={() => void exportProject('archive')}>
            <Archive size={14} /> Export project archive…
          </Menu.Item>
          <Menu.Item
            className="menu-item"
            onSelect={() => void window.omenflow.toggleResearch().catch(() => {})}
          >
            <Globe size={14} /> Research browser
          </Menu.Item>
          <Menu.Separator className="menu-sep" />
          <Menu.Item
            className="menu-item"
            onSelect={() => void openProjectAt().catch((e) => toast('error', errMsg(e)))}
          >
            <FolderOpen size={14} /> Open another project…
          </Menu.Item>
          <Menu.Item className="menu-item" onSelect={closeProject}>
            <SignOut size={14} /> Close project
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
