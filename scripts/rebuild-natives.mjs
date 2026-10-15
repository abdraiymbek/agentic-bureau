#!/usr/bin/env node
/**
 * Build node-pty from source for the running Node (vitest, tsx scripts).
 *
 * Needed after a clean install on macOS: the prebuilt spawn-helper is unpacked
 * without its executable bit, so every PTY spawn fails with "posix_spawnp
 * failed" until the module is compiled locally. better-sqlite3 ships N-API
 * prebuilds that load as installed and has nothing to rebuild.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mod = 'node-pty';

if (existsSync(path.join(root, 'node_modules', mod))) {
  console.log(`rebuild ${mod} for node ${process.version}`);
  execFileSync('npm', ['rebuild', mod, '--build-from-source'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
} else {
  console.log(`skip ${mod} (not installed)`);
}
