/**
 * The dispatch-level corpus run against the Rust host (`pnpm test:conformance`).
 * Kept apart from `pnpm test`: it needs cargo, and builds `omenflow-host` first.
 */
import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import base from '../../vitest.config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: base.resolve,
  test: {
    root: path.resolve(here, '../..'),
    environment: 'node',
    include: ['tests/conformance/**/*.conformance.ts'],
    globalSetup: [path.join(here, 'global-setup.ts')],
    // Each case starts its own host process; keep the machine responsive.
    maxWorkers: 4,
    minWorkers: 1,
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
