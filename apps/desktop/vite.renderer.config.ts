import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@omenflow/contracts/format': path.join(
        root,
        '..',
        '..',
        'packages',
        'contracts',
        'src',
        'format.ts',
      ),
      '@omenflow/contracts/chat': path.join(
        root,
        '..',
        '..',
        'packages',
        'contracts',
        'src',
        'chat.ts',
      ),
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
    // Keep vendored fonts on the app origin required by the production CSP.
    assetsInlineLimit: 0,
    target: 'chrome120',
    sourcemap: true,
  },
});
