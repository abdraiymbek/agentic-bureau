import React from 'react';
import { Button, ConfirmButton, Kbd } from '../ui/kit';
import type { DecisionOp, Verdict } from './guard';
import type { Phase } from './model';

export interface Feedback {
  tone: 'ok' | 'err' | 'warn';
  text: string;
}

const BUSY: Record<DecisionOp, string> = {
  approve: 'Recording the approval…',
  reject: 'Recording the rejection…',
  request_changes: 'Sending the request back to the agent…',
};

/**
 * The decision bar, pinned under the proposal. Its own feedback line reports the outcome of a
 * decision once, in place, so nothing else ever has to cover it.
 */
export function DecisionBar({
  phase,
  rationale,
  onRationale,
  verdicts,
  busy,
  readOnly,
  feedback,
  feedbackAction,
  onDecide,
}: {
  phase: Phase;
  rationale: string;
  onRationale: (text: string) => void;
  verdicts: Record<DecisionOp, Verdict>;
  busy: DecisionOp | null;
  readOnly: boolean;
  feedback: Feedback | null;
  feedbackAction?: React.ReactNode;
  onDecide: (op: DecisionOp) => void;
}) {
  const waiting = phase.kind === 'waiting_on_agent';
  const reasonFor = (op: DecisionOp) => {
    const v = verdicts[op];
    return v.ok ? null : v.reason;
  };
  const why = busy
    ? BUSY[busy]
    : readOnly
      ? reasonFor('approve')
      : (reasonFor('approve') ??
        (rationale.trim()
          ? null
          : 'A rationale is optional to approve and required to reject or request changes.'));
  return (
    <div className="decision" role="group" aria-label="Decision" data-toast-avoid>
      {feedback && (
        <div
          className={`decision-feedback tone-${feedback.tone}`}
          role={feedback.tone === 'err' ? 'alert' : 'status'}
        >
          <span className="grow">{feedback.text}</span>
          {feedbackAction}
        </div>
      )}
      <textarea
        aria-label="Decision rationale"
        rows={1}
        disabled={!!busy || readOnly}
        placeholder={
          waiting
            ? 'Why you reject it now, or why it can stand as proposed'
            : 'Rationale: why this is right, or what must change. Kept in the record.'
        }
        value={rationale}
        onChange={(e) => onRationale(e.target.value)}
      />
      <div className="decision-actions">
        <ConfirmButton
          label="Reject"
          confirmLabel="Confirm rejection"
          disabled={!!busy || !verdicts.reject.ok}
          onConfirm={() => onDecide('reject')}
        />
        <span className="grow" />
        {!waiting && (
          <Button
            busy={busy === 'request_changes'}
            disabled={busy ? busy !== 'request_changes' : !verdicts.request_changes.ok}
            onClick={() => onDecide('request_changes')}
          >
            Request changes
          </Button>
        )}
        <Button
          variant={waiting ? 'secondary' : 'primary'}
          busy={busy === 'approve'}
          disabled={busy ? busy !== 'approve' : !verdicts.approve.ok}
          onClick={() => onDecide('approve')}
          aria-keyshortcuts={waiting ? undefined : 'Meta+Enter'}
          trailing={waiting ? undefined : <Kbd>⌘↵</Kbd>}
        >
          {waiting ? 'Approve as it stands' : 'Approve changes'}
        </Button>
      </div>
      <div className="decision-foot">
        <span className="decision-why" role="status">
          {why}
        </span>
        <span className="decision-keys">
          <Kbd>J</Kbd>
          <Kbd>K</Kbd> changes · <Kbd>[</Kbd>
          <Kbd>]</Kbd> proposals{waiting ? '' : ' · '}
          {!waiting && <Kbd>⌘↵</Kbd>}
          {!waiting && ' approve'}
        </span>
      </div>
    </div>
  );
}
