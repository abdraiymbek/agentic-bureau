import { build, defineConfig, type Plugin } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name: string) => path.join(root, '..', '..', 'packages', name, 'src', 'index.ts');

/**
 * Ship the calc worker + omenflow CLI shim next to the bundle under
 * resources/core — `new URL('./calc-worker.mjs', import.meta.url)` must
 * resolve at runtime, and `omenflow` must be a real spawnable file.
 */
function copyHelpers(): Plugin {
  return {
    name: 'copy-utility-helpers',
    async writeBundle() {
      const out = path.join(root, 'resources', 'core');
      const pairs: [string, string][] = [
        [
          path.join(root, '..', '..', 'packages', 'engineering', 'src', 'calc-worker.mjs'),
          'calc-worker.mjs',
        ],
        [path.join(root, '..', '..', 'packages', 'agent-host', 'bin', 'omenflow.mjs'), 'omenflow'],
      ];
      for (const [src, name] of pairs) {
        const dest = path.join(out, name);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dest);
          fs.chmodSync(dest, 0o755);
        }
      }
      // A separate entry prevents the worker from importing utility.js (which
      // would start another bridge/core) and preserves isolation in the package.
      await build({
        configFile: false,
        resolve: { alias: { '@omenflow/contracts': pkg('contracts') } },
        ssr: { noExternal: true },
        build: {
          ssr: path.join(root, '..', '..', 'packages', 'core', 'src', 'mesh-worker.ts'),
          outDir: out,
          emptyOutDir: false,
          target: 'node20',
          sourcemap: true,
          rollupOptions: {
            output: { format: 'es', entryFileNames: 'mesh-worker.mjs', inlineDynamicImports: true },
          },
        },
      });
    },
  };
}

/**
 * The core utility process bundle → .vite/build/utility.js, forked by main.
 * SSR build keeps node builtins external and leaves Worker URLs intact.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@omenflow/contracts': pkg('contracts'),
      '@omenflow/storage': pkg('storage'),
      '@omenflow/core': pkg('core'),
      '@omenflow/agent-host': pkg('agent-host'),
      '@omenflow/mcp-server': pkg('mcp-server'),
      '@omenflow/engineering': pkg('engineering'),
    },
  },
  plugins: [copyHelpers()],
  // Bundle everything except the vendored natives (loaded from
  // resources/node_modules at runtime) and the worker's own mathjs import.
  ssr: { noExternal: true },
  build: {
    ssr: 'src/utility/index.ts',
    outDir: 'resources/core',
    emptyOutDir: false,
    target: 'node20',
    sourcemap: true,
    rollupOptions: {
      output: {
        format: 'cjs',
        entryFileNames: 'utility.js',
        inlineDynamicImports: true,
      },
      external: ['better-sqlite3', 'node-pty', 'mathjs', 'electron', /^ajv/],
    },
  },
});
