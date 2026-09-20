/**
 * CAD agent evaluation runner.
 *
 *   pnpm eval:cad -- --out /tmp/eval-baseline [--tasks a,b] [--suite main|holdout]
 *                    [--runs 3] [--model gpt-5.6-luna] [--effort high] [--timeout-min 20]
 *                    [--user-config]  (keep developer ~/.codex/config.toml; default ignores it)
 *
 * Writes per-run traces/results under --out/<task>/r<i>/ and rebuilds summary.md
 * from every result.json present, so several runners may share one --out.
 */
import fs from 'node:fs';
import path from 'node:path';
import { formatResult, runTask, type TaskResult } from './harness.js';
import { TASKS, type Task } from './tasks.js';
import { HOLDOUT_TASKS } from './holdout.js';

/** Constant across before/after runs — describes the situation, not the method. */
export const FRAMING =
  'You are working inside an Omen Flow engineering project; the `omenflow` MCP server is connected ' +
  'and OpenSCAD is available through it. Deliver the part below as a mechanical artifact in this ' +
  'project (OpenSCAD source, rendered). All dimensions are in millimetres.';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  return def;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const out = arg('out');
  if (!out) {
    console.error('missing --out <dir>');
    process.exit(3);
  }
  const suiteName = arg('suite', 'main')!;
  const suite: Task[] = suiteName === 'holdout' ? HOLDOUT_TASKS : TASKS;
  const only = arg('tasks')?.split(',').filter(Boolean);
  const tasks = only ? suite.filter((t) => only.includes(t.id)) : suite;
  if (tasks.length === 0) {
    console.error('no tasks selected');
    process.exit(3);
  }
  const model = arg('model', 'gpt-5.6-luna')!;
  const effort = arg('effort', 'high')!;
  const runs = Number(arg('runs', '1'));
  const timeoutMs = Number(arg('timeout-min', '20')) * 60_000;
  fs.mkdirSync(out, { recursive: true });
  const meta = { model, effort, suite: suiteName };

  for (let i = 1; i <= runs; i++) {
    for (const task of tasks) {
      const runDir = path.join(out, task.id, `r${i}`);
      if (fs.existsSync(path.join(runDir, 'result.json'))) {
        console.log(`=== ${task.id} r${i}: already done, skipping`);
        continue;
      }
      console.log(`\n=== ${task.id} (${task.category}) run ${i}/${runs} ===`);
      const started = Date.now();
      const r = await runTask(task, {
        model,
        reasoningEffort: effort,
        outDir: path.join(out, task.id),
        runName: `r${i}`,
        timeoutMs,
        framing: FRAMING,
        ignoreUserConfig: !flag('user-config'),
      });
      console.log(formatResult(r));
      console.log(`(${((Date.now() - started) / 1000).toFixed(0)}s wall)`);
      writeSummary(out, suite, meta);
    }
  }
  writeSummary(out, suite, meta);
  console.log(`\nsummary: ${path.join(out, 'summary.md')}`);
}

interface TaskAgg {
  task: Task;
  results: TaskResult[];
}

function collect(out: string, suite: Task[]): TaskAgg[] {
  const aggs: TaskAgg[] = [];
  for (const t of suite) {
    const dir = path.join(out, t.id);
    if (!fs.existsSync(dir)) continue;
    const results: TaskResult[] = [];
    for (const run of fs
      .readdirSync(dir)
      .filter((d) => /^r\d+$/.test(d))
      .sort()) {
      const f = path.join(dir, run, 'result.json');
      if (fs.existsSync(f)) results.push(JSON.parse(fs.readFileSync(f, 'utf8')) as TaskResult);
    }
    if (results.length) aggs.push({ task: t, results });
  }
  return aggs;
}

function writeSummary(
  out: string,
  suite: Task[],
  meta: { model: string; effort: string; suite: string },
): void {
  fs.writeFileSync(path.join(out, 'summary.md'), summarize(collect(out, suite), meta));
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function summarize(
  aggs: TaskAgg[],
  meta: { model: string; effort: string; suite: string },
): string {
  const all = aggs.flatMap((a) => a.results);
  const passed = all.filter((r) => r.pass).length;
  const checks = all.flatMap((r) => r.checks);
  const checksPassed = checks.filter((c) => c.pass).length;
  const m = (f: (r: TaskResult) => number) => avg(all.map(f));
  const head = [
    `# CAD eval — ${meta.suite} suite · ${meta.model} (${meta.effort})`,
    '',
    `Runs passed: **${passed}/${all.length}** · checks passed: ${checksPassed}/${checks.length} · tasks fully reliable: ${aggs.filter((a) => a.results.every((r) => r.pass)).length}/${aggs.length}`,
    '',
    '| task | category | pass rate | checks | verified runs | avg tool calls | avg tool errors | avg shell | avg time | avg out tokens | avg input tokens |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...aggs.map((a) => {
      const rs = a.results;
      const p = rs.filter((r) => r.pass).length;
      const c = rs.flatMap((r) => r.checks);
      const verified = rs.filter((r) => r.metrics.lastCheckPassed === true).length;
      return `| ${a.task.id} | ${a.task.category} | ${p}/${rs.length} | ${c.filter((x) => x.pass).length}/${c.length} | ${verified}/${rs.length} | ${avg(rs.map((r) => r.metrics.toolCalls)).toFixed(1)} | ${avg(rs.map((r) => r.metrics.toolErrors)).toFixed(1)} | ${avg(rs.map((r) => r.metrics.shellCommands)).toFixed(1)} | ${(avg(rs.map((r) => r.metrics.durationMs)) / 1000).toFixed(0)}s | ${avg(rs.map((r) => r.metrics.outputTokens)).toFixed(0)} | ${avg(rs.map((r) => r.metrics.inputTokens)).toFixed(0)} |`;
    }),
    `| **all** | | ${passed}/${all.length} | ${checksPassed}/${checks.length} | ${all.filter((r) => r.metrics.lastCheckPassed === true).length}/${all.length} | ${m((r) => r.metrics.toolCalls).toFixed(1)} | ${m((r) => r.metrics.toolErrors).toFixed(1)} | ${m((r) => r.metrics.shellCommands).toFixed(1)} | ${(m((r) => r.metrics.durationMs) / 1000).toFixed(0)}s | ${m((r) => r.metrics.outputTokens).toFixed(0)} | ${m((r) => r.metrics.inputTokens).toFixed(0)} |`,
    '',
    '## Failed checks',
    '',
    ...all.flatMap((r) =>
      r.checks
        .filter((c) => !c.pass)
        .map((c) => `- ${r.taskId}/${r.runName}: ✗ ${c.name}: ${c.detail}`),
    ),
    '',
    '## Runs',
    '',
  ];
  return [...head, ...all.map(formatResult)].join('\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
