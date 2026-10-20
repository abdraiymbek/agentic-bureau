import { describe, expect, it } from 'vitest';
import {
  geometryReviewBlock,
  type GeometryReview,
} from '../../apps/desktop/src/renderer/lib/geometry-review';
import type { ParsedMesh } from '../../apps/desktop/src/renderer/lib/stl-parse';

const mesh = {} as ParsedMesh;
const shown: GeometryReview = { revisionId: 'r1', mesh, status: { state: 'shown' } };

describe('accepting mechanical geometry', () => {
  it('waits for the same revision and mesh to be drawn', () => {
    expect(geometryReviewBlock('r1', mesh, null)).toMatch(/on screen/);
    expect(geometryReviewBlock('r1', mesh, shown)).toBeNull();
    expect(geometryReviewBlock('r2', mesh, shown)).toMatch(/on screen/);
    expect(geometryReviewBlock('r1', {} as ParsedMesh, shown)).toMatch(/on screen/);
    expect(geometryReviewBlock('r1', null, shown)).toMatch(/on screen/);
  });

  it('blocks unavailable, lost-context and failed boundary states until recovery', () => {
    for (const reason of ['No WebGL', 'The graphics context was lost.', 'Viewport render failed']) {
      expect(
        geometryReviewBlock('r1', mesh, { ...shown, status: { state: 'error', reason } }),
      ).toContain(reason);
    }
    expect(geometryReviewBlock('r1', mesh, { ...shown, status: { state: 'parsing' } })).toMatch(
      /on screen/,
    );
    expect(geometryReviewBlock('r1', mesh, shown)).toBeNull();
  });
});
