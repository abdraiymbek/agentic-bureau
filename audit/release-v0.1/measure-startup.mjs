/** Ten fresh-user-data packaged launches. Measures bridge readiness, not first paint. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

const out = process.argv[2];
if (!out) throw new Error('Provide output JSON');
const samples = [];
for (let run = 1; run <= 10; run++) {
  const sample = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/packaged-smoke.mjs'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let launched;
    let ready;
    let log = '';
    let partial = '';
    child.stdout.on('data', (data) => {
      partial += String(data);
      const lines = partial.split('\n');
      partial = lines.pop();
      for (const line of lines) {
        if (line.includes('packaged-smoke: launching')) launched = performance.now();
        if (line.includes('packaged-smoke: bridge at')) ready = performance.now();
        log += line + '\n';
      }
    });
    child.stderr.on('data', (data) => {
      log += String(data);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 || launched === undefined || ready === undefined) reject(new Error(log));
      else resolve({ run, bridgeReadyMs: ready - launched, smokePassed: true });
    });
  });
  samples.push(sample);
  console.log(JSON.stringify(sample));
}
const times = samples.map((sample) => sample.bridgeReadyMs).sort((a, b) => a - b);
fs.writeFileSync(
  out,
  JSON.stringify(
    {
      method:
        'Ten sequential packaged app launches with a fresh isolated Chromium/core data directory each time; OS file cache remains warm. Measures spawn-to-bridge readiness via smoke stdout, not first frame or workspace readiness. Every launch completes calculation and bridge smoke.',
      p50Ms: times[4],
      p95Ms: times[9],
      samples,
    },
    null,
    2,
  ) + '\n',
);
