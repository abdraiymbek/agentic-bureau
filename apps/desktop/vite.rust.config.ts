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
      '@bureau/contracts/format': path.resolve(root, '../../packages/contracts/src/format.ts'),
      '@bureau/contracts/chat': path.resolve(root, '../../packages/contracts/src/chat.ts'),
      '@bureau/contracts': path.resolve(root, '../../packages/contracts/src/index.ts'),
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
    // The 3D viewport (three.js) is about 500 kB on its own; nothing else reaches that.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // The heavy libraries behind lazily loaded views get stable chunks of their own, so a
        // change to a view does not rebuild them and they never join the entry chunk.
        manualChunks(id) {
          // Library stylesheets stay with the entry (see main.tsx) to keep the cascade order.
          if (!id.includes('/node_modules/') || id.endsWith('.css')) return undefined;
          if (id.includes('/node_modules/three/')) return 'three';
          if (id.includes('/node_modules/@xterm/')) return 'xterm';
          if (id.includes('/node_modules/marked/') || id.includes('/node_modules/dompurify/'))
            return 'markdown';
          return undefined;
        },
      },
    },
  },
});
