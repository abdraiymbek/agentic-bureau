#!/usr/bin/env node
/**
 * Packaged smoke: launch the built app, wait for the bridge socket and the
 * gated smoke grant, run a real `omenflow call` roundtrip, then shut down.
 *
 *   node scripts/packaged-smoke.mjs [path-to-Omen Flow.app-or-binary]
 *
 * Requires a packaged build first (`pnpm package` inside apps/desktop).
 * Exits 0 on success, 1 on failure — deterministic for CI.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv.slice(2).find((value) => !value.startsWith('--'));
const testCad = process.argv.includes('--cad');

function fail(msg) {
  throw new Error(`packaged-smoke: FAIL — ${msg}`);
}

/* Locate the packaged binary. */
function findApp() {
  const out = path.join(root, 'apps', 'desktop', 'out');
  if (arg) {
    const bin = arg.endsWith('.app')
      ? path.join(arg, 'Contents', 'MacOS', 'omenflow-desktop')
      : arg;
    if (fs.existsSync(bin))
      return {
        bin,
        resources:
          arg.endsWith('.app') || process.platform === 'darwin'
            ? path.join(path.dirname(bin), '..', 'Resources')
            : path.join(path.dirname(bin), 'resources'),
      };
    fail(`no executable at ${bin}`);
  }
  const dirName = `Omen Flow-${process.platform}-${process.arch}`;
  const appDir = path.join(out, dirName);
  const bin =
    process.platform === 'darwin'
      ? path.join(appDir, 'Omen Flow.app', 'Contents', 'MacOS', 'omenflow-desktop')
      : path.join(appDir, 'omenflow-desktop' + (process.platform === 'win32' ? '.exe' : ''));
  const resources =
    process.platform === 'darwin'
      ? path.join(appDir, 'Omen Flow.app', 'Contents', 'Resources')
      : path.join(appDir, 'resources');
  if (!fs.existsSync(bin)) {
    fail(`packaged app not found at ${bin} — run pnpm package in apps/desktop first`);
  }
  return { bin, resources };
}

const { bin, resources } = findApp();
const shim = path.join(resources, 'app.asar.unpacked', 'resources', 'core', 'omenflow');
if (!fs.existsSync(shim)) fail(`omenflow shim not packaged at ${shim}`);

const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'omenflow-smoke-'));
const env = { ...process.env, OMENFLOW_APP_DATA: appData, OMENFLOW_SMOKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;

// Exercise the actual standalone worker shipped in the application, not source
// loaders or a synchronous fallback that could hide a missing build artifact.
const meshWorker = path.join(path.dirname(shim), 'mesh-worker.mjs');
await new Promise((resolve, reject) => {
  const worker = new Worker(meshWorker, {
    workerData: {
      tris: new Float64Array([
        0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0,
        1, 0, 0, 0, 1,
      ]),
    },
  });
  const timer = setTimeout(() => {
    void worker.terminate();
    reject(new Error('packaged mesh worker timed out'));
  }, 10_000);
  worker.once('message', (message) => {
    clearTimeout(timer);
    void worker.terminate();
    try {
      assert.equal(message.ok, true, JSON.stringify(message.error));
      assert.equal(message.report.topology.watertight, true);
      assert.ok(Math.abs(message.report.volume - 1 / 6) < 1e-9);
      resolve();
    } catch (error) {
      reject(error);
    }
  });
  worker.once('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
});
console.log('packaged-smoke: standalone mesh worker → ok');

console.log(`packaged-smoke: launching ${bin}`);
const child = spawn(bin, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let logBuf = '';
let launchError;
let exited = false;
child.stdout.on('data', (d) => (logBuf = (logBuf + d).slice(-16_000)));
child.stderr.on('data', (d) => (logBuf = (logBuf + d).slice(-16_000)));
child.on('error', (error) => {
  launchError = error;
});
const closed = new Promise((resolve) =>
  child.once('close', () => {
    exited = true;
    resolve();
  }),
);
try {
  const smokeFile = path.join(appData, 'run', 'smoke.json');
  const deadline = Date.now() + 45_000;
  while (!fs.existsSync(smokeFile)) {
    if (launchError) throw launchError;
    if (exited) fail(`app exited early\n${logBuf}`);
    if (Date.now() > deadline) fail(`timed out waiting for smoke grant\n${logBuf}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const smoke = JSON.parse(fs.readFileSync(smokeFile, 'utf8'));
  console.log(`packaged-smoke: bridge at ${smoke.socketPath}`);
  const call = (op, payload) =>
    JSON.parse(
      execFileSync(process.execPath, [shim, 'call', op, '--input', '-'], {
        env: {
          ...process.env,
          OMENFLOW_BRIDGE_SOCK: smoke.socketPath,
          OMENFLOW_BRIDGE_TOKEN: smoke.token,
          OMENFLOW_PROJECT_ID: smoke.projectId,
        },
        input: JSON.stringify(payload),
        encoding: 'utf8',
        timeout: 90_000,
      }),
    );
  assert.ok(Array.isArray(call('artifact.list', {}).artifacts));
  assert.equal(call('project.summary', {}).project.name, 'Omen Flow smoke');
  console.log('packaged-smoke: bridge list + summary → ok');
  const calc = call('calculation.run', {
    expression: 'mass + mass',
    inputs: [{ name: 'mass', quantity: { value: 2, unit: 'kg' }, literal: true }],
    submitForReview: false,
  });
  assert.deepEqual(calc.result, { value: 4, unit: 'kg' });
  assert.equal(calc.experimental, true);
  console.log('packaged-smoke: calculation worker → ok');
  if (testCad) {
    const part = call('cad.write_source', {
      title: 'Packaged sphere',
      source: '$fn=64; sphere(r=10);',
    });
    assert.equal(part.render.ok, true);
    const check = call('cad.check', {
      artifactId: part.artifactId,
      expect: { bbox: { min: [-10, -10, -10], max: [10, 10, 10], tol: 0.1 }, shells: 1 },
    });
    assert.equal(check.verificationStatus, 'passed');
    assert.equal(check.pass, true);
    console.log('packaged-smoke: real OpenSCAD + persisted verification → ok');
  }
  console.log('packaged-smoke: DONE');
} finally {
  if (!exited) {
    child.kill('SIGTERM');
    const forced = setTimeout(() => child.kill('SIGKILL'), 7000);
    await closed;
    clearTimeout(forced);
  }
}
