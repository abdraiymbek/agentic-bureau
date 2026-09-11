import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@stark/contracts': path.join(root, '..', '..', 'packages', 'contracts', 'src', 'index.ts'),
    },
  },
  build: {
    rollupOptions: {
      external: ['electron', /^node:.*/],
    },
  },
});
