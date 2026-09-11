import { z } from 'zod';
import { idSchema } from './ids.js';

export const sessionStateSchema = z.enum([
  'starting',
  'running',
  'exited',
  'interrupted',
  'failed',
]);
export type SessionState = z.infer<typeof sessionStateSchema>;

export const sessionInfoSchema = z.object({
  id: idSchema,
  adapterId: z.string(),
  executablePath: z.string(),
  state: sessionStateSchema,
  pid: z.number().nullable(),
  exitCode: z.number().nullable(),
  cols: z.number().int(),
  rows: z.number().int(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  /** True while a structured STARK review is pending for this session. */
  waitingForReview: z.boolean().default(false),
  lastError: z.string().nullable(),
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

export const adapterStatusSchema = z.object({
  adapterId: z.string(),
  label: z.string(),
  available: z.boolean(),
  executablePath: z.string().nullable(),
  version: z.string().nullable(),
  testedVersionRange: z.string().nullable(),
  recognizedVersion: z.boolean(),
  capabilities: z.object({
    mcp: z.boolean(),
    cli: z.boolean(),
    resume: z.boolean(),
  }),
  lastTestAt: z.string().nullable(),
  lastTestOk: z.boolean().nullable(),
  lastError: z.string().nullable(),
  installHint: z.string().nullable(),
});
export type AdapterStatus = z.infer<typeof adapterStatusSchema>;

export const toolStatusSchema = z.object({
  toolId: z.string(),
  label: z.string(),
  kind: z.enum(['cad', 'agent', 'other']),
  available: z.boolean(),
  executablePath: z.string().nullable(),
  version: z.string().nullable(),
  lastError: z.string().nullable(),
  repair: z.string().nullable(),
});
export type ToolStatus = z.infer<typeof toolStatusSchema>;
