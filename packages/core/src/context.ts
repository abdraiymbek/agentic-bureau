import fs from 'node:fs';
import path from 'node:path';
import {
  Artifact,
  ArtifactView,
  Freshness,
  Job,
  JobStatus,
  MAX_JOB_LOG_CHARS,
  Origin,
  ProjectEvent,
  Revision,
  OmenflowError,
  ErrorCodes,
  newId,
} from '@omenflow/contracts';
import {
  ObjectStore,
  ProjectHandle,
  Repo,
  resolveProjectPath,
  sha256Hex,
  toProjectRelative,
} from '@omenflow/storage';

/** Services the host process (Electron main, or a test stub) provides to core. */
export interface HostServices {
  /** Open/read the isolated research browser surface. */
  researchOpen(url: string): Promise<{ ok: boolean; error?: string }>;
  researchReadPage(): Promise<{
    url: string;
    title: string;
    text: string;
    links: { text: string; url: string }[];
  }>;
  researchFollowLink(sel: {
    selector?: string;
    url?: string;
  }): Promise<{ ok: boolean; error?: string }>;
  researchScreenshot(): Promise<{ pngBase64: string }>;
  /** OS integration. */
  revealPath(absPath: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  notify(title: string, body: string): void;
}

export const nullHost: HostServices = {
  async researchOpen() {
    return { ok: false, error: 'Research browser unavailable in this host' };
  },
  async researchReadPage() {
    return { url: '', title: '', text: '', links: [] };
  },
  async researchFollowLink() {
    return { ok: false, error: 'Research browser unavailable in this host' };
  },
  async researchScreenshot() {
    throw new OmenflowError(ErrorCodes.VALIDATION, 'Research browser unavailable');
  },
  async revealPath() {},
  async openExternal() {},
  notify() {},
};

export type { EngineTools } from './tools.js';
import type { EngineTools } from './tools.js';

export type EventListener = (e: ProjectEvent) => void;

/**
 * Live project context — the unit every command handler operates on.
 * Owns: repo, objects, event emission, file materialization, watcher hooks.
 */
export class ProjectContext {
  readonly listeners = new Set<EventListener>();
  readonly jobCancels = new Map<string, () => void>();
  readonly proposalWaiters = new Set<(p: string) => void>();
  tools: EngineTools = {};

  constructor(
    public readonly handle: ProjectHandle,
    public readonly host: HostServices,
  ) {}

  get repo(): Repo {
    return this.handle.repo;
  }
  get objects(): ObjectStore {
    return this.handle.objects;
  }
  get root(): string {
    return this.handle.root;
  }
  get readOnly(): boolean {
    return this.handle.readOnly;
  }
  get projectId(): string {
    return this.handle.project.id;
  }

  emit(type: string, origin: Origin['kind'], data: unknown): number {
    const seq = this.repo.appendEvent(type, origin, data);
    const ev = this.repo.eventsSince(seq - 1).find((e) => e.seq === seq);
    if (ev) for (const l of this.listeners) l(ev);
    for (const w of this.proposalWaiters) w(type);
    return seq;
  }

  assertWritable(): void {
    if (this.readOnly) {
      throw new OmenflowError(
        ErrorCodes.READ_ONLY,
        'Project opened read-only (newer schema version)',
        {
          repair: 'Export the project and update Omen Flow to edit it.',
        },
      );
    }
  }

  requireArtifact(id: string): Artifact {
    const a = this.repo.getArtifact(id);
    if (!a) throw new OmenflowError(ErrorCodes.NOT_FOUND, `Artifact not found: ${id}`);
    return a;
  }
  requireRevision(id: string): Revision {
    const r = this.repo.getRevision(id);
    if (!r) throw new OmenflowError(ErrorCodes.NOT_FOUND, `Revision not found: ${id}`);
    return r;
  }

  /** Freshness for one artifact: current / stale / missing_input. */
  freshnessOf(artifactId: string): {
    freshness: Freshness;
    reasons: import('@omenflow/contracts').StaleRecord[];
  } {
    const reasons = this.repo.staleFor(artifactId);
    if (reasons.length === 0) return { freshness: 'current', reasons };
    if (reasons.some((r) => r.reason === 'missing_input'))
      return { freshness: 'missing_input', reasons };
    return { freshness: 'stale', reasons };
  }

  artifactView(a: Artifact): ArtifactView {
    const revision = a.selectedRevisionId ? this.repo.getRevision(a.selectedRevisionId) : null;
    const { freshness, reasons } = this.freshnessOf(a.id);
    return {
      artifact: a,
      revision,
      freshness,
      staleReasons: reasons,
      draftCount: this.repo.listDrafts(a.id).length,
      pendingProposal: !!this.repo.pendingProposalForArtifact(a.id),
    };
  }

  /* ------------------------- file + object handling -------------------- */

  resolvePath(rel: string): string {
    return resolveProjectPath(this.root, rel);
  }

  /** Store file content in the object store; returns sha256. */
  storeContent(content: Buffer | string): string {
    return this.objects.put(typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
  }

  /** Store a file already on disk (must be inside the project). */
  storeProjectFile(absPath: string): { sha256: string; relPath: string } {
    if (!absPath.startsWith(this.root)) {
      const rel = toProjectRelative(this.root, absPath);
      if (rel.startsWith('..')) {
        throw new OmenflowError(
          ErrorCodes.PATH_OUTSIDE_PROJECT,
          `File outside project: ${absPath}`,
        );
      }
    }
    const sha = sha256Hex(fs.readFileSync(absPath));
    this.objects.putFile(absPath);
    return { sha256: sha, relPath: toProjectRelative(this.root, absPath) };
  }

  /**
   * Materialize an object into a project-relative working path. Recorded so a
   * crash between DB commit and file write is repaired on reopen.
   */
  /** Set by CoreApp: lets the project watcher ignore files we wrote ourselves. */
  onMaterialized: ((relPath: string, sha256: string) => void) | null = null;

  materialize(
    relPath: string,
    sha256: string,
    revisionId?: string,
    opts?: { overwrite?: boolean },
  ): void {
    const mid = this.repo.addMaterialization(relPath, sha256, revisionId ?? null);
    this.onMaterialized?.(relPath, sha256);
    try {
      const abs = this.resolvePath(relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      // Never clobber a divergent external edit: if a user-owned file exists
      // with different content, leave it and let the watcher import it as a
      // draft. Generated outputs (views, renders, tool-written sources) pass
      // `overwrite` — they are ours to replace.
      const buf = this.objects.read(sha256);
      if (fs.existsSync(abs)) {
        const cur = sha256Hex(fs.readFileSync(abs));
        if (cur === sha256) {
          this.repo.completeMaterialization(mid);
          return;
        }
        if (opts?.overwrite) {
          fs.writeFileSync(abs, buf);
        } else {
          const marker = `${abs}.omenflow-conflict-${Date.now()}`;
          fs.writeFileSync(marker, buf);
        }
      } else {
        fs.writeFileSync(abs, buf);
      }
      this.repo.completeMaterialization(mid);
    } catch (e) {
      throw e;
    }
  }

  /* ------------------------- jobs -------------------------------------- */

  createJob(fields: {
    kind: string;
    tool: string;
    toolVersion?: string | null;
    inputs?: unknown;
    inputHashes?: Record<string, string>;
    command?: string | null;
    sessionId?: string | null;
  }): Job {
    const job: Job = {
      id: newId(),
      kind: fields.kind,
      tool: fields.tool,
      toolVersion: fields.toolVersion ?? null,
      inputs: fields.inputs ?? null,
      inputHashes: fields.inputHashes ?? {},
      command: fields.command ?? null,
      status: 'queued',
      log: '',
      outputHashes: {},
      error: null,
      sessionId: fields.sessionId ?? null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    this.repo.insertJob(job);
    return job;
  }

  jobLog(jobId: string, chunk: string): void {
    this.repo.appendJobLog(jobId, chunk, MAX_JOB_LOG_CHARS);
  }

  jobStatus(
    jobId: string,
    status: JobStatus,
    extra?: { error?: unknown; outputHashes?: Record<string, string> },
  ): void {
    const now = new Date().toISOString();
    this.repo.updateJob(jobId, {
      status,
      error: extra?.error === undefined ? undefined : extra.error,
      outputHashes: extra?.outputHashes,
      startedAt: status === 'running' ? now : undefined,
      finishedAt: ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(status)
        ? now
        : undefined,
    });
    const job = this.repo.getJob(jobId);
    if (job) this.emit('job.updated', 'system', { jobId, status, kind: job.kind, tool: job.tool });
  }
}
