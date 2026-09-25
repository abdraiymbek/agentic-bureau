import React, { useMemo } from 'react';
import type { ProjectEvent } from '@omenflow/contracts';
import { useStore } from '../store';
import { Empty, TypeGlyph } from '../ui/kit';

const LABELS: Record<string, string> = {
  'proposal.submitted': 'Proposed',
  'proposal.resolved': 'Decided',
  'baseline.changed': 'Baseline updated',
  'impact.propagated': 'Impact reached',
  'revision.committed': 'Revised',
  'project.created': 'Project created',
  'project.intent_changed': 'Intent changed',
  'build.exported': 'Build exported',
  'bom.changed': 'Bill of materials changed',
  'artifact.archived': 'Archived',
};

const ORIGIN: Record<string, string> = { user: 'You', agent: 'Agent', system: 'System' };

/** Every decision and revision, newest first, grouped by day. */
export function TimelineLens() {
  const events = useStore((s) => s.events);
  const artifacts = useStore((s) => s.artifacts);
  const proposals = useStore((s) => s.proposals);
  const { focus, decide } = useStore.getState();
  const titleOf = (id: string) => artifacts.find((v) => v.artifact.id === id)?.artifact;

  const days = useMemo(() => {
    const kept = events
      .filter((e) => {
        if (!LABELS[e.type]) return false;
        const affected = (e.data as { affected?: unknown[] } | null)?.affected;
        return !(
          e.type === 'impact.propagated' &&
          Array.isArray(affected) &&
          affected.length === 0
        );
      })
      .slice()
      .reverse();
    // One change often records a revision and a baseline move back to back; show it once.
    const merged: { event: ProjectEvent; labels: string[] }[] = [];
    for (const e of kept) {
      const id = (e.data as { artifactId?: string } | null)?.artifactId;
      const last = merged[merged.length - 1];
      const lastId = (last?.event.data as { artifactId?: string } | null)?.artifactId;
      if (
        last &&
        id &&
        id === lastId &&
        last.event.origin === e.origin &&
        Math.abs(new Date(last.event.ts).getTime() - new Date(e.ts).getTime()) < 10_000
      ) {
        last.labels.unshift(LABELS[e.type]!);
        continue;
      }
      merged.push({ event: e, labels: [LABELS[e.type]!] });
    }
    const groups: { day: string; items: { event: ProjectEvent; labels: string[] }[] }[] = [];
    for (const item of merged) {
      const day = new Date(item.event.ts).toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      });
      const last = groups[groups.length - 1];
      if (last?.day === day) last.items.push(item);
      else groups.push({ day, items: [item] });
    }
    return groups;
  }, [events]);

  if (!days.length)
    return (
      <div className="lens-page">
        <Empty
          title="The record starts here"
          body="Revisions, proposals, and your decisions appear on this line as you work."
        />
      </div>
    );

  return (
    <div className="lens-page timeline">
      {days.map((g) => (
        <section key={g.day} className="timeline-day">
          <h3>{g.day}</h3>
          <ol>
            {g.items.map(({ event: e, labels }) => {
              const d = (e.data ?? {}) as {
                artifactId?: string;
                proposalId?: string;
                state?: string;
                reason?: string;
                affected?: unknown[];
                rationale?: string;
              };
              const subject = d.artifactId ? titleOf(d.artifactId) : undefined;
              const proposal = d.proposalId
                ? proposals.find((p) => p.id === d.proposalId)
                : undefined;
              const decision =
                e.type === 'proposal.resolved' ? d.state?.replaceAll('_', ' ') : undefined;
              return (
                <li key={e.id} className={`timeline-item origin-${e.origin}`}>
                  <span className="timeline-dot" aria-hidden="true" />
                  <time>
                    {new Date(e.ts).toLocaleTimeString(undefined, {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </time>
                  <div className="timeline-body">
                    <span className="timeline-what">
                      {labels.join(' · ')}
                      {decision && (
                        <span className={`timeline-decision d-${d.state}`}> · {decision}</span>
                      )}
                    </span>
                    {subject ? (
                      <button type="button" className="cell-link" onClick={() => focus(subject.id)}>
                        <TypeGlyph type={subject.type} size={13} />
                        {subject.title}
                      </button>
                    ) : proposal || d.reason ? (
                      <button
                        type="button"
                        className="cell-link"
                        onClick={() => decide(d.proposalId ?? null)}
                      >
                        {proposal?.reason ?? d.reason}
                      </button>
                    ) : e.type === 'impact.propagated' && Array.isArray(d.affected) ? (
                      <span className="dim">
                        {d.affected.length} connected{' '}
                        {d.affected.length === 1 ? 'object' : 'objects'}
                      </span>
                    ) : null}
                    {d.rationale && <p className="timeline-why">“{d.rationale}”</p>}
                  </div>
                  <span className="timeline-who">{ORIGIN[e.origin] ?? e.origin}</span>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
