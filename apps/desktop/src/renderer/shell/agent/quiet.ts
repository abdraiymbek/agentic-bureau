/**
 * Commands whose failure the agent surface presents itself. They bypass the global error strip,
 * so an expected answer such as "this host does not serve agent.activity" is shown once, where
 * it belongs, instead of as an application error.
 */
import type { OmenflowErrorBody } from '@omenflow/contracts';

export type Quiet<T> = { ok: true; result: T } | { ok: false; error: OmenflowErrorBody };

export async function quiet<T>(
  op: string,
  payload: unknown = {},
  opts?: { projectId?: string },
): Promise<Quiet<T>> {
  try {
    const res = await window.omenflow.command(op, payload, opts);
    if (res.ok) return { ok: true, result: res.result as T };
    return {
      ok: false,
      error: (res.error as OmenflowErrorBody | undefined) ?? {
        code: 'INTERNAL',
        message: 'The host returned no error detail.',
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) },
    };
  }
}

/** The host does not implement the operation at all (as opposed to failing it). */
export function isUnserved(error: OmenflowErrorBody): boolean {
  const details = (error.details ?? {}) as { implementedBy?: unknown };
  if (details.implementedBy) return true;
  return /unknown (operation|op)\b|not implemented|is implemented by/i.test(error.message);
}

export function errorText(error: OmenflowErrorBody): string {
  return error.repair ? `${error.message} — ${error.repair}` : error.message;
}
