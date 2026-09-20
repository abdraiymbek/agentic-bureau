/**
 * Runs one CAD task through the real Omen Flow agent stack:
 *
 *   CoreApp (real OpenSCAD tools) ← BridgeServer ← MCP ← `omenflow mcp` shim
 *   ← Codex CLI (`codex exec`, model pinned) ← task prompt
 *
 * then evaluates the project state deterministically (evals/cad/checks.ts).
 * The agent's deliverable is the newest revision of the target mechanical
 * artifact; its OpenSCAD source is re-rendered here, independently of any
 * render the agent ran, so the source itself is what is judged.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_OPS, newId, type Origin } from '@omenflow/contracts';
import { CoreApp, nullHost } from '@omenflow/core';
import { createEngineTools } from '@omenflow/engineering';
import { parseStlTriangles, type TriangleBuffer } from '@omenflow/core';
import { BridgeServer, CodexAdapter, writeBootstrapBrief } from '@omenflow/agent-host';
import { connectMcpToBridge } from '@omenflow/mcp-server';
import { preservationCheck, runChecks, type CheckResult } from './checks.js';
import type { Task } from './tasks.js';

const USER: Origin = { kind: 'user' };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SHIM = path.join(REPO, 'packages/agent-host/bin/omenflow.mjs');

export interface RunOptions {
  model: string;
  reasoningEffort: string;
  outDir: string;
  timeoutMs: number;
  /** Sub-directory name for this run (e.g. `r1`). */
  runName: string;
  /** Text placed before the task prompt (kept constant across before/after runs). */
  framing: string;
  /** Extra `codex exec` args (e.g. config overrides under test). */
  extraCodexArgs?: string[];
  /** Ignore the developer's ~/.codex/config.toml so only Omen Flow's MCP is present. */
  ignoreUserConfig?: boolean;
}

export interface TraceMetrics {
  durationMs: number;
  turns: number;
  agentMessages: number;
  reasoningItems: number;
  toolCalls: number;
  toolErrors: number;
  toolCallsByName: Record<string, number>;
  shellCommands: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  exitCode: number | null;
  timedOut: boolean;
  finalMessage: string;
  /** Deterministic verification calls the agent made (cad_check via MCP or CLI). */
  checkCalls: number;
  /** Result of the agent's last cad_check, if any. */
  lastCheckPassed: boolean | null;
}

export interface TaskResult {
  taskId: string;
  runName: string;
  category: string;
  pass: boolean;
  checks: CheckResult[];
  metrics: TraceMetrics;
  scadPath: string | null;
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* Project + bridge                                                    */
/* ------------------------------------------------------------------ */

async function seedProject(app: CoreApp, projectId: string, task: Task): Promise<string | null> {
  if (!task.seed) return null;
  const created = (await app.dispatch(
    'artifact.create_draft',
    {
      type: 'mechanical',
      title: task.seed.title,
      payload: { params: task.seed.params ?? {}, modelUnit: 'mm' },
      files: [
        { path: task.seed.path, contentBase64: Buffer.from(task.seed.scad).toString('base64') },
      ],
      rationale: 'seeded baseline',
    },
    USER,
    projectId,
  )) as { artifact: { id: string }; revision: { id: string } };
  await app.dispatch(
    'artifact.accept_draft',
    {
      artifactId: created.artifact.id,
      draftRevisionId: created.revision.id,
      rationale: 'baseline',
    },
    USER,
    projectId,
  );
  return created.artifact.id;
}

function makeShimDir(root: string): string {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const wrapper = path.join(bin, 'omenflow');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${SHIM}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  return bin;
}

/* ------------------------------------------------------------------ */
/* Codex exec                                                          */
/* ------------------------------------------------------------------ */

interface CodexRun {
  exitCode: number | null;
  timedOut: boolean;
  events: Record<string, unknown>[];
  stderr: string;
  durationMs: number;
}

function runCodex(
  exe: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
  traceFile: string,
): Promise<CodexRun> {
  return new Promise((resolve) => {
    const started = Date.now();
    const events: Record<string, unknown>[] = [];
    const trace = fs.createWriteStream(traceFile);
    let stderr = '';
    let buf = '';
    let timedOut = false;
    const child = spawn(exe, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      buf += String(d);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        trace.write(line + '\n');
        try {
          events.push(JSON.parse(line));
        } catch {
          events.push({ type: 'raw', text: line });
        }
      }
    });
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('close', (code) => {
      clearTimeout(timer);
      trace.end();
      resolve({ exitCode: code, timedOut, events, stderr, durationMs: Date.now() - started });
    });
  });
}

function metricsFrom(run: CodexRun): TraceMetrics {
  const m: TraceMetrics = {
    durationMs: run.durationMs,
    turns: 0,
    agentMessages: 0,
    reasoningItems: 0,
    toolCalls: 0,
    toolErrors: 0,
    toolCallsByName: {},
    shellCommands: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    finalMessage: '',
    checkCalls: 0,
    lastCheckPassed: null,
  };
  const noteCheck = (text: string) => {
    m.checkCalls++;
    const hit = /"pass":\s*(true|false)/.exec(text);
    if (hit) m.lastCheckPassed = hit[1] === 'true';
  };
  for (const ev of run.events) {
    const type = ev.type as string;
    if (type === 'turn.completed') {
      m.turns++;
      const u = (ev.usage ?? {}) as Record<string, number>;
      m.inputTokens += u.input_tokens ?? 0;
      m.cachedInputTokens += u.cached_input_tokens ?? 0;
      m.outputTokens += u.output_tokens ?? 0;
      m.reasoningTokens += u.reasoning_output_tokens ?? 0;
    }
    if (type !== 'item.completed') continue;
    const item = ev.item as Record<string, unknown>;
    switch (item.type) {
      case 'agent_message':
        m.agentMessages++;
        m.finalMessage = String(item.text ?? '');
        break;
      case 'reasoning':
        m.reasoningItems++;
        break;
      case 'command_execution': {
        m.shellCommands++;
        const cmd = String(item.command ?? '');
        if (/omenflow call cad\.check/.test(cmd)) noteCheck(String(item.aggregated_output ?? ''));
        break;
      }
      case 'mcp_tool_call': {
        m.toolCalls++;
        const name = String(item.tool ?? item.name ?? 'unknown');
        m.toolCallsByName[name] = (m.toolCallsByName[name] ?? 0) + 1;
        const status = String(item.status ?? '');
        const result = item.result as
          { isError?: boolean; content?: { type: string; text?: string }[] } | undefined;
        if (status === 'failed' || result?.isError || item.error) m.toolErrors++;
        if (name === 'cad_check') {
          noteCheck((result?.content ?? []).map((c) => c.text ?? '').join('\n'));
        }
        break;
      }
      default:
        break;
    }
  }
  return m;
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

function openscadExe(): string {
  for (const p of [
    '/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD',
    '/opt/homebrew/bin/openscad',
    '/usr/bin/openscad',
  ]) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('OpenSCAD not found for evaluation');
}

export function renderScad(
  scad: string,
  outDir: string,
  name: string,
  params: Record<string, number | string | boolean> = {},
): { tris: TriangleBuffer; stderr: string } | { error: string; stderr: string } {
  const src = path.join(outDir, `${name}.scad`);
  const stl = path.join(outDir, `${name}.stl`);
  fs.writeFileSync(src, scad);
  const args = ['-o', stl, '--export-format', 'binstl'];
  for (const [k, v] of Object.entries(params)) {
    const val = typeof v === 'string' ? `"${v}"` : String(v);
    args.push('-D', `${k}=${val}`);
  }
  args.push(src);
  try {
    const stderr = execFileSync(openscadExe(), args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    if (!fs.existsSync(stl) || fs.statSync(stl).size === 0) return { error: 'no output', stderr };
    return { tris: parseStlTriangles(fs.readFileSync(stl)), stderr };
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    return { error: err.message, stderr: err.stderr ?? '' };
  }
}

function paramValues(
  params: Record<string, unknown> | undefined,
): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v && typeof v === 'object' && 'value' in v) out[k] = (v as { value: number }).value;
    else if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

export async function evaluateProject(
  app: CoreApp,
  projectId: string,
  task: Task,
  seededArtifactId: string | null,
  outDir: string,
): Promise<{ checks: CheckResult[]; scadPath: string | null; notes: string[] }> {
  const notes: string[] = [];
  const checks: CheckResult[] = [];
  const ctx = app.contextFor(projectId);
  const mechs = ctx.repo.listArtifacts({ type: 'mechanical' });

  let target = seededArtifactId ? mechs.find((a) => a.id === seededArtifactId) : undefined;
  if (!target) {
    if (seededArtifactId)
      notes.push('seeded artifact missing; falling back to newest mechanical artifact');
    target = [...mechs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }
  const expectedCount = task.artifactCount ?? 1;
  if (mechs.length !== expectedCount) {
    notes.push(`${mechs.length} mechanical artifact(s) present, expected ${expectedCount}`);
  }
  if (!target) {
    return {
      checks: [{ name: 'deliverable', pass: false, detail: 'no mechanical artifact in project' }],
      scadPath: null,
      notes,
    };
  }

  const revisions = ctx.repo.listRevisions(target.id);
  const latest = revisions[revisions.length - 1]!;
  if (task.seed) {
    checks.push({
      name: 'new revision on the same artifact',
      pass: revisions.length > 1,
      detail: `${revisions.length} revision(s) on "${target.title}"`,
    });
  }
  const payload = latest.payload as {
    scad?: { path: string; sha256?: string };
    stl?: { sha256?: string };
    params?: Record<string, unknown>;
    modelUnit?: string;
  };
  const scadRef = payload.scad ?? latest.files.find((f) => f.path.endsWith('.scad'));
  if (!scadRef?.sha256 || !ctx.objects.has(scadRef.sha256)) {
    checks.push({
      name: 'deliverable',
      pass: false,
      detail: 'latest revision has no .scad source',
    });
    return { checks, scadPath: null, notes };
  }
  const scad = ctx.objects.read(scadRef.sha256).toString('utf8');
  const scadPath = path.join(outDir, 'delivered.scad');
  fs.writeFileSync(scadPath, scad);

  const stlRef = payload.stl ?? latest.files.find((f) => f.path.endsWith('.stl'));
  const rendered = revisions.some((r) => {
    const p = r.payload as { stl?: { sha256?: string } };
    return !!(p.stl?.sha256 ?? r.files.find((f) => f.path.endsWith('.stl'))?.sha256);
  });
  checks.push({
    name: 'rendered by agent',
    pass: rendered,
    detail: rendered
      ? `STL present${stlRef ? ' on latest revision' : ' on an earlier revision only'}`
      : 'agent never produced a render for this artifact',
  });
  if ((payload.modelUnit ?? 'mm') !== 'mm') notes.push(`modelUnit is ${payload.modelUnit}`);

  const render = renderScad(scad, outDir, 'delivered', paramValues(payload.params));
  if ('error' in render) {
    checks.push({
      name: 'source renders',
      pass: false,
      detail: `${render.error}\n${render.stderr.slice(0, 500)}`,
    });
    return { checks, scadPath, notes };
  }
  const warnings = render.stderr.split('\n').filter((l) => /WARNING|ERROR/.test(l));
  checks.push({
    name: 'source renders cleanly',
    pass: warnings.length === 0,
    detail: warnings.length ? warnings.slice(0, 3).join(' | ') : 'no OpenSCAD warnings',
  });
  checks.push(...runChecks(render.tris, task.expect));

  for (const [i, variant] of (task.variants ?? []).entries()) {
    const vr = renderScad(scad, outDir, `variant-${i}`, {
      ...paramValues(payload.params),
      ...variant.params,
    });
    const label = `variant ${JSON.stringify(variant.params)}`;
    if ('error' in vr) {
      checks.push({ name: label, pass: false, detail: `render failed: ${vr.error}` });
      continue;
    }
    for (const c of runChecks(vr.tris, variant.expect))
      checks.push({ ...c, name: `${label}: ${c.name}` });
  }

  if (task.seed && task.changeRegions) {
    const orig = renderScad(task.seed.scad, outDir, 'seed', paramValues(task.seed.params));
    if (!('error' in orig))
      checks.push(preservationCheck(orig.tris, render.tris, task.changeRegions));
  }
  return { checks, scadPath, notes };
}

/* ------------------------------------------------------------------ */
/* Run one task                                                        */
/* ------------------------------------------------------------------ */

export async function runTask(task: Task, opts: RunOptions): Promise<TaskResult> {
  const outDir = path.join(opts.outDir, opts.runName);
  fs.mkdirSync(outDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `omenflow-eval-${task.id}-`));
  const appData = path.join(root, 'appdata');
  const projectDir = path.join(root, 'project');

  const app = new CoreApp(appData, nullHost);
  app.engineTools = createEngineTools();
  const created = (await app.dispatch(
    'project.create',
    { name: `Eval: ${task.id}`, path: projectDir, intent: 'CAD capability evaluation project.' },
    USER,
  )) as { projectId: string };
  const projectId = created.projectId;
  const ctx = app.contextFor(projectId);
  const seededId = await seedProject(app, projectId, task);

  // Unix socket paths are capped (~104 bytes on macOS) — keep it short.
  const sockDir = fs.mkdtempSync('/tmp/ofe-');
  const bridge = new BridgeServer(app, { socketPath: path.join(sockDir, 'b.sock') });
  bridge.onMcpConnection = (sock, grant, buffered) =>
    void connectMcpToBridge(sock, app, grant, buffered);
  await bridge.ready;

  const sessionId = newId();
  const token = bridge.issueToken({ projectId, sessionId, ops: [...AGENT_OPS] });
  const bootstrapPath = writeBootstrapBrief(ctx, sessionId);
  const bridgeEnv = {
    OMENFLOW_BRIDGE_SOCK: bridge.socketPath,
    OMENFLOW_BRIDGE_TOKEN: token,
    OMENFLOW_PROJECT_ID: projectId,
    OMENFLOW_SESSION_ID: sessionId,
  };
  const adapter = new CodexAdapter(() => ({}));
  const spec = await adapter.launchSpec({ ctx, sessionId, config: {}, bridgeEnv, bootstrapPath });

  const shimDir = makeShimDir(root);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...spec.env,
    PATH: [shimDir, spec.env.PATH ?? process.env.PATH ?? ''].join(path.delimiter),
  };
  const prompt = `${opts.framing}\n\n${task.prompt}`;
  fs.writeFileSync(path.join(outDir, 'prompt.md'), prompt);
  const lastMsg = path.join(outDir, 'last-message.md');
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    ...(opts.ignoreUserConfig ? ['--ignore-user-config'] : []),
    '-m',
    opts.model,
    '-c',
    `model_reasoning_effort="${opts.reasoningEffort}"`,
    '-c',
    'approval_policy="never"',
    // Stand-in for the human clicking "approve" on each Omen Flow tool call in
    // the interactive TUI. (Codex denies un-annotated MCP tools under
    // approval_policy=never; see Phase 1 findings.)
    '-c',
    'mcp_servers.omenflow.default_tools_approval_mode="approve"',
    '-o',
    lastMsg,
    ...spec.args,
    ...(opts.extraCodexArgs ?? []),
    prompt,
  ];
  fs.writeFileSync(path.join(outDir, 'codex-args.json'), JSON.stringify(args, null, 2));

  const events: unknown[] = [];
  ctx.listeners.add((e) =>
    events.push({ at: new Date().toISOString(), type: e.type, data: e.data }),
  );

  const run = await runCodex(
    spec.path,
    args,
    env,
    projectDir,
    opts.timeoutMs,
    path.join(outDir, 'trace.jsonl'),
  );
  fs.writeFileSync(path.join(outDir, 'stderr.txt'), run.stderr);
  fs.writeFileSync(path.join(outDir, 'project-events.json'), JSON.stringify(events, null, 2));

  // Let any in-flight render job settle before judging.
  await new Promise((r) => setTimeout(r, 1500));
  const metrics = metricsFrom(run);
  const evalResult = await evaluateProject(app, projectId, task, seededId, outDir);

  // Keep the project folder for forensic inspection.
  const keep = path.join(outDir, 'project');
  fs.rmSync(keep, { recursive: true, force: true });
  bridge.revoke(sessionId);
  await bridge.close();
  app.closeAll();
  fs.cpSync(projectDir, keep, { recursive: true });
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(sockDir, { recursive: true, force: true });

  const pass = evalResult.checks.every((c) => c.pass);
  const result: TaskResult = {
    taskId: task.id,
    runName: opts.runName,
    category: task.category,
    pass,
    checks: evalResult.checks,
    metrics,
    scadPath: evalResult.scadPath,
    notes: evalResult.notes,
  };
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

export function formatResult(r: TaskResult): string {
  const lines = [
    `## ${r.taskId} ${r.runName} (${r.category}) — ${r.pass ? 'PASS' : 'FAIL'}`,
    ...r.checks.map((c) => `- ${c.pass ? '✓' : '✗'} ${c.name}: ${c.detail}`),
    ...(r.notes.length ? ['', ...r.notes.map((n) => `  note: ${n}`)] : []),
    '',
    `  turns ${r.metrics.turns} · tool calls ${r.metrics.toolCalls} (errors ${r.metrics.toolErrors}) · shell ${r.metrics.shellCommands} · ` +
      `${(r.metrics.durationMs / 1000).toFixed(0)}s · in ${r.metrics.inputTokens} (cached ${r.metrics.cachedInputTokens}) out ${r.metrics.outputTokens} (reasoning ${r.metrics.reasoningTokens})` +
      (r.metrics.timedOut ? ' · TIMED OUT' : '') +
      (r.metrics.exitCode ? ` · exit ${r.metrics.exitCode}` : ''),
    `  tools: ${
      Object.entries(r.metrics.toolCallsByName)
        .map(([k, v]) => `${k}×${v}`)
        .join(', ') || 'none'
    }` +
      ` · verification: ${r.metrics.checkCalls} cad_check call(s)${r.metrics.lastCheckPassed === null ? '' : r.metrics.lastCheckPassed ? ', last passed' : ', last FAILED'}`,
    '',
  ];
  return lines.join('\n');
}
