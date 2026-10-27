import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { ArtifactView, ArtifactType, Revision } from '@bureau/contracts';
import { validatePayload } from '@bureau/contracts';
import payloads from '../fixtures/artifact-payloads.json';
import { displayedMechanicalRevision } from '../../apps/desktop/src/renderer/lib/mechanical-revisions';

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
vi.mock('../../apps/desktop/src/renderer/object/MechanicalStage', () => ({
  MechanicalStage: () => null,
}));
// Sanitization is exercised in the browser walkthrough; SSR has no DOM implementation.
vi.mock('dompurify', () => ({ default: { sanitize: (s: string) => s } }));
import { ObjectStage } from '../../apps/desktop/src/renderer/object/stages';
import { webUrl } from '../../apps/desktop/src/renderer/ui/ExternalLink';

function view(type: ArtifactType, payload: unknown = payloads[type]): ArtifactView {
  const revision = {
    id: 'draft',
    artifactId: type,
    seq: 1,
    parentId: null,
    payload: validatePayload(type, payload),
    reviewState: 'draft',
    files: [],
    inputs: [],
  } as unknown as Revision;
  return {
    artifact: { id: type, type, title: `Draft ${type}`, selectedRevisionId: null },
    revision,
    freshness: 'current',
    staleReasons: [],
    draftCount: 1,
    pendingProposal: false,
  } as ArtifactView;
}
function render(type: ArtifactType, payload?: unknown) {
  return renderToStaticMarkup(React.createElement(ObjectStage, { view: view(type, payload) }));
}

describe('structured draft stages', () => {
  it.each([
    [
      'requirement',
      ['The controller shall', 'value="12"', 'Operate throughout', 'Bench supply test'],
    ],
    [
      'assumption',
      [
        'Ambient temperature',
        'Indoor use',
        'Project owner',
        'Summer peak unmeasured',
        'Site survey pending',
      ],
    ],
    ['architecture', ['Power distribution', '<svg']],
    ['concept', ['modular inspection', '300 mm', 'Fixed sensor mast', 'Payload envelope pending']],
    ['component', ['CTRL-12', 'Example manufacturer', '12 V', 'Not published', 'UART']],
    [
      'source',
      ['Input rating is 12 V.', 'https://example.com/controller', 'Electrical characteristics'],
    ],
    [
      'wiring',
      [
        'Supply input',
        '10 V',
        '14 V',
        'DC supply',
        '22 AWG',
        'Confirm fuse sizing',
        'protection design pending',
      ],
    ],
    [
      'calculation',
      ['24 W', 'Nominal input power', 'voltage', '12 V', '2 A', 'Startup transient excluded'],
    ],
    ['software', ['Python', 'controller.py', 'Poll the controller']],
    ['assembly', ['Mount the controller', 'Hex key', 'Check alignment']],
    [
      'test',
      ['Set the supply', 'Controller starts', 'Bench test pending', 'No hardware available'],
    ],
    ['note', ['Confirm connector orientation']],
    ['subsystem', ['Power conversion and distribution']],
  ] as [ArtifactType, string[]][])('%s shows recorded content', (type, expected) => {
    const html = render(type);
    for (const text of expected) expect(html).toContain(text);
  });
  it('shows text-only calculation results', () => {
    expect(render('calculation', { result: { text: 'Insufficient input data' } })).toContain(
      'Insufficient input data',
    );
  });
  it('keeps nonstandard recorded target units in the input selector', () => {
    expect(
      render('requirement', { ...payloads.requirement, target: { value: 4, unit: 'm/s' } }),
    ).toContain('<option value="m/s" selected="">m/s</option>');
  });
  it('does not let a displayed draft invoke baseline edit controls', () => {
    expect(render('requirement')).toContain('<fieldset disabled=""');
    expect(render('note')).toMatch(/disabled=""[^>]*><span[^>]*>Edit text/);
  });
  it.each(Object.keys(payloads) as ArtifactType[])(
    '%s selects active drafts without substituting rejected work',
    (type) => {
      const draft = view(type).revision!;
      const rejected = { ...draft, id: 'rejected', seq: 2, reviewState: 'rejected' as const };
      expect(displayedMechanicalRevision([draft, rejected], null, null)?.id).toBe('draft');
      expect(displayedMechanicalRevision([rejected], null, null)).toBeNull();
    },
  );
  it('opens only recorded HTTP destinations', () => {
    expect(webUrl('https://example.com/part?id=12')).toBe('https://example.com/part?id=12');
    for (const url of [
      undefined,
      '',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,hello',
    ])
      expect(webUrl(url)).toBeNull();
  });
});

function baselineView(type: ArtifactType, payload: unknown = payloads[type]): ArtifactView {
  const draft = view(type, payload);
  return {
    ...draft,
    artifact: { ...draft.artifact, selectedRevisionId: 'draft' },
    revision: { ...draft.revision!, reviewState: 'approved' },
    draftCount: 0,
  } as ArtifactView;
}
const renderView = (v: ArtifactView) =>
  renderToStaticMarkup(React.createElement(ObjectStage, { view: v }));

describe('the revision on screen decides what a stage offers', () => {
  it.each((Object.keys(payloads) as ArtifactType[]).filter((type) => type !== 'mechanical'))(
    '%s draft can be accepted as the baseline, with the consequence stated',
    (type) => {
      const html = render(type);
      expect(html).toContain('r1 is a draft.');
      expect(html).toContain('Nothing is approved for this object yet.');
      expect(html).toContain('Accept as baseline');
      expect(html).toContain('marks what depends on it out of date');
    },
  );
  it('says why a draft cannot be edited in place', () => {
    for (const type of ['requirement', 'assumption', 'note'] as ArtifactType[])
      expect(render(type)).toContain('This is a draft. Accept it as the baseline to edit it here');
  });
  it('offers editing on the baseline, with no banner', () => {
    const html = renderView(baselineView('requirement'));
    expect(html).not.toContain('Accept as baseline');
    expect(html).toContain('<fieldset class="bare stage-fields">');
    expect(html).toContain('Recorded in this revision');
    expect(renderView(baselineView('note'))).not.toMatch(/disabled=""[^>]*><span[^>]*>Edit text/);
  });
  it('labels history as history and keeps it read-only', () => {
    const baseline = baselineView('requirement');
    const old = {
      ...baseline,
      artifact: { ...baseline.artifact, selectedRevisionId: 'newer' },
      revision: { ...baseline.revision!, reviewState: 'superseded' as const },
    } as ArtifactView;
    const html = renderView(old);
    expect(html).toContain('r1 is history · Superseded.');
    expect(html).toContain('<fieldset disabled=""');
    expect(html).not.toContain('Accept as baseline');
  });
  it('shows a recorded target band and keeps trace impact available on a draft', () => {
    const html = render('requirement', {
      ...payloads.requirement,
      target: { value: 12, unit: 'V', min: 11.5, max: 12.6 },
    });
    expect(html).toContain('aria-label="Band minimum"');
    expect(html).toMatch(/value="11.5"/);
    expect(html).toMatch(/value="12.6"/);
    // Tracing reads the record; a draft does not switch it off.
    expect(html).toMatch(
      /<button type="button" class="btn btn-ghost btn-sm"><span[^>]*>Trace impact/,
    );
  });
  it('keeps the reason of an unknown target and never shows it as a number', () => {
    const html = render('requirement', {
      ...payloads.requirement,
      target: { unknown: true, reason: 'Supply not chosen' },
    });
    expect(html).toContain('value="Supply not chosen"');
    expect(html).toContain('placeholder="Unknown"');
    expect(html).not.toContain('aria-label="Band minimum"');
  });
  it('shows a recorded unknown target as unknown even without a reason', () => {
    const html = render('requirement', {
      ...payloads.requirement,
      target: { unknown: true, reason: '' },
    });
    expect(html).toContain('placeholder="Unknown"');
    expect(html).toMatch(/<input type="checkbox"[^>]* checked=""/);
    expect(html).toContain('The target is unknown');
    const none = render('requirement', { ...payloads.requirement, target: undefined });
    expect(none).toContain('placeholder="—"');
    expect(none).toContain('The target is unknown');
    expect(none).not.toMatch(/<input type="checkbox"[^>]* checked=""/);
  });
  it('lets a result be recorded on a test that has no baseline yet', () => {
    const html = render('test');
    expect(html).toContain('<fieldset class="bare stack">');
    expect(html).toContain('Recording adds a revision that carries this result.');
  });
  it('keeps a bound recorded on one side of a calculation result and its inputs', () => {
    const html = render('calculation', {
      expression: 'm * 2',
      inputs: [{ name: 'm', quantity: { value: 0.15, unit: 'kg', min: 0.1 }, literal: true }],
      result: { quantity: { value: 0.3, unit: 'kg', max: 0.35 } },
    });
    expect(html).toContain('0.3 kg (max 0.35)');
    expect(html).toContain('0.15 kg (min 0.1)');
  });
  it('names the source and pin state of every calculation input', () => {
    const html = render('calculation');
    expect(html).toMatch(/Literal value, no source|No source recorded|Unavailable ·/);
  });
});
