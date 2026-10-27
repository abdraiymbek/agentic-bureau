import React from 'react';
import { ArrowLeft, CaretRight, GitBranch } from '../ui/icons';
import { useStore } from '../store';
import { needsYou } from '../lib/proposals';
import { lensDef } from '../project/lenses';
import { IconButton, Spinner, Tooltip, typeMeta } from '../ui/kit';

const JOB_VERBS: Record<string, string> = {
  'cad.render': 'Rendering',
  'wiring.render': 'Drawing wiring',
  'calculation.run': 'Calculating',
  'build.export': 'Exporting build',
};

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
          {i > 0 && <CaretRight size={11} className="trail-sep" aria-hidden="true" />}
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

/**
 * The sheet's header: back, where you are, and only what asks something of you (running tool
 * jobs, proposals that need you). The window drags from it. Search and the project menu live
 * in the sidebar.
 */
export function Titlebar() {
  const project = useStore((s) => s.project);
  const view = useStore((s) => s.view);
  const proposals = useStore((s) => s.proposals);
  const jobs = useStore((s) => s.jobs);
  const { decide } = useStore.getState();
  const pending = needsYou(proposals).length;
  // The Flow lens has its own Needs you pill over the map.
  const onFlow = view.level === 'project' && view.lens === 'flow';
  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued');
  const preview = import.meta.env.DEV && new URLSearchParams(location.search).has('design-preview');
  const jobText =
    active.length === 1
      ? `${JOB_VERBS[active[0]!.kind] ?? 'Running'} · ${active[0]!.tool}`
      : `${active.length} tool jobs`;

  return (
    <header className="titlebar" data-tauri-drag-region>
      {!project && <span className="traffic-space" data-tauri-drag-region />}
      <Trail />
      <div className="titlebar-actions" data-tauri-drag-region>
        {preview && <span className="titlebar-tag">Design preview</span>}
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
        {project && pending > 0 && view.level !== 'decide' && !onFlow && (
          <Tooltip side="bottom" label="Open decisions" shortcut="⌘⇧D">
            <button type="button" className="decisions-pill" onClick={() => decide(null)}>
              <GitBranch size={11} weight="bold" aria-hidden="true" />
              {pending} needs you
            </button>
          </Tooltip>
        )}
      </div>
    </header>
  );
}
