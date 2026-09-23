import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: {
      '@omenflow/contracts': path.resolve(root, '../../packages/contracts/src/index.ts'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    fs: { allow: [path.resolve(root, '../..')] },
  },
  base: './',
  build: {
    outDir: path.join(root, 'rust-dist'),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    target: 'safari16.4',
  },
});
