import { describe, expect, it } from 'vitest';
import {
  KEYBOARD_DWELL_MS,
  decisionVerdict,
  layerName,
  renderProblem,
  type DecisionContext,
} from '../../apps/desktop/src/renderer/decide/guard';
import type { Phase } from '../../apps/desktop/src/renderer/decide/model';
import { reviewStatus, type ReviewStatus } from '../../apps/desktop/src/renderer/decide/CadReview';
import { viewportStatus } from '../../apps/desktop/src/renderer/object/viewport/StlViewport';
import { artifact, detail, ids, proposal } from './decide-fixtures';

const needsYou: Phase = { kind: 'needs_you' };

function ctx(over: Partial<DecisionContext> = {}): DecisionContext {
  return {
    op: 'approve',
    via: 'pointer',
    readOnly: false,
    busy: false,
    shown: { proposalId: 'p', fingerprint: 'f', at: 0 },
    loaded: { proposalId: 'p', fingerprint: 'f', phase: needsYou },
    load: 'ready',
    renderProblem: null,
    unreadChange: false,
    rationale: '',
    ...over,
  };
}

const key = (over: Partial<DecisionContext> = {}) =>
  ctx({ via: 'keyboard', focusInside: true, layer: null, repeat: false, now: 10_000, ...over });

const reason = (c: DecisionContext) => {
  const v = decisionVerdict(c);
  return v.ok ? 'ok' : v.reason;
};

describe('approve guard', () => {
  it('approves a pending proposal whose changes are on screen', () => {
    expect(decisionVerdict(ctx())).toEqual({ ok: true });
    expect(decisionVerdict(key())).toEqual({ ok: true });
  });

  it('never approves behind an open layer or with focus outside the decision', () => {
    expect(reason(key({ layer: 'omnibar' }))).toBe(
      'Close the omnibar first. ⌘↵ acts only in the decision view.',
    );
    expect(reason(key({ layer: 'settings sheet' }))).toMatch(/settings sheet/);
    expect(reason(key({ focusInside: false }))).toMatch(/Move focus into the decision/);
  });

  it('ignores a held key, silently, and a proposal that just appeared', () => {
    expect(decisionVerdict(key({ repeat: true }))).toMatchObject({ ok: false, silent: true });
    expect(
      decisionVerdict(
        key({ shown: { proposalId: 'p', fingerprint: 'f', at: 10_000 - KEYBOARD_DWELL_MS + 1 } }),
      ),
    ).toMatchObject({ ok: false, silent: true });
    expect(
      decisionVerdict(
        key({ shown: { proposalId: 'p', fingerprint: 'f', at: 10_000 - KEYBOARD_DWELL_MS } }),
      ),
    ).toEqual({ ok: true });
  });

  it('acts only on the proposal and version that are on screen', () => {
    expect(reason(ctx({ shown: { proposalId: 'other', fingerprint: 'f', at: 0 } }))).toBe(
      'The screen is still showing an older version of this proposal.',
    );
    expect(reason(ctx({ shown: { proposalId: 'p', fingerprint: 'old', at: 0 } }))).toBe(
      'The screen is still showing an older version of this proposal.',
    );
    expect(reason(ctx({ shown: null }))).toMatch(/older version/);
  });

  it('requires the changes to be read and rendered', () => {
    expect(reason(ctx({ load: 'loading', loaded: null }))).toBe('The proposal is still loading.');
    expect(reason(ctx({ load: 'error' }))).toBe('The proposal could not be read.');
    expect(reason(ctx({ load: 'refreshing' }))).toBe('Checking whether the proposal changed.');
    expect(reason(ctx({ load: 'refresh_failed' }))).toMatch(/Could not confirm the latest state/);
    expect(reason(ctx({ renderProblem: 'The proposed geometry is still loading.' }))).toBe(
      'The proposed geometry is still loading.',
    );
    expect(reason(ctx({ unreadChange: true }))).toMatch(/changed while it was open/);
  });

  it('blocks approval when a base moved, and says why', () => {
    const moved: Phase = { kind: 'base_moved', artifactIds: ['a'] };
    expect(reason(ctx({ loaded: { proposalId: 'p', fingerprint: 'f', phase: moved } }))).toBe(
      'Approval is blocked: a baseline moved after this was proposed.',
    );
  });

  it('lets a returned proposal be approved as it stands only by an explicit press', () => {
    const waiting: Phase = { kind: 'waiting_on_agent', request: 'x', artifactIds: [] };
    const loaded = { proposalId: 'p', fingerprint: 'f', phase: waiting };
    expect(decisionVerdict(ctx({ loaded }))).toEqual({ ok: true });
    expect(reason(key({ loaded }))).toBe('⌘↵ approves only proposals that need you.');
    const movedWaiting: Phase = { kind: 'waiting_on_agent', request: 'x', artifactIds: ['a'] };
    expect(reason(ctx({ loaded: { ...loaded, phase: movedWaiting } }))).toMatch(/blocked/);
  });

  it('refuses closed proposals and read-only projects, and a second decision in flight', () => {
    const decided: Phase = { kind: 'decided', outcome: 'approved', rationale: null, at: null };
    expect(reason(ctx({ loaded: { proposalId: 'p', fingerprint: 'f', phase: decided } }))).toBe(
      'This proposal is no longer open.',
    );
    expect(reason(ctx({ readOnly: true }))).toMatch(/read-only/);
    expect(decisionVerdict(ctx({ busy: true }))).toMatchObject({ ok: false, silent: false });
    expect(decisionVerdict(key({ busy: true }))).toMatchObject({ ok: false, silent: true });
  });
});

describe('reject and request changes are guarded the same way', () => {
  it('need a rationale, the same proposal on screen, and an open state', () => {
    expect(reason(ctx({ op: 'reject' }))).toBe(
      'Say why it is rejected. The reason is kept in the record.',
    );
    expect(reason(ctx({ op: 'request_changes' }))).toBe('Say what the agent should change.');
    expect(decisionVerdict(ctx({ op: 'reject', rationale: 'Too heavy.' }))).toEqual({ ok: true });
    expect(reason(ctx({ op: 'reject', rationale: 'x', unreadChange: true }))).toMatch(/changed/);
    expect(
      reason(
        ctx({
          op: 'request_changes',
          rationale: 'x',
          shown: { proposalId: 'q', fingerprint: 'f', at: 0 },
        }),
      ),
    ).toMatch(/older version/);
    const waiting: Phase = { kind: 'waiting_on_agent', request: null, artifactIds: [] };
    const loaded = { proposalId: 'p', fingerprint: 'f', phase: waiting };
    expect(reason(ctx({ op: 'request_changes', rationale: 'x', loaded }))).toBe(
      'Changes are already requested.',
    );
    expect(decisionVerdict(ctx({ op: 'reject', rationale: 'x', loaded }))).toEqual({ ok: true });
  });

  it('have no keyboard shortcut', () => {
    expect(decisionVerdict(key({ op: 'reject', rationale: 'x' }))).toMatchObject({
      ok: false,
      silent: true,
    });
  });
});

describe('open layers', () => {
  // Which layer is open is decided by the shared helper (`lib/layers.ts`, tested in
  // layers.test.ts); the guard names it in the bar's words.
  it('names the layer that owns the keyboard', () => {
    expect(layerName(null)).toBeNull();
    expect(layerName('omnibar')).toBe('omnibar');
    expect(layerName('settings')).toBe('settings sheet');
    expect(layerName('dialog')).toBe('dialog');
    expect(layerName('menu')).toBe('menu');
    expect(layerName('prompt')).toBe('unsaved-changes prompt');
    expect(layerName('custom')).toBe('open panel');
  });
  it('blocks ⌘↵ while any of them is open, with its name', () => {
    expect(decisionVerdict(key({ layer: layerName('prompt') }))).toMatchObject({
      ok: false,
      reason: 'Close the unsaved-changes prompt first. ⌘↵ acts only in the decision view.',
    });
  });
});

describe('content that is not on screen', () => {
  const part = (kind: 'baseline_update' | 'archive', geometry?: ReviewStatus) => {
    const d = detail({ proposal: { changes: [{ ...proposal().changes[0]!, kind }] } });
    d.changes[0] = {
      ...d.changes[0]!,
      change: d.proposal.changes[0]!,
      artifact: { ...artifact(), type: 'mechanical' },
    };
    return { d, geometry: geometry ? { [ids.r2]: geometry } : {} };
  };

  it('holds back approval only, so a change that cannot be shown can still be rejected or returned', () => {
    const problem = 'The proposed geometry cannot be shown. This file is not a readable STL.';
    expect(reason(ctx({ renderProblem: problem }))).toBe(problem);
    expect(
      decisionVerdict(ctx({ op: 'reject', rationale: 'Broken mesh', renderProblem: problem })),
    ).toEqual({ ok: true });
    expect(
      decisionVerdict(
        ctx({ op: 'request_changes', rationale: 'Re-render it', renderProblem: problem }),
      ),
    ).toEqual({ ok: true });
  });

  it('waits for no geometry on a mechanical archive, which shows none', () => {
    const { d, geometry } = part('archive');
    expect(renderProblem(d, geometry)).toBeNull();
  });

  it('waits for a mechanical change until its geometry is on screen', () => {
    expect(renderProblem(part('baseline_update').d, {})).toBe(
      'The proposed geometry is still loading.',
    );
    const loading = part('baseline_update', { state: 'loading' });
    expect(renderProblem(loading.d, loading.geometry)).toBe(
      'The proposed geometry is still loading.',
    );
    const failed = part('baseline_update', { state: 'error', reason: 'Not readable.' });
    expect(renderProblem(failed.d, failed.geometry)).toBe('Not readable.');
    const ready = part('baseline_update', { state: 'ready' });
    expect(renderProblem(ready.d, ready.geometry)).toBeNull();
  });
});

describe('geometry review status', () => {
  const read = { state: 'ready' } as const;

  it('is ready only once the proposed mesh is on screen, not when its bytes arrive', () => {
    expect(reviewStatus(read, null)).toEqual({ state: 'loading' });
    expect(reviewStatus(read, { state: 'parsing' })).toEqual({ state: 'loading' });
    expect(reviewStatus(read, { state: 'shown' })).toEqual({ state: 'ready' });
  });

  it('is an error when the mesh cannot be parsed or no 3D view is available', () => {
    expect(
      reviewStatus(read, { state: 'error', reason: 'The file is not a readable STL: truncated' }),
    ).toEqual({
      state: 'error',
      reason: 'The proposed geometry cannot be shown. The file is not a readable STL: truncated',
    });
    expect(reviewStatus({ state: 'error', message: 'gone' }, null)).toEqual({
      state: 'error',
      reason: 'The proposed geometry could not be read: gone',
    });
    expect(reviewStatus({ state: 'loading' }, { state: 'shown' })).toEqual({ state: 'loading' });
  });

  it('reports what the viewport shows from the parse and the scene', () => {
    const mesh = {} as never;
    const scene = { ready: true, failure: null };
    expect(viewportStatus({ mesh: null, error: null, parsing: true }, scene)).toEqual({
      state: 'parsing',
    });
    expect(viewportStatus({ mesh, error: null, parsing: false }, scene)).toEqual({
      state: 'shown',
    });
    expect(
      viewportStatus({ mesh, error: null, parsing: false }, { ready: false, failure: null }),
    ).toEqual({ state: 'parsing' });
    expect(
      viewportStatus({ mesh, error: null, parsing: false }, { ready: false, failure: 'No WebGL' }),
    ).toEqual({ state: 'error', reason: 'The 3D view is not available: No WebGL' });
    expect(viewportStatus({ mesh: null, error: 'truncated', parsing: false }, scene)).toEqual({
      state: 'error',
      reason: 'The file is not a readable STL: truncated',
    });
  });
});
