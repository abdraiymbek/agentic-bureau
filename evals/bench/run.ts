/**
 * Public CAD benchmarks on the production Rust host.
 *
 *   tsx evals/bench/run.ts --out <dir> --cadgen <fixtures dir> --benchcad <records.jsonl>
 *       [--lanes 7] [--model claude-haiku-5-5] [--effort xhigh] [--deadline-min 58]
 *       [--task-min 12] [--only <id,...>] [--limit-benchcad N]
 *
 * Each task is one fresh host and project: the inputs are copied into the
 * project, Claude Code runs once on the host's headless launch plan, and the
 * newest rendered revision of the part it made is copied out as `output.stl`
 * with its OpenSCAD source. Lanes pull tasks from one queue (CADGenBench
 * first, so its submission is complete) until the deadline; a task never
 * outlives it. Scoring happens afterwards (`score.py`).
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeMetrics, runPlan, type StreamMetrics } from '../agent/cli.js';
import { EvalHost, REPO, type LaunchPlan } from '../agent/host.js';
import { TASKS as CAD_SUITE } from '../cad/tasks.js';

interface Task {
  id: string;
  bench: 'cadgenbench' | 'benchcad' | 'cadsuite';
  images: string[];
  prompt: string;
  /** cadsuite modification tasks: the part that exists before the agent starts. */
  seed?: { title: string; scad: string };
}

/** Where the part is delivered: Bureau's tools on the host, or plain Claude Code writing part.scad. */
type Arm = 'bureau' | 'bare';

const CAD_SUITE_DELIVERY: Record<Arm, string> = {
  bureau:
    'You are working inside a Bureau engineering project; the `bureau` MCP server is connected ' +
    'and OpenSCAD is available through it. Deliver the part below as a mechanical artifact in this ' +
    'project (OpenSCAD source, rendered). All dimensions are in millimetres.',
  bare:
    'You are working in a folder where OpenSCAD is installed (the `openscad` command). Deliver the part ' +
    'below as OpenSCAD source in the file `part.scad` in the current folder; you can render it with ' +
    '`openscad` to check it. All dimensions are in millimetres.',
};

const CAD_SUITE_FINISH =
  'This run is non-interactive: nobody will answer questions, so make reasonable decisions and finish the work. ' +
  'Act through tool calls, and do not end your turn until the part is written and you have checked it.';

/** The internal CAD suite (evals/cad), each task repeated `runs` times, phrased for the arm. */
function cadSuiteTasks(runs: number, arm: Arm): Task[] {
  return CAD_SUITE.flatMap((task) => {
    let prompt = task.prompt;
    if (arm === 'bare' && task.seed)
      prompt = prompt
        .replace(
          /^The project (already )?contains the mechanical artifact "([^"]+)"/,
          'The file `part.scad` contains the part "$2"',
        )
        .replace(
          /Record (the change|it) as a new revision of the same artifact\./,
          'Save the change in `part.scad`.',
        );
    return Array.from({ length: runs }, (_, run) => ({
      id: `${task.id}__r${run + 1}`,
      bench: 'cadsuite' as const,
      images: [],
      prompt: `${CAD_SUITE_FINISH}\n\n${CAD_SUITE_DELIVERY[arm]}\n\n${prompt}`,
      seed: task.seed ? { title: task.seed.title, scad: task.seed.scad } : undefined,
    }));
  });
}

const FRAMING =
  'This run is non-interactive: nobody will answer questions, so make reasonable decisions and finish the work. ' +
  'Act through tool calls: do not stop to announce a plan, and do not end your turn until the part is written with cad_write_source and its cad_check passes. A reply without a part is a failed task.';

const CONTINUE =
  'You ended your turn without a part. Continue now: write the part with cad_write_source from what you have already read, then verify it with cad_check and fix it until the check passes.';

const CADGEN_PROMPT = (
  images: string[],
  description: string,
) => `Reproduce the mechanical part shown in the engineering drawing ${images
  .map((image) => `\`inputs/${image}\``)
  .join(' and ')} as ONE Bureau mechanical part written in OpenSCAD, in millimetres.

Task note: ${description.trim()}

View the drawing with the Read tool (read it again or crop mentally as needed). Read the printed dimensions and callouts; never scale lengths off the pixels.

How the result is scored: your solid is aligned to the reference by rotation and translation only (never rescaled), then compared on volume and surface overlap, on mating interfaces (bores, holes, bolt circles, mounting faces: exact size and position), and on topology (number of bodies, through-holes, enclosed cavities). An invalid or non-watertight solid scores zero.

Priorities, in order:
1. Absolute size: every printed dimension exact.
2. Feature set: the exact number and position of holes, pockets, slots and bosses. Openings are blind unless marked THRU or a view/section shows daylight through them; a depth callout means a blind pocket. Never add a feature no view shows.
3. Overall form: follow the section/side view for every thickness step, hub, counterbore and pocket depth; hollow thin-walled housings, covers and trays (do not model them as solid blocks); keep gaps between spokes, ribs and arms open; follow curves and tapers.
4. Fillets and chamfers last.

Working approach:
- First write a dimension table from the drawing (envelope, every diameter and bolt circle, the through-thickness profile, feature counts and positions), resolving stacked dimensions into one arithmetic chain per axis.
- Build the part with named top-level parameters in one OpenSCAD source (cad_write_source). Use $fn = 96 for round features. The result must be a single solid body.
- Verify it with cad_check: assert the overall envelope and the key features from your table (holes and bores as sections, solid and empty probe points for pockets and through-openings). Fix the geometry until the check passes. Use cad_inspect sections to compare the profile with the drawing's section view.
- Finish when the part's check passes against assertions taken from the drawing. Do not request approval.`;

const BENCHCAD_PROMPT = `Reproduce the industrial part shown in \`inputs/composite.png\` as ONE Bureau mechanical part written in OpenSCAD. The image is a 2x2 composite of 4 diagonal parallel-projection views of the part. View it with the Read tool.

Views (cameras at, all looking at the part centre [0.5, 0.5, 0.5]):
- Top-left:     [-1, -1, -1]
- Top-right:    [ 1,  1,  1]
- Bottom-left:  [ 1, -1,  1]
- Bottom-right: [-1,  1, -1]

The renders are normalized: bounding box centred at [0.5, 0.5, 0.5], longest side mapped to [0, 1]. The result is scored by voxel IoU after the same normalization, so absolute scale does not matter, but proportions and orientation do: world X, Y and Z in your model must match world X, Y and Z in the renders. The result must be a single solid body.

Build it with cad_write_source (any convenient unit, for example the longest side as 100), then verify the proportions and features you read from the views with cad_check (bounding box, holes as sections, solid and empty probe points), and fix the geometry until the check passes. Do not request approval.`;

function cadgenTasks(dir: string): Task[] {
  return fs
    .readdirSync(dir)
    .filter((name) => /^1\d\d$/.test(name))
    .sort()
    .map((id) => {
      const fixture = path.join(dir, id);
      const yaml = fs.readFileSync(path.join(fixture, 'description.yaml'), 'utf8');
      const description = /description:\s*>?\s*\n([\s\S]*?)\n\S/.exec(yaml)?.[1] ?? '';
      const images = fs
        .readdirSync(fixture)
        .filter((file) => /^input\d*\.png$/.test(file))
        .sort();
      return {
        id,
        bench: 'cadgenbench' as const,
        images: images.map((image) => path.join(fixture, image)),
        prompt: CADGEN_PROMPT(images, description.replace(/\s+/g, ' ')),
      };
    });
}

function benchcadTasks(records: string): Task[] {
  return fs
    .readFileSync(records, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { stem: string; png?: string })
    .filter((record) => record.png)
    .sort((a, b) => a.stem.localeCompare(b.stem))
    .map((record) => ({
      id: record.stem,
      bench: 'benchcad' as const,
      images: [record.png!],
      prompt: BENCHCAD_PROMPT,
    }));
}

interface Options {
  out: string;
  arm: Arm;
  lanes: number;
  model: string;
  effort: string;
  deadline: number;
  taskMs: number;
  maxTurns: number;
  budgetUsd: number;
  hostBin: string;
  cliBin: string;
}

interface TaskResult {
  id: string;
  bench: Task['bench'];
  lane: number;
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  promptDetected: string | null;
  continuations: number;
  stream: StreamMetrics | null;
  model: string | null;
  profile: string | null;
  calls: number;
  callErrors: number;
  tools: Record<string, number>;
  parts: number;
  output: { revisionId: string; verification: unknown } | null;
  harnessError: string | null;
}

/** Copy the newest rendered revision of the most recently changed part out of the project. */
async function exportPart(host: EvalHost, projectId: string, projectDir: string, dir: string) {
  const listed = await host.command('artifact.list', { type: 'mechanical', limit: 50 }, projectId);
  const rows = (listed.items ?? listed.artifacts ?? listed) as any[];
  let best: { revision: any; at: string } | null = null;
  for (const row of rows) {
    const artifact = row.artifact ?? row;
    const history = await host.command('artifact.history', { artifactId: artifact.id }, projectId);
    for (const revision of (history.revisions ?? history) as any[]) {
      const stl = (revision.files ?? []).find((file: any) => String(file.path).endsWith('.stl'));
      if (!stl) continue;
      const at = String(revision.createdAt ?? revision.created_at ?? '');
      if (!best || at >= best.at) best = { revision, at };
    }
  }
  if (!best) return { parts: rows.length, output: null };
  fs.writeFileSync(
    path.join(dir, 'output.payload.json'),
    JSON.stringify(best.revision.payload ?? {}, null, 2),
  );
  for (const file of best.revision.files as any[]) {
    const ext = path.extname(String(file.path));
    if (ext !== '.stl' && ext !== '.scad') continue;
    const blob = path.join(projectDir, '.bureau', 'objects', file.sha256.slice(0, 2), file.sha256);
    fs.copyFileSync(blob, path.join(dir, `output${ext}`));
  }
  return {
    parts: rows.length,
    output: {
      revisionId: best.revision.id,
      verification: best.revision.payload?.verification ?? best.revision.verification ?? null,
    },
  };
}

function emptyResult(task: Task, lane: number, started: number): TaskResult {
  return {
    id: task.id,
    bench: task.bench,
    lane,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    exitCode: null,
    timedOut: false,
    promptDetected: null,
    continuations: 0,
    stream: null,
    model: null,
    profile: null,
    calls: 0,
    callErrors: 0,
    tools: {},
    parts: 0,
    output: null,
    harnessError: null,
  };
}

function sumMetrics(metrics: StreamMetrics[]): StreamMetrics {
  return {
    ...metrics.at(-1)!,
    inputTokens: metrics.reduce((sum, m) => sum + m.inputTokens, 0),
    cachedInputTokens: metrics.reduce((sum, m) => sum + m.cachedInputTokens, 0),
    outputTokens: metrics.reduce((sum, m) => sum + m.outputTokens, 0),
    turns: metrics.reduce((sum, m) => sum + m.turns, 0),
    costUsd: metrics.reduce((sum, m) => sum + (m.costUsd ?? 0), 0),
  };
}

/** Plain Claude Code in a folder with OpenSCAD: no Bureau, the part is whatever `part.scad` holds at the end. */
async function runBare(task: Task, lane: number, options: Options): Promise<TaskResult> {
  const dir = path.join(options.out, task.bench, task.id);
  fs.rmSync(dir, { recursive: true, force: true });
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });
  const started = Date.now();
  const result = emptyResult(task, lane, started);
  const partFile = path.join(work, 'part.scad');
  if (task.seed) fs.writeFileSync(partFile, task.seed.scad);
  try {
    const prompt = task.prompt;
    fs.writeFileSync(path.join(dir, 'prompt.txt'), `${prompt}\n`);
    const sessionId = randomUUID();
    const plan = {
      executable: path.join(os.homedir(), '.local/bin/claude'),
      args: [
        '-p',
        '--model',
        options.model,
        '--session-id',
        sessionId,
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'dontAsk',
        '--allowedTools',
        'Read,Write,Edit,Bash(openscad:*)',
      ],
      cwd: work,
      env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' },
      envDefaults: {},
      files: [],
    } as unknown as LaunchPlan;
    const extra = [
      '--strict-mcp-config',
      '--max-turns',
      String(options.maxTurns),
      '--max-budget-usd',
      String(options.budgetUsd),
      '--effort',
      options.effort,
    ];
    const taskEnd = Math.min(started + options.taskMs, options.deadline);
    const lines: string[] = [];
    let ran = await runPlan(plan, extra, prompt, Math.max(30_000, taskEnd - Date.now()), dir);
    lines.push(...ran.stdoutLines);
    const metrics = [claudeMetrics(ran.stdoutLines)];
    const unchanged = () =>
      !fs.existsSync(partFile) ||
      (task.seed !== undefined && fs.readFileSync(partFile, 'utf8') === task.seed.scad);
    // The same rule as the Bureau arm: a model that ends its turn with no part is resumed, at most twice.
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (ran.timedOut || ran.exitCode !== 0 || taskEnd - Date.now() < 60_000 || !unchanged())
        break;
      const resumeDir = path.join(dir, `continue-${attempt}`);
      fs.mkdirSync(resumeDir, { recursive: true });
      const args = [...plan.args];
      args[args.indexOf('--session-id')] = '--resume';
      const again =
        'You ended your turn without delivering the part. Continue now: write it to `part.scad`, render it with `openscad` to check it, and fix it until it is right.';
      ran = await runPlan({ ...plan, args }, extra, again, taskEnd - Date.now(), resumeDir);
      lines.push(...ran.stdoutLines);
      metrics.push(claudeMetrics(ran.stdoutLines));
      result.continuations = attempt;
    }
    result.exitCode = ran.exitCode;
    result.timedOut = ran.timedOut;
    result.promptDetected = ran.promptDetected;
    result.stream = sumMetrics(metrics);
    const init = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find((event) => event?.type === 'system' && event?.subtype === 'init');
    result.model = init?.model ?? null;
    if (fs.existsSync(partFile)) {
      fs.copyFileSync(partFile, path.join(dir, 'output.scad'));
      result.parts = 1;
      result.output = { revisionId: 'part.scad', verification: null };
    }
  } catch (error) {
    result.harnessError = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
  result.durationMs = Date.now() - started;
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

async function runTask(task: Task, lane: number, options: Options): Promise<TaskResult> {
  if (options.arm === 'bare') return runBare(task, lane, options);
  const dir = path.join(options.out, task.bench, task.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const projectDir = path.join(dir, 'project');
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'ofb-'));
  const started = Date.now();
  const result: TaskResult = {
    id: task.id,
    bench: task.bench,
    lane,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    exitCode: null,
    timedOut: false,
    promptDetected: null,
    continuations: 0,
    stream: null,
    model: null,
    profile: null,
    calls: 0,
    callErrors: 0,
    tools: {},
    parts: 0,
    output: null,
    harnessError: null,
  };
  const host = await EvalHost.start(options.hostBin, options.cliBin, appData);
  try {
    const created = await host.command('project.create', {
      path: projectDir,
      name: `${task.bench} ${task.id}`,
      intent: 'Reproduce one mechanical part from its drawing or views.',
    });
    const projectId = created.projectId as string;
    if (task.seed) {
      const written = await host.command(
        'cad.write_source',
        { title: task.seed.title, source: task.seed.scad },
        projectId,
      );
      await host
        .command(
          'artifact.accept_draft',
          {
            artifactId: written.artifactId,
            draftRevisionId: written.revisionId,
            rationale: 'baseline',
          },
          projectId,
        )
        .catch(() => undefined);
    }
    fs.mkdirSync(path.join(projectDir, 'inputs'), { recursive: true });
    for (const image of task.images) {
      const name = task.bench === 'benchcad' ? 'composite.png' : path.basename(image);
      fs.copyFileSync(image, path.join(projectDir, 'inputs', name));
    }
    const prompt = task.bench === 'cadsuite' ? task.prompt : `${FRAMING}\n\n${task.prompt}`;
    fs.writeFileSync(path.join(dir, 'prompt.txt'), `${prompt}\n`);
    const plan: LaunchPlan = await host.launch({
      projectId,
      adapterId: 'claude-code',
      model: options.model,
      profile: 'auto',
      args: [],
    });
    result.profile = plan.profile;
    // The drawing reaches the model through Claude Code's Read tool, next to Bureau's tools.
    const allowed = plan.args.indexOf('--allowedTools');
    if (allowed >= 0 && task.images.length)
      plan.args[allowed + 1] = `${plan.args[allowed + 1]},Read`;
    const extra = [
      '--strict-mcp-config',
      '--max-turns',
      String(options.maxTurns),
      '--max-budget-usd',
      String(options.budgetUsd),
      '--effort',
      options.effort,
    ];
    const taskEnd = Math.min(started + options.taskMs, options.deadline);
    const lines: string[] = [];
    let ran = await runPlan(plan, extra, prompt, Math.max(30_000, taskEnd - Date.now()), dir);
    lines.push(...ran.stdoutLines);
    const metrics = [claudeMetrics(ran.stdoutLines)];
    // A model that ends its turn with no part is resumed in the same session, at most twice.
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (ran.timedOut || ran.exitCode !== 0 || taskEnd - Date.now() < 60_000) break;
      const listed = await host.command(
        'artifact.list',
        { type: 'mechanical', limit: 5 },
        projectId,
      );
      if (((listed.items ?? listed.artifacts ?? listed) as any[]).length > 0) break;
      const resumeDir = path.join(dir, `continue-${attempt}`);
      fs.mkdirSync(resumeDir, { recursive: true });
      const args = [...plan.args];
      args[args.indexOf('--session-id')] = '--resume';
      ran = await runPlan({ ...plan, args }, extra, CONTINUE, taskEnd - Date.now(), resumeDir);
      lines.push(...ran.stdoutLines);
      metrics.push(claudeMetrics(ran.stdoutLines));
      result.continuations = attempt;
    }
    await host.revoke(plan.sessionId);
    result.exitCode = ran.exitCode;
    result.timedOut = ran.timedOut;
    result.promptDetected = ran.promptDetected;
    result.stream = {
      ...metrics.at(-1)!,
      inputTokens: metrics.reduce((sum, m) => sum + m.inputTokens, 0),
      cachedInputTokens: metrics.reduce((sum, m) => sum + m.cachedInputTokens, 0),
      outputTokens: metrics.reduce((sum, m) => sum + m.outputTokens, 0),
      turns: metrics.reduce((sum, m) => sum + m.turns, 0),
      costUsd: metrics.reduce((sum, m) => sum + (m.costUsd ?? 0), 0),
    };
    const init = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find((event) => event?.type === 'system' && event?.subtype === 'init');
    result.model = init?.model ?? null;
    const activity = await host.command(
      'agent.activity',
      { limit: 500, sessionId: plan.sessionId },
      projectId,
    );
    const calls = (activity.calls as any[]).filter((call) => call.sessionId === plan.sessionId);
    result.calls = calls.length;
    result.callErrors = calls.filter((call) => !call.ok).length;
    result.tools = calls.reduce<Record<string, number>>((tools, call) => {
      tools[call.op] = (tools[call.op] ?? 0) + 1;
      return tools;
    }, {});
    Object.assign(result, await exportPart(host, projectId, projectDir, dir));
  } catch (error) {
    result.harnessError = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    await host.shutdown();
    fs.rmSync(appData, { recursive: true, force: true });
  }
  result.durationMs = Date.now() - started;
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

function flag(args: string[], name: string, fallback?: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const out = path.resolve(flag(args, '--out')!);
  const started = Date.now();
  // Runs before the rename were started with `--arm omenflow`.
  const armFlag = flag(args, '--arm', 'bureau');
  const arm = (armFlag === 'omenflow' ? 'bureau' : armFlag) as Arm;
  const options: Options = {
    out,
    arm,
    lanes: Number(flag(args, '--lanes', '7')),
    model: flag(args, '--model', 'claude-haiku-5-5')!,
    effort: flag(args, '--effort', 'xhigh')!,
    deadline: started + Number(flag(args, '--deadline-min', '58')) * 60_000,
    taskMs: Number(flag(args, '--task-min', '12')) * 60_000,
    maxTurns: Number(flag(args, '--max-turns', '80')),
    budgetUsd: Number(flag(args, '--budget-usd', '4')),
    hostBin: flag(args, '--host-bin', path.join(REPO, 'target/release/bureau-host'))!,
    cliBin: flag(args, '--cli-bin', path.join(REPO, 'native/bureau-bridge/target/release/bureau'))!,
  };
  const only = flag(args, '--only')?.split(',');
  const cadgen = flag(args, '--cadgen');
  const benchcad = flag(args, '--benchcad');
  const limitBenchcad = Number(flag(args, '--limit-benchcad', '100000'));
  let queue: Task[] = [
    ...(cadgen ? cadgenTasks(cadgen) : []),
    ...(benchcad ? benchcadTasks(benchcad).slice(0, limitBenchcad) : []),
    ...(args.includes('--cadsuite') ? cadSuiteTasks(Number(flag(args, '--runs', '3')), arm) : []),
  ];
  if (only) queue = queue.filter((task) => only.includes(task.id));
  fs.mkdirSync(out, { recursive: true });
  console.log(
    `${queue.length} tasks, ${options.lanes} lanes, ${options.arm} ${options.model} ${options.effort}`,
  );
  const results: TaskResult[] = [];
  const minimumMs = 120_000;
  const lane = async (index: number) => {
    for (;;) {
      if (options.deadline - Date.now() < minimumMs) return;
      const task = queue.shift();
      if (!task) return;
      const result = await runTask(task, index, options);
      results.push(result);
      const minutes = ((Date.now() - started) / 60_000).toFixed(1);
      console.log(
        `[${minutes}m] lane ${index} ${task.bench}/${task.id} ${result.output ? 'part' : 'NO PART'}` +
          ` ${Math.round(result.durationMs / 1000)}s $${result.stream?.costUsd?.toFixed(3) ?? '?'}` +
          `${result.timedOut ? ' TIMEOUT' : ''}${result.harnessError ? ` ERROR ${result.harnessError.split('\n')[0]}` : ''}`,
      );
    }
  };
  await Promise.all(Array.from({ length: options.lanes }, (_, index) => lane(index)));
  console.log(`done: ${results.length} run, ${queue.length} not started`);
  fs.writeFileSync(
    path.join(out, `run-${new Date(started).toISOString().replace(/[:.]/g, '-')}.json`),
    JSON.stringify(
      { options: { ...options, deadline: undefined }, notStarted: queue.map((t) => t.id) },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
