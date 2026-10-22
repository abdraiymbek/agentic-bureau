/**
 * Agent evaluation on the production Rust host.
 *
 *   pnpm eval:agent -- --out <dir> [--cells <id,...>] [--concurrency 2]
 *   pnpm eval:agent -- --out <dir> --reference good|bad      (scripted, no model)
 *   pnpm eval:agent -- --summary <dir> [<dir> ...]            (table from result.json files)
 *
 * Each cell is one task for one CLI, model and profile, run once: a fresh
 * host on its own data directory, a fresh project under `--out`, seeding by
 * person-side commands, the host's headless launch plan for the CLI, then
 * judgement from recorded state and metrics from the ledger and the CLI's
 * event stream. See evals/agent/README.md.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeMetrics, codexMetrics, runPlan, type StreamMetrics } from './cli.js';
import { baseEnvironment, buildBinaries, EvalHost, REPO, type LaunchPlan } from './host.js';
import { captureState, contradictions, type Criterion } from './judge.js';
import { FRAMING, TASKS, type AgentCall, type Judgement, type TaskId } from './tasks.js';

type Cli = 'claude-code' | 'codex';

interface Cell {
  id: string;
  task: TaskId;
  cli: Cli;
  model: string;
  profile: 'auto' | 'compact' | 'standard' | 'full';
}

const cell = (task: TaskId, cli: Cli, model: string, profile: Cell['profile']): Cell => ({
  id: `${task}.${cli}.${model}.${profile}`,
  task,
  cli,
  model,
  profile,
});

const ALL_TASKS: TaskId[] = ['requirements', 'cad-plate', 'calculation', 'finish-discipline'];
const CAD_TASKS: TaskId[] = ['cad-plate', 'finish-discipline'];

/**
 * The V1 matrix: 14 Claude Code cells and 4 Codex cells, one run each. Claude models are named
 * by full id: Claude Code 2.1.287 resolves the alias `haiku` to Claude Haiku 4.5.
 */
export const MATRIX: Cell[] = [
  ...ALL_TASKS.map((task) => cell(task, 'claude-code', 'claude-haiku-5-5', 'compact')),
  ...ALL_TASKS.map((task) => cell(task, 'claude-code', 'claude-haiku-5-5', 'full')),
  ...ALL_TASKS.map((task) => cell(task, 'claude-code', 'claude-sonnet-5-5', 'auto')),
  ...CAD_TASKS.map((task) => cell(task, 'claude-code', 'claude-opus-5-5', 'auto')),
  ...CAD_TASKS.map((task) => cell(task, 'codex', 'gpt-6-luna', 'auto')),
  ...CAD_TASKS.map((task) => cell(task, 'codex', 'gpt-6-astra', 'auto')),
];

interface Options {
  out: string;
  cells: Cell[];
  concurrency: number;
  timeoutMs: number;
  maxTurns: number;
  hostBin: string | null;
  cliBin: string | null;
  reference: 'good' | 'bad' | null;
}

/**
 * Flags the harness adds to the plan, per CLI; the plan's own arguments are never changed. No
 * spend flag: Claude Code enforces `--max-budget-usd` with its own figure, which for a model it
 * does not know is another model's price (measured 36 times list price for Claude Haiku 5.5),
 * and a run it cuts off would read as a model stopping early. Turns and wall clock bound a run.
 */
function extraArgs(cli: Cli, options: Options): string[] {
  if (cli === 'claude-code')
    return [
      '--strict-mcp-config',
      '--no-session-persistence',
      '--max-turns',
      String(options.maxTurns),
    ];
  // The person's own Codex configuration (other MCP servers, plugins, notify
  // hooks) stays out of the run; authentication still comes from CODEX_HOME.
  // App plugins from the account's remote catalog are not covered by this
  // (see results/2026-10-14-v1-matrix.md, "After core fixes").
  return ['--ephemeral', '--ignore-user-config'];
}

export interface CellResult {
  cell: Cell;
  mode: 'model' | 'reference-good' | 'reference-bad';
  startedAt: string;
  sessionId: string | null;
  profile: string | null;
  profileSource: string | null;
  toolCount: number | null;
  success: boolean;
  verified: boolean | null;
  criteria: Criterion[];
  ledger: {
    calls: number;
    errors: number;
    repairs: number;
    tools: Record<string, number>;
    workStatusCalled: boolean;
    /** The host attached work_status to a committed check (alsoRan); not a call the agent made. */
    workStatusAttached: boolean;
    guideRead: string[];
    errorCodes: string[];
  };
  stream: StreamMetrics | null;
  run: {
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    promptDetected: string | null;
    durationMs: number;
  } | null;
  claims: string[];
  finalMessage: string;
  harnessError: string | null;
}

async function runCell(spec: Cell, options: Options, bins: { host: string; cli: string }) {
  const dir = path.join(options.out, spec.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // The bridge socket lives in the data directory, so it must be short.
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'ofe-'));
  const task = TASKS[spec.task];
  const startedAt = new Date().toISOString();
  const host = await EvalHost.start(bins.host, bins.cli, appData);
  const result: CellResult = {
    cell: spec,
    mode: options.reference ? `reference-${options.reference}` : 'model',
    startedAt,
    sessionId: null,
    profile: null,
    profileSource: null,
    toolCount: null,
    success: false,
    verified: null,
    criteria: [],
    ledger: {
      calls: 0,
      errors: 0,
      repairs: 0,
      tools: {},
      workStatusCalled: false,
      workStatusAttached: false,
      guideRead: [],
      errorCodes: [],
    },
    stream: null,
    run: null,
    claims: [],
    finalMessage: '',
    harnessError: null,
  };
  try {
    const created = await host.command('project.create', {
      path: path.join(dir, 'project'),
      name: 'Rover',
      intent: task.intent,
    });
    const projectId = created.projectId as string;
    const seed = await task.seed(host, projectId);
    const prompt = `${FRAMING}\n\n${task.prompt}`;
    fs.writeFileSync(path.join(dir, 'prompt.txt'), `${prompt}\n`);

    if (options.reference) {
      const session = await host.agentSession(
        projectId,
        spec.profile === 'auto' ? 'standard' : spec.profile,
      );
      result.sessionId = session.sessionId;
      result.profile = session.profile;
      const call: AgentCall = (tool, input) => {
        const env = { ...baseEnvironment('/usr/bin:/bin'), ...session.env };
        const ran = spawnSync(bins.cli, ['call', tool, '--input', '-'], {
          input: JSON.stringify(input),
          env,
          encoding: 'utf8',
        });
        if (ran.status !== 0) throw new Error(`${tool}: ${ran.stderr.trim()}`);
        return JSON.parse(ran.stdout);
      };
      result.finalMessage = task.reference[options.reference](call, seed);
      await host.revoke(session.sessionId);
    } else {
      const plan: LaunchPlan = await host.launch({
        projectId,
        adapterId: spec.cli,
        model: spec.model,
        profile: spec.profile,
        args: [],
      });
      result.sessionId = plan.sessionId;
      result.profile = plan.profile;
      result.profileSource = plan.profileSource;
      result.toolCount = plan.toolCount;
      fs.writeFileSync(
        path.join(dir, 'plan.json'),
        JSON.stringify(
          {
            ...plan,
            env: Object.fromEntries(
              Object.entries(plan.env).map(([key, value]) => [
                key,
                key.endsWith('TOKEN') ? '<redacted>' : value,
              ]),
            ),
            files: plan.files.map((file) => ({ path: file.path, bytes: file.contents.length })),
          },
          null,
          2,
        ),
      );
      const ran = await runPlan(plan, extraArgs(spec.cli, options), prompt, options.timeoutMs, dir);
      await host.revoke(plan.sessionId);
      result.run = {
        exitCode: ran.exitCode,
        signal: ran.signal,
        timedOut: ran.timedOut,
        promptDetected: ran.promptDetected,
        durationMs: ran.durationMs,
      };
      result.stream =
        spec.cli === 'claude-code' ? claudeMetrics(ran.stdoutLines) : codexMetrics(ran.stdoutLines);
      result.finalMessage = result.stream.finalMessage;
    }

    const activity = await host.command(
      'agent.activity',
      { limit: 500, sessionId: result.sessionId },
      projectId,
    );
    fs.writeFileSync(path.join(dir, 'activity.json'), JSON.stringify(activity, null, 2));
    const calls = (activity.calls as any[]).filter((call) => call.sessionId === result.sessionId);
    result.ledger = {
      calls: calls.length,
      errors: calls.filter((call) => !call.ok).length,
      repairs: calls.reduce((total, call) => total + (call.notes?.length ?? 0), 0),
      tools: calls.reduce<Record<string, number>>((tools, call) => {
        tools[call.op] = (tools[call.op] ?? 0) + 1;
        return tools;
      }, {}),
      workStatusCalled: calls.some((call) => call.op === 'work.status'),
      workStatusAttached: calls.some((call) =>
        (call.alsoRan ?? []).some((ran: { op?: unknown }) => ran.op === 'work.status'),
      ),
      guideRead: calls.filter((call) => call.op === 'guide.read').map((call) => call.tool),
      errorCodes: calls.filter((call) => !call.ok).map((call) => `${call.op} ${call.code}`),
    };

    const state = await captureState(host, projectId);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
    const judgement: Judgement = await task.judge({
      host,
      projectId,
      sessionId: result.sessionId!,
      state,
      seed,
      finalMessage: result.finalMessage,
    });
    result.criteria = judgement.criteria;
    result.verified = judgement.verified;
    result.claims = contradictions(result.finalMessage, {
      verified: judgement.verified === true,
      ready:
        state.sessionStatus.sessionId === result.sessionId && state.sessionStatus.ready === true,
      approved: false,
    });
    const clean =
      result.run === null ||
      (!result.run.timedOut && !result.run.promptDetected && result.run.exitCode === 0);
    result.success = clean && judgement.criteria.every((criterion) => criterion.pass);
  } catch (error) {
    result.harnessError = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    await host.shutdown();
    fs.rmSync(appData, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

const yesNo = (value: boolean | null) => (value === null ? '—' : value ? 'yes' : 'no');
const thousands = (value: number | undefined) =>
  value === undefined ? '—' : `${Math.round(value / 1000)}k`;

/** The results table for every `result.json` under the given directories. */
export function summary(dirs: string[]): string {
  const results = dirs.flatMap((dir) =>
    fs
      .readdirSync(dir)
      .map((name) => path.join(dir, name, 'result.json'))
      .filter((file) => fs.existsSync(file))
      .map((file) => JSON.parse(fs.readFileSync(file, 'utf8')) as CellResult),
  );
  const rows = results.map((r) => {
    const failed = r.criteria.filter((criterion) => !criterion.pass).map((c) => c.name);
    const why = r.harnessError
      ? `harness error: ${r.harnessError.split('\n')[0]}`
      : r.run?.timedOut
        ? 'timed out'
        : r.run?.promptDetected
          ? `CLI prompted: ${r.run.promptDetected}`
          : r.run && r.run.exitCode !== 0
            ? `exit ${r.run.exitCode} (${r.stream?.outcome ?? ''})`
            : failed.join('; ');
    return [
      r.cell.task,
      `${r.cell.cli} ${r.cell.model}`,
      `${r.cell.profile}${r.profile && r.cell.profile !== r.profile ? `→${r.profile}` : ''}`,
      r.success ? 'pass' : 'FAIL',
      yesNo(r.verified),
      String(r.ledger.calls),
      String(r.ledger.errors),
      String(r.ledger.repairs),
      yesNo(r.ledger.workStatusCalled),
      thousands(r.stream?.inputTokens),
      thousands(r.stream?.cachedInputTokens),
      r.stream ? String(r.stream.outputTokens) : '—',
      r.stream ? String(r.stream.turns) : '—',
      r.run ? `${Math.round(r.run.durationMs / 1000)} s` : '—',
      r.stream?.costUsd == null ? '—' : `$${r.stream.costUsd.toFixed(4)}`,
      why || '',
    ];
  });
  const header = [
    'task',
    'CLI / model',
    'profile',
    'success',
    'verified',
    'calls',
    'errors',
    'repairs',
    'work_status',
    'input tok',
    'cached',
    'output tok',
    'turns',
    'duration',
    'cost (list)',
    'failure',
  ];
  return [header, header.map(() => '---'), ...rows]
    .map((row) => `| ${row.join(' | ')} |`)
    .join('\n');
}

function parseArgs(argv: string[]): Options | { summary: string[] } {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  if (argv.includes('--summary'))
    return {
      summary: argv.slice(argv.indexOf('--summary') + 1).filter((arg) => !arg.startsWith('--')),
    };
  if (argv.includes('--budget-usd'))
    throw new Error(
      '--budget-usd is gone: Claude Code enforced it with its own price, which is wrong for models it does not know. Bound a run with --max-turns and --timeout-min; its list-price cost is estimated afterwards.',
    );
  const out = value('--out');
  if (!out) throw new Error('--out <dir> is required (outside the repository)');
  // The repository's own AGENTS.md would reach the model as instructions.
  if (!path.relative(REPO, path.resolve(out)).startsWith('..'))
    throw new Error(`--out must be outside the repository (${REPO})`);
  const wanted = value('--cells')?.split(',');
  const cells = wanted ? MATRIX.filter((spec) => wanted.includes(spec.id)) : MATRIX;
  if (wanted && cells.length !== wanted.length)
    throw new Error(
      `unknown cell in --cells; known cells:\n${MATRIX.map((spec) => spec.id).join('\n')}`,
    );
  const reference = value('--reference');
  if (reference && reference !== 'good' && reference !== 'bad')
    throw new Error('--reference is good or bad');
  return {
    out: path.resolve(out),
    cells,
    concurrency: Number(value('--concurrency') ?? 2),
    timeoutMs: Number(value('--timeout-min') ?? 10) * 60_000,
    maxTurns: Number(value('--max-turns') ?? 40),
    hostBin: value('--host-bin') ?? null,
    cliBin: value('--cli-bin') ?? null,
    reference: (reference as 'good' | 'bad' | undefined) ?? null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if ('summary' in options) {
    console.log(summary(options.summary));
    return;
  }
  const bins =
    options.hostBin && options.cliBin
      ? { host: options.hostBin, cli: options.cliBin }
      : buildBinaries();
  fs.mkdirSync(options.out, { recursive: true });
  const queue = [...options.cells];
  const aborted = new Set<Cli>();
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      if (aborted.has(next.cli)) {
        console.log(`skip ${next.id}: an earlier ${next.cli} run asked for confirmation`);
        continue;
      }
      console.log(`start ${next.id}`);
      const result = await runCell(next, options, bins);
      if (result.run?.promptDetected) aborted.add(next.cli);
      const failed = result.criteria.filter((criterion) => !criterion.pass).map((c) => c.name);
      console.log(
        `done  ${next.id}: ${result.success ? 'pass' : 'FAIL'}${result.harnessError ? ` (harness: ${result.harnessError.split('\n')[0]})` : ''}${failed.length ? ` [${failed.join('; ')}]` : ''}`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));
  const table = summary([options.out]);
  fs.writeFileSync(path.join(options.out, 'summary.md'), `${table}\n`);
  console.log(table);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
