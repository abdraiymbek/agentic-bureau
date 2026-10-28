import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CadSpecReadiness, CadSpecReport } from '@bureau/contracts';
import {
  SpecItems,
  orderedRows,
  originOf,
  sinceText,
} from '../../apps/desktop/src/renderer/decide/SpecItems';

const report: CadSpecReport = {
  listedBy: 'agent',
  items: [
    { item: 'outer diameter 60 mm', from: 'listed', state: 'passed', checks: ['outer circle d60'] },
    {
      item: 'Groove bottom Ø50',
      from: 'requirement',
      requirementId: 'r1',
      state: 'failed',
      checks: ['section z=8: outer circle d50'],
    },
    { item: 'both flanks straight', from: 'listed', state: 'unasserted', checks: [] },
    {
      item: 'Belt load',
      from: 'requirement',
      requirementId: 'r2',
      statement: true,
      state: 'not_shown',
      checks: [],
      reason: 'No check shows this requirement: it states a force target (200 N).',
    },
  ],
  requirements: [
    {
      artifactId: 'r1',
      revisionId: 'r1a',
      title: 'V-groove profile',
      priority: 'must',
      review: 'draft',
      via: ['edge'],
      linkedBy: 'agent',
      kind: 'features',
      derivedHash: 'h',
    },
    {
      artifactId: 'r2',
      revisionId: 'r2a',
      title: 'Belt load',
      priority: 'should',
      review: 'approved',
      via: ['input'],
      linkedBy: 'person',
      kind: 'advice',
      derivedHash: 'h',
    },
  ],
  counts: { items: 4, passed: 1, failed: 1, unasserted: 1, notShown: 1, blocking: 1 },
};

const render = (spec?: CadSpecReport, readiness?: CadSpecReadiness) =>
  renderToStaticMarkup(React.createElement(SpecItems, { spec, readiness })).replace(
    /<!-- -->/g,
    '',
  );

describe('listed items of a CAD check', () => {
  it('puts items without an assertion first, then failed, not shown and passed', () => {
    expect(orderedRows(report).map((row) => row.state)).toEqual([
      'unasserted',
      'failed',
      'not_shown',
      'passed',
    ]);
    const html = render(report);
    expect(html.indexOf('both flanks straight')).toBeLessThan(html.indexOf('Groove bottom Ø50'));
    expect(html.indexOf('Groove bottom Ø50')).toBeLessThan(html.indexOf('outer diameter 60 mm'));
    expect(html).toContain('1 of 4 pass · 1 without an assertion · 1 not shown by a check');
    expect(html).toContain('Nothing in the check shows this item.');
    expect(html).toContain('section z=8: outer circle d50');
    expect(html).toContain('it states a force target (200 N)');
  });

  it('says who listed an item and which requirement, in what review state, stands behind it', () => {
    expect(originOf(report.items[0]!, report)).toBe('Listed by the agent');
    expect(originOf(report.items[1]!, report)).toBe(
      'Requirement “V-groove profile” · Must · draft when checked',
    );
    expect(originOf(report.items[3]!, report)).toBe(
      'Requirement “Belt load” · Should · approved when checked',
    );
    expect(originOf(report.items[0]!, { ...report, listedBy: 'person' })).toBe(
      'Listed by a person',
    );
    // A requirement row shown by assertions listed for it says who chose them.
    expect(originOf({ ...report.items[1]!, assertedBy: 'listed' }, report)).toBe(
      'Requirement “V-groove profile” · Must · draft when checked · asserted by the agent',
    );
    expect(originOf({ ...report.items[1]!, assertedBy: 'requirement' }, report)).toBe(
      'Requirement “V-groove profile” · Must · draft when checked',
    );
  });

  it('names requirements linked or changed after the check, without a report too', () => {
    const readiness: CadSpecReadiness = {
      counts: { items: 0, passed: 0, failed: 0, unasserted: 0, notShown: 0, blocking: 0 },
      missing: [],
      linkedSince: [
        { requirementId: 'a', revisionId: 'a1', title: 'Envelope', change: 'linked_after' },
        { requirementId: 'b', revisionId: 'b1', title: 'Mount', change: 'not_considered' },
      ],
      linkedSinceCount: 3,
      blocking: 3,
    };
    const html = render(undefined, readiness);
    expect(html).toContain(
      'Requirement “Envelope” was linked to this part after this check, so the check does not show it.',
    );
    expect(html).toContain('This check does not take requirement “Mount” into account.');
    expect(html).toContain('1 more requirement is not shown by this check as it stands.');
    expect(html).not.toContain('Listed items</span>');
    expect(
      sinceText({ requirementId: 'c', revisionId: 'c1', title: 'Groove', change: 'revised' }),
    ).toBe(
      'Requirement “Groove” changed after this check, so the check does not show it as it stands.',
    );
    expect(render()).toBe('');
  });

  it('says when changed requirements replaced committed assertions', () => {
    const html = render({
      ...report,
      replaced: ['"Groove bottom Ø50" from requirement "V-groove"'],
      checkChanges: [],
    });
    expect(html).toContain(
      'state committed values differently and replace them: &quot;Groove bottom Ø50&quot; from requirement &quot;V-groove&quot;. Accepting this scope accepts their values.',
    );
    expect(html).not.toContain('The check also changed the scope itself');
    const own = render({
      ...report,
      replaced: ['"Groove bottom Ø50" from requirement "V-groove"'],
      checkChanges: ['solid'],
    });
    expect(own).toContain('The check also changed the scope itself: solid.');
  });

  it('says when linked requirements disagree, so no check can run', () => {
    const html = render(undefined, {
      counts: { items: 0, passed: 0, failed: 0, unasserted: 0, notShown: 0, blocking: 0 },
      missing: [],
      linkedSince: [],
      linkedSinceCount: 0,
      blocking: 0,
      conflict: 'requirements “A” and “B” state different size for this part',
    });
    expect(html).toContain(
      'No check of this part can run: requirements “A” and “B” state different size for this part. A person must reconcile the requirements.',
    );
  });
});
