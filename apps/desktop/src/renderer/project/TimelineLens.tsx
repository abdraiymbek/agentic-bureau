import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CaretRight } from '@phosphor-icons/react';
import type { AgentCallRecord, ArtifactView, ProjectEvent, Proposal } from '@omenflow/contracts';
import { errMsg } from '../api';
import { useStore } from '../store';
import { Button, Checkbox, Empty, Segmented, TypeGlyph, stateLabel, typeMeta } from '../ui/kit';
import { useAgentCalls, type AgentCalls } from './agent-calls';
import { useRowNav, type RowProps } from './row-nav';
import { useViewState } from '../lib/view-memory';
import {
  ACTOR_LABEL,
  eventFields,
  filterEvents,
  groupByDay,
  interleaveCalls,
  timelineRows,
  type Actor,
  type CallRun,
  type TimelineEntry,
} from './timeline';

/** Every decision and revision, newest first, grouped by day, back to the start of the record. */
export function TimelineLens() {
  const projectId = useStore((s) => s.projectId);
  // The store holds the record's window and pages older events in (`loadOlderEvents`).
  const events = useStore((s) => s.events);
  const hasOlder = useStore((s) => s.hasOlderEvents);
  const olderState = useStore((s) => s.olderEvents);
  const loadOlderEvents = useStore((s) => s.loadOlderEvents);
  const artifacts = useStore((s) => s.artifacts);
  const proposals = useStore((s) => s.proposals);
  const [actor, setActor] = useViewState<Actor>('timeline:actor', 'all');
  const [objectId, setObjectId] = useViewState<string | null>('timeline:object', null);
  const [showCalls, setShowCalls] = useViewState('timeline:calls', true);
  const calls = useAgentCalls(projectId);
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const atStart = !hasOlder;

  const loadOlder = useCallback(() => {
    if (hasOlder && olderState === 'idle') void loadOlderEvents();
  }, [hasOlder, olderState, loadOlderEvents]);

  const callsReady = calls.state.status === 'ready' && showCalls;
  const days = useMemo(() => {
    const components = new Set(
      artifacts.filter((v) => v.artifact.type === 'component').map((v) => v.artifact.id),
    );
    const rows = timelineRows(filterEvents(events, { actor, objectId }, proposals, components));
    const visibleCalls =
      callsReady && calls.state.status === 'ready' && (actor === 'all' || actor === 'agent')
        ? calls.state.calls.filter((c) => !objectId || c.artifactIds.includes(objectId))
        : [];
    const since = atStart ? null : (events[0]?.ts ?? null);
    return groupByDay(interleaveCalls(rows, visibleCalls, since));
  }, [events, actor, objectId, proposals, artifacts, callsReady, calls.state, atStart]);

  // Older pages load as the end of the list comes into view.
  useEffect(() => {
    const target = sentinel.current;
    if (!target || atStart) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadOlder();
      },
      { root: scroller.current, rootMargin: '400px 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [loadOlder, atStart]);

  // Calls older than the loaded record are read once the record reaches back that far.
  const { loadOlder: loadOlderCalls } = calls;
  useEffect(() => {
    if (calls.state.status !== 'ready' || !showCalls) return;
    const oldestCall = calls.state.calls[0];
    const oldestEvent = events[0];
    if (oldestCall && oldestEvent && (atStart || oldestCall.at > oldestEvent.ts)) loadOlderCalls();
  }, [calls.state, events, atStart, showCalls, loadOlderCalls]);

  const objects = useMemo(
    () =>
      [...artifacts].sort(
        (a, b) =>
          a.artifact.type.localeCompare(b.artifact.type) ||
          a.artifact.title.localeCompare(b.artifact.title),
      ),
    [artifacts],
  );
  const keys = days.flatMap((d) => d.items.map((i) => i.key));
  const rowProps = useRowNav(keys);
  const filtered = actor !== 'all' || objectId !== null;

  return (
    <div className="lens-page timeline" ref={scroller} data-rows="">
      <div className="lens-bar">
        <Segmented
          label="Who acted"
          value={actor}
          onChange={setActor}
          options={[
            { value: 'all', label: 'Everyone' },
            { value: 'user', label: ACTOR_LABEL.user },
            { value: 'agent', label: ACTOR_LABEL.agent },
            { value: 'system', label: ACTOR_LABEL.system },
          ]}
        />
        <select
          className="timeline-object"
          aria-label="Object"
          value={objectId ?? ''}
          onChange={(e) => setObjectId(e.target.value || null)}
        >
          <option value="">All objects</option>
          {objects.map((v) => (
            <option key={v.artifact.id} value={v.artifact.id}>
              {typeMeta(v.artifact.type).label} · {v.artifact.title}
            </option>
          ))}
        </select>
        {calls.state.status === 'ready' && (
          <Checkbox checked={showCalls} onChange={setShowCalls} label="Agent tool calls" />
        )}
        <span className="grow" />
        <CallsNote calls={calls.state} shown={showCalls} />
      </div>

      {!days.length && atStart ? (
        filtered ? (
          <p className="lens-muted">Nothing in the record matches this filter.</p>
        ) : (
          <Empty
            title="The record starts here"
            body="Revisions, proposals, and your decisions appear on this line as you work."
          />
        )
      ) : (
        days.map((g) => (
          <section key={g.key} className="timeline-day" aria-label={g.label}>
            <h3>{g.label}</h3>
            <ol>
              {g.items.map((item) =>
                item.kind === 'event' ? (
                  <EventRow
                    key={item.key}
                    entry={item}
                    artifacts={artifacts}
                    proposals={proposals}
                    rowProps={rowProps}
                  />
                ) : (
                  <CallRow key={item.key} run={item} artifacts={artifacts} rowProps={rowProps} />
                ),
              )}
            </ol>
          </section>
        ))
      )}

      <div ref={sentinel} className="timeline-end">
        {atStart ? (
          days.length > 0 && <p className="timeline-start">Start of the record</p>
        ) : olderState === 'error' ? (
          <p className="tone-warn-text" role="alert">
            Earlier entries didn’t load.{' '}
            <Button size="sm" onClick={() => void loadOlderEvents()}>
              Try again
            </Button>
          </p>
        ) : (
          <Button size="sm" variant="ghost" busy={olderState === 'loading'} onClick={loadOlder}>
            {olderState === 'loading' ? 'Loading earlier entries' : 'Show earlier entries'}
          </Button>
        )}
      </div>
    </div>
  );
}

function CallsNote({ calls, shown }: { calls: AgentCalls; shown: boolean }) {
  if (calls.status === 'error')
    return <span className="dim">Agent tool calls didn’t load: {calls.message}</span>;
  if (calls.status !== 'ready' || !shown) return null;
  if (calls.olderError)
    return <span className="dim">Earlier agent calls didn’t load: {calls.olderError}</span>;
  return null;
}

/** What a row opens: the object, the decision, the parts list, the exported package. */
function openers() {
  const s = useStore.getState();
  return {
    object: (id: string) => s.focus(id),
    decision: (id: string) => s.decide(id),
    lens: (lens: 'parts' | 'flow') => s.go({ level: 'project', lens }),
    reveal: (path: string) =>
      void window.omenflow.revealPath(path).catch((e) => s.toast('error', errMsg(e))),
  };
}

interface Target {
  label: React.ReactNode;
  open: () => void;
}

function eventTarget(
  e: ProjectEvent,
  artifacts: ArtifactView[],
  proposals: Proposal[],
  open: ReturnType<typeof openers>,
): Target | null {
  const d = eventFields(e);
  const object = (id: string | undefined) =>
    id ? artifacts.find((v) => v.artifact.id === id)?.artifact : undefined;
  const subject = object(d.artifactId);
  if (subject)
    return {
      label: (
        <>
          <TypeGlyph type={subject.type} size={13} />
          {subject.title}
        </>
      ),
      open: () => open.object(subject.id),
    };
  const proposalId = d.proposalId;
  if (proposalId) {
    const reason = proposals.find((p) => p.id === proposalId)?.reason ?? d.reason;
    return { label: reason ?? 'Open the decision', open: () => open.decision(proposalId) };
  }
  if (e.type === 'impact.propagated') {
    const cause = object(d.changed[0]);
    const n = d.affected ?? 0;
    const reach = `${n} connected ${n === 1 ? 'object' : 'objects'}`;
    return cause
      ? {
          label: (
            <>
              <TypeGlyph type={cause.type} size={13} />
              {cause.title} → {reach}
            </>
          ),
          open: () => open.object(cause.id),
        }
      : null;
  }
  if (e.type === 'bom.changed')
    return { label: 'Bill of materials', open: () => open.lens('parts') };
  const destPath = d.destPath;
  if (e.type === 'build.exported' && destPath)
    return { label: 'Reveal the package', open: () => open.reveal(destPath) };
  if (e.type === 'project.intent_changed')
    return { label: 'Project intent', open: () => open.lens('flow') };
  return null;
}

function Time({ iso }: { iso: string }) {
  const d = new Date(iso);
  return (
    <time dateTime={iso} title={d.toLocaleString()}>
      {d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
    </time>
  );
}

function EventRow({
  entry: { event: e, labels, count },
  artifacts,
  proposals,
  rowProps,
}: {
  entry: TimelineEntry;
  artifacts: ArtifactView[];
  proposals: Proposal[];
  rowProps: (key: string, open: () => void) => RowProps;
}) {
  const open = openers();
  const d = eventFields(e);
  const target = eventTarget(e, artifacts, proposals, open);
  const decision = e.type === 'proposal.resolved' && d.state ? stateLabel(d.state) : null;
  const quote = d.rationale ?? (e.type === 'project.intent_changed' ? d.intent : undefined);
  const props = rowProps(e.id, () => target?.open());
  return (
    <li
      {...props}
      className={`timeline-item lens-row origin-${e.origin}`}
      aria-label={[labels.join(', '), decision, ACTOR_LABEL[e.origin]].filter(Boolean).join(', ')}
    >
      <Time iso={e.ts} />
      <span className="timeline-dot" aria-hidden="true" />
      <div className="timeline-body">
        <span className="timeline-what">
          {labels.join(' · ')}
          {count > 1 && <span className="dim"> · {count} times</span>}
          {decision && <span className={`timeline-decision d-${d.state}`}> · {decision}</span>}
        </span>
        {target ? (
          <button type="button" className="cell-link" tabIndex={-1} onClick={target.open}>
            {target.label}
          </button>
        ) : (
          e.type === 'artifact.archived' && <span className="dim">An archived object</span>
        )}
        {quote && <p className="timeline-why">“{quote}”</p>}
      </div>
      <span className="timeline-who">{ACTOR_LABEL[e.origin] ?? e.origin}</span>
    </li>
  );
}

function CallRow({
  run,
  artifacts,
  rowProps,
}: {
  run: CallRun;
  artifacts: ArtifactView[];
  rowProps: (key: string, open: () => void) => RowProps;
}) {
  const [open, setOpen] = useState(false);
  const failed = run.calls.filter((c) => !c.ok).length;
  const n = run.calls.length;
  const summary = `Agent made ${n} tool ${n === 1 ? 'call' : 'calls'}${failed ? ` · ${failed} failed` : ''}`;
  const props = rowProps(run.key, () => setOpen(!open));
  return (
    <li
      {...props}
      className="timeline-item timeline-calls lens-row origin-agent"
      aria-label={summary}
    >
      <Time iso={run.calls[0]!.at} />
      <span className="timeline-dot" aria-hidden="true" />
      <div className="timeline-body">
        <button
          type="button"
          className="timeline-calls-toggle"
          aria-expanded={open}
          tabIndex={-1}
          onClick={() => setOpen(!open)}
        >
          <CaretRight size={11} className="disclosure-caret" />
          {summary}
        </button>
        {open && (
          <ol className="timeline-call-list">
            {run.calls.map((c) => (
              <CallLine key={c.seq} call={c} artifacts={artifacts} />
            ))}
          </ol>
        )}
      </div>
      <span className="timeline-who">Agent</span>
    </li>
  );
}

function CallLine({ call: c, artifacts }: { call: AgentCallRecord; artifacts: ArtifactView[] }) {
  const focus = useStore((s) => s.focus);
  const subject = c.artifactIds
    .map((id) => artifacts.find((v) => v.artifact.id === id)?.artifact)
    .find(Boolean);
  return (
    <li>
      <Time iso={c.at} />
      <span className="mono timeline-call-tool">{c.tool}</span>
      <span className={c.ok ? 'dim' : 'timeline-call-failed'}>
        {c.ok ? 'Done' : `Failed${c.code ? ` · ${c.code}` : ''}`}
      </span>
      <span className="num dim">{Math.round(c.durationMs)} ms</span>
      {subject && (
        <button type="button" className="cell-link dim" onClick={() => focus(subject.id)}>
          <TypeGlyph type={subject.type} size={12} />
          {subject.title}
        </button>
      )}
      {!c.ok && c.message && <p className="timeline-call-note">{c.message}</p>}
      {c.notes.map((note) => (
        <p key={note} className="timeline-call-note dim">
          Input repaired: {note}
        </p>
      ))}
    </li>
  );
}
