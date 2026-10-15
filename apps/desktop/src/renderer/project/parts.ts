/**
 * The Parts lens's reading of `bom.read` and `component.compare`. The host computes totals; this
 * module only labels them. Unknown values are listed, never summed and never shown as zero.
 */
import type { ComponentPayload, MaybeQuantity, Money, Offer, Quantity } from '@omenflow/contracts';
import { isUnknown } from '@omenflow/contracts/format';
import { quantityText } from '../lib/diff';
import { compatible, convert, toBase } from '../ui/units';

/** A value the host could not include in a known total, with the reason when one was recorded. */
export interface UnknownEntry {
  lineId: string;
  componentTitle: string;
  reason: string | null;
}

export interface BomLineView {
  line: {
    id: string;
    componentArtifactId: string;
    componentRevisionId?: string;
    subsystem: string | null;
    quantity: number;
    notes: string;
  };
  componentTitle: string;
  partNumber: string;
  manufacturer: string;
  imageUrl?: string | null;
  selectionReason?: string | null;
  description?: string | null;
  offer:
    | (Pick<Offer, 'seller' | 'url' | 'quantityBasis' | 'observedAt' | 'availabilityText'> & {
        price: Money | null;
      })
    | null;
  unitMass: Quantity | null;
  lineTotal: Money | null;
  /** Newer hosts say why a value is unknown and whether the line's revision is still current. */
  massUnknownReason?: string | null;
  priceUnknownReason?: string | null;
  componentRevisionCurrent?: boolean;
}

export interface Bom {
  lines: BomLineView[];
  totals: {
    cost: Money[];
    missingPriceCount: number;
    knownMass: Quantity | null;
    missingMassCount: number;
    lineCount: number;
    unknownCost?: UnknownEntry[];
    unknownMass?: UnknownEntry[];
  };
  /** Lines of replaced components, excluded from the lines and the totals. */
  replacedLines?: unknown[];
}

export interface BomTotalsView {
  /** Known cost per currency; currencies are never added together. */
  cost: Money[];
  mass: Quantity | null;
  lines: number;
  priceUnknown: UnknownEntry[];
  /** Counted by the host as unknown but not identified line by line. */
  priceUnknownUnlisted: number;
  massUnknown: UnknownEntry[];
  massUnknownUnlisted: number;
  replaced: number;
}

function priceReason(l: BomLineView): string | null {
  if (l.priceUnknownReason) return l.priceUnknownReason;
  if (!l.offer) return 'no offer chosen';
  if (!l.offer.price) return 'the offer has no price';
  return null;
}

export function bomTotalsView(bom: Bom): BomTotalsView {
  const t = bom.totals;
  const priceUnknown =
    t.unknownCost ??
    bom.lines
      .filter((l) => !l.lineTotal)
      .map((l) => ({
        lineId: l.line.id,
        componentTitle: l.componentTitle,
        reason: priceReason(l),
      }));
  const massUnknown =
    t.unknownMass ??
    bom.lines
      .filter((l) => !l.unitMass)
      .map((l) => ({
        lineId: l.line.id,
        componentTitle: l.componentTitle,
        reason: l.massUnknownReason ?? null,
      }));
  return {
    cost: t.cost,
    mass: t.knownMass,
    lines: t.lineCount,
    priceUnknown,
    priceUnknownUnlisted: Math.max(0, t.missingPriceCount - priceUnknown.length),
    massUnknown,
    massUnknownUnlisted: Math.max(0, t.missingMassCount - massUnknown.length),
    replaced: bom.replacedLines?.length ?? 0,
  };
}

export const formatMoney = (m: Money) => `${m.amount} ${m.currency}`;

/** Mass of a whole line, or null when the unit mass is unknown. */
export function lineMass(l: BomLineView): Quantity | null {
  return l.unitMass ? { value: l.unitMass.value * l.line.quantity, unit: l.unitMass.unit } : null;
}

/**
 * The unit a mass column reads in: grams below one kilogram of known total, else kilograms.
 * Recorded values in units the table does not know keep their own unit.
 */
const KILOGRAM: Quantity = { value: 1, unit: 'kg' };

export function massUnitFor(total: Quantity | null): 'g' | 'kg' | null {
  const kilograms = total ? toBase(total) : null;
  if (!total || kilograms === null || !compatible(total, KILOGRAM)) return null;
  return Math.abs(kilograms) < 1 ? 'g' : 'kg';
}

/** Formats a mass in the column's unit when it converts exactly, else as recorded. */
export function formatMass(q: Quantity | null, unit: 'g' | 'kg' | null): string | null {
  if (!q) return null;
  const shown = unit && q.unit !== unit && compatible(q, KILOGRAM) ? convert(q, unit) : null;
  return quantityText(shown ?? q);
}

/* ------------------------------------------------------------------ */
/* Components                                                          */
/* ------------------------------------------------------------------ */

export type PartGroup = 'candidate' | 'selected' | 'set-aside';

export const GROUP_LABEL: Record<PartGroup, string> = {
  candidate: 'Candidates',
  selected: 'Selected',
  'set-aside': 'Set aside',
};

export const GROUP_HINT: Record<PartGroup, string> = {
  candidate: 'Suggested, not selected yet',
  selected: 'Chosen for the design',
  'set-aside': 'Rejected or superseded',
};

export function partGroup(status: ComponentPayload['status'] | undefined): PartGroup {
  if (status === 'selected') return 'selected';
  if (status === 'rejected' || status === 'superseded') return 'set-aside';
  return 'candidate';
}

export const COMPARE_LIMIT = 4;

export type CompareVerdict = 'same' | 'differs' | 'units-differ' | 'single' | 'unknown';

export interface CompareRow {
  verdict: CompareVerdict;
  unknown: number;
}

function known(v: MaybeQuantity | null): Quantity | null {
  return v == null || isUnknown(v) ? null : (v as Quantity);
}

const SAME_TOLERANCE = 1e-9;

function sameValue(a: number, b: number) {
  return Math.abs(a - b) <= SAME_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Compares one property across parts. Values in different units are compared in base units. */
export function compareValues(values: (MaybeQuantity | null)[]): CompareRow {
  const knowns = values.map(known).filter((q): q is Quantity => q !== null);
  const unknown = values.length - knowns.length;
  const [first, ...rest] = knowns;
  if (!first) return { verdict: 'unknown', unknown };
  if (!rest.length) return { verdict: values.length > 1 ? 'single' : 'same', unknown };
  for (const q of rest) {
    if (q.unit === first.unit) {
      if (!sameValue(q.value, first.value)) return { verdict: 'differs', unknown };
    } else if (compatible(q, first)) {
      if (!sameValue(toBase(q)!, toBase(first)!)) return { verdict: 'differs', unknown };
    } else return { verdict: 'units-differ', unknown };
  }
  return { verdict: 'same', unknown };
}

export function compareLabel({ verdict, unknown }: CompareRow, total: number): string {
  if (verdict === 'unknown') return 'Not recorded for any';
  if (verdict === 'single') return `Recorded for 1 of ${total}`;
  const word =
    verdict === 'same'
      ? unknown
        ? 'Same where known'
        : 'Same'
      : verdict === 'differs'
        ? 'Differs'
        : 'Units differ';
  return unknown ? `${word} · ${unknown} of ${total} unknown` : word;
}

/** A drafted instruction for the agent; the person edits or sends it in the terminal. */
export function alternativesPrompt(part: {
  id: string;
  title: string;
  manufacturer?: string;
  partNumber?: string;
  reason?: string | null;
}): string {
  const identity = [part.manufacturer, part.partNumber].filter(Boolean).join(' ');
  return [
    `Find alternatives to Component ${part.title} (artifact ${part.id})${identity ? `, ${identity}` : ''}.`,
    part.reason ? `It was chosen because: ${part.reason}` : '',
    'Keep the current part unchanged. Add each alternative as a candidate with its source and a seller offer, record the properties that matter here with their units, and say in its selection reason how it compares. Do not select or propose any of them.',
  ]
    .filter(Boolean)
    .join(' ');
}
