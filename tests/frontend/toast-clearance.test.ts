import { describe, expect, it } from 'vitest';
import { toastClearance } from '../../apps/desktop/src/renderer/frame/toast-clearance';

const view = { width: 1440, height: 900 };
const stack = { width: 300, height: 44 };
const box = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

describe('toast clearance', () => {
  it('rests at the edge when nothing it would cover is near the bottom', () => {
    expect(toastClearance(view, stack, [])).toBe(16);
    // A save bar in the middle of a short stage is above the stack, not under it.
    expect(toastClearance(view, stack, [box(310, 520, 1100, 580)])).toBe(16);
    // A control at the bottom but left of the stack is beside it.
    expect(toastClearance(view, stack, [box(60, 840, 700, 884)])).toBe(16);
  });

  it('rises above a control pinned under it', () => {
    // The decision bar across the bottom of the stage.
    expect(toastClearance(view, stack, [box(310, 760, 1190, 880)])).toBe(900 - 760 + 8);
  });

  it('measures the stack it has, and assumes the widest toast before it can measure', () => {
    const narrowControl = box(1000, 840, 1100, 884);
    expect(toastClearance(view, stack, [narrowControl])).toBe(16);
    expect(toastClearance(view, { width: 0, height: 0 }, [narrowControl])).toBe(900 - 840 + 8);
  });

  it('keeps rising while the next control up would still be covered', () => {
    const footer = box(1100, 850, 1430, 890);
    const above = box(1100, 790, 1430, 840);
    expect(toastClearance(view, stack, [above, footer])).toBe(900 - 790 + 8);
  });
});
