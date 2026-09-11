#!/usr/bin/env node
/**
 * Packaged smoke: launch the built app, wait for the bridge socket and the
 * gated smoke grant, run a real `stark call` roundtrip, then shut down.
 *
 *   node scripts/packaged-smoke.mjs [path-to-STARK.app-or-binary]
 *
 * Requires a packaged build first (`pnpm package` inside apps/desktop).
 * Exits 0 on success, 1 on failure — deterministic for CI.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2];

function fail(msg) {
  console.error(`packaged-smoke: FAIL — ${msg}`);
  process.exit(1);
}

/* Locate the packaged binary. */
function findApp() {
  const out = path.join(root, 'apps', 'desktop', 'out');
  if (arg) {
    const bin = arg.endsWith('.app') ? path.join(arg, 'Contents', 'MacOS', 'stark-desktop') : arg;
    if (fs.existsSync(bin))
      return { bin, resources: path.join(path.dirname(bin), '..', 'Resources') };
    fail(`no executable at ${bin}`);
  }
  const dirName = `STARK-${process.platform}-${process.arch}`;
  const appDir = path.join(out, dirName);
  const bin =
    process.platform === 'darwin'
      ? path.join(appDir, 'STARK.app', 'Contents', 'MacOS', 'stark-desktop')
      : path.join(appDir, 'stark-desktop' + (process.platform === 'win32' ? '.exe' : ''));
  const resources =
    process.platform === 'darwin'
      ? path.join(appDir, 'STARK.app', 'Contents', 'Resources')
      : path.join(appDir, 'resources');
  if (!fs.existsSync(bin)) {
    fail(`packaged app not found at ${bin} — run pnpm package in apps/desktop first`);
  }
  return { bin, resources };
}

const { bin, resources } = findApp();
const shim = path.join(resources, 'app.asar.unpacked', 'resources', 'core', 'stark');
if (!fs.existsSync(shim)) fail(`stark shim not packaged at ${shim}`);

const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'stark-smoke-'));
const env = { ...process.env, STARK_APP_DATA: appData, STARK_SMOKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;

console.log(`packaged-smoke: launching ${bin}`);
let done = false;
const child = spawn(bin, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let logBuf = '';
child.stdout.on('data', (d) => (logBuf += d));
child.stderr.on('data', (d) => (logBuf += d));
child.on('exit', (code) => {
  if (!done) fail(`app exited early (code ${code})\n${logBuf.slice(-2000)}`);
});

const smokeFile = path.join(appData, 'run', 'smoke.json');
const deadline = Date.now() + 45_000;
while (!fs.existsSync(smokeFile)) {
  if (Date.now() > deadline) {
    child.kill('SIGKILL');
    fail(`timed out waiting for smoke grant\n${logBuf.slice(-3000)}`);
  }
  await new Promise((r) => setTimeout(r, 250));
}
const smoke = JSON.parse(fs.readFileSync(smokeFile, 'utf8'));
console.log(`packaged-smoke: bridge at ${smoke.socketPath}`);

/* Real bridge roundtrip through the packaged `stark` shim. */
const out = execFileSync(process.execPath, [shim, 'call', 'artifact.list', '--input', '-'], {
  env: {
    ...process.env,
    STARK_BRIDGE_SOCK: smoke.socketPath,
    STARK_BRIDGE_TOKEN: smoke.token,
    STARK_PROJECT_ID: smoke.projectId,
  },
  input: '{}',
  encoding: 'utf8',
  timeout: 20_000,
});
const res = JSON.parse(out.trim());
if (!res || !Array.isArray(res.artifacts))
  fail(`stark call returned unexpected result: ${out.trim().slice(0, 300)}`);
console.log(`packaged-smoke: stark call artifact.list → ok (${res.artifacts.length} artifacts)`);

/* Second call: project summary for the smoke project. */
const out2 = execFileSync(process.execPath, [shim, 'call', 'project.summary', '--input', '-'], {
  env: { ...process.env, STARK_BRIDGE_SOCK: smoke.socketPath, STARK_BRIDGE_TOKEN: smoke.token },
  input: '{}',
  encoding: 'utf8',
  timeout: 20_000,
});
const res2 = JSON.parse(out2.trim());
if (!res2 || typeof res2 !== 'object') fail(`project.summary returned unexpected result`);

done = true;
child.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 500));
child.kill('SIGKILL');
console.log('packaged-smoke: DONE');
process.exit(0);
