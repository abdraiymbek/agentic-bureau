import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentActivity, AgentCallRecord } from '@bureau/contracts';

const command = vi.hoisted(() => vi.fn());
vi.mock('../../apps/desktop/src/renderer/store', () => ({ useStore: { getState: () => ({}) } }));
vi.mock('../../apps/desktop/src/renderer/shell/agent/quiet', () => ({
  quiet: command,
  errorText: (error: { message: string }) => error.message,
  isUnserved: () => false,
}));

import { CALL_LIMIT, sessionCounts } from '../../apps/desktop/src/renderer/shell/agent/activity';
import { useAgentUi } from '../../apps/desktop/src/renderer/shell/agent/agent-store';
import { loadActivity } from '../../apps/desktop/src/renderer/shell/agent/feed';
import { latestCounts } from '../../apps/desktop/src/renderer/shell/agent/session-view';

function call(seq: number): AgentCallRecord {
  return {
    seq,
    at: new Date(seq * 1000).toISOString(),
    projectId: 'project',
    sessionId: 'session',
    tool: 'project_summary',
    op: 'project.summary',
    via: 'mcp',
    ok: seq % 10 !== 0,
    code: null,
    message: null,
    durationMs: 1,
    mutating: false,
    artifactIds: [],
    notes: [],
  };
}

function response(calls: AgentCallRecord[], total = 6000) {
  return {
    ok: true as const,
    result: {
      calls,
      sessions: [
        {
          sessionId: 'session',
          adapterId: 'custom',
          model: null,
          profile: 'standard' as const,
          startedAt: '',
          endedAt: null,
          calls: total,
          errors: Math.floor(total / 10),
        },
      ],
    } satisfies AgentActivity,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('bounded agent activity history', () => {
  beforeEach(() => {
    command.mockReset();
    useAgentUi.getState().enterProject('project');
  });
  afterEach(() => useAgentUi.getState().enterProject(null));

  it('pages beyond 1000 calls, retains live status separately, and returns to the latest window', async () => {
    const ledger = Array.from({ length: 6000 }, (_, i) => call(i + 1));
    command.mockImplementation(async (_op, input: { beforeSeq?: number; limit: number }) => {
      const eligible = ledger.filter((c) => c.seq < (input.beforeSeq ?? Infinity));
      return response(eligible.slice(-input.limit));
    });
    await loadActivity('project');
    for (let page = 0; page < 8; page++) await loadActivity('project', true);
    let activity = useAgentUi.getState().activity;
    expect(activity.history).toHaveLength(CALL_LIMIT);
    expect(activity.history![0]!.seq).toBe(4201);
    expect(activity.history!.at(-1)!.seq).toBe(5200);
    expect(command.mock.calls.slice(1).map(([, input]) => input.beforeSeq)).toEqual([
      5801, 5601, 5401, 5201, 5001, 4801, 4601, 4401,
    ]);

    const history = activity.history;
    useAgentUi.getState().addCalls([call(6001), call(6002), call(6002)], 'live');
    activity = useAgentUi.getState().activity;
    expect(activity.history).toBe(history);
    expect(activity.calls.at(-1)!.seq).toBe(6002);
    expect(
      sessionCounts('session', activity.calls, activity.sessions, activity.summarySeq),
    ).toEqual({
      calls: 6002,
      errors: 600,
    });
    useAgentUi.getState().showLatestCalls();
    activity = useAgentUi.getState().activity;
    expect(activity.history).toBeNull();
    expect(activity.calls.at(-1)!.seq).toBe(6002);
    expect(activity.hasMore).toBe(true);
    await loadActivity('project', true);
    expect(command.mock.calls.at(-1)![1].beforeSeq).toBe(5801);
    expect(useAgentUi.getState().activity.history![0]!.seq).toBe(5601);
  });

  it('keeps both windows bounded while live calls continue and the historical cursor advances to the beginning', async () => {
    const ledger = Array.from({ length: 1600 }, (_, i) => call(i + 1));
    command.mockImplementation(async (_op, input: { beforeSeq?: number; limit: number }) =>
      response(
        ledger.filter((c) => c.seq < (input.beforeSeq ?? Infinity)).slice(-input.limit),
        1600,
      ),
    );
    await loadActivity('project');
    await loadActivity('project', true);
    const history = useAgentUi.getState().activity.history;
    useAgentUi.getState().addCalls(
      Array.from({ length: 2000 }, (_, i) => call(1601 + i)),
      'live',
    );
    expect(useAgentUi.getState().activity.calls).toHaveLength(CALL_LIMIT);
    expect(useAgentUi.getState().activity.history).toBe(history);
    for (let page = 0; page < 7; page++) await loadActivity('project', true);
    const activity = useAgentUi.getState().activity;
    expect(activity.history).toHaveLength(CALL_LIMIT);
    expect(activity.history![0]!.seq).toBe(1);
    expect(activity.hasMore).toBe(false);
    useAgentUi.getState().showLatestCalls();
    expect(useAgentUi.getState().activity.hasMore).toBe(true);
    expect(useAgentUi.getState().activity.calls.at(-1)!.seq).toBe(3600);
    // The same authoritative host counters used by the session bar keep
    // totals intact after the bounded live tail has discarded old rows.
    expect(
      latestCounts(
        { calls: 3600, errors: 360 },
        sessionCounts('session', activity.calls, activity.sessions, activity.summarySeq),
      ),
    ).toEqual({ calls: 3600, errors: 360 });
  });

  it('coalesces repeated load clicks and ignores an older page after returning to latest', async () => {
    const first = Array.from({ length: 200 }, (_, i) => call(1001 + i));
    command.mockResolvedValueOnce(response(first));
    await loadActivity('project');
    command.mockResolvedValueOnce(response(Array.from({ length: 200 }, (_, i) => call(801 + i))));
    await loadActivity('project', true);
    const waiting = deferred<ReturnType<typeof response>>();
    command.mockReturnValueOnce(waiting.promise);
    const request = loadActivity('project', true);
    expect(loadActivity('project', true)).toBe(request);
    expect(command).toHaveBeenCalledTimes(3);
    expect(useAgentUi.getState().activity.loadingOlder).toBe(true);
    useAgentUi.getState().showLatestCalls();
    waiting.resolve(response(Array.from({ length: 200 }, (_, i) => call(601 + i))));
    await request;
    expect(useAgentUi.getState().activity.history).toBeNull();
    expect(useAgentUi.getState().activity.loadingOlder).toBe(false);
  });

  it('does not apply a page from an earlier visit to the same project', async () => {
    const waiting = deferred<ReturnType<typeof response>>();
    command.mockReturnValueOnce(waiting.promise);
    const request = loadActivity('project');
    useAgentUi.getState().enterProject('other');
    useAgentUi.getState().enterProject('project');
    waiting.resolve(response([call(1)]));
    await request;
    expect(useAgentUi.getState().activity.calls).toEqual([]);
  });
});
