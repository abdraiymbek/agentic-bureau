import React from 'react';
import {
  ArrowRight,
  ListChecks,
  GitBranch,
  WarningCircle,
  CheckCircle,
  Cube,
  ClockCounterClockwise,
  TerminalWindow,
  Plus,
  Circuitry,
  Calculator,
  Flask,
} from '@phosphor-icons/react';
import { useStore } from '../store';
import { ArtifactIcon, EmptyState, SectionHeading, StatusBadge, TextLink } from '../components/ui';

export function OverviewView() {
  const {
    project,
    artifacts,
    proposals,
    stale,
    suggestions,
    selectArtifact,
    navigate,
    events,
    set,
  } = useStore();
  const pending = proposals.filter((p) => p.state === 'pending');
  const outdated = artifacts.filter((v) => (stale[v.artifact.id] ?? []).length > 0);
  const approved = artifacts.filter((v) => v.revision?.reviewState === 'approved');
  const reqs = artifacts.filter((v) => v.artifact.type === 'requirement');
  const openArtifact = (id: string, type: string) => {
    selectArtifact(id);
    navigate(type === 'requirement' || type === 'assumption' ? 'requirements' : 'artifacts');
  };
  const domains = [
    {
      label: 'Mechanical design',
      type: 'mechanical',
      icon: Cube,
      empty: 'Models, geometry, and parameters',
    },
    {
      label: 'Electronics & wiring',
      type: 'wiring',
      icon: Circuitry,
      empty: 'Connections, power, and signals',
    },
    {
      label: 'Engineering calculations',
      type: 'calculation',
      icon: Calculator,
      empty: 'Inputs, assumptions, and results',
    },
    { label: 'Verification', type: 'test', icon: Flask, empty: 'Procedures and recorded evidence' },
  ];
  return (
    <div className="page-scroll overview">
      <div className="project-summary-line">
        <span>Project overview</span>
        <span className="grow" />
        <button className="text-link" onClick={() => navigate('files')}>
          Project files
          <ArrowRight size={14} />
        </button>
      </div>
      <h1 className="overview-title">{project?.name ?? 'Your project'}</h1>
      <p className="overview-intent">
        {project?.intent || 'Give your idea a place to become an engineered system.'}
      </p>
      <div className="overview-metrics">
        {[
          { icon: ListChecks, label: 'Requirements', value: reqs.length },
          { icon: CheckCircle, label: 'Approved objects', value: approved.length },
          { icon: GitBranch, label: 'Awaiting review', value: pending.length },
          { icon: WarningCircle, label: 'Out of date', value: outdated.length },
        ].map((m) => (
          <div className="overview-metric" key={m.label}>
            <m.icon size={15} />
            <div>
              <strong className="num">{m.value}</strong>
              <small>{m.label}</small>
            </div>
          </div>
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
              count={pending.length + outdated.length}
              action={<TextLink onClick={() => navigate('reviews')}>Open review queue</TextLink>}
            />
            {pending.slice(0, 2).map((p) => (
              <button className="attention-row" key={p.id} onClick={() => navigate('reviews')}>
                <GitBranch size={18} />
                <span className="grow">
                  <strong>{p.reason}</strong>
                  <small>
                    {p.changes.length} proposed {p.changes.length === 1 ? 'change' : 'changes'}{' '}
                    ready for your review
                  </small>
                </span>
                <StatusBadge state="pending" />
                <ArrowRight size={15} />
              </button>
            ))}
            {outdated.slice(0, 2).map((v) => (
              <button
                className="attention-row"
                key={v.artifact.id}
                onClick={() => openArtifact(v.artifact.id, v.artifact.type)}
              >
                <WarningCircle size={18} />
                <span className="grow">
                  <strong>{v.artifact.title}</strong>
                  <small>
                    An upstream input changed. Inspect the impact before using this result.
                  </small>
                </span>
                <ArrowRight size={15} />
              </button>
            ))}
            {!pending.length && !outdated.length && (
              <div className="inline-notice row">
                <CheckCircle size={17} className="ok" />
                <span>No pending reviews or outdated dependencies.</span>
              </div>
            )}
          </section>
          <section className="overview-section">
            <SectionHeading
              title="Engineering workspace"
              action={<TextLink onClick={() => navigate('artifacts')}>All design files</TextLink>}
            />
            <div className="workstream-grid">
              {domains.map((d) => {
                const objects = artifacts.filter((v) => v.artifact.type === d.type);
                return (
                  <button
                    key={d.type}
                    className="workstream"
                    onClick={() => {
                      selectArtifact(objects[0]?.artifact.id ?? null);
                      navigate('artifacts');
                    }}
                  >
                    <span className="workstream-icon">
                      <d.icon size={20} weight="light" />
                    </span>
                    <span className="grow">
                      <strong>{d.label}</strong>
                      <small>
                        {objects.length
                          ? `${objects.length} ${objects.length === 1 ? 'object' : 'objects'} in this project`
                          : d.empty}
                      </small>
                    </span>
                    <ArrowRight size={14} className="faint" />
                  </button>
                );
              })}
            </div>
          </section>
          <section className="overview-section">
            <SectionHeading
              title="Engineering record"
              count={artifacts.length}
              action={
                <TextLink
                  onClick={() => {
                    set({ quickOpen: true });
                  }}
                >
                  Find an object
                </TextLink>
              }
            />
            <table className="record-table">
              <thead>
                <tr>
                  <th>Object</th>
                  <th>Revision</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {[...artifacts]
                  .filter((v) => !['source', 'component'].includes(v.artifact.type))
                  .slice(0, 6)
                  .map((v) => (
                    <tr key={v.artifact.id}>
                      <td>
                        <button onClick={() => openArtifact(v.artifact.id, v.artifact.type)}>
                          <ArtifactIcon type={v.artifact.type} />
                          <span>{v.artifact.title}</span>
                        </button>
                      </td>
                      <td className="faint num">
                        {v.revision ? `r${String(v.revision.seq).padStart(2, '0')}` : 'No baseline'}
                      </td>
                      <td>
                        <StatusBadge
                          state={
                            v.freshness !== 'current'
                              ? v.freshness
                              : v.pendingProposal
                                ? 'pending'
                                : (v.revision?.reviewState ?? 'draft')
                          }
                        />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
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
            title="Recent activity"
            action={<TextLink onClick={() => navigate('history')}>View history</TextLink>}
          />
          {events
            .filter((e) =>
              ['proposal.resolved', 'baseline.changed', 'project.created'].includes(e.type),
            )
            .slice(-3)
            .reverse()
            .map((e) => (
              <div className="activity-row" key={e.id}>
                <ClockCounterClockwise size={15} />
                <div>
                  {e.type === 'project.created'
                    ? 'Project created'
                    : e.type === 'baseline.changed'
                      ? 'Engineering baseline updated'
                      : 'Review decision recorded'}
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
            ))}
        </section>
      )}
    </div>
  );
}
export function EmptyBlock(props: { title: string; body: string }) {
  return <EmptyState {...props} />;
}
