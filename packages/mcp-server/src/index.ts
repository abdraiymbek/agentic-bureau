import net from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { MAX_FRAME_BYTES, OPS_BY_NAME, OmenflowError, toErrorBody } from '@omenflow/contracts';
import type { CoreApp } from '@omenflow/core';
import type { z } from 'zod';

/** Grant handed over by the bridge after hello authentication (structural). */
export interface McpGrant {
  projectId: string;
  sessionId: string;
  ops: Iterable<string>;
}

/* ------------------------------------------------------------------ */
/* FrameTransport — MCP Transport over bridge socket frames             */
/*                                                                      */
/* Bridge mode 'mcp': after the welcome frame, every frame carries one    */
/* JSON-RPC message in each direction (4-byte LE length + JSON).         */
/* ------------------------------------------------------------------ */

export class FrameTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  readonly sessionId?: string;

  private buf: Buffer = Buffer.alloc(0);
  private started = false;

  constructor(
    private socket: net.Socket,
    buffered?: Buffer,
    sessionId?: string,
  ) {
    if (buffered?.length) this.buf = Buffer.from(buffered);
    if (sessionId) this.sessionId = sessionId;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.socket.on('data', (chunk) => this.consume(chunk));
    this.socket.on('close', () => this.onclose?.());
    this.socket.on('error', (e) => {
      this.onerror?.(e);
      this.onclose?.();
    });
    // Process any bytes the bridge decoder already pulled past 'hello'.
    if (this.buf.length > 0) {
      const pending = this.buf;
      this.buf = Buffer.alloc(0);
      this.consume(pending);
    }
  }

  private consume(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 4) return;
      const len = this.buf.readUInt32LE(0);
      if (len > MAX_FRAME_BYTES) {
        this.onerror?.(new Error(`MCP frame exceeds ${MAX_FRAME_BYTES} bytes`));
        this.socket.destroy();
        return;
      }
      if (this.buf.length < 4 + len) return;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      try {
        this.onmessage?.(JSON.parse(body.toString('utf8')) as JSONRPCMessage);
      } catch (e) {
        this.onerror?.(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    await new Promise<void>((resolve, reject) => {
      this.socket.write(Buffer.concat([header, body]), (e) => (e ? reject(e) : resolve()));
    });
  }

  async close(): Promise<void> {
    this.socket.end();
  }
}

/* ------------------------------------------------------------------ */
/* OmenflowMcpServer — one McpServer per bridge connection                 */
/* ------------------------------------------------------------------ */

export class OmenflowMcpServer {
  readonly server: McpServer;
  private transport: FrameTransport | null = null;

  constructor(
    private app: CoreApp,
    private grant: McpGrant,
  ) {
    this.server = new McpServer({ name: 'omenflow', version: '0.1.0' });
    this.registerTools();
    this.registerResources();
  }

  private registerTools(): void {
    for (const name of this.grant.ops) {
      const op = OPS_BY_NAME.get(name);
      if (!op) continue;
      // Superseded ops stay callable (CLI/GUI) but are not offered as tools —
      // a small, unambiguous vocabulary is what the model can use reliably.
      if (!op.agentVisible) continue;
      const toolName = name.replace(/\./g, '_');
      // All op inputs are zod objects; expose their shape as the tool schema
      // (field `.describe()` text becomes JSON-schema descriptions).
      const shape = (op.input as z.ZodObject<z.ZodRawShape>).shape;
      const hasShape = shape && typeof shape === 'object';
      this.server.registerTool(
        toolName,
        {
          description: op.description + (op.mutating ? ' (mutating)' : ''),
          ...(hasShape ? { inputSchema: shape } : {}),
          // Every op is gated by Omen Flow's own capability + proposal model:
          // agents can only create drafts, never touch the baseline. Declaring
          // that lets MCP clients (Codex, Claude) skip per-call approval prompts.
          annotations: {
            readOnlyHint: !op.mutating,
            destructiveHint: false,
            idempotentHint: !op.mutating,
            openWorldHint: false,
          },
        },
        async (args) => {
          try {
            const idem = (args as { idempotencyKey?: string } | undefined)?.idempotencyKey;
            const result = await this.app.dispatch(
              op.name,
              hasShape ? args : {},
              { kind: 'agent', sessionId: this.grant.sessionId },
              this.grant.projectId,
              idem,
            );
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result ?? null, null, 2) }],
            };
          } catch (e) {
            const body = e instanceof OmenflowError ? e.toBody() : toErrorBody(e);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
              isError: true,
            };
          }
        },
      );
    }
  }

  private registerResources(): void {
    const ops = new Set(this.grant.ops);
    if (!ops.has('project.summary')) return;
    this.server.registerResource(
      'project_summary',
      'omenflow://project/summary',
      { description: 'Bounded structured project summary', mimeType: 'application/json' },
      async (uri) => {
        const result = await this.app.dispatch(
          'project.summary',
          {},
          { kind: 'agent', sessionId: this.grant.sessionId },
          this.grant.projectId,
        );
        return {
          contents: [
            { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(result, null, 2) },
          ],
        };
      },
    );
  }

  /** Connect this server to an authenticated bridge socket. */
  async attach(socket: net.Socket, buffered?: Buffer): Promise<void> {
    this.transport = new FrameTransport(socket, buffered, this.grant.sessionId);
    await this.server.connect(this.transport);
  }

  async close(): Promise<void> {
    await this.server.close();
  }
}

/**
 * Wiring used by BridgeServer.onMcpConnection:
 *   bridge.onMcpConnection = (sock, grant, buffered) =>
 *     connectMcpToBridge(sock, app, grant, buffered);
 */
export async function connectMcpToBridge(
  socket: net.Socket,
  app: CoreApp,
  grant: McpGrant,
  buffered?: Buffer,
): Promise<OmenflowMcpServer> {
  const server = new OmenflowMcpServer(app, grant);
  await server.attach(socket, buffered);
  return server;
}

/** Alias used by the app wiring: `(sock, grant) => attachMcpToBridge(sock, app, grant)`. */
export const attachMcpToBridge = connectMcpToBridge;
