/** Disposable, loopback-only preview using the real renderer and engineering core. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import { CoreApp, nullHost } from '@omenflow/core';
import { createEngineTools } from '@omenflow/engineering';
import type { Revision, AdapterStatus, ProjectEvent } from '@omenflow/contracts';
import { buildRoverProject } from '../fixtures/rover/rover.fixture';
import { buildDroneProject } from '../fixtures/drone-dependencies/drone.fixture';
import { makePreviewMesh } from '../design-system/fixtures/preview-mesh';
import type { ServerResponse } from 'node:http';

async function main() {
  const previewRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omen-design-')));
  const app = new CoreApp(path.join(previewRoot, 'appdata'), nullHost);
  app.engineTools = createEngineTools();
  const rover = await buildRoverProject(app, path.join(previewRoot, 'Sable inspection rover'));
  const drone = await buildDroneProject(app, path.join(previewRoot, 'Scout payload drone'));
  const user = { kind: 'user' as const };
  const call = <T>(op: string, payload: unknown = {}) =>
    app.dispatch(op, payload, user, rover.projectId) as Promise<T>;
  await call('project.update_intent', {
    intent:
      'A compact inspection rover with a removable camera tray. Engineered for indoor floors, short ramps, and a 300 g sensor payload.',
  });
  const mech = await call<{ revision: Revision }>('artifact.read', {
    artifactId: rover.mechanical.artifactId,
  });
  await call('artifact.apply_edit', {
    artifactId: rover.mechanical.artifactId,
    baseRevisionId: mech.revision.id,
    fileWrites: [
      {
        path: 'camera-tray.preview.stl',
        contentBase64: Buffer.from(makePreviewMesh()).toString('base64'),
      },
    ],
    payloadPatch: {
      manufacturing:
        'Illustrative design-preview mesh. Not a verified OpenSCAD render or manufacturing model.',
    },
    rationale: 'Attach illustrative geometry for visual design review only.',
  });
  // A real proposed change, left pending so the full review interaction can be exercised.
  const requirement = await call<{ revision: Revision }>('artifact.read', {
    artifactId: rover.payloadReq.artifactId,
  });
  const draft = await call<{ revision: Revision }>('artifact.update_draft', {
    artifactId: rover.payloadReq.artifactId,
    baseRevisionId: requirement.revision.id,
    payload: { ...(requirement.revision.payload as object), target: { value: 0.5, unit: 'kg' } },
    rationale: 'Evaluate a heavier sensor package.',
  });
  await call('proposal.submit', {
    reason: 'Increase payload capacity to 500 g',
    changes: [
      {
        artifactId: rover.payloadReq.artifactId,
        baseRevisionId: requirement.revision.id,
        newRevisionId: draft.revision.id,
        kind: 'baseline_update',
      },
    ],
  });
  // A second recorded requirement change populates the decision history.
  const end = await call<{ revision: Revision }>('artifact.read', {
    artifactId: rover.enduranceReq.artifactId,
  });
  await call('artifact.apply_edit', {
    artifactId: rover.enduranceReq.artifactId,
    baseRevisionId: end.revision.id,
    payloadPatch: { target: { value: 45, unit: 'min' } },
    rationale: 'Longer inspection mission for the reference project.',
  });
  const adapters: AdapterStatus[] = ['Codex CLI', 'Claude Code', 'Custom CLI'].map((label, i) => ({
    adapterId: ['codex', 'claude-code', 'custom'][i]!,
    label,
    available: false,
    executablePath: null,
    version: null,
    testedVersionRange: null,
    recognizedVersion: false,
    capabilities: { cli: true, mcp: true, resume: false },
    lastTestAt: null,
    lastTestOk: null,
    lastError: null,
    installHint: 'Connect in the desktop app. Agent execution is disabled in this design preview.',
  }));
  app.connectionHost = {
    async list() {
      return adapters;
    },
    async test() {
      return { ok: false, error: 'Use the desktop app to test local agents.' };
    },
    async configure() {
      throw new Error('Configure local tools in the desktop app.');
    },
  };
  let activeId: string | null = rover.projectId;
  const clients = new Set<ServerResponse>();
  const emit = (event: ProjectEvent) => {
    for (const client of clients) client.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  for (const context of app.contexts.values()) context.listeners.add(emit);
  const token = randomUUID();
  const server = await createServer({
    root: path.resolve('apps/desktop'),
    configFile: path.resolve('apps/desktop/vite.renderer.config.ts'),
    server: { host: '127.0.0.1', port: 5173, strictPort: true, fs: { allow: [path.resolve('.')] } },
    plugins: [
      {
        name: 'omen-design-preview',
        configureServer(vite) {
          const designRoot = path.resolve('design-system');
          vite.middlewares.use('/design-system', (req, res) => {
            try {
              const pathname = decodeURIComponent((req.url ?? '/').split('?')[0]!);
              const file = path.resolve(
                designRoot,
                `.${pathname === '/' ? '/index.html' : pathname}`,
              );
              if (!file.startsWith(designRoot + path.sep) || !fs.statSync(file).isFile()) {
                res.statusCode = 404;
                res.end();
                return;
              }
              const types: Record<string, string> = {
                '.html': 'text/html',
                '.css': 'text/css',
                '.svg': 'image/svg+xml',
                '.png': 'image/png',
                '.woff2': 'font/woff2',
                '.md': 'text/plain; charset=utf-8',
                '.json': 'application/json',
              };
              res.setHeader('Content-Type', types[path.extname(file)] ?? 'text/plain');
              res.end(fs.readFileSync(file));
            } catch {
              res.statusCode = 404;
              res.end('Not found');
            }
          });
          vite.middlewares.use('/__omen_preview', async (req, res) => {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            if (url.pathname === '/bootstrap') {
              res.setHeader('Content-Type', 'application/json');
              res.end(
                JSON.stringify({
                  token,
                  path: rover.dir,
                  projectId: rover.projectId,
                  previewRoot,
                  otherProjectId: drone.projectId,
                }),
              );
              return;
            }
            if (url.pathname === '/events') {
              if (url.searchParams.get('token') !== token) {
                res.statusCode = 403;
                res.end();
                return;
              }
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
              });
              res.write(': connected\n\n');
              clients.add(res);
              req.on('close', () => clients.delete(res));
              return;
            }
            if (req.method !== 'POST' || req.headers['x-omen-preview'] !== token) {
              res.statusCode = 403;
              res.end();
              return;
            }
            try {
              let body = '';
              for await (const chunk of req) {
                body += chunk;
                if (body.length > 8_000_000) throw new Error('Preview request too large');
              }
              const { op, payload = {}, opts = {} } = JSON.parse(body);
              let result: unknown;
              if (op === '__active') {
                activeId = payload.id;
                result = {};
              } else if (
                op.startsWith('terminal.') &&
                op !== 'terminal.state' &&
                op !== 'terminal.resize'
              )
                throw new Error(
                  'Agent execution is available in the desktop app. This preview runs only the engineering record.',
                );
              else if (op === 'terminal.resize') result = {};
              else {
                if (
                  op === 'project.create' &&
                  !path.resolve(payload.path).startsWith(previewRoot + path.sep)
                )
                  throw new Error('Create projects inside the disposable preview directory.');
                if (
                  op === 'project.open' &&
                  !fs.realpathSync(payload.path).startsWith(previewRoot + path.sep)
                )
                  throw new Error('Only preview projects can be opened here.');
                if (op === 'project.import_archive')
                  throw new Error('Open project archives in the desktop app.');
                if (op === 'project.export_archive' || op === 'build.export') {
                  fs.mkdirSync(path.join(previewRoot, 'exports'), { recursive: true });
                  payload.destPath = path.join(
                    previewRoot,
                    'exports',
                    path.basename(payload.destPath),
                  );
                }
                result = await app.dispatch(
                  op,
                  payload,
                  user,
                  opts.projectId ?? activeId ?? undefined,
                );
              }
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ requestId: randomUUID(), ok: true, result }));
            } catch (error) {
              const e = error as Error & { code?: string; repair?: string };
              res.setHeader('Content-Type', 'application/json');
              res.end(
                JSON.stringify({
                  requestId: randomUUID(),
                  ok: false,
                  error: { code: e.code ?? 'PREVIEW', message: e.message, repair: e.repair },
                }),
              );
            }
          });
        },
      },
    ],
  });
  await server.listen();
  console.log('Omen Flow design preview: http://127.0.0.1:5173/?design-preview');
  console.log('Launcher: http://127.0.0.1:5173/?design-preview&screen=launcher');
  console.log(`Disposable project data: ${previewRoot}`);
  const stop = async () => {
    for (const client of clients) client.end();
    app.closeAll();
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}
void main();
