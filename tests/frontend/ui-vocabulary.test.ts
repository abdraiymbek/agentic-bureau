import { describe, expect, it } from 'vitest';
import { workStatusKinds } from '@bureau/contracts';
import {
  VOCABULARY,
  stateLabel,
  stateTone,
  stateWord,
} from '../../apps/desktop/src/renderer/ui/vocabulary';
import { ariaShortcut, displayShortcut } from '../../apps/desktop/src/renderer/ui/shortcuts';

describe('state vocabulary', () => {
  it('names review in four words: draft, in review, approved, changes requested', () => {
    expect(stateLabel('draft', 'review')).toBe('Draft');
    expect(stateLabel('proposed', 'review')).toBe('In review');
    expect(stateLabel('approved', 'review')).toBe('Approved');
    expect(stateLabel('changes_requested', 'review')).toBe('Changes requested');
  });

  it('uses the same words for a proposal as for a revision', () => {
    expect(stateLabel('pending')).toBe('In review');
    expect(stateLabel('accepted')).toBe('Approved');
    expect(stateTone('pending')).toBe(stateTone('proposed', 'review'));
  });

  it('keeps freshness separate: current, out of date', () => {
    expect(stateWord('current')).toEqual({ label: 'Current', tone: 'ok' });
    expect(stateWord('stale')).toEqual({ label: 'Out of date', tone: 'warn' });
  });

  it('separates a recorded test verdict from CAD verification', () => {
    expect(stateLabel('passed')).toBe('Passed');
    expect(stateLabel('passed', 'verification')).toBe('Verified');
    expect(stateLabel('partial', 'verification')).toBe('Partly verified');
    expect(stateLabel('partial', 'evidence')).toBe('Partly covered');
  });

  it('names what the completion gate reports in words, and a kind it does not know in sentence case', () => {
    expect(stateLabel('component_unsourced', 'work')).toBe('No source');
    expect(stateLabel('cad_spec_unasserted', 'work')).toBe('Spec not asserted');
    expect(stateWord('draft_unproposed', 'work').tone).toBe('neutral');
    expect(stateWord('requirement_unchecked', 'work')).toEqual({
      label: 'Requirement unchecked',
      tone: 'neutral',
    });
  });

  it('has its own words for every kind work_status reports', () => {
    for (const kind of workStatusKinds) expect(VOCABULARY.work).toHaveProperty(kind);
  });

  it('names listed CAD items apart from the verification they belong to', () => {
    expect(stateWord('unasserted', 'spec')).toEqual({ label: 'Not asserted', tone: 'warn' });
    expect(stateWord('not_shown', 'spec')).toEqual({ label: 'Not shown', tone: 'neutral' });
    expect(stateLabel('passed', 'spec')).toBe('Passed');
    expect(stateTone('failed', 'spec')).toBe('err');
    // Looked up without a dimension, "passed" still reads as a test verdict.
    expect(stateLabel('unasserted')).toBe('Unasserted');
  });

  it('marks only running work as live', () => {
    for (const [dimension, words] of Object.entries(VOCABULARY))
      for (const [state, word] of Object.entries(words))
        if (word.tone === 'signal')
          expect([dimension, state]).toEqual(['execution', expect.any(String)]);
    expect(stateTone('running')).toBe('signal');
    expect(stateTone('exited')).toBe('neutral');
  });

  it('labels an unrecognised state in sentence case instead of hiding it', () => {
    expect(stateWord('read-only')).toEqual({ label: 'Read only', tone: 'neutral' });
    expect(stateWord('')).toEqual({ label: 'Unknown state', tone: 'neutral' });
  });

  it('gives every word sentence case', () => {
    for (const words of Object.values(VOCABULARY))
      for (const { label } of Object.values(words)) {
        expect(label[0]).toBe(label[0]!.toUpperCase());
        expect(label.slice(1)).toBe(label.slice(1).toLowerCase());
      }
  });
});

describe('shortcuts', () => {
  it('shows Mac symbols on a Mac and Ctrl elsewhere', () => {
    expect(displayShortcut('⌘⇧D', true)).toBe('⌘⇧D');
    expect(displayShortcut('⌘⇧D', false)).toBe('Ctrl+Shift+D');
    expect(displayShortcut('⌘↵', false)).toBe('Ctrl+Enter');
    expect(displayShortcut('⌘1–4', false)).toBe('Ctrl+1–4');
    expect(displayShortcut('esc', false)).toBe('esc');
  });

  it('announces real key names', () => {
    expect(ariaShortcut('⌘↵', true)).toBe('Meta+Enter');
    expect(ariaShortcut('⌘↵', false)).toBe('Control+Enter');
    expect(ariaShortcut('⌘⇧D', true)).toBe('Meta+Shift+D');
    expect(ariaShortcut('⌘,', true)).toBe('Meta+,');
    expect(ariaShortcut('esc', true)).toBe('Escape');
    expect(ariaShortcut('⌘1–4', true)).toBeUndefined();
  });
});
