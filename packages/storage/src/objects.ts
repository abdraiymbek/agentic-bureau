import fs from 'node:fs';
import path from 'node:path';
import { ErrorCodes, MAX_FILE_BYTES, OmenflowError } from '@omenflow/contracts';
import { resolveProjectPath, sha256Hex } from './paths.js';

export function validateObjectHash(hash: string): void {
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new OmenflowError(ErrorCodes.VALIDATION, 'Invalid SHA-256 object identifier');
  }
}

/**
 * Content-addressed immutable object store under `.omenflow/objects/`.
 * Objects are written once and never mutated; revisions reference hashes.
 */
export class ObjectStore {
  constructor(
    private readonly objectsDir: string,
    private readonly readOnly = false,
  ) {
    if (!readOnly) fs.mkdirSync(objectsDir, { recursive: true });
  }

  private objectPath(hash: string): string {
    validateObjectHash(hash);
    return resolveProjectPath(this.objectsDir, `${hash.slice(0, 2)}/${hash}`);
  }

  /** Write bytes into the store; returns the sha256. Idempotent. */
  put(buf: Buffer): string {
    if (this.readOnly) throw new OmenflowError(ErrorCodes.READ_ONLY, 'Object store is read-only');
    if (buf.byteLength > MAX_FILE_BYTES) {
      throw new OmenflowError(ErrorCodes.VALIDATION, `File exceeds ${MAX_FILE_BYTES} byte limit`);
    }
    const hash = sha256Hex(buf);
    const dest = this.objectPath(hash);
    if (fs.existsSync(dest)) {
      this.read(hash); // Existing content must still match its immutable identity.
      return hash;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    try {
      const fd = fs.openSync(tmp, 'wx');
      try {
        fs.writeFileSync(fd, buf);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, dest);
      // Directory durability is supported on POSIX; some Windows filesystems
      // do not permit opening directories, so the rename is still retained.
      try {
        const dir = fs.openSync(path.dirname(dest), 'r');
        try {
          fs.fsyncSync(dir);
        } finally {
          fs.closeSync(dir);
        }
      } catch {
        /* platform limitation */
      }
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    // Objects are immutable on disk too.
    try {
      fs.chmodSync(dest, 0o444);
    } catch {
      /* best effort */
    }
    return hash;
  }

  putFile(absPath: string): string {
    if (fs.statSync(absPath).size > MAX_FILE_BYTES) {
      throw new OmenflowError(ErrorCodes.VALIDATION, `File exceeds ${MAX_FILE_BYTES} byte limit`);
    }
    return this.put(fs.readFileSync(absPath));
  }

  putText(text: string): string {
    return this.put(Buffer.from(text, 'utf8'));
  }

  has(hash: string): boolean {
    return fs.existsSync(this.objectPath(hash));
  }

  read(hash: string): Buffer {
    const objectPath = this.objectPath(hash);
    if (fs.statSync(objectPath).size > MAX_FILE_BYTES) {
      throw new OmenflowError(ErrorCodes.VALIDATION, `Object exceeds ${MAX_FILE_BYTES} byte limit`);
    }
    const bytes = fs.readFileSync(objectPath);
    if (sha256Hex(bytes) !== hash) {
      throw new OmenflowError(ErrorCodes.VALIDATION, `Corrupt object: ${hash}`);
    }
    return bytes;
  }

  readText(hash: string): string {
    return this.read(hash).toString('utf8');
  }

  absPath(hash: string): string {
    return this.objectPath(hash);
  }

  /** Restore object to writable-then-protected state for tests. */
  deleteUnreferenced(keep: Set<string>): string[] {
    if (this.readOnly) throw new OmenflowError(ErrorCodes.READ_ONLY, 'Object store is read-only');
    const removed: string[] = [];
    for (const shard of fs.readdirSync(this.objectsDir)) {
      const shardDir = path.join(this.objectsDir, shard);
      if (!fs.statSync(shardDir).isDirectory()) continue;
      for (const file of fs.readdirSync(shardDir)) {
        if (!/^[0-9a-f]{64}$/.test(file) || !file.startsWith(shard)) continue;
        const hash = file;
        if (!keep.has(hash)) {
          const p = path.join(shardDir, file);
          try {
            fs.chmodSync(p, 0o644);
            fs.unlinkSync(p);
            removed.push(hash);
          } catch {
            /* ignore */
          }
        }
      }
    }
    return removed;
  }
}
