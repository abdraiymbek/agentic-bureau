import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  Notification,
  Menu,
  protocol,
  utilityProcess,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
// @ts-expect-error no published types for squirrel-startup
import started from 'electron-squirrel-startup';
import { IPC, MAX_EXTRACT_CHARS } from '@stark/contracts';
import { ResearchSurface } from './research.js';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

// Register the app scheme as a standard+secure scheme BEFORE app ready so
// 'self' in the page CSP covers stark-app:// subresources (opaque-origin
// schemes break script-src 'self').
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'stark-app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

if (started) app.quit();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow: BrowserWindow | null = null;
let coreProc: Electron.UtilityProcess | null = null;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
let reqSeq = 0;
let activeProjectId: string | null = null;
let research: ResearchSurface | null = null;

const winStateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function sendToCore(msg: Record<string, unknown>): void {
  coreProc?.postMessage(msg);
}

function callCore<T>(op: string, payload: unknown, idempotencyKey?: string): Promise<T> {
  if (!coreProc) {
    return Promise.reject(
      new Error(
        'Omen Flow’s workspace service is unavailable. Quit and reopen Omen Flow to reconnect.',
      ),
    );
  }
  const requestId = `req-${++reqSeq}`;
  return new Promise<T>((resolve, reject) => {
    pending.set(requestId, { resolve: resolve as never, reject });
    sendToCore({
      type: 'command',
      requestId,
      op,
      payload,
      projectId: activeProjectId,
      idempotencyKey,
    });
    setTimeout(() => {
      if (pending.delete(requestId)) reject(new Error(`core call timeout: ${op}`));
    }, 300_000);
  });
}

function startCore(): void {
  const utilityPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'core', 'utility.js')
    : path.join(__dirname, '..', '..', 'resources', 'core', 'utility.js');
  fs.writeFileSync(
    path.join(app.getPath('userData'), 'boot.log'),
    `main fork ${utilityPath} exists=${fs.existsSync(utilityPath)}\n`,
  );
  coreProc = utilityProcess.fork(utilityPath, [], {
    serviceName: 'stark-core',
    // utilityProcess.fork requires stdin to be 'ignore'.
    stdio: ['ignore', 'pipe', 'inherit'],
    env: {
      // Test hooks may redirect app data (packaged-smoke); default is userData.
      STARK_APP_DATA: process.env.STARK_APP_DATA ?? app.getPath('userData'),
      ...(process.env.STARK_SMOKE ? { STARK_SMOKE: process.env.STARK_SMOKE } : {}),
    },
  });
  coreProc.on('message', (msg: Record<string, unknown>) => {
    if (msg.type === 'result') {
      const p = pending.get(msg.requestId as string);
      pending.delete(msg.requestId as string);
      if (msg.ok) p?.resolve(msg.result);
      else
        p?.reject(
          Object.assign(new Error((msg.error as { message?: string })?.message ?? 'error'), {
            body: msg.error,
          }),
        );
      return;
    }
    if (msg.type === 'event' && mainWindow) {
      mainWindow.webContents.send(IPC.event, msg.event);
      return;
    }
    if (msg.type === 'terminalData' && mainWindow) {
      mainWindow.webContents.send(IPC.terminalData, msg.data);
      return;
    }
    if (msg.type === 'terminalState' && mainWindow) {
      mainWindow.webContents.send(IPC.terminalState, msg.session);
      return;
    }
    if (msg.type === 'jobProgress' && mainWindow) {
      mainWindow.webContents.send(IPC.jobProgress, msg.data);
      return;
    }
    if (msg.type === 'hostCall') {
      void handleHostCall(msg.id as string, msg.method as string, msg.args as unknown[]);
      return;
    }
    if (msg.type === 'ready') {
      console.log('[core] ready, bridge socket:', msg.socketPath);
      return;
    }
  });
  coreProc.on('exit', (code) => {
    console.error('[core] exited', code);
    for (const p of pending.values()) p.reject(new Error('core process exited'));
    pending.clear();
    coreProc = null;
  });
  coreProc.stdout?.on('data', (d) => process.stdout.write(`[core] ${d}`));
  coreProc.stderr?.on('data', (d) => process.stderr.write(`[core!] ${d}`));
}

/* ------------------------------------------------------------------ */
/* Host services (executed in main, requested by core)                   */
/* ------------------------------------------------------------------ */

async function handleHostCall(id: string, method: string, args: unknown[]): Promise<void> {
  try {
    if (!research) research = new ResearchSurface(() => mainWindow);
    let result: unknown;
    switch (method) {
      case 'researchOpen':
        result = await research.open(args[0] as string);
        break;
      case 'researchReadPage':
        result = await research.readPage();
        break;
      case 'researchFollowLink':
        result = await research.followLink(args[0] as { selector?: string; url?: string });
        break;
      case 'researchScreenshot':
        result = await research.screenshot();
        break;
      case 'revealPath':
        shell.showItemInFolder(args[0] as string);
        result = null;
        break;
      case 'openExternal': {
        const url = args[0] as string;
        if (/^https?:\/\//.test(url)) await shell.openExternal(url);
        result = null;
        break;
      }
      case 'notify': {
        if (Notification.isSupported())
          new Notification({ title: args[0] as string, body: args[1] as string }).show();
        result = null;
        break;
      }
      default:
        throw new Error(`unknown host method ${method}`);
    }
    sendToCore({ type: 'hostResult', id, result });
  } catch (e) {
    sendToCore({
      type: 'hostResult',
      id,
      error: { code: 'INTERNAL', message: (e as Error).message },
    });
  }
}

/* ------------------------------------------------------------------ */
/* Window                                                               */
/* ------------------------------------------------------------------ */

function loadWindowState(): { width: number; height: number; x?: number; y?: number } {
  try {
    return JSON.parse(fs.readFileSync(winStateFile(), 'utf8'));
  } catch {
    return { width: 1440, height: 900 };
  }
}

function createWindow(): void {
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#161719',
    title: 'Omen Flow',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.on('close', () => {
    if (!mainWindow) return;
    const b = mainWindow.getBounds();
    fs.mkdirSync(path.dirname(winStateFile()), { recursive: true });
    fs.writeFileSync(winStateFile(), JSON.stringify(b));
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Navigation policy: no unexpected navigation, no new windows.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const devUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL;
    const allowed = (devUrl && url.startsWith(devUrl)) || url.startsWith('stark-app://');
    if (!allowed) e.preventDefault();
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadURL('stark-app://main_window/index.html');
  }
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' }, // required for terminal copy/paste
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ */
/* IPC                                                                  */
/* ------------------------------------------------------------------ */

function wireIpc(): void {
  ipcMain.handle(
    IPC.command,
    async (
      _e,
      body: { op: string; payload: unknown; projectId?: string; idempotencyKey?: string },
    ) => {
      // projectId in the body wins (renderer knows its project); fall back to active.
      const pid = body.projectId ?? activeProjectId ?? undefined;
      const requestId = `req-${++reqSeq}`;
      return new Promise((resolve) => {
        pending.set(requestId, {
          resolve: (v) => resolve({ ok: true, result: v }),
          reject: (e) => {
            const err = e as { body?: { code: string; message: string }; message?: string };
            resolve({
              ok: false,
              error: err.body ?? { code: 'INTERNAL', message: err.message ?? 'error' },
            });
          },
        });
        sendToCore({
          type: 'command',
          requestId,
          op: body.op,
          payload: body.payload,
          projectId: pid,
          idempotencyKey: body.idempotencyKey,
        });
        setTimeout(() => {
          if (pending.delete(requestId)) {
            resolve({ ok: false, error: { code: 'INTERNAL', message: `timeout: ${body.op}` } });
          }
        }, 300_000);
      });
    },
  );

  ipcMain.handle('stark:set-active-project', (_e, id: string | null) => {
    activeProjectId = id;
  });

  ipcMain.handle(IPC.pickDirectory, async (_e, opts?: { title?: string }) => {
    if (!mainWindow) return null;
    const r = await dialog.showOpenDialog(mainWindow, {
      title: opts?.title ?? 'Choose folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle(
    IPC.pickFile,
    async (_e, opts?: { title?: string; filters?: { name: string; extensions: string[] }[] }) => {
      if (!mainWindow) return null;
      const r = await dialog.showOpenDialog(mainWindow, {
        title: opts?.title ?? 'Choose file',
        properties: ['openFile'],
        filters: opts?.filters,
      });
      return r.canceled ? null : r.filePaths[0];
    },
  );
  ipcMain.handle(
    IPC.saveFile,
    async (
      _e,
      opts?: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] },
    ) => {
      if (!mainWindow) return null;
      const r = await dialog.showSaveDialog(mainWindow, {
        defaultPath: opts?.defaultPath,
        filters: opts?.filters,
      });
      return r.canceled ? null : r.filePath;
    },
  );
  ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
    if (/^https?:\/\//.test(url)) await shell.openExternal(url);
  });
  ipcMain.handle(IPC.openPath, async (_e, p: string) => shell.showItemInFolder(p));
  ipcMain.handle('stark:toggle-research', async () => {
    if (!research) research = new ResearchSurface(() => mainWindow);
    research.toggle();
  });
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                            */
/* ------------------------------------------------------------------ */

app.whenReady().then(() => {
  // Registered local application protocol for production builds.
  if (!MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    protocol.handle('stark-app', (req) => {
      const url = new URL(req.url);
      // stark-app://main_window/index.html → .vite/renderer/main_window/index.html
      const rel = `${url.hostname}${url.pathname}`;
      const file = path.join(__dirname, '..', 'renderer', rel);
      // fs is asar-aware; net.fetch(file://) is not — the network service
      // can't read inside app.asar, which left the window blank.
      try {
        const body = fs.readFileSync(file);
        const ext = path.extname(file).toLowerCase();
        const type =
          {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.mjs': 'text/javascript',
            '.css': 'text/css',
            '.json': 'application/json',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.woff': 'font/woff',
            '.woff2': 'font/woff2',
          }[ext] ?? 'application/octet-stream';
        return new Response(new Uint8Array(body), { headers: { 'content-type': type } });
      } catch {
        return new Response('not found', { status: 404 });
      }
    });
  }
  buildMenu();
  startCore();
  wireIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // macOS keeps the app alive; a reopened window still needs the core service.
  // before-quit owns shutdown on every platform.
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  sendToCore({ type: 'shutdown' });
});
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

export { callCore };
