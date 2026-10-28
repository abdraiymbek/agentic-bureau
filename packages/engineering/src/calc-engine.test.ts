import { describe, expect, it } from 'vitest';
import { ErrorCodes, qty } from '@bureau/contracts';
import { MathJsCalcEngine } from './calc-engine.js';

const engine = () => new MathJsCalcEngine();

describe('MathJsCalcEngine.evaluate', () => {
  it('adds across units and converts to outputUnit', async () => {
    const kg = await engine().evaluate(
      'a + b',
      [
        { name: 'a', quantity: qty(300, 'g') },
        { name: 'b', quantity: qty(0.2, 'kg') },
      ],
      'kg',
    );
    expect(kg).toEqual({ value: 0.5, unit: 'kg' });

    const g = await engine().evaluate(
      'a + b',
      [
        { name: 'a', quantity: qty(300, 'g') },
        { name: 'b', quantity: qty(0.2, 'kg') },
      ],
      'g',
    );
    expect(g).toEqual({ value: 500, unit: 'g' });
  });

  it('rejects incompatible units with INVALID_UNITS', async () => {
    await expect(
      engine().evaluate(
        'a + b',
        [
          { name: 'a', quantity: qty(1, 'kg') },
          { name: 'b', quantity: qty(1, 'm') },
        ],
        'kg',
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_UNITS });
  });

  it('rejects incompatible outputUnit with INVALID_UNITS', async () => {
    await expect(
      engine().evaluate('a', [{ name: 'a', quantity: qty(1, 'kg') }], 'm'),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_UNITS });
  });

  it('rejects assignment expressions', async () => {
    await expect(engine().evaluate('a = 2', [], '1')).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION,
    });
    await expect(engine().evaluate('f(x) = x^2', [], '1')).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION,
    });
  });

  it('rejects statements, strings, accessors and dangerous tokens', async () => {
    for (const expr of [
      'a=1; a+1',
      'import("x")',
      'eval("1")',
      'a => a',
      '"str"',
      'm[1]',
      'obj{}}'.slice(0, 4),
      'constructor',
    ]) {
      await expect(engine().evaluate(expr, [], '1'), expr).rejects.toMatchObject({
        code: ErrorCodes.VALIDATION,
      });
    }
  });

  it('rejects oversize expressions', async () => {
    await expect(engine().evaluate(`1${'+1'.repeat(1500)}`, [], '1')).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION,
    });
  });

  it('rejects unknown and bad-unit inputs', async () => {
    await expect(
      engine().evaluate(
        'a',
        [{ name: 'a', quantity: { unknown: true, reason: 'no datasheet' } }],
        '1',
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_UNITS });
    await expect(
      engine().evaluate(
        'a',
        [{ name: 'a', quantity: { value: 1, unit: 'furlong' } as never }],
        '1',
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_UNITS });
  });

  it('times out pathological evaluations', async () => {
    const fast = new MathJsCalcEngine({ timeoutMs: 1 });
    await expect(fast.evaluate('1 + 1', [], '1')).rejects.toMatchObject({
      code: ErrorCodes.TIMEOUT,
    });
  });

  it('battery_energy math: V × mAh × fraction → Wh', async () => {
    const r = await engine().evaluate(
      'voltage * capacity * usable_fraction',
      [
        { name: 'voltage', quantity: qty(12, 'V') },
        { name: 'capacity', quantity: qty(2200, 'mAh') },
        { name: 'usable_fraction', quantity: qty(0.8, '1') },
      ],
      'Wh',
    );
    expect(r.unit).toBe('Wh');
    expect(r.value).toBeCloseTo(21.12, 2);
  });
});

describe('MathJsCalcEngine.templates', () => {
  it('ships the four required templates', () => {
    const ids = engine()
      .templates()
      .map((t) => t.id);
    expect(ids).toEqual(['mass_budget', 'power_budget', 'battery_energy', 'torque_load']);
    for (const t of engine().templates()) {
      expect(t.assumptions.length).toBeGreaterThan(0);
      expect(t.limitations.length).toBeGreaterThan(0);
    }
  });

  it('every template evaluates end-to-end', async () => {
    const e = engine();
    const cases: Record<string, { inputs: [string, number, string][]; want: [number, string] }> = {
      mass_budget: {
        inputs: [
          ['payload', 300, 'g'],
          ['chassis', 1, 'kg'],
          ['electronics', 200, 'g'],
          ['battery', 500, 'g'],
        ],
        want: [2, 'kg'],
      },
      power_budget: {
        inputs: [
          ['avg_load', 10, 'W'],
          ['peak_load', 30, 'W'],
          ['margin', 1.25, '1'],
        ],
        want: [30, 'W'],
      },
      battery_energy: {
        inputs: [
          ['voltage', 12, 'V'],
          ['capacity', 2.2, 'Ah'],
          ['usable_fraction', 0.8, '1'],
        ],
        want: [21.12, 'Wh'],
      },
      torque_load: {
        inputs: [
          ['mass', 2, 'kg'],
          ['g', 9.80665, 'm/s^2'],
          ['incline', 10, 'deg'],
          ['wheel_radius', 50, 'mm'],
          ['accel', 1.96133, 'm/s^2'],
        ],
        want: [0.36644, 'N*m'],
      },
    };
    for (const t of e.templates()) {
      const c = cases[t.id]!;
      const r = await e.evaluate(
        t.expression,
        c.inputs.map(([name, value, unit]) => ({ name, quantity: qty(value, unit) })),
        t.outputUnit,
      );
      expect(r.unit).toBe(c.want[1]);
      expect(r.value).toBeCloseTo(c.want[0], 3);
    }
  });
});
