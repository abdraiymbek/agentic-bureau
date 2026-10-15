#!/usr/bin/env node
/** Cross-platform build/dev entry for the production Rust desktop. */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'apps/rust-desktop');
const mode = process.argv[2];
if (!['build', 'dev'].includes(mode)) throw new Error('Expected build or dev');
const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run('pnpm', ['build:bridge']);
if (mode === 'build') run('pnpm', ['--filter', '@omenflow/desktop', 'build:rust-ui']);
const tauri = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tauri.cmd' : 'tauri',
);
const args = [mode === 'build' ? 'build' : 'dev'];
// macOS bundles are signed ad hoc (bundle.macOS.signingIdentity "-"): an unsigned bundle downloaded
// from the web is reported as damaged, while an ad hoc one can be opened with Open Anyway.
// `pnpm release:macos` replaces that signature with a Developer ID.
if (mode === 'build' && process.platform !== 'darwin') args.push('--no-sign');
if (process.platform === 'win32') args.push('--config', 'tauri.windows.conf.json');
// Anything after the mode goes to tauri, e.g. `pnpm make --bundles deb,rpm,appimage`.
args.push(...process.argv.slice(3));
const child = spawn(tauri, args, {
  cwd: desktop,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
