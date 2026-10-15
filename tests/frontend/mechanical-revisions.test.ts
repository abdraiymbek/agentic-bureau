import { describe, expect, it } from 'vitest';
import type { Revision } from '@omenflow/contracts';
import {
  LATEST_WORK,
  displayedMechanicalRevision,
  mechanicalCandidates,
  mechanicalParameterUnit,
  newestActiveRevision,
  otherDraftCount,
  resolveDisplayedRevision,
  revisionRole,
} from '../../apps/desktop/src/renderer/lib/mechanical-revisions';

function revision(
  id: string,
  seq: number,
  reviewState: Revision['reviewState'],
  parentId: string | null = null,
): Revision {
  return {
    id,
    artifactId: 'part',
    seq,
    reviewState,
    parentId,
    payload: {},
    files: [],
    inputs: [],
    contentHash: 'fixture',
    origin: 'agent',
    originDetail: null,
    createdAt: '',
    rationale: '',
  };
}

describe('explicit mechanical revision selection', () => {
  const baseline = revision('baseline', 1, 'approved');
  const firstDraft = revision('draft', 2, 'draft');
  const proposed = revision('proposal', 3, 'proposed');
  const rejected = revision('rejected', 4, 'rejected');
  const history = [baseline, firstDraft, proposed, rejected];

  it('shows the latest proposed geometry before the first baseline exists', () => {
    expect(displayedMechanicalRevision(history.slice(1), null, null)?.id).toBe('proposal');
  });
  it('defaults to the latest candidate while retaining an explicit baseline selection', () => {
    expect(displayedMechanicalRevision(history, baseline.id, null)?.id).toBe('proposal');
    expect(displayedMechanicalRevision(history, baseline.id, baseline.id)?.id).toBe('baseline');
  });
  it('does not silently replace an explicit displayed revision with newer work', () => {
    expect(displayedMechanicalRevision(history, baseline.id, firstDraft.id)?.id).toBe('draft');
    expect(displayedMechanicalRevision(history, baseline.id, 'not-loaded-yet')).toBeNull();
  });
  it('does not offer rejected or selected revisions as candidates', () => {
    expect(mechanicalCandidates(history, baseline.id).map((r) => r.id)).toEqual([
      'proposal',
      'draft',
    ]);
  });
  it('falls back to the baseline when no eligible candidate exists', () => {
    expect(displayedMechanicalRevision([baseline, rejected], baseline.id, null)?.id).toBe(
      'baseline',
    );
  });
  it('does not let an older still-proposed revision override a newer accepted baseline', () => {
    const first = revision('rev-1', 1, 'superseded');
    const obsolete = revision('rev-2', 2, 'proposed', first.id);
    const accepted = revision('rev-3', 3, 'approved', first.id);
    const sequence = [first, obsolete, accepted];
    expect(displayedMechanicalRevision(sequence, accepted.id, null)?.id).toBe('rev-3');
    expect(mechanicalCandidates(sequence, accepted.id).map((r) => r.id)).toEqual([]);
    expect(displayedMechanicalRevision(sequence, accepted.id, obsolete.id)?.id).toBe('rev-2');
    const nextDraft = revision('rev-4', 4, 'draft', accepted.id);
    expect(displayedMechanicalRevision([...sequence, nextDraft], accepted.id, null)?.id).toBe(
      'rev-4',
    );
  });
});

describe('displayed-revision resolution for every stage', () => {
  const first = revision('r1', 1, 'superseded');
  const baseline = revision('r2', 2, 'approved', first.id);
  const orphan = revision('r3', 3, 'draft', first.id);
  const draft = revision('r4', 4, 'draft', baseline.id);
  const proposed = revision('r5', 5, 'proposed', draft.id);
  const rejected = revision('r6', 6, 'rejected', baseline.id);
  const history = [first, baseline, orphan, draft, proposed, rejected];

  it('latest work is the newest active draft descended from the baseline', () => {
    expect(resolveDisplayedRevision(history, baseline.id, LATEST_WORK)).toEqual({
      revision: proposed,
      role: 'candidate',
      pending: false,
    });
  });
  it('latest work falls back to the baseline when nothing is in progress', () => {
    expect(
      resolveDisplayedRevision([first, baseline, orphan, rejected], baseline.id, LATEST_WORK),
    ).toEqual({ revision: baseline, role: 'baseline', pending: false });
  });
  it('a baseline pick follows the pointer, not a remembered revision', () => {
    expect(resolveDisplayedRevision(history, baseline.id, { kind: 'baseline' }).revision).toBe(
      baseline,
    );
    const moved = history.map((r) =>
      r.id === draft.id ? { ...r, reviewState: 'approved' as const } : r,
    );
    expect(resolveDisplayedRevision(moved, draft.id, { kind: 'baseline' }).revision?.id).toBe('r4');
  });
  it('a named pick shows exactly that revision and says what it is', () => {
    expect(resolveDisplayedRevision(history, baseline.id, { kind: 'revision', id: 'r3' })).toEqual({
      revision: orphan,
      role: 'history',
      pending: false,
    });
    expect(
      resolveDisplayedRevision(history, baseline.id, { kind: 'revision', id: 'r6' }).role,
    ).toBe('history');
  });
  it('waits instead of guessing while the history is behind the record', () => {
    // The baseline pointer already names a revision the loaded list does not contain.
    expect(resolveDisplayedRevision(history, 'r7', LATEST_WORK)).toEqual({
      revision: null,
      role: null,
      pending: true,
    });
    expect(resolveDisplayedRevision(history, baseline.id, { kind: 'revision', id: 'r7' })).toEqual({
      revision: null,
      role: null,
      pending: true,
    });
  });
  it('shows a draft-only object and has nothing for an empty one', () => {
    const only = revision('d1', 1, 'draft');
    expect(resolveDisplayedRevision([only], null, LATEST_WORK)).toEqual({
      revision: only,
      role: 'candidate',
      pending: false,
    });
    expect(resolveDisplayedRevision([only], null, { kind: 'baseline' })).toEqual({
      revision: null,
      role: null,
      pending: false,
    });
    expect(resolveDisplayedRevision([], null, LATEST_WORK).revision).toBeNull();
  });
  it('names the role of any revision', () => {
    expect(history.map((r) => revisionRole(r, history, baseline.id))).toEqual([
      'history',
      'baseline',
      'history',
      'candidate',
      'candidate',
      'history',
    ]);
  });
  it('counts only current drafts other than the one on screen', () => {
    expect(otherDraftCount(history, baseline.id, proposed.id)).toBe(1);
    expect(otherDraftCount(history, baseline.id, draft.id)).toBe(0);
    expect(otherDraftCount(history, baseline.id, baseline.id)).toBe(1);
  });
  it('builds CAD candidates on the newest revision that was not rejected or superseded', () => {
    expect(newestActiveRevision(history)?.id).toBe('r5');
    expect(newestActiveRevision([first, rejected])).toBeNull();
  });
});

describe('parameter unit labels', () => {
  it('does not label a bare angle or count as millimetres', () => {
    expect(mechanicalParameterUnit('angle', 45, [])).toBe('unit unspecified');
    expect(mechanicalParameterUnit('$fn', 64, [{ name: '$fn', dimension: 'count' }])).toBe('count');
    expect(
      mechanicalParameterUnit('angle', 45, [{ name: 'angle', dimension: 'angle', unit: 'deg' }]),
    ).toBe('deg');
  });
  it('preserves explicit quantity units before manifest hints', () => {
    expect(
      mechanicalParameterUnit('width', { value: 1, unit: 'in' }, [{ name: 'width', unit: 'mm' }]),
    ).toBe('in');
  });
});
