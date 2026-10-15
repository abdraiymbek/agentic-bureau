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

/**
 * Capability profile of an agent session. It is fixed when the session starts
 * and shapes what the agent is shown (tool list, schemas, guidance, result
 * size). It never changes what the agent is allowed to do or how work is
 * verified.
 */
export const capabilityProfiles = ['compact', 'standard', 'full'] as const;
export const capabilityProfileSchema = z.enum(capabilityProfiles);
export type CapabilityProfile = z.infer<typeof capabilityProfileSchema>;

/** What a person can choose for an adapter: a fixed profile, or `auto` to resolve it from the model. */
export const profileSettingSchema = z.enum(['auto', ...capabilityProfiles]);
export type ProfileSetting = z.infer<typeof profileSettingSchema>;

/** Why a session has its profile: the person's setting, the launch model, or the adapter default. */
export const profileSourceSchema = z.enum(['user', 'model', 'adapter-default']);
export type ProfileSource = z.infer<typeof profileSourceSchema>;

const sessionBaseSchema = z.object({
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
  /** True while a structured Omen Flow review is pending for this session. */
  waitingForReview: z.boolean().default(false),
  lastError: z.string().nullable(),
});

/** Added in V1. Defaults keep sessions recorded by earlier builds parseable. */
const sessionV1Schema = z.object({
  /** Model id passed to the CLI at launch; null when the CLI chose its own. */
  model: z.string().nullable().default(null),
  profile: capabilityProfileSchema.default('standard'),
  profileSource: profileSourceSchema.default('adapter-default'),
  /** Number of tools listed to the agent for this session's profile. */
  toolCount: z.number().int().nonnegative().default(0),
  /** Recorded agent calls in this session, and how many of them failed. */
  calls: z.number().int().nonnegative().default(0),
  errors: z.number().int().nonnegative().default(0),
});

export const sessionInfoSchema = sessionBaseSchema.merge(sessionV1Schema);
/**
 * Session as sent by a host. The V1 fields are optional in this type because
 * the legacy TypeScript host and records from earlier builds omit them; the
 * Rust host always sends them. Show an absent field as absent, or parse with
 * `sessionInfoSchema` to apply the defaults.
 */
export type SessionInfo = z.infer<typeof sessionBaseSchema> & z.input<typeof sessionV1Schema>;

/** A model the host suggests for an adapter. */
export const adapterModelSchema = z.object({
  /** Identifier passed to the CLI, e.g. the value of its `--model` flag. */
  id: z.string(),
  label: z.string(),
  /** Profile that `auto` resolves to when this model is launched. */
  tier: capabilityProfileSchema,
});
export type AdapterModel = z.infer<typeof adapterModelSchema>;

const adapterBaseSchema = z.object({
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

/** Added in V1. Defaults keep adapter records from earlier builds parseable. */
const adapterV1Schema = z.object({
  /** Configured launch model; null leaves the choice to the CLI. */
  model: z.string().nullable().default(null),
  /** The person's profile setting for this adapter. */
  profile: profileSettingSchema.default('auto'),
  /** Saved launch arguments. The saved environment is never listed. */
  args: z.array(z.string()).default([]),
  /** Profile a session started now would get, after resolving `auto`. */
  resolvedProfile: capabilityProfileSchema.default('standard'),
  models: z.array(adapterModelSchema).default([]),
  /** True only when this build exercised the adapter's launch path (codex, claude-code). */
  verified: z.boolean().default(false),
  docsUrl: z.string().nullable().default(null),
  /** How guidance reaches this CLI, e.g. MCP instructions or a system-prompt flag. */
  guideChannels: z.array(z.string()).default([]),
});

export const adapterStatusSchema = adapterBaseSchema.merge(adapterV1Schema);
/**
 * Adapter status as sent by a host. The V1 fields are optional in this type
 * for the same reason as on `SessionInfo`.
 */
export type AdapterStatus = z.infer<typeof adapterBaseSchema> & z.input<typeof adapterV1Schema>;

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
