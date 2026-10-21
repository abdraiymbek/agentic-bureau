import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InlineVerification } from '../../apps/desktop/src/renderer/chat/InlineVerification';
import type { VerificationReview } from '../../apps/desktop/src/renderer/decide/model';

const record: VerificationReview = {
  status: 'passed',
  evidenceHash: 'exact-private-evidence-hash',
  evidence: {
    pass: true,
    expect: { size: [64.0000001, 46, 4.5], tol: 0.01 },
    integrity: { pass: true, detail: 'Recorded mesh integrity check.' },
    checks: [
      {
        name: 'overall size',
        pass: true,
        detail: '64.0000001 × 46 × 4.5 mm — expected within 0.01 mm',
      },
      { name: 'shells', pass: true, detail: '1 body' },
    ],
    coverage: {
      units: 'mm',
      frame: 'right-handed-z-up',
      assertions: ['overall size', 'shells'],
      limitations: ['Strength is not assessed.'],
    },
  },
};
const render = (verification?: VerificationReview) =>
  renderToStaticMarkup(
    React.createElement(InlineVerification, { verification, accepted: false, onAccept: () => {} }),
  );

describe('readable recorded verification in a human review', () => {
  it('shows actual assertion scope, exact measurement details and results before technical data', () => {
    const html = render(record);
    const primary = html.split('<details')[0]!;
    expect(primary).toContain('2 of 2 recorded assertions passed');
    expect(primary).toContain('Declared scope:');
    expect(primary).toContain('64.0000001 × 46 × 4.5 mm');
    expect(primary).toContain('Accept this exact declared verification scope');
    expect(primary).not.toContain('exact-private-evidence-hash');
    expect(html).toContain('exact-private-evidence-hash');
    expect(html).toContain('&quot;tol&quot;: 0.01');
    expect(html).toContain('Strength is not assessed.');
  });
  it('keeps scope acknowledgement outside every hidden disclosure', () => {
    const html = render(record);
    const at = html.indexOf('inline-scope-acceptance');
    const prefix = html.slice(0, at);
    expect(at).toBeGreaterThan(0);
    expect((prefix.match(/<details/g) ?? []).length).toBe(
      (prefix.match(/<\/details>/g) ?? []).length,
    );
  });
  it('prioritizes failed assertion details and never offers acceptance for failed evidence', () => {
    const verification: VerificationReview = {
      ...record,
      status: 'failed',
      evidence: {
        ...record.evidence,
        pass: false,
        checks: [
          ...record.evidence!.checks!,
          { name: 'clearance', pass: false, detail: '0.02 mm below the declared minimum.' },
        ],
      },
    };
    const html = render(verification);
    expect(html).toContain('Checks failed');
    expect(html).toContain('2 of 3 recorded assertions passed');
    expect(html.indexOf('<strong>clearance')).toBeLessThan(html.indexOf('<strong>overall size'));
    expect(html).not.toContain('inline-scope-acceptance');
  });
  it('preserves honest absent or invalidated verification state', () => {
    expect(render()).toContain('No engine verification recorded');
    expect(render()).toContain('No recorded assertion results');
    expect(render({ ...record, status: 'unverified' })).not.toContain('inline-scope-acceptance');
    expect(render({ ...record, status: 'unverified' })).toContain('Not verified for this revision');
  });
  it('keeps a completed decision readable without another scope-acceptance control', () => {
    const html = renderToStaticMarkup(
      React.createElement(InlineVerification, {
        verification: record,
        accepted: false,
        onAccept: () => {},
        showAcceptance: false,
      }),
    );
    expect(html).toContain('2 of 2 recorded assertions passed');
    expect(html).not.toContain('inline-scope-acceptance');
    expect(html).toContain('exact-private-evidence-hash');
  });
});
