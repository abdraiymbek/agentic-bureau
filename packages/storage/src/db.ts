import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ErrorCodes, SCHEMA_VERSION, OmenflowError } from '@omenflow/contracts';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './schema.js';

export class ProjectDb {
  readonly db: Database.Database;
  /** True when opened against a newer unsupported schema. */
  readonly readOnly: boolean;

  constructor(dbPath: string, opts?: { create?: boolean }) {
    const exists = fs.existsSync(dbPath);
    if (!exists && !opts?.create) {
      throw new OmenflowError(ErrorCodes.NOT_FOUND, `No project database at ${dbPath}`);
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.readOnly = this.migrate(exists);
  }

  private currentVersion(): number {
    try {
      const row = this.db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as
        { value: string } | undefined;
      return row ? Number(row.value) : 0;
    } catch {
      return 0;
    }
  }

  private migrate(existed: boolean): boolean {
    let version = this.currentVersion();
    if (version > LATEST_SCHEMA_VERSION) {
      // Newer unsupported schema → read-only.
      return true;
    }
    if (version === LATEST_SCHEMA_VERSION) return false;

    // Safe backup before migration.
    if (existed) this.backupTo(`${this.db.name}.pre-migration-${Date.now()}.bak`);

    for (const m of MIGRATIONS) {
      if (m.version <= version) continue;
      this.db.transaction(() => {
        this.db.exec(m.sql);
        this.db
          .prepare(
            `INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
          )
          .run(String(m.version));
      })();
      version = m.version;
    }
    return false;
  }

  /**
   * Consistent snapshot of the main database. better-sqlite3 v13's
   * `db.backup()` is async-only, so use `serialize()` — project databases
   * are small enough to hold in memory.
   */
  backupTo(destPath: string): void {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, this.db.serialize());
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}

export const OMENFLOW_DIR = '.omenflow';
export const SCHEMA_META_VERSION = SCHEMA_VERSION;
