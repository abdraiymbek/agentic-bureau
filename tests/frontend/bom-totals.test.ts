import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  alternativesPrompt,
  bomTotalsView,
  compareLabel,
  compareValues,
  formatMass,
  lineMass,
  massUnitFor,
  partGroup,
  type Bom,
  type BomLineView,
} from '../../apps/desktop/src/renderer/project/parts';
import {
  ProductImage,
  imageSource,
  observedDate,
  purchaseUrl,
} from '../../apps/desktop/src/renderer/ui/PartCard';

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function line(n: number, over: Partial<BomLineView> = {}): BomLineView {
  return {
    line: { id: `l${n}`, componentArtifactId: `c${n}`, subsystem: null, quantity: 1, notes: '' },
    componentTitle: `Part ${n}`,
    partNumber: `PN-${n}`,
    manufacturer: 'Maker',
    offer: {
      seller: 'Seller',
      url: 'https://shop.com/p',
      price: { amount: '1.00', currency: 'USD' },
      quantityBasis: 1,
      observedAt: '2026-10-13T12:00:00Z',
    },
    unitMass: { value: 0.01, unit: 'kg' },
    lineTotal: { amount: '1.00', currency: 'USD' },
    ...over,
  };
}

function bom(lines: BomLineView[], totals: Partial<Bom['totals']> = {}): Bom {
  return {
    lines,
    totals: {
      cost: [{ amount: '3.00', currency: 'USD' }],
      missingPriceCount: 0,
      knownMass: { value: 0.03, unit: 'kg' },
      missingMassCount: 0,
      lineCount: lines.length,
      ...totals,
    },
  };
}

describe('bill of materials totals', () => {
  it('reports the host’s known totals and no unknowns when everything is known', () => {
    const t = bomTotalsView(bom([line(1), line(2), line(3)]));
    expect(t.cost).toEqual([{ amount: '3.00', currency: 'USD' }]);
    expect(t.mass).toEqual({ value: 0.03, unit: 'kg' });
    expect(t.lines).toBe(3);
    expect(t.priceUnknown).toEqual([]);
    expect(t.massUnknown).toEqual([]);
  });

  it('labels each excluded line from the line data when the host lists none', () => {
    const t = bomTotalsView(
      bom(
        [
          line(1, { offer: null, lineTotal: null }),
          line(2, {
            offer: { ...line(2).offer!, price: null },
            lineTotal: null,
            unitMass: null,
            massUnknownReason: 'mass: not on the product page',
          }),
          line(3),
        ],
        { missingPriceCount: 2, missingMassCount: 1, knownMass: { value: 0.02, unit: 'kg' } },
      ),
    );
    expect(t.priceUnknown).toEqual([
      { lineId: 'l1', componentTitle: 'Part 1', reason: 'no offer chosen' },
      { lineId: 'l2', componentTitle: 'Part 2', reason: 'the offer has no price' },
    ]);
    expect(t.massUnknown).toEqual([
      { lineId: 'l2', componentTitle: 'Part 2', reason: 'mass: not on the product page' },
    ]);
    expect(t.priceUnknownUnlisted).toBe(0);
    expect(t.massUnknownUnlisted).toBe(0);
  });

  it('prefers the host’s lists and counts unknowns it did not identify', () => {
    const t = bomTotalsView({
      ...bom([line(1), line(2)], {
        missingMassCount: 2,
        unknownMass: [{ lineId: 'l2', componentTitle: 'Part 2', reason: "Unknown unit 'stone'" }],
        cost: [
          { amount: '2.00', currency: 'USD' },
          { amount: '5.00', currency: 'EUR' },
        ],
      }),
      replacedLines: [{}, {}],
    });
    expect(t.massUnknown).toEqual([
      { lineId: 'l2', componentTitle: 'Part 2', reason: "Unknown unit 'stone'" },
    ]);
    expect(t.massUnknownUnlisted).toBe(1);
    expect(t.cost.map((m) => m.currency)).toEqual(['USD', 'EUR']);
    expect(t.replaced).toBe(2);
  });

  it('keeps an unknown mass unknown and reads masses in one column unit', () => {
    expect(lineMass(line(1, { unitMass: null }))).toBeNull();
    expect(lineMass(line(1, { line: { ...line(1).line, quantity: 4 } }))).toEqual({
      value: 0.04,
      unit: 'kg',
    });
    expect(massUnitFor({ value: 0.0795, unit: 'kg' })).toBe('g');
    expect(massUnitFor({ value: 1500, unit: 'g' })).toBe('kg');
    expect(massUnitFor({ value: 3, unit: 'stone' })).toBeNull();
    expect(massUnitFor(null)).toBeNull();
    expect(formatMass({ value: 0.0795, unit: 'kg' }, 'g')).toBe('79.5 g');
    expect(formatMass({ value: 15, unit: 'stone' }, 'g')).toBe('15 stone');
    expect(formatMass(null, 'g')).toBeNull();
  });
});

describe('component comparison', () => {
  it('names differences in words, across units, with unknowns counted', () => {
    const kg = (value: number) => ({ value, unit: 'kg' });
    expect(compareValues([kg(0.0095), { value: 9.5, unit: 'g' }])).toEqual({
      verdict: 'same',
      unknown: 0,
    });
    expect(compareValues([kg(0.0095), kg(0.0012)]).verdict).toBe('differs');
    expect(compareValues([kg(1), { value: 1, unit: 'V' }]).verdict).toBe('units-differ');
    const partly = compareValues([kg(1), kg(1), null]);
    expect(compareLabel(partly, 3)).toBe('Same where known · 1 of 3 unknown');
    const single = compareValues([null, { unknown: true, reason: 'n/a' }, kg(2)]);
    expect(compareLabel(single, 3)).toBe('Recorded for 1 of 3');
    expect(compareLabel(compareValues([null, null]), 2)).toBe('Not recorded for any');
    expect(compareLabel(compareValues([kg(1), kg(2), null]), 3)).toBe('Differs · 1 of 3 unknown');
  });

  it('groups parts as candidates, selected or set aside', () => {
    expect(partGroup(undefined)).toBe('candidate');
    expect(partGroup('candidate')).toBe('candidate');
    expect(partGroup('selected')).toBe('selected');
    expect(partGroup('rejected')).toBe('set-aside');
    expect(partGroup('superseded')).toBe('set-aside');
  });

  it('drafts a precise request for alternatives that changes nothing', () => {
    const prompt = alternativesPrompt({
      id: 'c1',
      title: 'Wheel motor',
      manufacturer: 'Pololu',
      partNumber: 'POLOLU-2212',
      reason: 'Torque margin on ramps.',
    });
    expect(prompt).toContain('Component Wheel motor (artifact c1), Pololu POLOLU-2212.');
    expect(prompt).toContain('It was chosen because: Torque margin on ramps.');
    expect(prompt).toContain('Do not select or propose any of them.');
  });
});

describe('product images and purchase links', () => {
  it('loads images only over https and labels everything else', () => {
    expect(imageSource('https://cdn.shop.com/a.jpg')).toEqual({
      src: 'https://cdn.shop.com/a.jpg',
    });
    expect(imageSource('http://cdn.shop.com/a.jpg')).toEqual({
      refused: 'Image not loaded: insecure address',
    });
    expect(imageSource('javascript:alert(1)')).toBeNull();
    const http = renderToStaticMarkup(
      React.createElement(ProductImage, { url: 'http://cdn.shop.com/a.jpg', name: 'Part' }),
    );
    expect(http).toContain('Image not loaded: insecure address');
    expect(http).not.toContain('<img');
    const https = renderToStaticMarkup(
      React.createElement(ProductImage, { url: 'https://cdn.shop.com/a.jpg', name: 'Part' }),
    );
    // The placeholder holds the box until the image has loaded.
    expect(https).toContain('part-photo-placeholder');
    expect(https).toContain('<img');
    const thumb = renderToStaticMarkup(
      React.createElement(ProductImage, { name: 'Part', size: 'thumb' }),
    );
    expect(thumb).toContain('part-photo-thumb');
    expect(thumb).toContain('Image not recorded');
  });

  it('offers purchase links only for real seller addresses', () => {
    expect(purchaseUrl('https://www.pololu.com/product/2212')).toBe(
      'https://www.pololu.com/product/2212',
    );
    for (const url of [
      'https://192.168.1.10/item',
      'https://[::1]/item',
      'https://intranet/item',
      'https://shop.internal/item',
      'ftp://shop.com/item',
    ])
      expect(purchaseUrl(url)).toBeNull();
  });

  it('shows the local date of an observation, or the recorded text', () => {
    expect(observedDate('2026-10-13T12:00:00Z')).toMatch(/2026/);
    expect(observedDate('last week')).toBe('last week');
  });
});
