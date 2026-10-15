import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { ArtifactType } from '@omenflow/contracts';
import { validatePayload } from '@omenflow/contracts';
import payloads from '../fixtures/artifact-payloads.json';
import { diffPayload } from '../../apps/desktop/src/renderer/lib/diff';

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
// Sanitization is exercised in the browser; SSR has no DOM implementation.
vi.mock('dompurify', () => ({ default: { sanitize: (s: string) => s } }));
import { ArtifactContent } from '../../apps/desktop/src/renderer/decide/ArtifactContent';
import { PayloadDiff } from '../../apps/desktop/src/renderer/decide/PayloadDiff';

const html = (type: ArtifactType) =>
  renderToStaticMarkup(
    React.createElement(ArtifactContent, {
      type,
      payload: validatePayload(type, payloads[type as keyof typeof payloads]),
    }),
  ).replace(/<!-- -->/g, '');

describe('a new object is reviewed as its complete content', () => {
  it.each([
    [
      'requirement',
      [
        'The controller shall operate from a 12 V supply.',
        '12 V',
        'Must',
        'Operate throughout the stated supply range.',
        'Bench supply test',
      ],
    ],
    [
      'assumption',
      [
        'not an established fact',
        'Ambient temperature stays below 40 °C.',
        'Unknown — Site survey pending',
        'Indoor use',
        'Summer peak unmeasured',
        'Project owner',
      ],
    ],
    [
      'component',
      [
        'CTRL-12',
        'Example manufacturer',
        'Example supplier',
        '12 V',
        'Unknown — Not published',
        'UART',
        'Illustrative controller for regression testing',
      ],
    ],
    [
      'source',
      [
        'Input rating is 12 V.',
        'Illustrative controller data',
        'Example manufacturer',
        'datasheet',
        'Electrical characteristics',
        'https://example.com/controller',
      ],
    ],
    [
      'calculation',
      [
        '24 W',
        'Nominal input power',
        'voltage * current',
        'voltage',
        '12 V',
        'current',
        '2 A',
        'Steady state',
        'Startup transient excluded',
      ],
    ],
    [
      'test',
      [
        'Set the supply to 12 V.',
        'Expected: Controller starts',
        'Room temperature',
        'Not run',
        'Bench test pending',
      ],
    ],
    ['wiring', ['VIN', 'Supply input', 'power', '10 V – 14 V']],
    [
      'assembly',
      [
        'Mount the controller using spacers.',
        'Tools: Hex key',
        'Calibration: Check alignment before tightening',
      ],
    ],
    ['architecture', ['Power distribution', '<svg']],
    ['note', ['Open questions', 'Confirm connector orientation.']],
    [
      'concept',
      [
        'A modular inspection platform.',
        'Power and sensing',
        '300 mm',
        'Fixed sensor mast',
        'Payload envelope pending',
      ],
    ],
    ['subsystem', ['Power conversion and distribution.']],
    [
      'software',
      ['Python', 'controller.py', 'Poll the controller over UART.', 'software/controller.py'],
    ],
  ] as [ArtifactType, string[]][])('%s', (type, expected) => {
    const out = html(type);
    for (const text of expected) expect(out).toContain(text);
    expect(out).not.toContain('{&quot;');
  });

  it('says plainly what was not recorded instead of leaving gaps', () => {
    const out = renderToStaticMarkup(
      React.createElement(ArtifactContent, {
        type: 'requirement',
        payload: { statement: 'Carry 0.3 kg', acceptanceCriterion: '', priority: 'should' },
      }),
    );
    expect(out).toContain('Not recorded');
  });
});

describe('diff rendering', () => {
  const render = (from: unknown, to: unknown) =>
    renderToStaticMarkup(
      React.createElement(PayloadDiff, { entries: diffPayload(from, to) }),
    ).replace(/<!-- -->/g, '');

  it('puts a short change on one row, old struck and new marked, with words for assistive tech', () => {
    const out = render(
      { target: { value: 0.3, unit: 'kg' } },
      { target: { value: 0.5, unit: 'kg' } },
    );
    expect(out).toContain('class="diff-row"');
    expect(out).toMatch(
      /<del class="diff-from"><span class="sr-only">was <\/span><span class="review-qty">0.3 kg<\/span><\/del>/,
    );
    expect(out).toMatch(
      /<ins class="diff-to"><span class="sr-only">now <\/span><span class="review-qty">0.5 kg<\/span><\/ins>/,
    );
  });

  it('stacks long text with a line diff instead of squeezing it into a column', () => {
    const before = `${'The tray shall stay seated through ten minutes of vibration testing. '.repeat(2)}`;
    const out = render({ statement: before }, { statement: before.replace('ten', 'twenty') });
    expect(out).toContain('diff-row stacked');
    expect(out).toContain('line-diff line-diff-prose');
    expect(out).toContain('<mark>twenty</mark>');
    expect(out).toContain('<mark>ten</mark>');
  });

  it('shows a removed list item whole, with its fields', () => {
    const out = render(
      { inputs: [{ name: 'payload_mass', quantity: { value: 0.3, unit: 'kg' } }] },
      { inputs: [] },
    );
    expect(out).toContain('Removed');
    expect(out).toContain('payload_mass');
    expect(out).toContain('0.3 kg');
  });

  it('says when nothing in the recorded content changed', () => {
    expect(
      renderToStaticMarkup(
        React.createElement(PayloadDiff, {
          entries: [],
          empty: 'No field changes in the recorded content.',
        }),
      ),
    ).toContain('No field changes in the recorded content.');
  });
});
