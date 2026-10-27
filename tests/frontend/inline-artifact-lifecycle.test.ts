import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { Revision } from '@bureau/contracts';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const React = require('react');

/** Exercise the actual component's effect/state lifecycle without a browser or a mesh mock. */
function cardHarness() {
  const source = fs.readFileSync(
    new URL('../../apps/desktop/src/renderer/chat/InlineCards.tsx', import.meta.url),
    'utf8',
  );
  const code = ts.transpileModule(
    source.slice(source.indexOf('function ArtifactCard('), source.indexOf('function RecordBody(')) +
      '\nmodule.exports = ArtifactCard;',
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.React,
      },
    },
  ).outputText;
  const artifact = {
    id: 'part',
    type: 'mechanical',
    title: 'Exact part',
    selectedRevisionId: null,
  };
  let revision = {
    id: 'pinned',
    artifactId: 'part',
    seq: 4,
    reviewState: 'draft',
    files: [],
    payload: { params: { width: 64.0001 } },
  } as unknown as Revision;
  let answer = { view: { artifact, head: revision, freshness: 'current' }, revision };
  const state = {
    projectId: 'project',
    artifacts: [answer.view],
    baselineVersion: 0,
    evidenceVersions: {} as Record<string, number>,
  };
  const values: unknown[] = [],
    dependencies: unknown[][] = [];
  let cursor = 0;
  const effects: (() => unknown)[] = [];
  const reads: { artifactId: string; revisionId: string }[] = [];
  let fail = false;
  const useState = (initial: unknown) => {
    const at = cursor++;
    if (!(at in values)) values[at] = typeof initial === 'function' ? initial() : initial;
    return [
      values[at],
      (next: unknown) => {
        values[at] = typeof next === 'function' ? next(values[at]) : next;
      },
    ];
  };
  const useEffect = (effect: () => unknown, deps: unknown[]) => {
    const at = cursor++;
    if (!dependencies[at] || deps.some((dep, i) => !Object.is(dep, dependencies[at]![i]))) {
      dependencies[at] = deps;
      effects.push(effect);
    }
  };
  const module = { exports: null as unknown as (props: unknown) => unknown };
  new Function(
    'module',
    'React',
    'useState',
    'useEffect',
    'useStore',
    'cmd',
    'errMsg',
    'Notice',
    'Button',
    'Spinner',
    'TypeGlyph',
    'State',
    'RecordBody',
    'MechanicalCard',
    code,
  )(
    module,
    React,
    useState,
    useEffect,
    (select: (value: typeof state) => unknown) => select(state),
    (_op: string, params: (typeof reads)[number]) => {
      reads.push(params);
      return fail ? Promise.reject(new Error('offline')) : Promise.resolve(answer);
    },
    String,
    'notice',
    'button',
    'spinner',
    'glyph',
    'record-state',
    'record-body',
    'mechanical-card',
  );
  const render = () => {
    cursor = 0;
    return module.exports({
      projectId: 'project',
      artifactId: 'part',
      revisionId: 'pinned',
      storageKey: 'project/thread/card',
    });
  };
  const settle = async () => {
    effects.splice(0).forEach((effect) => effect());
    await Promise.resolve();
    return render();
  };
  type Node = {
    type: unknown;
    props: { children?: unknown; state?: string; revision: Revision; storageKey?: string };
  };
  const find = (tree: unknown, type: string): Node | null => {
    if (!tree || typeof tree !== 'object') return null;
    if (Array.isArray(tree)) return tree.map((node) => find(node, type)).find(Boolean) ?? null;
    const node = tree as Node;
    return node.type === type ? node : find(node.props?.children, type);
  };
  return {
    render,
    settle,
    find,
    reads,
    state,
    approve() {
      revision = { ...revision, reviewState: 'approved' };
      answer = {
        view: {
          ...answer.view,
          artifact: { ...artifact, selectedRevisionId: 'pinned' },
          head: revision,
        },
        revision,
      };
      state.artifacts = [answer.view] as unknown as typeof state.artifacts;
      state.baselineVersion++;
    },
    evidence() {
      state.evidenceVersions = { part: 1 };
    },
    fail() {
      fail = true;
    },
  };
}

describe('inline exact revision metadata lifecycle', () => {
  it('rereads approval metadata while preserving pinned geometry and editor draft identity', async () => {
    const h = cardHarness();
    h.render();
    const initial = await h.settle();
    expect(h.find(initial, 'record-state')!.props.state).toBe('draft');
    const before = h.find(initial, 'mechanical-card')!;
    h.approve();
    h.render();
    const approved = await h.settle();
    expect(h.find(approved, 'record-state')!.props.state).toBe('approved');
    const after = h.find(approved, 'mechanical-card')!;
    expect(after.props.revision.id).toBe(before.props.revision.id);
    expect(after.props.storageKey).toBe(before.props.storageKey);
    expect(after.props.revision.payload).toBe(before.props.revision.payload);
    expect(h.reads).toHaveLength(2);
    expect(h.reads.every((read) => read.revisionId === 'pinned')).toBe(true);
  });
  it('refreshes changed evidence and retains the existing editor when refresh fails', async () => {
    const h = cardHarness();
    h.render();
    await h.settle();
    h.evidence();
    h.fail();
    h.render();
    const retained = await h.settle();
    expect(h.find(retained, 'mechanical-card')!.props.storageKey).toBe('project/thread/card');
    expect(h.find(retained, 'notice')!.props.children).toContain(
      'Current revision state could not be refreshed: ',
    );
    expect(h.reads).toHaveLength(2);
  });
});
