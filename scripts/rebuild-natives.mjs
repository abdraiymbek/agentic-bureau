#!/usr/bin/env node
/**
 * Rebuild native modules (better-sqlite3, node-pty) for the requested ABI.
 *   node scripts/rebuild-natives.mjs electron  → Electron ABI (dev app / packaging)
 *   node scripts/rebuild-natives.mjs node      → Node ABI (vitest, tsx scripts)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2] ?? 'node';

const natives = ['better-sqlite3', 'node-pty'];

function rebuildForNode() {
  for (const mod of natives) {
    const dir = path.join(root, 'node_modules', mod);
    if (!existsSync(dir)) {
      console.log(`skip ${mod} (not installed)`);
      continue;
    }
    console.log(`rebuild ${mod} for node ${process.version}`);
    execFileSync('npm', ['rebuild', mod, '--build-from-source'], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  }
}

function rebuildForElectron() {
  const electronPkg = path.join(root, 'node_modules', 'electron', 'package.json');
  if (!existsSync(electronPkg)) {
    console.error('electron not installed; run pnpm install in apps/desktop first');
    process.exit(1);
  }
  const version = JSON.parse(readFileSync(electronPkg, 'utf8')).version;
  console.log(`rebuild natives for electron ${version}`);
  execFileSync(
    process.platform === 'win32' ? 'electron-rebuild.cmd' : 'electron-rebuild',
    ['-f', '-w', natives.join(','), '-v', version],
    { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' },
  );
}

if (mode === 'electron') rebuildForElectron();
else rebuildForNode();
