/**
 * Core utility process: owns SQLite, PTY sessions, jobs, MCP server, bridge.
 * Communicates with the Electron main process over the parent port.
 */
import path from 'node:path';
import fs from 'node:fs';
import { StarkError, toErrorBody, AGENT_OPS } from '@stark/contracts';
import { CoreApp, HostServices, type ProjectContext } from '@stark/core';
import { createEngineTools } from '@stark/engineering';
import { PtySessionManager, BridgeServer, ConnectionManager } from '@stark/agent-host';
import { attachMcpToBridge } from '@stark/mcp-server';

interface ParentPort {
  postMessage(m: unknown): void;
  on(ev: 'message', cb: (m: { data: unknown }) => void): void;
}
declare const process: NodeJS.Process & { parentPort: ParentPort };
const port = process.parentPort;

const appDataDir = process.env.STARK_APP_DATA ?? path.join(process.env.HOME ?? '.', '.stark-dev');
fs.mkdirSync(appDataDir, { recursive: true });

/* Host services are proxied to the main process over the port. */
const hostPending = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: unknown) => void }
>();
let hostSeq = 0;
function hostCall<T>(method: string, args: unknown[]): Promise<T> {
  const id = `host-${++hostSeq}`;
  return new Promise<T>((resolve, reject) => {
    hostPending.set(id, { resolve: resolve as never, reject });
    port.postMessage({ type: 'hostCall', id, method, args });
    setTimeout(() => {
      if (hostPending.delete(id))
        reject(new StarkError('INTERNAL' as never, `host call timeout: ${method}`));
    }, 60_000);
  });
}

const host: HostServices = {
  researchOpen: (url) => hostCall('researchOpen', [url]),
  researchReadPage: () => hostCall('researchReadPage', []),
  researchFollowLink: (sel) => hostCall('researchFollowLink', [sel]),
  researchScreenshot: () => hostCall('researchScreenshot', []),
  revealPath: (p) => hostCall('revealPath', [p]),
  openExternal: (u) => hostCall('openExternal', [u]),
  notify: (t, b) => void hostCall('notify', [t, b]),
};

const app = new CoreApp(appDataDir, host);
app.engineTools = createEngineTools({
  openScadPath: app.toolPaths.openscad,
  onToolPath: (toolId, p) => app.setToolPath(toolId, p),
});
const bridge = new BridgeServer(app, appDataDir);
const ptyHost = new PtySessionManager(app, bridge);
app.terminalHost = ptyHost;
app.connectionHost = new ConnectionManager(app, bridge);
bridge.onMcpConnection = (sock, grant) => attachMcpToBridge(sock, app, grant);

/* Forward project events + terminal streams to main. */
function wireContext(ctx: ProjectContext): void {
  ctx.listeners.add((e) => {
    port.postMessage({ type: 'event', projectId: ctx.projectId, event: e });
    if (e.type === 'session.data') {
      port.postMessage({
        type: 'terminalData',
        projectId: ctx.projectId,
        data: (e.data as { chunk: string }).chunk,
      });
    }
    if (e.type === 'session.state') {
      port.postMessage({
        type: 'terminalState',
        projectId: ctx.projectId,
        session: ptyHost.state(ctx),
      });
    }
    if (e.type === 'job.updated') {
      port.postMessage({ type: 'jobProgress', projectId: ctx.projectId, data: e.data });
    }
  });
}
const origRegister = app.register.bind(app);
app.register = (handle) => {
  const ctx = origRegister(handle);
  wireContext(ctx);
  return ctx;
};

port.on('message', async (m) => {
  const msg = m.data as Record<string, unknown>;
  if (msg.type === 'hostResult') {
    const p = hostPending.get(msg.id as string);
    hostPending.delete(msg.id as string);
    if (msg.error) p?.reject(StarkError.fromBody(msg.error as never));
    else p?.resolve(msg.result);
    return;
  }
  if (msg.type === 'command') {
    const { requestId, op, payload, projectId, idempotencyKey } = msg as {
      requestId: string;
      op: string;
      payload: unknown;
      projectId?: string;
      idempotencyKey?: string;
    };
    try {
      const result = await app.dispatch(
        op,
        payload,
        { kind: 'user' },
        projectId as string | undefined,
        idempotencyKey,
      );
      port.postMessage({ type: 'result', requestId, ok: true, result });
    } catch (e) {
      port.postMessage({ type: 'result', requestId, ok: false, error: toErrorBody(e) });
    }
    return;
  }
  if (msg.type === 'shutdown') {
    bridge.close();
    app.closeAll();
    process.exit(0);
  }
});

/**
 * Packaged-smoke hook (STARK_SMOKE=1): creates/opens a smoke project, mints a
 * scoped bridge credential, and writes run/smoke.json so
 * scripts/packaged-smoke.mjs can drive a real `stark call` roundtrip.
 * Gated on the env var — never active in a normal launch.
 */
if (process.env.STARK_SMOKE === '1') {
  void (async () => {
    try {
      await bridge.ready;
      const projectDir = path.join(appDataDir, 'smoke-project');
      fs.mkdirSync(projectDir, { recursive: true });
      let projectId: string;
      const existing = fs.existsSync(path.join(projectDir, 'stark.project.json'));
      if (existing) {
        const r = (await app.dispatch('project.open', { path: projectDir }, { kind: 'user' })) as {
          projectId: string;
        };
        projectId = r.projectId;
      } else {
        const r = (await app.dispatch(
          'project.create',
          { name: 'STARK smoke', path: projectDir, intent: 'packaged smoke verification project' },
          { kind: 'user' },
        )) as { projectId: string };
        projectId = r.projectId;
      }
      const token = bridge.issueToken({ projectId, sessionId: 'packaged-smoke', ops: AGENT_OPS });
      const smoke = { socketPath: bridge.socketPath, token, projectId };
      fs.mkdirSync(path.dirname(smoke.socketPath), { recursive: true });
      fs.writeFileSync(path.join(appDataDir, 'run', 'smoke.json'), JSON.stringify(smoke));
      port.postMessage({ type: 'smokeReady', ...smoke });
    } catch (e) {
      port.postMessage({ type: 'smokeError', error: toErrorBody(e) });
    }
  })();
}

port.postMessage({ type: 'ready', socketPath: bridge.socketPath });
try {
  fs.appendFileSync(
    path.join(appDataDir, 'boot.log'),
    `utility ready socket=${bridge.socketPath}\n`,
  );
} catch {
  /* marker write is diagnostic only */
}
