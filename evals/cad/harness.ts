/**
 * Runs one CAD task through the real Omen Flow agent stack:
 *
 *   CoreApp (real OpenSCAD tools) ← BridgeServer ← MCP ← `omenflow mcp` shim
 *   ← Codex CLI (`codex exec`, model pinned) ← task prompt
 *
 * then evaluates the project state deterministically (evals/cad/checks.ts).
 * The agent's deliverable is the active, non-rejected revision of the target mechanical
 * artifact; its OpenSCAD source is re-rendered here, independently of any
 * render the agent ran, so the source itself is what is judged.
 */
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_OPS, newId, type Origin, type MechanicalPayload } from '@omenflow/contracts';
import { CoreApp, nullHost, latestCadVerification } from '@omenflow/core';
import {
  canonicalScadRef,
  effectiveCadParams,
  renderMatchesInput,
} from '../../packages/core/src/cad-input.js';
import { createEngineTools } from '@omenflow/engineering';
import { assertMeshByteLimit, parseStlTriangles, type TriangleBuffer } from '@omenflow/core';
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
  /** Whether matching persisted verification passed for the final delivered revision. */
  lastCheckPassed: boolean | null;
  finalRevisionId?: string | null;
  verificationEvidenceHash?: string | null;
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

export interface CodexRun {
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
    child.on('error', (error) => {
      stderr += `\n${error.message}`;
      events.push({ type: 'error', message: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buf.trim()) {
        trace.write(buf + '\n');
        try {
          events.push(JSON.parse(buf));
        } catch {
          events.push({ type: 'raw', text: buf });
        }
      }
      trace.end();
      resolve({ exitCode: code, timedOut, events, stderr, durationMs: Date.now() - started });
    });
  });
}

export function metricsFrom(run: CodexRun): TraceMetrics {
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
        if (/omenflow call cad\.check/.test(cmd)) m.checkCalls++;
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
          m.checkCalls++;
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
  if (process.env.OMENFLOW_EVAL_OPENSCAD) return process.env.OMENFLOW_EVAL_OPENSCAD;
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
  // A previous successful render must not survive a failed or empty rerender.
  fs.rmSync(stl, { force: true });
  const args = ['-o', stl, '--export-format', 'binstl'];
  for (const [k, v] of Object.entries(params)) {
    const val = JSON.stringify(v);
    args.push('-D', `${k}=${val}`);
  }
  args.push(src);
  try {
    const result = spawnSync(openscadExe(), args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    const stderr = result.stderr ?? '';
    if (result.error || result.status !== 0)
      return {
        error:
          result.error?.message ??
          `OpenSCAD exited ${result.status}${result.signal ? ` (${result.signal})` : ''}`,
        stderr,
      };
    if (!fs.existsSync(stl) || fs.statSync(stl).size === 0) return { error: 'no output', stderr };
    assertMeshByteLimit(fs.statSync(stl).size);
    return { tris: parseStlTriangles(fs.readFileSync(stl)), stderr };
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    return { error: err.message, stderr: err.stderr ?? '' };
  }
}

export function providerRunChecks(run: CodexRun): CheckResult[] {
  return [
    {
      name: 'provider completed successfully',
      pass: run.exitCode === 0 && !run.timedOut,
      detail: run.timedOut ? 'provider timed out' : `provider exit ${run.exitCode ?? 'unknown'}`,
    },
    {
      name: 'provider completed a turn without fatal errors',
      pass:
        run.events.some((e) => e.type === 'turn.completed') &&
        !run.events.some((e) => ['error', 'turn.failed', 'thread.failed'].includes(String(e.type))),
      detail: `${run.events.filter((e) => e.type === 'turn.completed').length} completed turn(s); fatal provider events are disqualifying`,
    },
  ];
}

interface EvaluationResult {
  checks: CheckResult[];
  scadPath: string | null;
  notes: string[];
  finalRevisionId: string | null;
  finalCheckPassed: boolean | null;
  verificationEvidenceHash: string | null;
}

export async function evaluateProject(
  app: CoreApp,
  projectId: string,
  task: Task,
  seededArtifactId: string | null,
  outDir: string,
  render: typeof renderScad = renderScad,
): Promise<EvaluationResult> {
  const notes: string[] = [];
  const checks: CheckResult[] = [];
  const ctx = app.contextFor(projectId);
  const mechs = ctx.repo.listArtifacts({ type: 'mechanical' });

  let target = seededArtifactId ? mechs.find((a) => a.id === seededArtifactId) : undefined;
  if (!target && !seededArtifactId) {
    target = [...mechs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }
  const expectedCount = task.artifactCount ?? 1;
  checks.push({
    name: 'mechanical artifact count',
    pass: mechs.length === expectedCount,
    detail: `${mechs.length} mechanical artifact(s) present, expected ${expectedCount}`,
  });
  const result: EvaluationResult = {
    checks,
    scadPath: null,
    notes,
    finalRevisionId: null,
    finalCheckPassed: null,
    verificationEvidenceHash: null,
  };
  if (!target) {
    checks.push({
      name: 'deliverable',
      pass: false,
      detail: seededArtifactId
        ? 'seeded artifact is missing or archived; replacement artifacts cannot satisfy a modification task'
        : 'no mechanical artifact in project',
    });
    return result;
  }

  const revisions = ctx.repo.listRevisions(target.id);
  const latest = revisions
    .filter(
      (r) =>
        r.reviewState === 'draft' ||
        r.reviewState === 'proposed' ||
        r.id === target.selectedRevisionId,
    )
    .filter((r) => r.reviewState !== 'rejected' && r.reviewState !== 'superseded')
    .at(-1);
  if (!latest) {
    checks.push({
      name: 'deliverable',
      pass: false,
      detail: 'no active candidate or selected baseline revision',
    });
    return result;
  }
  result.finalRevisionId = latest.id;
  if (task.seed) {
    checks.push({
      name: 'new revision on the same artifact',
      pass: latest.seq > 1,
      detail: `final active revision ${latest.seq} on "${target.title}"; rejected history is excluded`,
    });
  }
  const payload = latest.payload as MechanicalPayload;
  const scadRef = canonicalScadRef(latest);
  if (!scadRef?.sha256 || !ctx.objects.has(scadRef.sha256)) {
    checks.push({
      name: 'deliverable',
      pass: false,
      detail: 'final active revision has no stored .scad source',
    });
    return result;
  }
  const scad = ctx.objects.read(scadRef.sha256).toString('utf8');
  const scadPath = path.join(outDir, 'delivered.scad');
  result.scadPath = scadPath;
  fs.writeFileSync(scadPath, scad);

  const stlRef = latest.files.find((f) => f.path === payload.stl?.path) ?? payload.stl;
  let rendered = false;
  try {
    rendered =
      renderMatchesInput(payload, latest.files) &&
      !!stlRef?.sha256 &&
      ctx.objects.has(stlRef.sha256);
  } catch {
    /* invalid units/parameters are not a valid render */
  }
  checks.push({
    name: 'final revision rendered by agent',
    pass: rendered,
    detail: rendered
      ? 'stored STL matches the final source, parameters and render identity'
      : 'no matching render on the final revision; historical meshes do not count',
  });
  const verification = rendered
    ? latestCadVerification(ctx, latest)
    : { status: 'unverified' as const };
  result.finalCheckPassed =
    verification.status === 'passed' ? true : verification.status === 'unverified' ? null : false;
  result.verificationEvidenceHash =
    'evidenceHash' in verification ? (verification.evidenceHash ?? null) : null;
  checks.push({
    name: 'final revision verified',
    pass: verification.status === 'passed',
    detail: `matching persisted verification: ${verification.status}`,
  });
  let params: Record<string, number | string | boolean>;
  try {
    params = effectiveCadParams(payload.params, payload.modelUnit);
  } catch (error) {
    checks.push({ name: 'CAD units and parameters', pass: false, detail: String(error) });
    return result;
  }

  const renderedSource = render(scad, outDir, 'delivered', params);
  if ('error' in renderedSource) {
    checks.push({
      name: 'source renders',
      pass: false,
      detail: `${renderedSource.error}\n${renderedSource.stderr.slice(0, 500)}`,
    });
    return result;
  }
  const warnings = renderedSource.stderr.split('\n').filter((l) => /WARNING|ERROR/.test(l));
  checks.push({
    name: 'source renders cleanly',
    pass: warnings.length === 0,
    detail: warnings.length ? warnings.slice(0, 3).join(' | ') : 'no OpenSCAD warnings',
  });
  checks.push(...runChecks(renderedSource.tris, task.expect));

  for (const [i, variant] of (task.variants ?? []).entries()) {
    const vr = render(scad, outDir, `variant-${i}`, {
      ...params,
      ...variant.params,
    });
    const label = `variant ${JSON.stringify(variant.params)}`;
    if ('error' in vr) {
      checks.push({ name: label, pass: false, detail: `render failed: ${vr.error}` });
      continue;
    }
    const variantWarnings = vr.stderr.split('\n').filter((line) => /WARNING|ERROR/.test(line));
    checks.push({
      name: `${label}: source renders cleanly`,
      pass: !variantWarnings.length,
      detail: variantWarnings.slice(0, 3).join(' | ') || 'no OpenSCAD warnings',
    });
    for (const c of runChecks(vr.tris, variant.expect))
      checks.push({ ...c, name: `${label}: ${c.name}` });
  }

  if (task.seed && task.changeRegions) {
    const orig = render(task.seed.scad, outDir, 'seed', effectiveCadParams(task.seed.params));
    if ('error' in orig || /WARNING|ERROR/.test(orig.stderr))
      checks.push({
        name: 'unrelated geometry preserved',
        pass: false,
        detail: `reference seed did not render cleanly: ${'error' in orig ? orig.error : orig.stderr}`,
      });
    else checks.push(preservationCheck(orig.tris, renderedSource.tris, task.changeRegions));
  }
  return result;
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
  // Freeze the agent's final state. A provider exit cannot be repaired by a
  // late tool mutation or by geometry from an earlier successful attempt.
  bridge.revoke(sessionId);
  const unfinished = ctx.repo
    .listJobs(Number.MAX_SAFE_INTEGER)
    .filter((job) => job.sessionId === sessionId && ['queued', 'running'].includes(job.status));
  for (const job of unfinished) ctx.cancelJob(job.id);
  const metrics = metricsFrom(run);
  const evalResult = await evaluateProject(app, projectId, task, seededId, outDir);
  evalResult.checks.unshift(...providerRunChecks(run), {
    name: 'agent jobs complete',
    pass: unfinished.length === 0,
    detail: `${unfinished.length} unfinished session job(s) at provider exit`,
  });
  metrics.lastCheckPassed = evalResult.finalCheckPassed;
  metrics.finalRevisionId = evalResult.finalRevisionId;
  metrics.verificationEvidenceHash = evalResult.verificationEvidenceHash;
  fs.writeFileSync(path.join(outDir, 'project-events.json'), JSON.stringify(events, null, 2));

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
      ` · verification: ${r.metrics.checkCalls} cad_check call(s)${r.metrics.lastCheckPassed === null ? ', final revision unverified' : r.metrics.lastCheckPassed ? ', final revision passed' : ', final revision FAILED or incomplete'}`,
    '',
  ];
  return lines.join('\n');
}
