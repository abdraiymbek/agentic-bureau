#!/usr/bin/env node
/**
 * Writes THIRD_PARTY_NOTICES.md: every third-party component that ships inside the app.
 *
 * - Rust crates linked into the desktop app (all platforms) and the `omenflow` helper, from
 *   `cargo metadata` (normal dependencies; build scripts and proc macros run at build time
 *   only and are not shipped).
 * - JavaScript packages bundled into the interface: the closure of the packages the renderer
 *   imports, following each package's runtime `dependencies`.
 * - The vendored fonts.
 *
 * For each component it records the licence, the source and the copyright lines of its own
 * licence files, then appends the text of each licence once.
 * Usage: node scripts/third-party-notices.mjs [--check]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'THIRD_PARTY_NOTICES.md');

function metadata(manifest) {
  const json = execFileSync(
    'cargo',
    ['metadata', '--format-version', '1', '--locked', '--manifest-path', manifest],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  return JSON.parse(json);
}

/** Packages reachable from `rootName` through normal (non-build, non-dev) edges, any target. */
function shippedCrates(meta, rootName) {
  const nodes = new Map(meta.resolve.nodes.map((node) => [node.id, node]));
  const packages = new Map(meta.packages.map((pkg) => [pkg.id, pkg]));
  const start = meta.packages.find((pkg) => pkg.name === rootName);
  if (!start) throw new Error(`No package ${rootName} in ${meta.workspace_root}`);
  const seen = new Set();
  const queue = [start.id];
  while (queue.length) {
    const id = queue.pop();
    if (seen.has(id)) continue;
    const pkg = packages.get(id);
    // Procedural macros run inside the compiler; nothing of them is linked.
    if (id !== start.id && pkg.targets.every((target) => target.kind.includes('proc-macro')))
      continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (dep.dep_kinds.some((kind) => kind.kind === null)) queue.push(dep.pkg);
    }
  }
  return [...seen]
    .map((id) => packages.get(id))
    .filter((pkg) => pkg.source !== null)
    .map((pkg) => ({
      ecosystem: 'Rust crate',
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? (pkg.license_file ? `see ${pkg.license_file}` : 'unspecified'),
      source: pkg.repository ?? `https://crates.io/crates/${pkg.name}`,
      dir: path.dirname(pkg.manifest_path),
    }));
}

/** Bare package names imported by the renderer (type-only imports excluded). */
function rendererImports() {
  const dir = path.join(root, 'apps/desktop/src/renderer');
  const names = new Set();
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const file = path.join(current, entry);
      if (statSync(file).isDirectory()) walk(file);
      else if (/\.(ts|tsx)$/.test(entry)) {
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(
          /^\s*(import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'".][^'"]*)['"]|^\s*import\s+['"]([^'".][^'"]*)['"]|import\(\s*['"]([^'".][^'"]*)['"]\s*\)/gm,
        )) {
          const spec = match[2] ?? match[3] ?? match[4];
          const parts = spec.split('/');
          names.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
        }
      }
    }
  };
  walk(dir);
  for (const name of [...names])
    if (name.startsWith('@omenflow/') || name === 'react/jsx-runtime') names.delete(name);
  return names;
}

function packageDir(name, fromDir) {
  const require = createRequire(path.join(fromDir, 'package.json'));
  try {
    return path.dirname(require.resolve(`${name}/package.json`));
  } catch {
    let current = path.dirname(require.resolve(name));
    while (current !== path.dirname(current)) {
      const manifest = path.join(current, 'package.json');
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name)
        return current;
      current = path.dirname(current);
    }
    throw new Error(`Cannot locate ${name} from ${fromDir}`);
  }
}

function bundledPackages() {
  const desktop = path.join(root, 'apps/desktop');
  const found = new Map();
  const queue = [...rendererImports()].map((name) => [name, desktop]);
  while (queue.length) {
    const [name, from] = queue.pop();
    const dir = packageDir(name, from);
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const key = `${manifest.name}@${manifest.version}`;
    if (found.has(key)) continue;
    const repository =
      typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
    found.set(key, {
      ecosystem: 'npm package',
      name: manifest.name,
      version: manifest.version,
      license:
        typeof manifest.license === 'string'
          ? manifest.license
          : (manifest.license?.type ?? 'unspecified'),
      source: (repository ?? `https://www.npmjs.com/package/${manifest.name}`)
        .replace(/^git\+/, '')
        .replace(/\.git$/, ''),
      dir,
    });
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      queue.push([dependency, dir]);
  }
  return [...found.values()];
}

const FONTS = [
  {
    ecosystem: 'font',
    name: 'Geist and Geist Mono',
    version: 'vendored',
    license: 'OFL-1.1',
    source: 'https://github.com/vercel/geist-font',
    licenseFile: 'design-system/fonts/geist-LICENSE.txt',
  },
  {
    ecosystem: 'font',
    name: 'IBM Plex Mono',
    version: 'vendored',
    license: 'OFL-1.1',
    source: 'https://github.com/IBM/plex',
    licenseFile: 'design-system/fonts/ibm-plex-mono-LICENSE.txt',
  },
];

/** Copyright lines from a component's own licence and notice files. */
function copyrights(dir) {
  if (!dir || !existsSync(dir)) return [];
  const files = readdirSync(dir).filter((entry) =>
    /^(licen[cs]e|copying|notice|copyright)/i.test(entry),
  );
  const lines = new Set();
  for (const file of files) {
    const full = path.join(dir, file);
    if (!statSync(full).isFile()) continue;
    for (const line of readFileSync(full, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim().replace(/\s+/g, ' ');
      // "Copyright …" or "(c) 2020 …"; not licence prose such as "(c) You must retain …".
      const statement =
        /^copyright\b/i.test(trimmed) &&
        !/^copyright\s+(notice|owner|holder|license|licence|statement|assignment|and|the|to|of|law|laws)\b/i.test(
          trimmed,
        );
      const dated = /^(\(c\)|©)\s*\d{4}/i.test(trimmed);
      if ((statement || dated) && !/\[yyyy\]|<year>|\{yyyy\}|\[year\]/i.test(trimmed))
        lines.add(trimmed);
    }
  }
  return [...lines].slice(0, 6);
}

const LICENSE_TEXTS = {
  MIT: `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`,
  'Apache-2.0':
    'The full text is the LICENSE file at the root of this repository and in each release.',
  'BSD-2-Clause': `Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
  'BSD-3-Clause': `Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
  ISC: `Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`,
  Zlib: `This software is provided 'as-is', without any express or implied warranty. In no event will the authors be held liable for any damages arising from the use of this software.

Permission is granted to anyone to use this software for any purpose, including commercial applications, and to alter it and redistribute it freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim that you wrote the original software. If you use this software in a product, an acknowledgment in the product documentation would be appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.`,
  '0BSD': `Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`,
  'MPL-2.0':
    'Mozilla Public License 2.0: https://www.mozilla.org/en-US/MPL/2.0/. The components under this licence are used unmodified; their source is available at the locations listed above.',
  'Unicode-3.0': 'Unicode License v3: https://www.unicode.org/license.txt',
  'OFL-1.1':
    'SIL Open Font License 1.1: the full text, with each font\'s copyright, is in design-system/fonts/ in the source repository and reproduced under "Fonts" below.',
  Unlicense: 'The Unlicense: https://unlicense.org/',
  'CC0-1.0':
    'Creative Commons Zero v1.0 Universal: https://creativecommons.org/publicdomain/zero/1.0/',
  'MIT-0': 'MIT No Attribution: https://spdx.org/licenses/MIT-0.html',
  'BSL-1.0': 'Boost Software License 1.0: https://www.boost.org/LICENSE_1_0.txt',
  'LLVM-exception':
    'Apache-2.0 with the LLVM exception: https://spdx.org/licenses/LLVM-exception.html',
};

/** Permissive choices, most preferred first, for components offered under alternatives. */
const PREFERENCE = [
  'MIT',
  'Apache-2.0',
  'BSD-3-Clause',
  'BSD-2-Clause',
  'ISC',
  'Zlib',
  '0BSD',
  'MIT-0',
  'Unlicense',
  'CC0-1.0',
  'BSL-1.0',
  'Unicode-3.0',
  'MPL-2.0',
];

/**
 * The licences this distribution relies on for one SPDX expression: every part joined by AND,
 * and for each set of alternatives (OR, or the older `/`) the most permissive option.
 */
function licenceIds(expression) {
  const ids = (part) =>
    (part.match(/[A-Za-z0-9.+-]+/g) ?? []).filter((id) => !['OR', 'AND', 'WITH'].includes(id));
  const rank = (alternative) => {
    const parts = ids(alternative);
    if (!parts.every((id) => id in LICENSE_TEXTS)) return Infinity;
    return Math.max(
      ...parts.map((id) => (PREFERENCE.includes(id) ? PREFERENCE.indexOf(id) : PREFERENCE.length)),
    );
  };
  return expression
    .replace(/\//g, ' OR ')
    .replace(/[()]/g, ' ')
    .split(/\s+AND\s+/)
    .flatMap((group) => {
      const alternatives = group.split(/\s+OR\s+/);
      const best = alternatives.reduce((a, b) => (rank(b) < rank(a) ? b : a));
      return ids(best);
    });
}

function render(components) {
  const rows = components
    .slice()
    .sort(
      (a, b) =>
        a.ecosystem.localeCompare(b.ecosystem) ||
        a.name.localeCompare(b.name) ||
        a.version.localeCompare(b.version),
    );
  const used = new Set(rows.flatMap((row) => licenceIds(row.license)));
  const unknown = [...used].filter((id) => !(id in LICENSE_TEXTS));
  if (unknown.length) throw new Error(`No licence text recorded for: ${unknown.join(', ')}`);
  const lines = [
    '# Third-party notices',
    '',
    'Omen Flow is licensed under the Apache License 2.0 (see LICENSE and NOTICE). The desktop app,',
    'its bundled `omenflow` helper and its interface include the third-party components below, each',
    'under its own licence. Generated by `node scripts/third-party-notices.mjs` from the lockfiles;',
    'build tools and test-only dependencies are not shipped and are not listed. OpenSCAD and agent',
    'CLIs are installed separately by the user and are not part of this distribution.',
    '',
  ];
  for (const ecosystem of ['Rust crate', 'npm package', 'font']) {
    const group = rows.filter((row) => row.ecosystem === ecosystem);
    lines.push(
      `## ${ecosystem === 'font' ? 'Fonts' : ecosystem === 'npm package' ? 'JavaScript packages (interface)' : 'Rust crates (app and helper)'}`,
      '',
    );
    lines.push(`${group.length} components.`, '');
    for (const row of group) {
      lines.push(
        `- **${row.name}** ${row.version === 'vendored' ? '' : row.version} — ${row.license} — ${row.source}`.replace(
          '  —',
          ' —',
        ),
      );
      for (const line of copyrights(row.dir)) lines.push(`  - ${line}`);
      if (row.licenseFile) {
        lines.push(
          '',
          '```text',
          readFileSync(path.join(root, row.licenseFile), 'utf8').trim(),
          '```',
          '',
        );
      }
    }
    lines.push('');
  }
  lines.push('## Licence texts', '');
  for (const id of [...used].sort()) lines.push(`### ${id}`, '', LICENSE_TEXTS[id], '');
  return (
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  );
}

const workspace = metadata(path.join(root, 'Cargo.toml'));
const bridge = metadata(path.join(root, 'native/omenflow-bridge/Cargo.toml'));
const crates = new Map();
for (const crate of [
  ...shippedCrates(workspace, 'omenflow-rust-desktop'),
  ...shippedCrates(bridge, 'omenflow-bridge'),
])
  crates.set(`${crate.name}@${crate.version}`, crate);
const text = render([...crates.values(), ...bundledPackages(), ...FONTS]);
if (process.argv.includes('--check')) {
  const current = existsSync(output) ? readFileSync(output, 'utf8') : '';
  if (current !== text) {
    console.error(
      'THIRD_PARTY_NOTICES.md is out of date: run node scripts/third-party-notices.mjs',
    );
    process.exit(1);
  }
  console.log('THIRD_PARTY_NOTICES.md is current');
} else {
  writeFileSync(output, text);
  console.log(`Wrote ${path.relative(root, output)}`);
}
