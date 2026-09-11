import fs from 'node:fs';
import path from 'node:path';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import {
  Artifact,
  ErrorCodes,
  Origin,
  Revision,
  StarkError,
  formatQty,
  isUnknown,
  type ComponentPayload,
  type MaybeQuantity,
} from '@stark/contracts';
import type { ProjectContext } from './context.js';
import { bomCsv, bomMarkdown } from './components.js';
import { materializeReadableView } from './artifacts.js';
import { resolveProjectPath } from '@stark/storage';

/**
 * Build preview: enumerate the selected baseline (or labeled drafts) and every
 * unresolved issue — missing files, stale outputs, open validation gaps.
 */
export function buildPreview(ctx: ProjectContext) {
  const artifacts = ctx.repo.listArtifacts();
  const items: {
    artifactId: string;
    title: string;
    type: string;
    revisionId: string | null;
    state: string;
    issues: string[];
  }[] = [];
  for (const a of artifacts) {
    const rev = a.selectedRevisionId ? ctx.repo.getRevision(a.selectedRevisionId) : null;
    const issues: string[] = [];
    if (!rev) issues.push('no baseline revision');
    const { freshness, reasons } = ctx.freshnessOf(a.id);
    if (freshness !== 'current') issues.push(`${freshness}: ${reasons.map((r) => r.reason).join(', ')}`);
    if (rev) {
      for (const f of rev.files) {
        const abs = ctx.resolvePath(f.path);
        const present = fs.existsSync(abs) || (f.sha256 ? ctx.objects.has(f.sha256) : false);
        if (!present) issues.push(`missing file ${f.path}`);
      }
      if (a.type === 'assumption') {
        const p = rev.payload as { needsValidation?: boolean };
        if (p.needsValidation) issues.push('unresolved assumption');
      }
    }
    if (ctx.repo.pendingProposalForArtifact(a.id)) issues.push('pending proposal');
    items.push({
      artifactId: a.id,
      title: a.title,
      type: a.type,
      revisionId: rev?.id ?? null,
      state: rev?.reviewState ?? 'none',
      issues,
    });
  }
  const drafts = artifacts.filter((a) => !a.selectedRevisionId).length;
  return {
    items,
    counts: {
      artifacts: items.length,
      ready: items.filter((i) => i.issues.length === 0).length,
      withIssues: items.filter((i) => i.issues.length > 0).length,
      noBaseline: drafts,
    },
  };
}

/**
 * Build package: ZIP of readable docs + source/manufacturing files + wiring +
 * software + manifest.json. Explicit `Draft` label when unresolved issues
 * exist and the user opts in.
 */
export async function exportBuildPackage(ctx: ProjectContext, input: {
  destPath: string;
  includeDrafts: boolean;
  label?: string;
}, origin: Origin): Promise<{ path: string; files: number; status: string; issues: number }> {
  const preview = buildPreview(ctx);
  const issueCount = preview.items.reduce((n, i) => n + i.issues.length, 0);
  const status = issueCount === 0 ? 'baseline' : 'draft';
  if (status === 'draft' && !input.includeDrafts) {
    throw new StarkError(ErrorCodes.VALIDATION, `Build has ${issueCount} unresolved issue(s)`, {
      repair: 'Resolve issues, or export with includeDrafts for a labeled Draft package.',
      details: preview.items.filter((i) => i.issues.length > 0),
    });
  }

  const files = new Map<string, Uint8Array>();
  const project = ctx.handle.project;
  const manifest: Record<string, unknown> = {
    format: 'stark-build-package',
    schemaVersion: 1,
    project: { id: project.id, name: project.name, intent: project.intent },
    status,
    label: input.label ?? status.toUpperCase(),
    exportedAt: new Date().toISOString(),
    exportedBy: origin.kind,
    artifacts: [] as unknown[],
    sources: [] as unknown[],
    toolVersions: ctx.repo.listJobs(200).filter((j) => j.toolVersion).map((j) => ({ tool: j.tool, version: j.toolVersion })),
    issues: preview.items.filter((i) => i.issues.length > 0),
  };

  for (const item of preview.items) {
    if (!item.revisionId) continue;
    const a = ctx.repo.getArtifact(item.artifactId)!;
    const rev = ctx.repo.getRevision(item.revisionId)!;
    (manifest.artifacts as unknown[]).push({
      artifactId: a.id,
      revisionId: rev.id,
      type: a.type,
      title: a.title,
      contentHash: rev.contentHash,
      state: rev.reviewState,
    });
    for (const f of rev.files) {
      if (!f.sha256 || !ctx.objects.has(f.sha256)) continue;
      files.set(`files/${f.path}`, ctx.objects.read(f.sha256));
      // Record source provenance entries.
      if (a.type === 'source') {
        const sp = rev.payload as { url?: string; retrievedAt?: string; title?: string };
        (manifest.sources as unknown[]).push({ url: sp.url, retrievedAt: sp.retrievedAt, title: sp.title });
      }
    }
    if (a.type === 'source') {
      const sp = rev.payload as { url?: string; retrievedAt?: string; title?: string };
      (manifest.sources as unknown[]).push({ url: sp.url, retrievedAt: sp.retrievedAt, title: sp.title });
    }
  }

  files.set('docs/BOM.md', strToU8(bomMarkdown(ctx)));
  files.set('docs/BOM.csv', strToU8(bomCsv(ctx)));
  const assembly = ctx.repo.listArtifacts({ type: 'assembly' })[0];
  if (assembly?.selectedRevisionId) {
    const rev = ctx.repo.getRevision(assembly.selectedRevisionId)!;
    const steps = ((rev.payload as { steps?: { order: number; instruction: string }[] }).steps ?? [])
      .map((s) => `${s.order}. ${s.instruction}`)
      .join('\n');
    files.set('docs/ASSEMBLY.md', strToU8(`# Assembly\n\n${steps}\n`));
  }
  const wiring = ctx.repo.listArtifacts({ type: 'wiring' })[0];
  if (wiring?.selectedRevisionId) {
    const rev = ctx.repo.getRevision(wiring.selectedRevisionId)!;
    files.set('docs/wiring.json', strToU8(JSON.stringify(rev.payload, null, 2)));
  }
  const assumptions = ctx.repo
    .listArtifacts({ type: 'assumption' })
    .map((a) => {
      const r = a.selectedRevisionId ? ctx.repo.getRevision(a.selectedRevisionId) : null;
      const p = r?.payload as { statement?: string; reason?: string } | undefined;
      return `- ${a.title}: ${p?.statement ?? ''} (${p?.reason ?? ''})`;
    })
    .join('\n');
  files.set('docs/ASSUMPTIONS.md', strToU8(`# Assumptions\n\n${assumptions}\n`));
  files.set('manifest.json', strToU8(JSON.stringify(manifest, null, 2)));

  const zipped = zipSync(Object.fromEntries(files), { level: 6 });
  const dest = path.isAbsolute(input.destPath) ? input.destPath : ctx.resolvePath(input.destPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, zipped);
  ctx.emit('build.exported', origin.kind, { destPath: dest, status, files: files.size });
  return { path: dest, files: files.size, status, issues: issueCount };
}

/* ------------------------------------------------------------------ */
/* Project archive export/import                                        */
/* ------------------------------------------------------------------ */

export function exportArchive(ctx: ProjectContext, destPath: string) {
  const project = ctx.handle.project;
  const files = new Map<string, Uint8Array>();

  // Consistent DB snapshot via backup API into a temp file.
  const tmpDb = path.join(ctx.root, '.stark', 'cache', `export-${Date.now()}.sqlite`);
  ctx.handle.pdb.backupTo(tmpDb);
  files.set('.stark/state.sqlite', fs.readFileSync(tmpDb));
  fs.unlinkSync(tmpDb);

  files.set('stark.project.json', strToU8(fs.readFileSync(path.join(ctx.root, 'stark.project.json'), 'utf8')));
  const readme = path.join(ctx.root, 'README.md');
  if (fs.existsSync(readme)) files.set('README.md', fs.readFileSync(readme));

  // All readable files.
  const walk = (rel: string) => {
    const abs = path.join(ctx.root, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(rel, e.name);
      if (e.isDirectory()) walk(p);
      else files.set(p.split(path.sep).join('/'), fs.readFileSync(path.join(ctx.root, p)));
    }
  };
  walk('artifacts');

  // Every object (archive must be self-contained history).
  const objRoot = path.join(ctx.root, '.stark', 'objects');
  const walkObj = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walkObj(p);
      else files.set(`.stark/objects/${path.relative(objRoot, p).split(path.sep).join('/')}`, fs.readFileSync(p));
    }
  };
  if (fs.existsSync(objRoot)) walkObj(objRoot);

  // Portable JSON snapshot of structured records.
  const snapshot = {
    format: 'stark-project-snapshot',
    version: 1,
    project,
    artifacts: ctx.repo.listArtifacts({ includeArchived: true }),
    revisions: ctx.repo.listArtifacts({ includeArchived: true }).flatMap((a) => ctx.repo.listRevisions(a.id)),
    edges: ctx.repo.allEdges(),
    proposals: ctx.repo.listProposals(),
    decisions: ctx.repo.listDecisions(10000),
    bomLines: ctx.repo.listBomLines(),
    events: ctx.repo.listEvents(10000),
  };
  files.set('snapshot.json', strToU8(JSON.stringify(snapshot, null, 2)));

  const manifest = {
    format: 'stark-project-archive',
    version: 1,
    projectId: project.id,
    name: project.name,
    exportedAt: new Date().toISOString(),
    excludes: ['credentials', 'machine settings', 'cache', 'work', 'terminal logs'],
  };
  files.set('archive-manifest.json', strToU8(JSON.stringify(manifest, null, 2)));

  const zipped = zipSync(Object.fromEntries(files));
  const dest = path.isAbsolute(destPath) ? destPath : ctx.resolvePath(destPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, zipped);
  return { path: dest, files: files.size };
}

/** Verify + expand a project archive into destDir. Runs outside ProjectContext. */
export function verifyArchive(archivePath: string): {
  manifest: { format: string; version: number; projectId: string; name: string };
  fileCount: number;
} {
  const buf = fs.readFileSync(archivePath);
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(buf);
  } catch (e) {
    throw new StarkError(ErrorCodes.ARCHIVE_INVALID, `Not a ZIP archive: ${(e as Error).message}`);
  }
  const manifestRaw = entries['archive-manifest.json'];
  if (!manifestRaw) {
    throw new StarkError(ErrorCodes.ARCHIVE_INVALID, 'Missing archive-manifest.json');
  }
  const manifest = JSON.parse(strFromU8(manifestRaw));
  if (manifest.format !== 'stark-project-archive') {
    throw new StarkError(ErrorCodes.ARCHIVE_INVALID, `Bad format: ${manifest.format}`);
  }
  if (manifest.version > 1) {
    throw new StarkError(ErrorCodes.UNSUPPORTED_SCHEMA, `Archive version ${manifest.version} unsupported`);
  }
  return { manifest, fileCount: Object.keys(entries).length };
}

export function expandArchive(archivePath: string, destDir: string): void {
  const buf = fs.readFileSync(archivePath);
  const entries = unzipSync(buf);
  let total = 0;
  for (const v of Object.values(entries)) total += v.byteLength;
  if (total > 4 * 1024 * 1024 * 1024) {
    throw new StarkError(ErrorCodes.ARCHIVE_INVALID, 'Archive too large');
  }
  for (const [name, data] of Object.entries(entries)) {
    // ZIP traversal guard: every entry resolves inside destDir.
    const dest = resolveProjectPath(destDir, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
}
