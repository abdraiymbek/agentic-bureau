import { z } from 'zod';

export const idSchema = z.string().uuid();
export type Id = string;

export function newId(): Id {
  // crypto.randomUUID is a global in Node ≥19, Electron, and browsers.
  return crypto.randomUUID();
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

export { originLabel } from './format.js';
