import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as contracts from '@bureau/contracts';
import { compatible, convert, toBase, unitDef } from '../../apps/desktop/src/renderer/ui/units';

// Every unit name the shipped core knows (the contract units plus its SI additions). The
// renderer's table must agree with the contracts on each one the contracts define.
const coreUnits = Object.keys(
  JSON.parse(
    fs.readFileSync(new URL('../../crates/core/units.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>,
);
const contractUnits = coreUnits.filter((u) => contracts.unitDef(u));

describe('the renderer unit table', () => {
  it('knows every contract unit and alias, with the same canonical name and dimension', () => {
    expect(contractUnits.length).toBeGreaterThan(80);
    for (const unit of contractUnits) {
      const mine = unitDef(unit);
      const theirs = contracts.unitDef(unit)!;
      expect(mine, unit).toBeDefined();
      expect([mine!.name, mine!.dim, mine!.scale, mine!.offset ?? 0], unit).toEqual([
        theirs.name,
        theirs.dim,
        theirs.scale,
        theirs.offset ?? 0,
      ]);
    }
  });

  it('knows no unit the contracts do not', () => {
    for (const unit of coreUnits.filter((u) => !contracts.unitDef(u)))
      expect(unitDef(unit), unit).toBeUndefined();
  });

  it('converts and compares exactly as the contracts do', () => {
    const q = { value: 12.5, unit: 'g', min: 12, max: 13 };
    expect(convert(q, 'kg')).toEqual(contracts.convert(q, 'kg'));
    expect(convert({ value: 20, unit: 'degC' }, 'K')).toEqual(
      contracts.convert({ value: 20, unit: 'degC' }, 'K'),
    );
    expect(toBase({ value: 3, unit: 'mAh' })).toBe(contracts.toBase({ value: 3, unit: 'mAh' }));
    expect(compatible({ value: 1, unit: 'N·m' }, { value: 1, unit: 'kg*cm' })).toBe(true);
    expect(compatible({ value: 1, unit: 'V' }, { value: 1, unit: 'A' })).toBe(false);
  });

  it('converts a bound recorded on one side only instead of dropping it', () => {
    const mass = convert({ value: 300, unit: 'g', max: 350 }, 'kg')!;
    expect(mass.value).toBeCloseTo(0.3, 12);
    expect(mass.max).toBeCloseTo(0.35, 12);
    expect(mass.min).toBeUndefined();
    const wall = convert({ value: 2, unit: 'cm', min: 1.5 }, 'mm')!;
    expect(wall.min).toBeCloseTo(15, 12);
    expect(wall.max).toBeUndefined();
  });

  it('never guesses a unit it does not know', () => {
    expect(toBase({ value: 1, unit: 'furlong' })).toBeNull();
    expect(convert({ value: 1, unit: 'furlong' }, 'm')).toBeNull();
    expect(convert({ value: 1, unit: 'kg' }, 'm')).toBeNull();
    expect(compatible({ value: 1, unit: 'furlong' }, { value: 1, unit: 'furlong' })).toBe(false);
  });
});
