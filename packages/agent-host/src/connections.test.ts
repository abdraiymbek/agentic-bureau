import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoreApp } from '@omenflow/core';
import { createProject } from '@omenflow/storage';
import type { ProjectContext } from '@omenflow/core';
import { BridgeServer } from './bridge/server.js';
import { ConnectionManager } from './connections.js';

describe('ConnectionManager', () => {
  let dir: string;
  let app: CoreApp;
  let ctx: ProjectContext;
  let bridge: BridgeServer;
  let conn: ConnectionManager;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omenflow-conn-'));
    app = new CoreApp(path.join(dir, 'app-data'));
    ctx = app.register(createProject(path.join(dir, 'proj'), 'Conn Proj', 'intent'));
    bridge = new BridgeServer(app, { socketPath: path.join(dir, 'run', 'bridge.sock') });
    await bridge.listen();
    conn = new ConnectionManager(app, bridge);
  });

  afterEach(async () => {
    await bridge.close();
    app.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('list() reports all shipped adapters', async () => {
    const statuses = await conn.list();
    expect(statuses.map((s) => s.adapterId).sort()).toEqual(['claude-code', 'codex', 'custom']);
    for (const s of statuses) expect(typeof s.available).toBe('boolean');
  });

  it('configure() persists adapter config via CoreApp', async () => {
    await conn.configure('custom', { executablePath: '/bin/sh', args: ['-c', 'echo hi'] });
    expect(app.adapterConfigs['custom']?.executablePath).toBe('/bin/sh');
    // persisted to settings.json
    const settings = JSON.parse(
      fs.readFileSync(path.join(app.appDataDir, 'settings.json'), 'utf8'),
    );
    expect(settings.adapters.custom.executablePath).toBe('/bin/sh');
  });

  it('configure() rejects unknown adapters', async () => {
    await expect(conn.configure('nope', {})).rejects.toThrow(/Unknown adapter/);
  });

  it('test() fails cleanly for an unconfigured adapter', async () => {
    const res = await conn.test(ctx, 'custom');
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    // lastTest persisted as failed
    const statuses = await conn.list();
    const custom = statuses.find((s) => s.adapterId === 'custom')!;
    expect(custom.lastTestOk).toBe(false);
    expect(custom.lastTestAt).toBeTruthy();
  });

  it('test() end-to-end: configured adapter + live bridge roundtrip', async () => {
    await conn.configure('custom', { executablePath: '/bin/sh' });
    const res = await conn.test(ctx, 'custom');
    expect(res.ok).toBe(true);
    expect(res.detail).toContain('bridge ok');
    const custom = (await conn.list()).find((s) => s.adapterId === 'custom')!;
    expect(custom.lastTestOk).toBe(true);
  });
});
