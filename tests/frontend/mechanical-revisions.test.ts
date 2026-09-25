import { describe, expect, it } from 'vitest';
import type { Revision } from '@omenflow/contracts';
import {
  displayedMechanicalRevision,
  mechanicalCandidates,
  mechanicalParameterUnit,
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
