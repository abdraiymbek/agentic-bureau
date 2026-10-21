import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InlinePayloadReview } from '../../apps/desktop/src/renderer/chat/InlinePayloadReview';
const render = (before: unknown, proposed: unknown) =>
  renderToStaticMarkup(React.createElement(InlinePayloadReview, { before, proposed }));
const input = {
  name: 'measured_mass',
  quantity: { value: 1.25, unit: 'kg' },
  source: 'Load-cell observation Ω',
};

describe('complete in-chat proposal payload review', () => {
  it('shows quantities and supporting facts of an added complex input in the proposed column', () => {
    const html = render({ inputs: [] }, { inputs: [input] });
    expect(html).toContain('1.25 kg');
    expect(html).toContain('Load-cell observation Ω');
    expect(html).toMatch(/<td>Not previously recorded<\/td><td><dl[\s\S]*1.25 kg/);
  });
  it('shows removed complex inputs in the before column rather than hiding their contents', () => {
    const html = render({ inputs: [input] }, { inputs: [] });
    expect(html).toMatch(/<td><dl[\s\S]*1.25 kg[\s\S]*<\/dl><\/td><td>Removed<\/td>/);
  });
  it('preserves wiring endpoints, connection units, unknown reasons and exact payloads', () => {
    const proposed = {
      connections: [
        {
          name: 'drive',
          from: { pin: 'M1' },
          to: { pin: 'A1' },
          voltage: { value: 12.000000001, unit: 'V' },
          current: { unknown: true, reason: '測定待ち Ω' },
        },
      ],
    };
    const html = render({ connections: [] }, proposed);
    expect(html).toContain('M1');
    expect(html).toContain('A1');
    expect(html).toContain('測定待ち Ω');
    expect(html).toContain('12.000000001');
    expect(html).toContain('Exact before payload');
    expect(html).toContain('Exact proposed payload');
    expect(html).toContain('&quot;unit&quot;: &quot;V&quot;');
  });
  it('keeps scalar changes readable and escapes program-like recorded text', () => {
    const html = render(
      { target: { value: 1.25, unit: 'kg' } },
      { target: { value: 2, unit: 'kg' }, markdown: '<script>danger()</script>' },
    );
    expect(html).toContain('1.25 kg');
    expect(html).toContain('2 kg');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;danger()&lt;/script&gt;');
  });
  it('keeps mechanical values primary and complete render provenance in counted disclosures', () => {
    const proposed = {
      params: { width: { value: 24.0000001, unit: 'mm' } },
      material: 'PETG',
      modelUnit: 'mm',
      scad: { path: 'part.scad', sha256: 'exact-source-hash' },
      renderIdentity: { inputFingerprint: 'exact-input-fingerprint' },
      paramManifest: [{ name: 'width', unit: 'mm' }],
    };
    const html = renderToStaticMarkup(
      React.createElement(InlinePayloadReview, { proposed, before: {}, mechanical: true }),
    );
    const primary = html.split('<details')[0]!;
    expect(primary).toContain('24');
    expect(primary).toContain('PETG');
    expect(primary).toContain('mm');
    expect(primary).not.toContain('exact-source-hash');
    expect(primary).not.toContain('exact-input-fingerprint');
    expect(html).toContain('Parameter definitions changed');
    expect(html).toContain('Recorded files &amp; render provenance');
    expect(html).toContain('exact-source-hash');
    expect(html).toContain('exact-input-fingerprint');
    expect(html).toContain('24.0000001');
    expect(render({}, proposed).split('<details')[0]).toContain('exact-source-hash');
  });
});
