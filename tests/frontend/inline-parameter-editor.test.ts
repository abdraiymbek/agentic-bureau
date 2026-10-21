import fs from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  parameterForm,
  parameterOverrides,
  parameterRows,
  parameterText,
} from '../../apps/desktop/src/renderer/lib/scad-params';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const generatedSource =
  '$fn = 64;\nwidth_mm = 20; // X size, mm\ndepth_mm = 15; // Y size, mm\nheight_mm = 10; // Z size, mm\n$fa = 12;\nclearance = 0.2; // mm\n';

/** Render the actual editor, including its collapsed disclosure and exact prepared attachment. */
function renderEditor(source: string, saved?: Record<string, string>) {
  const file = fs.readFileSync(
    new URL('../../apps/desktop/src/renderer/chat/InlineCards.tsx', import.meta.url),
    'utf8',
  );
  const code = ts.transpileModule(
    file
      .slice(
        file.indexOf('export function parameterInput('),
        file.indexOf('function QuantityCard('),
      )
      .replace('export function', 'function') + '\nmodule.exports = ParameterEditor;',
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.React,
      },
    },
  ).outputText;
  const rows = parameterRows(source, {}, []);
  let prepared: unknown[] | undefined;
  const module = { exports: null as unknown as (props: unknown) => React.ReactElement };
  const state = { readOnly: false, artifacts: [] };
  new Function(
    'module',
    'React',
    'useState',
    'useSaved',
    'useStore',
    'useChat',
    'parameterForm',
    'parameterOverrides',
    'parameterRows',
    'parameterText',
    'ArrowRight',
    'Button',
    'Notice',
    'openCard',
    code,
  )(
    module,
    React,
    (value: unknown) => [value, () => {}],
    (_key: string, initial: Record<string, string>) => [saved ?? initial, () => {}],
    (select: (value: typeof state) => unknown) => select(state),
    {
      getState: () => ({
        prepare: (...args: unknown[]) => {
          prepared = args;
        },
      }),
    },
    parameterForm,
    parameterOverrides,
    parameterRows,
    parameterText,
    () => null,
    'button',
    'notice',
    () => {},
  );
  const tree = module.exports({
    rows,
    view: { artifact: { id: 'artifact', title: 'Actual part' } },
    revision: { id: 'revision' },
    projectId: 'project',
    storageKey: 'project/thread/card',
  });
  const html = renderToStaticMarkup(tree);
  const click = (node: React.ReactNode): boolean => {
    if (!React.isValidElement<{ children?: React.ReactNode; onClick?: () => void }>(node))
      return false;
    if (node.type === 'button' && node.props.onClick) {
      node.props.onClick();
      return true;
    }
    return React.Children.toArray(node.props.children).some(click);
  };
  return {
    html,
    prepare: () => {
      click(tree);
      return prepared;
    },
  };
}

describe('three primary inline mechanical parameters', () => {
  it('shows width, depth and height with source units while keeping SCAD controls under More', () => {
    const { html } = renderEditor(generatedSource);
    const [primary, more] = html.split('<details');
    for (const name of ['width_mm', 'depth_mm', 'height_mm'])
      expect(primary).toContain(`aria-label="${name} (mm)"`);
    expect(primary?.match(/<input /g)).toHaveLength(3);
    expect(primary).not.toContain('$fn');
    expect(more).toContain('More parameters · 3');
    expect(more).toContain('aria-label="$fn"');
    expect(more).toContain('aria-label="$fa"');
    expect(more).toContain('aria-label="clearance (mm)"');
    expect(more).not.toMatch(/^ open/);
  });
  it('retains exact primary and hidden edits in one revision-bound prepared request', () => {
    const rows = parameterRows(generatedSource, {}, []);
    const form = { ...parameterForm(rows), width_mm: '20.0000', clearance: '0.2500', $fn: '96' };
    const result = renderEditor(generatedSource, form).prepare();
    expect(result?.[2]).toEqual({
      artifactId: 'artifact',
      revisionId: 'revision',
      title: 'Actual part',
      intent: 'render',
      fields: [
        { name: '$fn', text: '96', unit: '', unknown: false },
        { name: 'width_mm', text: '20.0000', unit: 'mm', unknown: false },
        { name: 'clearance', text: '0.2500', unit: 'mm', unknown: false },
      ],
    });
  });
});
