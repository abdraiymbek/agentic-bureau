import fs from 'node:fs';
import type { AdapterStatus, SessionInfo } from '@omenflow/contracts';
import { ErrorCodes, OmenflowError } from '@omenflow/contracts';
import {
  baseStatus,
  probeVersion,
  type AgentAdapter,
  type AdapterManifest,
  type ConfigGetter,
  type LaunchRequest,
  type LaunchSpec,
} from './base.js';

/**
 * Custom CLI adapter — any executable the user points at. Tool access is
 * declared via config (`toolAccess`: 'mcp' | 'cli' | 'none'); the session
 * env always carries the OMENFLOW_BRIDGE_* credentials.
 */
export class CustomAdapter implements AgentAdapter {
  readonly id = 'custom';
  readonly label = 'Custom CLI';
  readonly manifest: AdapterManifest = {
    id: 'custom',
    version: '1',
    testedVersions: [],
    platforms: ['darwin', 'linux', 'win32'],
  };
  readonly installHint = 'Set an executable path via connection.configure (adapterId "custom").';

  constructor(private getConfig: ConfigGetter) {}

  private toolAccess(): 'mcp' | 'cli' | 'none' {
    const cfg = this.getConfig();
    const raw = cfg.toolAccess ?? cfg.env?.OMENFLOW_TOOL_ACCESS ?? 'cli';
    return raw === 'mcp' || raw === 'none' ? raw : 'cli';
  }

  get capabilities() {
    const access = this.toolAccess();
    return { mcp: access === 'mcp', cli: access !== 'none', resume: false };
  }

  async discover(): Promise<AdapterStatus> {
    const cfg = this.getConfig();
    const status = baseStatus(this, cfg);
    if (!cfg.executablePath) {
      status.lastError = 'No executablePath configured';
      return status;
    }
    if (!fs.existsSync(cfg.executablePath)) {
      status.executablePath = cfg.executablePath;
      status.lastError = `Not found: ${cfg.executablePath}`;
      return status;
    }
    status.executablePath = cfg.executablePath;
    status.version = probeVersion(cfg.executablePath);
    status.recognizedVersion = true; // user-provided binary — nothing to compare
    status.available = true;
    return status;
  }

  async launchSpec(req: LaunchRequest): Promise<LaunchSpec> {
    const cfg = req.config;
    if (!cfg.executablePath || !fs.existsSync(cfg.executablePath)) {
      throw new OmenflowError(
        ErrorCodes.TOOL_MISSING,
        'Custom adapter executable not configured/found',
        {
          repair: 'Set connection.configure custom executablePath.',
        },
      );
    }
    return {
      path: cfg.executablePath,
      args: cfg.args ?? [],
      env: { ...req.bridgeEnv, ...cfg.env, OMENFLOW_BOOTSTRAP: req.bootstrapPath },
      cwd: req.ctx.root,
    };
  }

  resumeArgs(_session: SessionInfo): string[] | null {
    return null;
  }
}
