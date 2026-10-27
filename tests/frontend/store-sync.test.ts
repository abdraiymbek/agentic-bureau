import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactView, Edge, Project, ProjectEvent, Proposal } from '@bureau/contracts';
import { useStore } from '../../apps/desktop/src/renderer/store';
import {
  clearAllUnsaved,
  clearUnsaved,
  hasUnsavedWork,
  markUnsaved,
} from '../../apps/desktop/src/renderer/lib/dirty';
import { unsavedEdits } from '../../apps/desktop/src/renderer/lib/unsaved-edits';

/* ---------------- a fake host ---------------- */

function view(id: string, title = id, extra: Partial<ArtifactView> = {}): ArtifactView {
  return {
    artifact: { id, type: 'requirement', title, selectedRevisionId: `${id}-r1` },
    revision: { id: `${id}-r1`, payload: { statement: title } },
    freshness: 'current',
    staleReasons: [],
    draftCount: 0,
    pendingProposal: false,
    ...extra,
  } as unknown as ArtifactView;
}

function event(seq: number, type = 'revision.committed', data: unknown = {}): ProjectEvent {
  return {
    seq,
    id: `e${seq}`,
    type,
    origin: 'agent',
    ts: '2026-10-13T00:00:00Z',
    data,
    projectId: 'p1',
  };
}

interface Host {
  artifacts: ArtifactView[];
  edges: Edge[];
  proposals: Proposal[];
  highWater: number;
  /** Report paging the way the Rust host does (`hasMore`, `nextOffset`). */
  rustPaging: boolean;
  fail: Set<string>;
  /** Sequence numbers the record has no event for (a stretch with nothing recorded). */
  gap?: (seq: number) => boolean;
}

let host: Host;
const calls: { op: string; payload: Record<string, unknown> }[] = [];
const count = (op: string) => calls.filter((c) => c.op === op).length;

const command = vi.fn(async (op: string, payload: Record<string, unknown>) => {
  calls.push({ op, payload });
  if (host.fail.has(op)) return { ok: false, error: { code: 'INTERNAL', message: `${op} failed` } };
  switch (op) {
    case 'artifact.list': {
      const offset = (payload.offset as number) ?? 0;
      const limit = payload.limit as number;
      const artifacts = host.artifacts.slice(offset, offset + limit);
      const more = offset + artifacts.length < host.artifacts.length;
      return {
        ok: true,
        result: host.rustPaging
          ? {
              artifacts,
              hasMore: more,
              nextOffset: offset + artifacts.length,
              total: host.artifacts.length,
            }
          : { artifacts },
      };
    }
    case 'graph.list':
      return { ok: true, result: { edges: host.edges } };
    case 'proposal.list':
      return { ok: true, result: { proposals: host.proposals } };
    case 'project.changes_since': {
      const seq = payload.seq as number;
      const events: ProjectEvent[] = [];
      for (let s = seq + 1; s <= host.highWater && events.length < 500; s++)
        if (!host.gap?.(s)) events.push(event(s));
      return { ok: true, result: { events, highWater: host.highWater, hasMore: false } };
    }
    case 'job.list':
      return { ok: true, result: { jobs: [] } };
    case 'terminal.state':
      return { ok: true, result: { session: null } };
    case 'connection.list':
      return { ok: true, result: { adapters: [] } };
    case 'project.update_intent':
      return { ok: true, result: {} };
    default:
      return { ok: true, result: {} };
  }
});

const storage = new Map<string, string>();
const initial = useStore.getState();

async function openProject() {
  const s = useStore.getState();
  s.set({ project: { id: 'p1', name: 'Rover', intent: 'Carry a camera' } as Project });
  s.setActive('p1');
  await useStore.getState().refreshAll();
}

beforeEach(() => {
  vi.useFakeTimers();
  storage.clear();
  vi.stubGlobal('window', {
    bureau: { command, setActiveProject: vi.fn().mockResolvedValue(undefined) },
    dispatchEvent: vi.fn(),
  });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
  });
  host = {
    artifacts: [view('a1', 'Payload capacity'), view('a2', 'Camera tray')],
    edges: [],
    proposals: [],
    highWater: 3,
    rustPaging: false,
    fail: new Set(),
  };
  calls.length = 0;
  command.mockClear();
});

afterEach(() => {
  clearAllUnsaved();
  useStore.getState().setActive(null);
  useStore.setState(initial);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* ---------------- tests ---------------- */

describe('store sync', () => {
  it('turns a burst of 10 draft events and a proposal into one request per resource', async () => {
    await openProject();
    calls.length = 0;
    const push = useStore.getState().pushEvent;
    for (let i = 0; i < 10; i++) {
      push(event(10 + i, 'revision.committed'));
      await vi.advanceTimersByTimeAsync(10);
    }
    push(event(20, 'proposal.submitted'));
    await vi.advanceTimersByTimeAsync(500);
    expect(count('artifact.list')).toBe(1);
    expect(count('graph.list')).toBeLessThanOrEqual(1);
    expect(count('proposal.list')).toBe(1);
    expect(
      useStore
        .getState()
        .events.map((e) => e.seq)
        .slice(-11),
    ).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  });

  it('acts on a live event once and ignores events from another project', async () => {
    await openProject();
    const push = useStore.getState().pushEvent;
    push(event(4, 'baseline.changed'));
    await vi.advanceTimersByTimeAsync(500);
    calls.length = 0;
    push(event(4, 'baseline.changed'));
    push({ ...event(30, 'baseline.changed'), projectId: 'other' });
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toEqual([]);
    expect(useStore.getState().events.filter((e) => e.seq === 4)).toHaveLength(1);
  });

  it('still refreshes for a live event the tail read returned first', async () => {
    await openProject();
    const before = useStore.getState().partsVersion;
    // The agent's change lands while the events are read; its live push arrives after.
    host.highWater = 4;
    await useStore.getState().refreshEvents();
    expect(useStore.getState().events.at(-1)!.seq).toBe(4);
    calls.length = 0;
    useStore.getState().pushEvent(event(4, 'bom.changed'));
    await vi.advanceTimersByTimeAsync(500);
    expect(useStore.getState().partsVersion).toBe(before + 1);
    expect(count('artifact.list')).toBe(1);
    expect(useStore.getState().events.filter((e) => e.seq === 4)).toHaveLength(1);
  });

  it('applies the agent’s rename and navigation even when the tail read returned them first', async () => {
    await openProject();
    host.highWater = 5;
    await useStore.getState().refreshEvents();
    const push = useStore.getState().pushEvent;
    push(event(4, 'project.renamed', { name: 'Rover two' }));
    push(event(5, 'ui.open_artifact', { artifactId: 'a2' }));
    expect(useStore.getState().project?.name).toBe('Rover two');
    expect(useStore.getState().view).toEqual({ level: 'object', id: 'a2' });
  });

  it('keeps object identity when a refresh returns the same data', async () => {
    await openProject();
    const before = useStore.getState();
    host.artifacts = host.artifacts.map((v) => JSON.parse(JSON.stringify(v)) as ArtifactView);
    await before.refreshArtifacts();
    const after = useStore.getState();
    expect(after.artifacts).toBe(before.artifacts);
    expect(after.stale).toBe(before.stale);

    host.artifacts = [view('a1', 'Payload capacity, revised'), view('a2', 'Camera tray')];
    await after.refreshArtifacts();
    const changed = useStore.getState().artifacts;
    expect(changed).not.toBe(before.artifacts);
    expect(changed[0]).not.toBe(before.artifacts[0]);
    expect(changed[1]).toBe(before.artifacts[1]);
  });

  it('hands out a new list after a bill-of-materials change, items unchanged', async () => {
    await openProject();
    const before = useStore.getState();
    useStore.getState().pushEvent(event(4, 'bom.changed'));
    await vi.advanceTimersByTimeAsync(500);
    const after = useStore.getState();
    expect(after.partsVersion).toBe(before.partsVersion + 1);
    expect(after.artifacts).not.toBe(before.artifacts);
    expect(after.artifacts[0]).toBe(before.artifacts[0]);
  });

  it('invalidates same-revision evidence only for finished checks of the relevant object', async () => {
    await openProject();
    const before = useStore.getState().artifacts;
    useStore.getState().pushEvent(
      event(4, 'job.updated', {
        kind: 'cad_check',
        status: 'running',
        artifactId: 'a1',
      }),
    );
    expect(useStore.getState().evidenceVersions.a1).toBeUndefined();
    useStore.getState().pushEvent(
      event(5, 'job.updated', {
        kind: 'cad_check',
        status: 'succeeded',
        artifactId: 'a1',
      }),
    );
    expect(useStore.getState().evidenceVersions).toEqual({ a1: 1 });
    expect(useStore.getState().artifacts).toBe(before);
    useStore.getState().pushEvent(
      event(6, 'job.updated', {
        kind: 'cad_render',
        status: 'succeeded',
        artifactId: 'a2',
      }),
    );
    expect(useStore.getState().evidenceVersions).toEqual({ a1: 1 });
    useStore.getState().pushEvent(event(7, 'cad.scope.accepted', { artifactId: 'a1' }));
    useStore.getState().pushEvent(event(7, 'cad.scope.accepted', { artifactId: 'a1' }));
    expect(useStore.getState().evidenceVersions.a1).toBe(2);
  });

  it('refreshes proposal input context after a baseline moves and forgets versions on project switch', async () => {
    await openProject();
    useStore.getState().pushEvent(event(4, 'baseline.changed', { artifactId: 'a2' }));
    expect(useStore.getState().baselineVersion).toBe(1);
    useStore.getState().pushEvent(event(5, 'cad.scope.accepted', { artifactId: 'a1' }));
    useStore.getState().setActive('p2');
    expect(useStore.getState().baselineVersion).toBe(0);
    expect(useStore.getState().evidenceVersions).toEqual({});
    useStore.getState().pushEvent(event(6, 'cad.scope.accepted', { artifactId: 'a1' }));
    expect(useStore.getState().evidenceVersions).toEqual({});
  });

  it('updates the focused view when a draft advances without changing its open-draft count', async () => {
    host.artifacts[0] = view('a1', 'Payload', {
      draftCount: 1,
      head: { id: 'r2', seq: 2, reviewState: 'draft' },
    });
    await openProject();
    const before = useStore.getState().artifacts;
    host.artifacts[0] = { ...host.artifacts[0]!, head: { id: 'r3', seq: 3, reviewState: 'draft' } };
    useStore
      .getState()
      .pushEvent(event(4, 'revision.committed', { artifactId: 'a1', revisionId: 'r3' }));
    await vi.advanceTimersByTimeAsync(500);
    expect(useStore.getState().artifacts[0]?.head?.id).toBe('r3');
    expect(useStore.getState().artifacts[0]).not.toBe(before[0]);
    expect(useStore.getState().artifacts[1]).toBe(before[1]);
  });

  it('reads every artifact past 500 from a host without paging fields', async () => {
    host.artifacts = Array.from({ length: 1203 }, (_, i) => view(`a${i}`));
    await openProject();
    expect(useStore.getState().artifacts).toHaveLength(1203);
    expect(calls.filter((c) => c.op === 'artifact.list').map((c) => c.payload.offset)).toEqual([
      0, 500, 1000,
    ]);
  });

  it('follows hasMore and nextOffset from a host that reports paging', async () => {
    host.rustPaging = true;
    host.artifacts = Array.from({ length: 1000 }, (_, i) => view(`a${i}`));
    await openProject();
    expect(useStore.getState().artifacts).toHaveLength(1000);
    expect(count('artifact.list')).toBe(2);
  });
});

describe('load state', () => {
  it('tells loading from empty, and failure from both', async () => {
    host.artifacts = [];
    const s = useStore.getState();
    s.set({ project: { id: 'p1', name: 'Rover' } as Project });
    s.setActive('p1');
    expect(useStore.getState().firstLoadComplete).toBe(false);
    expect(useStore.getState().load.artifacts.status).toBe('idle');
    const loading = useStore.getState().refreshAll();
    await Promise.resolve();
    await Promise.resolve();
    expect(useStore.getState().load.artifacts.status).toBe('loading');
    await loading;
    const loaded = useStore.getState();
    expect(loaded.firstLoadComplete).toBe(true);
    expect(loaded.load.artifacts).toEqual({ status: 'ready', error: null, loaded: true });
    expect(loaded.artifacts).toEqual([]);
  });

  it('keeps the first load incomplete when part of the record fails, then retries', async () => {
    host.fail.add('graph.list');
    await openProject();
    let s = useStore.getState();
    expect(s.firstLoadComplete).toBe(false);
    expect(s.load.graph).toEqual({ status: 'error', error: 'graph.list failed', loaded: false });
    expect(s.load.artifacts.status).toBe('ready');
    host.fail.clear();
    calls.length = 0;
    await s.retryLoad();
    s = useStore.getState();
    expect(calls.map((c) => c.op)).toEqual(['graph.list']);
    expect(s.firstLoadComplete).toBe(true);
    expect(s.load.graph.status).toBe('ready');
  });

  it('keeps loaded data and stays ready-looking when a later refresh fails', async () => {
    await openProject();
    const before = useStore.getState().artifacts;
    host.fail.add('artifact.list');
    await useStore.getState().refreshArtifacts();
    const s = useStore.getState();
    expect(s.artifacts).toBe(before);
    expect(s.load.artifacts).toEqual({
      status: 'error',
      error: 'artifact.list failed',
      loaded: true,
    });
    expect(s.firstLoadComplete).toBe(true);
  });
});

describe('event record', () => {
  it('loads the newest page and pages older events in until the start', async () => {
    host.highWater = 1000;
    await openProject();
    let s = useStore.getState();
    expect(s.events[0]!.seq).toBe(601);
    expect(s.events.at(-1)!.seq).toBe(1000);
    expect(s.hasOlderEvents).toBe(true);
    // The probe asks for nothing; the tail starts where the newest page does.
    expect(calls.filter((c) => c.op === 'project.changes_since').map((c) => c.payload.seq)).toEqual(
      [Number.MAX_SAFE_INTEGER, 600],
    );
    await s.loadOlderEvents();
    s = useStore.getState();
    expect(s.events[0]!.seq).toBe(201);
    expect(s.events).toHaveLength(800);
    expect(s.hasOlderEvents).toBe(true);
    await s.loadOlderEvents();
    s = useStore.getState();
    expect(s.events[0]!.seq).toBe(1);
    expect(s.hasOlderEvents).toBe(false);
    expect(s.olderEvents).toBe('idle');
  });
});

describe('event record, live events before the first read', () => {
  it('does not claim the start of the record when an event arrives during the first read', async () => {
    host.highWater = 1000;
    const s = useStore.getState();
    s.set({ project: { id: 'p1', name: 'Rover', intent: 'Carry a camera' } as Project });
    s.setActive('p1');
    expect(useStore.getState().hasOlderEvents).toBe(true);
    const loading = useStore.getState().refreshAll();
    // The agent records something while the tail is on the wire.
    useStore.getState().pushEvent(event(1001));
    host.highWater = 1001;
    await loading;
    let now = useStore.getState();
    expect(now.events[0]!.seq).toBe(602);
    expect(now.events.at(-1)!.seq).toBe(1001);
    expect(now.hasOlderEvents).toBe(true);
    await now.loadOlderEvents();
    now = useStore.getState();
    expect(now.events[0]!.seq).toBe(202);
    expect(now.hasOlderEvents).toBe(true);
  });

  it('reads the record, not a page below an unknown bound, when the first read failed', async () => {
    host.highWater = 1000;
    host.fail.add('project.changes_since');
    await openProject();
    useStore.getState().pushEvent(event(1001));
    let now = useStore.getState();
    expect(now.load.events.status).toBe('error');
    expect(now.hasOlderEvents).toBe(true);
    host.fail.clear();
    host.highWater = 1001;
    await now.loadOlderEvents();
    now = useStore.getState();
    expect(now.events[0]!.seq).toBe(602);
    expect(now.hasOlderEvents).toBe(true);
    // Retry after the failure goes through the same first read.
    await useStore.getState().retryLoad();
    expect(useStore.getState().hasOlderEvents).toBe(true);
  });
});

describe('event record, sparse', () => {
  // Paging moved here from the Timeline lens, which now reads the store's window.
  it('moves past a stretch with no events instead of asking for it again', async () => {
    host.highWater = 900;
    host.gap = (seq) => seq > 1 && seq < 900;
    await openProject();
    let s = useStore.getState();
    expect(s.events.map((e) => e.seq)).toEqual([900]);
    expect(s.hasOlderEvents).toBe(true);
    await s.loadOlderEvents();
    s = useStore.getState();
    expect(s.events.map((e) => e.seq)).toEqual([900]);
    await s.loadOlderEvents();
    s = useStore.getState();
    expect(s.events.map((e) => e.seq)).toEqual([1, 900]);
    expect(s.hasOlderEvents).toBe(false);
    const asked = calls.filter((c) => c.op === 'project.changes_since').map((c) => c.payload.seq);
    expect(new Set(asked).size).toBe(asked.length);
  });
});

describe('unsaved work', () => {
  it('holds incoming changes to an object being edited until the edit is resolved', async () => {
    await openProject();
    const before = useStore.getState().artifacts[0]!;
    markUnsaved('requirement:a1', 'Payload capacity: target value', { holdArtifactIds: ['a1'] });
    host.artifacts = [view('a1', 'Changed by the agent'), view('a2', 'Camera tray')];
    await useStore.getState().refreshArtifacts();
    expect(useStore.getState().artifacts[0]).toBe(before);
    expect(useStore.getState().heldUpdates).toEqual(['a1']);
    clearUnsaved('requirement:a1');
    await vi.advanceTimersByTimeAsync(500);
    expect(useStore.getState().artifacts[0]!.artifact.title).toBe('Changed by the agent');
    expect(useStore.getState().heldUpdates).toEqual([]);
  });

  it('asks before navigating away from unsaved work and only leaves on discard', async () => {
    await openProject();
    const s = useStore.getState();
    s.focus('a1');
    markUnsaved('requirement:a1', 'Payload capacity: target value');
    s.focus('a2');
    expect(useStore.getState().view).toEqual({ level: 'object', id: 'a1' });
    expect(useStore.getState().leavePrompt).toEqual({
      action: 'continue',
      labels: ['Payload capacity: target value'],
    });
    useStore.getState().resolveLeavePrompt(false);
    expect(useStore.getState().view).toEqual({ level: 'object', id: 'a1' });
    useStore.getState().zoomOut();
    useStore.getState().resolveLeavePrompt(true);
    expect(useStore.getState().view).toEqual({ level: 'project', lens: 'flow' });
    expect(useStore.getState().leavePrompt).toBeNull();
    // The work was discarded, so the next move does not ask.
    useStore.getState().focus('a2');
    expect(useStore.getState().view).toEqual({ level: 'object', id: 'a2' });
  });

  it('neither asks nor discards when back or forward has nowhere to go', async () => {
    await openProject();
    useStore.getState().focus('a1');
    markUnsaved('requirement:a1', 'Payload capacity: target value');
    useStore.getState().goForward();
    expect(useStore.getState().leavePrompt).toBeNull();
    useStore.getState().goBack();
    expect(useStore.getState().leavePrompt?.labels).toEqual(['Payload capacity: target value']);
    useStore.getState().resolveLeavePrompt(false);
    useStore.setState({ back: [] });
    useStore.getState().goBack();
    expect(useStore.getState().leavePrompt).toBeNull();
    expect(useStore.getState().view).toEqual({ level: 'object', id: 'a1' });
    expect(hasUnsavedWork()).toBe(true);
  });

  it('asks about an object editor’s unsaved edits on every navigation, and clears them with the project', async () => {
    await openProject();
    const s = useStore.getState();
    s.focus('a1');
    unsavedEdits.put({ key: 'p1:a1:stage', label: 'requirement A1', mounted: true, snapshot: {} });
    for (const leave of [() => s.goBack(), () => s.zoomOut(), () => s.decide(null)]) {
      leave();
      expect(useStore.getState().leavePrompt?.labels).toEqual(['requirement A1']);
      useStore.getState().resolveLeavePrompt(false);
      expect(useStore.getState().view).toEqual({ level: 'object', id: 'a1' });
    }
    unsavedEdits.park('p1:a1:stage');
    expect(unsavedEdits.list()).toHaveLength(1);
    useStore.getState().setActive(null);
    expect(unsavedEdits.list()).toEqual([]);
  });

  it('does not let the agent navigate over unsaved work', async () => {
    await openProject();
    useStore.getState().focus('a1');
    markUnsaved('requirement:a1', 'Payload capacity: statement');
    const toast = vi.spyOn(useStore.getState(), 'toast');
    useStore.getState().pushEvent(event(4, 'ui.open_artifact', { artifactId: 'a2' }));
    expect(useStore.getState().view).toEqual({ level: 'object', id: 'a1' });
    expect(useStore.getState().leavePrompt).toBeNull();
    expect(toast).toHaveBeenCalledWith('info', expect.stringContaining('unsaved changes'));
  });
});

describe('navigation', () => {
  it('goes back and forward along the path taken', async () => {
    await openProject();
    const s = useStore.getState();
    s.go({ level: 'project', lens: 'parts' });
    s.focus('a1');
    s.focus('a2');
    s.goBack();
    expect(useStore.getState().view).toEqual({ level: 'object', id: 'a1' });
    s.goBack();
    expect(useStore.getState().view).toEqual({ level: 'project', lens: 'parts' });
    s.goForward();
    expect(useStore.getState().view).toEqual({ level: 'object', id: 'a1' });
    s.go({ level: 'project', lens: 'timeline' });
    expect(useStore.getState().forward).toEqual([]);
  });

  it('zooms out of an object to the lens it came from', async () => {
    await openProject();
    const s = useStore.getState();
    s.go({ level: 'project', lens: 'parts' });
    s.focus('a1');
    s.zoomOut();
    expect(useStore.getState().view).toEqual({ level: 'project', lens: 'parts' });
    s.focus('a1');
    s.decide('p9');
    s.zoomOut();
    expect(useStore.getState().view).toEqual({ level: 'object', id: 'a1' });
  });
});

describe('preferences', () => {
  it('reopens a project where it was left once the record shows the object exists', async () => {
    storage.set(
      'bureau.project.p1',
      JSON.stringify({ view: { level: 'object', id: 'a2' }, lens: 'parts', agentWindowOpen: true }),
    );
    const s = useStore.getState();
    s.setActive('p1');
    expect(useStore.getState().view).toEqual({ level: 'project', lens: 'parts' });
    expect(useStore.getState().agentWindowOpen).toBe(true);
    await useStore.getState().refreshAll();
    expect(useStore.getState().view).toEqual({ level: 'object', id: 'a2' });
    expect(useStore.getState().back).toEqual([{ level: 'project', lens: 'parts' }]);
  });

  it('stays on the lens when the saved object is gone, and saves where the person goes', async () => {
    storage.set('bureau.project.p1', JSON.stringify({ view: { level: 'object', id: 'gone' } }));
    await openProject();
    expect(useStore.getState().view).toEqual({ level: 'project', lens: 'flow' });
    useStore.getState().go({ level: 'project', lens: 'timeline' });
    expect(JSON.parse(storage.get('bureau.project.p1')!)).toEqual({
      view: { level: 'project', lens: 'timeline' },
      lens: 'timeline',
      agentWindowOpen: false,
    });
  });

  it('survives malformed stored preferences', async () => {
    storage.set('bureau.project.p1', '{not json');
    storage.set('bureau.rails', '[1,2]');
    await openProject();
    expect(useStore.getState().view).toEqual({ level: 'project', lens: 'flow' });
  });
});

describe('optimistic intent', () => {
  it('shows the new intent at once and restores the old one if saving fails', async () => {
    await openProject();
    const saving = useStore.getState().updateIntent('Carry two cameras');
    expect(useStore.getState().project?.intent).toBe('Carry two cameras');
    await saving;
    expect(command).toHaveBeenLastCalledWith(
      'project.update_intent',
      { intent: 'Carry two cameras' },
      { projectId: 'p1' },
    );

    host.fail.add('project.update_intent');
    const failing = useStore.getState().updateIntent('Carry three cameras');
    expect(useStore.getState().project?.intent).toBe('Carry three cameras');
    await expect(failing).rejects.toThrow('project.update_intent failed');
    expect(useStore.getState().project?.intent).toBe('Carry two cameras');
  });
});

describe('session', () => {
  it('lets a pushed session outrank a terminal.state answer already on its way', async () => {
    await openProject();
    let answer!: (v: unknown) => void;
    command.mockImplementationOnce(
      (op: string, payload: Record<string, unknown>) => (
        calls.push({ op, payload }),
        new Promise((resolve) => {
          answer = resolve;
        })
      ),
    );
    const refreshing = useStore.getState().refreshSession();
    await Promise.resolve();
    await Promise.resolve();
    useStore.getState().receiveSession({ id: 'new', state: 'running' } as never);
    await refreshing;
    answer({ ok: true, result: { session: { id: 'old', state: 'exited', scrollback: 'x' } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(useStore.getState().session).toEqual({ id: 'new', state: 'running' });
  });
});
