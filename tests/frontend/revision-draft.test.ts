import { describe, expect, it } from 'vitest';
import {
  commitDraft,
  dirtyFields,
  discardDraft,
  editDraft,
  editability,
  isDirty,
  keepEdits,
  lockReasonText,
  openDraft,
  receiveRevision,
  reloadBase,
  sameValue,
  underneathChanges,
} from '../../apps/desktop/src/renderer/lib/revision-draft';

type Form = { statement: string; target: number | null; unit: string; priority: string };
const recorded: Form = {
  statement: 'Carry the payload',
  target: 0.3,
  unit: 'kg',
  priority: 'must',
};

describe('edits are held apart from incoming data', () => {
  it('ignores the same revision arriving again, however often and however rebuilt', () => {
    const typing = editDraft(openDraft('r1', recorded), { statement: 'Carry the payload pack' });
    // A background refresh deserialises the same revision into fresh objects every time.
    const refreshed = receiveRevision(typing, 'r1', { ...recorded });
    expect(refreshed).toBe(typing);
    expect(receiveRevision(refreshed, 'r1', { ...recorded }).form.statement).toBe(
      'Carry the payload pack',
    );
  });

  it('follows the revision on screen while nothing is edited', () => {
    const clean = openDraft('r1', recorded);
    const next = receiveRevision(clean, 'r2', { ...recorded, target: 0.5 });
    expect(next.baseRevisionId).toBe('r2');
    expect(next.form.target).toBe(0.5);
    expect(isDirty(next)).toBe(false);
  });

  it('sets a different revision beside unsaved edits instead of replacing them', () => {
    const typing = editDraft(openDraft('r1', recorded), { target: 0.6 });
    const moved = receiveRevision(typing, 'r2', { ...recorded, target: 0.5, priority: 'should' });
    expect(moved.form.target).toBe(0.6);
    expect(moved.baseRevisionId).toBe('r1');
    expect(moved.incoming?.revisionId).toBe('r2');
    // Delivering the waiting revision again changes nothing either.
    expect(receiveRevision(moved, 'r2', { ...recorded, target: 0.5, priority: 'should' })).toBe(
      moved,
    );
  });

  it('drops a waiting revision when the base becomes current again', () => {
    const typing = editDraft(openDraft('r1', recorded), { target: 0.6 });
    const moved = receiveRevision(typing, 'r2', { ...recorded, target: 0.5 });
    expect(receiveRevision(moved, 'r1', recorded).incoming).toBeNull();
  });

  it('keeps edits when the target is momentarily unknown', () => {
    const typing = editDraft(openDraft('r1', recorded), { target: 0.6 });
    expect(receiveRevision(typing, null, recorded)).toBe(typing);
  });
});

describe('dirty tracking is field by field', () => {
  it('names exactly the fields that differ from the base', () => {
    const state = editDraft(openDraft('r1', recorded), { target: 0.6, priority: 'should' });
    expect(dirtyFields(state)).toEqual(['target', 'priority']);
  });
  it('is clean again once a field is typed back to its recorded value', () => {
    const state = editDraft(editDraft(openDraft('r1', recorded), { target: 0.6 }), { target: 0.3 });
    expect(isDirty(state)).toBe(false);
  });
  it('compares structured values by content', () => {
    expect(sameValue({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(sameValue({ a: [1, 2] }, { a: [1, 3] })).toBe(false);
    expect(sameValue(null, undefined)).toBe(false);
    expect(sameValue(0, -0)).toBe(false);
  });
});

describe('a revision that moved underneath', () => {
  const typing = editDraft(openDraft('r1', recorded), { target: 0.6, statement: 'Mine' });
  const moved = receiveRevision(typing, 'r2', {
    statement: 'Mine',
    target: 0.5,
    unit: 'kg',
    priority: 'should',
  });

  it('reports what changed, and which changes collide with the edits', () => {
    expect(underneathChanges(moved)).toEqual([
      { field: 'statement', was: 'Carry the payload', now: 'Mine', mine: 'Mine', contested: false },
      { field: 'target', was: 0.3, now: 0.5, mine: 0.6, contested: true },
      { field: 'priority', was: 'must', now: 'should', contested: false },
    ]);
    expect(underneathChanges(typing)).toEqual([]);
  });

  it('keeps the edits on top of the newer revision when asked to', () => {
    const kept = keepEdits(moved);
    expect(kept.baseRevisionId).toBe('r2');
    expect(kept.form).toEqual({ statement: 'Mine', target: 0.6, unit: 'kg', priority: 'should' });
    expect(kept.incoming).toBeNull();
    // Only the field that still differs from r2 is dirty.
    expect(dirtyFields(kept)).toEqual(['target']);
  });

  it('shows the newer revision when the edits are discarded', () => {
    const dropped = discardDraft(moved);
    expect(dropped.baseRevisionId).toBe('r2');
    expect(dropped.form.target).toBe(0.5);
    expect(isDirty(dropped)).toBe(false);
  });

  it('returns to the recorded form on a plain discard', () => {
    const dropped = discardDraft(typing);
    expect(dropped.form).toEqual(recorded);
    expect(dropped.baseRevisionId).toBe('r1');
  });
});

describe('saving and reloading', () => {
  it('is clean on the new revision as soon as the save returns', () => {
    const typing = editDraft(openDraft('r1', recorded), { target: 0.6 });
    const saved = commitDraft('r2', typing.form);
    expect(saved.baseRevisionId).toBe('r2');
    expect(isDirty(saved)).toBe(false);
    // The history catching up with the saved revision does not disturb the form.
    expect(receiveRevision(saved, 'r2', { ...typing.form })).toBe(saved);
  });

  it('adopts a base that finished loading, without touching edits', () => {
    const waiting = openDraft<{ source: string }>('r1', { source: '' });
    expect(reloadBase(waiting, { source: 'cube(1);' }).form.source).toBe('cube(1);');
    const typing = editDraft(openDraft('r1', { source: 'cube(1);' }), { source: 'cube(2);' });
    const reloaded = reloadBase(typing, { source: 'cube(3);' });
    expect(reloaded.form.source).toBe('cube(2);');
    expect(reloaded.base.source).toBe('cube(3);');
    expect(reloadBase(typing, { source: 'cube(1);' })).toBe(typing);
  });
});

describe('where editing is offered', () => {
  const draft = { id: 'd', reviewState: 'draft' };
  it('allows the baseline of a writable project and nothing else for direct edits', () => {
    const on = (displayed: typeof draft | null, anchorId: string | null, readOnly = false) =>
      editability({ readOnly, displayed, anchorId, anchor: 'baseline' });
    expect(on({ id: 'b', reviewState: 'approved' }, 'b')).toEqual({ canEdit: true, reason: null });
    expect(on({ id: 'b', reviewState: 'approved' }, 'b', true).reason).toBe('read-only-project');
    expect(on(draft, 'b').reason).toBe('draft');
    expect(on(draft, null).reason).toBe('draft');
    expect(on({ id: 'p', reviewState: 'proposed' }, 'b').reason).toBe('in-review');
    expect(on({ id: 's', reviewState: 'superseded' }, 'b').reason).toBe('history');
    expect(on(null, 'b').reason).toBe('nothing-recorded');
  });
  it('allows only the newest active revision for a CAD candidate', () => {
    const on = (id: string) =>
      editability({
        readOnly: false,
        displayed: { ...draft, id },
        anchorId: 'n',
        anchor: 'newest',
      });
    expect(on('n').canEdit).toBe(true);
    expect(on('older').reason).toBe('not-newest');
  });
  it('has words for every reason', () => {
    for (const reason of [
      'read-only-project',
      'nothing-recorded',
      'draft',
      'in-review',
      'history',
      'not-newest',
    ] as const)
      expect(lockReasonText(reason).length).toBeGreaterThan(20);
  });
});
