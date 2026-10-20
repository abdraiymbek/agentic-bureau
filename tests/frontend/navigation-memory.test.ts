import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import type { View } from '../../apps/desktop/src/renderer/store';
import type { ProjectEvent, Revision } from '@omenflow/contracts';
import {
  pushHistory,
  sameView,
  stepBack,
  stepForward,
  zoomOutTarget,
  HISTORY_LIMIT,
} from '../../apps/desktop/src/renderer/lib/navigation';
import {
  EMPTY_WINDOW,
  insertEvent,
  mergeTail,
  olderMayExist,
  prependOlder,
} from '../../apps/desktop/src/renderer/lib/event-window';
import {
  clearViewMemory,
  hasSavedScroll,
  recordScroll,
  rememberViewState,
  restoreScroll,
  scrollPath,
  useViewState,
  viewKey,
} from '../../apps/desktop/src/renderer/lib/view-memory';
import {
  failureSentence,
  loadFailure,
  RECORD,
} from '../../apps/desktop/src/renderer/frame/load-copy';
import { IDLE_LOAD } from '../../apps/desktop/src/renderer/lib/sync';
import { lazyView } from '../../apps/desktop/src/renderer/lib/lazy-view';
import {
  parseProjectPrefs,
  serializeProjectPrefs,
} from '../../apps/desktop/src/renderer/lib/preferences';
import { resolveDisplayedRevision } from '../../apps/desktop/src/renderer/lib/mechanical-revisions';

const flow: View = { level: 'project', lens: 'flow' };
const parts: View = { level: 'project', lens: 'parts' };
const obj = (id: string): View => ({ level: 'object', id });

describe('history', () => {
  it('compares views by place', () => {
    expect(sameView(obj('a'), obj('a'))).toBe(true);
    expect(sameView(obj('a'), obj('b'))).toBe(false);
    expect(sameView(flow, parts)).toBe(false);
    expect(sameView({ level: 'agent' }, { level: 'agent' })).toBe(true);
    expect(sameView(obj('a'), { level: 'object', id: 'a', revisionId: 'r3' })).toBe(false);
  });

  it('walks back and forward and clears forward on a new move', () => {
    let h = pushHistory({ back: [], forward: [] }, flow);
    h = pushHistory(h, parts);
    const back = stepBack(h, obj('a'))!;
    expect(back.view).toEqual(parts);
    expect(back.forward).toEqual([obj('a')]);
    const forward = stepForward(back, back.view)!;
    expect(forward.view).toEqual(obj('a'));
    expect(forward.back).toEqual([flow, parts]);
    expect(pushHistory(back, back.view).forward).toEqual([]);
    expect(stepBack({ back: [], forward: [] }, flow)).toBeNull();
    expect(stepForward({ back: [], forward: [] }, flow)).toBeNull();
  });

  it('returns to the exact content-search revision after another object and a lens', () => {
    const matched: View = { level: 'object', id: 'a', revisionId: 'a-r2' };
    const history = pushHistory(
      pushHistory(pushHistory({ back: [], forward: [] }, flow), matched),
      obj('b'),
    );
    const otherObject = stepBack(history, parts)!;
    expect(otherObject.view).toEqual(obj('b'));
    const returned = stepBack(otherObject, otherObject.view)!;
    expect(returned.view).toEqual(matched);

    // A newer draft may arrive while the search result is away; Back must still show its hit.
    const revisions = [
      { id: 'a-r1', seq: 1, parentId: null, reviewState: 'approved' },
      { id: 'a-r2', seq: 2, parentId: 'a-r1', reviewState: 'draft' },
      { id: 'a-r3', seq: 3, parentId: 'a-r2', reviewState: 'draft' },
    ] as Revision[];
    if (returned.view.level !== 'object' || !returned.view.revisionId)
      throw new Error('The content-search revision was lost from history');
    expect(
      resolveDisplayedRevision(revisions, 'a-r1', {
        kind: 'revision',
        id: returned.view.revisionId,
      }).revision?.id,
    ).toBe('a-r2');
    const forward = stepForward(returned, returned.view)!;
    expect(forward.view).toEqual(obj('b'));
    expect(stepBack(forward, forward.view)!.view).toEqual(matched);

    const reopened = parseProjectPrefs(
      serializeProjectPrefs({ view: matched, lens: 'parts', agentWindowOpen: false }),
      (id) => id === 'parts',
    );
    expect(reopened.view).toEqual(matched);
  });

  it('preserves baseline-following null separately from latest work and pinned revisions', () => {
    const baseline: View = { level: 'object', id: 'a', revisionId: null };
    const saved = parseProjectPrefs(
      serializeProjectPrefs({ view: baseline, lens: 'parts', agentWindowOpen: false }),
      (id) => id === 'parts',
    );
    expect(saved.view).toEqual(baseline);
    expect(sameView(baseline, obj('a'))).toBe(false);
    expect(sameView(baseline, { level: 'object', id: 'a', revisionId: 'a-r1' })).toBe(false);
    const back = stepBack(pushHistory({ back: [], forward: [] }, baseline), parts)!;
    expect(back.view).toEqual(baseline);

    const revisions = [
      { id: 'a-r1', seq: 1, parentId: null, reviewState: 'superseded' },
      { id: 'a-r2', seq: 2, parentId: 'a-r1', reviewState: 'approved' },
      { id: 'a-r3', seq: 3, parentId: 'a-r2', reviewState: 'draft' },
    ] as Revision[];
    expect(resolveDisplayedRevision(revisions, 'a-r1', { kind: 'baseline' }).revision?.id).toBe(
      'a-r1',
    );
    expect(resolveDisplayedRevision(revisions, 'a-r2', { kind: 'baseline' }).revision?.id).toBe(
      'a-r2',
    );
    expect(resolveDisplayedRevision(revisions, 'a-r2', { kind: 'latest' }).revision?.id).toBe(
      'a-r3',
    );
    expect(
      resolveDisplayedRevision(revisions, 'a-r2', { kind: 'revision', id: 'a-r1' }).revision?.id,
    ).toBe('a-r1');
  });

  it('bounds the history', () => {
    let h = { back: [] as View[], forward: [] as View[] };
    for (let i = 0; i < 100; i++) h = pushHistory(h, obj(String(i)));
    expect(h.back).toHaveLength(HISTORY_LIMIT);
    expect(h.back.at(-1)).toEqual(obj('99'));
  });

  it('zooms out one level to where the person came from', () => {
    expect(zoomOutTarget(obj('a'), [parts], 'parts', true)).toEqual(parts);
    expect(
      zoomOutTarget({ level: 'decide', proposalId: 'p' }, [flow, obj('a')], 'flow', true),
    ).toEqual(obj('a'));
    expect(zoomOutTarget({ level: 'decide', proposalId: null }, [parts], 'parts', true)).toEqual(
      parts,
    );
    expect(zoomOutTarget(parts, [], 'parts', true)).toEqual(flow);
    expect(zoomOutTarget(flow, [], 'flow', true)).toBeNull();
    expect(zoomOutTarget({ level: 'agent' }, [obj('a')], 'flow', true)).toEqual(obj('a'));
    expect(zoomOutTarget({ level: 'system' }, [], 'flow', false)).toEqual(flow);
    expect(
      zoomOutTarget({ level: 'system' }, [obj('a'), { level: 'system' }], 'flow', true),
    ).toEqual(obj('a'));
  });
});

const ev = (seq: number): ProjectEvent =>
  ({
    seq,
    id: `e${seq}`,
    type: 'revision.committed',
    origin: 'agent',
    ts: '',
    data: {},
  }) as ProjectEvent;
const seqs = (w: { events: ProjectEvent[] }) => w.events.map((e) => e.seq);

describe('event window', () => {
  it('inserts once, in order, and ignores what is below the window', () => {
    let w = insertEvent(EMPTY_WINDOW, ev(2), 10);
    w = insertEvent(w, ev(5), 10);
    w = insertEvent(w, ev(3), 10);
    expect(seqs(w)).toEqual([2, 3, 5]);
    expect(insertEvent(w, ev(3), 10)).toBe(w);
    expect(insertEvent({ events: [], from: 7 }, ev(7), 10).events).toEqual([]);
  });

  it('caps live growth by moving the bound, never silently', () => {
    let w = EMPTY_WINDOW;
    for (let s = 1; s <= 6; s++) w = insertEvent(w, ev(s), 4);
    expect(seqs(w)).toEqual([3, 4, 5, 6]);
    expect(w.from).toBe(2);
  });

  it('keeps pages the person loaded on purpose', () => {
    let w = prependOlder({ events: [ev(5), ev(6)], from: 4 }, { events: [ev(3), ev(4)], from: 2 });
    w = insertEvent(w, ev(7), 2);
    expect(seqs(w)).toEqual([3, 4, 5, 6, 7]);
    expect(w.from).toBe(2);
  });

  it('joins a tail that touches what is held and replaces one beyond a gap', () => {
    const held = { events: [ev(1), ev(2), ev(3)], from: 0 };
    expect(seqs(mergeTail(held, { events: [ev(3), ev(4)], from: 2 }, 10))).toEqual([1, 2, 3, 4]);
    expect(mergeTail(held, { events: [ev(3), ev(4)], from: 2 }, 10).from).toBe(0);
    const gap = mergeTail(held, { events: [ev(9), ev(10)], from: 8 }, 10);
    expect(seqs(gap)).toEqual([9, 10]);
    expect(gap.from).toBe(8);
  });

  it('lets the first tail set the bound when live events arrived before it', () => {
    const live = insertEvent(EMPTY_WINDOW, ev(1001), 10);
    expect(olderMayExist(live)).toBe(true);
    const tail = { events: [ev(998), ev(999), ev(1000)], from: 997 };
    const merged = mergeTail(live, tail, 10);
    expect(seqs(merged)).toEqual([998, 999, 1000, 1001]);
    expect(merged.from).toBe(997);
    expect(olderMayExist(merged)).toBe(true);
    expect(olderMayExist(mergeTail(EMPTY_WINDOW, { events: [ev(1)], from: 0 }, 10))).toBe(false);
    // Nothing is paged in below a bound that is not known yet.
    expect(prependOlder(live, { events: [ev(1)], from: 0 })).toBe(live);
  });

  it('prepends only events below the window', () => {
    const w = prependOlder(
      { events: [ev(10)], from: 9 },
      { events: [ev(8), ev(9), ev(10), ev(11)], from: 7 },
    );
    expect(seqs(w)).toEqual([8, 9, 10]);
    expect(w.from).toBe(7);
    expect(prependOlder(w, { events: [], from: 7 })).toBe(w);
  });
});

/* A minimal element tree for scroll memory: enough of Element for the functions under test. */
interface FakeEl {
  tagName: string;
  classList: string[];
  parentElement: FakeEl | null;
  children: FakeEl[];
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  clientHeight: number;
  scrollWidth: number;
  clientWidth: number;
  attrs: Record<string, string>;
}
function el(
  tag: string,
  cls: string,
  parent: FakeEl | null,
  size = { h: 100, content: 100 },
): FakeEl {
  let top = 0;
  const node: FakeEl = {
    tagName: tag.toUpperCase(),
    classList: cls ? cls.split(' ') : [],
    parentElement: parent,
    children: [],
    get scrollTop() {
      return top;
    },
    set scrollTop(v: number) {
      top = Math.max(0, Math.min(v, node.scrollHeight - node.clientHeight));
    },
    scrollLeft: 0,
    scrollHeight: size.content,
    clientHeight: size.h,
    scrollWidth: 100,
    clientWidth: 100,
    attrs: {},
  };
  parent?.children.push(node);
  return node;
}
const api = (n: FakeEl): Element => {
  const all = (x: FakeEl): FakeEl[] => x.children.flatMap((c) => [c, ...all(c)]);
  return Object.assign(n, {
    closest: (q: string) => {
      const attr = q.match(/^\[(.+)\]$/)?.[1];
      for (let x: FakeEl | null = n; x; x = x.parentElement)
        if (attr && attr in x.attrs) return api(x);
      return null;
    },
    contains: (o: FakeEl) => all(n).includes(o) || o === n,
    getAttribute: (a: string) => n.attrs[a] ?? null,
    querySelectorAll: () => all(n).map(api),
  }) as unknown as Element;
};

describe('view memory', () => {
  it('names each place once', () => {
    expect(viewKey(parts)).toBe('project:parts');
    expect(viewKey(obj('a'))).toBe('object:a');
    expect(viewKey({ level: 'decide', proposalId: null })).toBe('decide:');
    expect(viewKey({ level: 'agent' })).toBe('agent');
  });

  it('restores a scroll position once the content is tall enough', () => {
    clearViewMemory();
    const stage = el('div', 'stage-area', null);
    const page = el('div', 'project', stage);
    const lens = el('div', 'lens-page parts', page, { h: 100, content: 1000 });
    lens.scrollTop = 600;
    recordScroll('project:parts', api(lens), api(stage));
    expect(scrollPath(api(lens), api(stage))).toBe('div.project>div.lens-page');

    // The view is rebuilt; at first its content is short.
    const stage2 = el('div', 'stage-area', null);
    const page2 = el('div', 'project', stage2);
    const lens2 = el('div', 'lens-page parts', page2, { h: 100, content: 300 });
    expect(restoreScroll('project:parts', api(stage2))).toBe(1);
    expect(lens2.scrollTop).toBe(200);
    lens2.scrollHeight = 1000;
    expect(restoreScroll('project:parts', api(stage2))).toBe(0);
    expect(lens2.scrollTop).toBe(600);
    // Late content above moves it (scroll anchoring); the next frame puts it back.
    lens2.scrollTop = 640;
    expect(restoreScroll('project:parts', api(stage2))).toBe(0);
    expect(lens2.scrollTop).toBe(600);
    expect(hasSavedScroll('project:flow')).toBe(false);
    expect(restoreScroll('project:flow', api(stage2))).toBe(0);
  });

  it('prefers an explicit scroll key and forgets a region scrolled back to the top', () => {
    clearViewMemory();
    const stage = el('div', 'stage-area', null);
    const list = el('ul', 'queue', stage, { h: 100, content: 500 });
    list.attrs['data-scroll-key'] = 'decide-queue';
    expect(scrollPath(api(list), api(stage))).toBe('#decide-queue');
    list.scrollTop = 50;
    recordScroll('decide:', api(list), api(stage));
    expect(hasSavedScroll('decide:')).toBe(true);
    list.scrollTop = 0;
    recordScroll('decide:', api(list), api(stage));
    expect(hasSavedScroll('decide:')).toBe(false);
  });

  it('hands remembered view state back to the next component that asks', () => {
    clearViewMemory();
    function Picked() {
      const [picked] = useViewState<string[]>('parts:picked', []);
      return React.createElement('span', null, picked.join(','));
    }
    expect(renderToString(React.createElement(Picked))).toBe('<span></span>');
    rememberViewState('parts:picked', ['a', 'b']);
    expect(renderToString(React.createElement(Picked))).toBe('<span>a,b</span>');
    clearViewMemory();
    expect(renderToString(React.createElement(Picked))).toBe('<span></span>');
  });
});

describe('frame load copy', () => {
  const loads = (over: Partial<Record<string, typeof IDLE_LOAD>>) =>
    ({
      artifacts: IDLE_LOAD,
      graph: IDLE_LOAD,
      proposals: IDLE_LOAD,
      events: IDLE_LOAD,
      jobs: IDLE_LOAD,
      session: IDLE_LOAD,
      adapters: IDLE_LOAD,
      ...over,
    }) as Parameters<typeof loadFailure>[0];

  it('says what failed, and whether what is shown may be out of date', () => {
    const err = (loaded: boolean) => ({
      status: 'error' as const,
      error: 'Disk unavailable',
      loaded,
    });
    expect(loadFailure(loads({}))).toBeNull();
    const first = loadFailure(loads({ artifacts: err(false), graph: err(false) }))!;
    expect(failureSentence(first)).toBe('Could not load objects and links.');
    expect(first.message).toBe('Disk unavailable');
    const later = loadFailure(
      loads({ events: err(true), jobs: err(false), proposals: err(false) }),
    )!;
    expect(failureSentence(later)).toBe('Could not refresh proposals, the timeline and tool jobs.');
    // The agent surface reports its own failures.
    expect(loadFailure(loads({ session: err(false), adapters: err(false) }))).toBeNull();
    expect(loadFailure(loads({ events: err(false) }), RECORD)).toBeNull();
  });
});

describe('lazy views', () => {
  it('renders a preloaded view without passing through its fallback', async () => {
    const view = lazyView(() => Promise.resolve(() => React.createElement('b', null, 'stage')));
    const tree = () =>
      React.createElement(
        React.Suspense,
        { fallback: 'waiting' },
        React.createElement(view.Component),
      );
    // Before the chunk has arrived, the fallback shows.
    expect(renderToString(tree())).toContain('waiting');
    await view.preload();
    const html = renderToString(tree());
    expect(html).toContain('<b>stage</b>');
    expect(html).not.toContain('waiting');
  });

  it('tries again after a chunk failed to load', async () => {
    let attempt = 0;
    const view = lazyView(() =>
      ++attempt === 1
        ? Promise.reject(new Error('offline'))
        : Promise.resolve(() => React.createElement('i', null, 'loaded')),
    );
    await expect(view.preload()).rejects.toThrow('offline');
    await view.preload();
    expect(attempt).toBe(2);
  });
});
