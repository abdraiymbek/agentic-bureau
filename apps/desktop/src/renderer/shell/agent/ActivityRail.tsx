import React, { useMemo } from 'react';
import { ArrowClockwise, CheckCircle, WarningCircle, X } from '@phosphor-icons/react';
import type { AgentCallRecord } from '@omenflow/contracts';
import { useStore } from '../../store';
import { askAgent } from '../../lib/actions';
import { useChat } from '../../chat/chat-store';
import { Button, IconButton, Notice, Skeleton, TypeGlyph, shortId } from '../../ui/kit';
import { useAgentUi } from './agent-store';
import { alsoRanLine, durationLabel, groupCalls, timeRange, toolWords } from './activity';
import { loadActivity } from './feed';
import type { Starter } from './starters';
import { useRailContent } from './useRailContent';

const clock = (iso: string) => {
  const t = new Date(iso);
  return Number.isFinite(t.getTime())
    ? t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : '';
};

function CallRow({ call }: { call: AgentCallRecord }) {
  const artifacts = useStore((s) => s.artifacts);
  const focus = useStore((s) => s.focus);
  const touched = call.artifactIds.map((id) => ({
    id,
    view: artifacts.find((v) => v.artifact.id === id) ?? null,
  }));
  return (
    <li className={`call ${call.ok ? 'ok' : 'failed'}`}>
      <div className="call-head">
        {call.ok ? (
          <CheckCircle size={13} className="call-mark" aria-hidden="true" />
        ) : (
          <WarningCircle size={13} weight="fill" className="call-mark" aria-hidden="true" />
        )}
        <span className="call-tool truncate">{toolWords(call.tool)}</span>
        <span className="call-outcome">{call.ok ? 'ok' : 'failed'}</span>
        {Number.isFinite(call.durationMs) && (
          <span className="call-time mono">{durationLabel(call.durationMs)}</span>
        )}
      </div>
      <div className="call-meta">
        <span className="mono">{call.tool}</span>
        <span>{clock(call.at)}</span>
        {call.via === 'call' && <span>omenflow call</span>}
      </div>
      {!call.ok && (
        <p className="call-error">
          {call.code && <span className="mono">{call.code}</span>}
          {call.code && call.message ? ' · ' : ''}
          {call.message ?? (call.code ? '' : 'The host recorded no error message.')}
        </p>
      )}
      {call.notes.length > 0 && (
        <ul className="call-notes" aria-label="Repairs the server applied">
          {call.notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      )}
      {call.alsoRan && call.alsoRan.length > 0 && (
        <ul className="call-also" aria-label="What the host also ran in this call">
          {call.alsoRan.map((entry, i) => {
            const line = alsoRanLine(entry);
            return (
              <li key={i} className={line.warn ? 'warn' : undefined}>
                {line.text}
              </li>
            );
          })}
        </ul>
      )}
      {touched.length > 0 && (
        <div className="call-objects" aria-label="Objects named in this call">
          {touched.map(({ id, view }) =>
            view ? (
              <button key={id} type="button" className="call-object" onClick={() => focus(id)}>
                <TypeGlyph type={view.artifact.type} size={12} />
                <span className="truncate">{view.artifact.title}</span>
              </button>
            ) : (
              <span
                key={id}
                className="call-object missing mono"
                aria-label={`Artifact ${id}, not among the loaded objects`}
              >
                {shortId(id)}
              </span>
            ),
          )}
        </div>
      )}
    </li>
  );
}

function Starters({ sessionId, starters }: { sessionId: string; starters: Starter[] }) {
  return (
    <section className="starters" aria-label="Starter prompts">
      <header>
        <h3>Start from the record</h3>
        <IconButton
          size="sm"
          label="Dismiss starters"
          onClick={() => useAgentUi.getState().dismissStarters(sessionId)}
        >
          <X size={12} />
        </IconButton>
      </header>
      <p className="starters-lede">Typed into the terminal for you to edit and send.</p>
      {starters.map((s) => (
        <button key={s.id} type="button" className="starter" onClick={() => askAgent(s.text)}>
          <strong>{s.label}</strong>
          <span>{s.text}</span>
        </button>
      ))}
    </section>
  );
}

/** The agent's recorded tool calls beside the terminal. Only ledger records appear here. */
export function ActivityRail() {
  const projectId = useStore((s) => s.projectId);
  const errorsOnly = useAgentUi((s) => s.errorsOnly);
  const { session, activity, counts, starters, idle } = useRailContent();
  const calls = activity.history ?? activity.calls;
  const shown = useMemo(
    () => (errorsOnly ? calls.filter((c) => !c.ok) : calls),
    [calls, errorsOnly],
  );
  const groups = useMemo(() => groupCalls(shown), [shown]);
  // Calls from a conversation's runs are named as such, not as an earlier terminal session.
  const conversationKey = useChat((s) =>
    projectId
      ? (s.projects[projectId]?.record.conversations
          .flatMap((c) => c.turns.map((t) => t.sessionId ?? ''))
          .join(' ') ?? '')
      : '',
  );
  const conversationSessions = useMemo(
    () => new Set(conversationKey.split(' ').filter(Boolean)),
    [conversationKey],
  );
  // With no record from the host and nothing else to offer, the rail stays out of the way.
  if (idle) return null;

  return (
    <aside className="activity-rail" aria-label="Agent activity">
      <header className="activity-rail-head">
        <h2>Activity</h2>
        {counts && (
          <span
            className={`activity-rail-summary ${counts.errors ? 'tone-err' : ''}`}
            role="status"
          >
            {counts.calls} {counts.calls === 1 ? 'call' : 'calls'}
            {counts.errors ? ` · ${counts.errors} failed` : ''} this session
          </span>
        )}
        <span className="grow" />
        {calls.some((c) => !c.ok) && (
          <button
            type="button"
            className="activity-rail-filter"
            aria-pressed={errorsOnly}
            onClick={() => useAgentUi.getState().setErrorsOnly(!errorsOnly)}
          >
            Failures only
          </button>
        )}
      </header>
      <div className="activity-rail-body">
        {activity.history && (
          <Button size="sm" variant="ghost" onClick={() => useAgentUi.getState().showLatestCalls()}>
            Back to latest calls
          </Button>
        )}
        {session && starters.length > 0 && <Starters sessionId={session.id} starters={starters} />}
        {activity.status === 'loading' && !activity.calls.length && <Skeleton lines={4} />}
        {activity.status === 'unavailable' && (
          <p className="activity-rail-note">
            {activity.calls.length
              ? 'History is not available from this host. Calls recorded since this window opened are shown.'
              : 'Activity is not available from this host.'}
          </p>
        )}
        {activity.status === 'error' && (
          <Notice
            tone="err"
            role="alert"
            action={
              projectId && (
                <Button
                  size="sm"
                  icon={<ArrowClockwise size={12} />}
                  onClick={() => void loadActivity(projectId)}
                >
                  Retry
                </Button>
              )
            }
          >
            <span className="activity-rail-error">
              Could not read the activity record: {activity.error}
            </span>
          </Notice>
        )}
        {activity.status === 'ready' && !activity.calls.length && (
          <p className="activity-rail-note">No tool calls recorded in this project yet.</p>
        )}
        {errorsOnly && !shown.length && calls.length > 0 && (
          <p className="activity-rail-note">No failed calls among those loaded.</p>
        )}
        {groups.map((g) => (
          <section key={`${g.sessionId}:${g.latest}`} className="call-group">
            <h3>
              <span>{timeRange(g.earliest, g.latest, clock)}</span>
              <span>
                {g.calls.length} {g.calls.length === 1 ? 'call' : 'calls'}
                {g.failures ? ` · ${g.failures} failed` : ''}
              </span>
              {conversationSessions.has(g.sessionId) ? (
                <span>conversation</span>
              ) : (
                session && g.sessionId !== session.id && <span>earlier session</span>
              )}
            </h3>
            <ol>
              {g.calls.map((c) => (
                <CallRow key={c.seq} call={c} />
              ))}
            </ol>
          </section>
        ))}
        {activity.hasMore && projectId && (
          <Button
            size="sm"
            variant="ghost"
            busy={activity.loadingOlder}
            onClick={() => void loadActivity(projectId, true)}
          >
            Load earlier calls
          </Button>
        )}
      </div>
    </aside>
  );
}

/** One line under the floating window's header: the latest recorded call. */
export function ActivityTicker() {
  const session = useStore((s) => s.session);
  const calls = useAgentUi((s) => s.activity.calls);
  const latest = session ? [...calls].reverse().find((c) => c.sessionId === session.id) : undefined;
  if (!latest) return null;
  return (
    <div
      className={`agent-ticker ${latest.ok ? '' : 'failed'}`}
      role="status"
      aria-label="Latest agent call"
    >
      {latest.ok ? (
        <CheckCircle size={12} aria-hidden="true" />
      ) : (
        <WarningCircle size={12} weight="fill" aria-hidden="true" />
      )}
      <span className="truncate">
        {toolWords(latest.tool)} ·{' '}
        {latest.ok ? 'ok' : `failed${latest.code ? ` ${latest.code}` : ''}`}
        {!latest.ok && latest.message ? ` · ${latest.message}` : ''}
      </span>
      {Number.isFinite(latest.durationMs) && (
        <span className="mono">{durationLabel(latest.durationMs)}</span>
      )}
    </div>
  );
}
