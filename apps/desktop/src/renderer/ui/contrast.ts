/**
 * WCAG contrast from colours as the browser resolves them, so the catalogue reports measured ratios
 * for the tokens actually in force rather than numbers copied into a table.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Reads `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()`, as computed styles report them. */
export function parseColor(value: string): Rgba | null {
  const v = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (hex) {
    const h = hex[1]!;
    const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(v);
  if (!fn) return null;
  const parts = fn[1]!.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channel = (p: string) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p));
  const alpha =
    parts[3] === undefined
      ? 1
      : parts[3].endsWith('%')
        ? parseFloat(parts[3]) / 100
        : parseFloat(parts[3]);
  const [r, g, b] = parts.slice(0, 3).map(channel) as [number, number, number];
  if ([r, g, b, alpha].some((x) => !Number.isFinite(x))) return null;
  return { r, g, b, a: alpha };
}

/** A translucent colour laid over an opaque one. */
export function composite(top: Rgba, under: Rgba): Rgba {
  const mix = (t: number, u: number) => t * top.a + u * (1 - top.a);
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a: 1 };
}

function luminance({ r, g, b }: Rgba) {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** The contrast ratio of a foreground (composited over the background) against the background. */
export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const fg = foreground.a < 1 ? composite(foreground, background) : foreground;
  const [hi, lo] = [luminance(fg), luminance(background)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** What a ratio is good for: body text (4.5:1), large text and lines (3:1), or neither. */
export function contrastGrade(ratio: number): 'AA text' | 'AA lines' | 'Below AA' {
  if (ratio >= 4.5) return 'AA text';
  if (ratio >= 3) return 'AA lines';
  return 'Below AA';
}
