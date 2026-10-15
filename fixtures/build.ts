/**
 * Build a fixture project on disk with the Rust host.
 *   pnpm fixture:rover <dir>   — inspection rover reference project
 *   pnpm fixture:drone <dir>   — payload/propulsion impact fixture
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { buildHost, RustCore } from '../tests/conformance/rust-core';
import { buildRoverProject } from './rover/rover.fixture';
import { buildDroneProject } from './drone-dependencies/drone.fixture';

const [fixture, dir] = process.argv.slice(2);
if (!fixture || !dir || !['rover', 'drone'].includes(fixture)) {
  console.error('usage: tsx fixtures/build.ts <rover|drone> <dir>');
  process.exit(1);
}
const abs = path.resolve(dir);
fs.mkdirSync(path.dirname(abs), { recursive: true });

async function main() {
  // The host's own state (settings, bridge socket) is only needed while the
  // project is built. It lives in a short temporary path because a socket path
  // has a system length limit, and never inside the project folder, which
  // project.create requires to be empty.
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'omf-'));
  const app = await RustCore.start(appData, { binary: buildHost() });
  try {
    const refs =
      fixture === 'rover' ? await buildRoverProject(app, abs) : await buildDroneProject(app, abs);
    console.log(`built ${fixture} project at ${abs}`);
    console.log(`projectId: ${refs.projectId}`);
    console.log(
      `proposals approved: ${(refs as { proposalIds?: string[] }).proposalIds?.length ?? 0}`,
    );
  } finally {
    await app.shutdown();
    fs.rmSync(appData, { recursive: true, force: true });
  }
}

void main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
