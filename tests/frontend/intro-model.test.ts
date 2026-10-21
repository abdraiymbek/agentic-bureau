import { describe, expect, it } from 'vitest';
import {
  ARRIVE_MS,
  SCENES,
  engineInstallHint,
  fitScale,
  introNavKey,
  nextScene,
  platformOf,
  prevScene,
  primerFor,
  sceneIndex,
  settingsFolder,
} from '../../apps/desktop/src/renderer/intro/model';
import {
  COLS,
  FOCUS,
  LINKS,
  NODE,
  NODES,
  NODE_W,
  ORIGIN,
  WORLD,
  downstream,
  linkPath,
} from '../../apps/desktop/src/renderer/intro/rover';
import {
  INTRO_VERSION,
  introDue,
  parseIntroSeen,
  serializeIntroSeen,
} from '../../apps/desktop/src/renderer/lib/preferences';

describe('the order of scenes', () => {
  it('plays four acts, then five setup steps, each once', () => {
    expect(SCENES.map((s) => s.kind)).toEqual([
      'act',
      'act',
      'act',
      'act',
      'setup',
      'setup',
      'setup',
      'setup',
      'setup',
    ]);
    expect(new Set(SCENES.map((s) => s.id)).size).toBe(SCENES.length);
    expect(SCENES[0]!.id).toBe('arrive');
    expect(SCENES[SCENES.length - 1]!.id).toBe('local');
  });

  it('steps forward and back along the list and stops at its ends', () => {
    expect(nextScene('arrive')).toBe('whole');
    expect(nextScene('decide')).toBe('agent');
    expect(nextScene('local')).toBeNull();
    expect(prevScene('arrive')).toBeNull();
    expect(prevScene('agent')).toBe('decide');
    expect(sceneIndex('one')).toBe(2);
    expect(ARRIVE_MS).toBeGreaterThan(0);
  });
});

describe('what the keyboard does', () => {
  const press = (
    key: string,
    mods: Partial<{ mod: boolean; shift: boolean; alt: boolean }> = {},
  ) => ({
    key,
    mod: false,
    shift: false,
    alt: false,
    ...mods,
  });

  it('continues on → and Enter, goes back on ←, skips on Escape', () => {
    expect(introNavKey(press('ArrowRight'), 'workspace')).toBe('next');
    expect(introNavKey(press('Enter'), 'workspace')).toBe('next');
    expect(introNavKey(press('ArrowLeft'), 'workspace')).toBe('back');
    expect(introNavKey(press('Escape'), 'workspace')).toBe('skip');
    expect(introNavKey(press('a'), 'workspace')).toBeNull();
  });

  it('leaves Enter to a focused control and every key but Escape to a text field', () => {
    expect(introNavKey(press('Enter'), 'button')).toBeNull();
    expect(introNavKey(press('ArrowRight'), 'button')).toBe('next');
    expect(introNavKey(press('ArrowRight'), 'field')).toBeNull();
    expect(introNavKey(press('Enter'), 'field')).toBeNull();
    expect(introNavKey(press('Escape'), 'field')).toBe('skip');
  });

  it('ignores chords, which belong to the primer or to nothing', () => {
    expect(introNavKey(press('ArrowRight', { mod: true }), 'workspace')).toBeNull();
    expect(introNavKey(press('Enter', { shift: true }), 'workspace')).toBeNull();
    expect(introNavKey(press('Escape', { alt: true }), 'workspace')).toBeNull();
  });

  it('lights the primer row a real shortcut would use', () => {
    expect(primerFor(press('k', { mod: true }))).toBe('omnibar');
    expect(primerFor(press('K', { mod: true }))).toBe('omnibar');
    expect(primerFor(press('1', { mod: true }))).toBe('flow');
    expect(primerFor(press('j', { mod: true }))).toBe('agent');
    expect(primerFor(press('d', { mod: true, shift: true }))).toBe('decisions');
    expect(primerFor(press('Escape'))).toBe('escape');
    expect(primerFor(press('d', { mod: true }))).toBeNull();
    expect(primerFor(press('k'))).toBeNull();
    expect(primerFor(press('k', { mod: true, alt: true }))).toBeNull();
  });
});

describe('fitting the map', () => {
  it('fits the smaller of width and height, within sensible bounds', () => {
    const designed = fitScale({ width: 1440, height: 900 }, WORLD);
    const smallest = fitScale({ width: 1024, height: 700 }, WORLD);
    expect(designed).toBeGreaterThan(smallest);
    expect(designed * WORLD.width).toBeLessThanOrEqual(1440 - 96);
    expect(smallest * WORLD.width).toBeLessThanOrEqual(1024 - 96);
    expect(fitScale({ width: 4000, height: 3000 }, WORLD)).toBe(1.1);
    expect(fitScale({ width: 200, height: 200 }, WORLD)).toBe(0.42);
  });
});

describe('the rover map', () => {
  it('places every object in its layer column, left to right, without overlap', () => {
    const cols = new Set(COLS);
    for (const n of NODES) expect(cols.has(n.x as (typeof COLS)[number])).toBe(true);
    const seen = new Set<string>();
    for (const n of NODES) {
      const key = `${n.x}:${n.y}`;
      expect(seen.has(key), n.id).toBe(false);
      seen.add(key);
    }
    expect(WORLD.width).toBe(COLS[4] + NODE_W);
  });

  it('links run from an input to a consequence on its right, or loop within a column', () => {
    for (const l of LINKS) expect(l.b.x, l.key).toBeGreaterThanOrEqual(l.a.x);
    expect(linkPath(NODE.payload!, NODE.tray!)).toMatch(/^M216 \d+ C/);
    const loop = linkPath(NODE.mass!, NODE.torque!);
    expect(loop.startsWith(`M${NODE.mass!.x + NODE_W} `)).toBe(true);
    expect(loop.endsWith(`${NODE.torque!.x + NODE_W} ${NODE.torque!.cy}`)).toBe(true);
  });

  it('draws later columns later, so the map builds from intent to evidence', () => {
    for (const l of LINKS) expect(l.delay).toBeGreaterThan(Math.max(l.a.delay, l.b.delay));
    expect(NODE.ramp!.delay).toBeGreaterThan(NODE.payload!.delay);
  });

  it('lights the whole thread downstream of the payload requirement, in waves', () => {
    const thread = downstream(ORIGIN);
    expect([...thread.nodes].sort()).toEqual(['mass', 'payload', 'ramp', 'torque', 'tray']);
    expect(thread.wave).toMatchObject({
      payload: 0,
      'payload>tray': 0,
      'payload>mass': 0,
      tray: 1,
      mass: 1,
      'mass>torque': 1,
      torque: 2,
      'torque>ramp': 2,
      ramp: 3,
    });
    expect(thread.nodes.has(FOCUS)).toBe(true);
    expect(downstream('ramp').nodes).toEqual(new Set(['ramp']));
  });
});

describe('platform copy', () => {
  it('tells the platform from the browser and words the engine install for it', () => {
    expect(platformOf('Mozilla (Macintosh; Mac OS X)', 'MacIntel')).toBe('mac');
    expect(platformOf('Mozilla (X11; Linux x86_64)', 'Linux x86_64')).toBe('linux');
    expect(platformOf('Mozilla (Windows NT)', 'Win32')).toBe('other');
    expect(engineInstallHint('mac').command).toBe('brew install --cask openscad@snapshot');
    expect(engineInstallHint('linux').command).toBe('sudo apt install openscad');
    expect(engineInstallHint('other').command).toBeNull();
    expect(settingsFolder('mac')).toContain('app.omenflow.desktop');
    expect(settingsFolder('linux')).toBe('~/.local/share/app.omenflow.desktop');
  });
});

describe('remembering the introduction', () => {
  it('is due until this version has been seen, and again when the version rises', () => {
    expect(introDue(parseIntroSeen(null))).toBe(true);
    expect(introDue(parseIntroSeen('{oops'))).toBe(true);
    expect(introDue(parseIntroSeen(JSON.stringify({ version: 'one' })))).toBe(true);
    const seen = serializeIntroSeen(INTRO_VERSION, '2026-10-21T00:00:00.000Z');
    expect(parseIntroSeen(seen)).toBe(INTRO_VERSION);
    expect(introDue(parseIntroSeen(seen))).toBe(false);
    expect(introDue(INTRO_VERSION + 1)).toBe(false);
    expect(introDue(INTRO_VERSION - 1)).toBe(true);
  });
});
