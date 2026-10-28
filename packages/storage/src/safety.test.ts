import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProject, openProject, writeRenameJournal, renameJournalPath } from './project.js';
import { resolveMaterializationPath, sha256Hex, writeMaterializedFile } from './paths.js';
import { SCHEMA_VERSION } from '@bureau/contracts';

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-safety-'));
  roots.push(root);
  const project = path.join(root, 'project');
  return { root, project, handle: createProject(project, 'Safety', 'synthetic fixture') };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function bytes(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else result[path.relative(root, p)] = sha256Hex(fs.readFileSync(p));
    }
  };
  walk(root);
  return result;
}

describe('materialization boundaries and recovery', () => {
  it('rejects traversal, reserved aliases, and symlinks before replacing files', () => {
    const { root, project, handle } = fixture();
    fs.symlinkSync(path.join(project, '.bureau'), path.join(project, 'alias'));
    fs.symlinkSync(root, path.join(project, 'outside'));
    for (const rel of [
      '../outside.txt',
      '.bureau/state.sqlite',
      'bureau.project.json',
      'a/../.bureau/x',
      'alias/cache/attack',
      'outside/attack',
      '..\\attack',
    ]) {
      expect(() => resolveMaterializationPath(project, rel), rel).toThrow();
    }
    writeMaterializedFile(project, 'artifacts/mechanical/source.scad', Buffer.from('cube(10);'));
    expect(fs.readFileSync(path.join(project, 'artifacts/mechanical/source.scad'), 'utf8')).toBe(
      'cube(10);',
    );
    handle.close();
  });

  it('quarantines malicious journals and leaves missing/corrupt blobs pending', () => {
    const { root, project, handle } = fixture();
    const good = handle.objects.putText('good');
    const corrupt = handle.objects.putText('corrupt me');
    fs.chmodSync(handle.objects.absPath(corrupt), 0o644);
    fs.writeFileSync(handle.objects.absPath(corrupt), 'wrong bytes');
    const invalid = [
      handle.repo.addMaterialization('../outside.txt', good, null),
      handle.repo.addMaterialization('.bureau/cache/attack', good, null),
      handle.repo.addMaterialization('artifacts/bad.txt', '../bad', null),
    ];
    const missing = handle.repo.addMaterialization('artifacts/missing.txt', 'f'.repeat(64), null);
    const broken = handle.repo.addMaterialization('artifacts/corrupt.txt', corrupt, null);
    const valid = handle.repo.addMaterialization('artifacts/recovered.txt', good, null);
    handle.close();
    const reopened = openProject(project);
    const state = (id: string) =>
      (
        reopened.repo.db.prepare('SELECT state FROM materialization WHERE id=?').get(id) as {
          state: string;
        }
      ).state;
    for (const id of invalid) expect(state(id)).toBe('quarantined');
    expect(state(missing)).toBe('pending');
    expect(state(broken)).toBe('pending');
    expect(state(valid)).toBe('done');
    expect(fs.existsSync(path.join(root, 'outside.txt'))).toBe(false);
    expect(fs.existsSync(path.join(project, '.bureau/cache/attack'))).toBe(false);
    expect(fs.existsSync(path.join(project, 'artifacts/corrupt.txt'))).toBe(false);
    expect(
      reopened.repo.listEvents(100).filter((e) => e.type === 'project.recovery_error'),
    ).toHaveLength(5);
    reopened.close();
  });

  it('rejects malformed and corrupt immutable objects', () => {
    const { handle } = fixture();
    expect(() => handle.objects.read('../bad')).toThrow();
    expect(() => handle.objects.has('a'.repeat(63))).toThrow();
    const hash = handle.objects.putText('hello');
    fs.chmodSync(handle.objects.absPath(hash), 0o644);
    fs.writeFileSync(handle.objects.absPath(hash), 'wrong');
    expect(() => handle.objects.read(hash)).toThrow(/Corrupt object/);
    expect(() => handle.objects.putText('hello')).toThrow(/Corrupt object/);
    handle.close();
  });

  it('preserves a divergent external working file during crash recovery', () => {
    const { project, handle } = fixture();
    const hash = handle.objects.putText('committed version');
    const rel = 'artifacts/mechanical/part.scad';
    const id = handle.repo.addMaterialization(rel, hash, null);
    fs.writeFileSync(path.join(project, rel), 'external version');
    handle.close();
    const reopened = openProject(project);
    expect(fs.readFileSync(path.join(project, rel), 'utf8')).toBe('external version');
    expect(fs.readFileSync(path.join(project, `${rel}.bureau-recovery-${id}`), 'utf8')).toBe(
      'committed version',
    );
    expect(reopened.repo.pendingMaterializations().map((m) => m.id)).toContain(id);
    expect(reopened.repo.listEvents(100).some((e) => e.type === 'project.recovery_error')).toBe(
      true,
    );
    reopened.close();
  });
});

describe('rename journal recovery', () => {
  it('applies the intended name to both SQLite and the marker on open', () => {
    const { project, handle } = fixture();
    writeRenameJournal(project, 'Recovered');
    expect(fs.existsSync(renameJournalPath(project))).toBe(true);
    handle.close();
    const reopened = openProject(project);
    expect(reopened.project.name).toBe('Recovered');
    expect(
      JSON.parse(fs.readFileSync(path.join(project, 'bureau.project.json'), 'utf8')).name,
    ).toBe('Recovered');
    expect(fs.existsSync(renameJournalPath(project))).toBe(false);
    reopened.close();
  });
});

describe('unsupported projects are genuinely read-only', () => {
  it.each(['marker', 'database'])(
    'does not write source bytes or replay recovery for newer %s',
    (kind) => {
      const { project, handle } = fixture();
      const hash = handle.objects.putText('pending');
      handle.repo.addMaterialization('artifacts/pending.txt', hash, null);
      if (kind === 'database')
        handle.repo.db.prepare("UPDATE meta SET value='999' WHERE key='schema_version'").run();
      handle.close();
      if (kind === 'marker') {
        const marker = path.join(project, 'bureau.project.json');
        const pf = JSON.parse(fs.readFileSync(marker, 'utf8'));
        pf.version = SCHEMA_VERSION + 100;
        fs.writeFileSync(marker, JSON.stringify(pf));
      }
      const before = bytes(project);
      const reopened = openProject(project);
      expect(reopened.readOnly).toBe(true);
      expect(reopened.pdb.db.readonly).toBe(true);
      expect(reopened.project.name).toBe('Safety');
      expect(() => reopened.repo.db.prepare("UPDATE project SET name='mutated'").run()).toThrow();
      expect(() => reopened.objects.putText('mutated')).toThrow();
      expect(() => reopened.workDir('session')).toThrow();
      reopened.close();
      expect(bytes(project)).toEqual(before);
    },
  );

  it('reads committed WAL content without touching its source database', () => {
    const { project, handle } = fixture();
    handle.repo.db.prepare("UPDATE meta SET value='999' WHERE key='schema_version'").run();
    handle.repo.db.prepare("UPDATE project SET name='WAL value'").run();
    const before = bytes(project);
    const reopened = openProject(project);
    expect(reopened.readOnly).toBe(true);
    expect(reopened.project.name).toBe('WAL value');
    reopened.close();
    expect(bytes(project)).toEqual(before);
    handle.close();
  });
});
