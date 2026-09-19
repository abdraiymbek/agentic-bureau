import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@omenflow/contracts': path.join(
        root,
        '..',
        '..',
        'packages',
        'contracts',
        'src',
        'index.ts',
      ),
    },
  },
  build: {
    target: 'chrome120',
    sourcemap: true,
  },
});
