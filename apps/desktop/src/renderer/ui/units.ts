/**
 * Unit arithmetic for display: the contract unit table (`packages/contracts/src/units.ts`) as
 * plain data, so a lens can compare and convert recorded quantities without loading zod and the
 * operation registry into the renderer. A unit the table does not know is never guessed: the
 * functions answer "not compatible" or null. `tests/frontend/ui-units.test.ts` keeps this table
 * identical to the contracts' one, unit by unit and alias by alias.
 */
import type { Quantity } from '@omenflow/contracts';

interface UnitDef {
  dim: string;
  /** Multiply a value in this unit by `scale`, then add `offset`, to get the base unit. */
  scale: number;
  offset?: number;
  aliases?: string[];
}

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

export type DisplayUnit = UnitDef & { name: string };

const CANONICAL = new Map<string, DisplayUnit>();
for (const [name, def] of Object.entries(UNITS)) {
  CANONICAL.set(name, { ...def, name });
  for (const alias of def.aliases ?? []) CANONICAL.set(alias, { ...def, name });
}

/** The unit's definition, by name or alias; undefined for a unit the contracts do not know. */
export function unitDef(unit: string): DisplayUnit | undefined {
  return CANONICAL.get(unit);
}

/** Both units are known and measure the same dimension. */
export function compatible(a: Quantity, b: Quantity): boolean {
  const da = CANONICAL.get(a.unit);
  const db = CANONICAL.get(b.unit);
  return !!da && !!db && da.dim === db.dim;
}

/** The value in its dimension's base unit, or null when the unit is not known. */
export function toBase(q: Quantity): number | null {
  const def = CANONICAL.get(q.unit);
  return def ? q.value * def.scale + (def.offset ?? 0) : null;
}

/** The quantity (and its band) in another unit of the same dimension, or null when it has none. */
export function convert(q: Quantity, toUnit: string): Quantity | null {
  const from = CANONICAL.get(q.unit);
  const to = CANONICAL.get(toUnit);
  if (!from || !to || from.dim !== to.dim) return null;
  const across = (v: number) => (v * from.scale + (from.offset ?? 0) - (to.offset ?? 0)) / to.scale;
  const out: Quantity = { value: across(q.value), unit: to.name };
  // A bound recorded on one side only is part of the quantity too.
  if (q.min !== undefined) out.min = across(q.min);
  if (q.max !== undefined) out.max = across(q.max);
  return out;
}
