/**
 * One call in a turn's Recorded activity, as the host's ledger recorded it: whether it returned,
 * what the host also ran inside it (the check a write with `expect` ran, the work status attached
 * to a committed check) and the objects it named. A call that returned while the check it ran did
 * not pass reads in the warning tone, as in the activity rail, so an ok call is not read as
 * verified.
 */
import React from 'react';
import { ArrowRight } from '@phosphor-icons/react';
import type { AgentCallRecord } from '@omenflow/contracts';
import { State } from '../ui/kit';
import { alsoRanLine, asAlsoRan } from '../shell/agent/activity';

export function RecordedCall({
  call,
  onInspect,
}: {
  call: AgentCallRecord;
  onInspect: (artifactId: string) => void;
}) {
  const also = asAlsoRan(call.alsoRan).map(alsoRanLine);
  const warned = call.ok && also.some((line) => line.warn);
  return (
    <li>
      <State
        state={call.ok ? 'succeeded' : 'failed'}
        dimension="execution"
        label={call.ok ? 'Returned' : 'Failed'}
        tone={warned ? 'warn' : undefined}
      />
      <code>{call.tool}</code>
      <span>{call.durationMs} ms</span>
      {call.message && <small>{call.message}</small>}
      {also.map((line, i) => (
        <small key={`also-${i}`} className={`chat-call-also${line.warn ? ' warn' : ''}`}>
          Host also ran: {line.text}
        </small>
      ))}
      {call.artifactIds.map((id) => (
        <button type="button" key={id} onClick={() => onInspect(id)}>
          Inspect object {id.slice(-6)}
          <ArrowRight size={11} />
        </button>
      ))}
    </li>
  );
}
