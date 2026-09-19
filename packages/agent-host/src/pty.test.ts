import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoreApp } from '@omenflow/core';
import { createProject } from '@omenflow/storage';
import { BridgeServer } from './bridge/server.js';
import { PtySessionManager } from './pty.js';

// node-pty is a native module — it may fail to load under vitest depending on
// how it was built. Skip the live-PTY tests gracefully in that case.
let ptyAvailable = true;
try {
  await import('node-pty');
} catch {
  ptyAvailable = false;
}
const posix = process.platform !== 'win32';

async function waitFor(pred: () => boolean, timeoutMs = 8_000, step = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, step));
  }
}

describe('PtySessionManager', () => {
  let dir: string;
  let app: CoreApp;
  let bridge: BridgeServer;
  let mgr: PtySessionManager;
  let ctx: ReturnType<CoreApp['register']>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omenflow-pty-'));
    app = new CoreApp(path.join(dir, 'app-data'));
    ctx = app.register(createProject(path.join(dir, 'proj'), 'Pty Proj', 'intent'));
    bridge = new BridgeServer(app, { socketPath: path.join(dir, 'run', 'bridge.sock') });
    await bridge.listen();
    mgr = new PtySessionManager(app, bridge);
  });

  afterEach(async () => {
    await mgr.close();
    await bridge.close();
    app.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fails cleanly when the executable does not exist', async () => {
    await expect(
      mgr.start(ctx, { adapterId: 'custom', executablePath: '/no/such/exe' }),
    ).rejects.toThrow(/TOOL_MISSING|executable/i);
    const info = mgr.state(ctx);
    expect(info?.state).toBe('failed');
    const row = ctx.repo.getSession(info!.id);
    expect(row?.state).toBe('failed');
  });

  it('rejects an unknown adapter', async () => {
    await expect(mgr.start(ctx, { adapterId: 'nope' })).rejects.toThrow(/Unknown adapter/);
  });

  it.skipIf(!posix || !ptyAvailable)(
    'spawns a real PTY: echo, interrupt, resize, stop',
    async () => {
      const info = await mgr.start(ctx, {
        adapterId: 'custom',
        executablePath: '/bin/sh',
        args: [],
      });
      expect(info.state).toBe('running');
      expect(info.pid).toBeGreaterThan(0);

      // Session row + bridge token issued.
      expect(ctx.repo.getSession(info.id)?.state).toBe('running');
      const session = mgr.sessionFor(ctx.projectId)!;
      expect(bridge.grantForToken(session.token)?.sessionId).toBe(info.id);

      mgr.write(ctx, 'echo omenflow-pty-marker\n');
      await waitFor(() => mgr.getScrollback(ctx).includes('omenflow-pty-marker'));

      mgr.resize(ctx, 132, 43);
      expect(mgr.state(ctx)?.cols).toBe(132);
      expect(mgr.state(ctx)?.rows).toBe(43);

      // ^C — session stays alive.
      mgr.interrupt(ctx);
      mgr.write(ctx, 'echo after-interrupt\n');
      await waitFor(() => mgr.getScrollback(ctx).includes('after-interrupt'));
      expect(mgr.state(ctx)?.state).toBe('running');

      await mgr.stop(ctx);
      await waitFor(() => mgr.state(ctx)?.state === 'exited');
      expect(ctx.repo.getSession(info.id)?.state).toBe('exited');
      expect(bridge.grantForToken(session.token)).toBeNull();
      expect(mgr.getScrollback(ctx)).toContain('omenflow-pty-marker');
    },
    20_000,
  );

  it.skipIf(!posix || !ptyAvailable)('session.data events land in the repo', async () => {
    const info = await mgr.start(ctx, { adapterId: 'custom', executablePath: '/bin/sh', args: [] });
    mgr.write(ctx, 'echo data-event-check\n');
    await waitFor(() => mgr.getScrollback(ctx).includes('data-event-check'));
    const events = ctx.repo.eventsSince(0).filter((e) => e.type === 'session.data');
    expect(events.length).toBeGreaterThan(0);
    await mgr.stop(ctx);
    void info;
  });
});
