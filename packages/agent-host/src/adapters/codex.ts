import fs from 'node:fs';
import path from 'node:path';
import type { AdapterStatus, SessionInfo } from '@omenflow/contracts';
import { ErrorCodes, OmenflowError } from '@omenflow/contracts';
import {
  baseStatus,
  probeVersion,
  recognizedVersion,
  resolveExecutable,
  loginShellPath,
  type AgentAdapter,
  type AdapterManifest,
  type ConfigGetter,
  type LaunchRequest,
  type LaunchSpec,
} from './base.js';

/**
 * Codex CLI adapter. MCP wiring is passed via `-c` config overrides (no file
 * mutation): `mcp_servers.omenflow.command/args`. The agent inherits the
 * OMENFLOW_BRIDGE_* session env from the spawned process environment.
 */
export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly label = 'Codex CLI';
  readonly manifest: AdapterManifest = {
    id: 'codex',
    version: '1',
    testedVersions: ['0.4', '0.5', '0.6', '0.15'],
    platforms: ['darwin', 'linux', 'win32'],
  };
  readonly capabilities = { mcp: true, cli: true, resume: false };
  readonly installHint = 'Install Codex CLI (`npm i -g @openai/codex`) or set an executable path.';

  constructor(private getConfig: ConfigGetter) {}

  private resolve() {
    return resolveExecutable(this.getConfig().executablePath, 'codex');
  }

  async discover(): Promise<AdapterStatus> {
    const cfg = this.getConfig();
    const status = baseStatus(this, cfg);
    const exe = this.resolve();
    if (!exe.path || !fs.existsSync(exe.path)) {
      status.lastError = exe.path ? `Not found: ${exe.path}` : 'codex not found on PATH';
      return status;
    }
    status.executablePath = exe.path;
    status.version = probeVersion(exe.path);
    status.recognizedVersion = recognizedVersion(status.version, this.manifest.testedVersions);
    status.available = true;
    return status;
  }

  async launchSpec(req: LaunchRequest): Promise<LaunchSpec> {
    const cfg = req.config;
    const exe = resolveExecutable(cfg.executablePath, 'codex');
    if (!exe.path || !fs.existsSync(exe.path)) {
      throw new OmenflowError(ErrorCodes.TOOL_MISSING, 'Codex CLI executable not found', {
        repair: 'Install codex or set connection.configure codex executablePath.',
      });
    }
    const args = [
      // MCP wiring via config overrides — no project files mutated.
      '-c',
      'mcp_servers.omenflow.command="omenflow"',
      '-c',
      'mcp_servers.omenflow.args=["mcp"]',
      // Codex ≥0.150 spawns MCP servers without inheriting process env —
      // forward the bridge credentials explicitly (names, not values, so the
      // session token never lands in argv/ps).
      '-c',
      'mcp_servers.omenflow.env_vars=["OMENFLOW_BRIDGE_SOCK","OMENFLOW_BRIDGE_TOKEN","OMENFLOW_PROJECT_ID","OMENFLOW_SESSION_ID"]',
      // Omen Flow tools are already gated by its capability + proposal model
      // (agents only ever create drafts). Without this, Codex prompts the user
      // for every tool call in the TUI and denies them outright under
      // approval_policy=never (exec / automation).
      '-c',
      'mcp_servers.omenflow.default_tools_approval_mode="approve"',
      // Seatbelt denies AF_UNIX connects under the default sandbox, which is
      // exactly what `omenflow call` needs to reach the bridge. workspace-write
      // + network_access covers remote unix-socket connects (and the agent
      // needs project-dir writes regardless — the watcher turns them into
      // drafts).
      '-c',
      'sandbox_mode="workspace-write"',
      '-c',
      'sandbox_workspace_write.network_access=true',
      ...(cfg.args ?? []),
    ];
    const env: NodeJS.ProcessEnv = {
      ...req.bridgeEnv,
      ...cfg.env,
      OMENFLOW_BOOTSTRAP: req.bootstrapPath,
    };
    // If the exe was discovered on a login-shell PATH the GUI never saw,
    // propagate that PATH so `omenflow` and friends resolve inside the session.
    if (exe.fromPath && process.platform !== 'win32') {
      const login = loginShellPath();
      if (login) env.PATH = `${login}${path.delimiter}${process.env.PATH ?? ''}`;
    }
    return { path: exe.path, args, env, cwd: req.ctx.root };
  }

  /**
   * `-c` launch args carry the MCP config, so there is nothing to restore.
   * (The alternative — merging `[mcp_servers.omenflow]` into
   * `<project>/.codex/config.toml` — mutates a user file; only worth doing
   * if a future Codex version stops honoring `-c` overrides.)
   */
  async prepareProjectConfig(): Promise<() => void> {
    return () => {};
  }

  resumeArgs(_session: SessionInfo): string[] | null {
    return null; // resume not verified for Codex — marked unsupported
  }
}
