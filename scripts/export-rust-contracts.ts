/**
 * Operation manifest for the Rust crates, generated from the TypeScript
 * contracts. Build-time only.
 *
 *   pnpm contracts:export   write crates/contracts/registry.json
 *   pnpm contracts:check    fail when that file differs from a fresh export
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRegistry,
  capabilityProfiles,
  serializeRegistry,
  toolListing,
} from '@bureau/contracts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'crates', 'contracts', 'registry.json');
const relative = path.relative(root, output);
const manifest = buildRegistry();
const fresh = serializeRegistry(manifest);

if (process.argv.includes('--check')) {
  const current = fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : null;
  if (current !== fresh) {
    console.error(
      `${relative} is ${current === null ? 'missing' : 'out of date'}. Run \`pnpm contracts:export\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log(`${relative} matches the TypeScript contracts`);
} else {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, fresh);
  console.log(`${manifest.operations.length} operation contracts → ${relative}`);
  for (const profile of capabilityProfiles) {
    const listing = toolListing(profile, manifest);
    console.log(
      `  ${profile}: ${listing.length} tools, ${JSON.stringify(listing).length} characters listed`,
    );
  }
}
