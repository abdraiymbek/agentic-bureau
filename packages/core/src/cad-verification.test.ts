import { describe, expect, it } from 'vitest';
import { verificationScopeChanges } from './cad-verification.js';

describe('verification scope comparison', () => {
  it('permits more assertions and tighter tolerances while retaining all earlier assertions', () => {
    const prior = { bbox: { min: [0, 0, 0], max: [10, 10, 10], tol: 0.1 } };
    expect(
      verificationScopeChanges(prior, { bbox: { ...prior.bbox, tol: 0.01 }, shells: 1 }),
    ).toEqual([]);
    expect(verificationScopeChanges(prior, { ...prior, solid: [[5, 5, 5]] })).toEqual([]);
  });
  it('detects removals, changes and looser default/explicit tolerances', () => {
    const prior = { bbox: { min: [0, 0, 0], max: [10, 10, 10], tol: 0.01 } };
    expect(verificationScopeChanges(prior, {})).toContain('bbox');
    expect(
      verificationScopeChanges(prior, { bbox: { min: [0, 0, 0], max: [10, 10, 10] } }),
    ).toContain('bbox');
    expect(
      verificationScopeChanges(prior, { bbox: { ...prior.bbox, max: [20, 10, 10] } }),
    ).toContain('bbox');
    expect(verificationScopeChanges({}, { watertight: false })).toContain('watertight');
  });
  it('preserves coordinate order but accepts reordered independent probe lists', () => {
    expect(
      verificationScopeChanges(
        {
          solid: [
            [1, 2, 3],
            [4, 5, 6],
          ],
        },
        {
          solid: [
            [4, 5, 6],
            [1, 2, 3],
            [0, 0, 0],
          ],
        },
      ),
    ).toEqual([]);
    expect(verificationScopeChanges({ solid: [[1, 2, 3]] }, { solid: [[3, 2, 1]] })).toContain(
      'solid',
    );
  });
});
