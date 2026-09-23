#!/usr/bin/env node
/** Sign the Rust/Tauri app, notarize and staple it, then package the DMG. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
const dmg = path.join(root, 'target/release/bundle/dmg/Omen Flow_0.1.0_aarch64.dmg');
const scratch = mkdtempSync(path.join(tmpdir(), 'omenflow-notary-'));
try {
  run('codesign', [
    '--force',
    '--deep',
    '--options',
    'runtime',
    '--timestamp',
    '--sign',
    identity,
    app,
  ]);
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const archive = path.join(scratch, 'Omen Flow.zip');
  run('ditto', ['-c', '-k', '--keepParent', app, archive]);
  run('xcrun', ['notarytool', 'submit', archive, '--keychain-profile', profile, '--wait']);
  run('xcrun', ['stapler', 'staple', app]);
  run('xcrun', ['stapler', 'validate', app]);
  run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  run(process.execPath, [path.join(root, 'scripts/rust-packaged-smoke.mjs'), app]);
  mkdirSync(path.dirname(dmg), { recursive: true });
  run('hdiutil', [
    'create',
    '-volname',
    'Omen Flow',
    '-srcfolder',
    app,
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
