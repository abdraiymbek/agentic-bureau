import { describe, expect, it } from 'vitest';
import {
  clearHandoff,
  confirmRead,
  forgetNotes,
  notesFor,
  projectReview,
  readCheck,
  recordDecision,
  setQueue,
  updateNotes,
} from '../../apps/desktop/src/renderer/decide/memory';
import { listVersion } from '../../apps/desktop/src/renderer/decide/model';
import { recordOf } from '../../apps/desktop/src/renderer/decide/handoff';
import { artifact, detail, ids, proposal } from './decide-fixtures';

let n = 0;
const project = () => `project-${++n}`;
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('the reviewer’s work survives refreshes', () => {
  it('keeps the rationale, open sections, scopes and scroll through identical refreshes', () => {
    const pid = project();
    const first = detail();
    expect(readCheck(pid, first, true)).toEqual([]);
    updateNotes(pid, ids.p1, {
      rationale: 'Sensor package confirmed at 480 g',
      open: { '0:content': true },
      scopes: { [ids.req]: 'e'.repeat(64) },
      scrollTop: 640,
    });
    // A background refresh of the list replaces every object but changes nothing: no re-read.
    const p = proposal();
    expect(listVersion(copy(p), () => ids.r1)).toBe(listVersion(p, () => ids.r1));
    // A refresh of the proposal itself returns an equal record: nothing to re-read.
    expect(readCheck(pid, copy(first), true)).toEqual([]);
    expect(notesFor(pid, ids.p1)).toMatchObject({
      rationale: 'Sensor package confirmed at 480 g',
      open: { '0:content': true },
      scopes: { [ids.req]: 'e'.repeat(64) },
      scrollTop: 640,
    });
  });

  it('flags a proposal that changed underneath until the person confirms re-reading it', () => {
    const pid = project();
    readCheck(pid, detail(), true);
    updateNotes(pid, ids.p1, { rationale: 'draft' });
    const moved = detail({ change: { artifact: artifact(ids.r3) } });
    expect(readCheck(pid, moved, true)).toEqual([
      'It is now “Base moved” (it was “Needs you”).',
      'Payload capacity: its baseline moved while this was open.',
    ]);
    expect(readCheck(pid, moved, true)).toHaveLength(2);
    expect(notesFor(pid, ids.p1).rationale).toBe('draft');
    confirmRead(pid, moved);
    expect(readCheck(pid, moved, true)).toEqual([]);
    expect(notesFor(pid, ids.p1).rationale).toBe('draft');
  });

  it('does not take a cached copy as what the person read', () => {
    const pid = project();
    const cached = detail();
    expect(readCheck(pid, cached, false)).toEqual([]);
    expect(notesFor(pid, ids.p1).read).toBeNull();
    const fresh = detail({ proposal: { state: 'accepted' } });
    expect(readCheck(pid, fresh, true)).toEqual([]);
    expect(notesFor(pid, ids.p1).read?.detail.proposal.state).toBe('accepted');
  });

  it('forgets a draft once it became the record, and bounds what it keeps', () => {
    const pid = project();
    updateNotes(pid, ids.p1, { rationale: 'recorded' });
    forgetNotes(pid, ids.p1);
    expect(notesFor(pid, ids.p1).rationale).toBe('');
    for (let i = 0; i < 45; i++) updateNotes(pid, `p${i}`, { rationale: String(i) });
    updateNotes(pid, 'p0', { rationale: 'touched again' });
    expect(projectReview(pid).notes.size).toBe(40);
    expect(notesFor(pid, 'p0').rationale).toBe('touched again');
    expect(notesFor(pid, 'p1').rationale).toBe('');
  });

  it('keeps each project’s queue position and handoff apart', () => {
    const a = project();
    const b = project();
    setQueue(a, { filter: 'all', selected: ids.p2 });
    expect(projectReview(a)).toMatchObject({ filter: 'all', selected: ids.p2 });
    expect(projectReview(b)).toMatchObject({ filter: 'open', selected: null });
    recordDecision(a, recordOf(detail(), 'approved', '', []));
    expect(projectReview(a).handoff).toHaveLength(1);
    expect(projectReview(b).handoff).toHaveLength(0);
    clearHandoff(a);
    expect(projectReview(a).handoff).toHaveLength(0);
  });
});
