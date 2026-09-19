import { z } from 'zod';
import { ErrorCodes } from './errors.js';
import { idSchema } from './ids.js';

export const PROTOCOL_VERSION = 1;
export const SCHEMA_VERSION = 1;
export const PROJECT_FILE = 'omenflow.project.json';

/** Max bridge frame payload (bytes). */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** Max chars of job log retained in the DB. */
export const MAX_JOB_LOG_CHARS = 64 * 1024;
/** Max artifact file size (bytes). */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Max text extraction chars from research pages. */
export const MAX_EXTRACT_CHARS = 200 * 1024;
/** Max graph traversal depth for impact. */
export const MAX_IMPACT_DEPTH = 64;

export const requestEnvelopeSchema = z.object({
  requestId: z.string().min(1),
  projectId: idSchema.optional(),
  op: z.string().min(1),
  payload: z.unknown().optional(),
  idempotencyKey: z.string().optional(),
  expectedRevision: idSchema.optional(),
});
export type RequestEnvelope = z.infer<typeof requestEnvelopeSchema>;

export const responseEnvelopeSchema = z.object({
  requestId: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      repair: z.string().optional(),
      details: z.unknown().optional(),
    })
    .optional(),
});
export type ResponseEnvelope = z.infer<typeof responseEnvelopeSchema>;

export function okResponse(requestId: string, result: unknown): ResponseEnvelope {
  return { requestId, ok: true, result };
}
export function errResponse(
  requestId: string,
  code: string,
  message: string,
  repair?: string,
  details?: unknown,
): ResponseEnvelope {
  return { requestId, ok: false, error: { code, message, repair, details } };
}

/* ------------------------------------------------------------------ */
/* Bridge wire protocol                                                 */
/*                                                                      */
/* Transport: unix domain socket (macOS/Linux) or named pipe (Windows). */
/* Frames: 4-byte little-endian length + JSON body.                     */
/*                                                                      */
/* 1. client → handshake {type:'hello', token, protocolVersion, mode}   */
/* 2. server → {type:'welcome', protocolVersion, projectId, sessionId}  */
/*    or → {type:'error', error}                                        */
/* 3a. mode 'call': request/response envelopes over frames              */
/* 3b. mode 'mcp': raw JSON-RPC messages, one per frame, both ways      */
/* ------------------------------------------------------------------ */

export const bridgeHelloSchema = z.object({
  type: z.literal('hello'),
  token: z.string().min(1),
  protocolVersion: z.number().int(),
  mode: z.enum(['call', 'mcp']),
});
export type BridgeHello = z.infer<typeof bridgeHelloSchema>;

export const bridgeWelcomeSchema = z.object({
  type: z.literal('welcome'),
  protocolVersion: z.number().int(),
  projectId: idSchema,
  sessionId: idSchema,
  agentOps: z.array(z.string()),
});
export type BridgeWelcome = z.infer<typeof bridgeWelcomeSchema>;

export const bridgeErrorSchema = z.object({
  type: z.literal('error'),
  error: z.object({ code: z.string(), message: z.string() }),
});
export type BridgeError = z.infer<typeof bridgeErrorSchema>;

export type BridgeServerMessage = BridgeWelcome | BridgeError;

export const envKeys = {
  socketPath: 'OMENFLOW_BRIDGE_SOCK',
  token: 'OMENFLOW_BRIDGE_TOKEN',
  projectId: 'OMENFLOW_PROJECT_ID',
  sessionId: 'OMENFLOW_SESSION_ID',
} as const;

export function protocolMismatch(version: number): boolean {
  return version !== PROTOCOL_VERSION;
}

/* ------------------------------------------------------------------ */
/* Renderer ↔ main IPC                                                  */
/* ------------------------------------------------------------------ */

export const IPC = {
  /** invoke: {op, payload} → ResponseEnvelope (minus requestId echo). */
  command: 'omenflow:command',
  /** main → renderer push channels. */
  event: 'omenflow:event', // project events
  terminalData: 'omenflow:terminal:data',
  terminalState: 'omenflow:terminal:state',
  jobProgress: 'omenflow:job:progress',
  /** request-response utilities */
  pickDirectory: 'omenflow:pick-directory',
  pickFile: 'omenflow:pick-file',
  saveFile: 'omenflow:save-file',
  openExternal: 'omenflow:open-external',
  openPath: 'omenflow:open-path',
  windowState: 'omenflow:window-state',
} as const;

/** Project event pushed to renderer + bridge waiters. */
export const EVENT_TYPES = {
  PROJECT_CREATED: 'project.created',
  PROJECT_OPENED: 'project.opened',
  REVISION_COMMITTED: 'revision.committed',
  BASELINE_CHANGED: 'baseline.changed',
  PROPOSAL_SUBMITTED: 'proposal.submitted',
  PROPOSAL_RESOLVED: 'proposal.resolved',
  IMPACT_PROPAGATED: 'impact.propagated',
  STALE_CHANGED: 'stale.changed',
  JOB_UPDATED: 'job.updated',
  BOM_CHANGED: 'bom.changed',
  EXTERNAL_EDIT: 'file.external_edit',
  SESSION_STATE: 'session.state',
  SUGGESTED_ACTION: 'ui.suggested_action',
  ARTIFACT_OPEN: 'ui.open_artifact',
} as const;
