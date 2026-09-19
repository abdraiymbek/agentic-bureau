import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Omen Flow',
    executableName: 'omenflow-desktop',
    asar: {
      // Runtime deps are vendored under resources/ and must stay real files
      // (utilityProcess.fork + worker spawn + native .node loads).
      unpack: '**/*.{node,dylib,so,dll}',
      unpackDir: 'resources',
    },
    ignore: (path) => {
      if (!path) return false;
      if (path.startsWith('/.vite')) return false;
      if (path.startsWith('/resources')) return false;
      if (path === '/package.json') return false;
      return true;
    },
    osxSign: {},
    // osxNotarize: filled in CI via env when credentials exist.
  },
  rebuildConfig: {
    onlyModules: ['better-sqlite3', 'node-pty'],
  },
  makers: [
    new MakerZIP({}, ['darwin', 'linux', 'win32']),
    new MakerDMG(
      {
        name: 'Omen Flow',
        title: 'Omen Flow',
        overwrite: true,
      },
      ['darwin'],
    ),
    new MakerSquirrel(
      {
        name: 'OmenFlow',
        authors: 'Omen Flow contributors',
        description: 'Local desktop engineering workspace',
      },
      ['win32'],
    ),
    new MakerDeb({}, ['linux']),
    new MakerRpm({}, ['linux']),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/main.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
  ],
  hooks: {
    // Utility bundle via our own vite build; Electron-ABI natives vendored
    // into resources/node_modules (pnpm symlinks don't survive pruning).
    async prePackage() {
      execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['run', 'build:utility'], {
        cwd: __dirname,
        stdio: 'inherit',
      });
      execFileSync(process.execPath, [path.join(__dirname, 'scripts', 'vendor-natives.mjs')], {
        cwd: __dirname,
        stdio: 'inherit',
      });
    },
    // Forge's "Preparing native dependencies" step rebuilds the pnpm-store
    // copies of better-sqlite3/node-pty against the Electron ABI, which breaks
    // vitest (plain Node). Restore the workspace copies to Node ABI.
    async postPackage() {
      const root = path.join(__dirname, '..', '..');
      execFileSync(process.execPath, [path.join(root, 'scripts', 'rebuild-natives.mjs'), 'node'], {
        cwd: root,
        stdio: 'inherit',
      });
    },
  },
};

export default config;
