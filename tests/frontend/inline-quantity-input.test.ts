import { describe, expect, it } from 'vitest';
import {
  quantityProblem,
  type QuantityFields,
  type QuantityDraft,
} from '../../apps/desktop/src/renderer/chat/quantity-input';

const fields: QuantityFields = [{ name: 'mass', label: 'Payload mass', unit: 'kg', value: 1.25 }];
const value = (unit: string, text = '1.2500'): QuantityDraft => [
  { name: 'mass', text, unit, unknown: false },
];

describe('exact inline quantity constraints', () => {
  it('refuses erased and dimension-incompatible recorded units, including restored drafts', () => {
    expect(quantityProblem(fields, value(''))).toContain('recorded unit (kg)');
    expect(quantityProblem(fields, value(' '))).toContain('recorded unit (kg)');
    expect(quantityProblem(fields, value('mm'))).toContain('compatible with kg');
  });
  it('accepts compatible conversions without rewriting exact typed values or units', () => {
    const draft = value('g', '1250.000');
    expect(quantityProblem(fields, draft)).toBeNull();
    expect(draft).toEqual(value('g', '1250.000'));
    expect(quantityProblem(fields, value('lbs', '2.755778'))).toBeNull();
  });
  it('keeps unknown units and Unicode reasons explicit and refuses a blank reason', () => {
    const draft: QuantityDraft = [
      { name: 'mass', text: '', unit: 'kg', unknown: true, reason: '測定待ち Ω' },
    ];
    expect(quantityProblem(fields, draft)).toBeNull();
    expect(draft[0]?.reason).toBe('測定待ち Ω');
    expect(quantityProblem(fields, [{ ...draft[0]!, unit: 'g' }])).toContain(
      'keep its recorded unit',
    );
    expect(quantityProblem(fields, [{ ...draft[0]!, reason: ' ' }])).toContain('reason');
  });
  it('does not infer a dimension for initially unspecified or unfamiliar units', () => {
    expect(quantityProblem([{ ...fields[0]!, unit: '' }], value(''))).toBeNull();
    expect(quantityProblem([{ ...fields[0]!, unit: '' }], value('V', '12.000'))).toBeNull();
    expect(quantityProblem([{ ...fields[0]!, unit: 'furlong' }], value('furlong'))).toBeNull();
    expect(quantityProblem([{ ...fields[0]!, unit: 'furlong' }], value('m'))).toContain(
      'compatible',
    );
  });
  it('still refuses missing values, numeric overflow and mismatched recorded fields', () => {
    expect(quantityProblem(fields, value('kg', ''))).toContain('finite number');
    expect(quantityProblem(fields, value('kg', '1e999'))).toContain('finite number');
    expect(quantityProblem(fields, [])).toContain('recorded fields changed');
  });
});
