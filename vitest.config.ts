import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name: string) => path.join(root, 'packages', name, 'src', 'index.ts');

export default defineConfig({
  resolve: {
    alias: {
      '@stark/contracts': pkg('contracts'),
      '@stark/storage': pkg('storage'),
      '@stark/core': pkg('core'),
      '@stark/agent-host': pkg('agent-host'),
      '@stark/mcp-server': pkg('mcp-server'),
      '@stark/engineering': pkg('engineering'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'tests/**/*.test.ts', 'fixtures/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
