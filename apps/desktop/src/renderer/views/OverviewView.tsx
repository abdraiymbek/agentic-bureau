import React from 'react';
import {
  ArrowRight,
  ListChecks,
  GitBranch,
  WarningCircle,
  CheckCircle,
  ClockCounterClockwise,
  TerminalWindow,
  Plus,
} from '@phosphor-icons/react';
import { useStore, type Nav } from '../store';
import {
  ArtifactIcon,
  EmptyState,
  SectionHeading,
  StatusBadge,
  TextLink,
  typeLabels,
} from '../components/ui';
import type { ArtifactType } from '@omenflow/contracts';

/** Disciplines in the order an engineer reads a project: intent → design → parts → evidence. */
const RECORD_ORDER: ArtifactType[] = [
  'requirement',
  'assumption',
  'concept',
  'architecture',
  'subsystem',
  'mechanical',
  'wiring',
  'software',
  'calculation',
  'component',
  'assembly',
  'test',
  'source',
  'note',
];

export function OverviewView() {
  const { project, artifacts, proposals, stale, suggestions, openArtifact, navigate, events, set } =
    useStore();
  const pending = proposals.filter((p) => ['pending', 'changes_requested'].includes(p.state));
  const outdated = artifacts.filter((v) => (stale[v.artifact.id] ?? []).length > 0);
  const approved = artifacts.filter((v) => v.revision?.reviewState === 'approved');
  const reqs = artifacts.filter((v) => v.artifact.type === 'requirement');
  const attention = pending.length + outdated.length;
  const record = RECORD_ORDER.map((type) => {
    const objects = artifacts.filter((v) => v.artifact.type === type);
    return {
      type,
      objects,
      stale: objects.filter((v) => (stale[v.artifact.id] ?? []).length > 0).length,
      inReview: objects.filter((v) => v.pendingProposal).length,
      drafts: objects.filter((v) => !v.revision).length,
    };
  }).filter((r) => r.objects.length > 0);
  const openDiscipline = (type: ArtifactType, firstId: string) => {
    if (type === 'component') navigate('components');
    else openArtifact(firstId, type);
  };
  const summary: { icon: typeof ListChecks; label: string; value: number; to: Nav }[] = [
    { icon: ListChecks, label: 'Requirements', value: reqs.length, to: 'requirements' },
    { icon: CheckCircle, label: 'Approved objects', value: approved.length, to: 'artifacts' },
    { icon: GitBranch, label: 'Awaiting review', value: pending.length, to: 'reviews' },
    { icon: WarningCircle, label: 'Out of date', value: outdated.length, to: 'history' },
  ];
  return (
    <div className="page-scroll overview">
      <h1 className="overview-title">{project?.name ?? 'Your project'}</h1>
      <p className="overview-intent">
        {project?.intent || 'Give your idea a place to become an engineered system.'}
      </p>
      <div className="overview-metrics" role="list">
        {summary.map((m) => (
          <button
            className={`overview-metric ${m.label === 'Out of date' && m.value > 0 ? 'warn' : ''}`}
            key={m.label}
            role="listitem"
            onClick={() => navigate(m.to)}
          >
            <m.icon size={15} />
            <span>
              <strong className="num">{m.value}</strong>
              <small>{m.label}</small>
            </span>
          </button>
        ))}
      </div>
      {!artifacts.length ? (
        <EmptyState
          title="Start with what it needs to do."
          body="Connect an agent and describe your project. Requirements, design files, and proposals will appear as you work."
          action={
            <button
              className="primary"
              onClick={() => set({ sidecarOpen: true, sidecarTab: 'agent' })}
            >
              <TerminalWindow size={15} />
              Connect an agent
            </button>
          }
        />
      ) : (
        <>
          <section className="overview-section">
            <SectionHeading
              title="Needs your attention"
              count={attention}
              action={
                pending.length > 0 ? (
                  <TextLink onClick={() => navigate('reviews')}>Open review queue</TextLink>
                ) : undefined
              }
            />
            {pending.slice(0, 3).map((p) => (
              <button className="attention-row" key={p.id} onClick={() => navigate('reviews')}>
                <GitBranch size={18} />
                <span className="grow">
                  <strong>{p.reason}</strong>
                  <small>
                    {p.changes.length} proposed {p.changes.length === 1 ? 'change' : 'changes'} ·
                    proposed by {p.createdBy}
                  </small>
                </span>
                <StatusBadge state="pending" />
                <ArrowRight size={15} />
              </button>
            ))}
            {outdated.slice(0, Math.max(1, 4 - Math.min(pending.length, 3))).map((v) => (
              <button
                className="attention-row"
                key={v.artifact.id}
                onClick={() => openArtifact(v.artifact.id, v.artifact.type)}
              >
                <WarningCircle size={18} />
                <span className="grow">
                  <strong>{v.artifact.title}</strong>
                  <small>
                    {typeLabels[v.artifact.type]} · an input changed since this result was recorded
                  </small>
                </span>
                <StatusBadge state="stale" />
                <ArrowRight size={15} />
              </button>
            ))}
            {attention > 4 && (
              <TextLink onClick={() => navigate('history')}>
                {attention - 4} more in History & impact
              </TextLink>
            )}
            {!attention && (
              <div className="inline-notice row">
                <CheckCircle size={17} className="ok" />
                <span>Nothing is waiting on you. Every baseline is current and reviewed.</span>
              </div>
            )}
          </section>
          <section className="overview-section">
            <SectionHeading
              title="Engineering record"
              count={artifacts.length}
              action={<TextLink onClick={() => set({ quickOpen: true })}>Find an object</TextLink>}
            />
            <div className="record-rows">
              {record.map((r) => (
                <button
                  key={r.type}
                  className="record-row"
                  onClick={() => openDiscipline(r.type, r.objects[0]!.artifact.id)}
                >
                  <ArtifactIcon type={r.type} size={16} />
                  <span className="record-row-label">
                    {typeLabels[r.type] ?? r.type}
                    <span className="count">{r.objects.length}</span>
                  </span>
                  <span className="record-row-state">
                    {r.stale > 0 && <span className="warn">{r.stale} out of date</span>}
                    {r.inReview > 0 && <span className="warn">{r.inReview} in review</span>}
                    {r.drafts > 0 && <span>{r.drafts} without baseline</span>}
                    {!r.stale && !r.inReview && !r.drafts && (
                      <span className="faint">All current</span>
                    )}
                  </span>
                  <ArrowRight size={14} className="faint" />
                </button>
              ))}
            </div>
          </section>
        </>
      )}
      {suggestions.length > 0 && (
        <section className="overview-section">
          <SectionHeading title="Suggested next steps" />
          {suggestions.map((s, i) => (
            <div className="activity-row" key={i}>
              <Plus size={15} />
              <div>
                {s.title}
                <small>{s.detail}</small>
              </div>
            </div>
          ))}
        </section>
      )}
      {events.length > 0 && (
        <section className="overview-section">
          <SectionHeading
            title="Recent decisions"
            action={<TextLink onClick={() => navigate('history')}>Full change log</TextLink>}
          />
          {events
            .filter((e) =>
              ['proposal.resolved', 'baseline.changed', 'project.created'].includes(e.type),
            )
            .slice(-3)
            .reverse()
            .map((e) => {
              const d = (e.data ?? {}) as { artifactId?: string; state?: string };
              const subject = d.artifactId
                ? artifacts.find((v) => v.artifact.id === d.artifactId)?.artifact.title
                : undefined;
              return (
                <div className="activity-row" key={e.id}>
                  <ClockCounterClockwise size={15} />
                  <div>
                    {e.type === 'project.created'
                      ? 'Project created'
                      : e.type === 'baseline.changed'
                        ? `Baseline updated${subject ? ` · ${subject}` : ''}`
                        : `Review decision recorded${d.state ? ` · ${d.state.replaceAll('_', ' ')}` : ''}`}
                    <small>
                      {new Date(e.ts).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </small>
                  </div>
                </div>
              );
            })}
        </section>
      )}
    </div>
  );
}
export function EmptyBlock(props: { title: string; body: string }) {
  return <EmptyState {...props} />;
}
