import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { PartCard, purchaseUrl } from '../../apps/desktop/src/renderer/ui/PartCard';
const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

describe('sourced shopping lines', () => {
  it('renders the product image, name, reason, all seller prices and exact purchase destinations', () => {
    const html = renderToStaticMarkup(
      React.createElement(PartCard, {
        title: 'Sensor board',
        payload: {
          partNumber: 'S-1',
          manufacturer: 'Maker',
          imageUrl: 'https://cdn.adafruit.com/sensor.jpg',
          selectionReason: 'Reads room humidity over I2C.',
        },
        onFocus: () => {},
        offers: [
          {
            seller: 'Seller A',
            url: 'https://www.adafruit.com/product/4636?variant=one',
            price: { amount: '6.95', currency: 'USD' },
            quantityBasis: 1,
            observedAt: '2026-09-26T12:00:00Z',
          },
          {
            seller: 'Seller B',
            url: 'https://www.pololu.com/product/1',
            price: { amount: '12.00', currency: 'EUR' },
            quantityBasis: 2,
            observedAt: '2026-09-25T12:00:00Z',
          },
        ],
      }),
    );
    for (const value of [
      'Sensor board',
      'sensor.jpg',
      'Reads room humidity',
      '6.95 USD',
      '12.00 EUR',
      'Pack of 2',
      'variant=one',
      '2026-09-26',
    ])
      expect(html).toContain(value);
  });
  it('preserves missing facts and never makes a placeholder a purchase action', () => {
    const html = renderToStaticMarkup(
      React.createElement(PartCard, {
        title: 'Unknown part',
        payload: {},
        offers: [
          {
            seller: 'Example',
            url: 'https://example.com/product',
            price: null,
            quantityBasis: 1,
            observedAt: '2026-09-26',
          },
        ],
        onFocus: () => {},
      }),
    );
    expect(html).toContain('Price unknown');
    expect(html).toContain('Image not recorded');
    expect(html).toContain('Selection reason not recorded');
    expect(html).toContain('Purchase link needed');
    expect(html).not.toContain('href=');
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'not a URL',
      'https://example.com/product',
      'https://user:pass@shop.com/',
      'https://shop.invalid/item',
    ])
      expect(purchaseUrl(url)).toBeNull();
  });
});
