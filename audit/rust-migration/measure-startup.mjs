/** Ten fresh-data packaged Rust launches; bridge readiness, not first paint. */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
const [app, out] = process.argv.slice(2);
if (!app || !out) throw new Error('Provide app bundle and output JSON');
const samples = [];
for (let run = 1; run <= 10; run++) {
  const sample = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/rust-packaged-smoke.mjs', app], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let launched,
      ready,
      log = '',
      partial = '';
    child.stdout.on('data', (data) => {
      partial += String(data);
      const lines = partial.split('\n');
      partial = lines.pop();
      for (const line of lines) {
        if (line.includes('rust-packaged-smoke: launching')) launched = performance.now();
        if (line.includes('rust-packaged-smoke: bridge at')) ready = performance.now();
        log += line + '\n';
      }
    });
    child.stderr.on('data', (data) => {
      log += String(data);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 && launched !== undefined && ready !== undefined
        ? resolve({ run, bridgeReadyMs: ready - launched, smokePassed: true })
        : reject(new Error(log)),
    );
  });
  samples.push(sample);
  console.log(JSON.stringify(sample));
}
const times = samples.map((s) => s.bridgeReadyMs).sort((a, b) => a - b);
writeFileSync(
  out,
  JSON.stringify(
    {
      method:
        'Ten sequential packaged Rust app launches with fresh isolated app data; OS cache warm. Spawn-to-bridge readiness via smoke stdout, not first frame or workspace readiness.',
      p50Ms: times[4],
      p95Ms: times[9],
      samples,
    },
    null,
    2,
  ) + '\n',
);
