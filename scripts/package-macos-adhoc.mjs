#!/usr/bin/env node
/** Repackage a verified ad hoc app without changing its signed contents. */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (
  process.platform !== 'darwin' ||
  (args.length !== 0 && (args.length !== 2 || args[0] !== '--app' || !args[1]))
) {
  throw new Error('Run on macOS: package-macos-adhoc.mjs [--app path/to/Bureau.app]');
}
const source = realpathSync(
  path.resolve(args[1] ?? path.join(root, 'target/release/bundle/macos/Bureau.app')),
);
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const install = readFileSync(path.join(root, 'docs/macos-install.txt'));
const run = (command, commandArgs) =>
  execFileSync(command, commandArgs, { cwd: root, env: process.env, stdio: 'inherit' });
const output = (command, commandArgs) =>
  execFileSync(command, commandArgs, { cwd: root, encoding: 'utf8' }).trim();

function verifyApp(app) {
  const plist = path.join(app, 'Contents/Info.plist');
  if (
    output('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist]) !==
    'app.agenticbureau.desktop'
  ) {
    throw new Error('Expected the Bureau app bundle identifier');
  }
  for (const field of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    if (output('plutil', ['-extract', field, 'raw', '-o', '-', plist]) !== version) {
      throw new Error(`${field} does not match package.json version ${version}`);
    }
  }
  const executable = output('plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', plist]);
  if (!executable || path.basename(executable) !== executable) {
    throw new Error('Invalid CFBundleExecutable');
  }
  const helper = path.join(app, 'Contents/Resources/bureau');
  for (const code of [app, helper]) {
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', code]);
    // codesign writes signature details to stderr. Preserve existing Developer ID
    // signatures by refusing them here; release:macos owns that distribution path.
    const signature = spawnSync('codesign', ['--display', '--verbose=4', code], {
      cwd: root,
      encoding: 'utf8',
    });
    if (signature.error) throw signature.error;
    if (signature.status !== 0 || !/^Signature=adhoc$/m.test(signature.stderr)) {
      throw new Error(`Expected an existing valid ad hoc signature: ${code}`);
    }
  }
  return path.join(app, 'Contents/MacOS', executable);
}

/** Compare signed content as well as executable permissions and symlink targets. */
function tree(app) {
  const entries = [];
  function visit(relative) {
    const absolute = path.join(app, relative);
    const stat = lstatSync(absolute);
    const mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink()) entries.push([relative, 'link', readlinkSync(absolute)]);
    else if (stat.isDirectory()) {
      entries.push([relative, 'directory', mode]);
      for (const name of readdirSync(absolute).sort()) visit(path.join(relative, name));
    } else if (stat.isFile()) {
      entries.push([
        relative,
        'file',
        mode,
        createHash('sha256').update(readFileSync(absolute)).digest('hex'),
      ]);
    } else throw new Error(`Unsupported entry in app bundle: ${absolute}`);
  }
  visit('');
  return JSON.stringify(entries);
}

const executable = verifyApp(source);
const architecture = output('lipo', ['-archs', executable]);
const arch = { arm64: 'aarch64', x86_64: 'x86_64' }[architecture];
if (!arch) throw new Error(`Unsupported app architecture: ${architecture}`);
const original = tree(source);
const destination = path.join(root, `target/release/bundle/dmg/Bureau_${version}_${arch}.dmg`);
mkdirSync(path.dirname(destination), { recursive: true });
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'bureau-adhoc-')));
const partial = `${destination}.${process.pid}.partial`;
const mount = path.join(scratch, 'mounted');
let mounted = false;
try {
  const volume = path.join(scratch, 'volume');
  mkdirSync(volume);
  const staged = path.join(volume, 'Bureau.app');
  run('ditto', [source, staged]);
  if (tree(staged) !== original) throw new Error('Staging changed the app bundle');
  symlinkSync('/Applications', path.join(volume, 'Applications'));
  copyFileSync(path.join(root, 'docs/macos-install.txt'), path.join(volume, 'INSTALL.txt'));
  const dmg = path.join(scratch, 'Bureau.dmg');
  run('hdiutil', ['create', '-volname', 'Bureau', '-srcfolder', volume, '-format', 'UDZO', dmg]);
  run('hdiutil', ['verify', dmg]);
  mkdirSync(mount);
  try {
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]);
    mounted = true;
  } catch (error) {
    // A failed attachment may still have mounted its filesystem. Detach it in
    // finally rather than recursively cleaning a live mount point.
    mounted = lstatSync(mount).dev !== lstatSync(scratch).dev;
    throw error;
  }
  const packaged = realpathSync(path.join(mount, 'Bureau.app'));
  verifyApp(packaged);
  if (tree(packaged) !== original) throw new Error('The disk image changed the app bundle');
  if (!readFileSync(path.join(mount, 'INSTALL.txt')).equals(install)) {
    throw new Error('The disk image changed INSTALL.txt');
  }
  if (readlinkSync(path.join(mount, 'Applications')) !== '/Applications') {
    throw new Error('The disk image has an invalid Applications link');
  }
  run(process.execPath, [path.join(root, 'scripts/rust-packaged-smoke.mjs'), packaged]);
  if (tree(source) !== original || tree(packaged) !== original) {
    throw new Error('The app bundle changed during verification');
  }
  copyFileSync(dmg, partial);
  renameSync(partial, destination);
  console.log(`Verified ad hoc macOS package: ${destination}`);
  console.log('This package is not notarized. First launch requires the macOS Open Anyway action.');
} finally {
  rmSync(partial, { force: true });
  if (mounted) {
    try {
      run('hdiutil', ['detach', mount]);
      mounted = false;
    } catch {
      run('hdiutil', ['detach', '-force', mount]);
      mounted = false;
    }
  }
  if (!mounted) rmSync(scratch, { recursive: true, force: true });
}
