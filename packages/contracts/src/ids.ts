import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const idSchema = z.string().uuid();
export type Id = string;

export function newId(): Id {
  return randomUUID();
}

/** Reference to an exact artifact revision. */
export const revisionRefSchema = z.object({
  artifactId: idSchema,
  revisionId: idSchema,
});
export type RevisionRef = z.infer<typeof revisionRefSchema>;

export function refKey(ref: RevisionRef): string {
  return `${ref.artifactId}@${ref.revisionId}`;
}

/** Origins are assigned by the core, never by the caller. */
export const originSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.literal('agent'), sessionId: idSchema }),
  z.object({ kind: z.literal('system') }),
]);
export type Origin = z.infer<typeof originSchema>;

export function originLabel(origin: Origin): string {
  return origin.kind === 'agent' ? `agent:${origin.sessionId.slice(0, 8)}` : origin.kind;
}
