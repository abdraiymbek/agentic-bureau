/**
 * One formatter for quantities and one for dates. Every surface shows values through these, so a
 * quantity always keeps its unit, an unknown always says so, and a time always means the same
 * thing. Pure functions: no React, no store.
 */
import type { MaybeQuantity, Money, Quantity } from '@bureau/contracts';

/* ------------------------------------------------------------------ */
/* Quantities                                                           */
/* ------------------------------------------------------------------ */

/** Joins a value to its unit so a line break never separates them. */
export const UNIT_JOIN = ' ';

const DISPLAY_DIGITS = 4;

/** Unit spellings for display. Each display form is an accepted alias, so a copied value parses back. */
const UNIT_DISPLAY: Record<string, string> = {
  'N*m': 'N·m',
  'N*mm': 'N·mm',
  'N*cm': 'N·cm',
  'kg*cm': 'kg·cm',
  'oz*in': 'oz·in',
  deg: '°',
  degC: '°C',
  uA: 'µA',
};

/** Units written against the number. */
const TIGHT_UNITS = new Set(['°', '%']);

export function displayUnit(unit: string): string {
  return UNIT_DISPLAY[unit] ?? unit;
}

/** A number at display precision: four significant digits, no trailing zeros, plain digits. */
export function formatNumber(value: number, digits = DISPLAY_DIGITS): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  return String(Number(value.toPrecision(digits)));
}

function withUnit(value: string, unit: string): string {
  const shown = displayUnit(unit);
  if (!shown || shown === '1') return value;
  return TIGHT_UNITS.has(shown) ? `${value}${shown}` : `${value}${UNIT_JOIN}${shown}`;
}

export type QuantityInput = Quantity | MaybeQuantity | null | undefined;

export interface QuantityText {
  /** What to show. */
  text: string;
  /** False for not set and for unknown values; render those with `.unknown`. */
  known: boolean;
}

/**
 * The display form of a quantity. Not set (null or undefined) and unknown (with its recorded
 * reason) are words, never zero.
 */
export function describeQuantity(q: QuantityInput, digits = DISPLAY_DIGITS): QuantityText {
  if (q == null) return { text: 'Not set', known: false };
  if ('unknown' in q && q.unknown === true)
    return { text: q.reason ? `Unknown — ${q.reason}` : 'Unknown', known: false };
  const { value, unit, min, max } = q as Quantity;
  const main = withUnit(formatNumber(value, digits), unit);
  const bound = (n: number) => withUnit(formatNumber(n, digits), unit);
  const range =
    min !== undefined && max !== undefined
      ? ` (${formatNumber(min, digits)}–${bound(max)})`
      : min !== undefined
        ? ` (min ${bound(min)})`
        : max !== undefined
          ? ` (max ${bound(max)})`
          : '';
  return { text: main + range, known: true };
}

export function formatQuantity(q: QuantityInput, digits = DISPLAY_DIGITS): string {
  return describeQuantity(q, digits).text;
}

/** Money keeps the recorded decimal string; it is never re-parsed as a float. */
export function formatMoney(money: Money | null | undefined): string {
  if (!money) return 'Unknown';
  return `${money.amount}${UNIT_JOIN}${money.currency}`;
}

/* ------------------------------------------------------------------ */
/* Dates                                                                */
/* ------------------------------------------------------------------ */

export type DateStyle =
  /** "just now", "12 min ago", "3 h ago", "Yesterday", "4 d ago", then the date. */
  | 'relative'
  /** The calendar day: "13 Oct 2026". */
  | 'day'
  /** Day and time: "13 Oct 2026, 14:05". */
  | 'datetime'
  /** Time of day: "14:05". */
  | 'time';

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Reads an ISO timestamp, or a calendar date (YYYY-MM-DD) as that day in local time. A date-only
 * value is never shifted through UTC, so an observation recorded for the 26th shows the 26th.
 */
export function parseDate(value: string): { date: Date; dateOnly: boolean } | null {
  const day = DATE_ONLY.exec(value.trim());
  if (day) {
    const date = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    return Number.isFinite(date.getTime()) ? { date, dateOnly: true } : null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? { date, dateOnly: false } : null;
}

const DAY: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };
const TIME: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };

function startOfDay(t: number) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A recorded time in words. Unreadable input reads as unknown; it is never replaced by now. */
export function formatDate(
  value: string | null | undefined,
  style: DateStyle = 'relative',
  now = Date.now(),
  locale?: string,
): string {
  const parsed = value ? parseDate(value) : null;
  if (!parsed) return 'Unknown time';
  const { date, dateOnly } = parsed;
  const t = date.getTime();
  if (style === 'day' || (dateOnly && style !== 'time'))
    return date.toLocaleDateString(locale, DAY);
  if (style === 'time') return date.toLocaleTimeString(locale, TIME);
  if (style === 'datetime') return date.toLocaleString(locale, { ...DAY, ...TIME });

  const s = (now - t) / 1000;
  // A time ahead of this clock is shown as recorded rather than as a guess about the future.
  if (s < -60) return date.toLocaleString(locale, { ...DAY, ...TIME });
  if (s < 45) return 'just now';
  if (s < 90) return '1 min ago';
  const min = Math.round(s / 60);
  if (min < 45) return `${min} min ago`;
  if (min < 90) return '1 h ago';
  const days = Math.round((startOfDay(now) - startOfDay(t)) / 86_400_000);
  if (days === 0 || min < 22 * 60) return `${Math.round(min / 60)} h ago`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} d ago`;
  return date.toLocaleDateString(locale, DAY);
}

/** The absolute form shown beside every relative time (tooltip, `<time dateTime>`). */
export function absoluteDate(value: string | null | undefined, locale?: string): string {
  const parsed = value ? parseDate(value) : null;
  if (!parsed) return 'Unknown time';
  return parsed.dateOnly
    ? parsed.date.toLocaleDateString(locale, DAY)
    : parsed.date.toLocaleString(locale, { ...DAY, ...TIME });
}
