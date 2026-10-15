import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { artifactPayloadSchemas } from './entities.js';
import { ErrorCodes } from './errors.js';
import {
  AGENT_OPS,
  AGENT_TOOL_OPS,
  OPS,
  type Capability,
  type OpPack,
  type OpTier,
} from './ops.js';
import {
  EVENT_TYPES,
  MAX_FRAME_BYTES,
  PROJECT_FILE,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  envKeys,
} from './protocol.js';
import type { CapabilityProfile } from './session.js';

/**
 * The operation manifest the Rust crates read (`crates/contracts/registry.json`).
 * It is generated from the zod contracts by `pnpm contracts:export`; never edit
 * the JSON by hand. `pnpm contracts:check` and `tests/contracts-registry.test.ts`
 * fail when the file and the contracts drift apart.
 */

export type JsonSchema = Record<string, unknown>;

export interface RegistryOperation {
  name: string;
  toolName: string;
  description: string;
  capability: Capability;
  mutating: boolean;
  agentVisible: boolean;
  agentAllowed: boolean;
  agentTool: boolean;
  tier: OpTier;
  pack: OpPack;
  summary: string;
  example: Record<string, unknown> | null;
  compactSchema: JsonSchema | null;
  inputSchema: JsonSchema;
}

export interface RegistryManifest {
  protocolVersion: number;
  schemaVersion: number;
  projectFile: string;
  maxFrameBytes: number;
  envKeys: Record<string, string>;
  errorCodes: string[];
  eventTypes: string[];
  artifactPayloadSchemas: Record<string, JsonSchema>;
  operations: RegistryOperation[];
}

function jsonSchema(schema: z.ZodTypeAny): JsonSchema {
  return zodToJsonSchema(schema, { $refStrategy: 'none' }) as JsonSchema;
}

/**
 * A listing overlay carries only what a model needs to form a call: the
 * dialect marker and the closed-object markers are dropped. Validation always
 * runs against the full input schema, so nothing is loosened by this.
 */
function overlaySchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(overlaySchema);
  if (!node || typeof node !== 'object') return node;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema') continue;
    if (key === 'additionalProperties' && isOpenOrClosedMarker(value)) continue;
    // `properties` maps field names to schemas; a field may be named like a keyword.
    out[key] =
      key === 'properties'
        ? Object.fromEntries(
            Object.entries(value as JsonSchema).map(([name, child]) => [
              name,
              overlaySchema(child),
            ]),
          )
        : overlaySchema(value);
  }
  return out;
}

function isOpenOrClosedMarker(value: unknown): boolean {
  return (
    value === false ||
    (!!value && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length)
  );
}

export function buildRegistry(): RegistryManifest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: SCHEMA_VERSION,
    projectFile: PROJECT_FILE,
    maxFrameBytes: MAX_FRAME_BYTES,
    envKeys,
    errorCodes: Object.values(ErrorCodes),
    eventTypes: Object.values(EVENT_TYPES),
    artifactPayloadSchemas: Object.fromEntries(
      Object.entries(artifactPayloadSchemas).map(([type, schema]) => [type, jsonSchema(schema)]),
    ),
    operations: OPS.map((op) => ({
      name: op.name,
      toolName: op.toolName,
      description: op.description,
      capability: op.capability,
      mutating: op.mutating,
      agentVisible: op.agentVisible,
      agentAllowed: AGENT_OPS.has(op.name),
      agentTool: AGENT_TOOL_OPS.has(op.name),
      tier: op.tier,
      pack: op.pack,
      summary: op.summary,
      example: op.example,
      compactSchema: op.compactSchema
        ? (overlaySchema(jsonSchema(op.compactSchema)) as JsonSchema)
        : null,
      inputSchema: jsonSchema(op.input),
    })),
  };
}

/** The exact bytes of `registry.json` for a manifest. */
export function serializeRegistry(manifest: RegistryManifest = buildRegistry()): string {
  return JSON.stringify(manifest, null, 2) + '\n';
}

/** Whether a capability profile lists an operation as a tool. */
export function listedIn(
  profile: CapabilityProfile,
  op: Pick<RegistryOperation, 'agentTool' | 'tier'>,
): boolean {
  if (!op.agentTool) return false;
  if (profile === 'full') return true;
  return op.tier === 'core' || (profile === 'standard' && op.tier === 'standard');
}

export interface ListedTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/**
 * The tools a profile lists, as the registry defines them: summary and compact
 * overlay for `compact`, description and full input schema otherwise. Used to
 * measure and bound the size of each profile's listing.
 */
export function toolListing(
  profile: CapabilityProfile,
  manifest: RegistryManifest = buildRegistry(),
): ListedTool[] {
  return manifest.operations
    .filter((op) => listedIn(profile, op))
    .map((op) =>
      profile === 'compact'
        ? {
            name: op.toolName,
            description: op.summary,
            inputSchema: op.compactSchema ?? op.inputSchema,
          }
        : { name: op.toolName, description: op.description, inputSchema: op.inputSchema },
    );
}
