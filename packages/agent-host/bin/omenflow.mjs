#!/usr/bin/env node
/**
 * `omenflow` — dev/test shim for the Omen Flow bridge helper.
 *
 * Self-contained plain Node ESM (no deps, no build step). Production builds
 * ship the compiled Rust helper from native/omenflow-bridge instead — the wire
 * protocol is identical.
 *
 *   omenflow call <op> --input <file|'-'> [--idempotency-key k]
 *   omenflow mcp
 *
 * Env (injected per session by the agent host):
 *   OMENFLOW_BRIDGE_SOCK  unix socket path / windows pipe
 *   OMENFLOW_BRIDGE_TOKEN per-session credential
 *   OMENFLOW_PROJECT_ID / OMENFLOW_SESSION_ID (informational)
 *
 * Wire protocol: 4-byte LE length-prefixed JSON frames.
 *   → {type:'hello', token, protocolVersion:1, mode:'call'|'mcp'}
 *   ← {type:'welcome', ...} | {type:'error', error:{code,message}}
 *   call: → {requestId, op, payload, idempotencyKey?}
 *         ← {requestId, ok, result|error}
 *   mcp:  JSON-RPC messages, one per frame, both directions.
 *
 * Exit codes: 0 ok · 2 bridge/app error (JSON on stderr) · 3 usage.
 */
import fs from 'node:fs';
import net from 'node:net';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

const eprint = (obj) => process.stderr.write(JSON.stringify(obj) + '\n');
const fail = (code, message) => {
  eprint({ ok: false, error: { code, message } });
  process.exit(2);
};

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

class FrameDecoder {
  constructor() {
    this.buf = Buffer.alloc(0);
  }
  push(chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const len = this.buf.readUInt32LE(0);
      if (len > MAX_FRAME_BYTES) throw new Error(`frame exceeds ${MAX_FRAME_BYTES} bytes`);
      if (this.buf.length < 4 + len) break;
      out.push(JSON.parse(this.buf.subarray(4, 4 + len).toString('utf8')));
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'mcp') return { mode: 'mcp' };
  if (cmd !== 'call')
    return {
      error: 'usage: omenflow call <op> --input <file|-> [--idempotency-key k] | omenflow mcp',
    };
  const out = { mode: 'call' };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--input') out.input = rest[++i];
    else if (a === '--idempotency-key') out.idempotencyKey = rest[++i];
    else if (!a.startsWith('-') && !out.op) out.op = a;
    else return { error: `unexpected argument: ${a}` };
  }
  if (!out.op) return { error: 'missing <op>' };
  if (out.input === undefined) return { error: 'missing --input <file|->' };
  return out;
}

const readStdin = () =>
  new Promise((resolve, reject) => {
    let data = '';
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });

const connect = (socketPath) =>
  new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', () => resolve(null));
  });

const nextMessage = (socket, decoder) =>
  new Promise((resolve, reject) => {
    const onData = (chunk) => {
      let msgs;
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
    const onErr = (e) => {
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

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    eprint({ ok: false, error: { code: 'VALIDATION', message: parsed.error } });
    process.exit(3);
  }

  const socketPath = process.env.OMENFLOW_BRIDGE_SOCK;
  const token = process.env.OMENFLOW_BRIDGE_TOKEN;
  if (!socketPath || !token) {
    fail(
      'APP_NOT_RUNNING',
      'OMENFLOW_BRIDGE_SOCK/OMENFLOW_BRIDGE_TOKEN not set — not inside an Omen Flow session?',
    );
  }

  const socket = await connect(socketPath);
  if (!socket) fail('APP_NOT_RUNNING', `Cannot connect to Omen Flow bridge at ${socketPath}`);

  const decoder = new FrameDecoder();
  socket.write(
    encodeFrame({ type: 'hello', token, protocolVersion: PROTOCOL_VERSION, mode: parsed.mode }),
  );

  let welcome;
  try {
    welcome = await nextMessage(socket, decoder);
  } catch {
    fail('APP_NOT_RUNNING', 'Bridge closed during handshake');
  }
  if (welcome.type !== 'welcome') {
    fail(
      welcome.error?.code ?? 'CONNECTION_DENIED',
      welcome.error?.message ?? 'Handshake rejected',
    );
  }

  if (parsed.mode === 'mcp') {
    // Bidirectional pump: stdin JSON-RPC lines → frames; frames → stdout lines.
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (line) => {
      const t = line.trim();
      if (!t) return;
      try {
        socket.write(encodeFrame(JSON.parse(t)));
      } catch {
        eprint({
          ok: false,
          error: { code: 'VALIDATION', message: `Bad JSON-RPC line: ${t.slice(0, 200)}` },
        });
      }
    });
    socket.on('data', (chunk) => {
      let msgs;
      try {
        msgs = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const m of msgs) process.stdout.write(JSON.stringify(m) + '\n');
    });
    rl.on('close', () => socket.end());
    socket.on('close', () => process.exit(0));
    socket.on('error', () => process.exit(2));
    return;
  }

  // mode 'call'
  let payload = {};
  try {
    const raw = parsed.input === '-' ? await readStdin() : fs.readFileSync(parsed.input, 'utf8');
    payload = raw.trim() === '' ? {} : JSON.parse(raw);
  } catch (e) {
    fail('VALIDATION', `Cannot read --input payload: ${e.message}`);
  }

  socket.write(
    encodeFrame({
      requestId: randomUUID(),
      op: parsed.op,
      payload,
      idempotencyKey: parsed.idempotencyKey,
    }),
  );
  let response;
  try {
    response = await nextMessage(socket, decoder);
  } catch {
    fail('APP_NOT_RUNNING', 'Bridge closed before responding');
  }
  socket.end();
  if (response.ok) {
    process.stdout.write(JSON.stringify(response.result ?? null, null, 2) + '\n');
    process.exit(0);
  }
  eprint({ ok: false, error: response.error });
  process.exit(2);
}

main().catch((e) => fail('INTERNAL', e?.message ?? String(e)));
