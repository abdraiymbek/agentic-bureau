import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { AGENT_OPS, newId } from '@omenflow/contracts';
import { CoreApp } from '@omenflow/core';
import { createProject } from '@omenflow/storage';
import { connectMcpToBridge, FrameTransport } from './index.js';

/* Minimal frame codec for the fake client (same 4-byte LE + JSON wire). */
function encodeFrame(m: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(m), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

class FakeMcpClient {
  decoder = { buf: Buffer.alloc(0) };
  queue: unknown[] = [];
  waiters: ((m: unknown) => void)[] = [];

  constructor(public socket: net.Socket) {
    socket.on('data', (chunk) => {
      this.decoder.buf = Buffer.concat([this.decoder.buf, chunk]);
      for (;;) {
        if (this.decoder.buf.length < 4) break;
        const len = this.decoder.buf.readUInt32LE(0);
        if (this.decoder.buf.length < 4 + len) break;
        const body = this.decoder.buf.subarray(4, 4 + len);
        this.decoder.buf = this.decoder.buf.subarray(4 + len);
        const m = JSON.parse(body.toString('utf8'));
        const w = this.waiters.shift();
        if (w) w(m);
        else this.queue.push(m);
      }
    });
  }

  send(m: unknown): void {
    this.socket.write(encodeFrame(m));
  }

  next(timeoutMs = 5000): Promise<unknown> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('frame timeout')), timeoutMs);
      this.waiters.push((m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
  }

  /** Send a JSON-RPC request and await its response. */
  async rpc(method: string, params?: unknown): Promise<unknown> {
    const id = newId();
    this.send({ jsonrpc: '2.0', id, method, params });
    for (;;) {
      const m = (await this.next()) as { id?: string };
      if (m.id === id) return m;
    }
  }

  notify(method: string): void {
    this.send({ jsonrpc: '2.0', method });
  }
}

describe('OmenflowMcpServer over bridge frames', () => {
  let dir: string;
  let app: CoreApp;
  let projectId: string;
  let server: net.Server;
  let sockPath: string;
  const sockets: net.Socket[] = [];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omenflow-mcp-'));
    app = new CoreApp(path.join(dir, 'app-data'));
    const ctx = app.register(createProject(path.join(dir, 'proj'), 'MCP Project', 'intent'));
    projectId = ctx.projectId;
    sockPath = path.join(dir, 'mcp.sock');
  });

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.destroy();
    server?.close();
    app.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Accept one connection on a tmp socket; hand it to connectMcpToBridge. */
  async function attachClient(): Promise<FakeMcpClient> {
    server = net.createServer();
    await new Promise<void>((r) => server.listen(sockPath, r));
    const accepted = new Promise<net.Socket>((resolve) => server.once('connection', resolve));
    const clientSock = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(sockPath);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    sockets.push(clientSock);
    const serverSock = await accepted;
    sockets.push(serverSock);
    await connectMcpToBridge(serverSock, app, {
      projectId,
      sessionId: newId(),
      ops: [...AGENT_OPS],
    });
    return new FakeMcpClient(clientSock);
  }

  it('initialize → tools/list exposes agent ops as tools', async () => {
    const client = await attachClient();
    const init = (await client.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    })) as { result: { serverInfo: { name: string } } };
    expect(init.result.serverInfo.name).toBe('omenflow');
    client.notify('notifications/initialized');

    const list = (await client.rpc('tools/list')) as {
      result: {
        tools: {
          name: string;
          description?: string;
          inputSchema: { properties?: Record<string, { description?: string }> };
          annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
        }[];
      };
    };
    const names = list.result.tools.map((t) => t.name);
    expect(names).toContain('project_summary');
    expect(names).toContain('artifact_list');
    expect(names).not.toContain('proposal_approve'); // user-only op
    // CAD vocabulary is present with field descriptions + annotations; legacy ops are hidden.
    for (const t of [
      'cad_write_source',
      'cad_read_source',
      'cad_inspect',
      'cad_check',
      'tool_describe',
    ]) {
      expect(names).toContain(t);
    }
    for (const t of ['cad_render', 'cad_probe', 'cad_validate_source', 'job_read', 'job_list']) {
      expect(names).not.toContain(t);
    }
    const check = list.result.tools.find((t) => t.name === 'cad_check')!;
    expect(check.inputSchema.properties?.expect?.description).toMatch(/must be true/i);
    expect(check.annotations?.readOnlyHint).toBe(true);
    expect(check.annotations?.destructiveHint).toBe(false);
    const write = list.result.tools.find((t) => t.name === 'cad_write_source')!;
    expect(write.annotations?.readOnlyHint).toBe(false);
    expect(write.inputSchema.properties?.source?.description).toMatch(/plain text/);
  });

  it('tools/call project_summary returns project JSON', async () => {
    const client = await attachClient();
    await client.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    client.notify('notifications/initialized');

    const res = (await client.rpc('tools/call', {
      name: 'project_summary',
      arguments: {},
    })) as { result: { content: { type: string; text: string }[]; isError?: boolean } };
    expect(res.result.isError).toBeFalsy();
    const body = JSON.parse(res.result.content[0]!.text) as { project: { name: string } };
    expect(body.project.name).toBe('MCP Project');
  });

  it('dispatch errors surface as isError', async () => {
    const client = await attachClient();
    await client.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    client.notify('notifications/initialized');
    const res = (await client.rpc('tools/call', {
      name: 'artifact_read',
      arguments: { artifactId: newId() }, // valid id, does not exist
    })) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(res.result.isError).toBe(true);
    const body = JSON.parse(res.result.content[0]!.text) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('FrameTransport roundtrips a raw message', async () => {
    // Loop two FrameTransports over a socket pair.
    server = net.createServer();
    await new Promise<void>((r) => server.listen(sockPath, r));
    const accepted = new Promise<net.Socket>((resolve) => server.once('connection', resolve));
    const clientSock = await new Promise<net.Socket>((resolve) => {
      const s = net.createConnection(sockPath);
      s.once('connect', () => resolve(s));
    });
    const serverSock = await accepted;
    sockets.push(clientSock, serverSock);

    const a = new FrameTransport(clientSock);
    const b = new FrameTransport(serverSock);
    const got = new Promise<unknown>((resolve) => (b.onmessage = (m) => resolve(m)));
    await a.start();
    await b.start();
    await a.send({ jsonrpc: '2.0', method: 'ping', id: 1 } as never);
    expect(await got).toEqual({ jsonrpc: '2.0', method: 'ping', id: 1 });
    await a.close();
    await b.close();
  });
});
