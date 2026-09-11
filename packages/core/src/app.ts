import fs from 'node:fs';
import path from 'node:path';
import {
  AdapterStatus,
  ErrorCodes,
  Origin,
  SessionInfo,
  StarkError,
  newId,
} from '@stark/contracts';
import { ProjectHandle, createProject, openProject } from '@stark/storage';
import { ProjectContext, HostServices, EngineTools, nullHost } from './context.js';
import { ProjectWatcher } from './watcher.js';
import { dispatch } from './dispatch.js';
import { expandArchive, verifyArchive } from './build.js';

/** Terminal/session services provided by agent-host. */
export interface TerminalHost {
  start(
    ctx: ProjectContext,
    opts: { adapterId: string; executablePath?: string; args?: string[] },
  ): Promise<SessionInfo>;
  write(ctx: ProjectContext, data: string): void;
  resize(ctx: ProjectContext, cols: number, rows: number): void;
  interrupt(ctx: ProjectContext): void;
  stop(ctx: ProjectContext): Promise<void>;
  restart(ctx: ProjectContext): Promise<SessionInfo>;
  state(ctx: ProjectContext): SessionInfo | null;
}

export interface ConnectionHost {
  list(): Promise<AdapterStatus[]>;
  test(
    ctx: ProjectContext,
    adapterId: string,
  ): Promise<{ ok: boolean; error?: string; detail?: string }>;
  configure(
    adapterId: string,
    cfg: { executablePath?: string; args?: string[]; env?: Record<string, string> },
  ): Promise<void>;
}

/** Per-adapter persisted settings (executable, args, env, last test result). */
export interface AdapterSettings {
  executablePath?: string;
  args?: string[];
  env?: Record<string, string>;
  toolAccess?: 'mcp' | 'cli' | 'none';
  lastTestAt?: string | null;
  lastTestOk?: boolean | null;
  lastError?: string | null;
}

interface AppSettings {
  recentProjects: string[];
  adapters: Record<string, AdapterSettings>;
  prefs: Record<string, unknown>;
  toolPaths: Record<string, string>;
}

/**
 * Application root in the core process. Owns project contexts, settings,
 * recents, and the dispatch entry point for all transports.
 */
export class CoreApp {
  readonly contexts = new Map<string, ProjectContext>();
  private watchers = new Map<string, ProjectWatcher>();
  terminalHost: TerminalHost | null = null;
  connectionHost: ConnectionHost | null = null;
  engineTools: EngineTools = {};
  private settingsPath: string;
  private settings: AppSettings;

  constructor(
    public readonly appDataDir: string,
    public readonly host: HostServices = nullHost,
  ) {
    fs.mkdirSync(appDataDir, { recursive: true });
    this.settingsPath = path.join(appDataDir, 'settings.json');
    this.settings = this.loadSettings();
  }

  private loadSettings(): AppSettings {
    try {
      return {
        recentProjects: [],
        adapters: {},
        prefs: {},
        toolPaths: {},
        ...JSON.parse(fs.readFileSync(this.settingsPath, 'utf8')),
      };
    } catch {
      return { recentProjects: [], adapters: {}, prefs: {}, toolPaths: {} };
    }
  }
  private saveSettings(): void {
    fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2));
  }
  get adapterConfigs(): AppSettings['adapters'] {
    return this.settings.adapters;
  }
  /** Merge + persist per-adapter config (used by connection.configure/test). */
  setAdapterConfig(adapterId: string, cfg: AdapterSettings): void {
    this.settings.adapters[adapterId] = { ...this.settings.adapters[adapterId], ...cfg };
    this.saveSettings();
  }
  get toolPaths(): Record<string, string> {
    return this.settings.toolPaths;
  }
  setToolPath(toolId: string, p: string): void {
    this.settings.toolPaths[toolId] = p;
    this.saveSettings();
  }

  private rememberProject(root: string): void {
    this.settings.recentProjects = [
      root,
      ...this.settings.recentProjects.filter((p) => p !== root),
    ].slice(0, 12);
    this.saveSettings();
  }

  contextFor(projectId: string): ProjectContext {
    const ctx = this.contexts.get(projectId);
    if (!ctx) throw new StarkError(ErrorCodes.NOT_FOUND, `No open project: ${projectId}`);
    return ctx;
  }

  register(handle: ProjectHandle): ProjectContext {
    const existing = this.contexts.get(handle.project.id);
    if (existing) return existing;
    const ctx = new ProjectContext(handle, this.host);
    ctx.tools = this.engineTools;
    const watcher = new ProjectWatcher(ctx);
    watcher.start();
    this.contexts.set(handle.project.id, ctx);
    this.watchers.set(handle.project.id, watcher);
    this.rememberProject(handle.root);
    return ctx;
  }

  closeProject(projectId: string): void {
    this.watchers.get(projectId)?.stop();
    this.watchers.delete(projectId);
    const handle = this.contexts.get(projectId)?.handle;
    if (handle && handle.pdb.db.open) handle.close();
    this.contexts.delete(projectId);
  }

  /** Close every open project — used on app quit and in tests. */
  closeAll(): void {
    for (const id of [...this.contexts.keys()]) this.closeProject(id);
  }

  /** App-level + project-level op entry. projectId omitted for app ops. */
  async dispatch(
    op: string,
    payload: unknown,
    origin: Origin,
    projectId?: string,
    idempotencyKey?: string,
  ): Promise<unknown> {
    switch (op) {
      case 'project.create': {
        const p = payload as { name: string; path: string; intent: string };
        const handle = createProject(p.path, p.name, p.intent);
        const ctx = this.register(handle);
        return { project: handle.project, projectId: handle.project.id };
        void ctx;
      }
      case 'project.open': {
        const p = payload as { path: string };
        const handle = openProject(p.path);
        const ctx = this.register(handle);
        return { project: handle.project, projectId: handle.project.id, readOnly: handle.readOnly };
        void ctx;
      }
      case 'project.rename': {
        const ctx = this.contextFor(projectId!);
        const p = payload as { name: string };
        ctx.repo.updateProject({ name: p.name });
        return { project: ctx.repo.getProject() };
      }
      case 'project.update_intent': {
        const ctx = this.contextFor(projectId!);
        ctx.repo.updateProject({ intent: (payload as { intent: string }).intent });
        return { project: ctx.repo.getProject() };
      }
      case 'project.import_archive': {
        const p = payload as { archivePath: string; destDir: string; newIdentity: boolean };
        const { manifest } = verifyArchive(p.archivePath);
        if (this.contexts.has(manifest.projectId) && !p.newIdentity) {
          throw new StarkError(ErrorCodes.VALIDATION, 'Project already open', {
            repair: 'Close it first, or import with newIdentity to make a copy.',
          });
        }
        expandArchive(p.archivePath, p.destDir);
        if (p.newIdentity) {
          // Re-identify: new project id in file + DB row.
          const pfPath = path.join(p.destDir, 'stark.project.json');
          const pf = JSON.parse(fs.readFileSync(pfPath, 'utf8'));
          pf.id = newId();
          pf.name = `${pf.name} (copy)`;
          fs.writeFileSync(pfPath, JSON.stringify(pf, null, 2));
          const handle = openProject(p.destDir);
          handle.repo.db.prepare(`UPDATE project SET id=?, name=?`).run(pf.id, pf.name);
          handle.repo.appendEvent('project.imported', 'user', {
            from: manifest.projectId,
            copy: true,
          });
          const ctx = this.register(handle);
          return { project: handle.project, projectId: ctx.projectId };
        }
        const handle = openProject(p.destDir);
        handle.repo.appendEvent('project.imported', 'user', { from: manifest.projectId });
        const ctx = this.register(handle);
        return { project: handle.project, projectId: ctx.projectId };
      }
      case 'app.recent_projects':
        return { projects: this.settings.recentProjects.filter((p) => fs.existsSync(p)) };
      case 'app.diagnostics':
        return {
          appDataDir: this.appDataDir,
          openProjects: [...this.contexts.keys()],
          versions: { node: process.version },
        };
      case 'settings.get': {
        const key = (payload as { key?: string }).key;
        if (!key) return { settings: this.settings };
        const [a, b] = key.split('.');
        return {
          value: (this.settings as unknown as Record<string, Record<string, unknown>>)[a!]?.[b!],
        };
      }
      case 'settings.set': {
        const { key, value } = payload as { key: string; value: unknown };
        const [a, b] = key.split('.');
        if (!a || !b) throw new StarkError(ErrorCodes.VALIDATION, `Bad settings key: ${key}`);
        (this.settings as unknown as Record<string, Record<string, unknown>>)[a] ??= {};
        (this.settings as unknown as Record<string, Record<string, unknown>>)[a]![b!] = value;
        this.saveSettings();
        return { ok: true };
      }
      case 'terminal.start':
        return this.terminalHost!.start(this.contextFor(projectId!), payload as never);
      case 'terminal.write':
        this.terminalHost!.write(this.contextFor(projectId!), (payload as { data: string }).data);
        return { ok: true };
      case 'terminal.resize': {
        const p = payload as { cols: number; rows: number };
        this.terminalHost!.resize(this.contextFor(projectId!), p.cols, p.rows);
        return { ok: true };
      }
      case 'terminal.interrupt':
        this.terminalHost!.interrupt(this.contextFor(projectId!));
        return { ok: true };
      case 'terminal.stop':
        await this.terminalHost!.stop(this.contextFor(projectId!));
        return { ok: true };
      case 'terminal.restart':
        return this.terminalHost!.restart(this.contextFor(projectId!));
      case 'terminal.state':
        return { session: this.terminalHost?.state(this.contextFor(projectId!)) ?? null };
      case 'connection.list':
        return { adapters: (await this.connectionHost?.list()) ?? [] };
      case 'connection.test': {
        const p = payload as { adapterId: string };
        if (!this.connectionHost)
          throw new StarkError(ErrorCodes.TOOL_MISSING, 'No connection host');
        return this.connectionHost.test(this.contextFor(projectId!), p.adapterId);
      }
      case 'connection.configure': {
        const p = payload as {
          adapterId: string;
          executablePath?: string;
          args?: string[];
          env?: Record<string, string>;
        };
        if (!this.connectionHost)
          throw new StarkError(ErrorCodes.TOOL_MISSING, 'No connection host');
        return this.connectionHost.configure(p.adapterId, p);
      }
      default: {
        const ctx = this.contextFor(projectId!);
        return dispatch(ctx, { op, payload, origin, idempotencyKey });
      }
    }
  }
}
