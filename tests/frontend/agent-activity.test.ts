import { describe, expect, it } from 'vitest';
import type { AgentCallRecord } from '@omenflow/contracts';
import {
  activitySignal,
  asCallRecord,
  durationLabel,
  groupCalls,
  mergeCalls,
  sessionCounts,
  timeRange,
  toolWords,
} from '../../apps/desktop/src/renderer/shell/agent/activity';
import { isUnserved } from '../../apps/desktop/src/renderer/shell/agent/quiet';

const t0 = Date.parse('2026-10-13T14:00:00.000Z');
function call(seq: number, minutes: number, patch: Partial<AgentCallRecord> = {}): AgentCallRecord {
  return {
    seq,
    at: new Date(t0 + minutes * 60_000).toISOString(),
    projectId: 'p1',
    sessionId: 's1',
    tool: 'artifact_read',
    op: 'artifact.read',
    via: 'mcp',
    ok: true,
    code: null,
    message: null,
    durationMs: 12,
    mutating: false,
    artifactIds: [],
    notes: [],
    ...patch,
  };
}

describe('agent call records', () => {
  it('names tools in words', () => {
    expect(toolWords('cad_check')).toBe('CAD check');
    expect(toolWords('artifact_create_draft')).toBe('Artifact create draft');
    expect(toolWords('mcp__omenflow__bom_read')).toBe('BOM read');
    expect(toolWords('project.summary')).toBe('Project summary');
    expect(toolWords('')).toBe('');
  });

  it('formats durations', () => {
    expect(durationLabel(84)).toBe('84 ms');
    expect(durationLabel(1420)).toBe('1.4 s');
    expect(durationLabel(42_000)).toBe('42 s');
    expect(durationLabel(123_000)).toBe('2 min 3 s');
    expect(durationLabel(120_000)).toBe('2 min');
    expect(durationLabel(Number.NaN)).toBe('');
  });

  it('accepts host records and rejects anything that is not one', () => {
    expect(
      asCallRecord({ seq: 1, at: 'x', sessionId: 's', tool: 'cad_check', ok: false }),
    ).toMatchObject({
      op: 'cad_check',
      code: null,
      artifactIds: [],
      notes: [],
    });
    expect(asCallRecord({ seq: '1', at: 'x', sessionId: 's', tool: 't', ok: true })).toBeNull();
    expect(asCallRecord(null)).toBeNull();
    expect(
      asCallRecord({ seq: 1, at: 'x', sessionId: 's', tool: 't', ok: true, durationMs: 'fast' })!
        .durationMs,
    ).toBeNaN();
  });

  it('merges live and historical records by sequence, without duplicates, keeping the newest', () => {
    const a = [call(1, 0), call(2, 1)];
    expect(mergeCalls(a, [])).toBe(a);
    const merged = mergeCalls(a, [call(4, 3), call(2, 1), call(3, 2)]);
    expect(merged.map((c) => c.seq)).toEqual([1, 2, 3, 4]);
    expect(mergeCalls(merged, [call(5, 4)], 3).map((c) => c.seq)).toEqual([3, 4, 5]);
  });

  it('groups by time gaps and by session, newest first', () => {
    const calls = [
      call(1, 0),
      call(2, 1, { ok: false, code: 'VALIDATION' }),
      call(3, 20),
      call(4, 21, { sessionId: 's2' }),
    ];
    const groups = groupCalls(calls);
    expect(groups.map((g) => g.calls.map((c) => c.seq))).toEqual([[4], [3], [2, 1]]);
    expect(groups[2]!.failures).toBe(1);
    expect(groups[2]!.earliest).toBe(calls[0]!.at);
    expect(groups[2]!.latest).toBe(calls[1]!.at);
  });

  it('shows one time for a group whose calls fall within the shown second', () => {
    const seconds = (iso: string) => iso.slice(11, 19);
    expect(timeRange('2026-10-13T14:00:01.120Z', '2026-10-13T14:00:01.870Z', seconds)).toBe(
      '14:00:01',
    );
    expect(timeRange('2026-10-13T14:00:01.120Z', '2026-10-13T14:02:30.000Z', seconds)).toBe(
      '14:00:01 – 14:02:30',
    );
  });

  it('counts a session from its ledger summary plus later live records', () => {
    const calls = [
      call(1, 0),
      call(2, 1),
      call(3, 2, { ok: false }),
      call(4, 3, { sessionId: 's2' }),
    ];
    const sessions = [
      {
        sessionId: 's1',
        adapterId: 'codex',
        model: null,
        profile: 'compact' as const,
        startedAt: '',
        endedAt: null,
        calls: 40,
        errors: 2,
      },
    ];
    expect(sessionCounts('s1', calls, sessions, 2)).toEqual({ calls: 41, errors: 3 });
    expect(sessionCounts('s2', calls, sessions, 2)).toEqual({ calls: 1, errors: 0 });
    expect(sessionCounts('s3', calls, sessions, 2)).toBeNull();
  });

  it('marks the agent working while calls arrive and flags a failed last call', () => {
    const calls = [call(1, 0), call(2, 1, { ok: false, code: 'NOT_FOUND' })];
    expect(activitySignal(calls, 's1', 1000, 3000)).toMatchObject({ arriving: true });
    expect(activitySignal(calls, 's1', 1000, 9000).arriving).toBe(false);
    expect(activitySignal(calls, 's1', null, 0).lastFailed?.seq).toBe(2);
    expect(activitySignal([...calls, call(3, 2)], 's1', null, 0).lastFailed).toBeNull();
    expect(activitySignal(calls, 'other', null, 0).lastFailed).toBeNull();
  });
});

describe('unserved operations', () => {
  it('tells "this host does not serve it" apart from a failure', () => {
    expect(
      isUnserved({
        code: 'VALIDATION',
        message: 'agent.activity is implemented by the Rust host',
        details: { op: 'agent.activity', implementedBy: 'rust-host' },
      }),
    ).toBe(true);
    expect(isUnserved({ code: 'VALIDATION', message: 'Unknown operation: agent.activity' })).toBe(
      true,
    );
    expect(isUnserved({ code: 'INTERNAL', message: 'ledger unreadable' })).toBe(false);
  });
});
