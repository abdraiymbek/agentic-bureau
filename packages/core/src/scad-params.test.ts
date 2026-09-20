import { describe, expect, it } from 'vitest';
import { ensureDefaultFaceting, parseScadParameters } from './scad-params.js';

describe('parseScadParameters', () => {
  it('still parses file-scope literals', () => {
    const p = parseScadParameters('w = 100;\n// hole\nhole_d = 8.4;\n$fn = 64;\n');
    expect(p.map((x) => [x.name, x.value, x.derived])).toEqual([
      ['w', 100, false],
      ['hole_d', 8.4, false],
      ['$fn', 64, false],
    ]);
  });

  it('exposes derived file-scope expressions and evaluates simple arithmetic', () => {
    const p = parseScadParameters(`
      plate_w = 60;
      plate_d = 40;
      height = 2 * plate_w;
      inset = plate_w / 2 - 5;
      label = "mount";
    `);
    const by = Object.fromEntries(p.map((x) => [x.name, x]));
    expect(by.height.derived).toBe(true);
    expect(by.height.expr).toBe('2 * plate_w');
    expect(by.height.value).toBe(120);
    expect(by.inset.derived).toBe(true);
    expect(by.inset.value).toBe(25);
    expect(by.label.value).toBe('mount');
    expect(by.label.derived).toBe(false);
  });

  it('does not treat module-internal assignments as parameters', () => {
    const p = parseScadParameters('w = 10;\nmodule m() { h = 99; cube(h); }\n');
    expect(p.map((x) => x.name)).toEqual(['w']);
  });
});

describe('ensureDefaultFaceting', () => {
  it('injects $fn when curved primitives are used without it', () => {
    const r = ensureDefaultFaceting('difference(){ cube(10); cylinder(d=4,h=12); }');
    expect(r.injected).toBe(true);
    expect(r.source).toMatch(/^\$fn = 64;/);
    expect(r.source).toContain('cylinder(d=4,h=12)');
  });

  it('does not inject when $fn is already set', () => {
    const src = '$fn = 12;\ncylinder(d=4,h=10);';
    const r = ensureDefaultFaceting(src);
    expect(r.injected).toBe(false);
    expect(r.source).toBe(src);
  });

  it('does not inject for prismatic-only source', () => {
    const r = ensureDefaultFaceting('cube([10,20,30]);');
    expect(r.injected).toBe(false);
  });
});
