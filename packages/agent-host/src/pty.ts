import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { AGENT_OPS, ErrorCodes, OmenflowError, newId, type SessionInfo } from '@omenflow/contracts';
import type { CoreApp, ProjectContext, TerminalHost } from '@omenflow/core';
import type { IPty } from 'node-pty';
import {
  adapterById,
  createAdapterRegistry,
  loginShellPath,
  writeBootstrapBrief,
  type AgentAdapter,
} from './adapters/index.js';
import type { BridgeServer } from './bridge/server.js';

const SCROLLBACK_CAP = 256 * 1024;
const KILL_GRACE_MS = 2_000;

/** Bounded ring buffer of PTY output for renderer restore after reload. */
export class Scrollback {
  private chunks: string[] = [];
  private size = 0;

  constructor(private cap = SCROLLBACK_CAP) {}

  push(chunk: string): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.cap && this.chunks.length > 1) {
      this.size -= this.chunks[0]!.length;
      this.chunks.shift();
    }
  }

  text(): string {
    return this.chunks.join('');
  }
}

export interface ManagedSession {
  info: SessionInfo;
  pty: IPty | null;
  scrollback: Scrollback;
  token: string;
  restoreConfig: (() => void) | null;
  lastStart: { adapterId: string; executablePath?: string; args?: string[] };
  stopping: boolean;
}

/**
 * TerminalHost backed by node-pty. One active session per project context.
 * node-pty is a native CJS addon — it is imported lazily inside start() so
 * the rest of this module (and its tests) load fine when the binding is
 * unavailable.
 */
export class PtySessionManager implements TerminalHost {
  private sessions = new Map<string, ManagedSession>(); // projectId → session
  private adapters: AgentAdapter[];

  constructor(
    private app: CoreApp,
    private bridge: BridgeServer,
    /** Directory holding the `omenflow` bridge CLI; prepended to session PATH. */
    private cliDir?: string,
  ) {
    this.adapters = createAdapterRegistry((id) => app.adapterConfigs[id] ?? {});
  }

  sessionFor(projectId: string): ManagedSession | null {
    return this.sessions.get(projectId) ?? null;
  }

  async start(
    ctx: ProjectContext,
    opts: { adapterId: string; executablePath?: string; args?: string[] },
  ): Promise<SessionInfo> {
    const adapter = adapterById(this.adapters, opts.adapterId);
    if (!adapter) {
      throw new OmenflowError(ErrorCodes.VALIDATION, `Unknown adapter: ${opts.adapterId}`);
    }
    const existing = this.sessions.get(ctx.projectId);
    if (existing && (existing.info.state === 'running' || existing.info.state === 'starting')) {
      await this.stop(ctx);
    }

    const sessionId = newId();
    const token = this.bridge.issueToken({
      projectId: ctx.projectId,
      sessionId,
      ops: [...AGENT_OPS],
    });

    // Per-session config = persisted adapter config + explicit overrides.
    const cfg = { ...(this.app.adapterConfigs[opts.adapterId] ?? {}) };
    if (opts.executablePath) cfg.executablePath = opts.executablePath;
    if (opts.args) cfg.args = opts.args;

    const session: ManagedSession = {
      info: {
        id: sessionId,
        adapterId: opts.adapterId,
        executablePath: cfg.executablePath ?? '',
        state: 'starting',
        pid: null,
        exitCode: null,
        cols: 80,
        rows: 24,
        startedAt: new Date().toISOString(),
        endedAt: null,
        waitingForReview: false,
        lastError: null,
      },
      pty: null,
      scrollback: new Scrollback(),
      token,
      restoreConfig: null,
      lastStart: {
        adapterId: opts.adapterId,
        executablePath: opts.executablePath,
        args: opts.args,
      },
      stopping: false,
    };
    this.sessions.set(ctx.projectId, session);
    ctx.repo.upsertSession(session.info);
    ctx.emit('session.state', 'system', session.info);

    try {
      const bootstrapPath = writeBootstrapBrief(ctx, sessionId);
      const bridgeEnv = bridgeEnvFor(this.bridge.socketPath, token, ctx.projectId, sessionId);
      const spec = await adapter.launchSpec({
        ctx,
        sessionId,
        config: cfg,
        bridgeEnv,
        bootstrapPath,
      });
      session.info.executablePath = spec.path;
      session.restoreConfig = (await adapter.prepareProjectConfig?.(ctx.root)) ?? null;

      const pty = await import('node-pty');
      const [file, args] = spawnTarget(spec.path, spec.args);
      const env = mergedEnv(spec.env);
      // Session PATH: omenflow shim dir, then adapter-specified, then the user's
      // login-shell PATH (GUI-spawned processes get a stub), then ours.
      env.PATH = [
        this.cliDir,
        env.PATH,
        loginShellPath(),
        process.platform === 'win32' ? '' : '/usr/bin:/bin:/usr/sbin:/sbin',
      ]
        .filter((s): s is string => !!s)
        .join(path.delimiter);
      const child = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: session.info.cols,
        rows: session.info.rows,
        cwd: spec.cwd,
        env,
      });
      session.pty = child;
      session.info.pid = child.pid;
      session.info.state = 'running';
      ctx.repo.upsertSession(session.info);
      ctx.emit('session.state', 'system', session.info);

      child.onData((chunk) => {
        session.scrollback.push(chunk);
        ctx.emit('session.data', 'system', { sessionId, chunk });
      });
      child.onExit(({ exitCode }) => {
        this.onExit(ctx, session, exitCode);
      });
      return session.info;
    } catch (e) {
      session.info.state = 'failed';
      session.info.endedAt = new Date().toISOString();
      session.info.lastError = e instanceof Error ? e.message : String(e);
      this.bridge.revoke(sessionId);
      ctx.repo.upsertSession(session.info);
      ctx.emit('session.state', 'system', session.info);
      if (e instanceof OmenflowError) throw e;
      throw new OmenflowError(
        ErrorCodes.TOOL_MISSING,
        `Failed to launch agent: ${session.info.lastError}`,
        {
          repair: 'Check the adapter executable path (connection.test).',
        },
      );
    }
  }

  write(ctx: ProjectContext, data: string): void {
    this.sessions.get(ctx.projectId)?.pty?.write(data);
  }

  resize(ctx: ProjectContext, cols: number, rows: number): void {
    const s = this.sessions.get(ctx.projectId);
    if (!s?.pty) return;
    s.pty.resize(cols, rows);
    s.info.cols = cols;
    s.info.rows = rows;
  }

  interrupt(ctx: ProjectContext): void {
    this.sessions.get(ctx.projectId)?.pty?.write('\x03');
  }

  async stop(ctx: ProjectContext): Promise<void> {
    const s = this.sessions.get(ctx.projectId);
    if (!s) return;
    s.stopping = true;
    const pid = s.pty?.pid ?? null;
    if (s.pty && s.info.state === 'running') {
      await killTree(s.pty, pid);
    }
    if (s.info.state === 'running' || s.info.state === 'starting') {
      s.info.state = 'exited';
      s.info.endedAt = new Date().toISOString();
      ctx.repo.upsertSession(s.info);
      ctx.emit('session.state', 'system', s.info);
    }
    this.bridge.revoke(s.info.id);
    s.restoreConfig?.();
    s.restoreConfig = null;
  }

  async restart(ctx: ProjectContext): Promise<SessionInfo> {
    const s = this.sessions.get(ctx.projectId);
    const last = s?.lastStart;
    if (!last) {
      throw new OmenflowError(ErrorCodes.VALIDATION, 'No session to restart');
    }
    await this.stop(ctx);
    return this.start(ctx, last);
  }

  state(ctx: ProjectContext): SessionInfo | null {
    return this.sessions.get(ctx.projectId)?.info ?? null;
  }

  /** Scrollback for renderer restore after reload. */
  getScrollback(ctx: ProjectContext): string {
    return this.sessions.get(ctx.projectId)?.scrollback.text() ?? '';
  }

  /** Stop every session — call on app quit. */
  async close(): Promise<void> {
    for (const projectId of [...this.sessions.keys()]) {
      const ctx = this.app.contexts.get(projectId);
      if (ctx) await this.stop(ctx);
    }
  }

  private onExit(ctx: ProjectContext, s: ManagedSession, exitCode: number): void {
    s.info.state = 'exited';
    s.info.exitCode = exitCode;
    s.info.endedAt = new Date().toISOString();
    this.bridge.revoke(s.info.id);
    try {
      s.restoreConfig?.();
    } catch {
      /* restore best-effort */
    }
    s.restoreConfig = null;
    try {
      ctx.repo.upsertSession(s.info);
      ctx.emit('session.state', 'system', s.info);
    } catch {
      /* project may be closed already */
    }
  }
}

function bridgeEnvFor(
  socketPath: string,
  token: string,
  projectId: string,
  sessionId: string,
): Record<string, string> {
  return {
    OMENFLOW_BRIDGE_SOCK: socketPath,
    OMENFLOW_BRIDGE_TOKEN: token,
    OMENFLOW_PROJECT_ID: projectId,
    OMENFLOW_SESSION_ID: sessionId,
  };
}

/**
 * Windows can't exec .cmd/.bat directly — route through cmd.exe /c with
 * per-argument quoting (never concatenate raw user input into a shell line).
 */
function spawnTarget(exe: string, args: string[]): [string, string[] | string] {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe)) {
    const line = [exe, ...args].map(cmdQuote).join(' ');
    return ['cmd.exe', `/c ${line}`];
  }
  return [exe, args];
}

/** CommandLineToArgvW-compatible quoting for one argument. */
function cmdQuote(arg: string): string {
  if (!/[\s"&|<>^%']/.test(arg) && arg.length > 0) return arg;
  return `"${arg.replace(/(\\*)("|$)/g, (_m, bs: string, tail: string) => bs + bs + (tail ? `\\"` : '\\"'))}"`;
}

/** Child env: filtered process.env + adapter/bridge vars on top. */
function mergedEnv(overlay: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith('OMENFLOW_')) continue; // never leak host-side OMENFLOW_* vars
    env[k] = v;
  }
  for (const [k, v] of Object.entries(overlay)) {
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/**
 * Kill the process tree rooted at the pty child.
 * POSIX: node-pty children are session leaders (pgid = pid) — signal the
 * group, then sweep survivors listed by `ps -g`. Windows: taskkill /T.
 */
async function killTree(ptyProc: IPty, pid: number | null): Promise<void> {
  if (process.platform === 'win32') {
    try {
      ptyProc.kill();
    } catch {
      /* already dead */
    }
    if (pid) {
      try {
        execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        /* already dead */
      }
    }
    return;
  }

  const signalGroup = (sig: NodeJS.Signals) => {
    if (!pid) return;
    try {
      process.kill(-pid, sig); // the pty child's process group
    } catch {
      /* group gone */
    }
  };
  const groupPids = (): number[] => {
    if (!pid) return [];
    try {
      const out = execFileSync('ps', ['-o', 'pid=', '-g', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return out
        .split('\n')
        .map((l) => parseInt(l.trim(), 10))
        .filter((n) => Number.isFinite(n));
    } catch {
      return [];
    }
  };

  signalGroup('SIGTERM');
  try {
    ptyProc.kill();
  } catch {
    /* already dead */
  }

  const deadline = Date.now() + KILL_GRACE_MS;
  let remaining = groupPids();
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    remaining = groupPids();
  }
  if (remaining.length > 0) {
    signalGroup('SIGKILL');
    for (const p of remaining) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
}
