/**
 * Calls to operations that not every host serves (`project.coverage`, `agent.activity`).
 * The answer distinguishes "this host does not have it" from a real failure, and neither raises
 * the application-wide error strip: the lens that asked shows the outcome itself.
 */
import type { BureauErrorBody } from '@bureau/contracts';
import { CommandError } from '../api';

export type OptionalResult<T> =
  { status: 'ok'; value: T } | { status: 'unavailable' } | { status: 'error'; error: Error };

/** True when the error says the host does not implement the operation at all. */
export function isUnavailable(body: BureauErrorBody): boolean {
  const details = body.details as { implementedBy?: unknown } | undefined;
  if (details?.implementedBy === 'rust-host') return true;
  // Transports that drop `details` still carry the legacy core's message.
  return (
    /^(Unknown operation|Operation not implemented)\b/.test(body.message) ||
    / is implemented by the Rust host$/.test(body.message)
  );
}

export async function optionalCommand<T>(
  op: string,
  payload: unknown,
  opts?: { projectId?: string },
): Promise<OptionalResult<T>> {
  try {
    const res = await window.bureau.command(op, payload, opts);
    if (res.ok) return { status: 'ok', value: res.result as T };
    const body = (res.error as BureauErrorBody | undefined) ?? {
      code: 'INTERNAL',
      message: 'unknown error',
    };
    if (isUnavailable(body)) return { status: 'unavailable' };
    return { status: 'error', error: new CommandError(body) };
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e : new Error(String(e)) };
  }
}
