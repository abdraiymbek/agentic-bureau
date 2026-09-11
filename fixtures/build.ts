/**
 * Build a fixture project on disk.
 *   pnpm fixture:rover <dir>   — inspection rover reference project
 *   pnpm fixture:drone <dir>   — payload/propulsion impact fixture
 */
import path from 'node:path';
import fs from 'node:fs';
import { CoreApp, nullHost } from '@stark/core';
import { createEngineTools } from '@stark/engineering';
import { buildRoverProject } from './rover/rover.fixture.js';
import { buildDroneProject } from './drone-dependencies/drone.fixture.js';

const [fixture, dir] = process.argv.slice(2);
if (!fixture || !dir || !['rover', 'drone'].includes(fixture)) {
  console.error('usage: tsx fixtures/build.ts <rover|drone> <dir>');
  process.exit(1);
}
const abs = path.resolve(dir);
fs.mkdirSync(path.dirname(abs), { recursive: true });

async function main() {
  // App data must not live inside the project dir — project.create requires
  // an empty target folder.
  const app = new CoreApp(
    path.join(path.dirname(abs), `.stark-appdata-${path.basename(abs)}`),
    nullHost,
  );
  app.engineTools = createEngineTools();
  try {
    const refs =
      fixture === 'rover' ? await buildRoverProject(app, abs) : await buildDroneProject(app, abs);
    console.log(`built ${fixture} project at ${abs}`);
    console.log(`projectId: ${refs.projectId}`);
    console.log(
      `proposals approved: ${(refs as { proposalIds?: string[] }).proposalIds?.length ?? 0}`,
    );
  } finally {
    app.closeAll();
  }
}

void main().then(() => process.exit(0));
