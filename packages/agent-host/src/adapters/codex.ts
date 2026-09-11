import fs from 'node:fs';
import path from 'node:path';
import type { AdapterStatus, SessionInfo } from '@stark/contracts';
import { ErrorCodes, StarkError } from '@stark/contracts';
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
 * mutation): `mcp_servers.stark.command/args`. The agent inherits the
 * STARK_BRIDGE_* session env from the spawned process environment.
 */
export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly label = 'Codex CLI';
  readonly manifest: AdapterManifest = {
    id: 'codex',
    version: '1',
    testedVersions: ['0.4', '0.5', '0.6'],
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
      throw new StarkError(ErrorCodes.TOOL_MISSING, 'Codex CLI executable not found', {
        repair: 'Install codex or set connection.configure codex executablePath.',
      });
    }
    const args = [
      // MCP wiring via config overrides — no project files mutated.
      '-c',
      'mcp_servers.stark.command="stark"',
      '-c',
      'mcp_servers.stark.args=["mcp"]',
      ...(cfg.args ?? []),
    ];
    const env: NodeJS.ProcessEnv = {
      ...req.bridgeEnv,
      ...cfg.env,
      STARK_BOOTSTRAP: req.bootstrapPath,
    };
    // If the exe was discovered on a login-shell PATH the GUI never saw,
    // propagate that PATH so `stark` and friends resolve inside the session.
    if (exe.fromPath && process.platform !== 'win32') {
      const login = loginShellPath();
      if (login) env.PATH = `${login}${path.delimiter}${process.env.PATH ?? ''}`;
    }
    return { path: exe.path, args, env, cwd: req.ctx.root };
  }

  /**
   * `-c` launch args carry the MCP config, so there is nothing to restore.
   * (The alternative — merging `[mcp_servers.stark]` into
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
