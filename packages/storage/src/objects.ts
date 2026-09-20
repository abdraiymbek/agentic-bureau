import fs from 'node:fs';
import path from 'node:path';
import { ErrorCodes, MAX_FILE_BYTES, OmenflowError } from '@omenflow/contracts';
import { sha256Hex } from './paths.js';

/**
 * Content-addressed immutable object store under `.omenflow/objects/`.
 * Objects are written once and never mutated; revisions reference hashes.
 */
export class ObjectStore {
  constructor(private readonly objectsDir: string) {
    fs.mkdirSync(objectsDir, { recursive: true });
  }

  private objectPath(hash: string): string {
    return path.join(this.objectsDir, hash.slice(0, 2), hash);
  }

  /** Write bytes into the store; returns the sha256. Idempotent. */
  put(buf: Buffer): string {
    if (buf.byteLength > MAX_FILE_BYTES) {
      throw new OmenflowError(ErrorCodes.VALIDATION, `File exceeds ${MAX_FILE_BYTES} byte limit`);
    }
    const hash = sha256Hex(buf);
    const dest = this.objectPath(hash);
    if (fs.existsSync(dest)) return hash;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
    // Objects are immutable on disk too.
    try {
      fs.chmodSync(dest, 0o444);
    } catch {
      /* best effort */
    }
    return hash;
  }

  putFile(absPath: string): string {
    return this.put(fs.readFileSync(absPath));
  }

  putText(text: string): string {
    return this.put(Buffer.from(text, 'utf8'));
  }

  has(hash: string): boolean {
    return fs.existsSync(this.objectPath(hash));
  }

  read(hash: string): Buffer {
    return fs.readFileSync(this.objectPath(hash));
  }

  readText(hash: string): string {
    return this.read(hash).toString('utf8');
  }

  absPath(hash: string): string {
    return this.objectPath(hash);
  }

  /** Restore object to writable-then-protected state for tests. */
  deleteUnreferenced(keep: Set<string>): string[] {
    const removed: string[] = [];
    for (const shard of fs.readdirSync(this.objectsDir)) {
      const shardDir = path.join(this.objectsDir, shard);
      if (!fs.statSync(shardDir).isDirectory()) continue;
      for (const file of fs.readdirSync(shardDir)) {
        if (!/^[0-9a-f]{62}$/.test(file)) continue;
        const hash = shard + file;
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
