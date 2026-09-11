import fs from 'node:fs';
import path from 'node:path';
import type { ProjectContext } from './context.js';
import { commitRevision } from './artifacts.js';
import { sha256Hex, toProjectRelative } from '@stark/storage';

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
          setTimeout(() => this.onWrite(rel), 300),
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
    const abs = path.join(this.ctx.root, relPath);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return;
    const sha = sha256Hex(fs.readFileSync(abs));
    if (this.knownHashes.get(relPath) === sha) return; // our own write
    this.knownHashes.set(relPath, sha);

    // Find the artifact whose current revision references this path.
    for (const a of this.ctx.repo.listArtifacts()) {
      const rev = a.selectedRevisionId ? this.ctx.repo.getRevision(a.selectedRevisionId) : null;
      const drafts = this.ctx.repo.listDrafts(a.id);
      const candidates = [rev, ...drafts].filter((r): r is NonNullable<typeof r> => !!r);
      const owner = candidates.find((r) => r.files.some((f) => f.path === relPath));
      if (!owner) continue;
      const existing = owner.files.find((f) => f.path === relPath);
      if (existing?.sha256 === sha) continue;
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
