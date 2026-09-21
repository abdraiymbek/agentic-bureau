import fs from 'node:fs';
import path from 'node:path';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import {
  ErrorCodes,
  Origin,
  OmenflowError,
  PROJECT_FILE,
  SCHEMA_VERSION,
  type MechanicalPayload,
} from '@omenflow/contracts';
import type { ProjectContext } from './context.js';
import { bomCsv, bomMarkdown } from './components.js';
import { renderMatchesInput } from './cad-input.js';
import { latestCadVerification } from './cad-verification.js';
import { assertTerminalExportAllowed } from './session-retention.js';
import {
  resolveProjectPath,
  resolveMaterializationPath,
  ProjectDb,
  Repo,
  ObjectStore,
  validateObjectHash,
  LATEST_SCHEMA_VERSION,
  sha256Hex,
} from '@omenflow/storage';

/**
 * Build preview: enumerate the selected baseline (or labeled drafts) and every
 * unresolved issue — missing files, stale outputs, open validation gaps.
 */
export function buildPreview(ctx: ProjectContext, opts?: { includeDrafts?: boolean }) {
  const artifacts = ctx.repo.listArtifacts();
  const items: {
    artifactId: string;
    title: string;
    type: string;
    revisionId: string | null;
    state: string;
    verification: ReturnType<typeof latestCadVerification> | null;
    issues: string[];
  }[] = [];
  for (const a of artifacts) {
    const rev = a.selectedRevisionId
      ? ctx.repo.getRevision(a.selectedRevisionId)
      : opts?.includeDrafts
        ? (ctx.repo
            .listRevisions(a.id)
            .filter((r) => r.reviewState !== 'rejected' && r.reviewState !== 'superseded')
            .at(-1) ?? null)
        : null;
    const issues: string[] = [];
    let verification: ReturnType<typeof latestCadVerification> | null = null;
    if (!a.selectedRevisionId) issues.push('no baseline revision');
    const { freshness, reasons } = ctx.freshnessOf(a.id);
    if (freshness !== 'current')
      issues.push(`${freshness}: ${reasons.map((r) => r.reason).join(', ')}`);
    if (rev) {
      for (const f of rev.files) {
        try {
          resolveMaterializationPath(ctx.root, f.path);
          if (!f.sha256) issues.push(`missing immutable content identity: ${f.path}`);
          else ctx.objects.read(f.sha256);
        } catch {
          issues.push(`missing, corrupt or unsafe file ${f.path}`);
        }
      }
      if (a.type === 'mechanical') {
        try {
          if (!renderMatchesInput(rev.payload as MechanicalPayload, rev.files)) {
            issues.push('geometry does not match the current effective inputs; render required');
          }
          verification = latestCadVerification(ctx, rev);
          if (verification.status !== 'passed')
            issues.push(`CAD verification: ${verification.status}`);
        } catch {
          verification = { status: 'unverified' };
          issues.push('CAD render or verification evidence is invalid');
        }
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
      verification,
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
export async function exportBuildPackage(
  ctx: ProjectContext,
  input: {
    destPath: string;
    includeDrafts: boolean;
    label?: string;
  },
  origin: Origin,
): Promise<{ path: string; files: number; status: string; issues: number }> {
  const preview = buildPreview(ctx, { includeDrafts: input.includeDrafts });
  const issueCount = preview.items.reduce((n, i) => n + i.issues.length, 0);
  const status = issueCount === 0 ? 'baseline' : 'draft';
  if (status === 'draft' && !input.includeDrafts) {
    throw new OmenflowError(ErrorCodes.VALIDATION, `Build has ${issueCount} unresolved issue(s)`, {
      repair: 'Resolve issues, or export with includeDrafts for a labeled Draft package.',
      details: preview.items.filter((i) => i.issues.length > 0),
    });
  }

  const files = new Map<string, Uint8Array>();
  const project = ctx.handle.project;
  const manifest: Record<string, unknown> = {
    format: 'omenflow-build-package',
    schemaVersion: 1,
    project: { id: project.id, name: project.name, intent: project.intent },
    status,
    verificationScope:
      'Checks establish only their declared geometric assertions. Human approval and physical/manufacturing validity are separate.',
    label: input.label ?? status.toUpperCase(),
    exportedAt: new Date().toISOString(),
    exportedBy: origin.kind,
    artifacts: [] as unknown[],
    sources: [] as unknown[],
    toolVersions: ctx.repo
      .listJobs(200)
      .filter((j) => j.toolVersion)
      .map((j) => ({ tool: j.tool, version: j.toolVersion })),
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
      selected: a.selectedRevisionId === rev.id,
      payload: rev.payload,
      files: rev.files,
      inputs: rev.inputs,
      verification: item.verification,
      issues: item.issues,
    });
    for (const f of rev.files) {
      if (!f.sha256 || !ctx.objects.has(f.sha256)) continue;
      files.set(`files/${f.path}`, ctx.objects.read(f.sha256));
    }
    if (a.type === 'source') {
      const sp = rev.payload as {
        url?: string;
        retrievedAt?: string;
        title?: string;
        fileHash?: string;
      };
      if (sp.fileHash) files.set(`attachments/${sp.fileHash}`, ctx.objects.read(sp.fileHash));
      (manifest.sources as unknown[]).push({
        url: sp.url,
        retrievedAt: sp.retrievedAt,
        title: sp.title,
        fileHash: sp.fileHash,
      });
    }
  }

  files.set('docs/BOM.md', strToU8(bomMarkdown(ctx)));
  files.set('docs/BOM.csv', strToU8(bomCsv(ctx)));
  const assembly = ctx.repo.listArtifacts({ type: 'assembly' })[0];
  if (assembly?.selectedRevisionId) {
    const rev = ctx.repo.getRevision(assembly.selectedRevisionId)!;
    const steps = (
      (rev.payload as { steps?: { order: number; instruction: string }[] }).steps ?? []
    )
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

export function exportArchive(
  ctx: ProjectContext,
  destPath: string,
  opts?: { includeTerminalHistory?: boolean; grantTerminalExportConsent?: boolean },
) {
  const includeTerminal = assertTerminalExportAllowed(
    ctx,
    opts?.includeTerminalHistory === true,
    opts?.grantTerminalExportConsent === true,
  );
  const project = ctx.handle.project;
  const files = new Map<string, Uint8Array>();

  // Redact only a private snapshot. VACUUM removes deleted terminal bytes from
  // free pages as well; the user's live terminal history is preserved.
  files.set(
    '.omenflow/state.sqlite',
    ctx.handle.pdb.archiveSnapshot({ includeSessionData: includeTerminal }),
  );

  files.set(
    'omenflow.project.json',
    strToU8(fs.readFileSync(resolveProjectPath(ctx.root, 'omenflow.project.json'), 'utf8')),
  );
  const readme = resolveMaterializationPath(ctx.root, 'README.md');
  if (fs.existsSync(readme)) files.set('README.md', fs.readFileSync(readme));

  // All readable files.
  const walk = (rel: string) => {
    const abs = resolveMaterializationPath(ctx.root, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.isSymbolicLink())
        throw new OmenflowError(
          ErrorCodes.VALIDATION,
          `Cannot archive symbolic link: ${rel}/${e.name}`,
        );
      const p = path.join(rel, e.name);
      if (e.isDirectory()) walk(p);
      else files.set(p.split(path.sep).join('/'), fs.readFileSync(path.join(ctx.root, p)));
    }
  };
  walk('artifacts');

  // Every object (archive must be self-contained history).
  const objRoot = resolveProjectPath(ctx.root, '.omenflow/objects');
  const walkObj = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink())
        throw new OmenflowError(
          ErrorCodes.VALIDATION,
          'Cannot archive symbolic links in object store',
        );
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walkObj(p);
      else
        files.set(
          `.omenflow/objects/${path.relative(objRoot, p).split(path.sep).join('/')}`,
          fs.readFileSync(p),
        );
    }
  };
  if (fs.existsSync(objRoot)) walkObj(objRoot);

  // Portable JSON snapshot of structured records.
  const snapshot = {
    format: 'omenflow-project-snapshot',
    version: 1,
    project,
    artifacts: ctx.repo.listArtifacts({ includeArchived: true }),
    revisions: ctx.repo
      .listArtifacts({ includeArchived: true })
      .flatMap((a) => ctx.repo.listRevisions(a.id)),
    edges: ctx.repo.allEdges(),
    proposals: ctx.repo.listProposals(),
    decisions: ctx.repo.listDecisions(2147483647),
    bomLines: ctx.repo.listBomLines(),
    jobs: ctx.repo.listJobs(2147483647),
    events: ctx.repo
      .listEvents(2147483647)
      .filter((e) => includeTerminal || e.type !== 'session.data'),
  };
  files.set('snapshot.json', strToU8(JSON.stringify(snapshot, null, 2)));

  const manifest = {
    format: 'omenflow-project-archive',
    version: 1,
    projectId: project.id,
    name: project.name,
    exportedAt: new Date().toISOString(),
    excludes: [
      'credentials',
      'machine settings',
      'cache',
      'work',
      ...(includeTerminal ? [] : ['terminal logs']),
    ],
    terminalHistory: includeTerminal ? 'included-with-consent' : 'excluded',
  };
  files.set('archive-manifest.json', strToU8(JSON.stringify(manifest, null, 2)));

  const zipped = zipSync(Object.fromEntries(files));
  const dest = path.isAbsolute(destPath) ? destPath : ctx.resolvePath(destPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, zipped);
  return { path: dest, files: files.size };
}

/** Deliberately bounded portable format; ZIP64 and links are not supported. */
export const ARCHIVE_LIMITS = {
  compressedBytes: 128 * 1024 * 1024,
  uncompressedBytes: 512 * 1024 * 1024,
  entryBytes: 128 * 1024 * 1024,
  entries: 10000,
} as const;

type ArchiveManifest = { format: string; version: number; projectId: string; name: string };
type ArchiveMember = { name: string; size: number; crc: number; directory: boolean };

function invalidArchive(message: string): never {
  throw new OmenflowError(ErrorCodes.ARCHIVE_INVALID, message);
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Inspect the central directory before any decompression/allocation. */
function archiveMembers(buf: Buffer): ArchiveMember[] {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50 && i + 22 + buf.readUInt16LE(i + 20) === buf.length) {
      end = i;
      break;
    }
  }
  if (end < 0) invalidArchive('Missing ZIP directory');
  const count = buf.readUInt16LE(end + 10);
  const directorySize = buf.readUInt32LE(end + 12);
  let cursor = buf.readUInt32LE(end + 16);
  if (
    count > ARCHIVE_LIMITS.entries ||
    count === 65535 ||
    cursor === 0xffffffff ||
    buf.readUInt16LE(end + 4) !== 0 ||
    buf.readUInt16LE(end + 6) !== 0 ||
    buf.readUInt16LE(end + 8) !== count ||
    cursor + directorySize !== end
  ) {
    invalidArchive('Unsupported or oversized ZIP directory');
  }
  const members: ArchiveMember[] = [];
  const names = new Set<string>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || buf.readUInt32LE(cursor) !== 0x02014b50)
      invalidArchive('Invalid ZIP member');
    const flags = buf.readUInt16LE(cursor + 8);
    const compression = buf.readUInt16LE(cursor + 10);
    const crc = buf.readUInt32LE(cursor + 16);
    const compressed = buf.readUInt32LE(cursor + 20);
    const size = buf.readUInt32LE(cursor + 24);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const unixMode = (buf.readUInt32LE(cursor + 38) >>> 16) & 0xf000;
    const localOffset = buf.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || localOffset + 30 > cursor || buf.readUInt32LE(localOffset) !== 0x04034b50)
      invalidArchive('Invalid ZIP member offset');
    const name = new TextDecoder('utf-8', { fatal: true }).decode(
      buf.subarray(cursor + 46, cursor + 46 + nameLength),
    );
    if (
      !name ||
      name.includes('\\') ||
      name.includes('\0') ||
      name.startsWith('/') ||
      /^[a-zA-Z]:/.test(name) ||
      name.split('/').some((part) => part === '..' || part === '.') ||
      names.has(name.toLowerCase())
    ) {
      invalidArchive(`Unsafe or duplicate archive path: ${name}`);
    }
    names.add(name.toLowerCase());
    const directory = name.endsWith('/');
    if (
      (flags & 1) !== 0 ||
      ![0, 8].includes(compression) ||
      (unixMode !== 0 && unixMode !== 0x8000 && unixMode !== 0x4000) ||
      size > ARCHIVE_LIMITS.entryBytes ||
      compressed > ARCHIVE_LIMITS.compressedBytes ||
      (directory && size !== 0)
    ) {
      invalidArchive(`Unsupported or oversized ZIP member: ${name}`);
    }
    total += size;
    if (total > ARCHIVE_LIMITS.uncompressedBytes)
      invalidArchive('Archive expands beyond the size limit');
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const localName = buf.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    if (
      !localName.equals(buf.subarray(cursor + 46, cursor + 46 + nameLength)) ||
      localOffset + 30 + localNameLength + localExtraLength + compressed > cursor
    )
      invalidArchive('ZIP member metadata mismatch');
    members.push({ name, size, crc, directory });
    cursor = next;
  }
  if (cursor !== end) invalidArchive('ZIP directory size mismatch');
  return members;
}

function readArchive(archivePath: string): {
  manifest: ArchiveManifest;
  entries: Record<string, Uint8Array>;
} {
  if (fs.statSync(archivePath).size > ARCHIVE_LIMITS.compressedBytes)
    invalidArchive('Compressed archive exceeds the size limit');
  const buf = fs.readFileSync(archivePath);
  try {
    const members = archiveMembers(buf);
    const entries = unzipSync(buf);
    for (const member of members) {
      const data = entries[member.name];
      if (!data || data.byteLength !== member.size || crc32(data) !== member.crc)
        invalidArchive(`Corrupt archive member: ${member.name}`);
    }
    const manifestRaw = entries['archive-manifest.json'];
    if (!manifestRaw) invalidArchive('Missing archive-manifest.json');
    const manifest = JSON.parse(strFromU8(manifestRaw)) as ArchiveManifest;
    if (
      manifest.format !== 'omenflow-project-archive' ||
      manifest.version !== 1 ||
      typeof manifest.projectId !== 'string' ||
      typeof manifest.name !== 'string'
    )
      invalidArchive('Unsupported archive manifest');
    if (!entries[PROJECT_FILE] || !entries['.omenflow/state.sqlite'])
      invalidArchive('Missing project marker or database');
    for (const member of members) {
      if (
        member.name.startsWith('.omenflow/') &&
        !member.directory &&
        member.name !== '.omenflow/state.sqlite' &&
        !/^\.omenflow\/objects\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(member.name)
      ) {
        invalidArchive(`Reserved archive member: ${member.name}`);
      }
    }
    return { manifest, entries };
  } catch (error) {
    if (error instanceof OmenflowError) throw error;
    invalidArchive(`Invalid ZIP archive: ${(error as Error).message}`);
  }
}

/** Validate canonical records and referenced objects before publishing. */
function validateStagedProject(root: string, manifest: ArchiveManifest): void {
  const pf = JSON.parse(fs.readFileSync(path.join(root, PROJECT_FILE), 'utf8')) as {
    format: string;
    version: number;
    id: string;
  };
  if (
    pf.format !== 'omenflow-project' ||
    pf.version !== SCHEMA_VERSION ||
    pf.id !== manifest.projectId
  ) {
    invalidArchive('Unsupported or inconsistent project marker');
  }
  const pdb = new ProjectDb(path.join(root, '.omenflow/state.sqlite'), { readOnly: true });
  try {
    const version = pdb.db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as
      { value: string } | undefined;
    if (!version || Number(version.value) > LATEST_SCHEMA_VERSION || Number(version.value) < 1)
      invalidArchive('Unsupported database schema');
    const integrity = pdb.db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok' || (pdb.db.pragma('foreign_key_check') as unknown[]).length)
      invalidArchive('Invalid project database');
    const repo = new Repo(pdb.db);
    if (repo.getProject()?.id !== pf.id) invalidArchive('Project identity mismatch');
    const objects = new ObjectStore(path.join(root, '.omenflow/objects'), true);
    const verifyHashes = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const v of value) verifyHashes(v);
        return;
      }
      for (const [key, v] of Object.entries(value)) {
        if ((key === 'sha256' || key === 'fileHash') && v !== null && v !== undefined) {
          if (typeof v !== 'string') invalidArchive('Invalid object reference');
          validateObjectHash(v);
          objects.read(v);
        } else verifyHashes(v);
      }
    };
    for (const artifact of repo.listArtifacts({ includeArchived: true })) {
      if (
        artifact.selectedRevisionId &&
        repo.getRevision(artifact.selectedRevisionId)?.artifactId !== artifact.id
      )
        invalidArchive('Invalid selected revision');
      for (const revision of repo.listRevisions(artifact.id)) {
        if (revision.parentId && repo.getRevision(revision.parentId)?.artifactId !== artifact.id)
          invalidArchive('Invalid parent revision');
        for (const file of revision.files) resolveMaterializationPath(root, file.path);
        verifyHashes(revision.files);
        verifyHashes(revision.payload);
        for (const input of revision.inputs) {
          if (repo.getRevision(input.revisionId)?.artifactId !== input.artifactId)
            invalidArchive('Invalid revision input');
        }
      }
    }
    for (const edge of repo.allEdges()) {
      if (
        !repo.getArtifact(edge.upstreamArtifactId) ||
        !repo.getArtifact(edge.downstreamArtifactId) ||
        (edge.requiredUpstreamRevisionId &&
          repo.getRevision(edge.requiredUpstreamRevisionId)?.artifactId !== edge.upstreamArtifactId)
      )
        invalidArchive('Invalid dependency edge');
    }
    for (const proposal of repo.listProposals()) {
      for (const change of proposal.changes) {
        if (
          repo.getRevision(change.newRevisionId)?.artifactId !== change.artifactId ||
          (change.baseRevisionId &&
            repo.getRevision(change.baseRevisionId)?.artifactId !== change.artifactId)
        )
          invalidArchive('Invalid proposal revision');
      }
    }
    for (const line of repo.listBomLines()) {
      if (repo.getRevision(line.componentRevisionId)?.artifactId !== line.componentArtifactId)
        invalidArchive('Invalid BOM revision');
    }
    for (const job of repo.listJobs(2147483647)) {
      if (job.outputHashes.verification) objects.read(job.outputHashes.verification);
    }
    for (const m of repo.pendingMaterializations()) {
      resolveMaterializationPath(root, m.path);
      validateObjectHash(m.sha256 ?? '');
      objects.read(m.sha256!);
    }
  } finally {
    pdb.close();
  }
}

/** Preflight is bounded and never writes to the destination. */
export function verifyArchive(archivePath: string): {
  manifest: ArchiveManifest;
  fileCount: number;
} {
  const { manifest, entries } = readArchive(archivePath);
  return { manifest, fileCount: Object.keys(entries).length };
}

/** Stage, verify, optionally prepare identity, then atomically publish. */
export function expandArchive(
  archivePath: string,
  destDir: string,
  prepare?: (stagingDir: string) => void,
): void {
  const absolute = path.resolve(destDir);
  const occupied = () =>
    fs.existsSync(absolute) &&
    (!fs.lstatSync(absolute).isDirectory() ||
      fs.lstatSync(absolute).isSymbolicLink() ||
      fs.readdirSync(absolute).length !== 0);
  if (occupied()) invalidArchive('Archive destination must be a new or empty directory');
  const { manifest, entries } = readArchive(archivePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(absolute), '.omenflow-import-'));
  try {
    for (const [name, data] of Object.entries(entries)) {
      const dest = resolveProjectPath(staging, name);
      if (name.endsWith('/')) {
        fs.mkdirSync(dest, { recursive: true });
        continue;
      }
      if (name.startsWith('.omenflow/objects/')) {
        const hash = path.basename(name);
        validateObjectHash(hash);
        if (name.split('/')[2] !== hash.slice(0, 2) || sha256Hex(Buffer.from(data)) !== hash)
          invalidArchive(`Corrupt object: ${hash}`);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data, { flag: 'wx' });
    }
    validateStagedProject(staging, manifest);
    prepare?.(staging);
    if (occupied()) invalidArchive('Archive destination became occupied during import');
    // rename replaces an existing empty directory atomically on supported
    // desktop filesystems; a nonempty destination is never removed.
    fs.renameSync(staging, absolute);
  } catch (error) {
    if (error instanceof OmenflowError) throw error;
    invalidArchive(`Could not import project: ${(error as Error).message}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
