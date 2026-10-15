import { z } from 'zod';
import { ErrorCodes, OmenflowError } from './errors.js';

/**
 * Physical quantities with explicit units. Values normalize to SI-ish base
 * units per dimension. Unknown values are `null` plus a reason — never zero.
 */
export type Dim =
  | 'length'
  | 'mass'
  | 'time'
  | 'current'
  | 'voltage'
  | 'power'
  | 'energy'
  | 'charge'
  | 'force'
  | 'torque'
  | 'angle'
  | 'angular_speed'
  | 'speed'
  | 'acceleration'
  | 'temperature'
  | 'data'
  | 'dimensionless';

interface UnitDef {
  dim: Dim;
  /** Multiply a value in this unit by `scale` then add `offset` to get base. */
  scale: number;
  offset?: number;
  aliases?: string[];
}

/** Base units: m, kg, s, A, V, W, J, C, N, N·m, rad, rad/s, m/s, K, byte, 1. */
const UNITS: Record<string, UnitDef> = {
  m: { dim: 'length', scale: 1 },
  mm: { dim: 'length', scale: 0.001 },
  cm: { dim: 'length', scale: 0.01 },
  km: { dim: 'length', scale: 1000 },
  in: { dim: 'length', scale: 0.0254, aliases: ['inch', '"'] },
  ft: { dim: 'length', scale: 0.3048 },

  kg: { dim: 'mass', scale: 1 },
  g: { dim: 'mass', scale: 0.001 },
  mg: { dim: 'mass', scale: 1e-6 },
  lb: { dim: 'mass', scale: 0.45359237, aliases: ['lbs'] },
  oz: { dim: 'mass', scale: 0.028349523125 },

  s: { dim: 'time', scale: 1, aliases: ['sec'] },
  ms: { dim: 'time', scale: 0.001 },
  min: { dim: 'time', scale: 60 },
  h: { dim: 'time', scale: 3600, aliases: ['hr', 'hour'] },
  day: { dim: 'time', scale: 86400 },

  A: { dim: 'current', scale: 1 },
  mA: { dim: 'current', scale: 0.001 },
  uA: { dim: 'current', scale: 1e-6, aliases: ['µA'] },

  V: { dim: 'voltage', scale: 1 },
  mV: { dim: 'voltage', scale: 0.001 },
  kV: { dim: 'voltage', scale: 1000 },

  W: { dim: 'power', scale: 1 },
  mW: { dim: 'power', scale: 0.001 },
  kW: { dim: 'power', scale: 1000 },

  J: { dim: 'energy', scale: 1 },
  Wh: { dim: 'energy', scale: 3600 },
  mWh: { dim: 'energy', scale: 3.6 },
  kWh: { dim: 'energy', scale: 3.6e6 },

  C: { dim: 'charge', scale: 1 },
  Ah: { dim: 'charge', scale: 3600 },
  mAh: { dim: 'charge', scale: 3.6 },

  N: { dim: 'force', scale: 1 },
  lbf: { dim: 'force', scale: 4.4482216152605 },
  kgf: { dim: 'force', scale: 9.80665 },

  'N*m': { dim: 'torque', scale: 1, aliases: ['Nm', 'N·m'] },
  'N*mm': { dim: 'torque', scale: 0.001, aliases: ['Nmm', 'N·mm'] },
  'N*cm': { dim: 'torque', scale: 0.01, aliases: ['Ncm', 'N·cm'] },
  'kg*cm': { dim: 'torque', scale: 0.0980665, aliases: ['kgcm', 'kg·cm', 'kgf·cm'] },
  'oz*in': { dim: 'torque', scale: 0.0070615518, aliases: ['ozin', 'oz·in'] },

  rad: { dim: 'angle', scale: 1 },
  deg: { dim: 'angle', scale: Math.PI / 180, aliases: ['°'] },

  'rad/s': { dim: 'angular_speed', scale: 1 },
  rpm: { dim: 'angular_speed', scale: Math.PI / 30 },

  'm/s': { dim: 'speed', scale: 1 },
  'km/h': { dim: 'speed', scale: 1 / 3.6 },
  mph: { dim: 'speed', scale: 0.44704 },

  'm/s^2': { dim: 'acceleration', scale: 1 },
  'cm/s^2': { dim: 'acceleration', scale: 0.01 },
  'ft/s^2': { dim: 'acceleration', scale: 0.3048 },

  K: { dim: 'temperature', scale: 1 },
  degC: { dim: 'temperature', scale: 1, offset: 273.15, aliases: ['°C', 'Celsius'] },

  B: { dim: 'data', scale: 1, aliases: ['byte'] },
  kB: { dim: 'data', scale: 1e3 },
  MB: { dim: 'data', scale: 1e6 },
  GB: { dim: 'data', scale: 1e9 },
  KiB: { dim: 'data', scale: 1024 },
  MiB: { dim: 'data', scale: 1048576 },

  '1': { dim: 'dimensionless', scale: 1, aliases: ['', 'unitless'] },
  '%': { dim: 'dimensionless', scale: 0.01, aliases: ['percent'] },
};

const CANONICAL: Record<string, UnitDef & { name: string }> = {};
for (const [name, def] of Object.entries(UNITS)) {
  CANONICAL[name] = { ...def, name };
  for (const alias of def.aliases ?? []) CANONICAL[alias] = { ...def, name };
}

export const quantitySchema = z.object({
  value: z.number().finite(),
  unit: z.string().min(1),
  /** Optional uncertainty band, same unit. */
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
});
export type Quantity = z.infer<typeof quantitySchema>;

/** A value that may be unknown — carries a reason instead of a fake zero. */
export const maybeQuantitySchema = z.union([
  quantitySchema,
  z.object({ unknown: z.literal(true), reason: z.string() }),
]);
export type MaybeQuantity = z.infer<typeof maybeQuantitySchema>;

/** Defined in the dependency-free `format` entry point; re-exported for existing callers. */
export { formatQty, isUnknown } from './format.js';

export function unitDef(unit: string): (UnitDef & { name: string }) | undefined {
  return CANONICAL[unit];
}

export function dimOf(q: Quantity): Dim {
  const def = CANONICAL[q.unit];
  if (!def) throw new OmenflowError(ErrorCodes.INVALID_UNITS, `Unknown unit '${q.unit}'`);
  return def.dim;
}

/** Value in base units for its dimension. */
export function toBase(q: Quantity): number {
  const def = CANONICAL[q.unit];
  if (!def) throw new OmenflowError(ErrorCodes.INVALID_UNITS, `Unknown unit '${q.unit}'`);
  return q.value * def.scale + (def.offset ?? 0);
}

export function convert(q: Quantity, toUnit: string): Quantity {
  const from = CANONICAL[q.unit];
  const to = CANONICAL[toUnit];
  if (!from || !to) {
    throw new OmenflowError(ErrorCodes.INVALID_UNITS, `Unknown unit '${!from ? q.unit : toUnit}'`);
  }
  if (from.dim !== to.dim) {
    throw new OmenflowError(
      ErrorCodes.INVALID_UNITS,
      `Cannot convert ${q.unit} (${from.dim}) to ${toUnit} (${to.dim})`,
    );
  }
  const base = q.value * from.scale + (from.offset ?? 0);
  const value = (base - (to.offset ?? 0)) / to.scale;
  const out: Quantity = { value, unit: to.name };
  if (q.min !== undefined && q.max !== undefined) {
    out.min = (q.min * from.scale + (from.offset ?? 0) - (to.offset ?? 0)) / to.scale;
    out.max = (q.max * from.scale + (from.offset ?? 0) - (to.offset ?? 0)) / to.scale;
  }
  return out;
}

export function compatible(a: Quantity, b: Quantity): boolean {
  const da = CANONICAL[a.unit];
  const db = CANONICAL[b.unit];
  return !!da && !!db && da.dim === db.dim;
}

export function assertCompatible(a: Quantity, b: Quantity): void {
  if (!compatible(a, b)) {
    throw new OmenflowError(ErrorCodes.INVALID_UNITS, `Incompatible units: ${a.unit} vs ${b.unit}`);
  }
}

/** Add two compatible quantities, preserving the first's unit. */
export function addQty(a: Quantity, b: Quantity): Quantity {
  const bb = convert(b, a.unit);
  const out: Quantity = { value: a.value + bb.value, unit: a.unit };
  if (a.min !== undefined && a.max !== undefined && bb.min !== undefined && bb.max !== undefined) {
    out.min = a.min + bb.min;
    out.max = a.max + bb.max;
  }
  return out;
}

export function scaleQty(q: Quantity, factor: number): Quantity {
  const out: Quantity = { value: q.value * factor, unit: q.unit };
  if (q.min !== undefined && q.max !== undefined) {
    out.min = q.min * factor;
    out.max = q.max * factor;
  }
  return out;
}

export function qty(value: number, unit: string): Quantity {
  if (!CANONICAL[unit]) {
    throw new OmenflowError(ErrorCodes.INVALID_UNITS, `Unknown unit '${unit}'`);
  }
  return { value, unit };
}

/** Money: decimal string + ISO 4217 currency. Never mixed without conversion record. */
export const moneySchema = z.object({
  amount: z.string().regex(/^-?\d+(\.\d{1,4})?$/, 'decimal amount'),
  currency: z.string().length(3),
});
export type Money = z.infer<typeof moneySchema>;

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new OmenflowError(
      ErrorCodes.MIXED_CURRENCY,
      `Cannot add ${a.currency} to ${b.currency} without a dated conversion record`,
    );
  }
  return { amount: (Number(a.amount) + Number(b.amount)).toFixed(2), currency: a.currency };
}

export function scaleMoney(m: Money, factor: number): Money {
  return { amount: (Number(m.amount) * factor).toFixed(2), currency: m.currency };
}
