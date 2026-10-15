/** Sizing for a recorded or derived SVG so its text can be read at a known scale. */

export interface DiagramSize {
  width: number;
  height: number;
}

const LENGTH = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/;

/** The size the SVG was drawn at: its viewBox, else unitless or pixel width and height. */
export function svgNaturalSize(svg: string): DiagramSize | null {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!tag) return null;
  const attribute = (name: string) =>
    new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1];
  const box = attribute('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (box?.length === 4 && box.every(Number.isFinite) && box[2]! > 0 && box[3]! > 0)
    return { width: box[2]!, height: box[3]! };
  const width = LENGTH.exec(attribute('width') ?? '')?.[1];
  const height = LENGTH.exec(attribute('height') ?? '')?.[1];
  return width && height && Number(width) > 0 && Number(height) > 0
    ? { width: Number(width), height: Number(height) }
    : null;
}

export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/** The next zoom stop above or below the current scale. */
export function stepZoom(scale: number, direction: 1 | -1): number {
  const stops = direction > 0 ? ZOOM_STEPS : [...ZOOM_STEPS].reverse();
  return (
    stops.find((s) => (direction > 0 ? s > scale + 1e-6 : s < scale - 1e-6)) ??
    stops[stops.length - 1]!
  );
}

/** The scale at which the drawing exactly fills the available width. */
export function fitScale(natural: DiagramSize, availableWidth: number): number {
  return availableWidth > 0 ? availableWidth / natural.width : 1;
}
