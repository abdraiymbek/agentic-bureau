import type { ForgeConfig } from '@electron-forge/shared-types';
import path from 'node:path';

/** Credentials remain in the macOS keychain; partial release setup fails closed. */
export function macSigningConfig(
  env: NodeJS.ProcessEnv,
  root: string,
): Pick<NonNullable<ForgeConfig['packagerConfig']>, 'osxSign' | 'osxNotarize'> {
  const identity = env.OMENFLOW_SIGNING_IDENTITY?.trim();
  const profile = env.OMENFLOW_NOTARIZE_PROFILE?.trim();
  if (!identity && !profile && env.OMENFLOW_RELEASE_SIGNED !== '1') return {};
  if (!identity || !profile) {
    throw new Error(
      'Signed releases require OMENFLOW_SIGNING_IDENTITY and OMENFLOW_NOTARIZE_PROFILE. Install the Developer ID certificate and store notarization credentials in the macOS keychain first.',
    );
  }
  return {
    osxSign: {
      identity,
      identityValidation: true,
      strictVerify: true,
      optionsForFile: () => ({
        hardenedRuntime: true,
        entitlements: path.join(root, 'entitlements.mac.plist'),
      }),
    },
    osxNotarize: { keychainProfile: profile },
  };
}
