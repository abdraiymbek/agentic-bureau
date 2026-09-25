import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { ArtifactView, ArtifactType, Revision } from '@omenflow/contracts';
import { validatePayload } from '@omenflow/contracts';
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
