/**
 * A `CoreApp`-shaped client for the Rust host.
 *
 * `RustCore.start(appDataDir)` spawns `bureau-host` on a free loopback port
 * and drives it the way the desktop app does. User-origin calls go to the
 * command route. Agent-origin calls take the real agent path: the host issues
 * bridge credentials for the session and the call is framed onto the bridge
 * socket, so capability checks and agent attribution are the production ones.
 *
 * Used by the conformance suite, the fixture builders and the design preview.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Origin } from '@bureau/contracts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROTOCOL_VERSION = 1;

export interface CoreErrorBody {
  code: string;
  message: string;
  repair?: string;
  details?: unknown;
}

/** A failed operation, in the contract's error shape. */
export class CoreError extends Error implements CoreErrorBody {
  readonly code: string;
  readonly repair?: string;
  readonly details?: unknown;
  constructor(body: CoreErrorBody) {
    super(body.message);
    this.name = 'CoreError';
    this.code = body.code;
    this.repair = body.repair;
    this.details = body.details;
  }
}

export interface Envelope {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: CoreErrorBody;
}

/** One server-sent event from the host. */
export interface HostEvent {
  /** `event`, `terminal-data`, `terminal-state`, `agent-call`, `chat` or `resync`. */
  name: string;
  data: unknown;
}

export interface RustCoreOptions {
  /** Path to `bureau-host`. Defaults to `BUREAU_HOST_BIN`, then the cargo debug build. */
  binary?: string;
  /** Path to the `bureau` helper agent sessions call back through. */
  cli?: string;
  /** Loopback port; a free one is picked when omitted. */
  port?: number;
}

/** Where cargo puts the debug build of `bureau-host` for this repository. */
export function hostBinary(): string {
  if (process.env.BUREAU_HOST_BIN) return process.env.BUREAU_HOST_BIN;
  const metadata = spawnSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (metadata.status !== 0)
    throw new Error(`cargo metadata failed: ${metadata.stderr || metadata.error?.message}`);
  const target = (JSON.parse(metadata.stdout) as { target_directory: string }).target_directory;
  return path.join(
    target,
    'debug',
    process.platform === 'win32' ? 'bureau-host.exe' : 'bureau-host',
  );
}

/** Build `bureau-host` and return its path. */
export function buildHost(): string {
  const build = spawnSync('cargo', ['build', '--locked', '-p', 'bureau-headless'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (build.status !== 0) throw new Error('cargo build -p bureau-headless failed');
  return hostBinary();
}

/** One authenticated bridge connection in call mode; requests are answered in order. */
class BridgeCalls {
  private buffered = Buffer.alloc(0);
  private readonly waiting: Array<(frame: unknown) => void> = [];
  private failure: Error | null = null;

  private constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk) => {
      this.buffered = Buffer.concat([this.buffered, chunk]);
      while (this.buffered.length >= 4) {
        const length = this.buffered.readUInt32LE(0);
        if (this.buffered.length < 4 + length) break;
        const frame = JSON.parse(this.buffered.subarray(4, 4 + length).toString('utf8'));
        this.buffered = this.buffered.subarray(4 + length);
        this.waiting.shift()?.(frame);
      }
    });
    const fail = (error: Error) => {
      this.failure = error;
      for (const waiter of this.waiting.splice(0)) waiter({ __closed: error });
    };
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('The agent bridge closed the connection')));
  }

  static async open(socketPath: string, token: string): Promise<BridgeCalls> {
    const socket = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const calls = new BridgeCalls(socket);
    const welcome = (await calls.exchange({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      mode: 'call',
      token,
    })) as { type: string; error?: CoreErrorBody };
    if (welcome.type !== 'welcome') {
      socket.destroy();
      throw new CoreError(
        welcome.error ?? {
          code: 'CONNECTION_DENIED',
          message: 'The agent bridge refused the session',
        },
      );
    }
    return calls;
  }

  private exchange(message: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      this.waiting.push((frame) => {
        const closed = (frame as { __closed?: Error }).__closed;
        if (closed) reject(closed);
        else resolve(frame);
      });
      const body = Buffer.from(JSON.stringify(message), 'utf8');
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      this.socket.write(Buffer.concat([header, body]));
    });
  }

  call(requestId: string, op: string, payload: unknown, idempotencyKey?: string) {
    return this.exchange({ requestId, op, payload, idempotencyKey }) as Promise<Envelope>;
  }

  close() {
    this.socket.destroy();
  }
}

export class RustCore {
  /** Accepted for `CoreApp` compatibility. The Rust host owns its engines. */
  engineTools: unknown = undefined;
  private readonly agent = new http.Agent({ keepAlive: true });
  private readonly bridges = new Map<string, Promise<BridgeCalls>>();
  private readonly streams = new Set<http.ClientRequest>();
  private requests = 0;
  private stopped: Promise<void> | null = null;

  private constructor(
    readonly appDataDir: string,
    readonly port: number,
    readonly token: string,
    /** The agent bridge socket, for running the `bureau` helper against this host. */
    readonly socketPath: string,
    private readonly child: ChildProcess,
  ) {}

  /** Spawn a host on `appDataDir`. Starting again on the same directory is a restart. */
  static async start(appDataDir: string, options: RustCoreOptions = {}): Promise<RustCore> {
    const args = ['--app-data', appDataDir, '--port', String(options.port ?? 0)];
    if (options.cli) args.push('--cli', options.cli);
    // The host stops when this process's end of its stdin closes, so it cannot outlive us.
    args.push('--exit-on-stdin-close');
    const child = spawn(options.binary ?? hostBinary(), args, {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
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
    return new RustCore(appDataDir, announced.port, announced.token, announced.socketPath, child);
  }

  private post(route: string, body: unknown): Promise<Envelope> {
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
              const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Envelope;
              if (response.statusCode === 200) resolve(envelope);
              else
                reject(
                  new CoreError(
                    envelope.error ?? {
                      code: 'INTERNAL',
                      message: `The host answered ${route} with HTTP ${response.statusCode}`,
                    },
                  ),
                );
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

  private unwrap(envelope: Envelope): unknown {
    if (envelope.ok) return envelope.result;
    throw new CoreError(
      envelope.error ?? { code: 'INTERNAL', message: 'The host returned a failure with no error' },
    );
  }

  /** The raw response envelope of a user-origin command, as the desktop renderer receives it. */
  command(op: string, payload: unknown, projectId?: string | null, idempotencyKey?: string) {
    return this.post('/api/command', {
      op,
      payload: payload ?? {},
      projectId: projectId ?? null,
      idempotencyKey: idempotencyKey ?? null,
    });
  }

  private bridge(projectId: string, sessionId: string): Promise<BridgeCalls> {
    const key = `${projectId}\n${sessionId}`;
    let calls = this.bridges.get(key);
    if (!calls) {
      calls = this.post('/api/agent/session', { projectId, sessionId }).then((envelope) => {
        const session = this.unwrap(envelope) as { token: string; socketPath: string };
        return BridgeCalls.open(session.socketPath, session.token);
      });
      // A failed session is not kept: the next call asks again.
      calls.catch(() => this.bridges.delete(key));
      this.bridges.set(key, calls);
    }
    return calls;
  }

  /**
   * Run one operation and return its result, or reject with a {@link CoreError}
   * carrying `{ code, message, repair, details }`.
   */
  async dispatch(
    op: string,
    payload: unknown,
    origin: Origin,
    projectId?: string,
    idempotencyKey?: string,
  ): Promise<unknown> {
    if (origin.kind === 'user')
      return this.unwrap(await this.command(op, payload, projectId, idempotencyKey));
    if (origin.kind === 'agent') {
      if (!projectId)
        throw new CoreError({
          code: 'VALIDATION',
          message: `An agent session belongs to one project: ${op} needs a projectId`,
        });
      const calls = await this.bridge(projectId, origin.sessionId);
      this.requests += 1;
      return this.unwrap(
        await calls.call(`conformance-${this.requests}`, op, payload ?? {}, idempotencyKey),
      );
    }
    throw new CoreError({
      code: 'CAPABILITY_DENIED',
      message: `The host accepts user and agent calls; ${op} was sent with system origin`,
    });
  }

  /** Receive the host's events until the returned function is called. */
  subscribe(listener: (event: HostEvent) => void): () => void {
    const request = http.get({
      host: '127.0.0.1',
      port: this.port,
      path: '/api/events',
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' },
    });
    this.streams.add(request);
    request.on('response', (response) => {
      response.setEncoding('utf8');
      let pending = '';
      response.on('data', (chunk: string) => {
        pending += chunk;
        let end: number;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const fields = new Map(
            pending
              .slice(0, end)
              .split('\n')
              .filter((line) => !line.startsWith(':'))
              .map((line) => {
                const colon = line.indexOf(': ');
                return [line.slice(0, colon), line.slice(colon + 2)] as const;
              }),
          );
          pending = pending.slice(end + 2);
          const name = fields.get('event');
          if (name) listener({ name, data: JSON.parse(fields.get('data') ?? 'null') });
        }
      });
    });
    request.on('error', () => this.streams.delete(request));
    return () => {
      this.streams.delete(request);
      request.destroy();
    };
  }

  /** Stop the host: agent terminals are terminated and the process exits. */
  shutdown(): Promise<void> {
    this.stopped ??= (async () => {
      for (const request of this.streams) request.destroy();
      for (const calls of this.bridges.values()) (await calls.catch(() => null))?.close();
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

  /** `CoreApp.closeAll` under its familiar name: closes every project by stopping the host. */
  closeAll(): Promise<void> {
    return this.shutdown();
  }
}
