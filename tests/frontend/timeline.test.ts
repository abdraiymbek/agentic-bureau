import { describe, expect, it } from 'vitest';
import type { AgentCallRecord, ProjectEvent, Proposal } from '@omenflow/contracts';
import {
  dayLabel,
  eventArtifactIds,
  eventFields,
  eventLabel,
  filterEvents,
  groupByDay,
  interleaveCalls,
  timelineRows,
} from '../../apps/desktop/src/renderer/project/timeline';
import { asAgentCall, mergeCalls } from '../../apps/desktop/src/renderer/project/agent-calls';

const T0 = Date.parse('2026-10-13T10:00:00Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function event(
  seq: number,
  type: string,
  data: Record<string, unknown> = {},
  origin: ProjectEvent['origin'] = 'user',
  seconds = seq,
): ProjectEvent {
  return { seq, id: `e${seq}`, type, origin, ts: at(seconds), data };
}

function call(seq: number, seconds: number, over: Partial<AgentCallRecord> = {}): AgentCallRecord {
  return {
    seq,
    at: at(seconds),
    projectId: 'p1',
    sessionId: 's1',
    tool: 'cad_check',
    op: 'cad.check',
    via: 'mcp',
    ok: true,
    code: null,
    message: null,
    durationMs: 120,
    mutating: true,
    artifactIds: ['a1'],
    notes: [],
    ...over,
  };
}

describe('timeline rows', () => {
  it('labels drafts and revisions from the recorded review state and drops noise', () => {
    expect(eventLabel(event(1, 'revision.committed', { reviewState: 'draft' }))).toBe('Drafted');
    expect(eventLabel(event(1, 'revision.committed', { reviewState: 'approved' }))).toBe('Revised');
    expect(eventLabel(event(1, 'job.updated'))).toBeNull();
    expect(eventLabel(event(1, 'impact.propagated', { affected: [] }))).toBeNull();
    expect(eventLabel(event(1, 'impact.propagated', { affected: ['a2'] }))).toBe('Impact reached');
  });

  it('counts only what an impact reached beyond the objects that changed', () => {
    // A part accepted on its own still has an older input: it is listed, but nothing was reached.
    const own = event(1, 'impact.propagated', {
      changed: [{ artifactId: 'tray', revisionId: 'r3' }],
      affected: [{ artifactId: 'tray', reason: 'input changed', path: ['req', 'tray'] }],
    });
    expect(eventLabel(own)).toBeNull();
    const onward = event(2, 'impact.propagated', {
      changed: [{ artifactId: 'req', revisionId: 'r5' }],
      affected: [
        { artifactId: 'tray', reason: 'input changed', path: ['req', 'tray'] },
        { artifactId: 'mass', reason: 'input changed', path: ['req', 'mass'] },
      ],
    });
    expect(eventLabel(onward)).toBe('Impact reached');
    expect(eventFields(onward).affected).toBe(2);
  });

  it('merges a draft and the baseline move it caused, and bursts of bill changes', () => {
    const rows = timelineRows([
      event(1, 'revision.committed', { artifactId: 'a1', reviewState: 'draft' }, 'user', 0),
      event(2, 'baseline.changed', { artifactId: 'a1' }, 'user', 1),
      event(3, 'bom.changed', {}, 'system', 100),
      event(4, 'bom.changed', {}, 'system', 110),
      event(5, 'bom.changed', {}, 'system', 300),
      event(6, 'revision.committed', { artifactId: 'a2', reviewState: 'draft' }, 'agent', 400),
    ]);
    expect(rows.map((r) => [r.labels.join(' · '), r.count])).toEqual([
      ['Drafted', 1],
      ['Bill of materials changed', 1],
      ['Bill of materials changed', 2],
      ['Revised · Baseline updated', 1],
    ]);
  });

  it('keeps two revisions of one object as two rows', () => {
    const rows = timelineRows([
      event(1, 'revision.committed', { artifactId: 'a1', reviewState: 'draft' }, 'user', 0),
      event(2, 'baseline.changed', { artifactId: 'a1' }, 'user', 1),
      event(3, 'revision.committed', { artifactId: 'a1', reviewState: 'draft' }, 'user', 2),
    ]);
    expect(rows.map((r) => r.labels.join(' · '))).toEqual([
      'Drafted',
      'Revised · Baseline updated',
    ]);
  });

  it('does not merge the same object across actors or long gaps', () => {
    const rows = timelineRows([
      event(1, 'revision.committed', { artifactId: 'a1', reviewState: 'draft' }, 'agent', 0),
      event(2, 'baseline.changed', { artifactId: 'a1' }, 'user', 1),
      event(3, 'revision.committed', { artifactId: 'a1' }, 'user', 60),
    ]);
    expect(rows).toHaveLength(3);
  });

  it('filters by actor and by the objects an event is about, including proposal changes', () => {
    const proposals = [{ id: 'p1', changes: [{ artifactId: 'a3' }] } as unknown as Proposal];
    const events = [
      event(1, 'revision.committed', { artifactId: 'a1' }, 'agent'),
      event(2, 'proposal.submitted', { proposalId: 'p1' }, 'agent'),
      event(
        3,
        'impact.propagated',
        { changed: [{ artifactId: 'a3' }], affected: ['a4'] },
        'system',
      ),
      event(4, 'job.updated', { artifactId: 'a1' }, 'system'),
    ];
    expect(eventArtifactIds(events[2]!, proposals)).toEqual(['a3', 'a4']);
    // Proposal events record counts under similar names; they never read as ids.
    expect(
      eventArtifactIds(event(9, 'proposal.submitted', { changes: 1, affected: 0 }), []),
    ).toEqual([]);
    expect(
      filterEvents(events, { actor: 'agent', objectId: null }, proposals).map((e) => e.seq),
    ).toEqual([1, 2]);
    expect(
      filterEvents(events, { actor: 'all', objectId: 'a3' }, proposals).map((e) => e.seq),
    ).toEqual([2, 3]);
    expect(filterEvents(events, { actor: 'system', objectId: 'a1' }, proposals)).toEqual([]);
  });

  it('drops the bill of materials announcement after an approval that touched no part', () => {
    const proposals = [
      { id: 'req', changes: [{ artifactId: 'a1', kind: 'baseline_update' }] },
      { id: 'part', changes: [{ artifactId: 'c1', kind: 'baseline_update' }] },
      { id: 'old', changes: [{ artifactId: 'a1', kind: 'baseline_update' }] },
    ] as unknown as Proposal[];
    const approval = (seq: number, id: string) => [
      event(seq, 'proposal.resolved', { proposalId: id, state: 'accepted' }),
      event(seq + 1, 'impact.propagated', { changed: [{ artifactId: 'x' }], affected: [] }),
      event(seq + 2, 'bom.changed', {}, 'system'),
    ];
    const events = [
      ...approval(1, 'req'),
      ...approval(4, 'part'),
      // An approval that also retired an older proposal.
      event(7, 'proposal.resolved', { proposalId: 'req', state: 'accepted' }),
      event(8, 'proposal.resolved', { proposalId: 'old', state: 'superseded' }),
      event(9, 'bom.changed', {}, 'system'),
      // A line edit records what changed and always stays.
      event(10, 'bom.changed', { lineId: 'l1' }),
      // The approval before this one is outside the loaded window.
      event(20, 'bom.changed', {}, 'system'),
    ];
    const bom = (componentIds?: Set<string>) =>
      filterEvents(events, { actor: 'all', objectId: null }, proposals, componentIds)
        .filter((e) => e.type === 'bom.changed')
        .map((e) => e.seq);
    expect(bom(new Set(['c1']))).toEqual([6, 10, 20]);
    // Without the project's components nothing can be judged, so nothing is dropped.
    expect(bom()).toEqual([3, 6, 9, 10, 20]);
  });

  it('places recorded agent calls between record rows and runs consecutive calls together', () => {
    const rows = timelineRows([
      event(1, 'revision.committed', { artifactId: 'a1' }, 'user', 10),
      event(2, 'proposal.submitted', { proposalId: 'p' }, 'agent', 50),
    ]);
    const items = interleaveCalls(rows, [call(1, 5), call(2, 20), call(3, 30), call(4, 60)], null);
    expect(
      items.map((i) => (i.kind === 'event' ? i.event.type : i.calls.map((c) => c.seq).join(','))),
    ).toEqual(['4', 'proposal.submitted', '3,2', 'revision.committed', '1']);
    // Calls older than the loaded record wait until the record reaches back that far.
    const windowed = interleaveCalls(rows, [call(1, 5), call(2, 20)], at(10));
    expect(
      windowed
        .filter((i) => i.kind === 'calls')
        .flatMap((i) => (i.kind === 'calls' ? i.calls : [])),
    ).toHaveLength(1);
  });

  it('groups by local day and names the year only when it is not this year', () => {
    const now = new Date('2026-10-13T12:00:00Z');
    expect(dayLabel('2026-10-13T12:00:00Z', now)).not.toMatch(/2026/);
    expect(dayLabel('2025-10-13T12:00:00Z', now)).toMatch(/2025/);
    const days = groupByDay(
      timelineRows([
        { ...event(1, 'project.created'), ts: '2026-10-11T12:00:00Z' },
        { ...event(2, 'project.intent_changed'), ts: '2026-10-13T12:00:00Z' },
      ]),
      now,
    );
    expect(days.map((d) => d.items.length)).toEqual([1, 1]);
  });
});

describe('agent call records', () => {
  it('accepts only well-formed records for this project from the live channel', () => {
    expect(asAgentCall(call(1, 0), 'p1')).toEqual(call(1, 0));
    expect(asAgentCall(call(1, 0), 'other')).toBeNull();
    expect(asAgentCall({ ...call(1, 0), seq: '1' }, 'p1')).toBeNull();
    expect(asAgentCall('cad_check', 'p1')).toBeNull();
  });

  it('merges pages and live records by sequence number', () => {
    expect(
      mergeCalls([call(3, 3), call(1, 1)], [call(2, 2), call(3, 3)]).map((c) => c.seq),
    ).toEqual([1, 2, 3]);
  });
});
