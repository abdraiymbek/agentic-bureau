import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/** A rebuilt release asset replaces its old checksum; other architectures stay intact. */
export function mergeChecksums(existing, replacements) {
  const entries = new Map();
  for (const source of [existing, replacements]) {
    for (const line of source.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const match = /^([a-f\d]{64}) [ *](.+)$/i.exec(line);
      if (!match) throw new Error('Invalid SHA256SUMS entry');
      entries.set(match[2].replace(/^\.\//, ''), match[1].toLowerCase());
    }
  }
  return [...entries]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, hash]) => `${hash}  ${name}\n`)
    .join('');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [existing, replacements, destination] = process.argv.slice(2);
  if (!existing || !replacements || !destination)
    throw new Error('Usage: merge-checksums.mjs EXISTING NEW OUTPUT');
  fs.writeFileSync(
    destination,
    mergeChecksums(fs.readFileSync(existing, 'utf8'), fs.readFileSync(replacements, 'utf8')),
  );
}
