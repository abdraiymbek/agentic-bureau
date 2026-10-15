import { describe, expect, it } from 'vitest';
import type { Revision } from '@omenflow/contracts';
import {
  affectedIds,
  approvalEffects,
  detailPhase,
  fingerprint,
  isCarrier,
  listPhase,
  listVersion,
  needsYou,
  nextAfterDecision,
  phaseLabel,
  queueList,
  waitingOnAgent,
  whatChanged,
} from '../../apps/desktop/src/renderer/decide/model';
import { artifact, carrierDetail, detail, ids, proposal } from './decide-fixtures';

const selected = (id: string | null) => () => id;

describe('who owns the next move', () => {
  it('maps the core states to phases in words', () => {
    expect(phaseLabel(detailPhase(detail()))).toBe('Needs you');
    const waiting = detailPhase(
      detail({ proposal: { state: 'changes_requested', resolutionRationale: 'Use 480 g.' } }),
    );
    expect(waiting).toEqual({ kind: 'waiting_on_agent', request: 'Use 480 g.', artifactIds: [] });
    expect(phaseLabel(waiting)).toBe('Waiting on the agent');
    const approved = detailPhase(
      detail({
        proposal: {
          state: 'accepted',
          resolvedAt: '2026-10-13T11:00:00Z',
          resolutionRationale: 'OK',
        },
      }),
    );
    expect(approved).toEqual({
      kind: 'decided',
      outcome: 'approved',
      rationale: 'OK',
      at: '2026-10-13T11:00:00Z',
    });
    expect(
      detailPhase(detail({ proposal: { state: 'rejected', resolutionRationale: '  ' } })),
    ).toMatchObject({ kind: 'decided', outcome: 'rejected', rationale: null });
    expect(detailPhase(detail({ proposal: { state: 'cancelled' } })).kind).toBe('cancelled');
    expect(detailPhase(detail({ proposal: { state: 'conflicted' } })).kind).toBe('conflicted');
  });

  it('reads supersession from the V1 field or from the older impact record', () => {
    expect(
      detailPhase(detail({ proposal: { state: 'superseded', supersededBy: ids.p2 } })),
    ).toEqual({
      kind: 'superseded',
      by: ids.p2,
    });
    expect(
      detailPhase(
        detail({
          proposal: {
            state: 'superseded',
            impact: { affectedArtifactIds: [], summary: '', supersededByProposalId: ids.p3 },
          },
        }),
      ),
    ).toEqual({ kind: 'superseded', by: ids.p3 });
    expect(detailPhase(detail({ proposal: { state: 'superseded' } }))).toEqual({
      kind: 'superseded',
      by: null,
    });
  });

  it('uses the core’s baseMoved when present, and never second-guesses it', () => {
    expect(detailPhase(detail({ change: { baseMoved: true } }))).toEqual({
      kind: 'base_moved',
      artifactIds: [ids.req],
    });
    // The core may allow a candidate that descends from a newer baseline: its false wins.
    expect(
      detailPhase(detail({ change: { baseMoved: false, artifact: artifact(ids.r3) } })).kind,
    ).toBe('needs_you');
  });

  it('derives a moved base from the recorded ids when an older core sends no flag', () => {
    expect(detailPhase(detail({ change: { artifact: artifact(ids.r3) } }))).toEqual({
      kind: 'base_moved',
      artifactIds: [ids.req],
    });
    const waiting = detailPhase(
      detail({ proposal: { state: 'changes_requested' }, change: { artifact: artifact(ids.r3) } }),
    );
    expect(waiting).toMatchObject({ kind: 'waiting_on_agent', artifactIds: [ids.req] });
  });

  it('flags a moved base in the queue from the project list, and only when it knows', () => {
    const p = proposal();
    expect(listPhase(p, selected(ids.r1)).kind).toBe('needs_you');
    expect(listPhase(p, selected(ids.r3)).kind).toBe('base_moved');
    expect(listPhase(p, () => undefined).kind).toBe('needs_you');
    const flagged = proposal({
      changes: [{ ...proposal().changes[0]!, baseMoved: true }],
    });
    expect(listPhase(flagged, selected(ids.r1)).kind).toBe('base_moved');
  });
});

describe('queue', () => {
  const all = [
    proposal({ id: ids.p1, createdAt: '2026-10-13T10:00:00Z' }),
    proposal({ id: ids.p2, createdAt: '2026-10-13T12:00:00Z', state: 'changes_requested' }),
    proposal({ id: ids.p3, createdAt: '2026-10-13T11:00:00Z', supersededBy: ids.p1 }),
  ];

  it('lists only what needs the person under “Needs you”', () => {
    expect(needsYou(all).map((p) => p.id)).toEqual([ids.p1]);
    expect(waitingOnAgent(all).map((p) => p.id)).toEqual([ids.p2]);
    expect(queueList(all, 'all').map((p) => p.id)).toEqual([ids.p2, ids.p3, ids.p1]);
  });

  it('advances to the proposal below the decided one, else above, else anything open', () => {
    const shown = ['a', 'b', 'c', 'd'];
    expect(nextAfterDecision(shown, 'b', ['a', 'c', 'd'])).toBe('c');
    expect(nextAfterDecision(shown, 'd', ['a', 'b', 'c'])).toBe('c');
    expect(nextAfterDecision(shown, 'b', ['a'])).toBe('a');
    expect(nextAfterDecision(shown, 'b', ['new'])).toBe('new');
    expect(nextAfterDecision(shown, 'b', [])).toBeNull();
    expect(nextAfterDecision(shown, 'b', ['b'])).toBeNull();
  });
});

describe('changes underneath', () => {
  it('keeps the same fingerprint and list version for an identical refresh', () => {
    const a = detail();
    const b = JSON.parse(JSON.stringify(a));
    expect(fingerprint(b)).toBe(fingerprint(a));
    const p = proposal();
    expect(listVersion(JSON.parse(JSON.stringify(p)), selected(ids.r1))).toBe(
      listVersion(p, selected(ids.r1)),
    );
    expect(listVersion(p, selected(ids.r3))).not.toBe(listVersion(p, selected(ids.r1)));
  });

  it('says what changed, in words', () => {
    const before = detail();
    expect(whatChanged(before, detail({ change: { artifact: artifact(ids.r3) } }))).toEqual([
      'It is now “Base moved” (it was “Needs you”).',
      'Payload capacity: its baseline moved while this was open.',
    ]);
    expect(
      whatChanged(before, detail({ proposal: { state: 'superseded', supersededBy: ids.p2 } })),
    ).toEqual(['A newer proposal replaced it.']);
    const evidence = detail({
      change: { verification: { status: 'passed', evidenceHash: 'f'.repeat(64) } },
    });
    expect(whatChanged(before, evidence)).toEqual([
      'Payload capacity: the verification evidence changed.',
    ]);
  });
});

describe('what approval does', () => {
  const title = (id: string) => (id === ids.dep ? 'Camera tray' : 'Old motor');

  it('lists the baseline move, dependents and the record', () => {
    expect(approvalEffects(detail(), title, {})).toEqual([
      'Payload capacity: the baseline moves from r1 to r2.',
      '1 downstream object may be marked out of date.',
      'The decision and your rationale are kept in the record.',
    ]);
  });

  it('names archiving, bill of materials lines and accepted scopes', () => {
    const d = detail({
      proposal: {
        changes: [
          {
            artifactId: ids.req,
            newRevisionId: ids.r2,
            kind: 'component_selection',
            replacesArtifactId: ids.p3,
            bomLines: [
              {
                componentArtifactId: ids.req,
                componentRevisionId: ids.r2,
                subsystem: null,
                quantity: 2,
                offerId: null,
                location: null,
                notes: '',
              },
            ],
            removeBomLineIds: [ids.p1, ids.p2],
          },
        ],
        impact: { affectedArtifactIds: [], summary: '' },
      },
      change: { base: null },
    });
    d.changes[0]!.change = d.proposal.changes[0]!;
    expect(approvalEffects(d, title, { [ids.req]: 'e'.repeat(64) })).toEqual([
      'Payload capacity is selected for the build; r2 becomes its baseline.',
      'Old motor is archived and leaves the bill of materials.',
      'Adds 1 bill of materials line.',
      'Removes 2 bill of materials lines.',
      'Payload capacity: you accept the declared verification scope.',
      'The decision and your rationale are kept in the record.',
    ]);
  });

  it('keeps the baseline and marks nothing out of date for a carried bill of materials edit', () => {
    const d = carrierDetail();
    expect(isCarrier(d.changes[0]!)).toBe(true);
    expect(affectedIds(d)).toEqual([]);
    expect(approvalEffects(d, title, {})).toEqual([
      'Motor: the baseline stays r1; only its bill of materials changes.',
      'Adds 1 bill of materials line.',
      'The decision and your rationale are kept in the record.',
    ]);
  });

  it('treats a bill of materials edit that really revises the component as a baseline move', () => {
    for (const changed of [
      carrierDetail({ contentHash: 'f'.repeat(64) }),
      carrierDetail({ parentId: null }),
      carrierDetail({
        inputs: [{ artifactId: ids.dep, revisionId: ids.r3, relationship: 'depends_on' }],
      } as Partial<Revision>),
    ]) {
      expect(isCarrier(changed.changes[0]!)).toBe(false);
      expect(affectedIds(changed)).toEqual([ids.dep]);
      expect(approvalEffects(changed, title, {})[0]).toBe(
        'Motor: the baseline moves from r1 to r2.',
      );
    }
  });

  it('promises nothing the core will refuse once a baseline moved', () => {
    expect(approvalEffects(detail(), title, {}, [ids.req])).toEqual([
      'Payload capacity: its baseline is newer than r1, the revision this change was prepared on.',
      'Nothing changes until the agent rebuilds the change.',
    ]);
  });
});
