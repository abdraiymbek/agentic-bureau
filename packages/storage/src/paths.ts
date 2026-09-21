import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ErrorCodes, OmenflowError, PROJECT_FILE } from '@omenflow/contracts';

/** Normalize to a canonical absolute path (no trailing sep, real casing where possible). */
export function canonicalize(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    // Path doesn't exist yet — canonicalize the deepest existing ancestor and
    // re-append the missing tail so symlinked parents (e.g. /var → /private/var
    // on macOS) don't make valid children look like escapes.
    const missing: string[] = [];
    let cur = abs;
    while (!fs.existsSync(cur)) {
      missing.unshift(path.basename(cur));
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    try {
      return missing.reduce((p2, seg) => path.join(p2, seg), fs.realpathSync(cur));
    } catch {
      return abs;
    }
  }
}

/** True if `child` is inside `root` after canonicalization. */
export function isInside(root: string, child: string): boolean {
  const r = canonicalize(root);
  const c = canonicalize(child);
  const rel = path.relative(r, c);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve a project-relative path safely. Rejects absolute paths, `..`
 * escapes, and symlink redirection outside the project root.
 */
export function resolveProjectPath(root: string, rel: string): string {
  if (
    !rel ||
    rel.includes('\0') ||
    rel.includes('\\') ||
    path.isAbsolute(rel) ||
    /^[a-zA-Z]:/.test(rel)
  ) {
    throw new OmenflowError(ErrorCodes.PATH_OUTSIDE_PROJECT, `Absolute path not allowed: ${rel}`);
  }
  const rootCanon = canonicalize(root);
  const abs = path.resolve(rootCanon, rel);
  const relFromRoot = path.relative(rootCanon, abs);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    throw new OmenflowError(ErrorCodes.PATH_OUTSIDE_PROJECT, `Path escapes project: ${rel}`);
  }
  // Walk existing ancestors to catch symlinks that would redirect outside.
  let cur = abs;
  const missing: string[] = [];
  while (!fs.existsSync(cur)) {
    missing.push(path.basename(cur));
    cur = path.dirname(cur);
    if (cur === path.dirname(cur)) break;
  }
  const real = fs.realpathSync(cur);
  const resolved = missing.reduceRight((p, seg) => path.join(p, seg), real);
  const rel2 = path.relative(rootCanon, resolved);
  if (rel2.startsWith('..') || path.isAbsolute(rel2)) {
    throw new OmenflowError(ErrorCodes.PATH_OUTSIDE_PROJECT, `Symlink escapes project: ${rel}`);
  }
  return abs;
}

/** Author-controlled files never share a namespace with canonical state. */
export function resolveMaterializationPath(root: string, rel: string): string {
  const abs = resolveProjectPath(root, rel);
  const normalized = path.relative(canonicalize(root), abs).split(path.sep).join('/');
  const first = normalized.split('/')[0]?.toLowerCase();
  if (!normalized || first === '.omenflow' || first === PROJECT_FILE.toLowerCase()) {
    throw new OmenflowError(ErrorCodes.PATH_OUTSIDE_PROJECT, `Reserved project path: ${rel}`);
  }
  // A safe-looking alias may resolve back into canonical state.
  const actual = path.relative(canonicalize(root), canonicalize(abs)).split(path.sep).join('/');
  const actualFirst = actual.split('/')[0]?.toLowerCase();
  if (actualFirst === '.omenflow' || actualFirst === PROJECT_FILE.toLowerCase()) {
    throw new OmenflowError(ErrorCodes.PATH_OUTSIDE_PROJECT, `Reserved project path: ${rel}`);
  }
  return abs;
}

export const resolveProjectSourcePath = resolveMaterializationPath;

/** Atomic replacement, with policy checked again after creating directories. */
export function writeMaterializedFile(root: string, rel: string, bytes: Buffer): void {
  const dest = resolveMaterializationPath(root, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  resolveMaterializationPath(root, rel);
  const tmp = path.join(path.dirname(dest), `.omenflow-write-${randomUUID()}`);
  try {
    fs.writeFileSync(tmp, bytes, { flag: 'wx' });
    resolveMaterializationPath(root, rel);
    fs.renameSync(tmp, dest);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function toProjectRelative(root: string, abs: string): string {
  const rel = path.relative(canonicalize(root), canonicalize(abs));
  return rel.split(path.sep).join('/');
}

export function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function sha256File(p: string): string {
  return sha256Hex(fs.readFileSync(p));
}

/** Detect read-only project folders before they fail mid-operation. */
export function assertWritable(dir: string): void {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    throw new OmenflowError(ErrorCodes.READ_ONLY, `Folder is read-only: ${dir}`);
  }
}
