import React from 'react';
import type { ArtifactView } from '@omenflow/contracts';
import { Segmented, State, TypeGlyph, relativeTime, shortId } from '../ui/kit';
import {
  listPhase,
  needsYou,
  phaseLabel,
  phaseTone,
  waitingOnAgent,
  type QueueFilter,
  type ReviewProposal,
} from './model';

const BY: Record<string, string> = { agent: 'Agent', user: 'You', system: 'System' };

function Entry({
  p,
  active,
  artifacts,
  onSelect,
}: {
  p: ReviewProposal;
  active: boolean;
  artifacts: Map<string, ArtifactView>;
  onSelect: () => void;
}) {
  const phase = listPhase(p, (id) => {
    const v = artifacts.get(id);
    return v ? v.artifact.selectedRevisionId : undefined;
  });
  const objects = p.changes.slice(0, 2);
  const more = p.changes.length - objects.length;
  return (
    <li>
      <button
        type="button"
        className={`queue-item ${active ? 'active' : ''}`}
        aria-current={active ? 'true' : undefined}
        onClick={onSelect}
      >
        <span className="queue-title" title={p.reason}>
          {p.reason}
        </span>
        <span className="queue-objects">
          {objects.map((c) => {
            const v = artifacts.get(c.artifactId);
            return (
              <span key={c.artifactId} className="queue-object">
                {v && <TypeGlyph type={v.artifact.type} size={12} />}
                <span className="truncate">
                  {v?.artifact.title ?? `object ${shortId(c.artifactId)}`}
                </span>
              </span>
            );
          })}
          {more > 0 && <span className="queue-more">+{more} more</span>}
        </span>
        <span className="queue-meta">
          <State state={p.state} label={phaseLabel(phase)} tone={phaseTone(phase)} quiet />
          <span>
            {BY[p.createdBy] ?? p.createdBy} ·{' '}
            <time dateTime={p.createdAt} title={new Date(p.createdAt).toLocaleString()}>
              {relativeTime(p.createdAt)}
            </time>{' '}
            · {p.changes.length} {p.changes.length === 1 ? 'change' : 'changes'}
          </span>
        </span>
      </button>
    </li>
  );
}

/** Left rail of the decision level: what needs the person, then everything. */
export function Queue({
  proposals,
  list,
  filter,
  onFilter,
  activeId,
  onSelect,
  artifacts,
}: {
  proposals: ReviewProposal[];
  list: ReviewProposal[];
  filter: QueueFilter;
  onFilter: (f: QueueFilter) => void;
  activeId: string | null;
  onSelect: (id: string) => void;
  artifacts: ArtifactView[];
}) {
  const byId = new Map(artifacts.map((a) => [a.artifact.id, a]));
  const waiting = waitingOnAgent(proposals).length;
  return (
    <aside className="rail rail-up decide-queue" aria-label="Proposals">
      <div className="decide-filter">
        <Segmented
          label="Which proposals"
          value={filter}
          onChange={onFilter}
          options={[
            { value: 'open', label: 'Needs you', count: needsYou(proposals).length },
            { value: 'all', label: 'All' },
          ]}
        />
        {filter === 'open' && waiting > 0 && (
          <button type="button" className="queue-note" onClick={() => onFilter('all')}>
            {waiting} waiting on the agent
          </button>
        )}
      </div>
      {list.length ? (
        <ul className="queue">
          {list.map((p) => (
            <Entry
              key={p.id}
              p={p}
              active={p.id === activeId}
              artifacts={byId}
              onSelect={() => onSelect(p.id)}
            />
          ))}
        </ul>
      ) : (
        <p className="rail-empty">
          {filter === 'open' ? 'Nothing waiting on you.' : 'No proposals yet.'}
        </p>
      )}
    </aside>
  );
}
