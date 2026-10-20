import { describe, expect, it } from 'vitest';
// Release tooling is a standalone Node module, also run directly by GitHub Actions.
// @ts-expect-error the standalone script deliberately has no runtime TypeScript dependency
import { mergeChecksums } from '../scripts/merge-checksums.mjs';

describe('release asset checksums', () => {
  it('replaces rebuilt assets and preserves packages for other architectures', () => {
    const old = `${'0'.repeat(64)}  linux-amd64.deb\n${'b'.repeat(64)}  macos-arm64.dmg\n`;
    const rebuilt = `${'f'.repeat(64)}  ./linux-amd64.deb\n${'a'.repeat(64)}  linux-amd64.rpm\n`;
    const result = mergeChecksums(old, rebuilt);
    expect(result).toContain(`${'f'.repeat(64)}  linux-amd64.deb\n`);
    expect(result).toContain(`${'a'.repeat(64)}  linux-amd64.rpm\n`);
    expect(result).toContain(`${'b'.repeat(64)}  macos-arm64.dmg\n`);
    expect(result).not.toContain('0'.repeat(64));
    expect(mergeChecksums(result, rebuilt)).toBe(result);
  });

  it('generates an initial manifest and refuses malformed records', () => {
    expect(mergeChecksums('', `${'a'.repeat(64)} *app.AppImage\n`)).toBe(
      `${'a'.repeat(64)}  app.AppImage\n`,
    );
    expect(() => mergeChecksums('not a checksum', '')).toThrow('Invalid SHA256SUMS');
  });
});
