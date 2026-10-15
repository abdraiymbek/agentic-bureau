import { describe, expect, it } from 'vitest';
import type { ArtifactView, CalculationPayload } from '@omenflow/contracts';
import {
  inputSource,
  rerunOutcome,
} from '../../apps/desktop/src/renderer/object/stages/calculation';

type Input = CalculationPayload['inputs'][number];

const NOTE =
  'Formula, inputs and result (0.505 kg) are the same as the recorded revision. No new revision or proposal was created.';

describe('re-running a calculation', () => {
  it('says nothing new was recorded when the core reports the same result, and opens nothing', () => {
    const outcome = rerunOutcome({ unchanged: true, proposal: null, note: NOTE });
    expect(outcome).toEqual({ kind: 'unchanged', message: NOTE, proposalId: null });
    expect(outcome.message).not.toMatch(/waiting for your review/);
  });

  it('points at the proposal already waiting when the same result is pending', () => {
    const outcome = rerunOutcome({ unchanged: true, proposal: { id: 'p7' }, note: NOTE });
    expect(outcome).toMatchObject({ kind: 'unchanged', proposalId: 'p7' });
    expect(outcome.message).toContain('already waits for your review');
  });

  it('claims a result waiting for review only when a proposal was submitted', () => {
    expect(
      rerunOutcome({ unchanged: false, proposal: { id: 'p8' }, revision: { seq: 3 } }),
    ).toEqual({
      kind: 'proposed',
      message: 'Recorded inputs recalculated as r3. The new result is waiting for your review.',
      proposalId: 'p8',
    });
    expect(rerunOutcome({ unchanged: false, proposal: null, revision: { seq: 3 } })).toEqual({
      kind: 'drafted',
      message: 'Recorded inputs recalculated as r3, a draft. It was not submitted for review.',
    });
  });
});

describe('where a calculation input is pinned', () => {
  const source = {
    artifact: { id: 'mass', type: 'component', title: 'Motor', selectedRevisionId: 'rev-5' },
    revision: { id: 'rev-5', seq: 5 },
  } as unknown as ArtifactView;
  const input = (revisionId: string): Input =>
    ({
      name: 'm',
      quantity: { value: 0.2, unit: 'kg' },
      sourceRef: { artifactId: 'mass', revisionId },
      literal: false,
    }) as Input;

  it('names the pinned revision by number once the source history is read', () => {
    const pin = inputSource(input('db39429d-0000'), [source], () => 2);
    expect(pin).toEqual({
      pin: 'Pinned to r2; the baseline is now r5',
      moved: true,
      available: true,
    });
  });

  it('invents no number while the history loads, and falls back to the id when it cannot', () => {
    expect(inputSource(input('db39429d-0000'), [source], () => 'loading')!.pin).toBe(
      'Pinned to another revision; the baseline is now r5',
    );
    expect(inputSource(input('db39429d-0000'), [source], () => null)!.pin).toBe(
      'Pinned to revision db39429d; the baseline is now r5',
    );
  });

  it('says the pin is the baseline without reading any history', () => {
    let asked = false;
    const pin = inputSource(input('rev-5'), [source], () => {
      asked = true;
      return null;
    });
    expect(pin!.pin).toBe('Pinned to r5, the current baseline');
    expect(asked).toBe(false);
  });
});
