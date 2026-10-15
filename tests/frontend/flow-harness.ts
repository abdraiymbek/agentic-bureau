/**
 * Load harness for the flow map. It is not part of the app and no test imports it.
 *
 * With `pnpm design:preview` running and a project open on the Flow lens, load it from the
 * browser console and replace the project in memory with a synthetic one:
 *
 *   const h = await import('/@fs/<repo>/tests/frontend/flow-harness.ts');
 *   await h.loadSynthetic(300, 600);
 *   await h.measureHover();
 *   await h.measurePan();
 *
 * Nothing is written to the project: reload the page to get the real one back.
 */
import { useStore } from '../../apps/desktop/src/renderer/store';
import { remember } from '../../apps/desktop/src/renderer/project/flow/memory';
import { syntheticGraph } from './flow-fixtures';

/** The next frame, or 50 ms later when the page is hidden and gets no frames. */
const frame = () =>
  new Promise<number>((resolve) => {
    const timer = setTimeout(() => resolve(performance.now()), 50);
    requestAnimationFrame((at) => {
      clearTimeout(timer);
      resolve(at);
    });
  });

/** Replaces the open project's objects and links, in memory only, and remounts the map. */
export async function loadSynthetic(
  nodes = 300,
  links = 600,
  options: { seed?: number; expanded?: boolean } = {},
) {
  const store = useStore.getState();
  if (!store.projectId) throw new Error('Open a project first');
  const { artifacts, edges } = syntheticGraph(nodes, links, options.seed ?? 5);
  const types = [...new Set(artifacts.map((v) => v.artifact.type))];
  // Large groups start collapsed; measuring the worst case means opening every one.
  remember(store.projectId, {
    viewport: null,
    groups: options.expanded === false ? {} : Object.fromEntries(types.map((t) => [t, false])),
  });
  // Leaving the lens for a frame unmounts the map, so it starts again from what was remembered.
  store.go({ level: 'project', lens: 'parts' });
  await frame();
  store.set({ artifacts, edges, stale: {}, proposals: [], suggestions: [] });
  store.go({ level: 'project', lens: 'flow' });
  await frame();
  return { nodes: artifacts.length, links: edges.length };
}

function summary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    samples: sorted.length,
    mean: round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    median: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted[sorted.length - 1]!),
  };
}

/**
 * Hovers every node in turn, twice. The first pass times each hover: `script` is the pointer
 * handler, `style` the style recalculation it leaves behind and `layout` any layout after that.
 * The second pass counts what changed in the map, by kind: a hover should only write thread
 * attributes. The passes are separate because observing mutations slows the writes it records.
 */
export async function measureHover() {
  const root = document.querySelector<HTMLElement>('.map');
  if (!root) throw new Error('The flow map is not on screen');
  const nodes = [...root.querySelectorAll<HTMLElement>('.map-world [data-node]')];
  const hover = (el: HTMLElement) =>
    el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
  const leave = () => root.dispatchEvent(new PointerEvent('pointerleave'));

  const script: number[] = [];
  const style: number[] = [];
  const layout: number[] = [];
  const thread: number[] = [];
  for (const [i, el] of nodes.entries()) {
    const started = performance.now();
    hover(el);
    const handled = performance.now();
    void getComputedStyle(el).opacity;
    const styled = performance.now();
    void el.offsetWidth;
    script.push(handled - started);
    style.push(styled - handled);
    layout.push(performance.now() - styled);
    thread.push(root.querySelectorAll('[data-thread], [data-lit]').length);
    if (i % 20 === 19) await frame();
  }
  leave();
  await frame();

  const mutations: Record<string, number> = {};
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      const kind = r.type === 'attributes' ? `attribute ${r.attributeName}` : r.type;
      mutations[kind] = (mutations[kind] ?? 0) + 1;
    }
  });
  observer.observe(root.querySelector('.map-world')!, {
    subtree: true,
    attributes: true,
    childList: true,
    characterData: true,
  });
  for (const el of nodes) hover(el);
  leave();
  await frame();
  observer.disconnect();

  return {
    nodes: nodes.length,
    links: root.querySelectorAll('.map-edges:not(.over) .map-edge').length,
    elements: root.querySelectorAll('*').length,
    script: summary(script),
    style: summary(style),
    layout: summary(layout),
    threadSize: summary(thread),
    mutations,
  };
}

/**
 * Pans and zooms with one wheel event per frame and reports the frame intervals, in
 * milliseconds. Only meaningful while the page is visible: a hidden page does not get frames.
 */
export async function measurePan(frames = 120) {
  const root = document.querySelector<HTMLElement>('.map');
  if (!root) throw new Error('The flow map is not on screen');
  const box = root.getBoundingClientRect();
  const wheel = (init: WheelEventInit) =>
    root.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
        ...init,
      }),
    );
  const run = async (init: (i: number) => WheelEventInit) => {
    const intervals: number[] = [];
    const handler: number[] = [];
    let last = await frame();
    for (let i = 0; i < frames; i++) {
      const started = performance.now();
      wheel(init(i));
      handler.push(performance.now() - started);
      const now = await frame();
      intervals.push(now - last);
      last = now;
    }
    return { frame: summary(intervals), handler: summary(handler) };
  };
  const pan = await run((i) => ({ deltaX: i < frames / 2 ? 18 : -18, deltaY: i % 2 ? 9 : -4 }));
  const zoom = await run((i) => ({ deltaY: i < frames / 2 ? 2 : -2, ctrlKey: true }));
  return { visible: document.visibilityState, pan, zoom };
}
