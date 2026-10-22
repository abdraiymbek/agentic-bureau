import { describe, expect, it } from 'vitest';
import {
  EVENT_RESOURCES,
  createSyncScheduler,
  resourcesForEvent,
  type SyncClock,
  type SyncResource,
} from '../../apps/desktop/src/renderer/lib/sync';
import { shareDeep, shareList } from '../../apps/desktop/src/renderer/lib/share';

/** A clock the test moves by hand; microtasks stay real. */
function manualClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: SyncClock = {
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id as number);
    },
    now: () => now,
    queueMicrotask: (fn) => queueMicrotask(fn),
  };
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await settle();
    }
    now = until;
    await settle();
  };
  return { clock, advance, pendingTimers: () => timers.size };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** A host whose answers the test releases one by one. */
function controlledHost() {
  const calls: {
    resource: SyncResource;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }[] = [];
  const load = (resource: SyncResource) =>
    new Promise<unknown>((resolve, reject) => calls.push({ resource, resolve, reject }));
  const count = (resource: SyncResource) => calls.filter((c) => c.resource === resource).length;
  return { calls, load, count };
}

function setup(delayMs = 80, maxWaitMs = 400) {
  const { clock, advance, pendingTimers } = manualClock();
  const host = controlledHost();
  const applied: { resource: SyncResource; value: unknown }[] = [];
  const statuses: string[] = [];
  const sync = createSyncScheduler<SyncResource>({
    load: host.load,
    apply: (resource, value) => applied.push({ resource, value }),
    status: (resource, status) => statuses.push(`${resource}:${status}`),
    delayMs,
    maxWaitMs,
    clock,
  });
  return { sync, host, applied, statuses, advance, pendingTimers };
}

describe('event to resource mapping', () => {
  it('refreshes only what each event can change', () => {
    expect(resourcesForEvent('revision.committed')).toEqual(['artifacts']);
    expect(resourcesForEvent('impact.propagated')).toEqual(['artifacts']);
    expect(resourcesForEvent('proposal.submitted')).toEqual(['proposals', 'artifacts']);
    expect(resourcesForEvent('job.updated')).toEqual(['jobs']);
    expect(resourcesForEvent('session.state')).toEqual(['session']);
    // A draft never changes the baseline graph; a moved baseline does.
    expect(resourcesForEvent('revision.committed')).not.toContain('graph');
    expect(resourcesForEvent('baseline.changed')).toEqual(['artifacts', 'graph', 'proposals']);
    expect(resourcesForEvent('graph.changed')).toContain('graph');
  });

  it('applies intent and navigation events without refreshing anything', () => {
    for (const type of ['project.intent_changed', 'project.renamed', 'ui.open_artifact'])
      expect(resourcesForEvent(type)).toEqual([]);
    // An export writes a file; its job arrives as its own job.updated.
    expect(resourcesForEvent('cad.exported')).toEqual([]);
    expect(resourcesForEvent('build.exported')).toEqual([]);
    expect(resourcesForEvent('ui.something_new')).toEqual([]);
  });

  it('treats an unknown record event as possibly changing the core record', () => {
    expect(resourcesForEvent('artifact.updated')).toEqual(['artifacts', 'graph', 'proposals']);
    expect(Object.keys(EVENT_RESOURCES)).toContain('artifact.renamed');
  });
});

describe('sync scheduler', () => {
  it('coalesces a burst of 10 drafts and a proposal into one request per resource', async () => {
    const { sync, host, advance } = setup();
    for (let i = 0; i < 10; i++) {
      sync.invalidate(resourcesForEvent('revision.committed'));
      await advance(5);
    }
    sync.invalidate(resourcesForEvent('proposal.submitted'));
    await advance(200);
    expect(host.count('artifacts')).toBeLessThanOrEqual(1);
    expect(host.count('graph')).toBeLessThanOrEqual(1);
    expect(host.count('proposals')).toBeLessThanOrEqual(1);
    expect(host.count('artifacts')).toBe(1);
    expect(host.count('proposals')).toBe(1);
    expect(host.calls).toHaveLength(2);
  });

  it('waits for a quiet period but never longer than the maximum wait', async () => {
    const { sync, host, advance } = setup(80, 400);
    sync.invalidate(['artifacts']);
    await advance(79);
    expect(host.calls).toHaveLength(0);
    await advance(1);
    expect(host.calls).toHaveLength(1);
    host.calls[0]!.resolve([]);
    await settle();

    // Events every 50 ms keep resetting the quiet period; the maximum wait still sends one.
    for (let t = 0; t < 390; t += 50) {
      sync.invalidate(['graph']);
      await advance(50);
    }
    expect(host.count('graph')).toBe(1);
  });

  it('keeps one request in flight per resource and asks again once for changes during it', async () => {
    const { sync, host, applied, advance } = setup();
    sync.invalidate(['artifacts']);
    await advance(80);
    expect(host.calls).toHaveLength(1);
    for (let i = 0; i < 5; i++) sync.invalidate(['artifacts']);
    await advance(500);
    // Still one on the wire: the new burst waits for it.
    expect(host.calls).toHaveLength(1);
    host.calls[0]!.resolve(['old']);
    await settle();
    expect(applied.map((a) => a.value)).toEqual([['old']]);
    expect(host.calls).toHaveLength(2);
    host.calls[1]!.resolve(['new']);
    await settle();
    expect(applied.map((a) => a.value)).toEqual([['old'], ['new']]);
    expect(host.calls).toHaveLength(2);
  });

  it('resolves refresh only with data requested after the call', async () => {
    const { sync, host } = setup();
    const first = sync.refresh(['proposals']);
    await settle();
    expect(host.calls).toHaveLength(1);
    let secondDone = false;
    const second = sync.refresh(['proposals']).then(() => {
      secondDone = true;
    });
    host.calls[0]!.resolve(['before the mutation']);
    await first;
    await settle();
    // The answer to the first request predates the second call, so it does not satisfy it.
    expect(secondDone).toBe(false);
    expect(host.calls).toHaveLength(2);
    host.calls[1]!.resolve(['after the mutation']);
    await second;
    expect(secondDone).toBe(true);
  });

  it('sends refreshes asked for in one task together, with pending invalidations', async () => {
    const { sync, host, pendingTimers } = setup();
    sync.invalidate(['graph']);
    void sync.refresh(['artifacts']);
    void sync.refresh(['artifacts']);
    void sync.refresh(['proposals']);
    await settle();
    expect(host.calls.map((c) => c.resource).sort()).toEqual(['artifacts', 'graph', 'proposals']);
    expect(pendingTimers()).toBe(0);
  });

  it('drops an answer superseded by a pushed value, latest wins', async () => {
    const { sync, host, applied } = setup();
    const waiting = sync.refresh(['session']);
    await settle();
    sync.supersede('session');
    await waiting;
    host.calls[0]!.resolve({ id: 'old session' });
    await settle();
    expect(applied).toEqual([]);
  });

  it('drops answers from a project that is no longer open', async () => {
    const { sync, host, applied, statuses } = setup();
    const waiting = sync.refresh(['artifacts']);
    await settle();
    const generation = sync.generation;
    sync.reset();
    expect(sync.generation).toBe(generation + 1);
    await waiting;
    host.calls[0]!.resolve(['from the previous project']);
    await settle();
    expect(applied).toEqual([]);
    expect(statuses).toEqual(['artifacts:loading']);
    // The new project's request is not blocked by the old one still on the wire.
    void sync.refresh(['artifacts']);
    await settle();
    expect(host.calls).toHaveLength(2);
  });

  it('reports a failure through status and still resolves the waiter', async () => {
    const { sync, host, applied, statuses } = setup();
    const waiting = sync.refresh(['jobs']);
    await settle();
    host.calls[0]!.reject(new Error('Disk unavailable'));
    await expect(waiting).resolves.toBeUndefined();
    expect(applied).toEqual([]);
    expect(statuses).toEqual(['jobs:loading', 'jobs:error']);
  });
});

describe('structural sharing', () => {
  it('returns the previous object when nothing changed', () => {
    const prev = { a: 1, b: { c: [1, 2, { d: 'x' }] } };
    const next = JSON.parse(JSON.stringify(prev)) as typeof prev;
    expect(shareDeep(prev, next)).toBe(prev);
  });

  it('keeps unchanged subtrees and replaces changed ones', () => {
    const prev = {
      title: 'Tray',
      payload: { mass: { value: 1, unit: 'kg' } },
      files: [{ p: 'a' }],
    };
    const next = {
      title: 'Tray',
      payload: { mass: { value: 2, unit: 'kg' } },
      files: [{ p: 'a' }],
    };
    const out = shareDeep(prev, next);
    expect(out).not.toBe(prev);
    expect(out).toEqual(next);
    expect(out.files).toBe(prev.files);
    expect(out.payload).not.toBe(prev.payload);
  });

  it('notices removed and added keys', () => {
    expect(shareDeep({ a: 1, b: 2 }, { a: 1 })).toEqual({ a: 1 });
    const prev = { a: 1 };
    expect(shareDeep(prev, { a: 1, b: undefined })).not.toBe(prev);
  });

  it('keeps item identity by key when a list is reordered or grows', () => {
    const a = { id: 'a', v: 1 };
    const b = { id: 'b', v: 2 };
    const prev = [a, b];
    expect(
      shareList(
        prev,
        [
          { id: 'a', v: 1 },
          { id: 'b', v: 2 },
        ],
        (x) => x.id,
      ),
    ).toBe(prev);
    const moved = shareList(
      prev,
      [
        { id: 'c', v: 3 },
        { id: 'b', v: 2 },
        { id: 'a', v: 1 },
      ],
      (x) => x.id,
    );
    expect(moved).not.toBe(prev);
    expect(moved[1]).toBe(b);
    expect(moved[2]).toBe(a);
    const changed = shareList(
      prev,
      [
        { id: 'a', v: 9 },
        { id: 'b', v: 2 },
      ],
      (x) => x.id,
    );
    expect(changed[0]).not.toBe(a);
    expect(changed[1]).toBe(b);
  });
});
