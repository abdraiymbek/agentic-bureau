import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROJECT_PREFS,
  DEFAULT_RAILS,
  parseProjectPrefs,
  parseRails,
  parseRecents,
  parseTheme,
  parseView,
  readRaw,
  serializeProjectPrefs,
  writeRaw,
} from '../../apps/desktop/src/renderer/lib/preferences';

const isLens = (id: string) => ['flow', 'parts', 'timeline', 'files'].includes(id);

afterEach(() => vi.unstubAllGlobals());

describe('preference parsing', () => {
  it('reads the theme, defaulting to Graphite', () => {
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme(null)).toBe('dark');
    expect(parseTheme('sepia')).toBe('dark');
  });

  it('round-trips project preferences', () => {
    const prefs = {
      view: { level: 'object' as const, id: 'a1' },
      lens: 'parts' as const,
      agentWindowOpen: true,
    };
    expect(parseProjectPrefs(serializeProjectPrefs(prefs), isLens)).toEqual(prefs);
  });

  it('keeps what it can read from a damaged or foreign value', () => {
    expect(parseProjectPrefs(null, isLens)).toBe(DEFAULT_PROJECT_PREFS);
    expect(parseProjectPrefs('{oops', isLens)).toBe(DEFAULT_PROJECT_PREFS);
    expect(parseProjectPrefs('[1]', isLens)).toBe(DEFAULT_PROJECT_PREFS);
    expect(
      parseProjectPrefs(
        JSON.stringify({
          view: { level: 'project', lens: 'evidence' },
          lens: 'files',
          agentWindowOpen: 'yes',
        }),
        isLens,
      ),
    ).toEqual({ view: null, lens: 'files', agentWindowOpen: false });
  });

  it('accepts only views it can return to', () => {
    expect(parseView({ level: 'agent' }, isLens)).toEqual({ level: 'agent' });
    expect(parseView({ level: 'decide' }, isLens)).toEqual({ level: 'decide', proposalId: null });
    expect(parseView({ level: 'decide', proposalId: 'p' }, isLens)).toEqual({
      level: 'decide',
      proposalId: 'p',
    });
    expect(parseView({ level: 'object', id: '' }, isLens)).toBeNull();
    expect(parseView({ level: 'system' }, isLens)).toBeNull();
    expect(parseView('object', isLens)).toBeNull();
  });

  it('reads rail and recent-object preferences tolerantly', () => {
    expect(parseRails(JSON.stringify({ inputs: true }))).toEqual({
      inputs: true,
      consequences: false,
    });
    expect(parseRails('nope')).toBe(DEFAULT_RAILS);
    expect(parseRecents(JSON.stringify(['a', 3, '', 'b', 'c']), 2)).toEqual(['a', 'b']);
    expect(parseRecents('{"a":1}', 8)).toEqual([]);
  });

  it('works without storage, or with storage that throws', () => {
    expect(readRaw('omen.theme')).toBeNull();
    expect(() => writeRaw('omen.theme', 'light')).not.toThrow();
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    });
    expect(readRaw('omen.theme')).toBeNull();
    expect(() => writeRaw('omen.theme', 'light')).not.toThrow();
  });
});
