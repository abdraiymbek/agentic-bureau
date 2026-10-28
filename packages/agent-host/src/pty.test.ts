import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoreApp } from '@bureau/core';
import { createProject } from '@bureau/storage';
import { BridgeServer } from './bridge/server.js';
import { PtySessionManager, Scrollback } from './pty.js';
import { newId } from '@bureau/contracts';

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

// The interrupt round trip relies on the shell running an INT trap when ^C arrives through the
// terminal. bash does; dash, Ubuntu's /bin/sh, does not, so prefer bash wherever it exists.
const shell = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';

describe('PtySessionManager', () => {
  let dir: string;
  let app: CoreApp;
  let bridge: BridgeServer;
  let mgr: PtySessionManager;
  let ctx: ReturnType<CoreApp['register']>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-pty-'));
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
        executablePath: shell,
        args: [],
      });
      expect(info.state).toBe('running');
      expect(info.pid).toBeGreaterThan(0);

      // Session row + bridge token issued.
      expect(ctx.repo.getSession(info.id)?.state).toBe('running');
      const session = mgr.sessionFor(ctx.projectId)!;
      expect(bridge.grantForToken(session.token)?.sessionId).toBe(info.id);

      mgr.write(ctx, 'echo bureau-pty-marker\n');
      await waitFor(() => mgr.getScrollback(ctx).includes('bureau-pty-marker'));

      mgr.resize(ctx, 132, 43);
      expect(mgr.state(ctx)?.cols).toBe(132);
      expect(mgr.state(ctx)?.rows).toBe(43);

      // Wait for the shell to handle ^C before sending the next command. POSIX
      // terminal signal handling may flush input queued immediately after ^C.
      // Split the markers so echoed command text cannot satisfy the checks.
      mgr.write(ctx, `trap 'printf "INTERRUPT_%s\\n" HANDLED' INT\nprintf 'TRAP_%s\\n' READY\n`);
      await waitFor(() => mgr.getScrollback(ctx).includes('TRAP_READY'));
      mgr.interrupt(ctx);
      await waitFor(() => mgr.getScrollback(ctx).includes('INTERRUPT_HANDLED'));
      mgr.write(ctx, 'echo after-interrupt\n');
      await waitFor(() => mgr.getScrollback(ctx).includes('after-interrupt'));
      expect(mgr.state(ctx)?.state).toBe('running');

      await mgr.stop(ctx);
      await waitFor(() => mgr.state(ctx)?.state === 'exited');
      expect(ctx.repo.getSession(info.id)?.state).toBe('exited');
      expect(bridge.grantForToken(session.token)).toBeNull();
      expect(mgr.getScrollback(ctx)).toContain('bureau-pty-marker');
    },
    20_000,
  );

  it.skipIf(!posix || !ptyAvailable)(
    'terminal output is transient and stays out of engineering events',
    async () => {
      const output: string[] = [];
      ctx.terminalListeners.add((data) => output.push(data.chunk));
      const info = await mgr.start(ctx, {
        adapterId: 'custom',
        executablePath: '/bin/sh',
        args: [],
      });
      mgr.write(ctx, 'echo data-event-check\n');
      await waitFor(() => mgr.getScrollback(ctx).includes('data-event-check'));
      const events = ctx.repo.eventsSince(0).filter((e) => e.type === 'session.data');
      expect(events).toHaveLength(0);
      expect(output.join('')).toContain('data-event-check');
      await mgr.stop(ctx);
      void info;
    },
  );

  it.skipIf(!posix || !ptyAvailable)(
    'interrupt and stop cancel session-owned jobs before signaling the CLI',
    async () => {
      const info = await mgr.start(ctx, {
        adapterId: 'custom',
        executablePath: '/bin/sh',
        args: [],
      });
      const unrelated = ctx.createJob({ kind: 'test', tool: 'test', sessionId: newId() });
      const running = ctx.createJob({ kind: 'test', tool: 'test', sessionId: info.id });
      ctx.jobStatus(running.id, 'running');
      let cancelled = false;
      ctx.jobCancels.set(running.id, () => {
        cancelled = true;
      });
      mgr.interrupt(ctx);
      expect(cancelled).toBe(true);
      expect(ctx.repo.getJob(running.id)?.status).toBe('cancelled');
      expect(ctx.repo.getJob(unrelated.id)?.status).toBe('queued');
      expect(mgr.state(ctx)?.state).toBe('running');
      const queued = ctx.createJob({ kind: 'test', tool: 'test', sessionId: info.id });
      const grant = bridge.grantForToken(mgr.sessionFor(ctx.projectId)!.token)!;
      const stopping = mgr.stop(ctx);
      expect(grant.isActive()).toBe(false);
      expect(ctx.repo.getJob(queued.id)?.status).toBe('cancelled');
      await stopping;
      ctx.jobStatus(queued.id, 'succeeded');
      expect(ctx.repo.getJob(queued.id)?.status).toBe('cancelled');
    },
  );

  it('a stop during startup cannot launch a process afterwards', async () => {
    const starting = mgr.start(ctx, { adapterId: 'custom', executablePath: '/bin/sh', args: [] });
    const rejected = expect(starting).rejects.toMatchObject({ code: 'CANCELLED' });
    await mgr.stop(ctx);
    await rejected;
    expect(mgr.state(ctx)?.state).toBe('exited');
    expect(mgr.state(ctx)?.pid).toBeNull();
  });

  it('bounds a single oversized terminal output chunk', () => {
    const scrollback = new Scrollback(32);
    scrollback.push('x'.repeat(1000) + 'end');
    expect(scrollback.text()).toHaveLength(32);
    expect(scrollback.text().endsWith('end')).toBe(true);
  });
});
