#!/usr/bin/env node
/** Credential-gated public release: Forge signs/notarizes the app, then the DMG. */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const identity = process.env.OMENFLOW_SIGNING_IDENTITY?.trim();
const profile = process.env.OMENFLOW_NOTARIZE_PROFILE?.trim();
if (process.platform !== 'darwin' || !identity || !profile) {
  throw new Error(
    'Run on macOS with OMENFLOW_SIGNING_IDENTITY and OMENFLOW_NOTARIZE_PROFILE. See docs/release.md.',
  );
}
const run = (exe, args) =>
  execFileSync(exe, args, {
    cwd: root,
    env: { ...process.env, OMENFLOW_RELEASE_SIGNED: '1' },
    stdio: 'inherit',
  });
run('pnpm', ['make']);
const app = path.join(
  root,
  'apps/desktop/out',
  `Omen Flow-darwin-${process.arch}`,
  'Omen Flow.app',
);
const dmg = path.join(root, 'apps/desktop/out/make/Omen Flow.dmg');
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
run('xcrun', ['stapler', 'validate', app]);
run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
run(process.execPath, [path.join(root, 'scripts/packaged-smoke.mjs'), app, '--cad']);
run('codesign', ['--force', '--sign', identity, '--timestamp', dmg]);
run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', profile, '--wait']);
run('xcrun', ['stapler', 'staple', dmg]);
run('xcrun', ['stapler', 'validate', dmg]);
run('codesign', ['--verify', '--strict', '--verbose=2', dmg]);
run('spctl', [
  '--assess',
  '--type',
  'open',
  '--context',
  'context:primary-signature',
  '--verbose=2',
  dmg,
]);
console.log(`Signed and notarized artifacts validated: ${app}\n${dmg}`);
