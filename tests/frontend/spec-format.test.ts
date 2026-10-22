import { describe, expect, it } from 'vitest';
import { describeAssertions } from '../../apps/desktop/src/renderer/lib/spec-format';
import { UNIT_JOIN } from '../../apps/desktop/src/renderer/ui/format';

/** Expected lines written with plain spaces; a value is joined to mm as the quantity formatter joins it. */
const joined = (lines: string[]) =>
  lines.map((line) => line.replace(/ (mm[²³]?)(?!\w)/g, `${UNIT_JOIN}$1`));

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
    ).toEqual(
      joined([
        'size 60 × 60 × 16 mm',
        '1 body',
        'hole Ø8 mm at (0, 0, 2) mm',
        'hole Ø3.2 mm at (10, 0, 5) mm along x',
        'envelope (-30, -30, 0) to (30, 30, 16.0001) mm',
        'volume 34500 mm³',
        'material at (29.5, 0, 3.5), (29.5, 0, 12.5) mm',
        'empty space at (29.5, 0, 8) mm',
        'section z = 8 mm: outer Ø50 mm',
        'section y = 0 mm: outer 60 × 16 mm, hole Ø8 mm at (0, 8) mm',
        'section x = 1 mm: 2 cut-outs, material area 120 mm²',
        'section z = 4 mm: nothing asserted',
      ]),
    );
  });

  it('shows every recorded tolerance, centre and position, with its unit', () => {
    expect(
      describeAssertions({
        volume: { value: 34500, tolPct: 10 },
        bbox: { min: [0, 0, 0], max: [60, 60, 16], tol: 2 },
        holes: [{ at: [0, 0, 2], d: 8, axis: 'z' }],
        sections: [
          {
            axis: 'z',
            at: 8,
            outer: { d: 50, tol: 1.5, center: [5, 5] },
            holes: [{ center: [0, 0], d: 8, tol: 0.5 }],
            slots: [{ center: [12, 0], size: [10, 4], tol: 0.2 }],
            polygons: [{ center: [-12, 0], sides: 6, acrossFlats: 5.5, tol: 0.05 }],
            materialArea: { value: 1192, tolPct: 2.5 },
          },
          { axis: 'x', at: 0, outer: { size: [60, 16], center: [0, 8] }, outerCount: 1 },
        ],
      }),
    ).toEqual(
      joined([
        'volume 34500 mm³ ± 10%',
        'envelope (0, 0, 0) to (60, 60, 16) mm ± 2 mm',
        'hole Ø8 mm at (0, 0, 2) mm along z',
        'section z = 8 mm: outer Ø50 mm at (5, 5) mm ± 1.5 mm, hole Ø8 mm at (0, 0) mm ± 0.5 mm, ' +
          'cut-out 10 × 4 mm at (12, 0) mm ± 0.2 mm, ' +
          '6-gon 5.5 mm across flats at (-12, 0) mm ± 0.05 mm, material area 1192 mm² ± 2.5%',
        'section x = 0 mm: outer 60 × 16 mm at (0, 8) mm, 1 material region',
      ]),
    );
  });

  it('keeps tolerances exactly as recorded, and reads an outline the way the check does', () => {
    expect(
      describeAssertions({
        bbox: { min: [0, 0, 0], max: [1, 1, 1], tol: 0.0125 },
        sections: [{ axis: 'y', at: 0.5, outer: { size: [1, 1], d: 3, tol: 0.001 } }],
      }),
    ).toEqual(
      joined([
        'envelope (0, 0, 0) to (1, 1, 1) mm ± 0.0125 mm',
        'section y = 0.5 mm: outer 1 × 1 mm ± 0.001 mm, d 3',
      ]),
    );
  });

  it('shows a field it has no words for, at any depth, as it is', () => {
    expect(
      describeAssertions({
        bbox: { min: [0, 0, 0], max: [1, 1, 1], margin: 1 },
        volume: { value: 1, spread: 'wide' },
        holes: [{ at: [0, 0, 0], d: 1, depth: 3 }],
        sections: [
          {
            axis: 'z',
            at: 0,
            outer: { d: 4, roundness: 0.9 },
            holes: [{ center: [0, 0], d: 1, kind: 'blind' }],
            materialArea: { value: 2, basis: 'net' },
            holeCount: 'two',
          },
        ],
        size: 'large',
        solid: [[1, 2, 3]],
        empty: 'centre',
      }),
    ).toEqual(
      joined([
        'envelope (0, 0, 0) to (1, 1, 1) mm, margin 1',
        'volume 1 mm³, spread "wide"',
        'hole Ø1 mm at (0, 0, 0) mm, depth 3',
        'section z = 0 mm: outer Ø4 mm, roundness 0.9, hole Ø1 mm at (0, 0) mm, kind "blind", ' +
          'holeCount "two", material area 2 mm², basis "net"',
        'size "large"',
        'material at (1, 2, 3) mm',
        'empty "centre"',
      ]),
    );
  });

  it('shows a key it does not know as it is, and nothing for no assertions', () => {
    expect(describeAssertions({ shells: 2, preserve: { changeRegions: [] } })).toEqual([
      '2 bodies',
      'preserve {"changeRegions":[]}',
    ]);
    expect(
      describeAssertions({
        holes: [4],
        bbox: { min: 'origin', max: [1, 1, 1] },
        sections: [{ axis: 'z', at: 1, holes: [null], slots: 'none' }],
      }),
    ).toEqual(
      joined([
        'hole 4',
        'envelope "origin" to (1, 1, 1) mm',
        'section z = 1 mm: hole null, slots "none"',
      ]),
    );
    expect(describeAssertions(undefined)).toEqual([]);
    expect(describeAssertions({})).toEqual([]);
  });
});
