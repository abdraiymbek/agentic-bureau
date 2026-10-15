import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name: string) => path.join(root, 'packages', name, 'src', 'index.ts');

export default defineConfig({
  resolve: {
    alias: {
      // Subpath first: the string alias below would otherwise capture it.
      '@omenflow/contracts/format': path.join(root, 'packages', 'contracts', 'src', 'format.ts'),
      '@omenflow/contracts': pkg('contracts'),
      '@omenflow/storage': pkg('storage'),
      '@omenflow/core': pkg('core'),
      '@omenflow/agent-host': pkg('agent-host'),
      '@omenflow/mcp-server': pkg('mcp-server'),
      '@omenflow/engineering': pkg('engineering'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'tests/**/*.test.ts', 'fixtures/**/*.test.ts'],
    // The engine suites spawn OpenSCAD and calculation workers with wall-clock limits;
    // oversubscribing the machine makes those limits fire.
    maxWorkers: 4,
    minWorkers: 1,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
