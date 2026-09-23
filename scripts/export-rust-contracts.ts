/** Frozen, reviewable operation manifest for the Rust port. Build-time only. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_OPS,
  AGENT_TOOL_OPS,
  ErrorCodes,
  EVENT_TYPES,
  MAX_FRAME_BYTES,
  OPS,
  PROTOCOL_VERSION,
  PROJECT_FILE,
  SCHEMA_VERSION,
  artifactPayloadSchemas,
  envKeys,
} from '@omenflow/contracts';
import { zodToJsonSchema } from 'zod-to-json-schema';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'crates', 'contracts', 'registry.json');
const manifest = {
  protocolVersion: PROTOCOL_VERSION,
  schemaVersion: SCHEMA_VERSION,
  projectFile: PROJECT_FILE,
  maxFrameBytes: MAX_FRAME_BYTES,
  envKeys,
  errorCodes: Object.values(ErrorCodes),
  eventTypes: Object.values(EVENT_TYPES),
  artifactPayloadSchemas: Object.fromEntries(
    Object.entries(artifactPayloadSchemas).map(([type, schema]) => [
      type,
      zodToJsonSchema(schema, { $refStrategy: 'none' }),
    ]),
  ),
  operations: OPS.map((op) => ({
    name: op.name,
    toolName: op.name.replace(/\./g, '_'),
    description: op.description,
    capability: op.capability,
    mutating: op.mutating,
    agentVisible: op.agentVisible,
    agentAllowed: AGENT_OPS.has(op.name),
    agentTool: AGENT_TOOL_OPS.has(op.name),
    inputSchema: zodToJsonSchema(op.input, { $refStrategy: 'none' }),
  })),
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n');
console.log(`${manifest.operations.length} operation contracts → ${path.relative(root, output)}`);
