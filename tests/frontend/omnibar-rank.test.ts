import { describe, expect, it } from 'vitest';
import {
  moveSelection,
  parseQuery,
  rank,
  scoreCandidate,
  type Candidate,
} from '../../apps/desktop/src/renderer/shell/omnibar/rank';

const objects: Candidate[] = [
  {
    id: 'o:tray',
    group: 'objects',
    label: 'Camera tray mount',
    keywords: 'Mechanical Chassis Approved',
  },
  {
    id: 'o:mass',
    group: 'objects',
    label: 'Rover mass budget',
    keywords: 'Calculation Out of date stale outdated changed',
  },
  {
    id: 'o:reg',
    group: 'objects',
    label: 'Pololu D24V22F5 5 V step-down regulator',
    keywords: 'Component',
  },
  {
    id: 'o:cap',
    group: 'objects',
    label: 'Payload capacity',
    keywords: 'Requirement Approved',
    recent: 0,
  },
];
const commands: Candidate[] = [
  { id: 'goto:flow', group: 'goto', label: 'Project flow', keywords: 'Flow map graph' },
  {
    id: 'agent:window',
    group: 'agent',
    label: 'Show the agent window',
    keywords: 'agent terminal console',
  },
  { id: 'act:settings', group: 'actions', label: 'Settings: Agents', keywords: 'preferences' },
  {
    id: 'act:theme',
    group: 'actions',
    label: 'Switch to Paper (light)',
    keywords: 'appearance theme',
  },
];
const all = [...objects, ...commands];
const ask = (text: string): Candidate => ({
  id: 'ask',
  group: 'ask',
  label: `Ask Codex: “${text}”`,
});

describe('omnibar ranking', () => {
  it('opens the object for a three-word title and lists asking the agent last, unselected', () => {
    const q = 'camera tray mount';
    const r = rank(all, q, ask(q));
    expect(r.flat[r.initial]!.id).toBe('o:tray');
    expect(r.flat[r.flat.length - 1]!.id).toBe('ask');
    expect(r.groups[r.groups.length - 1]!.id).toBe('ask');
  });

  it('never selects the ask item by default, even when nothing else matches', () => {
    const q = 'tighten the bolt pattern please';
    const r = rank(all, q, ask(q));
    expect(r.flat.map((i) => i.id)).toEqual(['ask']);
    expect(r.initial).toBe(-1);
  });

  it('selects the ask item only with the ask prefix, and searches nothing else then', () => {
    const r = rank(all, '> camera tray mount', ask('camera tray mount'));
    expect(r.flat.map((i) => i.id)).toEqual(['ask']);
    expect(r.initial).toBe(0);
    expect(parseQuery('>  why is it stale?')).toEqual({
      mode: 'ask',
      text: 'why is it stale?',
      tokens: [],
    });
    expect(rank(all, '>', ask('')).flat).toEqual([]);
  });

  it('matches words in any order', () => {
    const r = rank(all, 'tray camera', null);
    expect(r.flat[0]!.id).toBe('o:tray');
  });

  it('finds out-of-date objects by state and not unrelated commands by scattered letters', () => {
    const r = rank(all, 'stale', null);
    expect(r.flat.map((i) => i.id)).toEqual(['o:mass']);
  });

  it('requires every word to match', () => {
    expect(rank(all, 'camera regulator', null).flat).toEqual([]);
  });

  it('matches part numbers and word prefixes', () => {
    expect(rank(all, 'd24v', null).flat[0]!.id).toBe('o:reg');
    expect(rank(all, 'sett', null).flat[0]!.id).toBe('act:settings');
  });

  it('ranks a label match above a keyword match and boosts recent objects', () => {
    const items: Candidate[] = [
      { id: 'a', group: 'objects', label: 'Wheel torque', keywords: 'payload' },
      { id: 'b', group: 'objects', label: 'Payload ramp test' },
    ];
    expect(rank(items, 'payload', null).flat.map((i) => i.id)).toEqual(['b', 'a']);
    const q = parseQuery('payload');
    const plain = scoreCandidate(objects[3]!, q);
    expect(plain).toBeGreaterThan(scoreCandidate({ ...objects[3]!, recent: undefined }, q));
  });

  it('shows recents and every command, but not the whole object list, with an empty query', () => {
    const recent: Candidate = { id: 'r:o:cap', group: 'recent', label: 'Payload capacity' };
    const r = rank([...all, recent], '', null);
    expect(r.groups.map((g) => g.id)).toEqual(['recent', 'goto', 'agent', 'actions']);
    expect(r.flat.map((i) => i.id)).toEqual([
      'r:o:cap',
      'goto:flow',
      'agent:window',
      'act:settings',
      'act:theme',
    ]);
    expect(r.initial).toBe(0);
  });

  it('caps a group and says how many more matched', () => {
    const many: Candidate[] = Array.from({ length: 20 }, (_, i) => ({
      id: `o:${i}`,
      group: 'objects',
      label: `Bracket ${i}`,
    }));
    const r = rank([...many, ...commands], 'bracket', null);
    expect(r.groups[0]!.items).toHaveLength(12);
    expect(r.groups[0]!.more).toBe(8);
  });

  it('keeps commands reachable when many objects match', () => {
    const many: Candidate[] = Array.from({ length: 60 }, (_, i) => ({
      id: `o:${i}`,
      group: 'objects',
      label: `Agent note ${i}`,
    }));
    const r = rank([...many, ...commands], 'agent', null);
    expect(r.flat.some((i) => i.id === 'agent:window')).toBe(true);
  });

  it('moves the selection with wrapping', () => {
    expect(moveSelection(-1, 3, 1)).toBe(0);
    expect(moveSelection(-1, 3, -1)).toBe(2);
    expect(moveSelection(2, 3, 1)).toBe(0);
    expect(moveSelection(0, 3, -1)).toBe(2);
    expect(moveSelection(0, 0, 1)).toBe(-1);
  });
});
