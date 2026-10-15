import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  composite,
  contrastGrade,
  contrastRatio,
  parseColor,
  type Rgba,
} from '../../apps/desktop/src/renderer/ui/contrast';

const css = fs.readFileSync(new URL('../../design-system/tokens.css', import.meta.url), 'utf8');

function block(start: string) {
  const at = css.indexOf(start);
  expect(at, start).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('\n}', open));
}
function declarations(text: string) {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}
const root = declarations(block(':root {'));
const themes = {
  graphite: { ...root, ...declarations(block(":root,\n[data-theme='dark'] {")) },
  paper: { ...root, ...declarations(block("[data-theme='light'] {")) },
};
type Theme = keyof typeof themes;

function color(theme: Theme, token: string): Rgba {
  const t = themes[theme];
  let value = t[token];
  for (let i = 0; value?.startsWith('var('); i++) value = t[value.slice(4, -1)];
  const parsed = value ? parseColor(value) : null;
  if (!parsed) throw new Error(`${theme} ${token} is not a colour: ${value}`);
  return parsed;
}
/** A background token, with translucent tints laid over `under`. */
function ground(theme: Theme, token: string, under = '--surface'): Rgba {
  const c = color(theme, token);
  return c.a < 1 ? composite(c, color(theme, under)) : c;
}
const ratio = (theme: Theme, fg: string, bg: string, under?: string) =>
  contrastRatio(color(theme, fg), ground(theme, bg, under));

const SURFACES = ['--field', '--surface', '--raised', '--raised-2', '--inset'];

describe('contrast helpers', () => {
  it('reads the colour forms computed styles report', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#0b0c0e80')?.a).toBeCloseTo(0.5, 2);
    expect(parseColor('rgba(207, 243, 110, 0.1)')).toEqual({ r: 207, g: 243, b: 110, a: 0.1 });
    expect(parseColor('rgb(0 0 0 / 50%)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseColor('var(--x)')).toBeNull();
  });

  it('measures WCAG ratios, compositing translucent colours', () => {
    const black = parseColor('#000')!;
    const white = parseColor('#fff')!;
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
    expect(contrastRatio({ ...black, a: 0 }, white)).toBeCloseTo(1, 5);
    expect(composite({ ...black, a: 0.5 }, white).r).toBeCloseTo(127.5, 5);
    expect(contrastGrade(4.5)).toBe('AA text');
    expect(contrastGrade(3.2)).toBe('AA lines');
    expect(contrastGrade(2.9)).toBe('Below AA');
  });
});

describe('tokens meet their contrast roles in both themes', () => {
  for (const theme of Object.keys(themes) as Theme[]) {
    it(`${theme}: text, supporting and metadata text are AA on every surface`, () => {
      for (const fg of ['--text', '--text-2', '--text-3'])
        for (const bg of SURFACES)
          expect(ratio(theme, fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    });

    it(`${theme}: state words are AA on their own tint over the field, stage and islands`, () => {
      for (const tone of ['ok', 'warn', 'err'])
        for (const under of ['--field', '--surface', '--raised'])
          expect(
            ratio(theme, `--${tone}`, `--${tone}-soft`, under),
            `${tone} over ${under}`,
          ).toBeGreaterThanOrEqual(4.5);
      expect(ratio(theme, '--signal-text', '--signal-soft')).toBeGreaterThanOrEqual(4.5);
      expect(ratio(theme, '--field', '--warn')).toBeGreaterThanOrEqual(4.5);
    });

    it(`${theme}: signal drawn as a line, ring or dot, and the focus ring, reach 3:1`, () => {
      for (const bg of SURFACES) {
        expect(ratio(theme, '--signal-stroke', bg), `stroke on ${bg}`).toBeGreaterThanOrEqual(3);
        expect(ratio(theme, '--focus', bg), `focus on ${bg}`).toBeGreaterThanOrEqual(3);
      }
      for (const bg of ['--field', '--surface', '--raised'])
        expect(ratio(theme, '--text-4', bg), `text-4 on ${bg}`).toBeGreaterThanOrEqual(3);
    });

    it(`${theme}: fills keep their ink readable`, () => {
      expect(ratio(theme, '--signal-ink', '--signal')).toBeGreaterThanOrEqual(7);
      expect(ratio(theme, '--signal-ink', '--signal-hover')).toBeGreaterThanOrEqual(7);
      expect(ratio(theme, '--primary-ink', '--primary')).toBeGreaterThanOrEqual(7);
      expect(ratio(theme, '--text', '--pressed')).toBeGreaterThanOrEqual(7);
    });

    it(`${theme}: terminal colours are readable on the terminal background`, () => {
      expect(ratio(theme, '--terminal-fg', '--terminal-bg')).toBeGreaterThanOrEqual(7);
      expect(ratio(theme, '--terminal-cursor', '--terminal-bg')).toBeGreaterThanOrEqual(3);
      const names = Object.keys(themes[theme]).filter((k) => k.startsWith('--ansi-'));
      expect(names).toHaveLength(16);
      for (const name of names) {
        // On a dark terminal "black" is a background colour; every other colour is text.
        const min = theme === 'graphite' && name === '--ansi-black' ? 2.5 : 4.5;
        expect(ratio(theme, name, '--terminal-bg'), name).toBeGreaterThanOrEqual(min);
      }
    });
  }

  it('defines every theme role in both themes', () => {
    const graphite = Object.keys(declarations(block(":root,\n[data-theme='dark'] {"))).sort();
    const paper = Object.keys(declarations(block("[data-theme='light'] {"))).sort();
    expect(paper).toEqual(graphite);
  });
});
