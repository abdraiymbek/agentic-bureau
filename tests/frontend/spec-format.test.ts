import { describe, expect, it } from 'vitest';
import { describeAssertions } from '../../apps/desktop/src/renderer/lib/spec-format';

describe('cad_check assertions in words', () => {
  it('names each group with its unit and the recorded values exactly', () => {
    expect(
      describeAssertions({
        size: [60, 60, 16],
        bodies: 1,
        holes: [
          { at: [0, 0, 2], d: 8 },
          { at: [10, 0, 5], d: 3.2, axis: 'x' },
        ],
        bbox: { min: [-30, -30, 0], max: [30, 30, 16.0001] },
        volume: { value: 34500 },
        solid: [
          [29.5, 0, 3.5],
          [29.5, 0, 12.5],
        ],
        empty: [[29.5, 0, 8]],
        sections: [
          { axis: 'z', at: 8, outer: { d: 50 } },
          { axis: 'y', at: 0, outer: { size: [60, 16] }, holes: [{ center: [0, 8], d: 8 }] },
          { axis: 'x', at: 1, holeCount: 2, materialArea: { value: 120 } },
          { axis: 'z', at: 4 },
        ],
      }),
    ).toEqual([
      'size 60 × 60 × 16 mm',
      '1 body',
      'hole Ø8 mm at (0, 0, 2) mm',
      'hole Ø3.2 mm at (10, 0, 5) mm along x',
      'envelope (-30, -30, 0) to (30, 30, 16.0001) mm',
      'volume 34500 mm³',
      'material at (29.5, 0, 3.5), (29.5, 0, 12.5) mm',
      'empty space at (29.5, 0, 8) mm',
      'section z = 8 mm: outer Ø50 mm',
      'section y = 0 mm: outer 60 × 16 mm, hole Ø8 mm at (0, 8)',
      'section x = 1 mm: 2 cut-outs, material area 120 mm²',
      'section z = 4 mm: nothing asserted',
    ]);
  });

  it('shows a key it does not know as it is, and nothing for no assertions', () => {
    expect(describeAssertions({ shells: 2, preserve: { changeRegions: [] } })).toEqual([
      '2 bodies',
      'preserve {"changeRegions":[]}',
    ]);
    expect(describeAssertions(undefined)).toEqual([]);
    expect(describeAssertions({})).toEqual([]);
  });
});
