import fs from 'node:fs';
import path from 'node:path';
import type { ProjectContext } from './context.js';
import { commitRevision } from './artifacts.js';
import { sha256Hex, resolveProjectSourcePath } from '@bureau/storage';

/**
 * Watches the project's artifacts/ tree. Completed external writes on files
 * that belong to a revision are imported as draft revisions — the accepted
 * baseline is never overwritten by filesystem edits.
 */
export class ProjectWatcher {
  private watcher: fs.FSWatcher | null = null;
  private debounce = new Map<string, NodeJS.Timeout>();
  /** relPath → last materialized sha256 (our generated views + rev files). */
  private knownHashes = new Map<string, string>();

  constructor(private ctx: ProjectContext) {}

  start(): void {
    if (this.ctx.readOnly || this.ctx.closed) return;
    const dir = path.join(this.ctx.root, 'artifacts');
    if (!fs.existsSync(dir)) return;
    try {
      this.watcher = fs.watch(dir, { recursive: true }, (_ev, filename) => {
        if (!filename) return;
        const rel = `artifacts/${filename.split(path.sep).join('/')}`;
        const t = this.debounce.get(rel);
        if (t) clearTimeout(t);
        this.debounce.set(
          rel,
          setTimeout(() => {
            try {
              this.onWrite(rel);
            } catch (error) {
              if (!this.ctx.closed && !this.ctx.readOnly)
                this.ctx.emit('file.import_failed', 'system', { path: rel, error: String(error) });
            }
          }, 300),
        );
      });
    } catch {
      // fs.watch unsupported here — watcher is best-effort.
    }
  }

  /** Record the hash we wrote so the watcher ignores our own materializations. */
  noteMaterialized(relPath: string, sha256: string): void {
    this.knownHashes.set(relPath, sha256);
  }

  private onWrite(relPath: string): void {
    this.debounce.delete(relPath);
    if (this.ctx.readOnly || this.ctx.closed) return;
    const abs = resolveProjectSourcePath(this.ctx.root, relPath);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return;
    const sha = sha256Hex(fs.readFileSync(abs));
    if (this.knownHashes.get(relPath) === sha) return; // our own write
    this.knownHashes.set(relPath, sha);

    // Find the artifact whose revisions reference this path. The owner is the
    // newest such revision (the agent's latest draft), so the imported edit
    // builds on current content rather than forking an older revision.
    for (const a of this.ctx.repo.listArtifacts()) {
      const referencing = this.ctx.repo
        .listRevisions(a.id)
        .filter(
          (r) =>
            !['rejected', 'superseded'].includes(r.reviewState) &&
            r.files.some((f) => f.path === relPath),
        );
      if (referencing.length === 0) continue;
      // Content that any revision already carries is ours (a materialization), not an edit.
      if (referencing.some((r) => r.files.some((f) => f.path === relPath && f.sha256 === sha)))
        return;
      const owner = referencing[referencing.length - 1]!;
      // External edit → draft revision with updated file.
      const newSha = this.ctx.objects.putFile(abs);
      const files = owner.files.map((f) => (f.path === relPath ? { ...f, sha256: newSha } : f));
      commitRevision(this.ctx, {
        artifactId: a.id,
        parentId: owner.id,
        origin: { kind: 'user' },
        payload: owner.payload,
        files,
        inputs: owner.inputs,
        rationale: `External edit imported: ${relPath}`,
        reviewState: 'draft',
      });
      this.ctx.emit('file.external_edit', 'user', { artifactId: a.id, path: relPath });
      return;
    }
  }

  stop(): void {
    this.watcher?.close();
    for (const t of this.debounce.values()) clearTimeout(t);
  }
}
