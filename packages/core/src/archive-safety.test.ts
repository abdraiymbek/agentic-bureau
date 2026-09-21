import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { createProject, openProject, updateProjectFile } from '@omenflow/storage';
import { ARCHIVE_LIMITS, expandArchive, exportArchive, verifyArchive } from './build.js';
import { ProjectContext, nullHost } from './context.js';
import {
  pruneHistoricalSessionData,
  SESSION_DATA_KEEP_LAST,
  terminalExportConsent,
} from './session-retention.js';

const roots: string[] = [];
const handles: ReturnType<typeof createProject>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omenflow-archive-test-'));
  roots.push(root);
  const handle = createProject(path.join(root, 'source'), 'Archive', 'portable fixture');
  handles.push(handle);
  const ctx = new ProjectContext(handle, nullHost);
  const archive = path.join(root, 'project.zip');
  const exportIt = () => exportArchive(ctx, archive);
  const mutate = (change: (entries: Record<string, Uint8Array>) => void) => {
    const entries = unzipSync(fs.readFileSync(archive));
    change(entries);
    fs.writeFileSync(archive, zipSync(entries));
  };
  return { root, handle, ctx, archive, exportIt, mutate };
}

describe('private and portable archives', () => {
  it('excludes terminal bytes from DB pages and JSON without deleting live history', () => {
    const { root, handle, archive, exportIt } = fixture();
    const marker = 'TERMINAL-PRIVATE-MARKER-82319';
    handle.repo.appendEvent('session.data', 'system', { chunk: marker });
    handle.repo.putIdempotent('history-read', 'request', { chunk: marker });
    handle.repo.appendEvent('artifact.audit', 'user', { rationale: 'Engineering record' });
    exportIt();
    const entries = unzipSync(fs.readFileSync(archive));
    for (const data of Object.values(entries))
      expect(Buffer.from(data).includes(Buffer.from(marker))).toBe(false);
    expect(handle.repo.listEvents(100).some((e) => JSON.stringify(e).includes(marker))).toBe(true);
    const dest = path.join(root, 'imported');
    expandArchive(archive, dest);
    const imported = openProject(dest);
    handles.push(imported);
    expect(imported.project.id).toBe(handle.project.id);
    expect(imported.repo.listEvents(100).some((e) => e.type === 'artifact.audit')).toBe(true);
    expect(imported.repo.listEvents(100).some((e) => e.type === 'session.data')).toBe(false);
  });

  it('refuses occupied destinations, stages identity changes, and preserves destination on prepare failure', () => {
    const { root, archive, exportIt } = fixture();
    exportIt();
    const dest = path.join(root, 'occupied');
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, 'README.md'), 'keep me');
    expect(() => expandArchive(archive, dest)).toThrow(/empty directory/);
    expect(fs.readFileSync(path.join(dest, 'README.md'), 'utf8')).toBe('keep me');
    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty);
    expect(() =>
      expandArchive(archive, empty, () => {
        throw new Error('injected preparation failure');
      }),
    ).toThrow(/injected preparation failure/);
    expect(fs.readdirSync(empty)).toEqual([]);
    const id = '00000000-0000-4000-8000-000000000042';
    expandArchive(archive, empty, (staging) => {
      const h = openProject(staging);
      h.repo.db.prepare('UPDATE project SET id=?').run(id);
      updateProjectFile(staging, { id });
      h.close();
    });
    const imported = openProject(empty);
    handles.push(imported);
    expect(imported.project.id).toBe(id);
    expect(fs.readdirSync(root).some((name) => name.startsWith('.omenflow-import-'))).toBe(false);
  });

  it.each([
    'traversal',
    'reserved',
    'bad-object',
    'bad-database',
    'newer-marker',
    'unsafe-journal',
  ])('rejects %s before publishing', (variant) => {
    const { root, handle, archive, exportIt, mutate } = fixture();
    if (variant === 'unsafe-journal') {
      const hash = handle.objects.putText('attack');
      handle.repo.addMaterialization('../outside.txt', hash, null);
    }
    exportIt();
    mutate((entries) => {
      if (variant === 'traversal') entries['../outside.txt'] = strToU8('bad');
      if (variant === 'reserved') entries['.omenflow/work/stolen.txt'] = strToU8('bad');
      if (variant === 'bad-object')
        entries[`.omenflow/objects/aa/${'a'.repeat(64)}`] = strToU8('bad');
      if (variant === 'bad-database') entries['.omenflow/state.sqlite'] = strToU8('not sqlite');
      if (variant === 'newer-marker') {
        const marker = JSON.parse(Buffer.from(entries['omenflow.project.json']!).toString());
        marker.version = 999;
        entries['omenflow.project.json'] = strToU8(JSON.stringify(marker));
      }
    });
    const dest = path.join(root, 'rejected');
    expect(() => expandArchive(archive, dest)).toThrow();
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(path.join(root, 'outside.txt'))).toBe(false);
    expect(fs.readdirSync(root).some((name) => name.startsWith('.omenflow-import-'))).toBe(false);
  });

  it('checks CRC and size limits before trusting compressed entries', () => {
    const { archive, exportIt } = fixture();
    exportIt();
    const original = fs.readFileSync(archive);
    const directory = original.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const badCrc = Buffer.from(original);
    badCrc.writeUInt32LE((badCrc.readUInt32LE(directory + 16) ^ 1) >>> 0, directory + 16);
    fs.writeFileSync(archive, badCrc);
    expect(() => verifyArchive(archive)).toThrow(/Corrupt archive member/);
    const bomb = Buffer.from(original);
    bomb.writeUInt32LE(ARCHIVE_LIMITS.entryBytes + 1, directory + 24);
    fs.writeFileSync(archive, bomb);
    expect(() => verifyArchive(archive)).toThrow(/oversized ZIP member/);
    fs.writeFileSync(archive, original.subarray(0, original.length - 10));
    expect(() => verifyArchive(archive)).toThrow(/Missing ZIP directory/);
  });

  it('rejects symlink entries before extraction', () => {
    const { archive, exportIt } = fixture();
    exportIt();
    const bytes = fs.readFileSync(archive);
    const directory = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE((0xa1ff * 65536) >>> 0, directory + 38);
    fs.writeFileSync(archive, bytes);
    expect(() => verifyArchive(archive)).toThrow(/Unsupported/);
  });

  it('prunes oldest terminal rows and keeps engineering events', () => {
    const { handle, ctx } = fixture();
    handle.repo.appendEvent('artifact.audit', 'user', { keep: true });
    for (let i = 0; i < 5; i++) handle.repo.appendEvent('session.data', 'system', { i });
    expect(handle.repo.pruneSessionData(2)).toBe(3);
    const events = handle.repo.listEvents(20);
    expect(events.filter((e) => e.type === 'session.data')).toHaveLength(2);
    expect(events.some((e) => e.type === 'artifact.audit')).toBe(true);
    expect(SESSION_DATA_KEEP_LAST).toBeGreaterThan(0);
    pruneHistoricalSessionData(ctx);
  });

  it('requires explicit consent before a terminal-history archive', () => {
    const { ctx, archive } = fixture();
    ctx.repo.appendEvent('session.data', 'system', { chunk: 'CONSENT-MARKER' });
    expect(() => exportArchive(ctx, archive, { includeTerminalHistory: true })).toThrow(
      /export consent/,
    );
    expect(terminalExportConsent(ctx)).toBe(false);
    exportArchive(ctx, archive, {
      includeTerminalHistory: true,
      grantTerminalExportConsent: true,
    });
    expect(terminalExportConsent(ctx)).toBe(true);
    const entries = unzipSync(fs.readFileSync(archive));
    const snapshot = JSON.parse(Buffer.from(entries['snapshot.json']!).toString());
    expect(snapshot.events.some((e: { type: string }) => e.type === 'session.data')).toBe(true);
  });
});
