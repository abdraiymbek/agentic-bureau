import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  ErrorCodes,
  PROTOCOL_VERSION,
  OmenflowError,
  bridgeHelloSchema,
  errResponse,
  okResponse,
  protocolMismatch,
  requestEnvelopeSchema,
  type ResponseEnvelope,
} from '@omenflow/contracts';
import type { CoreApp } from '@omenflow/core';
import { FrameDecoder, encodeFrame } from './framing.js';

/** A bridge credential: one token ↔ one agent session on one project. */
export interface BridgeGrant {
  token: string;
  projectId: string;
  sessionId: string;
  ops: Set<string>;
}

const HELLO_TIMEOUT_MS = 10_000;

/**
 * Local RPC bridge the agent CLI (`omenflow`) connects to.
 *
 * Transport: unix socket `<appDataDir>/run/bridge.sock` on macOS/Linux,
 * named pipe `\\.\pipe\omenflow-<user>-bridge` on Windows.
 * Protocol: see packages/contracts/src/protocol.ts — hello → welcome →
 * per-frame request/response envelopes (mode 'call') or JSON-RPC frames
 * (mode 'mcp', handed to the mcp-server package via onMcpConnection).
 */
export class BridgeServer {
  /** Set by the app wiring to hand authenticated 'mcp' connections to MCP. */
  onMcpConnection?: (socket: net.Socket, grant: BridgeGrant, buffered: Buffer) => void;
  /** Resolves once the socket is accepting connections. */
  readonly ready: Promise<string>;

  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  private grants = new Map<string, BridgeGrant>(); // token → grant
  private sessionTokens = new Map<string, string>(); // sessionId → token
  private _socketPath: string;
  private closed = false;

  /**
   * @param target an app-data dir (socket goes to `<dir>/run/bridge.sock`)
   *   or `{ socketPath }` for an explicit path. The server starts listening
   *   immediately — await `ready` (or `listen()`) before connecting.
   */
  constructor(
    private app: CoreApp,
    target?: string | { socketPath?: string },
  ) {
    if (typeof target === 'string') {
      this._socketPath = defaultSocketPath(target);
    } else {
      this._socketPath = target?.socketPath ?? defaultSocketPath(app.appDataDir);
    }
    this.ready = this.listenInner();
    // Avoid unhandled-rejection noise; awaiters still see the real error.
    void this.ready.catch(() => {});
  }

  get socketPath(): string {
    return this._socketPath;
  }

  /** Issue a per-session credential. `ops` is the allowed op set (AGENT_OPS). */
  issueToken(input: { projectId: string; sessionId: string; ops: Iterable<string> }): string {
    const token = randomBytes(24).toString('hex');
    this.grants.set(token, {
      token,
      projectId: input.projectId,
      sessionId: input.sessionId,
      ops: new Set(input.ops),
    });
    this.sessionTokens.set(input.sessionId, token);
    return token;
  }

  /** Invalidate the credential for a session (on exit/stop). */
  revoke(sessionId: string): void {
    const token = this.sessionTokens.get(sessionId);
    if (token) this.grants.delete(token);
    this.sessionTokens.delete(sessionId);
  }

  grantForToken(token: string): BridgeGrant | null {
    return this.grants.get(token) ?? null;
  }

  /** Idempotent — returns the `ready` promise started by the constructor. */
  listen(): Promise<string> {
    return this.ready;
  }

  private async listenInner(): Promise<string> {
    if (this.server) return this._socketPath;
    if (process.platform !== 'win32') {
      const dir = path.dirname(this._socketPath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(dir, 0o700);
      } catch {
        /* best effort */
      }
      // Remove a stale socket left by a crashed process.
      try {
        fs.unlinkSync(this._socketPath);
      } catch {
        /* absent */
      }
    }
    const server = net.createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this._socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (this.closed) {
      server.close();
      return this._socketPath;
    }
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(this._socketPath, 0o600);
      } catch {
        /* best effort */
      }
    }
    this.server = server;
    return this._socketPath;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(this._socketPath);
      } catch {
        /* absent */
      }
    }
  }

  /* ----------------------------- internals ---------------------------- */

  private handleConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => socket.destroy());

    const decoder = new FrameDecoder();
    let grant: BridgeGrant | null = null;
    let mode: 'await-hello' | 'call' | 'handed-off' = 'await-hello';

    const helloTimer = setTimeout(() => {
      if (mode === 'await-hello') {
        sendError(socket, ErrorCodes.CONNECTION_DENIED, 'Timed out waiting for hello');
        socket.end();
      }
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref?.();

    socket.on('data', (chunk) => {
      let messages: unknown[];
      try {
        messages = decoder.push(chunk);
      } catch (e) {
        const err = OmenflowError.from(e);
        sendError(socket, err.code, err.message);
        socket.end();
        return;
      }
      for (const message of messages) {
        if (mode === 'handed-off') return;
        if (mode === 'await-hello') {
          const result = this.handleHello(socket, message, decoder);
          if (!result) return; // hello failed — socket closing
          grant = result.grant;
          mode = result.mode;
          clearTimeout(helloTimer);
          if (mode === 'handed-off') return;
          continue;
        }
        // mode 'call'
        void this.handleCallFrame(socket, grant!, message);
      }
    });
  }

  /**
   * Validate the hello frame. Returns the connection mode + grant on success;
   * sends an error frame and closes, returning null, on failure.
   */
  private handleHello(
    socket: net.Socket,
    message: unknown,
    decoder: FrameDecoder,
  ): { mode: 'call' | 'handed-off'; grant: BridgeGrant } | null {
    const parsed = bridgeHelloSchema.safeParse(message);
    if (!parsed.success) {
      sendError(socket, ErrorCodes.VALIDATION, 'First frame must be a bridge hello');
      socket.end();
      return null;
    }
    const hello = parsed.data;
    if (protocolMismatch(hello.protocolVersion)) {
      sendError(
        socket,
        ErrorCodes.PROTOCOL_MISMATCH,
        `Protocol version ${hello.protocolVersion} != ${PROTOCOL_VERSION}`,
      );
      socket.end();
      return null;
    }
    const grant = this.grants.get(hello.token);
    if (!grant) {
      sendError(socket, ErrorCodes.CONNECTION_DENIED, 'Unknown or revoked bridge token');
      socket.end();
      return null;
    }
    socket.write(
      encodeFrame({
        type: 'welcome',
        protocolVersion: PROTOCOL_VERSION,
        projectId: grant.projectId,
        sessionId: grant.sessionId,
        agentOps: [...grant.ops],
      }),
    );
    if (hello.mode === 'mcp') {
      // Hand the raw socket to the MCP server, along with any bytes the
      // decoder already consumed past the hello frame.
      socket.removeAllListeners('data');
      const buffered = decoder.pending();
      if (this.onMcpConnection) {
        this.onMcpConnection(socket, grant, buffered);
      } else {
        sendError(socket, ErrorCodes.INTERNAL, 'MCP transport is not attached to this bridge');
        socket.end();
      }
      return { mode: 'handed-off', grant };
    }
    return { mode: 'call', grant };
  }

  private async handleCallFrame(
    socket: net.Socket,
    grant: BridgeGrant,
    message: unknown,
  ): Promise<void> {
    const parsed = requestEnvelopeSchema.safeParse(message);
    const requestId = parsed.success
      ? parsed.data.requestId
      : typeof (message as { requestId?: unknown })?.requestId === 'string'
        ? (message as { requestId: string }).requestId
        : 'unknown';
    let response: ResponseEnvelope;
    if (!parsed.success) {
      response = errResponse(requestId, ErrorCodes.VALIDATION, 'Malformed request envelope');
    } else {
      const env = parsed.data;
      if (!grant.ops.has(env.op)) {
        response = errResponse(
          requestId,
          ErrorCodes.CAPABILITY_DENIED,
          `Op not granted to this session: ${env.op}`,
        );
      } else {
        try {
          const result = await this.app.dispatch(
            env.op,
            env.payload,
            { kind: 'agent', sessionId: grant.sessionId },
            grant.projectId,
            env.idempotencyKey,
          );
          response = okResponse(requestId, result);
        } catch (e) {
          const err = OmenflowError.from(e);
          response = errResponse(requestId, err.code, err.message, err.repair, err.details);
        }
      }
    }
    if (!socket.destroyed) socket.write(encodeFrame(response));
  }
}

function sendError(socket: net.Socket, code: string, message: string): void {
  try {
    socket.write(encodeFrame({ type: 'error', error: { code, message } }));
  } catch {
    /* socket already gone */
  }
}

function defaultSocketPath(appDataDir: string): string {
  if (process.platform === 'win32') {
    let user = 'user';
    try {
      user = os.userInfo().username.replace(/[^a-zA-Z0-9_-]/g, '_') || 'user';
    } catch {
      /* keep default */
    }
    return `\\\\.\\pipe\\omenflow-${user}-bridge`;
  }
  return path.join(appDataDir, 'run', 'bridge.sock');
}
