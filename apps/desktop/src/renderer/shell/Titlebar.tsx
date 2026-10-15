import React from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import {
  ArrowLeft,
  CaretDown,
  CaretRight,
  FolderOpen,
  MagnifyingGlass,
  Export,
  Archive,
  FolderSimple,
  SignOut,
  Globe,
} from '@phosphor-icons/react';
import { useStore } from '../store';
import { needsYou } from '../lib/proposals';
import { lensDef } from '../project/lenses';
import { IconButton, Kbd, Mark, Spinner, Tooltip, typeMeta } from '../ui/kit';
import { closeProject, exportProject, openProjectAt } from '../lib/actions';
import { errMsg } from '../api';

const JOB_VERBS: Record<string, string> = {
  'cad.render': 'Rendering',
  'wiring.render': 'Drawing wiring',
  'calculation.run': 'Calculating',
  'build.export': 'Exporting build',
};

function report(action: Promise<unknown>) {
  void action.catch((e) => useStore.getState().toast('error', errMsg(e)));
}

/** Names only where you are: the level, then the object or proposal in focus. */
function Trail() {
  const view = useStore((s) => s.view);
  const back = useStore((s) => s.back);
  const project = useStore((s) => s.project);
  const artifacts = useStore((s) => s.artifacts);
  const proposals = useStore((s) => s.proposals);
  const { goBack } = useStore.getState();
  const focused = view.level === 'object' ? artifacts.find((v) => v.artifact.id === view.id) : null;
  const proposal =
    view.level === 'decide' && view.proposalId
      ? proposals.find((p) => p.id === view.proposalId)
      : null;
  const steps: { kind?: string; label: string }[] =
    view.level === 'project'
      ? project
        ? [{ label: lensDef(view.lens)?.label ?? view.lens }]
        : []
      : view.level === 'object'
        ? focused
          ? [{ kind: typeMeta(focused.artifact.type).label, label: focused.artifact.title }]
          : []
        : view.level === 'decide'
          ? [proposal ? { kind: 'Decisions', label: proposal.reason } : { label: 'Decisions' }]
          : view.level === 'agent'
            ? [{ label: 'Agent' }]
            : [{ label: 'Design system' }];
  return (
    <nav className="trail" aria-label="Location" data-tauri-drag-region>
      {back.length > 0 && (project || view.level === 'system') && view.level !== 'project' && (
        <IconButton size="sm" label="Back (⌘[)" onClick={goBack}>
          <ArrowLeft size={13} />
        </IconButton>
      )}
      {steps.map((step, i) => (
        <React.Fragment key={i}>
          <CaretRight size={11} className="trail-sep" aria-hidden="true" />
          {step.kind && (
            <>
              <span className="trail-kind">{step.kind}</span>
              <CaretRight size={11} className="trail-sep" aria-hidden="true" />
            </>
          )}
          <span className="trail-current truncate" aria-current="location">
            {step.label}
          </span>
        </React.Fragment>
      ))}
    </nav>
  );
}

export function Titlebar() {
  const project = useStore((s) => s.project);
  const view = useStore((s) => s.view);
  const proposals = useStore((s) => s.proposals);
  const jobs = useStore((s) => s.jobs);
  const readOnly = useStore((s) => s.readOnly);
  const { set, go, decide } = useStore.getState();
  const pending = needsYou(proposals).length;
  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued');
  const preview = import.meta.env.DEV && new URLSearchParams(location.search).has('design-preview');
  const jobText =
    active.length === 1
      ? `${JOB_VERBS[active[0]!.kind] ?? 'Running'} · ${active[0]!.tool}`
      : `${active.length} tool jobs`;

  return (
    <header className="titlebar" data-tauri-drag-region>
      <span className="traffic-space" data-tauri-drag-region />
      <Tooltip label={project ? 'Project flow (⌘1)' : 'Omen Flow'} side="bottom">
        <button
          type="button"
          className="titlebar-mark"
          aria-label={project ? 'Project flow' : 'Omen Flow'}
          onClick={() =>
            project
              ? go({ level: 'project', lens: 'flow' })
              : set({ view: { level: 'project', lens: 'flow' } })
          }
        >
          <Mark size={17} />
        </button>
      </Tooltip>
      {project && <ProjectMenu name={project.name} readOnly={readOnly} />}
      {preview && <span className="titlebar-tag">Design preview</span>}

      <Trail />

      <div className="titlebar-actions">
        {active.length > 0 && (
          <Tooltip
            side="bottom"
            label={
              <span className="tip-lines">
                {active.map((j, i) => (
                  <span key={i}>
                    {JOB_VERBS[j.kind] ?? j.kind} · {j.tool} · {j.status}
                  </span>
                ))}
              </span>
            }
          >
            <span className="titlebar-job" role="status" tabIndex={0}>
              <Spinner />
              {jobText}
            </span>
          </Tooltip>
        )}
        {project && pending > 0 && view.level !== 'decide' && (
          <Tooltip side="bottom" label="Open decisions (⌘⇧D)">
            <button type="button" className="decisions-pill" onClick={() => decide(null)}>
              <span className="state-dot" aria-hidden="true" />
              {pending} to review
            </button>
          </Tooltip>
        )}
        <button
          type="button"
          className="omni-trigger"
          aria-keyshortcuts="Meta+K"
          onClick={() => set({ omniOpen: true })}
        >
          <MagnifyingGlass size={13} />
          <span>{project ? 'Go to or ask' : 'Search'}</span>
          <Kbd>⌘K</Kbd>
        </button>
      </div>
    </header>
  );
}

function ProjectMenu({ name, readOnly }: { name: string; readOnly: boolean }) {
  const projectPath = useStore((s) => s.projectPath);
  return (
    <Menu.Root>
      <Tooltip side="bottom" label={projectPath ?? name}>
        <Menu.Trigger asChild>
          <button type="button" className="project-switch" aria-label={`Project ${name}`}>
            <span className="truncate">{name}</span>
            {readOnly && <span className="titlebar-tag">Read-only</span>}
            <CaretDown size={11} />
          </button>
        </Menu.Trigger>
      </Tooltip>
      <Menu.Portal>
        <Menu.Content
          className="menu"
          align="start"
          sideOffset={6}
          // Escape closes the menu and nothing else; the workspace does not also zoom out.
          onEscapeKeyDown={(e) => e.stopPropagation()}
        >
          <div className="menu-label truncate">{projectPath}</div>
          {readOnly && (
            <div className="menu-label">Open read-only: changes and agent sessions are off.</div>
          )}
          <Menu.Item
            className="menu-item"
            disabled={!projectPath}
            onSelect={() => projectPath && report(window.omenflow.revealPath(projectPath))}
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
            onSelect={() => report(window.omenflow.toggleResearch())}
          >
            <Globe size={14} /> Research browser
          </Menu.Item>
          <Menu.Separator className="menu-sep" />
          <Menu.Item className="menu-item" onSelect={() => report(openProjectAt())}>
            <FolderOpen size={14} /> Open another project…
          </Menu.Item>
          <Menu.Item className="menu-item" onSelect={() => report(closeProject())}>
            <SignOut size={14} /> Close project
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
