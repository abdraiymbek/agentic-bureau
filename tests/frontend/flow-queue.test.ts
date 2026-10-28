import { describe, expect, it } from 'vitest';
import type { Proposal, StaleRecord } from '@bureau/contracts';
import {
  hasRows,
  needsQueue,
  needsRows,
  quietLine,
} from '../../apps/desktop/src/renderer/project/flow/queue';
import {
  FLAG,
  flagsOf,
  groupFlags,
  groupName,
  nodeName,
  stateWords,
} from '../../apps/desktop/src/renderer/project/flow/describe';
import { parseMemory } from '../../apps/desktop/src/renderer/project/flow/memory';
import {
  causalAdjacency,
  linkKey,
  stalePathSteps,
  threadOf,
} from '../../apps/desktop/src/renderer/lib/graph';
import { buildGraph } from '../../apps/desktop/src/renderer/project/flow/model';
import { nodeId, roverGraph, view } from './flow-fixtures';

const proposal = (id: string, state: Proposal['state'], createdAt: string, artifact = 1) =>
  ({
    id,
    state,
    createdAt,
    reason: `Proposal ${id}`,
    createdBy: 'agent',
    changes: [{ artifactId: nodeId(artifact) }],
  }) as unknown as Proposal;

const record = (
  self: number,
  path: number[],
  reason: StaleRecord['reason'] = 'input_changed',
): StaleRecord => ({
  artifactId: nodeId(self),
  upstreamArtifactId: nodeId(path[0]!),
  expectedRevisionId: 'r1',
  actualRevisionId: reason === 'missing_input' ? null : 'r2',
  path: path.map(nodeId),
  reason,
  sinceEventSeq: 9,
});

const settled = [
  view(1, 'requirement', 'Payload capacity'),
  view(2, 'calculation', 'Rover mass budget'),
  view(3, 'calculation', 'Wheel torque'),
  view(4, 'mechanical', 'Camera tray'),
];

describe('needs-you queue', () => {
  it('separates what waits on the human from what is back with the agent', () => {
    const queue = needsQueue({
      artifacts: settled,
      stale: {},
      suggestions: [],
      proposals: [
        proposal('older', 'pending', '2026-10-10T09:00:00Z'),
        proposal('sent-back', 'changes_requested', '2026-10-11T09:00:00Z'),
        proposal('newer', 'pending', '2026-10-12T09:00:00Z'),
        proposal('done', 'accepted', '2026-10-13T09:00:00Z'),
        proposal('dropped', 'rejected', '2026-10-13T10:00:00Z'),
      ],
    });
    // Newest first, the order of the decision queue.
    expect(queue.review.map((p) => p.id)).toEqual(['newer', 'older']);
    expect(queue.returned.map((p) => p.id)).toEqual(['sent-back']);
    expect(queue.count).toBe(2);
    expect(hasRows(queue)).toBe(true);
  });

  it('lists out-of-date objects with the reason their path records', () => {
    const queue = needsQueue({
      artifacts: [
        ...settled,
        view(5, 'test', 'Ramp traverse'),
        view(6, 'note', 'Draft only', { baseline: false }),
      ],
      proposals: [],
      suggestions: [],
      stale: {
        [nodeId(3)]: [record(3, [1, 2, 3])],
        [nodeId(2)]: [record(2, [1, 2])],
        [nodeId(4)]: [record(4, [1, 4]), record(4, [2, 4])],
        [nodeId(5)]: [record(5, [6, 5], 'missing_input')],
        [nodeId(1)]: [],
      },
    });
    // The missing input first, then the objects closest to the change, then by title.
    expect(queue.outdated.map((o) => [o.title, o.reason, o.why])).toEqual([
      ['Ramp traverse', 'missing_input', 'Draft only has no approved baseline'],
      ['Camera tray', 'input_changed', 'Payload capacity changed · 1 more input'],
      ['Rover mass budget', 'input_changed', 'Payload capacity changed'],
      ['Wheel torque', 'input_changed', 'Payload capacity changed, through Rover mass budget'],
    ]);
    expect(queue.count).toBe(4);
    expect(queue.outdated[1]!.revision).toBe(1);
  });

  it('names a cause it cannot find without inventing one', () => {
    const queue = needsQueue({
      artifacts: settled,
      proposals: [],
      suggestions: [],
      stale: {
        [nodeId(2)]: [record(2, [77, 2], 'missing_input')],
        [nodeId(3)]: [record(3, [78, 3])],
        [nodeId(4)]: [record(4, [4], 'missing_input')],
      },
    });
    expect(Object.fromEntries(queue.outdated.map((o) => [o.title, o.why]))).toEqual({
      'Rover mass budget': 'An input is archived or missing',
      'Wheel torque': 'An input changed since it was recorded',
      'Camera tray': 'Its approved revision is missing',
    });
  });

  it('shows at most the given number of rows and counts the rest exactly', () => {
    const proposals = Array.from({ length: 6 }, (_, i) =>
      proposal(`p${i}`, 'pending', `2026-10-0${i + 1}T09:00:00Z`),
    );
    const queue = needsQueue({
      artifacts: settled,
      proposals,
      suggestions: [],
      stale: { [nodeId(2)]: [record(2, [1, 2])] },
    });
    expect(queue.count).toBe(7);
    const cut = needsRows(queue, 4);
    expect(cut.rows.map((r) => r.kind)).toEqual(['review', 'review', 'review', 'review']);
    expect(cut.hidden).toBe(3);
    const all = needsRows(queue, 99);
    expect(all.rows).toHaveLength(7);
    expect(all.rows[6]).toMatchObject({ kind: 'outdated' });
    expect(all.hidden).toBe(0);
  });

  it('drops repeated agent suggestions', () => {
    const queue = needsQueue({
      artifacts: settled,
      proposals: [],
      stale: {},
      suggestions: [
        { title: 'Weigh the chassis' },
        { title: 'Weigh the chassis' },
        { title: 'Weigh the chassis', detail: 'The mass budget uses an estimate.' },
      ],
    });
    expect(queue.suggestions).toHaveLength(2);
    expect(queue.count).toBe(0);
    expect(hasRows(queue)).toBe(true);
  });

  it('only says every baseline is current and reviewed when that is true', () => {
    const base = { proposals: [], stale: {}, suggestions: [] };
    const calm = needsQueue({ ...base, artifacts: settled });
    expect(hasRows(calm)).toBe(false);
    expect(quietLine(calm)).toEqual({
      settled: true,
      text: 'Every baseline is current and reviewed',
    });

    const drafted = needsQueue({
      ...base,
      artifacts: [
        ...settled,
        view(7, 'note', 'First draft', { baseline: false, draftCount: 1 }),
        view(8, 'note', 'Second draft', { baseline: false, draftCount: 2 }),
        view(9, 'test', 'Edited test', { draftCount: 1 }),
      ],
    });
    expect(hasRows(drafted)).toBe(false);
    expect(quietLine(drafted)).toEqual({
      settled: false,
      text: 'Nothing waits on you · 2 objects have no baseline · 3 drafts are not proposed',
    });

    const withAgent = needsQueue({
      ...base,
      artifacts: [...settled, view(9, 'test', 'Edited test', { draftCount: 1 })],
      proposals: [proposal('back', 'changes_requested', '2026-10-11T09:00:00Z', 9)],
    });
    // The draft is in the returned proposal, so it is not also counted as unproposed.
    expect(quietLine(withAgent)).toEqual({
      settled: false,
      text: 'Nothing waits on you · 1 proposal is back with the agent',
    });

    const waiting = needsQueue({
      ...base,
      artifacts: settled,
      proposals: [proposal('p', 'pending', '2026-10-11T09:00:00Z')],
    });
    expect(quietLine(waiting)).toEqual({ settled: false, text: '1 waiting on you' });
  });
});

describe('node state in words', () => {
  it('keeps review, freshness, open change and agent activity apart', () => {
    const current = flagsOf(view(1, 'requirement', 'Payload capacity'), false, false);
    expect(nodeName('Requirement', 'Payload capacity', current)).toBe(
      'Requirement: Payload capacity. approved baseline, current.',
    );
    const busy = flagsOf(
      view(2, 'calculation', 'Mass budget', {
        freshness: 'stale',
        staleReasons: [record(2, [1, 2])],
        pendingProposal: true,
      }),
      true,
      true,
    );
    expect(stateWords(busy).map((w) => [w.text, w.tone])).toEqual([
      ['Approved baseline', 'ok'],
      ['Out of date', 'warn'],
      ['Change in review', 'warn'],
      ['Changed by the agent in the last 15 minutes', 'signal'],
    ]);
    expect(busy & FLAG.impact).toBeTruthy();
    const draft = flagsOf(
      view(3, 'note', 'Idea', { baseline: false, draftCount: 1 }),
      false,
      false,
    );
    expect(nodeName('Note', 'Idea', draft)).toBe('Note: Idea. draft, no approved baseline.');
    const missing = flagsOf(
      view(4, 'test', 'Ramp', {
        freshness: 'missing_input',
        staleReasons: [record(4, [9, 4], 'missing_input')],
      }),
      false,
      false,
    );
    expect(stateWords(missing).map((w) => w.text)).toEqual(['Approved baseline', 'Missing input']);
    expect(missing & FLAG.stale).toBe(0);
  });

  it('summarises a collapsed group without hiding what is inside it', () => {
    const flags = [
      FLAG.stale,
      FLAG.stale | FLAG.review,
      FLAG.noBaseline | FLAG.draft,
      FLAG.touched,
      0,
    ];
    expect(groupName('Calculations', flags)).toBe(
      'Calculations: collapsed group of 5 objects. 2 out of date, 1 in review, 1 without a baseline, 1 changed by the agent.',
    );
    expect(groupName('Tests', [0])).toBe('Tests: collapsed group of 1 object.');
    // The group shows a mark for any state inside it, and "no baseline" only when all lack one.
    expect(groupFlags(flags)).toBe(FLAG.stale | FLAG.review | FLAG.touched);
    expect(groupFlags([FLAG.noBaseline, FLAG.noBaseline | FLAG.draft])).toBe(FLAG.noBaseline);
  });
});

describe('thread and stale paths', () => {
  it('walks the whole causal thread in both directions and nothing beside it', () => {
    const { artifacts, edges } = roverGraph();
    const graph = buildGraph(artifacts, edges);
    const adjacency = causalAdjacency(graph.links);
    const titles = (ids: Set<string>) =>
      [...ids].map((id) => artifacts.find((v) => v.artifact.id === id)!.artifact.title).sort();
    // The mass budget rests on the payload requirement and the battery (and its source), and
    // the torque calculation rests on it.
    expect(titles(threadOf(nodeId(19), adjacency))).toEqual([
      'LiPo 2S 450 mAh 30C pack',
      'LiPo 2S 450 mAh pack (supplier listing)',
      'Payload capacity',
      'Rover mass budget',
      'Wheel torque at 15° incline',
    ]);
    expect(titles(threadOf(nodeId(1), adjacency))).toEqual(['Endurance']);
    expect(threadOf('gone', adjacency)).toEqual(new Set(['gone']));
  });

  it('follows only links that carry consequence', () => {
    const adjacency = causalAdjacency([
      { from: 'a', to: 'b', causal: true },
      { from: 'b', to: 'c', causal: false },
    ]);
    expect(threadOf('a', adjacency)).toEqual(new Set(['a', 'b']));
  });

  it('marks only the links a change actually travelled along', () => {
    const steps = stalePathSteps({
      c: [{ path: ['a', 'b', 'c'] }],
      d: [{ path: ['a', 'd'] }],
      e: [{ path: ['b', 'e'] }],
    });
    expect(Object.fromEntries(steps)).toEqual({
      [linkKey('a', 'b')]: 0,
      [linkKey('b', 'c')]: 1,
      [linkKey('a', 'd')]: 0,
      [linkKey('b', 'e')]: 0,
    });
    // c and d are both out of date, but a link between them is not a stale path.
    expect(steps.has(linkKey('c', 'd'))).toBe(false);
    expect(steps.has(linkKey('d', 'c'))).toBe(false);
  });
});

describe('remembered map state', () => {
  it('keeps what is well formed and drops the rest', () => {
    expect(parseMemory(null)).toEqual({ viewport: null, groups: {} });
    expect(parseMemory('{not json')).toEqual({ viewport: null, groups: {} });
    expect(parseMemory('[1,2]')).toEqual({ viewport: null, groups: {} });
    expect(
      parseMemory(
        JSON.stringify({
          viewport: { x: 12, y: -40, k: 0.9, extra: true },
          groups: { component: true, source: false, note: 'yes' },
        }),
      ),
    ).toEqual({ viewport: { x: 12, y: -40, k: 0.9 }, groups: { component: true, source: false } });
    expect(parseMemory(JSON.stringify({ viewport: { x: 1, y: 2, k: 0 } })).viewport).toBeNull();
    expect(parseMemory(JSON.stringify({ viewport: { x: '1', y: 2, k: 1 } })).viewport).toBeNull();
  });
});
