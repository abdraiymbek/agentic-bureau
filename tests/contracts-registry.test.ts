import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OPS, buildRegistry, serializeRegistry } from '@omenflow/contracts';

const registryFile = fileURLToPath(new URL('../crates/contracts/registry.json', import.meta.url));

describe('crates/contracts/registry.json', () => {
  it('matches a fresh export of the TypeScript contracts', () => {
    const onDisk = fs.readFileSync(registryFile, 'utf8');
    // Compared as a boolean first: a 300 KB string diff is not a useful failure.
    expect(
      onDisk === serializeRegistry(),
      'registry.json is out of date. Run `pnpm contracts:export` and commit the result.',
    ).toBe(true);
  });

  it('exports deterministically', () => {
    expect(serializeRegistry()).toBe(serializeRegistry());
    expect(serializeRegistry(buildRegistry())).toBe(serializeRegistry());
  });

  it('carries the metadata the Rust host reads, for every operation', () => {
    const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8')) as {
      operations: Record<string, unknown>[];
    };
    expect(registry.operations.map((operation) => operation.name)).toEqual(
      OPS.map((op) => op.name),
    );
    for (const operation of registry.operations) {
      expect(Object.keys(operation), String(operation.name)).toEqual([
        'name',
        'toolName',
        'description',
        'capability',
        'mutating',
        'agentVisible',
        'agentAllowed',
        'agentTool',
        'tier',
        'pack',
        'summary',
        'example',
        'compactSchema',
        'inputSchema',
      ]);
      expect(operation.toolName).toBe(String(operation.name).replace(/\./g, '_'));
      expect(['core', 'standard', 'full']).toContain(operation.tier);
      expect((operation.inputSchema as { type?: string }).type).toBe('object');
    }
  });
});
