import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
// Type-only, so it is checked by `tsc` (which resolves the subpath through the
// package's export map) and erased before the test runs.
import type * as FormatEntry from '@omenflow/contracts/format';
import * as barrel from './index.js';
import { formatQty, isUnknown, originLabel } from './format.js';

const formatFile = fileURLToPath(new URL('./format.ts', import.meta.url));

describe('formatting helpers', () => {
  it('formats a quantity with its unit and four significant digits', () => {
    expect(formatQty({ value: 0.41234, unit: 'kg' })).toBe('0.4123 kg');
    expect(formatQty({ value: 5, unit: 'V', min: 4.5, max: 5.5 })).toBe('5 [4.5–5.5] V');
  });

  it('keeps an unknown value unknown, with its reason', () => {
    expect(formatQty({ unknown: true, reason: 'not on the datasheet' })).toBe(
      'unknown (not on the datasheet)',
    );
    expect(formatQty(null)).toBe('unknown');
    expect(formatQty(undefined)).toBe('unknown');
    expect(isUnknown({ unknown: true, reason: 'x' })).toBe(true);
    expect(isUnknown(null)).toBe(true);
    expect(isUnknown({ value: 0, unit: 'g' })).toBe(false);
  });

  it('labels an origin', () => {
    expect(originLabel({ kind: 'user' })).toBe('user');
    expect(originLabel({ kind: 'agent', sessionId: '12345678-0000-4000-8000-000000000000' })).toBe(
      'agent:12345678',
    );
  });
});

describe('@omenflow/contracts/format entry point', () => {
  it('has no runtime imports, so it never pulls in zod or the registry', () => {
    const source = ts.createSourceFile(
      formatFile,
      fs.readFileSync(formatFile, 'utf8'),
      ts.ScriptTarget.ES2022,
    );
    const runtimeImports = source.statements.filter(
      (statement) =>
        (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) ||
        (ts.isExportDeclaration(statement) && !!statement.moduleSpecifier),
    );
    expect(runtimeImports.map((statement) => statement.getText(source))).toEqual([]);
    expect(source.text).not.toMatch(/\bimport\(|\brequire\(/);
  });

  it('is resolved by Node through the package export map and loads on its own', async () => {
    const resolved = createRequire(import.meta.url).resolve('@omenflow/contracts/format');
    expect(fs.realpathSync(resolved)).toBe(fs.realpathSync(formatFile));
    const entry = (await import(/* @vite-ignore */ resolved)) as typeof FormatEntry;
    expect(Object.keys(entry).sort()).toEqual(['formatQty', 'isUnknown', 'originLabel']);
    expect(entry.formatQty({ value: 300, unit: 'g' })).toBe('300 g');
  });

  it('is resolved by TypeScript from the renderer project', () => {
    const configFile = fileURLToPath(
      new URL('../../../apps/desktop/tsconfig.json', import.meta.url),
    );
    const config = ts.getParsedCommandLineOfConfigFile(configFile, undefined, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    })!;
    const importer = fileURLToPath(
      new URL('../../../apps/desktop/src/renderer/main.tsx', import.meta.url),
    );
    const resolve = (specifier: string) =>
      ts.resolveModuleName(specifier, importer, config.options, ts.sys).resolvedModule
        ?.resolvedFileName;
    expect(fs.realpathSync(resolve('@omenflow/contracts/format')!)).toBe(
      fs.realpathSync(formatFile),
    );
    expect(resolve('@omenflow/contracts')).toMatch(/packages\/contracts\/src\/index\.ts$/);
  });

  it('stays available from the package root for existing callers', () => {
    expect(barrel.formatQty).toBe(formatQty);
    expect(barrel.isUnknown).toBe(isUnknown);
    expect(barrel.originLabel).toBe(originLabel);
  });
});
