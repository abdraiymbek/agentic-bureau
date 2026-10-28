/**
 * Judge internal-CAD-suite runs from every arm with one judge.
 *
 *   tsx evals/bench/judge-cadsuite.ts <arm dir> [<arm dir> ...]
 *
 * For each `<arm dir>/cadsuite/<task>__r<n>/output.scad` the delivered OpenSCAD source is
 * re-rendered here, independently of anything the agent ran, and judged by the suite's own
 * checks (evals/cad): it renders, it renders without OpenSCAD warnings, the task's
 * closed-form expectation (envelope, volume, bodies, probe points, cross-sections), the
 * parametric variants, and for modification tasks the untouched-geometry comparison with
 * the seed. A run passes only when every check passes; a run with no part fails.
 *
 * Only the delivered geometry is judged, so arms are comparable whatever tools they had:
 * Bureau's own records (verification, revisions) are not part of the verdict.
 */
import fs from 'node:fs';
import path from 'node:path';
import { effectiveCadParams } from '../../packages/core/src/cad-input.js';
import { preservationCheck, runChecks, type CheckResult } from '../cad/checks.js';
import { renderScad } from '../cad/harness.js';
import { taskById } from '../cad/tasks.js';

function judge(runDir: string): { pass: boolean; checks: CheckResult[] } {
  const taskId = path.basename(runDir).replace(/__r\d+$/, '');
  const task = taskById(taskId);
  if (!task) throw new Error(`unknown task ${taskId}`);
  const scadFile = path.join(runDir, 'output.scad');
  if (!fs.existsSync(scadFile))
    return { pass: false, checks: [{ name: 'part delivered', pass: false, detail: 'no part' }] };
  const scad = fs.readFileSync(scadFile, 'utf8');
  const outDir = path.join(runDir, 'judge');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const checks: CheckResult[] = [];
  let params: Record<string, number | string | boolean> = {};
  const payloadFile = path.join(runDir, 'output.payload.json');
  if (fs.existsSync(payloadFile)) {
    const payload = JSON.parse(fs.readFileSync(payloadFile, 'utf8'));
    try {
      params = effectiveCadParams(payload.params, payload.modelUnit);
    } catch {
      params = {};
    }
  }
  const delivered = renderScad(scad, outDir, 'delivered', params);
  if ('error' in delivered) {
    checks.push({ name: 'source renders', pass: false, detail: delivered.error });
    return { pass: false, checks };
  }
  const warnings = delivered.stderr.split('\n').filter((line) => /WARNING|ERROR/.test(line));
  checks.push({
    name: 'source renders cleanly',
    pass: warnings.length === 0,
    detail: warnings.slice(0, 3).join(' | ') || 'no warnings',
  });
  checks.push(...runChecks(delivered.tris, task.expect));
  for (const [index, variant] of (task.variants ?? []).entries()) {
    const label = `variant ${JSON.stringify(variant.params)}`;
    const rendered = renderScad(scad, outDir, `variant-${index}`, { ...params, ...variant.params });
    if ('error' in rendered) {
      checks.push({ name: label, pass: false, detail: `render failed: ${rendered.error}` });
      continue;
    }
    for (const check of runChecks(rendered.tris, variant.expect))
      checks.push({ ...check, name: `${label}: ${check.name}` });
  }
  if (task.seed && task.changeRegions) {
    const seed = renderScad(task.seed.scad, outDir, 'seed', effectiveCadParams(task.seed.params));
    if (!('error' in seed))
      checks.push(preservationCheck(seed.tris, delivered.tris, task.changeRegions));
  }
  return { pass: checks.every((check) => check.pass), checks };
}

for (const armDir of process.argv.slice(2)) {
  const suite = path.join(armDir, 'cadsuite');
  const runs = fs
    .readdirSync(suite)
    .filter((name) => fs.existsSync(path.join(suite, name, 'result.json')))
    .sort();
  let passed = 0;
  for (const name of runs) {
    const verdict = judge(path.join(suite, name));
    fs.writeFileSync(path.join(suite, name, 'judge.json'), JSON.stringify(verdict, null, 2));
    passed += verdict.pass ? 1 : 0;
    const failed = verdict.checks.filter((check) => !check.pass).map((check) => check.name);
    console.log(
      `${path.basename(armDir)} ${name} ${verdict.pass ? 'PASS' : `FAIL (${failed.slice(0, 3).join('; ')})`}`,
    );
  }
  console.log(`${path.basename(armDir)}: ${passed}/${runs.length} passed`);
}
