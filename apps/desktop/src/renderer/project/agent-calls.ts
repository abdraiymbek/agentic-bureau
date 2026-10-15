/**
 * The agent call ledger as the Timeline reads it: `agent.activity` for what was recorded, the
 * host's live channel for what arrives while the lens is open. Only records the host supplies are
 * ever shown; a host without the ledger leaves the feature hidden.
 */
import { useCallback, useEffect, useState } from 'react';
import type { AgentActivity, AgentCallRecord } from '@omenflow/contracts';
import { errMsg } from '../api';
import { optionalCommand } from './optional-op';

export const CALL_PAGE = 100;

export type AgentCalls =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      calls: AgentCallRecord[];
      atStart: boolean;
      loadingOlder: boolean;
      olderError: string | null;
    };

/** Accepts only well-formed records for this project from the live channel. */
export function asAgentCall(value: unknown, projectId: string): AgentCallRecord | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<AgentCallRecord>;
  if (
    v.projectId !== projectId ||
    typeof v.seq !== 'number' ||
    typeof v.at !== 'string' ||
    typeof v.tool !== 'string' ||
    typeof v.op !== 'string' ||
    typeof v.ok !== 'boolean' ||
    typeof v.durationMs !== 'number' ||
    !Array.isArray(v.artifactIds)
  )
    return null;
  return {
    seq: v.seq,
    at: v.at,
    projectId: v.projectId,
    sessionId: typeof v.sessionId === 'string' ? v.sessionId : '',
    tool: v.tool,
    op: v.op,
    via: v.via === 'call' ? 'call' : 'mcp',
    ok: v.ok,
    code: typeof v.code === 'string' ? v.code : null,
    message: typeof v.message === 'string' ? v.message : null,
    durationMs: v.durationMs,
    mutating: v.mutating === true,
    artifactIds: v.artifactIds.filter((id): id is string => typeof id === 'string'),
    notes: Array.isArray(v.notes) ? v.notes.filter((n): n is string => typeof n === 'string') : [],
  };
}

/** Oldest first, one record per sequence number. */
export function mergeCalls(...lists: AgentCallRecord[][]): AgentCallRecord[] {
  const bySeq = new Map<number, AgentCallRecord>();
  for (const list of lists) for (const c of list) bySeq.set(c.seq, c);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function useAgentCalls(projectId: string | null) {
  const [state, setState] = useState<AgentCalls>({ status: 'loading' });

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    // Records that arrive live while the first read is in flight are kept and merged.
    let early: AgentCallRecord[] = [];
    let reading = true;
    let ready = false;
    setState({ status: 'loading' });
    void optionalCommand<AgentActivity>('agent.activity', { limit: CALL_PAGE }, { projectId }).then(
      (r) => {
        if (!active) return;
        reading = false;
        if (r.status === 'unavailable') setState({ status: 'unavailable' });
        else if (r.status === 'error') setState({ status: 'error', message: errMsg(r.error) });
        else {
          ready = true;
          setState({
            status: 'ready',
            calls: mergeCalls(r.value.calls, early),
            atStart: r.value.calls.length < CALL_PAGE,
            loadingOlder: false,
            olderError: null,
          });
        }
        early = [];
      },
    );
    const unsubscribe = window.omenflow.onAgentCall?.((value) => {
      const call = asAgentCall(value, projectId);
      if (!call || !active) return;
      if (reading) early.push(call);
      else if (ready)
        setState((s) => (s.status === 'ready' ? { ...s, calls: mergeCalls(s.calls, [call]) } : s));
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [projectId]);

  /** Reads the page before the oldest loaded call; after a failure only an explicit retry reads. */
  const loadOlder = useCallback(
    (retry = false) => {
      if (!projectId || state.status !== 'ready' || state.atStart || state.loadingOlder) return;
      if (state.olderError && !retry) return;
      const beforeSeq = state.calls[0]?.seq;
      if (beforeSeq === undefined) return;
      setState({ ...state, loadingOlder: true, olderError: null });
      void optionalCommand<AgentActivity>(
        'agent.activity',
        { limit: CALL_PAGE, beforeSeq },
        { projectId },
      ).then((r) =>
        setState((s) => {
          if (s.status !== 'ready') return s;
          if (r.status === 'ok')
            return {
              ...s,
              calls: mergeCalls(r.value.calls, s.calls),
              atStart: r.value.calls.length < CALL_PAGE,
              loadingOlder: false,
            };
          return {
            ...s,
            loadingOlder: false,
            olderError:
              r.status === 'error' ? errMsg(r.error) : 'The agent call record stopped answering.',
          };
        }),
      );
    },
    [projectId, state],
  );

  return { state, loadOlder };
}
