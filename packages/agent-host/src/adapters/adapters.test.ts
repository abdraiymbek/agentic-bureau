import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapterStatusSchema, newId } from '@bureau/contracts';
import { CoreApp } from '@bureau/core';
import { createProject } from '@bureau/storage';
import { CodexAdapter } from './codex.js';
import { ClaudeAdapter } from './claude.js';
import { CustomAdapter } from './custom.js';
import { createAdapterRegistry, adapterById, writeBootstrapBrief, which } from './index.js';

let dir: string;
let app: CoreApp;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-adapters-'));
  app = new CoreApp(path.join(dir, 'app-data'));
});

afterEach(() => {
  app.closeAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('adapter registry', () => {
  it('contains codex, claude-code, custom', () => {
    const reg = createAdapterRegistry(() => ({}));
    expect(reg.map((a) => a.id).sort()).toEqual(['claude-code', 'codex', 'custom']);
    expect(adapterById(reg, 'codex')?.label).toBe('Codex CLI');
    expect(adapterById(reg, 'nope')).toBeNull();
  });

  it('each adapter exposes a manifest', () => {
    for (const a of createAdapterRegistry(() => ({}))) {
      expect(a.manifest.id).toBe(a.id);
      expect(Array.isArray(a.manifest.testedVersions)).toBe(true);
      expect(a.manifest.platforms.length).toBeGreaterThan(0);
    }
  });
});

describe('codex adapter', () => {
  it('discover() returns a well-formed status (available may be false)', async () => {
    const codex = new CodexAdapter(() => ({}));
    const status = await codex.discover();
    expect(() => adapterStatusSchema.parse(status)).not.toThrow();
    expect(status.adapterId).toBe('codex');
    if (which('codex')) {
      expect(status.available).toBe(true);
      expect(status.executablePath).toBeTruthy();
    } else {
      expect(status.available).toBe(false);
      expect(status.lastError).toBeTruthy();
    }
  });

  it('discover() honors a configured executablePath', async () => {
    const codex = new CodexAdapter(() => ({ executablePath: '/bin/sh' }));
    const status = await codex.discover();
    expect(status.available).toBe(true);
    expect(status.executablePath).toBe('/bin/sh');
  });

  it('launchSpec carries -c mcp_servers.bureau overrides + bridge env', async () => {
    const ctx = app.register(createProject(path.join(dir, 'proj'), 'P', 'i'));
    const codex = new CodexAdapter(() => ({ executablePath: '/bin/sh' }));
    const sessionId = newId();
    const bootstrapPath = writeBootstrapBrief(ctx, sessionId);
    const spec = await codex.launchSpec({
      ctx,
      sessionId,
      config: { executablePath: '/bin/sh' },
      bridgeEnv: {
        BUREAU_BRIDGE_SOCK: '/tmp/x.sock',
        BUREAU_BRIDGE_TOKEN: 't',
        BUREAU_PROJECT_ID: ctx.projectId,
        BUREAU_SESSION_ID: sessionId,
      },
      bootstrapPath,
    });
    expect(spec.path).toBe('/bin/sh');
    expect(spec.cwd).toBe(ctx.root);
    const joined = spec.args.join(' ');
    expect(joined).toContain('mcp_servers.bureau.command="bureau"');
    expect(joined).toContain('mcp_servers.bureau.args=["mcp"]');
    // env passthrough for the MCP child + seatbelt escape for `bureau call`
    expect(joined).toContain('mcp_servers.bureau.env_vars=["BUREAU_BRIDGE_SOCK"');
    expect(joined).toContain('"BUREAU_BRIDGE_TOKEN"');
    expect(joined).toContain('sandbox_mode="workspace-write"');
    expect(joined).toContain('sandbox_workspace_write.network_access=true');
    expect(spec.env.BUREAU_BRIDGE_TOKEN).toBe('t');
    expect(spec.env.BUREAU_BOOTSTRAP).toBe(bootstrapPath);
    expect(fs.existsSync(bootstrapPath)).toBe(true);
  });
});

describe('claude adapter', () => {
  it('launchSpec writes mcp.json with bridge env', async () => {
    const ctx = app.register(createProject(path.join(dir, 'proj'), 'P', 'i'));
    const claude = new ClaudeAdapter(() => ({ executablePath: '/bin/sh' }));
    const sessionId = newId();
    const bootstrapPath = writeBootstrapBrief(ctx, sessionId);
    const spec = await claude.launchSpec({
      ctx,
      sessionId,
      config: { executablePath: '/bin/sh' },
      bridgeEnv: {
        BUREAU_BRIDGE_SOCK: '/tmp/x.sock',
        BUREAU_BRIDGE_TOKEN: 'sekret',
        BUREAU_PROJECT_ID: ctx.projectId,
        BUREAU_SESSION_ID: sessionId,
      },
      bootstrapPath,
    });
    const cfgIdx = spec.args.indexOf('--mcp-config');
    expect(cfgIdx).toBeGreaterThanOrEqual(0);
    const mcpJson = JSON.parse(fs.readFileSync(spec.args[cfgIdx + 1]!, 'utf8')) as {
      mcpServers: { bureau: { command: string; args: string[]; env: Record<string, string> } };
    };
    expect(mcpJson.mcpServers.bureau.command).toBe('bureau');
    expect(mcpJson.mcpServers.bureau.args).toEqual(['mcp']);
    expect(mcpJson.mcpServers.bureau.env.BUREAU_BRIDGE_TOKEN).toBe('sekret');
  });

  it('supports resume', () => {
    const claude = new ClaudeAdapter(() => ({}));
    expect(claude.capabilities.resume).toBe(true);
    expect(claude.resumeArgs?.({ id: 'abc' } as never)).toEqual(['--resume', 'abc']);
  });
});

describe('custom adapter', () => {
  it('rejects launch without executablePath', async () => {
    const ctx = app.register(createProject(path.join(dir, 'proj'), 'P', 'i'));
    const custom = new CustomAdapter(() => ({}));
    const sessionId = newId();
    await expect(
      custom.launchSpec({
        ctx,
        sessionId,
        config: {},
        bridgeEnv: {},
        bootstrapPath: writeBootstrapBrief(ctx, sessionId),
      }),
    ).rejects.toThrow(/executable/i);
  });

  it('discovers a configured executable', async () => {
    const custom = new CustomAdapter(() => ({ executablePath: '/bin/sh' }));
    const status = await custom.discover();
    expect(status.available).toBe(true);
    expect(status.executablePath).toBe('/bin/sh');
  });

  it('reports missing executable in status, not throw', async () => {
    const custom = new CustomAdapter(() => ({ executablePath: '/no/such/bin' }));
    const status = await custom.discover();
    expect(status.available).toBe(false);
    expect(status.lastError).toContain('/no/such/bin');
  });
});

describe('bootstrap brief', () => {
  it('contains intent, rules, tool usage', () => {
    const ctx = app.register(createProject(path.join(dir, 'proj'), 'BriefProj', 'build a rocket'));
    const p = writeBootstrapBrief(ctx, newId());
    const text = fs.readFileSync(p, 'utf8');
    expect(text).toContain('BriefProj');
    expect(text).toContain('build a rocket');
    expect(text).toContain('bureau call');
    expect(text).toContain('proposal');
    expect(p).toContain(path.join('.bureau', 'work'));
  });
});
