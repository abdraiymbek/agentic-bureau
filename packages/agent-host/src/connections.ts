import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AGENT_OPS,
  ErrorCodes,
  OmenflowError,
  envKeys,
  newId,
  type AdapterStatus,
} from '@omenflow/contracts';
import type { CoreApp, ConnectionHost, ProjectContext } from '@omenflow/core';
import { adapterById, createAdapterRegistry, type AgentAdapter } from './adapters/index.js';
import type { BridgeServer } from './bridge/server.js';

/**
 * ConnectionHost: adapter discovery/status, live bridge test, and persisted
 * per-adapter configuration.
 */
export class ConnectionManager implements ConnectionHost {
  private adapters: AgentAdapter[];
  /** Path of the `omenflow` CLI shim used for the end-to-end bridge check. */
  private cliPath: string;

  constructor(
    private app: CoreApp,
    private bridge: BridgeServer,
    opts?: { cliPath?: string },
  ) {
    this.adapters = createAdapterRegistry((id) => app.adapterConfigs[id] ?? {});
    this.cliPath = opts?.cliPath ?? defaultCliPath();
  }

  async list(): Promise<AdapterStatus[]> {
    const out: AdapterStatus[] = [];
    for (const adapter of this.adapters) {
      const status = await adapter.discover();
      const cfg = this.app.adapterConfigs[adapter.id];
      status.lastTestAt = cfg?.lastTestAt ?? null;
      status.lastTestOk = cfg?.lastTestOk ?? null;
      out.push(status);
    }
    return out;
  }

  /**
   * Live test: executable present + version probed (discover), launch spec
   * builds, and — the part that actually proves the bridge — a real `omenflow
   * call project.summary` roundtrip through the CLI shim with a throwaway
   * session token. Agent-TUI auth itself is only exercised on real launch.
   */
  async test(
    ctx: ProjectContext,
    adapterId: string,
  ): Promise<{ ok: boolean; error?: string; detail?: string }> {
    const adapter = adapterById(this.adapters, adapterId);
    if (!adapter) throw new OmenflowError(ErrorCodes.NOT_FOUND, `Unknown adapter: ${adapterId}`);

    const finish = async (ok: boolean, error: string | null, detail?: string) => {
      await this.app.setAdapterConfig(adapterId, {
        lastTestAt: new Date().toISOString(),
        lastTestOk: ok,
        lastError: error,
      });
      return { ok, ...(error ? { error } : {}), ...(detail ? { detail } : {}) };
    };

    const status = await adapter.discover();
    if (!status.available) {
      return finish(false, status.lastError ?? 'Adapter not available');
    }

    // Launch-spec sanity (bootstrap file goes to a synthetic work dir).
    const testSessionId = newId();
    try {
      const { writeBootstrapBrief } = await import('./adapters/base.js');
      const bootstrapPath = writeBootstrapBrief(ctx, testSessionId);
      await adapter.launchSpec({
        ctx,
        sessionId: testSessionId,
        config: this.app.adapterConfigs[adapterId] ?? {},
        bridgeEnv: {
          [envKeys.socketPath]: this.bridge.socketPath,
          [envKeys.token]: 'unused',
          [envKeys.projectId]: ctx.projectId,
          [envKeys.sessionId]: testSessionId,
        },
        bootstrapPath,
      });
    } catch (e) {
      return finish(false, `Launch spec failed: ${(e as Error).message}`);
    }

    // End-to-end bridge roundtrip via the CLI shim.
    const token = this.bridge.issueToken({
      projectId: ctx.projectId,
      sessionId: testSessionId,
      ops: [...AGENT_OPS],
    });
    try {
      const result = await runCli(this.cliPath, 'call', 'project.summary', {
        [envKeys.socketPath]: this.bridge.socketPath,
        [envKeys.token]: token,
        [envKeys.projectId]: ctx.projectId,
        [envKeys.sessionId]: testSessionId,
      });
      if (!result.ok) {
        return finish(false, result.error ?? 'Bridge call failed');
      }
      return finish(
        true,
        null,
        `bridge ok${status.version ? ` · ${adapter.label} ${status.version}` : ''}`,
      );
    } finally {
      this.bridge.revoke(testSessionId);
    }
  }

  async configure(
    adapterId: string,
    cfg: { executablePath?: string; args?: string[]; env?: Record<string, string> },
  ): Promise<void> {
    if (!adapterById(this.adapters, adapterId)) {
      throw new OmenflowError(ErrorCodes.NOT_FOUND, `Unknown adapter: ${adapterId}`);
    }
    await this.app.setAdapterConfig(adapterId, cfg);
  }
}

/**
 * The `omenflow` helper ships beside the bundled utility (`omenflow` /
 * `omenflow.exe`); the source tree uses `bin/omenflow.mjs`.
 */
function defaultCliPath(): string {
  for (const name of ['omenflow.exe', 'omenflow']) {
    const candidate = fileURLToPath(new URL(`./${name}`, import.meta.url));
    if (fs.existsSync(candidate)) return candidate;
  }
  return fileURLToPath(new URL('../bin/omenflow.mjs', import.meta.url));
}

/**
 * The shipped helper is either the compiled Rust binary (spawned directly)
 * or the JS shim (spawned through the current runtime — under Electron that
 * is the app binary with ELECTRON_RUN_AS_NODE=1, under tests it is Node).
 */
function cliSpawnTarget(cliPath: string, args: string[]): [string, string[]] {
  let script = true;
  try {
    const fd = fs.openSync(cliPath, 'r');
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    script = head.toString('latin1') === '#!';
  } catch {
    /* unreadable helper: report through the spawn error below */
  }
  return script ? [process.execPath, [cliPath, ...args]] : [cliPath, args];
}

/** Spawn `<cliPath> call <op> --input -` with stdin `{}`; parse result. */
function runCli(
  cliPath: string,
  verb: 'call',
  op: string,
  env: Record<string, string>,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const [file, argv] = cliSpawnTarget(cliPath, [verb, op, '--input', '-']);
    const child = execFile(
      file,
      argv,
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env },
        timeout: 15_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          // The shim prints a JSON error body on stderr for exit code 2.
          const line = stderr.trim().split('\n')[0];
          try {
            const body = JSON.parse(line ?? '') as { error?: { message?: string; code?: string } };
            resolve({ ok: false, error: body.error?.message ?? `exit ${error.code}` });
          } catch {
            resolve({ ok: false, error: stderr.trim() || error.message });
          }
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as { project?: unknown };
          resolve(
            parsed && typeof parsed === 'object'
              ? { ok: true }
              : { ok: false, error: 'empty result' },
          );
        } catch {
          resolve({ ok: false, error: `Unparseable CLI output: ${stdout.slice(0, 200)}` });
        }
      },
    );
    child.stdin?.end('{}\n');
  });
}
