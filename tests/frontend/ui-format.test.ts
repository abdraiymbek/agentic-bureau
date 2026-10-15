import { describe, expect, it } from 'vitest';
import {
  UNIT_JOIN,
  absoluteDate,
  describeQuantity,
  displayUnit,
  formatDate,
  formatMoney,
  formatNumber,
  formatQuantity,
  parseDate,
} from '../../apps/desktop/src/renderer/ui/format';

const j = (s: string) => s.replaceAll(' ', UNIT_JOIN);

describe('quantity formatter', () => {
  it('keeps the unit with the value and never breaks them apart', () => {
    expect(formatQuantity({ value: 0.41234, unit: 'kg' })).toBe(j('0.4123 kg'));
    expect(formatQuantity({ value: 300, unit: 'g' })).toBe(j('300 g'));
    expect(formatQuantity({ value: 0, unit: 'mm' })).toBe(j('0 mm'));
  });

  it('says not set and unknown in words, never zero', () => {
    expect(describeQuantity(null)).toEqual({ text: 'Not set', known: false });
    expect(describeQuantity(undefined)).toEqual({ text: 'Not set', known: false });
    expect(describeQuantity({ unknown: true, reason: 'battery mass not recorded' })).toEqual({
      text: 'Unknown — battery mass not recorded',
      known: false,
    });
    expect(describeQuantity({ unknown: true, reason: '' })).toEqual({
      text: 'Unknown',
      known: false,
    });
  });

  it('shows bounds in the same unit', () => {
    expect(formatQuantity({ value: 0.3, unit: 'kg', min: 0.28, max: 0.32 })).toBe(
      `0.3${UNIT_JOIN}kg (0.28–0.32${UNIT_JOIN}kg)`,
    );
  });

  it('shows a bound recorded on one side only', () => {
    expect(formatQuantity({ value: 0.3, unit: 'kg', max: 0.35 })).toBe(
      `0.3${UNIT_JOIN}kg (max 0.35${UNIT_JOIN}kg)`,
    );
    expect(formatQuantity({ value: 12, unit: 'V', min: 11 })).toBe(
      `12${UNIT_JOIN}V (min 11${UNIT_JOIN}V)`,
    );
  });

  it('writes units in display form only where the display form parses back', () => {
    expect(displayUnit('N*m')).toBe('N·m');
    expect(displayUnit('degC')).toBe('°C');
    expect(displayUnit('m/s^2')).toBe('m/s^2');
    expect(formatQuantity({ value: 15, unit: 'deg' })).toBe('15°');
    expect(formatQuantity({ value: 12, unit: '%' })).toBe('12%');
    expect(formatQuantity({ value: 3, unit: '1' })).toBe('3');
    expect(formatQuantity({ value: 20, unit: 'degC' })).toBe(j('20 °C'));
  });

  it('rounds to four significant digits without trailing zeros', () => {
    expect(formatNumber(1234.5)).toBe('1235');
    expect(formatNumber(0.000012346)).toBe('0.00001235');
    expect(formatNumber(-2.5)).toBe('-2.5');
    expect(formatNumber(1.23456, 6)).toBe('1.23456');
  });

  it('keeps recorded money decimals exactly', () => {
    expect(formatMoney({ amount: '12.50', currency: 'USD' })).toBe(j('12.50 USD'));
    expect(formatMoney(null)).toBe('Unknown');
  });
});

describe('date formatter', () => {
  const now = new Date(2026, 9, 13, 15, 0, 0).getTime();
  const ago = (s: number) => new Date(now - s * 1000).toISOString();

  it('words recent times and does not round across a unit boundary', () => {
    expect(formatDate(ago(10), 'relative', now)).toBe('just now');
    expect(formatDate(ago(60), 'relative', now)).toBe('1 min ago');
    expect(formatDate(ago(12 * 60), 'relative', now)).toBe('12 min ago');
    expect(formatDate(ago(59.6 * 60), 'relative', now)).toBe('1 h ago');
    expect(formatDate(ago(3 * 3600), 'relative', now)).toBe('3 h ago');
  });

  it('uses calendar days beyond today', () => {
    const yesterday = new Date(2026, 9, 12, 9, 0, 0).toISOString();
    const threeDays = new Date(2026, 9, 10, 9, 0, 0).toISOString();
    expect(formatDate(yesterday, 'relative', now)).toBe('Yesterday');
    expect(formatDate(threeDays, 'relative', now)).toBe('3 d ago');
    expect(formatDate(new Date(2026, 8, 1).toISOString(), 'relative', now, 'en-GB')).toBe(
      '1 Sept 2026',
    );
  });

  it('shows a date-only value as that calendar day, never shifted through UTC', () => {
    const parsed = parseDate('2026-09-26');
    expect(parsed?.dateOnly).toBe(true);
    expect(parsed?.date.getDate()).toBe(26);
    expect(formatDate('2026-09-26', 'relative', now, 'en-GB')).toBe('26 Sept 2026');
    expect(absoluteDate('2026-09-26', 'en-GB')).toBe('26 Sept 2026');
  });

  it('never invents a time', () => {
    expect(formatDate('', 'relative', now)).toBe('Unknown time');
    expect(formatDate('not a date', 'day', now)).toBe('Unknown time');
    expect(formatDate(null)).toBe('Unknown time');
    expect(absoluteDate(undefined)).toBe('Unknown time');
  });

  it('shows a time ahead of this clock as recorded', () => {
    const ahead = new Date(now + 5 * 60_000).toISOString();
    expect(formatDate(ahead, 'relative', now, 'en-GB')).toBe(
      formatDate(ahead, 'datetime', now, 'en-GB'),
    );
  });
});
