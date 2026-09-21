import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ErrorCodes, OmenflowError, type OmenflowErrorBody } from '@omenflow/contracts';
import type { Repo } from '@omenflow/storage';

/** Acknowledged-write boundaries where tests inject process death. */
export type DurabilityBoundary =
  | 'app.reservation.stored'
  | 'app.reservation.completed'
  | 'project.create.after-domain'
  | 'project.create.after-register'
  | 'project.import.after-domain'
  | 'project.rename.journal-written'
  | 'project.rename.after-db'
  | 'project.rename.after-marker'
  | 'dispatch.after-domain-before-result'
  | 'dispatch.after-result-journal';

export type DurabilityHook = (boundary: DurabilityBoundary, detail?: unknown) => void;

export function runDurabilityHooks(
  hooks: DurabilityHook[] | undefined,
  boundary: DurabilityBoundary,
  detail?: unknown,
): void {
  if (!hooks?.length) return;
  for (const hook of hooks) hook(boundary, detail);
}

export function hashRequest(op: string, payload: unknown): string {
  return createHash('sha256').update(JSON.stringify({ op, payload })).digest('hex');
}

export function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export type AppReservationState = 'reserved' | 'completed' | 'failed';

export interface AppReservation {
  op: string;
  requestHash: string;
  state: AppReservationState;
  result?: unknown;
  error?: OmenflowErrorBody;
  projectPath?: string;
  createdAt: string;
}

interface ReservationFile {
  reservations: Record<string, AppReservation>;
}

export function appReservationKey(
  originKind: string,
  sessionId: string | undefined,
  op: string,
  idempotencyKey: string,
): string {
  const who = originKind === 'agent' ? (sessionId ?? 'agent') : 'user';
  return `${who}:${op}:${idempotencyKey}`;
}

export function reservationsPath(appDataDir: string): string {
  return path.join(appDataDir, 'reservations.json');
}

export function loadAppReservations(appDataDir: string): Record<string, AppReservation> {
  const file = reservationsPath(appDataDir);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ReservationFile;
    return parsed.reservations ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* keep going with an empty table */
    }
    return {};
  }
}

export function saveAppReservations(
  appDataDir: string,
  reservations: Record<string, AppReservation>,
): void {
  atomicWriteJson(reservationsPath(appDataDir), { reservations } satisfies ReservationFile);
}

export function replayAppReservation(
  reservation: AppReservation | undefined,
  requestHash: string,
): unknown | null {
  if (!reservation) return null;
  if (reservation.requestHash !== requestHash)
    throw new OmenflowError(ErrorCodes.VALIDATION, 'Idempotency key reused with different payload');
  if (reservation.state === 'completed')
    return { ...(reservation.result as object), idempotent: true };
  if (reservation.state === 'failed' && reservation.error)
    throw OmenflowError.fromBody(reservation.error);
  return null;
}

export interface ResultJournal {
  key: string;
  requestHash: string;
  response: unknown;
  writtenAt: string;
}

export function resultJournalPath(root: string, key: string): string {
  const digest = createHash('sha256').update(key).digest('hex');
  return path.join(root, '.omenflow', 'recovery', 'idempotency', `${digest}.json`);
}

export function writeResultJournal(root: string, journal: ResultJournal): void {
  atomicWriteJson(resultJournalPath(root, journal.key), journal);
}

export function readResultJournal(
  root: string,
  key: string,
  requestHash: string,
): ResultJournal | null {
  const file = resultJournalPath(root, key);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ResultJournal;
    if (parsed.key !== key || parsed.requestHash !== requestHash) return null;
    if ((parsed.response as { operationPending?: boolean })?.operationPending) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearResultJournal(root: string, key: string): void {
  fs.rmSync(resultJournalPath(root, key), { force: true });
}

/** Persist journals written after a domain commit but before SQLite idempotency. */
export function recoverResultJournals(root: string, repo: Repo): number {
  const dir = path.join(root, '.omenflow', 'recovery', 'idempotency');
  if (!fs.existsSync(dir)) return 0;
  let recovered = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ResultJournal;
      if (
        !parsed.key ||
        !parsed.requestHash ||
        parsed.response === undefined ||
        (parsed.response as { operationPending?: boolean })?.operationPending
      )
        continue;
      repo.putIdempotent(parsed.key, parsed.requestHash, parsed.response);
      fs.rmSync(file, { force: true });
      recovered++;
    } catch {
      try {
        fs.renameSync(file, `${file}.corrupt`);
      } catch {
        /* leave the unreadable file in place */
      }
    }
  }
  return recovered;
}
