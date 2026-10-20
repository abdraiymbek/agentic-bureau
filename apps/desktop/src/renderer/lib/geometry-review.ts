import type { ParsedMesh } from './stl-parse';
import type { ViewportStatus } from '../object/viewport/StlViewport';

export interface GeometryReview {
  revisionId: string;
  mesh: ParsedMesh | null;
  status: ViewportStatus;
}

/** A previously drawn revision cannot stand in for the geometry being accepted now. */
export function geometryReviewBlock(
  revisionId: string | undefined,
  mesh: ParsedMesh | null,
  review: GeometryReview | null,
): string | null {
  if (revisionId && mesh && review?.revisionId === revisionId && review.mesh === mesh) {
    if (review.status.state === 'shown') return null;
    if (review.status.state === 'error')
      return `The geometry cannot be reviewed: ${review.status.reason}`;
  }
  return 'The geometry has to be on screen before this draft can be accepted.';
}
