import fs from 'node:fs';
import path from 'node:path';
import {
  AdapterStatus,
  ErrorCodes,
  Origin,
  PROJECT_FILE,
  SessionInfo,
  BureauError,
  newId,
  OPS_BY_NAME,
} from '@bureau/contracts';
import {
  ProjectHandle,
  createProject,
  openProject,
  canonicalize,
  updateProjectFile,
  writeRenameJournal,
  clearRenameJournal,
  readProjectFile,
} from '@bureau/storage';
import { ProjectContext, HostServices, EngineTools, nullHost } from './context.js';
import { ProjectWatcher } from './watcher.js';
import { assertServedByLegacyCore, dispatch } from './dispatch.js';
import { expandArchive, verifyArchive } from './build.js';
import { propagateFrom } from './graph.js';
import { pruneHistoricalSessionData } from './session-retention.js';
import {
  type AppReservation,
  type DurabilityBoundary,
  type DurabilityHook,
  appReservationKey,
  hashRequest,
  loadAppReservations,
  recoverResultJournals,
  replayAppReservation,
  runDurabilityHooks,
  saveAppReservations,
} from './durability.js';

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
  getScrollback?(ctx: ProjectContext): string;
  getScrollbackSnapshot?(ctx: ProjectContext): { text: string; cursor: number };
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
  readonly durabilityHooks: DurabilityHook[] = [];
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
    // Canonicalize so /tmp/x and /private/tmp/x don't duplicate on macOS.
    const canon = (p: string) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return p;
      }
    };
    const key = canon(root);
    this.settings.recentProjects = [
      key,
      ...this.settings.recentProjects.filter((p) => canon(p) !== key),
    ].slice(0, 12);
    this.saveSettings();
  }

  contextFor(projectId: string): ProjectContext {
    const ctx = this.contexts.get(projectId);
    if (!ctx) throw new BureauError(ErrorCodes.NOT_FOUND, `No open project: ${projectId}`);
    return ctx;
  }

  crash(boundary: DurabilityBoundary, detail?: unknown): void {
    runDurabilityHooks(this.durabilityHooks, boundary, detail);
  }

  private liveContextAt(root: string): ProjectContext | undefined {
    const canon = canonicalize(root);
    return [...this.contexts.values()].find((c) => c.root === canon);
  }

  private appKey(op: string, origin: Origin, idempotencyKey?: string): string | null {
    if (!idempotencyKey) return null;
    return appReservationKey(
      origin.kind,
      origin.kind === 'agent' ? origin.sessionId : undefined,
      op,
      idempotencyKey,
    );
  }

  private openExistingProject(dir: string): ProjectContext | undefined {
    const root = canonicalize(dir);
    const live = this.liveContextAt(root);
    if (live) return live;
    if (!fs.existsSync(path.join(root, PROJECT_FILE))) return undefined;
    const marker = JSON.parse(fs.readFileSync(path.join(root, PROJECT_FILE), 'utf8')) as {
      id?: string;
    };
    if (marker.id && this.contexts.has(marker.id) && this.contexts.get(marker.id)!.root !== root)
      throw new BureauError(
        ErrorCodes.REVISION_CONFLICT,
        'Another folder with this project identity is already open; import a copy with a new identity',
      );
    return this.register(openProject(root));
  }

  private putAppReservation(key: string, reservation: AppReservation): void {
    const reservations = loadAppReservations(this.appDataDir);
    reservations[key] = reservation;
    saveAppReservations(this.appDataDir, reservations);
  }

  private reservation(key: string): AppReservation | undefined {
    return loadAppReservations(this.appDataDir)[key];
  }

  private completeAppReservation(key: string, requestHash: string, result: unknown): void {
    this.putAppReservation(key, {
      ...(this.reservation(key) ?? {
        op: key,
        requestHash,
        state: 'reserved',
        createdAt: new Date().toISOString(),
      }),
      requestHash,
      state: 'completed',
      result,
    });
  }

  private failAppReservation(key: string, requestHash: string, error: unknown): void {
    this.putAppReservation(key, {
      ...(this.reservation(key) ?? {
        op: key,
        requestHash,
        state: 'reserved',
        createdAt: new Date().toISOString(),
      }),
      requestHash,
      state: 'failed',
      error: BureauError.from(error).toBody(),
    });
  }

  register(handle: ProjectHandle): ProjectContext {
    const existing = this.contexts.get(handle.project.id);
    if (existing) {
      if (existing.root !== handle.root) {
        handle.close();
        throw new BureauError(
          ErrorCodes.REVISION_CONFLICT,
          'Another folder with this project identity is already open',
        );
      }
      if (handle !== existing.handle) handle.close();
      return existing;
    }
    const ctx = new ProjectContext(handle, this.host);
    ctx.tools = { ...this.engineTools };
    ctx.durabilityHooks = this.durabilityHooks;
    if (!handle.readOnly) recoverResultJournals(handle.root, handle.repo);
    if (!handle.readOnly) pruneHistoricalSessionData(ctx);
    if (!handle.readOnly)
      ctx.repo.tx(() =>
        propagateFrom(
          ctx,
          ctx.repo.listArtifacts().map((a) => a.id),
          ctx.repo.latestEventSeq(),
        ),
      );
    const watcher = new ProjectWatcher(ctx);
    ctx.onMaterialized = (relPath, sha) => watcher.noteMaterialized(relPath, sha);
    if (!handle.readOnly) watcher.start();
    this.contexts.set(handle.project.id, ctx);
    this.watchers.set(handle.project.id, watcher);
    this.rememberProject(handle.root);
    return ctx;
  }

  closeProject(projectId: string): void {
    this.watchers.get(projectId)?.stop();
    this.watchers.delete(projectId);
    const ctx = this.contexts.get(projectId);
    if (ctx && !ctx.readOnly && ctx.handle.pdb.db.open)
      for (const j of ctx.repo.listJobs(10000)) ctx.cancelJob(j.id);
    if (ctx) ctx.closed = true;
    const handle = ctx?.handle;
    if (handle && handle.pdb.db.open) handle.close();
    this.contexts.delete(projectId);
  }

  /** Close every open project — used on app quit and in tests. */
  closeAll(): void {
    for (const id of [...this.contexts.keys()]) this.closeProject(id);
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.contexts.values()].map((ctx) => this.terminalHost?.stop(ctx)),
    );
    this.closeAll();
  }

  /** App-level + project-level op entry. projectId omitted for app ops. */
  async dispatch(
    op: string,
    payload: unknown,
    origin: Origin,
    projectId?: string,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const definition = OPS_BY_NAME.get(op);
    if (!definition) throw new BureauError(ErrorCodes.VALIDATION, `Unknown operation: ${op}`);
    if (origin.kind === 'agent' && definition.capability === 'user') {
      throw new BureauError(
        op === 'artifact.apply_edit' ? ErrorCodes.APPROVAL_REQUIRED : ErrorCodes.CAPABILITY_DENIED,
        `Agents cannot call ${op}`,
      );
    }
    assertServedByLegacyCore(op);
    const parsed = definition.input.safeParse(payload ?? {});
    if (!parsed.success)
      throw new BureauError(
        ErrorCodes.VALIDATION,
        `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    payload = parsed.data;
    if (definition.mutating && projectId) this.contextFor(projectId).assertWritable();
    switch (op) {
      case 'project.create': {
        const p = payload as { name: string; path: string; intent: string };
        const key = this.appKey(op, origin, idempotencyKey);
        const hash = hashRequest(op, payload);
        if (key) {
          const replay = replayAppReservation(this.reservation(key), hash);
          if (replay) return replay;
          this.putAppReservation(key, {
            op,
            requestHash: hash,
            state: 'reserved',
            projectPath: canonicalize(p.path),
            createdAt: this.reservation(key)?.createdAt ?? new Date().toISOString(),
          });
          this.crash('app.reservation.stored', { op, path: p.path });
        }
        if (key) {
          const recovered = this.openExistingProject(p.path);
          if (recovered) {
            const result = { project: recovered.handle.project, projectId: recovered.projectId };
            this.completeAppReservation(key, hash, result);
            return { ...result, recovered: true };
          }
        }
        let handle: ProjectHandle | undefined;
        try {
          handle = createProject(p.path, p.name, p.intent);
          this.crash('project.create.after-domain', { path: p.path });
          const ctx = this.register(handle);
          handle = undefined;
          this.crash('project.create.after-register', { projectId: ctx.projectId });
          const result = { project: ctx.handle.project, projectId: ctx.projectId };
          if (key) this.completeAppReservation(key, hash, result);
          this.crash('app.reservation.completed', { op });
          return result;
        } catch (error) {
          if (handle && !this.contexts.has(handle.project.id)) {
            try {
              handle.close();
            } catch {
              /* closed or never fully opened */
            }
          }
          if (key && !fs.existsSync(path.join(canonicalize(p.path), PROJECT_FILE)))
            this.failAppReservation(key, hash, error);
          throw error;
        }
      }
      case 'project.open': {
        const p = payload as { path: string };
        const live = this.liveContextAt(p.path);
        if (live)
          return {
            project: live.handle.project,
            projectId: live.projectId,
            readOnly: live.readOnly,
          };
        const root = canonicalize(p.path);
        const marker = JSON.parse(fs.readFileSync(path.join(root, 'bureau.project.json'), 'utf8'));
        if (this.contexts.has(marker.id))
          throw new BureauError(
            ErrorCodes.REVISION_CONFLICT,
            'Another folder with this project identity is already open; import a copy with a new identity',
          );
        const handle = openProject(root);
        const ctx = this.register(handle);
        return { project: handle.project, projectId: ctx.projectId, readOnly: handle.readOnly };
      }
      case 'project.rename': {
        const ctx = this.contextFor(projectId!);
        const p = payload as { name: string };
        const key = this.appKey(op, origin, idempotencyKey);
        const hash = hashRequest(op, payload);
        if (key) {
          const replay = replayAppReservation(this.reservation(key), hash);
          if (replay) return replay;
          this.putAppReservation(key, {
            op,
            requestHash: hash,
            state: 'reserved',
            projectPath: ctx.root,
            createdAt: this.reservation(key)?.createdAt ?? new Date().toISOString(),
          });
          this.crash('app.reservation.stored', { op });
        }
        writeRenameJournal(ctx.root, p.name);
        this.crash('project.rename.journal-written', { name: p.name });
        if (ctx.repo.getProject()?.name !== p.name) {
          ctx.repo.tx(() => {
            ctx.repo.updateProject({ name: p.name });
            ctx.emit('project.renamed', origin.kind, { name: p.name });
          });
        }
        this.crash('project.rename.after-db', { name: p.name });
        updateProjectFile(ctx.root, { name: p.name });
        this.crash('project.rename.after-marker', { name: p.name });
        clearRenameJournal(ctx.root);
        const result = { project: ctx.repo.getProject() };
        if (key) this.completeAppReservation(key, hash, result);
        this.crash('app.reservation.completed', { op });
        return result;
      }
      case 'project.update_intent': {
        const ctx = this.contextFor(projectId!);
        ctx.repo.tx(() => {
          ctx.repo.updateProject({ intent: (payload as { intent: string }).intent });
          ctx.emit('project.intent_changed', origin.kind, payload);
        });
        return { project: ctx.repo.getProject() };
      }
      case 'project.list_open': {
        return {
          projects: [...this.contexts.values()].map((c) => ({
            id: c.projectId,
            name: c.handle.project.name,
            root: c.handle.root,
          })),
        };
      }
      case 'project.close': {
        const ctx = this.contextFor(projectId!);
        try {
          await this.terminalHost?.stop(ctx);
        } catch {
          /* best-effort: closing must not fail on a wedged session */
        }
        this.closeProject(projectId!);
        return { ok: true };
      }
      case 'project.import_archive': {
        const p = payload as { archivePath: string; destDir: string; newIdentity: boolean };
        const key = this.appKey(op, origin, idempotencyKey);
        const hash = hashRequest(op, payload);
        if (key) {
          const replay = replayAppReservation(this.reservation(key), hash);
          if (replay) return replay;
          this.putAppReservation(key, {
            op,
            requestHash: hash,
            state: 'reserved',
            projectPath: canonicalize(p.destDir),
            createdAt: this.reservation(key)?.createdAt ?? new Date().toISOString(),
          });
          this.crash('app.reservation.stored', { op, path: p.destDir });
        }
        if (key) {
          const recoveredImport = this.openExistingProject(p.destDir);
          if (recoveredImport) {
            const result = {
              project: recoveredImport.handle.project,
              projectId: recoveredImport.projectId,
              readOnly: recoveredImport.readOnly,
            };
            this.completeAppReservation(key, hash, result);
            return { ...result, recovered: true };
          }
        }
        const { manifest } = verifyArchive(p.archivePath);
        if (this.contexts.has(manifest.projectId) && !p.newIdentity) {
          throw new BureauError(ErrorCodes.VALIDATION, 'Project already open', {
            repair: 'Close it first, or import with newIdentity to make a copy.',
          });
        }
        try {
          expandArchive(p.archivePath, p.destDir, (staging) => {
            if (!p.newIdentity) return;
            const stagingHandle = openProject(staging);
            try {
              if (stagingHandle.readOnly)
                throw new BureauError(
                  ErrorCodes.READ_ONLY,
                  'Cannot re-identify a newer project format',
                );
              const pfPath = path.join(staging, 'bureau.project.json');
              const pf = JSON.parse(fs.readFileSync(pfPath, 'utf8'));
              pf.id = newId();
              pf.name = `${pf.name} (copy)`;
              stagingHandle.repo.db.prepare('UPDATE project SET id=?, name=?').run(pf.id, pf.name);
              fs.writeFileSync(pfPath, JSON.stringify(pf, null, 2));
            } finally {
              stagingHandle.close();
            }
          });
          this.crash('project.import.after-domain', { path: p.destDir });
          const handle = openProject(p.destDir);
          if (!handle.readOnly)
            handle.repo.appendEvent('project.imported', 'user', {
              from: manifest.projectId,
              copy: p.newIdentity,
            });
          const ctx = this.register(handle);
          const result = {
            project: handle.project,
            projectId: ctx.projectId,
            readOnly: handle.readOnly,
          };
          if (key) this.completeAppReservation(key, hash, result);
          this.crash('app.reservation.completed', { op });
          return result;
        } catch (error) {
          if (key && !fs.existsSync(path.join(canonicalize(p.destDir), PROJECT_FILE)))
            this.failAppReservation(key, hash, error);
          throw error;
        }
      }
      case 'app.recent_projects': {
        const projects = this.settings.recentProjects.filter((p) => fs.existsSync(p));
        const projectNames: Record<string, string> = {};
        for (const root of projects) {
          try {
            // Read the marker only: listing recents must not open, migrate or
            // acquire a write handle on any project database.
            const marker = readProjectFile(root);
            if (typeof marker.name === 'string' && marker.name.trim())
              projectNames[root] = marker.name;
          } catch {
            /* A moved/damaged project stays visible with its folder name. */
          }
        }
        return { projects, projectNames };
      }
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
        if (
          !a ||
          !b ||
          ['__proto__', 'constructor', 'prototype'].includes(a) ||
          ['__proto__', 'constructor', 'prototype'].includes(b)
        )
          throw new BureauError(ErrorCodes.VALIDATION, `Bad settings key: ${key}`);
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
      case 'terminal.state': {
        const ctx = this.contextFor(projectId!);
        const session = this.terminalHost?.state(ctx);
        const snapshot =
          this.terminalHost && 'getScrollbackSnapshot' in this.terminalHost
            ? this.terminalHost.getScrollbackSnapshot?.(ctx)
            : { text: this.terminalHost?.getScrollback?.(ctx) ?? '', cursor: 0 };
        return {
          session: session
            ? {
                ...session,
                scrollback: snapshot?.text ?? this.terminalHost?.getScrollback?.(ctx) ?? '',
                scrollbackCursor: snapshot?.cursor ?? 0,
              }
            : null,
        };
      }
      case 'connection.list':
        return { adapters: (await this.connectionHost?.list()) ?? [] };
      case 'connection.test': {
        const p = payload as { adapterId: string };
        if (!this.connectionHost)
          throw new BureauError(ErrorCodes.TOOL_MISSING, 'No connection host');
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
          throw new BureauError(ErrorCodes.TOOL_MISSING, 'No connection host');
        return this.connectionHost.configure(p.adapterId, p);
      }
      default: {
        const ctx = this.contextFor(projectId!);
        return dispatch(ctx, { op, payload, origin, idempotencyKey });
      }
    }
  }
}
