#!/usr/bin/env node
/** Sign the Rust/Tauri app, notarize and staple it, then package the DMG. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const run = (exe, args, cwd = root) =>
  execFileSync(exe, args, { cwd, env: process.env, stdio: 'inherit' });
run('pnpm', ['build:bridge']);
run('pnpm', ['--filter', '@omenflow/desktop', 'build:rust-ui']);
const rust = path.join(root, 'apps/rust-desktop');
run(path.join(root, 'node_modules/.bin/tauri'), ['build', '--bundles', 'app', '--no-sign'], rust);
const app = path.join(root, 'target/release/bundle/macos/Omen Flow.app');
const helper = path.join(app, 'Contents/Resources/omenflow');
const { version } = JSON.parse(readFileSync(path.join(rust, 'tauri.conf.json'), 'utf8'));
const arch = process.arch === 'arm64' ? 'aarch64' : process.arch;
const dmg = path.join(root, `target/release/bundle/dmg/Omen Flow_${version}_${arch}.dmg`);
const scratch = mkdtempSync(path.join(tmpdir(), 'omenflow-notary-'));
try {
  // Inside out: notarization rejects any Mach-O without a Developer ID signature, and
  // `--deep` does not sign executables shipped as resources, such as the helper.
  for (const code of [helper, app]) {
    run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, code]);
  }
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const archive = path.join(scratch, 'Omen Flow.zip');
  run('ditto', ['-c', '-k', '--keepParent', app, archive]);
  run('xcrun', ['notarytool', 'submit', archive, '--keychain-profile', profile, '--wait']);
  run('xcrun', ['stapler', 'staple', app]);
  run('xcrun', ['stapler', 'validate', app]);
  run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  run(process.execPath, [path.join(root, 'scripts/rust-packaged-smoke.mjs'), app]);
  mkdirSync(path.dirname(dmg), { recursive: true });
  // The volume holds the stapled app and a link to /Applications to drag it onto.
  const volume = path.join(scratch, 'volume');
  mkdirSync(volume);
  run('ditto', [app, path.join(volume, 'Omen Flow.app')]);
  symlinkSync('/Applications', path.join(volume, 'Applications'));
  run('hdiutil', [
    'create',
    '-volname',
    'Omen Flow',
    '-srcfolder',
    volume,
    '-ov',
    '-format',
    'UDZO',
    dmg,
  ]);
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
  console.log(`Signed and notarized Rust artifacts validated: ${app}\n${dmg}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
