/**
 * The host's completion-gate record on a conversation turn: what work_status reported when the
 * response ended, read and recorded by Bureau, and what Bureau did about it. Agents cannot
 * present this; it is not a `chat.present` kind.
 */
import React from 'react';
import { ListChecks } from '../ui/icons';
import type { ChatGate, ChatTurn } from '@bureau/contracts';
import { Button, Notice, State, Time } from '../ui/kit';

/** Who continued an earlier turn, said on its collapsed record. */
export function continuedCaption(continuedBy: ChatTurn): string {
  return continuedBy.continues?.automatic
    ? 'Bureau continued once, automatically, below.'
    : 'You continued this below.';
}

/** Why Bureau did not continue the latest turn's unfinished work by itself, when it did not. */
export function autoCaption(gate: ChatGate): string | null {
  const auto = gate.auto;
  if (auto?.state !== 'skipped') return null;
  switch (auto.reason) {
    case 'needs_person':
      return 'The remaining items need you or facts from outside the project; there is nothing for the agent to resolve from the record.';
    case 'already_continued':
      return 'Bureau already continued once after your message. Continue yourself, or edit the request.';
    case 'jobs_running':
      return 'Not continued automatically: a job was still running when this response ended.';
    case 'busy':
      return 'Not continued automatically: another agent was working in this project.';
    case 'prompt_limit':
      return 'Not continued automatically: this conversation is too long. Start a new conversation.';
    case 'agent_unavailable':
      return `Not continued automatically: ${auto.detail ?? 'the agent could not start.'}`;
    case 'project_closed':
      return 'Not continued automatically: the project was closed.';
    case 'read_only':
      return 'Not continued automatically: the project is read-only.';
    default:
      return null;
  }
}

/**
 * A turn's gate that lists blockers. Earlier turns' records collapse to one quiet line, which says
 * who continued the turn when a continuation follows it. Only the latest turn can be continued, and
 * a continuation is always added after it, so the latest turn is never one that was continued.
 */
export function WorkNotFinished({
  gate,
  latest,
  continuedBy,
  blocked,
  refused,
  onContinue,
  onEdit,
}: {
  gate: ChatGate;
  /** The conversation's latest turn: only it can be continued. */
  latest: boolean;
  /** The turn that continues this one, when there is one (an earlier turn's). */
  continuedBy?: ChatTurn;
  /** The project is busy or read-only: Continue waits. */
  blocked: boolean;
  /** Why the host refused the last Continue. */
  refused?: string;
  onContinue: () => void;
  onEdit: () => void;
}) {
  const count = `${gate.blockers} ${gate.blockers === 1 ? 'blocker' : 'blockers'}`;
  if (!latest)
    return (
      <p className="chat-gate-earlier">
        <ListChecks size={14} aria-hidden="true" />
        <span>
          Work not finished when this response ended, per work_status recorded by Bureau:{' '}
          {gate.summary}
          {continuedBy && ` ${continuedCaption(continuedBy)}`}
        </span>
        <Time value={gate.checkedAt} />
      </p>
    );
  const caption = autoCaption(gate);
  return (
    <section className="inline-card chat-gate" aria-label="Work not finished">
      <header className="inline-card-head">
        <span className="inline-card-icon">
          <ListChecks size={18} />
        </span>
        <div>
          <span className="chat-eyebrow">
            Completion gate · work_status, recorded by Bureau <Time value={gate.checkedAt} /> when
            this response ended
          </span>
          <h2>Work not finished</h2>
        </div>
        <State state="unfinished" tone="warn" label={count} />
      </header>
      <p className="inline-caption">{gate.summary}</p>
      <ul className="chat-gate-items">
        {gate.outstanding.map((item, index) => (
          <li key={`${item.artifactId}-${item.kind}-${index}`}>
            <State
              state={item.kind}
              dimension="work"
              tone={item.severity === 'blocker' ? 'warn' : 'neutral'}
            />
            <strong>{item.title}</strong>
            <span>{item.detail}</span>
            {item.tool ? <code>{item.tool}</code> : <small>Needs you</small>}
          </li>
        ))}
        {gate.more > 0 && <li className="chat-gate-more">{gate.more} more in work_status</li>}
      </ul>
      {gate.jobsRunning > 0 && gate.auto?.state !== 'skipped' && (
        <p className="inline-caption">
          A job was still running when this response ended; this list may change when it finishes.
        </p>
      )}
      {caption && <p className="inline-caption">{caption}</p>}
      {refused && (
        <Notice tone="err" role="alert">
          {refused}
        </Notice>
      )}
      <div className="inline-card-actions">
        <Button variant="primary" size="sm" disabled={blocked} onClick={onContinue}>
          Continue
        </Button>
        <Button variant="ghost" size="sm" onClick={onEdit}>
          Edit request
        </Button>
      </div>
    </section>
  );
}

/**
 * A completed response that called no Bureau tool and touched nothing. Not a blocker, and
 * never continued automatically: a question can be answered without tools.
 */
export function NoToolCalls({
  latest,
  blocked,
  refused,
  onContinue,
}: {
  /** The conversation's latest turn: only it can be continued. */
  latest: boolean;
  blocked: boolean;
  refused?: string;
  onContinue: () => void;
}) {
  return (
    <div className="chat-gate-note" role="note">
      <p>
        <span className="chat-eyebrow">Recorded by Bureau</span>
        No Bureau tools were called in this response.
      </p>
      {latest && (
        <Button size="sm" variant="ghost" disabled={blocked} onClick={onContinue}>
          Continue
        </Button>
      )}
      {refused && latest && (
        <Notice tone="err" role="alert">
          {refused}
        </Notice>
      )}
    </div>
  );
}

/** The request side of a continuation: the person's Continue, or Bureau's one send. */
export function ContinuationMessage({ text, automatic }: { text: string; automatic: boolean }) {
  return (
    <article
      className={`chat-user-message is-continuation${automatic ? ' is-automatic' : ''}`}
      aria-label={automatic ? 'Sent by Bureau' : 'Your message, continue'}
    >
      <span className="chat-eyebrow">
        {automatic
          ? 'Sent by Bureau, once, because work_status reported unfinished work'
          : 'You asked the agent to continue'}
      </span>
      <div>{text}</div>
    </article>
  );
}
