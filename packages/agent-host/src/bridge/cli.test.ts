import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_OPS, envKeys, newId } from '@bureau/contracts';
import { CoreApp } from '@bureau/core';
import { createProject } from '@bureau/storage';
import { BridgeServer } from './server.js';
import { FrameDecoder, encodeFrame } from './framing.js';

const CLI = fileURLToPath(new URL('../../bin/bureau.mjs', import.meta.url));

function runCli(
  args: string[],
  env: Record<string, string>,
  stdin = '{}\n',
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, ...env }, timeout: 15_000 },
      (error, stdout, stderr) => {
        resolve({ code: error ? (error.code as number) : 0, stdout, stderr });
      },
    );
    child.stdin?.end(stdin);
  });
}

describe('bureau CLI shim (bin/bureau.mjs)', () => {
  let dir: string;
  let app: CoreApp;
  let bridge: BridgeServer;
  let projectId: string;
  let sessionId: string;
  let token: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-cli-'));
    app = new CoreApp(path.join(dir, 'app-data'));
    const ctx = app.register(createProject(path.join(dir, 'proj'), 'CLI Project', 'intent'));
    projectId = ctx.projectId;
    bridge = new BridgeServer(app, { socketPath: path.join(dir, 'run', 'bridge.sock') });
    await bridge.listen();
    sessionId = newId();
    token = bridge.issueToken({ projectId, sessionId, ops: [...AGENT_OPS] });
  });

  afterEach(async () => {
    await bridge.close();
    app.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const env = () => ({
    [envKeys.socketPath]: bridge.socketPath,
    [envKeys.token]: token,
    [envKeys.projectId]: projectId,
    [envKeys.sessionId]: sessionId,
  });

  it('call project.summary prints result JSON', async () => {
    const res = await runCli(['call', 'project.summary', '--input', '-'], env());
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as { project: { name: string } };
    expect(parsed.project.name).toBe('CLI Project');
  });

  it('call reads payload from a file', async () => {
    const inputFile = path.join(dir, 'input.json');
    fs.writeFileSync(inputFile, JSON.stringify({ budget: 4000 }));
    const res = await runCli(['call', 'project.summary', '--input', inputFile], env());
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toHaveProperty('project');
  });

  it('call a denied op exits 2 with CAPABILITY_DENIED on stderr', async () => {
    const res = await runCli(
      ['call', 'proposal.approve', '--input', '-'],
      env(),
      JSON.stringify({ proposalId: newId(), rationale: '' }) + '\n',
    );
    expect(res.code).toBe(2);
    const err = JSON.parse(res.stderr.trim().split('\n')[0]!) as { error: { code: string } };
    expect(err.error.code).toBe('CAPABILITY_DENIED');
  });

  it('APP_NOT_RUNNING when the socket is missing', async () => {
    const res = await runCli(['call', 'project.summary', '--input', '-'], {
      ...env(),
      [envKeys.socketPath]: path.join(dir, 'nope.sock'),
    });
    expect(res.code).toBe(2);
    const err = JSON.parse(res.stderr.trim().split('\n')[0]!) as { error: { code: string } };
    expect(err.error.code).toBe('APP_NOT_RUNNING');
  });

  it('APP_NOT_RUNNING when env is unset', async () => {
    const res = await runCli(['call', 'project.summary', '--input', '-'], {
      [envKeys.socketPath]: '',
      [envKeys.token]: '',
    });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('APP_NOT_RUNNING');
  });

  it('CONNECTION_DENIED for a bad token', async () => {
    const res = await runCli(['call', 'project.summary', '--input', '-'], {
      ...env(),
      [envKeys.token]: 'nope',
    });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('CONNECTION_DENIED');
  });

  it('usage error exits 3', async () => {
    const res = await runCli(['call'], env());
    expect(res.code).toBe(3);
  });

  it('mcp mode: pipes JSON-RPC lines through the bridge after handoff', async () => {
    // Stand-in for the mcp-server package: echo back each frame with a marker.
    bridge.onMcpConnection = (socket, grant, buffered) => {
      const dec = new FrameDecoder();
      if (buffered.length) {
        for (const m of dec.push(buffered))
          socket.write(encodeFrame({ echoed: m, sessionId: grant.sessionId }));
      }
      socket.on('data', (chunk) => {
        for (const m of dec.push(chunk))
          socket.write(encodeFrame({ echoed: m, sessionId: grant.sessionId }));
      });
    };

    const res = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        const child = execFile(
          process.execPath,
          [CLI, 'mcp'],
          { env: { ...process.env, ...env() }, timeout: 15_000 },
          (error, stdout, stderr) =>
            resolve({ code: error ? (error.code as number) : 0, stdout, stderr }),
        );
        child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
        // Give the bridge a beat to welcome + hand off, then finish stdin.
        setTimeout(() => child.stdin?.end(), 300);
      },
    );
    expect(res.code).toBe(0);
    const line = res.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { echoed?: { method?: string } })[0];
    expect(line?.echoed?.method).toBe('ping');
  });
});
