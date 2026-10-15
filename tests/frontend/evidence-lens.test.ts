import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { CoverageEvidence, CoverageReport, CoverageRequirement } from '@omenflow/contracts';
import {
  EvidenceView,
  type CoverageState,
} from '../../apps/desktop/src/renderer/project/EvidenceLens';
import {
  coverageSentence,
  filterCounts,
  filterRequirements,
  gapPrompt,
  targetView,
  verdictOf,
} from '../../apps/desktop/src/renderer/project/evidence';

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function evidence(n: number, over: Partial<CoverageEvidence> = {}): CoverageEvidence {
  return {
    artifactId: id(100 + n),
    type: 'calculation',
    title: `Evidence ${n}`,
    relation: 'validates',
    state: 'current',
    evidenceKind: null,
    result: null,
    verdict: 'unknown',
    ...over,
  };
}

function requirement(n: number, over: Partial<CoverageRequirement> = {}): CoverageRequirement {
  return {
    artifactId: id(n),
    title: `Requirement ${n}`,
    statement: `The rover shall do thing ${n}.`,
    target: { value: n, unit: 'kg' },
    priority: 'must',
    review: 'approved',
    coverage: 'none',
    reason: 'Nothing is linked.',
    evidence: [],
    ...over,
  };
}

const rows: CoverageRequirement[] = [
  requirement(1, {
    title: 'Payload capacity',
    target: { value: 0.3, unit: 'kg' },
    coverage: 'covered',
    reason: '1 calculation and 1 test are current.',
    evidence: [
      evidence(1, { title: 'Rover mass budget', result: '0.412 kg', evidenceKind: 'calculated' }),
      evidence(2, {
        type: 'test',
        title: 'Ramp traverse',
        result: '0.35 kg',
        verdict: 'pass',
        evidenceKind: 'measured',
      }),
    ],
  }),
  requirement(2, {
    title: 'Endurance',
    target: { value: 45, unit: 'min' },
    coverage: 'partial',
    priority: 'should',
    reason: 'One test has no result.',
    evidence: [
      evidence(3, { title: 'Usable pack energy', result: '2.664 Wh' }),
      evidence(4, { type: 'test', title: 'Runtime test', state: 'no_result' }),
    ],
  }),
  requirement(3, {
    title: 'Ramp climb',
    target: { unknown: true, reason: 'ramp angle not decided' },
    coverage: 'stale',
    review: 'in_review',
    reason: 'Wheel torque was computed for an earlier payload.',
    evidence: [evidence(5, { title: 'Wheel torque', state: 'stale', result: '0.21 N*m' })],
  }),
  requirement(4, {
    title: 'Indoor use',
    target: null,
    coverage: 'none',
    review: 'draft',
    priority: 'could',
  }),
  requirement(5, {
    title: 'Supply voltage',
    target: { value: 12, unit: 'V', min: 11, max: 13 },
    coverage: 'partial',
    reason: 'One test failed; one calculation is a draft.',
    evidence: [
      evidence(6, { type: 'test', title: 'Bench supply', result: '10.8 V', verdict: 'fail' }),
      evidence(7, { title: 'Regulator drop', state: 'draft', verdict: 'pass' }),
    ],
  }),
];
const report: CoverageReport = {
  requirements: rows,
  totals: { requirements: 5, covered: 1, partial: 2, stale: 1, none: 1 },
};

const render = (state: CoverageState) =>
  renderToStaticMarkup(React.createElement(EvidenceView, { state, onRetry: () => {} })) as string;

describe('evidence lens rendering', () => {
  const html = render({ status: 'ready', report });

  it('names every coverage state in words with the host’s reason', () => {
    for (const text of [
      'Covered',
      'Partly covered',
      'Out of date',
      'No evidence',
      '1 calculation and 1 test are current.',
      'Wheel torque was computed for an earlier payload.',
    ])
      expect(html).toContain(text);
  });

  it('keeps targets as quantities with units and an unknown target unknown, with its reason', () => {
    expect(html).toContain('0.3 kg');
    expect(html).toContain('45 min');
    expect(html).toContain('12 [11–13] V');
    expect(html).toContain('Unknown');
    expect(html).toContain('ramp angle not decided');
    expect(html).toContain('No quantitative target');
    expect(html).not.toMatch(/>0 kg</);
  });

  it('shows evidence chips with state words, recorded results and only recorded test verdicts', () => {
    for (const text of ['Rover mass budget', '0.412 kg', 'No result', 'Draft', '10.8 V'])
      expect(html).toContain(text);
    expect(html).toContain('>Pass<');
    expect(html).toContain('>Fail<');
    // A draft calculation never shows a verdict, even if one came with it.
    expect(html.match(/>Pass</g)).toHaveLength(1);
    expect(html).toContain('Nothing linked');
  });

  it('states the totals in a sentence and offers to close the gaps in view', () => {
    expect(html).toContain(
      '3 of 5 requirements have current evidence, 2 of them only partly. 1 is out of date and 1 has no evidence.',
    );
    expect(html).toContain('Ask agent to close 4 gaps');
    expect(html).toContain('Must');
    expect(html).toContain('In review');
  });

  it('says plainly when the host does not provide coverage, and never shows a matrix then', () => {
    const unavailable = render({ status: 'unavailable' });
    expect(unavailable).toContain('Coverage is not available in this build');
    expect(unavailable).toContain('project.coverage');
    expect(unavailable).not.toContain('<table');
  });

  it('has loading, error and empty states', () => {
    expect(render({ status: 'loading' })).toContain('Loading');
    const error = render({ status: 'error', message: 'Project not open' });
    expect(error).toContain('Coverage didn’t load');
    expect(error).toContain('Project not open');
    expect(error).toContain('Try again');
    const empty = render({
      status: 'ready',
      report: {
        requirements: [],
        totals: { requirements: 0, covered: 0, partial: 0, stale: 0, none: 0 },
      },
    });
    expect(empty).toContain('No requirements yet');
  });
});

describe('coverage sentence', () => {
  const t = (covered: number, partial: number, stale: number, none: number) =>
    coverageSentence({
      requirements: covered + partial + stale + none,
      covered,
      partial,
      stale,
      none,
    });

  it('counts covered and partly covered requirements as having current evidence', () => {
    expect(t(5, 0, 1, 1)).toBe(
      '5 of 7 requirements have current evidence. 1 is out of date and 1 has no evidence.',
    );
    expect(t(0, 1, 0, 2)).toBe(
      '1 of 3 requirements has current evidence, but only partly. 2 have no evidence.',
    );
    expect(t(0, 2, 1, 0)).toBe(
      '2 of 3 requirements have current evidence, but each only partly. 1 is out of date.',
    );
    expect(t(0, 0, 0, 4)).toBe('0 of 4 requirements have current evidence. 4 have no evidence.');
  });

  it('handles all covered, one requirement, and none', () => {
    expect(t(7, 0, 0, 0)).toBe('All 7 requirements have current evidence.');
    expect(t(1, 0, 0, 0)).toBe('1 of 1 requirement has current evidence.');
    expect(t(0, 0, 0, 0)).toBe('No requirements yet.');
  });
});

describe('evidence filters and the gap prompt', () => {
  it('narrows to gaps, out of date or no evidence, and searches titles and evidence', () => {
    expect(filterCounts(rows)).toEqual({ all: 5, gaps: 4, stale: 1, none: 1 });
    expect(filterRequirements(rows, 'gaps').map((r) => r.title)).toEqual([
      'Endurance',
      'Ramp climb',
      'Indoor use',
      'Supply voltage',
    ]);
    expect(filterRequirements(rows, 'stale').map((r) => r.title)).toEqual(['Ramp climb']);
    expect(filterRequirements(rows, 'none').map((r) => r.title)).toEqual(['Indoor use']);
    expect(filterRequirements(rows, 'all', 'ramp').map((r) => r.title)).toEqual([
      'Payload capacity',
      'Ramp climb',
    ]);
  });

  it('names each gap by id, target and the evidence that needs attention', () => {
    const prompt = gapPrompt(rows);
    expect(prompt).toMatch(/^Close the evidence gaps for these 4 requirements\./);
    expect(prompt).not.toContain('Payload capacity');
    expect(prompt).toContain(`1. Requirement Endurance (artifact ${id(2)}) · target 45 min`);
    expect(prompt).toContain('target unknown (ramp angle not decided)');
    expect(prompt).toContain('no quantitative target');
    expect(prompt).toContain(`test Runtime test (artifact ${id(104)}, no result)`);
    expect(prompt).toContain('do not record a result you did not obtain');
    expect(prompt.trim().endsWith('call work_status and tell me what is still open.')).toBe(true);
  });

  it('keeps a bound recorded on one side of the target, in the lens and in the prompt', () => {
    const banded = requirement(9, {
      title: 'Payload mass',
      target: { value: 0.3, unit: 'kg', max: 0.35 },
      coverage: 'none',
      evidence: [],
    });
    expect(targetView(banded.target)).toEqual({ kind: 'value', text: '0.3 kg (max 0.35)' });
    expect(targetView({ value: 12, unit: 'V', min: 11 })).toEqual({
      kind: 'value',
      text: '12 V (min 11)',
    });
    expect(targetView({ value: 0.3, unit: 'kg', min: 0.25, max: 0.35 })).toEqual({
      kind: 'value',
      text: '0.3 [0.25–0.35] kg',
    });
    expect(gapPrompt([banded])).toContain('· target 0.3 kg (max 0.35) ·');
  });

  it('reads targets and verdicts without inference', () => {
    expect(targetView({ unknown: true, reason: '' })).toEqual({ kind: 'unknown', reason: null });
    expect(targetView(null)).toEqual({ kind: 'none' });
    expect(verdictOf(evidence(1, { type: 'calculation', verdict: 'pass' }))).toBeNull();
    expect(verdictOf(evidence(1, { type: 'test', verdict: 'unknown' }))).toBeNull();
    expect(verdictOf(evidence(1, { type: 'test', verdict: 'fail' }))).toBe('Fail');
  });
});
