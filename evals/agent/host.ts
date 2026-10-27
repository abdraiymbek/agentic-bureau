/**
 * The production Rust host (`bureau-host`) for evaluation runs.
 *
 * The host is spawned with a minimal environment, so nothing from the
 * process running the evaluation (an agent CLI's own session variables,
 * API endpoints, tokens) reaches the host or, through it, the agent CLI.
 * Person-side calls go to the command route; the launch plan comes from
 * `POST /api/agent/launch`, exactly as the desktop wires a terminal session.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A failed host command, in the contract's error shape. */
export class HostError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly repair?: string,
    readonly details?: unknown,
  ) {
    super(`${code}: ${message}`);
    this.name = 'HostError';
  }
}

/** The plan `POST /api/agent/launch` returns. */
export interface LaunchPlan {
  projectId: string;
  sessionId: string;
  adapterId: string;
  model: string | null;
  profile: 'compact' | 'standard' | 'full';
  profileSource: string;
  toolCount: number;
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  envDefaults: Record<string, string>;
  scrubbedPrefix: string;
  files: { path: string; contents: string }[];
  stdin: 'prompt';
  agentsMd: boolean;
}

/** Bridge credentials for a scripted agent session (`POST /api/agent/session`). */
export interface AgentSession {
  sessionId: string;
  token: string;
  socketPath: string;
  profile: string;
  env: Record<string, string>;
}

/** The variables every child of the harness gets, and nothing else. */
export function baseEnvironment(pathValue: string): Record<string, string> {
  return {
    PATH: pathValue,
    HOME: os.homedir(),
    USER: os.userInfo().username,
    LANG: 'en_US.UTF-8',
    TMPDIR: os.tmpdir(),
  };
}

/** Build the release host and helper from this checkout and return their paths. */
export function buildBinaries(): { host: string; cli: string } {
  const run = (args: string[]) => {
    const result = spawnSync('cargo', args, { cwd: REPO, stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`cargo ${args.join(' ')} failed`);
  };
  run(['build', '--release', '--locked', '-p', 'bureau-headless']);
  run(['build', '--release', '--locked', '--manifest-path', 'native/bureau-bridge/Cargo.toml']);
  const metadata = spawnSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (metadata.status !== 0) throw new Error(`cargo metadata failed: ${metadata.stderr}`);
  const target = (JSON.parse(metadata.stdout) as { target_directory: string }).target_directory;
  return {
    host: path.join(target, 'release', 'bureau-host'),
    cli: path.join(REPO, 'native/bureau-bridge/target/release/bureau'),
  };
}

export class EvalHost {
  private readonly agent = new http.Agent({ keepAlive: true });
  private stopped: Promise<void> | null = null;

  private constructor(
    readonly appDataDir: string,
    readonly port: number,
    readonly token: string,
    readonly socketPath: string,
    private readonly child: ChildProcess,
  ) {}

  /**
   * Start a host on `appDataDir`. The data directory must be short: the
   * bridge socket lives inside it and Unix socket paths are limited to about
   * 100 bytes.
   */
  static async start(binary: string, cli: string, appDataDir: string): Promise<EvalHost> {
    const env = {
      ...baseEnvironment('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'),
      SHELL: process.env.SHELL ?? '/bin/zsh',
    };
    const child = spawn(
      binary,
      ['--app-data', appDataDir, '--port', '0', '--cli', cli, '--exit-on-stdin-close'],
      { stdio: ['pipe', 'pipe', 'pipe'], env },
    );
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => process.stderr.write(`[host] ${chunk}`));
    const announced = await new Promise<{ port: number; token: string; socketPath: string }>(
      (resolve, reject) => {
        let text = '';
        child.once('error', reject);
        child.once('exit', (code) =>
          reject(new Error(`bureau-host exited with code ${code} before it was listening`)),
        );
        child.stdout!.setEncoding('utf8');
        child.stdout!.on('data', (chunk: string) => {
          text += chunk;
          const end = text.indexOf('\n');
          if (end >= 0) resolve(JSON.parse(text.slice(0, end)));
        });
      },
    );
    child.removeAllListeners('exit');
    child.stdout!.removeAllListeners('data');
    child.stdout!.resume();
    return new EvalHost(appDataDir, announced.port, announced.token, announced.socketPath, child);
  }

  private post(route: string, body: unknown): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const text = JSON.stringify(body);
      const request = http.request(
        {
          host: '127.0.0.1',
          port: this.port,
          path: route,
          method: 'POST',
          agent: this.agent,
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(text),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            try {
              resolve({
                status: response.statusCode ?? 0,
                body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on('error', reject);
      request.end(text);
    });
  }

  private async envelope(route: string, body: unknown): Promise<any> {
    const reply = await this.post(route, body);
    const envelope = reply.body as {
      ok?: boolean;
      result?: unknown;
      error?: { code: string; message: string; repair?: string; details?: unknown };
    };
    if (reply.status === 200 && envelope.ok) return envelope.result;
    const error = envelope.error ?? {
      code: 'INTERNAL',
      message: `The host answered ${route} with HTTP ${reply.status}`,
    };
    throw new HostError(error.code, error.message, error.repair, error.details);
  }

  /** A person-side command, as the desktop renderer sends it. */
  command(op: string, payload: unknown = {}, projectId: string | null = null): Promise<any> {
    return this.envelope('/api/command', { op, payload, projectId, idempotencyKey: null });
  }

  /** The headless launch plan for one CLI, model and profile on an open project. */
  launch(body: {
    projectId: string;
    adapterId: string;
    model: string;
    profile: string;
    args: string[];
  }): Promise<LaunchPlan> {
    return this.envelope('/api/agent/launch', body);
  }

  /** Credentials for a scripted agent session with a fixed profile. */
  agentSession(projectId: string, profile: string): Promise<AgentSession> {
    return this.envelope('/api/agent/session', { projectId, profile });
  }

  async revoke(sessionId: string): Promise<void> {
    await this.envelope('/api/agent/revoke', { sessionId });
  }

  /** Stop the host; it stops any agent terminals first. */
  shutdown(): Promise<void> {
    this.stopped ??= (async () => {
      const exited = new Promise<void>((resolve) => {
        if (this.child.exitCode !== null || this.child.signalCode !== null) resolve();
        else this.child.once('exit', () => resolve());
      });
      await this.post('/api/shutdown', {}).catch(() => this.child.kill('SIGTERM'));
      this.agent.destroy();
      const forced = setTimeout(() => this.child.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(forced);
    })();
    return this.stopped;
  }
}
