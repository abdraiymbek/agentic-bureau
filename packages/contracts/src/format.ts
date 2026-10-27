/**
 * Pure display helpers with no runtime dependencies, published as the
 * `@bureau/contracts/format` entry point so a caller can format a value
 * without loading zod and the operation registry. Only type imports are
 * allowed here: they are erased at build time. `format.test.ts` fails if a
 * value import is added.
 */
import type { Origin } from './ids.js';
import type { MaybeQuantity, Quantity } from './units.js';

export function isUnknown(q: MaybeQuantity | null | undefined): boolean {
  return q == null || ('unknown' in q && q.unknown === true);
}

const FORMAT_DIGITS = 4;
export function formatQty(q: Quantity | MaybeQuantity | null | undefined): string {
  if (isUnknown(q as MaybeQuantity)) {
    const reason =
      q && typeof q === 'object' && 'reason' in q ? ` (${(q as { reason: string }).reason})` : '';
    return `unknown${reason}`;
  }
  const qq = q as Quantity;
  const v = Number(qq.value.toPrecision(FORMAT_DIGITS));
  const range =
    qq.min !== undefined && qq.max !== undefined
      ? ` [${Number(qq.min.toPrecision(FORMAT_DIGITS))}–${Number(qq.max.toPrecision(FORMAT_DIGITS))}]`
      : '';
  return `${v}${range} ${qq.unit}`;
}

export function originLabel(origin: Origin): string {
  return origin.kind === 'agent' ? `agent:${origin.sessionId.slice(0, 8)}` : origin.kind;
}
