import { describe, expect, it } from 'vitest';
import {
  ZOOM_STEPS,
  fitScale,
  stepZoom,
  svgNaturalSize,
} from '../../apps/desktop/src/renderer/lib/diagram';

describe('diagram sizing', () => {
  it('reads the drawn size from the viewBox, else from pixel dimensions', () => {
    expect(svgNaturalSize('<svg xmlns="x" viewBox="0 0 1220 238" width="100%">')).toEqual({
      width: 1220,
      height: 238,
    });
    expect(svgNaturalSize(`<svg width='320' height="80px"><text/></svg>`)).toEqual({
      width: 320,
      height: 80,
    });
    expect(svgNaturalSize('<svg viewBox="0,0,10,5">')).toEqual({ width: 10, height: 5 });
  });
  it('has no size for a drawing that does not state one', () => {
    for (const svg of ['<svg width="100%" height="50%">', '<svg viewBox="0 0 0 10">', '<p>no</p>'])
      expect(svgNaturalSize(svg)).toBeNull();
  });
  it('steps between fixed zoom stops and stays inside them', () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(0.646, 1)).toBe(0.75);
    expect(stepZoom(0.646, -1)).toBe(0.5);
    expect(stepZoom(3, 1)).toBe(ZOOM_STEPS[ZOOM_STEPS.length - 1]);
    expect(stepZoom(0.5, -1)).toBe(ZOOM_STEPS[0]);
  });
  it('fits the drawing to the available width', () => {
    expect(fitScale({ width: 1220, height: 238 }, 610)).toBe(0.5);
    expect(fitScale({ width: 1220, height: 238 }, 0)).toBe(1);
  });
});
