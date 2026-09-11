import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { AGENT_OPS, PROTOCOL_VERSION, newId } from '@stark/contracts';
import { CoreApp } from '@stark/core';
import { createProject } from '@stark/storage';
import type { ProjectContext } from '@stark/core';
import { BridgeServer } from './server.js';
import { FrameDecoder, encodeFrame } from './framing.js';

/** Minimal bridge client for tests: hello → then framed req/res. */
class TestClient {
  socket: net.Socket;
  decoder = new FrameDecoder();
  queue: unknown[] = [];
  waiters: ((m: unknown) => void)[] = [];

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on('data', (chunk) => {
      for (const m of this.decoder.push(chunk)) {
        const w = this.waiters.shift();
        if (w) w(m);
        else this.queue.push(m);
      }
    });
  }

  static async connect(socketPath: string): Promise<TestClient> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(socketPath);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    return new TestClient(socket);
  }

  next(timeoutMs = 5000): Promise<unknown> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for frame')), timeoutMs);
      this.waiters.push((m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
  }

  send(m: unknown): void {
    this.socket.write(encodeFrame(m));
  }

  async hello(token: string, mode: 'call' | 'mcp' = 'call'): Promise<unknown> {
    this.send({ type: 'hello', token, protocolVersion: PROTOCOL_VERSION, mode });
    return this.next();
  }

  close(): void {
    this.socket.destroy();
  }
}

describe('BridgeServer', () => {
  let dir: string;
  let app: CoreApp;
  let ctx: ProjectContext;
  let bridge: BridgeServer;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stark-bridge-'));
    app = new CoreApp(path.join(dir, 'app-data'));
    ctx = app.register(createProject(path.join(dir, 'proj'), 'Test Project', 'test intent'));
    bridge = new BridgeServer(app, { socketPath: path.join(dir, 'run', 'bridge.sock') });
    await bridge.listen();
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await bridge.close();
    app.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function connect(): Promise<TestClient> {
    const c = await TestClient.connect(bridge.socketPath);
    clients.push(c);
    return c;
  }

  function token(sessionId = newId()): { token: string; sessionId: string } {
    return {
      token: bridge.issueToken({ projectId: ctx.projectId, sessionId, ops: [...AGENT_OPS] }),
      sessionId,
    };
  }

  it('denies a wrong token with CONNECTION_DENIED', async () => {
    const c = await connect();
    const res = (await c.hello('bogus-token')) as { type: string; error: { code: string } };
    expect(res.type).toBe('error');
    expect(res.error.code).toBe('CONNECTION_DENIED');
  });

  it('denies a protocol mismatch with PROTOCOL_MISMATCH', async () => {
    const { token: t } = token();
    const c = await connect();
    c.send({ type: 'hello', token: t, protocolVersion: 99, mode: 'call' });
    const res = (await c.next()) as { type: string; error: { code: string } };
    expect(res.error.code).toBe('PROTOCOL_MISMATCH');
  });

  it('denies a non-hello first frame', async () => {
    const c = await connect();
    c.send({ requestId: 'x', op: 'project.summary', payload: {} });
    const res = (await c.next()) as { type: string; error: { code: string } };
    expect(res.type).toBe('error');
  });

  it('call mode: project.summary dispatches end-to-end', async () => {
    const { token: t, sessionId } = token();
    const c = await connect();
    const welcome = (await c.hello(t)) as { type: string; sessionId: string; agentOps: string[] };
    expect(welcome.type).toBe('welcome');
    expect(welcome.sessionId).toBe(sessionId);
    expect(welcome.agentOps).toContain('project.summary');

    c.send({ requestId: 'r1', op: 'project.summary', payload: {} });
    const res = (await c.next()) as {
      requestId: string;
      ok: boolean;
      result: { project: { name: string } };
    };
    expect(res.requestId).toBe('r1');
    expect(res.ok).toBe(true);
    expect(res.result.project.name).toBe('Test Project');
  });

  it('call mode: user-only op → CAPABILITY_DENIED', async () => {
    const { token: t } = token();
    const c = await connect();
    await c.hello(t);
    c.send({
      requestId: 'r2',
      op: 'proposal.approve',
      payload: { proposalId: newId(), rationale: '' },
    });
    const res = (await c.next()) as { ok: boolean; error: { code: string } };
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('CAPABILITY_DENIED');
  });

  it('call mode: unknown op → error envelope', async () => {
    const { token: t } = token();
    const c = await connect();
    await c.hello(t);
    c.send({ requestId: 'r3', op: 'no.such.op', payload: {} });
    const res = (await c.next()) as { ok: boolean; error: { code: string } };
    expect(res.ok).toBe(false);
  });

  it('second connection is isolated; revoke kills its grant', async () => {
    const a = token();
    const b = token();
    const ca = await connect();
    const cb = await connect();
    const wa = (await ca.hello(a.token)) as { sessionId: string };
    const wb = (await cb.hello(b.token)) as { sessionId: string };
    expect(wa.sessionId).toBe(a.sessionId);
    expect(wb.sessionId).toBe(b.sessionId);

    ca.send({ requestId: 'a1', op: 'project.summary', payload: {} });
    cb.send({ requestId: 'b1', op: 'project.summary', payload: {} });
    const [ra, rb] = (await Promise.all([ca.next(), cb.next()])) as [
      { requestId: string },
      { requestId: string },
    ];
    expect(ra.requestId).toBe('a1');
    expect(rb.requestId).toBe('b1');

    bridge.revoke(b.sessionId);
    const cb2 = await connect();
    const denied = (await cb2.hello(b.token)) as { type: string; error: { code: string } };
    expect(denied.error.code).toBe('CONNECTION_DENIED');
    // Existing connection unaffected.
    ca.send({ requestId: 'a2', op: 'project.summary', payload: {} });
    const ra2 = (await ca.next()) as { ok: boolean };
    expect(ra2.ok).toBe(true);
  });
});
