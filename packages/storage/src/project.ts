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
import { assertWritable, canonicalize } from './paths.js';

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
    this.objects = new ObjectStore(path.join(root, '.omenflow', 'objects'));
  }

  get project(): Project {
    const p = this.repo.getProject();
    if (!p) throw new OmenflowError(ErrorCodes.INTERNAL, 'Project row missing');
    return p;
  }

  workDir(sessionId: string): string {
    const dir = path.join(this.root, '.omenflow', 'work', sessionId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  close(): void {
    this.pdb.close();
  }
}

function writeProjectFile(root: string, pf: ProjectFile): void {
  fs.writeFileSync(path.join(root, PROJECT_FILE), JSON.stringify(pf, null, 2) + '\n', 'utf8');
}

function readProjectFile(root: string): ProjectFile {
  const p = path.join(root, PROJECT_FILE);
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
    const pdb = new ProjectDb(path.join(root, '.omenflow', 'state.sqlite'));
    return new ProjectHandle(root, pdb, true);
  }
  const pdb = new ProjectDb(path.join(root, '.omenflow', 'state.sqlite'));
  const handle = new ProjectHandle(root, pdb, pdb.readOnly);

  // Crash recovery: re-materialize pending file writes from object store.
  for (const m of handle.repo.pendingMaterializations()) {
    try {
      const abs = path.join(root, m.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (m.sha256 && handle.objects.has(m.sha256)) {
        const buf = handle.objects.read(m.sha256);
        fs.writeFileSync(abs, buf);
      }
      handle.repo.completeMaterialization(m.id);
    } catch {
      /* leave pending; retried next open */
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
