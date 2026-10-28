/**
 * The Evidence lens's reading of `project.coverage`. Everything here restates what the host
 * recorded: no verdict is derived from numbers, and an unknown target stays unknown.
 */
import type {
  CoverageEvidence,
  CoverageReport,
  CoverageRequirement,
  MaybeQuantity,
} from '@bureau/contracts';
import { isUnknown } from '@bureau/contracts/format';
import { quantityText, type KnownQuantity } from '../lib/diff';
import type { Tone } from '../ui/kit';

export type Coverage = CoverageRequirement['coverage'];
export type CoverageFilter = 'all' | 'gaps' | 'stale' | 'none';

export const COVERAGE_LABEL: Record<Coverage, string> = {
  covered: 'Covered',
  partial: 'Partly covered',
  stale: 'Out of date',
  none: 'No evidence',
};

export const COVERAGE_TONE: Record<Coverage, Tone> = {
  covered: 'ok',
  partial: 'warn',
  stale: 'warn',
  none: 'err',
};

export const EVIDENCE_STATE_LABEL: Record<CoverageEvidence['state'], string> = {
  current: 'Current',
  stale: 'Out of date',
  draft: 'Draft',
  no_result: 'No result',
};

export const EVIDENCE_STATE_TONE: Record<CoverageEvidence['state'], Tone> = {
  current: 'ok',
  stale: 'warn',
  draft: 'neutral',
  no_result: 'neutral',
};

export const RELATION_LABEL: Record<CoverageEvidence['relation'], string> = {
  validates: 'validates',
  derived_from: 'is derived from',
  depends_on: 'depends on',
};

export const PRIORITY_LABEL: Record<CoverageRequirement['priority'], string> = {
  must: 'Must',
  should: 'Should',
  could: 'Could',
};

/** The review state as the shared `State` vocabulary names it. */
export const REVIEW_STATE: Record<CoverageRequirement['review'], string> = {
  approved: 'approved',
  draft: 'draft',
  in_review: 'proposed',
};

/** A verdict is shown only where a test result recorded one. */
export function verdictOf(e: CoverageEvidence): 'Pass' | 'Fail' | null {
  if (e.type !== 'test') return null;
  if (e.verdict === 'pass') return 'Pass';
  if (e.verdict === 'fail') return 'Fail';
  return null;
}

export type TargetView =
  { kind: 'value'; text: string } | { kind: 'unknown'; reason: string | null } | { kind: 'none' };

export function targetView(target: MaybeQuantity | null): TargetView {
  if (target == null) return { kind: 'none' };
  if (isUnknown(target)) {
    const reason = 'reason' in target && typeof target.reason === 'string' ? target.reason : '';
    return { kind: 'unknown', reason: reason.trim() || null };
  }
  return { kind: 'value', text: quantityText(target as KnownQuantity) };
}

function targetText(target: MaybeQuantity | null): string {
  const t = targetView(target);
  if (t.kind === 'value') return `target ${t.text}`;
  if (t.kind === 'unknown') return t.reason ? `target unknown (${t.reason})` : 'target unknown';
  return 'no quantitative target';
}

const isGap = (r: CoverageRequirement) => r.coverage !== 'covered';

export function filterRequirements(
  rows: CoverageRequirement[],
  filter: CoverageFilter,
  query = '',
): CoverageRequirement[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (filter === 'gaps' && !isGap(r)) return false;
    if (filter === 'stale' && r.coverage !== 'stale') return false;
    if (filter === 'none' && r.coverage !== 'none') return false;
    if (!q) return true;
    return [r.title, r.statement, ...r.evidence.map((e) => e.title)]
      .join(' ')
      .toLowerCase()
      .includes(q);
  });
}

export function filterCounts(rows: CoverageRequirement[]): Record<CoverageFilter, number> {
  return {
    all: rows.length,
    gaps: rows.filter(isGap).length,
    stale: rows.filter((r) => r.coverage === 'stale').length,
    none: rows.filter((r) => r.coverage === 'none').length,
  };
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function joinClauses(parts: string[]): string {
  if (parts.length < 2) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The lens's header line, e.g. "5 of 7 requirements have current evidence. 2 have none." */
export function coverageSentence(t: CoverageReport['totals']): string {
  const n = t.requirements;
  if (n === 0) return 'No requirements yet.';
  if (t.covered === n && n > 1) return `All ${n} requirements have current evidence.`;
  const current = t.covered + t.partial;
  // Partly covered requirements are among those with current evidence, so they are said there
  // rather than counted again beside the out-of-date and uncovered ones.
  const partly =
    t.partial === 0
      ? ''
      : t.partial === current
        ? `, but ${plural(current, 'only partly', 'each only partly')}`
        : `, ${t.partial} of them only partly`;
  const head = `${current} of ${n} ${plural(n, 'requirement', 'requirements')} ${plural(current, 'has', 'have')} current evidence${partly}.`;
  const rest = [
    t.stale > 0 && `${t.stale} ${plural(t.stale, 'is', 'are')} out of date`,
    t.none > 0 && `${t.none} ${plural(t.none, 'has', 'have')} no evidence`,
  ].filter((x): x is string => !!x);
  if (!rest.length) return head;
  const tail = joinClauses(rest);
  return `${head} ${tail.charAt(0).toUpperCase()}${tail.slice(1)}.`;
}

/**
 * The instruction offered to the agent for the gaps in view. It names every requirement by id
 * and the evidence that needs attention, and asks for nothing that would invent a result.
 */
export function gapPrompt(rows: CoverageRequirement[]): string {
  const gaps = rows.filter(isGap);
  const lines = gaps.map((r, i) => {
    const attention = r.evidence
      .filter((e) => e.state !== 'current')
      .map(
        (e) =>
          `${e.type} ${e.title} (artifact ${e.artifactId}, ${EVIDENCE_STATE_LABEL[e.state].toLowerCase()})`,
      );
    const head = `${i + 1}. Requirement ${r.title} (artifact ${r.artifactId}) · ${targetText(r.target)} · ${COVERAGE_LABEL[r.coverage]}`;
    const reason = r.reason.trim() ? `: ${r.reason.trim()}` : '';
    const needs = attention.length ? ` Needs attention: ${attention.join('; ')}.` : '';
    return `${head}${reason}${needs}`;
  });
  return [
    `Close the evidence gaps for ${plural(gaps.length, 'this requirement', `these ${gaps.length} requirements`)}. For each one, add or bring up to date the calculation or test that checks it against its target, run it or record the result you actually obtain, and link it to the requirement. Do not change the requirements, and do not record a result you did not obtain.`,
    '',
    ...lines,
    '',
    'When you are done, call work_status and tell me what is still open.',
  ].join('\n');
}
