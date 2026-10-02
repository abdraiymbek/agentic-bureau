import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  CheckCircle,
  GitBranch,
  Lightbulb,
  Play,
  WarningCircle,
} from '@phosphor-icons/react';
import { cmd, errMsg } from '../api';
import { openProposals, useStore, type Lens } from '../store';
import { showAgent } from '../lib/actions';
import { Button, TypeGlyph, typeMeta } from '../ui/kit';
import { FlowMap } from './FlowMap';
import { PartsLens } from './PartsLens';
import { TimelineLens } from './TimelineLens';
import { FilesLens } from './FilesLens';

/** Zoom level 0: the whole project, seen through one lens at a time. */
export function ProjectView({ lens }: { lens: Lens }) {
  const artifacts = useStore((s) => s.artifacts);
  const proposals = useStore((s) => s.proposals);
  const stale = useStore((s) => s.stale);
  const suggestions = useStore((s) => s.suggestions);
  const empty = artifacts.length === 0;
  const busyIsland =
    openProposals(proposals).length > 0 ||
    suggestions.length > 0 ||
    Object.values(stale).some((r) => r.length > 0);
  return (
    <div className={`project lens-${lens}`}>
      {lens === 'flow' && !empty && <FlowMap reserveRight={busyIsland ? 352 : 48} />}
      <header className="project-head">
        <Identity />
      </header>
      {lens === 'flow' && (empty ? <Beginning /> : <NeedsYou />)}
      {lens === 'parts' && <PartsLens />}
      {lens === 'timeline' && <TimelineLens />}
      {lens === 'files' && <FilesLens />}
    </div>
  );
}

function Identity() {
  const project = useStore((s) => s.project);
  const readOnly = useStore((s) => s.readOnly);
  const artifacts = useStore((s) => s.artifacts);
  const edges = useStore((s) => s.edges);
  const toast = useStore((s) => s.toast);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project?.intent ?? '');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing) setDraft(project?.intent ?? '');
  }, [project?.intent, editing]);
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);
  const save = async () => {
    const next = draft.trim();
    setEditing(false);
    if (!project || next === project.intent) return;
    try {
      await cmd('project.update_intent', { intent: next });
      useStore.getState().set({ project: { ...project, intent: next } });
    } catch (e) {
      toast('error', errMsg(e));
    }
  };
  return (
    <div className="identity">
      <h1>{project?.name}</h1>
      {editing ? (
        <textarea
          ref={ref}
          className="identity-intent editing"
          aria-label="Project intent"
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void save();
            }
            if (e.key === 'Escape') {
              e.stopPropagation();
              setDraft(project?.intent ?? '');
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="identity-intent"
          disabled={readOnly}
          onClick={() => setEditing(true)}
          title={readOnly ? undefined : 'Edit the project intent'}
        >
          {project?.intent || 'Add one sentence about what this must become.'}
        </button>
      )}
      {artifacts.length > 0 && (
        <p className="identity-meta">
          {artifacts.length} objects · {edges.length} recorded links
        </p>
      )}
    </div>
  );
}

/** Only what is waiting on a human. Disappears into one quiet line when nothing is. */
function NeedsYou() {
  const proposals = useStore((s) => s.proposals);
  const artifacts = useStore((s) => s.artifacts);
  const stale = useStore((s) => s.stale);
  const suggestions = useStore((s) => s.suggestions);
  const { decide, focus } = useStore.getState();
  const pending = openProposals(proposals);
  const outdated = artifacts.filter((v) => (stale[v.artifact.id] ?? []).length > 0);
  const count = pending.length + outdated.length;

  if (!count && !suggestions.length)
    return (
      <div className="needs island quiet">
        <CheckCircle size={14} className="tone-ok-text" />
        Every baseline is current and reviewed
      </div>
    );

  return (
    <aside className="needs island" aria-label="Needs you">
      {count > 0 && (
        <header className="needs-head">
          <span>Needs you</span>
          <span className="count">{count}</span>
        </header>
      )}
      {pending.slice(0, 4).map((p) => (
        <button key={p.id} type="button" className="needs-row" onClick={() => decide(p.id)}>
          <GitBranch size={15} className="tone-warn-text" />
          <span className="needs-copy">
            <strong>{p.reason}</strong>
            <small>
              {p.state === 'changes_requested' ? 'Changes requested' : 'Proposed'} ·{' '}
              {p.changes.length} {p.changes.length === 1 ? 'change' : 'changes'} · {p.createdBy}
            </small>
          </span>
          <ArrowRight size={13} className="needs-go" />
        </button>
      ))}
      {outdated.slice(0, Math.max(0, 5 - Math.min(pending.length, 4))).map((v) => (
        <button
          key={v.artifact.id}
          type="button"
          className="needs-row"
          onClick={() => focus(v.artifact.id)}
        >
          <WarningCircle size={15} className="tone-warn-text" />
          <span className="needs-copy">
            <strong>{v.artifact.title}</strong>
            <small>
              {typeMeta(v.artifact.type).label} ·{' '}
              {(stale[v.artifact.id] ?? []).some((r) => r.reason === 'missing_input')
                ? 'an input is missing'
                : 'an input changed since it was recorded'}
            </small>
          </span>
          <ArrowRight size={13} className="needs-go" />
        </button>
      ))}
      {count > 5 &&
        (pending.length > 4 ? (
          <button type="button" className="needs-more" onClick={() => decide(null)}>
            {count - 5} more · review all
          </button>
        ) : (
          <span className="needs-more">{count - 5} more marked on the flow</span>
        ))}
      {suggestions.length > 0 && (
        <div className="needs-suggest">
          <span className="needs-sub">Suggested by the agent</span>
          {suggestions.slice(-3).map((s, i) => (
            <div className="needs-suggestion" key={i}>
              <Lightbulb size={13} />
              <span>
                {s.title}
                {s.detail && <small>{s.detail}</small>}
              </span>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

/** An empty project is a starting line, not an empty dashboard. */
function Beginning() {
  const session = useStore((s) => s.session);
  const project = useStore((s) => s.project);
  const askAbout = useStore((s) => s.askAbout);
  const live = session?.state === 'running';
  const prompt = project?.intent
    ? `Read the project intent and draft the first requirements with measurable targets and acceptance criteria. Intent: ${project.intent}`
    : 'Help me define this project. Ask me what it must do, then draft requirements with measurable targets.';
  return (
    <div className="beginning">
      <div className="beginning-flow" aria-hidden="true">
        {(['requirement', 'component', 'mechanical', 'calculation'] as const).map((t, i) => (
          <React.Fragment key={t}>
            {i > 0 && <span className="beginning-link" />}
            <span className="beginning-node">
              <TypeGlyph type={t} size={14} />
              {['Intent', 'Parts', 'Design', 'Evidence'][i]}
            </span>
          </React.Fragment>
        ))}
      </div>
      <h2>Start with what it must do.</h2>
      <p>
        Your agent drafts requirements, parts, models, and calculations. They appear here as one
        connected flow — and none become the design until you approve them.
      </p>
      {live ? (
        <Button
          variant="primary"
          onClick={() => askAbout(prompt)}
          trailing={<ArrowRight size={14} />}
        >
          Draft first requirements
        </Button>
      ) : (
        <Button
          variant="signal"
          icon={<Play size={13} weight="fill" />}
          onClick={() => showAgent()}
        >
          Open the agent
        </Button>
      )}
    </div>
  );
}
