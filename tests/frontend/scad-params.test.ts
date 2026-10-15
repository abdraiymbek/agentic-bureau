import { describe, expect, it } from 'vitest';
import {
  inModelUnits,
  parameterForm,
  parameterOverrides,
  parameterRows,
  scanScadParameters,
  unitFromComment,
} from '../../apps/desktop/src/renderer/lib/scad-params';

const SOURCE = `// Camera tray
tray_width = 62;   // mm
tray_depth = 44.5; // outer depth (mm)
$fn = 64;
rounded = true;
label = "A; b // not a comment";
slot = tray_width - 2 * 4; // derived
/* block
   hidden = 1;
*/
module tray(w = 10, d = 20) {
  inner = w - 2;
  cube([w, d, 2]);
}
translate([0, 0, 5])
  cylinder(
    h = 10,
    d = 5
  );
angle = 30; // tilt in deg
tray_width = 64;
`;

describe('parameter extraction from OpenSCAD source', () => {
  const found = scanScadParameters(SOURCE);
  const named = (name: string) => found.find((p) => p.name === name);

  it('lists file-scope assignments in source order', () => {
    expect(found.map((p) => p.name)).toEqual([
      'tray_width',
      'tray_depth',
      '$fn',
      'rounded',
      'label',
      'slot',
      'angle',
    ]);
  });
  it('never reports call arguments, module parameters, module locals or commented code', () => {
    for (const name of ['h', 'd', 'w', 'inner', 'hidden']) expect(named(name)).toBeUndefined();
  });
  it('reads literals by kind and keeps expressions as written', () => {
    expect(named('tray_depth')).toMatchObject({ kind: 'number', value: 44.5, line: 3 });
    expect(named('rounded')).toMatchObject({ kind: 'boolean', value: true });
    expect(named('label')).toMatchObject({ kind: 'string', value: 'A; b // not a comment' });
    expect(named('slot')).toMatchObject({
      kind: 'expression',
      value: null,
      expr: 'tray_width - 2 * 4',
      comment: 'derived',
    });
  });
  it('uses the last assignment of a name, as OpenSCAD does', () => {
    expect(named('tray_width')).toMatchObject({ value: 64, line: 21 });
  });
  it('handles several statements on one line and comparisons on the right-hand side', () => {
    const inline = scanScadParameters('w = 100; d = 40; // sizes\nsame = w == d;\nw == d;');
    expect(inline.map((p) => [p.name, p.kind])).toEqual([
      ['w', 'number'],
      ['d', 'number'],
      ['same', 'expression'],
    ]);
    expect(inline[0]!.comment).toBeUndefined();
    expect(inline[1]!.comment).toBe('sizes');
  });
  it('reads nothing from an empty or parameterless source', () => {
    expect(scanScadParameters('')).toEqual([]);
    expect(scanScadParameters('cube([1, 2, 3]);')).toEqual([]);
  });
});

describe('units are shown only where they are known', () => {
  it('accepts unambiguous unit notes and nothing looser', () => {
    expect(unitFromComment('mm')).toBe('mm');
    expect(unitFromComment('MM, outer')).toBe('mm');
    expect(unitFromComment('outer depth (mm)')).toBe('mm');
    expect(unitFromComment('tilt in deg')).toBe('deg');
    expect(unitFromComment('°')).toBe('deg');
    for (const loose of [
      'in the middle',
      'M3 clearance',
      'make it mm-ish maybe',
      '[10:50]',
      undefined,
    ])
      expect(unitFromComment(loose)).toBeNull();
  });

  const rows = parameterRows(
    SOURCE,
    { tray_depth: 50, rounded: true, wall: 3, tray_width: { value: 64, unit: 'mm' } },
    [
      { name: '$fn', dimension: 'count' },
      { name: 'angle', unit: 'deg', description: 'Tilt of the lens' },
    ],
  );
  const row = (name: string) => rows.find((r) => r.name === name)!;

  it('marks overrides, and only where the recorded value differs from the default', () => {
    expect(row('tray_depth')).toMatchObject({ value: 50, overridden: true, editable: true });
    expect(row('rounded').overridden).toBe(false);
    expect(row('tray_width').overridden).toBe(false);
    expect(row('angle')).toMatchObject({ value: 30, overridden: false });
  });
  it('takes a unit from the record, then the manifest, then the source comment', () => {
    expect(row('tray_width')).toMatchObject({ unit: 'mm', unitSource: 'recorded' });
    expect(row('angle')).toMatchObject({ unit: 'deg', unitSource: 'manifest' });
    expect(row('$fn')).toMatchObject({ unit: 'count', unitSource: 'manifest' });
    expect(row('tray_depth')).toMatchObject({ unit: 'mm', unitSource: 'source-comment' });
    expect(row('label')).toMatchObject({ unit: '', unitSource: null });
    expect(row('angle').description).toBe('Tilt of the lens');
  });
  it('lists expressions as read-only and stray overrides as not declared', () => {
    expect(row('slot')).toMatchObject({ editable: false, value: null });
    expect(row('wall')).toMatchObject({ declared: null, overridden: true, editable: false });
    expect(rows[rows.length - 1]!.name).toBe('wall');
  });
  it('falls back to the recorded overrides when the source cannot be read', () => {
    expect(parameterRows(null, { wall: 3 }, []).map((r) => [r.name, r.value, r.editable])).toEqual([
      ['wall', 3, false],
    ]);
  });

  it('sends recorded overrides plus edits, and refuses text that is not a value', () => {
    const form = parameterForm(rows);
    expect(form).toMatchObject({ tray_depth: '50', rounded: 'true', angle: '30' });
    expect(parameterOverrides(rows, form)).toEqual({ ok: true, params: { tray_depth: 50 } });
    expect(
      parameterOverrides(rows, { ...form, angle: '45', rounded: 'false', label: 'B' }),
    ).toEqual({
      ok: true,
      params: { tray_depth: 50, angle: 45, rounded: false, label: 'B' },
    });
    expect(parameterOverrides(rows, { ...form, angle: '4x5' })).toMatchObject({
      ok: false,
      name: 'angle',
    });
    expect(parameterOverrides(rows, { ...form, angle: '' })).toMatchObject({ ok: false });
  });

  it('keeps a recorded quantity’s unit by sending it in model units, edited or not', () => {
    const source = 'wall = 2; // mm\ntilt = 10;\ndepth = 40;\n';
    const recorded = {
      wall: { value: 0.1, unit: 'in' },
      tilt: { value: 0.5, unit: 'rad' },
      depth: 50,
    };
    const quantities = parameterRows(source, recorded, []);
    const wall = quantities.find((r) => r.name === 'wall')!;
    expect(wall).toMatchObject({
      value: 0.1,
      unit: 'in',
      unitSource: 'recorded',
      overridden: true,
    });
    const form = parameterForm(quantities);
    // Saving another parameter re-sends wall as 2.54 mm, not as 0.1 mm.
    expect(parameterOverrides(quantities, { ...form, depth: '45' })).toEqual({
      ok: true,
      params: { wall: 2.54, tilt: 28.6478897565, depth: 45 },
    });
    // A value typed in the field labelled (in) is inches.
    expect(parameterOverrides(quantities, { ...form, wall: '0.2' })).toMatchObject({
      ok: true,
      params: { wall: 5.08 },
    });
  });

  it('counts a quantity equal to the default only when it renders as the default', () => {
    const source = 'wall = 2;\nlip = 2;\n';
    const equal = parameterRows(source, { wall: { value: 2, unit: 'mm' } }, []);
    expect(equal[0]!.overridden).toBe(false);
    const scaled = parameterRows(source, { lip: { value: 2, unit: 'cm' } }, []);
    expect(scaled.find((r) => r.name === 'lip')!.overridden).toBe(true);
    expect(parameterOverrides(scaled, parameterForm(scaled))).toEqual({
      ok: true,
      params: { lip: 20 },
    });
  });

  it('refuses to send a recorded unit that has no model unit instead of dropping it', () => {
    const rows = parameterRows(
      'mass = 1;\nwall = 2;\n',
      { mass: { value: 0.3, unit: 'kg' }, wall: 3 },
      [],
    );
    expect(parameterOverrides(rows, { ...parameterForm(rows), wall: '4' })).toMatchObject({
      ok: false,
      name: 'mass',
    });
    expect(inModelUnits(1, 'furlong')).toBeNull();
    expect(inModelUnits(3, 'cm')).toBe(30);
  });
});
