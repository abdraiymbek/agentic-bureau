/** Core calls made by the decision level. */
import type { BureauErrorBody } from '@bureau/contracts';
import { CommandError } from '../api';

/**
 * Like `cmd`, but a failure is reported only by the caller: the decision bar shows it inline,
 * once, beside the action that failed, instead of also raising the global error strip.
 */
export async function quietCmd<T>(
  op: string,
  payload: unknown,
  opts: { projectId?: string; idempotencyKey?: string },
): Promise<T> {
  const res = await window.bureau.command(op, payload, opts);
  if (!res.ok)
    throw new CommandError(
      (res.error as BureauErrorBody | undefined) ?? {
        code: 'INTERNAL',
        message: 'unknown error',
      },
    );
  return res.result as T;
}

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Immutable revision files read for review, shared by every view of the same bytes. */
const FILE_LIMIT = 16;
const files = new Map<string, Promise<Uint8Array>>();

export function readRevisionFile(
  projectId: string | null,
  rev: { artifactId: string; id: string },
  path: string,
): Promise<Uint8Array> {
  const key = `${projectId}:${rev.id}:${path}`;
  const hit = files.get(key);
  if (hit) {
    files.delete(key);
    files.set(key, hit);
    return hit;
  }
  const read = quietCmd<{ contentBase64: string }>(
    'artifact.read_file',
    { artifactId: rev.artifactId, revisionId: rev.id, path },
    { projectId: projectId ?? undefined },
  ).then((r) => decode(r.contentBase64));
  read.catch(() => files.delete(key));
  files.set(key, read);
  while (files.size > FILE_LIMIT) files.delete(files.keys().next().value!);
  return read;
}
