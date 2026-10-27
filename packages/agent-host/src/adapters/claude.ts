import fs from 'node:fs';
import path from 'node:path';
import type { AdapterStatus, SessionInfo } from '@bureau/contracts';
import { ErrorCodes, BureauError } from '@bureau/contracts';
import {
  baseStatus,
  loginShellPath,
  probeVersion,
  recognizedVersion,
  resolveExecutable,
  type AgentAdapter,
  type AdapterManifest,
  type ConfigGetter,
  type LaunchRequest,
  type LaunchSpec,
} from './base.js';

/**
 * Claude Code adapter. MCP wiring via a per-session config file:
 * `.bureau/work/<session>/mcp.json` + `claude --mcp-config <file>`.
 * Session credentials are embedded in that file's env block.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude-code';
  readonly label = 'Claude Code';
  readonly manifest: AdapterManifest = {
    id: 'claude-code',
    version: '1',
    testedVersions: ['1.', '2.'],
    platforms: ['darwin', 'linux', 'win32'],
  };
  readonly capabilities = { mcp: true, cli: true, resume: true };
  readonly installHint =
    'Install Claude Code (`npm i -g @anthropic-ai/claude-code`) or set an executable path.';

  constructor(private getConfig: ConfigGetter) {}

  private resolve() {
    return resolveExecutable(this.getConfig().executablePath, 'claude');
  }

  async discover(): Promise<AdapterStatus> {
    const cfg = this.getConfig();
    const status = baseStatus(this, cfg);
    const exe = this.resolve();
    if (!exe.path || !fs.existsSync(exe.path)) {
      status.lastError = exe.path ? `Not found: ${exe.path}` : 'claude not found on PATH';
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
    const exe = resolveExecutable(cfg.executablePath, 'claude');
    if (!exe.path || !fs.existsSync(exe.path)) {
      throw new BureauError(ErrorCodes.TOOL_MISSING, 'Claude Code executable not found', {
        repair: 'Install claude or set connection.configure claude-code executablePath.',
      });
    }
    const mcpPath = path.join(path.dirname(req.bootstrapPath), 'mcp.json');
    const mcpConfig = {
      mcpServers: {
        bureau: {
          command: 'bureau',
          args: ['mcp'],
          env: { ...req.bridgeEnv },
        },
      },
    };
    fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2), 'utf8');
    try {
      fs.chmodSync(mcpPath, 0o600);
    } catch {
      /* best effort — contains session credentials */
    }

    const env: NodeJS.ProcessEnv = {
      ...req.bridgeEnv,
      ...cfg.env,
      BUREAU_BOOTSTRAP: req.bootstrapPath,
    };
    if (exe.fromPath && process.platform !== 'win32') {
      const login = loginShellPath();
      if (login) env.PATH = `${login}${path.delimiter}${process.env.PATH ?? ''}`;
    }
    return {
      path: exe.path,
      args: ['--mcp-config', mcpPath, ...(cfg.args ?? [])],
      env,
      cwd: req.ctx.root,
    };
  }

  resumeArgs(session: SessionInfo): string[] | null {
    return ['--resume', session.id];
  }
}
