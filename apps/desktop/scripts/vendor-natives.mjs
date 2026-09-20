/**
 * Vendor Electron-ABI native deps + their dependency closure into
 * resources/node_modules.
 *
 * pnpm hoists Node-ABI builds into the shared store; the utility process runs
 * under Electron's ABI, so we copy the packages (dereferenced) and rebuild
 * the native ones against Electron. Runs in dev (`pnpm start`) and packaging
 * (forge prePackage hook). Vitest keeps using the node-ABI workspace copies.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // apps/desktop
const appRequire = createRequire(path.join(root, 'package.json'));
const vendorDir = path.join(root, 'resources', 'node_modules');
// Externalized in vite.utility.config.ts / loaded by calc-worker.mjs.
const roots = ['better-sqlite3', 'node-pty', 'mathjs', 'ajv', 'ajv-formats'];
const natives = ['better-sqlite3', 'node-pty'];

fs.mkdirSync(vendorDir, { recursive: true });
fs.writeFileSync(
  path.join(root, 'resources', 'package.json'),
  JSON.stringify(
    {
      name: 'omenflow-runtime',
      private: true,
      dependencies: Object.fromEntries(roots.map((m) => [m, '*'])),
    },
    null,
    2,
  ),
);

// Copy each root + its transitive dependency closure.
const queue = roots.map((name) => ({ name, from: appRequire }));
const seen = new Set();
while (queue.length) {
  const { name, from } = queue.shift();
  const top = name
    .split('/')
    .slice(0, name.startsWith('@') ? 2 : 1)
    .join('/');
  if (seen.has(top)) continue;
  let pkgJsonPath;
  try {
    pkgJsonPath = from.resolve(`${top}/package.json`);
  } catch {
    console.warn(`[vendor-natives] skipping unresolvable dep ${top}`);
    continue;
  }
  seen.add(top);
  const src = fs.realpathSync(path.dirname(pkgJsonPath));
  const dest = path.join(vendorDir, top);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true });
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const depReq = createRequire(pkgJsonPath);
  for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push({ name: dep, from: depReq });
}

// Rebuild native modules against the Electron runtime ABI.
const electronPkg = JSON.parse(
  fs.readFileSync(appRequire.resolve('electron/package.json'), 'utf8'),
);
const rebuildMain = fs.realpathSync(appRequire.resolve('@electron/rebuild'));
execFileSync(
  process.execPath,
  [
    path.join(path.dirname(rebuildMain), 'cli.js'),
    '--force',
    '--module-dir',
    path.join(root, 'resources'),
    '--only',
    natives.join(','),
    '--version',
    electronPkg.version,
  ],
  { stdio: 'inherit', cwd: root },
);

// node-pty's spawn-helper must be executable.
for (const rel of [
  'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper',
  'node_modules/node-pty/prebuilds/linux-x64/spawn-helper',
  'node_modules/node-pty/prebuilds/win32-x64/winpty-agent.exe',
]) {
  const p = path.join(root, 'resources', rel);
  if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
}
console.log(`[vendor-natives] vendored ${seen.size} modules to resources/node_modules`);
