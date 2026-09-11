import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name: string) => path.join(root, '..', '..', 'packages', name, 'src', 'index.ts');

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
  build: {
    rollupOptions: {
      external: [
        'electron',
        'better-sqlite3',
        'node-pty',
        /^node:.*/,
        'fs', 'path', 'os', 'crypto', 'net', 'child_process', 'util', 'events', 'stream', 'worker_threads', 'module', 'assert', 'buffer', 'url', 'zlib', 'readline', 'tty', 'constants',
      ],
    },
  },
});
