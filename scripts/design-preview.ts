/**
 * Disposable, loopback-only preview: the real renderer on the real Rust host.
 *
 * Builds `omenflow-host`, starts it on a scratch directory, builds the fixture
 * projects through it, and serves the renderer with Vite. The page talks only
 * to this server's `/__omen_preview` endpoints; they forward to the host, which
 * never sees the page and whose token never leaves this process.
 *
 * The endpoints act as the person, so they answer only a browser that opened
 * the address printed on this terminal: its `key` is exchanged for a cookie
 * scoped to this port, and every endpoint requires that cookie. Header checks
 * alone stop other web pages, not other local programs. The scratch directory
 * is removed when the preview stops.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'vite';
import type { Revision } from '@omenflow/contracts';
import { buildRoverProject } from '../fixtures/rover/rover.fixture';
import { buildDroneProject } from '../fixtures/drone-dependencies/drone.fixture';
import { makePreviewMesh } from '../design-system/fixtures/preview-mesh';
import { buildHost, RustCore, type Envelope } from '../tests/conformance/rust-core';

const MAX_REQUEST_CHARS = 8_000_000;
/**
 * Terminals and adapter settings start processes, so the preview offers them
 * only when it was started with OMEN_PREVIEW_AGENTS=1: an agent CLI runs
 * models and may update itself, and a Custom CLI runs any executable.
 */
const AGENTS_ENABLED = process.env.OMEN_PREVIEW_AGENTS === '1';
/** Operations that start or configure a process; reading state stays open. */
const PROCESS_OPS = new Set([
  'terminal.start',
  'terminal.restart',
  'connection.configure',
  'connection.test',
]);

/** A request this preview will not forward, said in words the interface can show. */
class Refused extends Error {
  constructor(
    message: string,
    readonly repair?: string,
  ) {
    super(message);
  }
}

/**
 * The helper agent CLIs call back through, built (or brought up to date) the
 * way `pnpm build:bridge` builds it, so a terminal here runs the current one.
 */
function bridgeHelper(): string {
  const manifest = path.resolve('native/omenflow-bridge/Cargo.toml');
  const build = spawnSync(
    'cargo',
    ['build', '--release', '--locked', '--manifest-path', manifest],
    // The helper is its own workspace with its own target directory.
    { stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: undefined } },
  );
  if (build.status !== 0) throw new Error('Could not build the omenflow bridge helper');
  return path.resolve(
    'native/omenflow-bridge/target/release',
    process.platform === 'win32' ? 'omenflow.exe' : 'omenflow',
  );
}

async function main() {
  const previewRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omen-design-')));
  // Removed however the process ends: a stop, Vite's own SIGTERM handler
  // (which exits once Vite has closed) or a failure while starting.
  process.on('exit', () => {
    fs.rmSync(previewRoot, { recursive: true, force: true });
    console.log(`Removed the disposable project data at ${previewRoot}`);
  });
  const app = await RustCore.start(path.join(previewRoot, 'app'), {
    binary: buildHost(),
    cli: bridgeHelper(),
  });
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
    payloadPatch: {
      target: { value: 45, unit: 'min' },
      acceptanceCriterion: '≥45 min mixed drive/idle telemetry at 20 °C from a fully charged pack.',
    },
    rationale: 'Longer inspection mission for the reference project.',
  });

  let activeId: string | null = rover.projectId;
  const streams = new Set<http.ClientRequest>();
  const token = randomUUID();
  /** Printed on this terminal only; the page trades it for the cookie. */
  const key = randomUUID();
  // Parallel previews (one per working copy) each need their own port.
  const port = Number(process.env.OMEN_PREVIEW_PORT ?? 5173);
  const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const inside = (candidate: string) => candidate.startsWith(previewRoot + path.sep);
  /** Whether an existing path, with links followed, is inside the preview directory. */
  const existsInside = (candidate: string) => {
    try {
      return inside(fs.realpathSync(candidate));
    } catch {
      return false;
    }
  };

  // Cookies are scoped by host, not port, so each preview names its own.
  const cookieName = `omen_preview_${port}`;
  const hasCookie = (req: IncomingMessage) =>
    (req.headers.cookie ?? '').split(';').some((part) => part.trim() === `${cookieName}=${token}`);
  /**
   * Only this preview's own page may use the endpoints: they act as the
   * person. The cookie proves the browser opened the printed address; the
   * header checks keep other web pages out.
   */
  const fromThisPage = (req: IncomingMessage) => {
    const site = req.headers['sec-fetch-site'];
    return (
      hasCookie(req) &&
      origins.includes(`http://${req.headers.host}`) &&
      (req.headers.origin === undefined || origins.includes(req.headers.origin)) &&
      (site === undefined || site === 'same-origin' || site === 'none')
    );
  };

  /** Apply the preview's limits, then run the command on the host. */
  const command = async (
    op: string,
    payload: Record<string, unknown>,
    opts: { projectId?: string; idempotencyKey?: string },
  ): Promise<Envelope> => {
    if (op === '__active') {
      activeId = (payload.id as string | null) ?? null;
      return { requestId: randomUUID(), ok: true, result: {} };
    }
    if (op === 'project.create' && !inside(path.resolve(String(payload.path))))
      throw new Refused('Create projects inside the disposable preview directory.');
    if (op === 'project.open' && !existsInside(String(payload.path)))
      throw new Refused('Only preview projects can be opened here.');
    if (op === 'project.import_archive')
      throw new Refused('Open project archives in the desktop app.');
    if (PROCESS_OPS.has(op) && !AGENTS_ENABLED)
      throw new Refused(
        'Terminals and agent settings are off in the design preview unless it was started with OMEN_PREVIEW_AGENTS=1.',
        'Restart the preview with OMEN_PREVIEW_AGENTS=1 to run a terminal here, or use the desktop app.',
      );
    if (op === 'project.export_archive' || op === 'build.export') {
      fs.mkdirSync(path.join(previewRoot, 'exports'), { recursive: true });
      payload.destPath = path.join(previewRoot, 'exports', path.basename(String(payload.destPath)));
    }
    return app.command(op, payload, opts.projectId ?? activeId, opts.idempotencyKey);
  };

  /** Pass the host's event stream through, including where the page left off. */
  const streamEvents = (req: IncomingMessage, res: ServerResponse) => {
    const lastEventId = req.headers['last-event-id'];
    const upstream = http.get({
      host: '127.0.0.1',
      port: app.port,
      path: '/api/events',
      headers: {
        Authorization: `Bearer ${app.token}`,
        ...(typeof lastEventId === 'string' ? { 'Last-Event-ID': lastEventId } : {}),
      },
    });
    streams.add(upstream);
    const end = () => {
      streams.delete(upstream);
      upstream.destroy();
      res.end();
    };
    upstream.on('response', (events) => {
      res.writeHead(events.statusCode ?? 502, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      events.pipe(res);
      events.on('end', end);
    });
    upstream.on('error', end);
    req.on('close', end);
  };

  const server = await createServer({
    root: path.resolve('apps/desktop'),
    configFile: path.resolve('apps/desktop/vite.renderer.config.ts'),
    server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [path.resolve('.')] } },
    plugins: [
      {
        name: 'omen-design-preview',
        configureServer(vite) {
          // The printed address carries the key once; the browser keeps a
          // cookie instead and the address bar loses the key.
          vite.middlewares.use((req, res, next) => {
            const [pathname, query = ''] = (req.url ?? '/').split('?');
            const parts = query.split('&');
            if (!parts.includes(`key=${key}`)) return next();
            // The rest of the address stays as written (`?design-preview`).
            const kept = parts.filter((part) => !part.startsWith('key=')).join('&');
            res.statusCode = 303;
            res.setHeader(
              'Set-Cookie',
              `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`,
            );
            res.setHeader('Location', kept ? `${pathname}?${kept}` : pathname!);
            res.end();
          });
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
            const refuse = () => {
              res.statusCode = 403;
              res.end();
            };
            if (!fromThisPage(req)) return refuse();
            if (url.pathname === '/bootstrap') {
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Cache-Control', 'no-store');
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
              if (url.searchParams.get('token') !== token) return refuse();
              streamEvents(req, res);
              return;
            }
            if (
              url.pathname !== '/command' ||
              req.method !== 'POST' ||
              req.headers['x-omen-preview'] !== token
            )
              return refuse();
            let envelope: Envelope;
            try {
              let body = '';
              for await (const chunk of req) {
                body += chunk;
                if (body.length > MAX_REQUEST_CHARS) throw new Refused('Preview request too large');
              }
              const { op, payload = {}, opts = {} } = JSON.parse(body);
              envelope = await command(op, payload, opts);
            } catch (error) {
              const e = error as Error & { code?: string; repair?: string };
              envelope = {
                requestId: randomUUID(),
                ok: false,
                error: { code: e.code ?? 'PREVIEW', message: e.message, repair: e.repair },
              };
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(envelope));
          });
        },
      },
    ],
  });
  await server.listen();
  console.log(`Omen Flow design preview: http://127.0.0.1:${port}/?design-preview&key=${key}`);
  console.log(`Launcher: http://127.0.0.1:${port}/?design-preview&screen=launcher&key=${key}`);
  console.log('Open one of these addresses; the key lets only that browser use the preview.');
  console.log(`Disposable project data (removed when the preview stops): ${previewRoot}`);
  console.log(
    AGENTS_ENABLED
      ? 'Terminals start for real from the Agent tab, agent CLIs included (OMEN_PREVIEW_AGENTS=1).'
      : 'Terminals are off. Set OMEN_PREVIEW_AGENTS=1 to run a Custom CLI, Codex or Claude Code.',
  );
  const stop = async () => {
    for (const stream of streams) stream.destroy();
    try {
      await app.shutdown();
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
