import fs from 'node:fs';
import path from 'node:path';
import {
  ErrorCodes,
  PROJECT_FILE,
  Project,
  SCHEMA_VERSION,
  OmenflowError,
  newId,
} from '@omenflow/contracts';
import { ProjectDb } from './db.js';
import { LATEST_SCHEMA_VERSION } from './schema.js';
import { ObjectStore } from './objects.js';
import { Repo } from './repo.js';
import {
  assertWritable,
  canonicalize,
  resolveProjectPath,
  resolveMaterializationPath,
  writeMaterializedFile,
  sha256Hex,
} from './paths.js';
import { validateObjectHash } from './objects.js';
import { randomUUID } from 'node:crypto';

export const ARTIFACT_DIRS = [
  'requirements',
  'research',
  'concepts',
  'components',
  'mechanical',
  'electronics',
  'calculations',
  'software',
  'assembly',
  'tests',
] as const;

const OMENFLOW_SUBDIRS = ['objects', 'work', 'recovery', 'cache'] as const;

interface ProjectFile {
  format: 'omenflow-project';
  version: number;
  id: string;
  name: string;
}

/** A live, opened project: folder layout + canonical DB + object store. */
export class ProjectHandle {
  readonly repo: Repo;
  readonly objects: ObjectStore;

  constructor(
    public readonly root: string,
    public readonly pdb: ProjectDb,
    public readonly readOnly: boolean,
  ) {
    this.repo = new Repo(pdb.db);
    this.objects = new ObjectStore(resolveProjectPath(root, '.omenflow/objects'), readOnly);
  }

  get project(): Project {
    const p = this.repo.getProject();
    if (!p) throw new OmenflowError(ErrorCodes.INTERNAL, 'Project row missing');
    return p;
  }

  workDir(sessionId: string): string {
    if (this.readOnly) throw new OmenflowError(ErrorCodes.READ_ONLY, 'Project is read-only');
    const dir = path.join(this.root, '.omenflow', 'work', sessionId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  close(): void {
    this.pdb.close();
  }
}

function writeProjectFile(root: string, pf: ProjectFile): void {
  const dest = resolveProjectPath(root, PROJECT_FILE);
  const tmp = `${dest}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(pf, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmp, dest);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function updateProjectFile(
  root: string,
  changes: Partial<Pick<ProjectFile, 'id' | 'name'>>,
): void {
  const previous = readProjectFile(root);
  if (previous.version > SCHEMA_VERSION)
    throw new OmenflowError(ErrorCodes.READ_ONLY, 'Project is read-only');
  writeProjectFile(root, { ...previous, ...changes });
}

/** One journal covers SQLite name + marker file; recovery finishes both. */
export interface RenameJournal {
  version: 1;
  name: string;
  startedAt: string;
}

export function renameJournalPath(root: string): string {
  return path.join(canonicalize(root), '.omenflow', 'recovery', 'rename.json');
}

export function writeRenameJournal(root: string, name: string): void {
  const dest = renameJournalPath(root);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${randomUUID()}`;
  const journal: RenameJournal = { version: 1, name, startedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(tmp, JSON.stringify(journal) + '\n', { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmp, dest);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function readRenameJournal(root: string): RenameJournal | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(renameJournalPath(root), 'utf8')) as RenameJournal;
    return parsed.version === 1 && parsed.name ? parsed : null;
  } catch {
    return null;
  }
}

export function clearRenameJournal(root: string): void {
  fs.rmSync(renameJournalPath(root), { force: true });
}

/** Finish a crash between the DB rename and the marker, or vice versa. */
export function applyRenameJournal(handle: ProjectHandle): boolean {
  if (handle.readOnly) return false;
  const journal = readRenameJournal(handle.root);
  if (!journal) return false;
  const project = handle.repo.getProject();
  if (project && project.name !== journal.name) {
    handle.repo.tx(() => {
      handle.repo.updateProject({ name: journal.name });
      handle.repo.appendEvent('project.renamed', 'system', {
        name: journal.name,
        recovered: true,
      });
    });
  }
  const marker = readProjectFile(handle.root);
  if (marker.name !== journal.name) updateProjectFile(handle.root, { name: journal.name });
  clearRenameJournal(handle.root);
  return true;
}

export function readProjectFile(root: string): ProjectFile {
  const p = resolveProjectPath(root, PROJECT_FILE);
  if (!fs.existsSync(p)) {
    throw new OmenflowError(
      ErrorCodes.NOT_FOUND,
      `Not an Omen Flow project (missing ${PROJECT_FILE})`,
      {
        repair: 'Choose a folder containing an Omen Flow project, or create a new one.',
      },
    );
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as ProjectFile;
    if (parsed.format !== 'omenflow-project') throw new Error('bad format');
    return parsed;
  } catch (e) {
    throw new OmenflowError(
      ErrorCodes.VALIDATION,
      `Invalid ${PROJECT_FILE}: ${(e as Error).message}`,
    );
  }
}

/** Create a project folder + canonical DB. Idempotent-ish: refuses non-empty non-project dirs. */
export function createProject(dir: string, name: string, intent: string): ProjectHandle {
  const root = canonicalize(dir);
  // Creation must never rewrite an existing marker (in particular, downgrade
  // a newer project format before its read-only guard can inspect it).
  if (fs.existsSync(path.join(root, PROJECT_FILE))) {
    throw new OmenflowError(ErrorCodes.VALIDATION, 'Project already exists', {
      repair: 'Open the existing project instead of creating over it.',
    });
  }
  fs.mkdirSync(root, { recursive: true });
  assertWritable(root);

  const existing = fs.readdirSync(root).filter((f) => !f.startsWith('.DS_Store'));
  if (existing.length > 0 && !fs.existsSync(path.join(root, PROJECT_FILE))) {
    throw new OmenflowError(ErrorCodes.VALIDATION, `Folder is not empty: ${root}`, {
      repair: 'Pick an empty folder or open an existing project.',
    });
  }

  for (const d of ARTIFACT_DIRS) fs.mkdirSync(path.join(root, 'artifacts', d), { recursive: true });
  fs.mkdirSync(path.join(root, 'exports'), { recursive: true });
  for (const d of OMENFLOW_SUBDIRS)
    fs.mkdirSync(path.join(root, '.omenflow', d), { recursive: true });

  const projectId = fs.existsSync(path.join(root, PROJECT_FILE))
    ? readProjectFile(root).id
    : newId();
  writeProjectFile(root, {
    format: 'omenflow-project',
    version: SCHEMA_VERSION,
    id: projectId,
    name,
  });

  const readme = path.join(root, 'README.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      `# ${name}\n\nOmen Flow engineering project. State lives in \`.omenflow/state.sqlite\`;\nreadable views live under \`artifacts/\`.\n\n${intent}\n`,
      'utf8',
    );
  }

  const pdb = new ProjectDb(path.join(root, '.omenflow', 'state.sqlite'), { create: true });
  const handle = new ProjectHandle(root, pdb, false);
  if (!handle.repo.getProject()) {
    handle.repo.tx(() => {
      handle.repo.insertProject({
        id: projectId,
        name,
        intent,
        unitsPref: 'si',
        currencyPref: 'USD',
        schemaVersion: LATEST_SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
      });
      handle.repo.appendEvent('project.created', 'user', { name });
    });
  }
  return handle;
}

/** Open an existing project; runs migrations (with backup) and recovery repair. */
export function openProject(dir: string): ProjectHandle {
  const root = canonicalize(dir);
  const pf = readProjectFile(root);
  if (pf.version > SCHEMA_VERSION) {
    // Open read-only: allow export but not mutation.
    const pdb = new ProjectDb(resolveProjectPath(root, '.omenflow/state.sqlite'), {
      readOnly: true,
    });
    return new ProjectHandle(root, pdb, true);
  }
  const pdb = new ProjectDb(resolveProjectPath(root, '.omenflow/state.sqlite'));
  const handle = new ProjectHandle(root, pdb, pdb.readOnly);
  if (handle.readOnly) return handle;

  applyRenameJournal(handle);

  // Crash recovery: re-materialize pending file writes from object store.
  for (const m of handle.repo.pendingMaterializations()) {
    try {
      resolveMaterializationPath(root, m.path);
      validateObjectHash(m.sha256 ?? '');
    } catch (error) {
      handle.repo.tx(() => {
        handle.repo.db
          .prepare(`UPDATE materialization SET state='quarantined' WHERE id=?`)
          .run(m.id);
        handle.repo.appendEvent('project.recovery_error', 'system', {
          materializationId: m.id,
          path: m.path,
          state: 'quarantined',
          error: (error as Error).message,
        });
      });
      continue;
    }
    try {
      // read() verifies the digest. A missing/corrupt object must not complete
      // the journal, and must not replace the last usable working file.
      const buf = handle.objects.read(m.sha256!);
      const dest = resolveMaterializationPath(root, m.path);
      if (fs.existsSync(dest) && sha256Hex(fs.readFileSync(dest)) !== m.sha256) {
        const conflictPath = `${m.path}.omenflow-recovery-${m.id}`;
        const conflict = resolveMaterializationPath(root, conflictPath);
        if (!fs.existsSync(conflict)) writeMaterializedFile(root, conflictPath, buf);
        throw new Error(
          `Working file differs from pending recovery; preserved both versions at ${m.path} and ${conflictPath}`,
        );
      }
      writeMaterializedFile(root, m.path, buf);
      handle.repo.completeMaterialization(m.id);
    } catch (error) {
      handle.repo.appendEvent('project.recovery_error', 'system', {
        materializationId: m.id,
        path: m.path,
        state: 'pending',
        error: (error as Error).message,
      });
    }
  }

  // Mark sessions/jobs left running by a crash.
  handle.repo.tx(() => {
    for (const s of handle.repo.sessionsByState('running')) {
      handle.repo.upsertSession({ ...s, state: 'interrupted', endedAt: new Date().toISOString() });
    }
    for (const j of handle.repo.listJobs(200, 'running')) {
      handle.repo.updateJob(j.id, { status: 'interrupted', finishedAt: new Date().toISOString() });
    }
    handle.repo.appendEvent('project.opened', 'system', { name: pf.name });
  });
  return handle;
}

/** The folder layout guaranteed to exist. */
export function ensureLayout(root: string): void {
  for (const d of ARTIFACT_DIRS) fs.mkdirSync(path.join(root, 'artifacts', d), { recursive: true });
  fs.mkdirSync(path.join(root, 'exports'), { recursive: true });
  for (const d of OMENFLOW_SUBDIRS)
    fs.mkdirSync(path.join(root, '.omenflow', d), { recursive: true });
}
