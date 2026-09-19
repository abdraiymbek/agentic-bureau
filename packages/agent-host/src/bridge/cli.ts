import fs from 'node:fs';
import net from 'node:net';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import {
  ErrorCodes,
  PROTOCOL_VERSION,
  envKeys,
  type RequestEnvelope,
  type ResponseEnvelope,
} from '@omenflow/contracts';
import { FrameDecoder, encodeFrame } from './framing.js';

/**
 * `omenflow` CLI — the agent-facing bridge client (TypeScript reference;
 * bin/omenflow.mjs is the self-contained dev shim, native/omenflow-bridge is the
 * production build).
 *
 *   omenflow call <op> --input <file|'-'> [--idempotency-key k]
 *   omenflow mcp
 *
 * Exit codes: 0 ok · 2 bridge/app error (JSON on stderr) · 3 usage.
 */

export interface CliDeps {
  env?: NodeJS.ProcessEnv;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

function eprint(deps: CliDeps, obj: unknown): void {
  (deps.stderr ?? process.stderr).write(JSON.stringify(obj) + '\n');
}

function fail(deps: CliDeps, code: string, message: string): number {
  eprint(deps, { ok: false, error: { code, message } });
  return 2;
}

interface ParsedArgs {
  mode: 'call' | 'mcp';
  op?: string;
  input?: string;
  idempotencyKey?: string;
}

function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  const [cmd, ...rest] = argv;
  if (cmd === 'mcp') return { mode: 'mcp' };
  if (cmd !== 'call')
    return {
      error: `usage: omenflow call <op> --input <file|-> [--idempotency-key k] | omenflow mcp`,
    };
  const out: ParsedArgs = { mode: 'call' };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--input') out.input = rest[++i];
    else if (a === '--idempotency-key') out.idempotencyKey = rest[++i];
    else if (!a.startsWith('-') && !out.op) out.op = a;
    else return { error: `unexpected argument: ${a}` };
  }
  if (!out.op) return { error: 'missing <op>' };
  if (out.input === undefined) return { error: 'missing --input <file|->' };
  return out;
}

function readStdin(stream: NodeJS.ReadStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.on('data', (c) => (data += c));
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}

async function connect(socketPath: string): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', () => resolve(null));
  });
}

function nextMessage(socket: net.Socket, decoder: FrameDecoder): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      let msgs: unknown[];
      try {
        msgs = decoder.push(chunk);
      } catch (e) {
        cleanup();
        reject(e);
        return;
      }
      if (msgs.length > 0) {
        cleanup();
        resolve(msgs[0]);
      }
    };
    const onErr = (e: Error) => {
      cleanup();
      reject(e);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onErr);
    };
    socket.on('data', onData);
    socket.on('error', onErr);
  });
}

export async function runOmenflowCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    eprint(deps, { ok: false, error: { code: ErrorCodes.VALIDATION, message: parsed.error } });
    return 3;
  }

  const socketPath = env[envKeys.socketPath];
  const token = env[envKeys.token];
  if (!socketPath || !token) {
    return fail(
      deps,
      ErrorCodes.APP_NOT_RUNNING,
      `${envKeys.socketPath}/${envKeys.token} not set — not inside an Omen Flow session?`,
    );
  }

  const socket = await connect(socketPath);
  if (!socket) {
    return fail(
      deps,
      ErrorCodes.APP_NOT_RUNNING,
      `Cannot connect to Omen Flow bridge at ${socketPath}`,
    );
  }

  const decoder = new FrameDecoder();
  socket.write(
    encodeFrame({ type: 'hello', token, protocolVersion: PROTOCOL_VERSION, mode: parsed.mode }),
  );
  let welcome: { type?: string; error?: { code?: string; message?: string } };
  try {
    welcome = (await nextMessage(socket, decoder)) as typeof welcome;
  } catch {
    return fail(deps, ErrorCodes.APP_NOT_RUNNING, 'Bridge closed during handshake');
  }
  if (welcome.type !== 'welcome') {
    return fail(
      deps,
      welcome.error?.code ?? ErrorCodes.CONNECTION_DENIED,
      welcome.error?.message ?? 'Handshake rejected',
    );
  }

  if (parsed.mode === 'mcp') {
    return runMcpPump(socket, decoder, deps);
  }

  // mode 'call'
  const stdin = deps.stdin ?? process.stdin;
  let payload: unknown = {};
  try {
    const raw =
      parsed.input === '-' ? await readStdin(stdin) : fs.readFileSync(parsed.input!, 'utf8');
    payload = raw.trim() === '' ? {} : JSON.parse(raw);
  } catch (e) {
    socket.destroy();
    return fail(
      deps,
      ErrorCodes.VALIDATION,
      `Cannot read --input payload: ${(e as Error).message}`,
    );
  }

  const request: RequestEnvelope = {
    requestId: randomUUID(),
    op: parsed.op!,
    payload,
    idempotencyKey: parsed.idempotencyKey,
  };
  socket.write(encodeFrame(request));
  try {
    const response = (await nextMessage(socket, decoder)) as ResponseEnvelope;
    socket.end();
    if (response.ok) {
      (deps.stdout ?? process.stdout).write(
        JSON.stringify(response.result ?? null, null, 2) + '\n',
      );
      return 0;
    }
    eprint(deps, { ok: false, error: response.error });
    return 2;
  } catch {
    socket.destroy();
    return fail(deps, ErrorCodes.APP_NOT_RUNNING, 'Bridge closed before responding');
  }
}

/**
 * Bidirectional pump: newline-delimited JSON-RPC on stdin → bridge frames;
 * bridge frames → newline-delimited JSON-RPC on stdout. stderr is reserved
 * for diagnostics. Exits when the socket closes.
 */
function runMcpPump(socket: net.Socket, decoder: FrameDecoder, deps: CliDeps): Promise<number> {
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, terminal: false });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        socket.write(encodeFrame(JSON.parse(trimmed)));
      } catch {
        eprint(deps, {
          ok: false,
          error: {
            code: ErrorCodes.VALIDATION,
            message: `Bad JSON-RPC line: ${trimmed.slice(0, 200)}`,
          },
        });
      }
    });
    socket.on('data', (chunk) => {
      let msgs: unknown[];
      try {
        msgs = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const m of msgs) stdout.write(JSON.stringify(m) + '\n');
    });
    const done = (code: number) => {
      rl.close();
      resolve(code);
    };
    socket.on('close', () => done(0));
    socket.on('error', () => done(2));
    rl.on('close', () => socket.end());
  });
}
