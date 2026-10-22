/**
 * Running an agent CLI from a host launch plan, non-interactively, and
 * reading what its event stream says about the run.
 *
 * The child gets PATH, HOME, USER, LANG and TMPDIR plus the plan's own
 * variables, nothing else. It runs in its own process group so a timeout
 * stops the CLI and every MCP server it started.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { baseEnvironment, type LaunchPlan } from './host.js';
import { estimateClaudeRun, PRICES_AS_OF } from './pricing.js';

export interface CliRun {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Set when the CLI asked for an update or a confirmation; the run was stopped. */
  promptDetected: string | null;
  durationMs: number;
  stdoutLines: string[];
  stderr: string;
}

/** Text a CLI prints when it waits for a person. Never answered: the run is stopped. */
const PROMPTS = [
  /update now/i,
  /would you like to (update|install|continue)/i,
  /\[y\/n\]/i,
  /\(y\/n\)/i,
  /press enter/i,
  /do you trust/i,
];

/**
 * Write the plan's files, spawn its executable with the prompt on standard
 * input, and wait for it to exit or for the wall-clock limit.
 */
export function runPlan(
  plan: LaunchPlan,
  extraArgs: string[],
  prompt: string,
  timeoutMs: number,
  logDir: string,
): Promise<CliRun> {
  for (const file of plan.files) {
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    fs.writeFileSync(file.path, file.contents, { mode: 0o600 });
  }
  const env = baseEnvironment(plan.env.PATH ?? '/usr/bin:/bin');
  for (const [key, value] of Object.entries(plan.envDefaults)) env[key] ??= value;
  Object.assign(env, plan.env);
  const args = [...plan.args];
  // Extra flags go before the plan's trailing `-` (Codex reads the prompt there).
  const tail = args.at(-1) === '-' ? args.pop() : undefined;
  args.push(...extraArgs);
  if (tail) args.push(tail);
  fs.writeFileSync(
    path.join(logDir, 'command.json'),
    JSON.stringify(
      { executable: plan.executable, args, cwd: plan.cwd, envKeys: Object.keys(env).sort() },
      null,
      2,
    ),
  );

  const started = Date.now();
  const child = spawn(plan.executable, args, {
    cwd: plan.cwd,
    env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const events = fs.createWriteStream(path.join(logDir, 'events.jsonl'));
  const stdoutLines: string[] = [];
  let pending = '';
  let stderr = '';
  let promptDetected: string | null = null;
  let timedOut = false;

  const stopGroup = () => {
    if (child.pid === undefined || child.exitCode !== null) return;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      return;
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }, 5_000).unref();
  };
  const watch = (text: string) => {
    if (promptDetected) return;
    const match = PROMPTS.find((pattern) => pattern.test(text));
    if (match) {
      promptDetected = text.trim().slice(0, 300);
      stopGroup();
    }
  };

  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    events.write(chunk);
    pending += chunk;
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end).trim();
      pending = pending.slice(end + 1);
      if (!line) continue;
      stdoutLines.push(line);
      if (!line.startsWith('{')) watch(line);
    }
  });
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    stderr += chunk;
    watch(chunk);
  });
  child.stdin!.end(`${prompt}\n`);

  const timer = setTimeout(() => {
    timedOut = true;
    stopGroup();
  }, timeoutMs);

  return new Promise((resolve) => {
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (pending.trim()) stdoutLines.push(pending.trim());
      events.end();
      fs.writeFileSync(path.join(logDir, 'stderr.log'), stderr);
      // Whatever the CLI left running in its group goes too.
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group is empty.
      }
      for (const file of plan.files) fs.rmSync(file.path, { force: true });
      resolve({
        exitCode: code,
        signal,
        timedOut,
        promptDetected,
        durationMs: Date.now() - started,
        stdoutLines,
        stderr,
      });
    });
  });
}

/** What the CLI's own event stream reports. Never used to judge the work. */
export interface StreamMetrics {
  /** Every input token the model processed, cached or not. */
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  turns: number;
  /**
   * Omen Flow's estimate at list price (pricing.ts, as of `PRICES_AS_OF`); null when a model
   * that ran has no price, and for Codex, which reports none.
   */
  costUsd: number | null;
  /** The table the estimate used. */
  pricesAsOf: string | null;
  /** Models that ran without a price, so `costUsd` is null. */
  unpricedModels: string[];
  /**
   * The CLI's own figure, kept for audit only: Claude Code prices a model it does not know at
   * another model's rates.
   */
  cliCostUsd: number | null;
  /** The model the CLI said it runs (Claude Code's init event). */
  model: string | null;
  /** Tokens per model as the CLI reported them, without its cost figures. */
  modelUsage: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
    }
  > | null;
  finalMessage: string;
  /** How the CLI says the run ended (`success`, `error_max_turns`, …). */
  outcome: string;
  /** Tool calls by name as the CLI made them (MCP and built-in). */
  toolCalls: Record<string, number>;
  /** Calls to tools that are not Omen Flow's (shell, file reads, web). */
  otherToolCalls: number;
  /** Tool uses the CLI refused under its permission mode. */
  permissionDenials: number;
  /** Whether the Omen Flow MCP server was connected when the run started. */
  mcpConnected: boolean | null;
  /** Playbook topics the model asked guide_read for, in order. */
  guideTopics: string[];
}

const OMEN = /^(mcp__omenflow__|omenflow[_.:/])/;

function parse(lines: string[]): Record<string, any>[] {
  return lines.flatMap((line) => {
    try {
      const event = JSON.parse(line);
      return event && typeof event === 'object' ? [event] : [];
    } catch {
      return [];
    }
  });
}

export function claudeMetrics(lines: string[]): StreamMetrics {
  const events = parse(lines);
  const metrics: StreamMetrics = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    turns: 0,
    costUsd: null,
    pricesAsOf: PRICES_AS_OF,
    unpricedModels: [],
    cliCostUsd: null,
    model: null,
    modelUsage: null,
    finalMessage: '',
    outcome: 'no_result',
    toolCalls: {},
    otherToolCalls: 0,
    permissionDenials: 0,
    mcpConnected: null,
    guideTopics: [],
  };
  let lastText = '';
  for (const event of events) {
    if (event.type === 'system' && event.subtype === 'init') {
      if (typeof event.model === 'string') metrics.model = event.model;
      const servers = (event.mcp_servers ?? []) as { name: string; status: string }[];
      metrics.mcpConnected = servers.some(
        (server) => server.name === 'omenflow' && server.status === 'connected',
      );
    }
    if (event.type === 'assistant') {
      for (const block of (event.message?.content ?? []) as any[]) {
        if (block.type === 'text' && typeof block.text === 'string') lastText = block.text;
        if (block.type !== 'tool_use') continue;
        const name = String(block.name);
        metrics.toolCalls[name] = (metrics.toolCalls[name] ?? 0) + 1;
        if (!OMEN.test(name)) metrics.otherToolCalls += 1;
        if (name.endsWith('guide_read'))
          metrics.guideTopics.push(String(block.input?.topic ?? 'start'));
      }
    }
    if (event.type === 'result') {
      const usage = event.usage ?? {};
      metrics.inputTokens =
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0);
      metrics.cachedInputTokens = usage.cache_read_input_tokens ?? 0;
      metrics.outputTokens = usage.output_tokens ?? 0;
      metrics.turns = event.num_turns ?? 0;
      metrics.cliCostUsd = typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null;
      if (event.modelUsage && typeof event.modelUsage === 'object')
        metrics.modelUsage = Object.fromEntries(
          Object.entries(event.modelUsage as Record<string, Record<string, unknown>>).map(
            ([model, usage]) => [
              model,
              {
                inputTokens: Number(usage.inputTokens ?? 0),
                outputTokens: Number(usage.outputTokens ?? 0),
                cacheReadInputTokens: Number(usage.cacheReadInputTokens ?? 0),
                cacheCreationInputTokens: Number(usage.cacheCreationInputTokens ?? 0),
              },
            ],
          ),
        );
      metrics.outcome = String(event.subtype ?? 'result');
      metrics.permissionDenials = Array.isArray(event.permission_denials)
        ? event.permission_denials.length
        : 0;
      if (typeof event.result === 'string') metrics.finalMessage = event.result;
    }
  }
  if (!metrics.finalMessage) metrics.finalMessage = lastText;
  const estimate = estimateClaudeRun(events);
  metrics.costUsd = estimate.usd;
  metrics.unpricedModels = estimate.unpriced;
  return metrics;
}

export function codexMetrics(lines: string[]): StreamMetrics {
  const metrics: StreamMetrics = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    turns: 0,
    costUsd: null,
    pricesAsOf: null,
    unpricedModels: [],
    cliCostUsd: null,
    model: null,
    modelUsage: null,
    finalMessage: '',
    outcome: 'no_result',
    toolCalls: {},
    otherToolCalls: 0,
    permissionDenials: 0,
    mcpConnected: null,
    guideTopics: [],
  };
  for (const event of parse(lines)) {
    if (event.type === 'turn.completed') {
      metrics.turns += 1;
      metrics.outcome = 'success';
      const usage = event.usage ?? {};
      metrics.inputTokens += usage.input_tokens ?? 0;
      metrics.cachedInputTokens += usage.cached_input_tokens ?? 0;
      metrics.outputTokens += usage.output_tokens ?? 0;
    }
    if (event.type === 'turn.failed' || event.type === 'error') {
      metrics.outcome = `${event.type}: ${String(event.error?.message ?? event.message ?? '').slice(0, 200)}`;
    }
    if (event.type !== 'item.completed') continue;
    const item = event.item ?? {};
    if (item.type === 'agent_message') metrics.finalMessage = String(item.text ?? '');
    if (item.type === 'mcp_tool_call') {
      const name = `${item.server ?? 'mcp'}:${item.tool ?? 'unknown'}`;
      metrics.toolCalls[name] = (metrics.toolCalls[name] ?? 0) + 1;
      if (item.server !== 'omenflow') metrics.otherToolCalls += 1;
      else metrics.mcpConnected = true;
      if (item.tool === 'guide_read') {
        const args =
          typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments;
        metrics.guideTopics.push(String(args?.topic ?? 'start'));
      }
    }
    if (item.type === 'command_execution' || item.type === 'web_search') {
      const name = item.type === 'web_search' ? 'web_search' : 'shell';
      metrics.toolCalls[name] = (metrics.toolCalls[name] ?? 0) + 1;
      metrics.otherToolCalls += 1;
    }
  }
  return metrics;
}
