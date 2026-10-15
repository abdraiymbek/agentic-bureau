import crypto from 'node:crypto';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync(new URL('../../apps/desktop/index.html', import.meta.url), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';

/** Runs the bootstrap against a stand-in document and storage; returns the theme it set. */
function bootstrap(stored: string | null | Error) {
  const root = { dataset: {} as Record<string, string> };
  const storage = {
    getItem: () => {
      if (stored instanceof Error) throw stored;
      return stored;
    },
  };
  new Function('document', 'localStorage', inline[0]!)({ documentElement: root }, storage);
  return root.dataset.theme;
}

describe('theme before first paint', () => {
  it('has exactly one inline script, before the application script', () => {
    expect(inline).toHaveLength(1);
    expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('type="module"'));
    expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('<body>'));
  });

  it('is allowed by its hash and the policy allows nothing else inline', () => {
    const hash = crypto.createHash('sha256').update(inline[0]!, 'utf8').digest('base64');
    const scriptSrc = /script-src ([^;]+)/.exec(policy)?.[1] ?? '';
    expect(scriptSrc.split(/\s+/)).toContain(`'sha256-${hash}'`);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it('applies the stored preference the way the store reads it', () => {
    expect(bootstrap('light')).toBe('light');
    expect(bootstrap('dark')).toBe('dark');
    expect(bootstrap(null)).toBe('dark');
    expect(bootstrap('sepia')).toBe('dark');
    expect(bootstrap(new Error('storage blocked'))).toBe('dark');
  });
});
