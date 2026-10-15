import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  ArrowUUpLeft,
  At,
  CaretDown,
  CaretUp,
  CheckCircle,
  CircleDashed,
  GitBranch,
  Lightbulb,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import type { Proposal } from '@omenflow/contracts';
import { useStore } from '../../store';
import { Button, IconButton, relativeTime, Tooltip, typeMeta } from '../../ui/kit';
import {
  hasRows,
  needsQueue,
  needsRows,
  quietLine,
  type OutdatedItem,
  type Suggestion,
} from './queue';

/** Rows shown before the rest are folded behind "n more". */
const ROW_LIMIT = 4;
/** Below this window width the island rests as a pill and opens over the map. */
const NARROW = '(max-width: 1120px)';

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const query = window.matchMedia(NARROW);
    const update = () => setNarrow(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return narrow;
}

const ACTORS: Record<Proposal['createdBy'], string> = {
  user: 'You',
  agent: 'Agent',
  system: 'System',
};

/** How an object is named to the agent: the same form "Ask agent" uses everywhere. */
const reference = (item: OutdatedItem) =>
  `${typeMeta(item.type).label.toLowerCase()} "${item.title}" (artifact ${item.id}${
    item.revision ? `, revision ${item.revision}` : ''
  })`;

/** Hands a request to the agent for the person to send; it waits until the CLI is ready. */
function ask(text: string) {
  useStore.getState().askAbout(text);
}

function ProposalRow({ proposal, returned }: { proposal: Proposal; returned?: boolean }) {
  const decide = useStore((s) => s.decide);
  const changes = `${proposal.changes.length} ${proposal.changes.length === 1 ? 'change' : 'changes'}`;
  const when = relativeTime(
    returned ? (proposal.resolvedAt ?? proposal.createdAt) : proposal.createdAt,
  );
  const detail = returned
    ? `Changes requested · ${changes} · ${when}`
    : `${ACTORS[proposal.createdBy]} proposed ${changes} · ${when}`;
  return (
    <div className="needs-row">
      <button type="button" className="needs-open" onClick={() => decide(proposal.id)}>
        {returned ? (
          <ArrowUUpLeft size={15} className="needs-icon" />
        ) : (
          <GitBranch size={15} className="needs-icon warn" />
        )}
        <span className="needs-copy">
          <strong title={proposal.reason}>{proposal.reason}</strong>
          <small title={detail}>{detail}</small>
        </span>
        <ArrowRight size={13} className="needs-go" />
      </button>
    </div>
  );
}

function OutdatedRow({ item, canAsk }: { item: OutdatedItem; canAsk: boolean }) {
  const focus = useStore((s) => s.focus);
  const missing = item.reason === 'missing_input';
  const detail = `${missing ? 'Missing input' : 'Out of date'} · ${item.why}`;
  return (
    <div className="needs-row">
      <button type="button" className="needs-open" onClick={() => focus(item.id)}>
        <WarningCircle size={15} className={`needs-icon ${missing ? 'err' : 'warn'}`} />
        <span className="needs-copy">
          <strong title={`${typeMeta(item.type).label}: ${item.title}`}>{item.title}</strong>
          <small title={detail}>{detail}</small>
        </span>
      </button>
      {canAsk && (
        <IconButton
          size="sm"
          label="Ask the agent to re-evaluate"
          onClick={() =>
            ask(
              `Re-evaluate the Omen Flow ${reference(item)}. It is ${
                missing ? 'missing an input' : 'out of date'
              }: ${item.why}. `,
            )
          }
        >
          <At size={13} />
        </IconButton>
      )}
    </div>
  );
}

function SuggestionRow({ suggestion }: { suggestion: Suggestion }) {
  const dismiss = () => {
    const { suggestions, set } = useStore.getState();
    set({
      suggestions: suggestions.filter(
        (s) => s.title !== suggestion.title || s.detail !== suggestion.detail,
      ),
    });
  };
  return (
    <div className="needs-row needs-suggestion">
      <Lightbulb size={15} className="needs-icon signal" />
      <span className="needs-copy">
        <strong>{suggestion.title}</strong>
        {suggestion.detail && <small>{suggestion.detail}</small>}
      </span>
      <IconButton size="sm" label="Dismiss suggestion" onClick={dismiss}>
        <X size={12} />
      </IconButton>
    </div>
  );
}

/**
 * The work queue: what waits on a human, what is back with the agent, and what the agent
 * suggested. One quiet line when there is nothing to list; a pill at narrow widths.
 *
 * `onRest` receives the element while the open island rests on the canvas, so the map can keep
 * clear of it, and null while it is a pill or floats over the map.
 */
export function NeedsYou({ onRest }: { onRest: (island: HTMLElement | null) => void }) {
  const proposals = useStore((s) => s.proposals);
  const artifacts = useStore((s) => s.artifacts);
  const stale = useStore((s) => s.stale);
  const suggestions = useStore((s) => s.suggestions);
  const readOnly = useStore((s) => s.readOnly);
  const narrow = useNarrow();
  /** The user's own choice to open or close the island; until they make one it follows the width. */
  const [choice, setChoice] = useState<boolean | null>(null);
  const [showAll, setShowAll] = useState(false);
  const queue = useMemo(
    () => needsQueue({ proposals, artifacts, stale, suggestions }),
    [proposals, artifacts, stale, suggestions],
  );

  if (!hasRows(queue)) {
    const line = quietLine(queue);
    return (
      <div className="needs island quiet" role="status">
        {line.settled ? (
          <CheckCircle size={14} className="tone-ok-text" />
        ) : (
          <CircleDashed size={14} />
        )}
        {line.text}
      </div>
    );
  }

  const open = choice ?? !narrow;
  if (!open)
    return (
      <button
        type="button"
        className="needs island quiet needs-pill"
        aria-expanded={false}
        onClick={() => setChoice(true)}
      >
        {queue.count > 0 ? (
          <>
            <span className="needs-dot" aria-hidden="true" />
            Needs you <span className="count">{queue.count}</span>
          </>
        ) : (
          'Nothing waits on you'
        )}
        <CaretDown size={11} />
      </button>
    );

  const { rows, hidden } = needsRows(queue, showAll ? Number.POSITIVE_INFINITY : ROW_LIMIT);
  const canAsk = !readOnly;
  return (
    <aside
      className={`needs island${narrow ? ' floating' : ''}`}
      aria-label="Needs you"
      data-rows={rows.length > 2 ? 'many' : undefined}
      ref={narrow ? undefined : onRest}
    >
      <header className="needs-head">
        <span>{queue.count > 0 ? 'Needs you' : 'Nothing waits on you'}</span>
        {queue.count > 0 && <span className="count">{queue.count}</span>}
        <span className="grow" />
        {hidden > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>
            {hidden} more
          </Button>
        )}
        {canAsk && queue.outdated.length > 1 && (
          <Tooltip
            label={`Ask the agent to re-evaluate all ${queue.outdated.length} out-of-date objects`}
          >
            <Button
              size="sm"
              variant="ghost"
              icon={<At size={12} />}
              onClick={() =>
                ask(
                  `Re-evaluate these out-of-date Omen Flow objects, starting with the ones closest to the change: ${queue.outdated
                    .map(reference)
                    .join('; ')}. `,
                )
              }
            >
              Re-evaluate all
            </Button>
          </Tooltip>
        )}
        <IconButton size="sm" label="Collapse" onClick={() => setChoice(false)}>
          <CaretUp size={12} />
        </IconButton>
      </header>
      <div className="needs-list">
        {rows.length > 0 && (
          <div className="needs-rows">
            {rows.map((row) =>
              row.kind === 'review' ? (
                <ProposalRow key={row.proposal.id} proposal={row.proposal} />
              ) : (
                <OutdatedRow key={row.item.id} item={row.item} canAsk={canAsk} />
              ),
            )}
          </div>
        )}
        {queue.returned.length > 0 && (
          <section className="needs-section">
            <h3 className="needs-sub">Back with the agent</h3>
            {queue.returned.map((p) => (
              <ProposalRow key={p.id} proposal={p} returned />
            ))}
          </section>
        )}
        {queue.suggestions.length > 0 && (
          <section className="needs-section">
            <h3 className="needs-sub">Suggested by the agent</h3>
            {queue.suggestions.slice(-3).map((s) => (
              <SuggestionRow key={`${s.title}\n${s.detail ?? ''}`} suggestion={s} />
            ))}
          </section>
        )}
      </div>
    </aside>
  );
}
