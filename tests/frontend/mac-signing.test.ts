import { describe, expect, it } from 'vitest';
import { macSigningConfig } from '../../apps/desktop/signing.js';

describe('macOS release signing setup', () => {
  it('keeps ordinary contributor builds unsigned', () => {
    expect(macSigningConfig({}, '/app')).toEqual({});
  });
  it.each([
    { OMENFLOW_RELEASE_SIGNED: '1' },
    { OMENFLOW_SIGNING_IDENTITY: 'Developer ID Application: Test' },
    { OMENFLOW_NOTARIZE_PROFILE: 'omenflow' },
  ])('refuses partial credential setup instead of producing an unsigned release', (env) => {
    expect(() => macSigningConfig(env, '/app')).toThrow('Signed releases require');
  });
  it('uses validated signing, hardened runtime and a keychain notarization profile', () => {
    const config = macSigningConfig(
      {
        OMENFLOW_SIGNING_IDENTITY: 'Developer ID Application: Test',
        OMENFLOW_NOTARIZE_PROFILE: 'omenflow',
      },
      '/app',
    );
    expect(config.osxSign).toMatchObject({ identityValidation: true, strictVerify: true });
    if (!config.osxSign || config.osxSign === true) throw new Error('Missing signing options');
    expect(config.osxSign.optionsForFile?.('/app/helper')).toEqual({
      hardenedRuntime: true,
      entitlements: '/app/entitlements.mac.plist',
    });
    expect(config.osxNotarize).toEqual({ keychainProfile: 'omenflow' });
  });
});
