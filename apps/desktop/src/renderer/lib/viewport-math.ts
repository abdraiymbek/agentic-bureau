/**
 * Geometry behind the viewport tools, free of three.js so it can be tested on its own.
 * The frame is the one the core renders in: right-handed, Z up, model units.
 */
import type { MeshBounds } from './stl-parse';

export type Vec3 = [number, number, number];
export type Axis = 'x' | 'y' | 'z';

export const AXES: Axis[] = ['x', 'y', 'z'];
const AXIS_INDEX: Record<Axis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

export function axisIndex(axis: Axis): 0 | 1 | 2 {
  return AXIS_INDEX[axis];
}

export function boundsSize(bounds: MeshBounds): Vec3 {
  return [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];
}

export function boundsCenter(bounds: MeshBounds): Vec3 {
  return [
    (bounds.max[0] + bounds.min[0]) / 2,
    (bounds.max[1] + bounds.min[1]) / 2,
    (bounds.max[2] + bounds.min[2]) / 2,
  ];
}

/** Radius of the sphere around the bounds centre that contains the whole envelope. */
export function boundsRadius(bounds: MeshBounds): number {
  const [x, y, z] = boundsSize(bounds);
  return Math.hypot(x, y, z) / 2;
}

export function unionBounds(a: MeshBounds, b: MeshBounds): MeshBounds {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

/**
 * Side by side, the comparison sits on the low-X side of the part with a clear gap between
 * them. This is how far it is moved along X to get there.
 */
export function sideBySideShift(part: MeshBounds, other: MeshBounds): number {
  const gap = Math.max(boundsSize(part)[0], boundsSize(other)[0]) * 0.2;
  return part.min[0] - gap - other.max[0];
}

/** The envelope of everything drawn: the part, and the comparison where it is placed. */
export function drawnExtent(
  part: MeshBounds,
  other: MeshBounds | null,
  sideBySide: boolean,
): MeshBounds {
  if (!other) return part;
  const shift = sideBySide ? sideBySideShift(part, other) : 0;
  return unionBounds(part, {
    min: [other.min[0] + shift, other.min[1], other.min[2]],
    max: [other.max[0] + shift, other.max[1], other.max[2]],
  });
}

/** Lengths print with two decimals and always with their unit. */
export function formatLength(value: number, unit: string): string {
  return `${value.toFixed(2)} ${unit}`;
}

export function formatEnvelope(bounds: MeshBounds, unit: string): string {
  return `${boundsSize(bounds)
    .map((v) => v.toFixed(2))
    .join(' × ')} ${unit}`;
}

/* ------------------------------------------------------------------ */
/* Section plane                                                        */
/* ------------------------------------------------------------------ */

export interface SectionSetting {
  axis: Axis;
  /** 0 at the low face of the envelope, 1 at the high face. */
  fraction: number;
  /** Keep the high side instead of the low side. */
  flipped: boolean;
}

export function clampFraction(fraction: number): number {
  return Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0.5;
}

/** Where the plane sits along its axis, in model units. */
export function sectionCoordinate(bounds: MeshBounds, section: SectionSetting): number {
  const i = axisIndex(section.axis);
  return bounds.min[i] + (bounds.max[i] - bounds.min[i]) * clampFraction(section.fraction);
}

/**
 * The clipping plane as `normal · p + constant >= 0` for points that stay visible. By default
 * the low side of the axis is kept, so the cut face looks toward the positive axis.
 */
export function sectionPlane(
  bounds: MeshBounds,
  section: SectionSetting,
): { normal: Vec3; constant: number } {
  const at = sectionCoordinate(bounds, section);
  const sign = section.flipped ? 1 : -1;
  const normal: Vec3 = [0, 0, 0];
  normal[axisIndex(section.axis)] = sign;
  return { normal, constant: -sign * at };
}

/** True when the section keeps this point. Points on the plane are kept. */
export function keptBySection(point: Vec3, plane: { normal: Vec3; constant: number }): boolean {
  return (
    plane.normal[0] * point[0] +
      plane.normal[1] * point[1] +
      plane.normal[2] * point[2] +
      plane.constant >=
    0
  );
}

/* ------------------------------------------------------------------ */
/* Measure                                                              */
/* ------------------------------------------------------------------ */

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

export interface Measurement {
  distance: number;
  /** Signed offset from the first point to the second along each model axis. */
  delta: Vec3;
}

export function measure(a: Vec3, b: Vec3): Measurement {
  return { distance: distance(a, b), delta: [b[0] - a[0], b[1] - a[1], b[2] - a[2]] };
}

export interface PickedPoint {
  point: Vec3;
  /** The point is a mesh vertex, not an arbitrary place on a face. */
  onVertex: boolean;
}

/**
 * A pick on a triangle snaps to the nearest of its corners when that corner is within the
 * tolerance; otherwise it stays exactly where the face was hit and is reported as such.
 */
export function snapToVertex(hit: Vec3, corners: Vec3[], tolerance: number): PickedPoint {
  let best: Vec3 | null = null;
  let bestDistance = Infinity;
  for (const corner of corners) {
    const d = distance(hit, corner);
    if (d < bestDistance) {
      best = corner;
      bestDistance = d;
    }
  }
  return best && bestDistance <= tolerance
    ? { point: [...best], onVertex: true }
    : { point: [...hit], onVertex: false };
}

/** Model units covered by one screen pixel at a given distance from the camera. */
export function unitsPerPixel(input: {
  orthographic: boolean;
  /** Perspective: vertical field of view in degrees. */
  fov: number;
  /** Orthographic: visible height in model units (after zoom). */
  viewHeight: number;
  distance: number;
  viewportHeightPx: number;
}): number {
  const height = input.orthographic
    ? input.viewHeight
    : 2 * input.distance * Math.tan((input.fov * Math.PI) / 360);
  return height / Math.max(1, input.viewportHeightPx);
}

/* ------------------------------------------------------------------ */
/* Camera                                                               */
/* ------------------------------------------------------------------ */

export type StandardView = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso';

export interface ViewDirection {
  label: string;
  /** Number-row key that selects it. */
  key: string;
  /** Unit vector from the target toward the camera. */
  from: Vec3;
  up: Vec3;
}

const ISO = 1 / Math.sqrt(3);

/** Front looks along +Y, so +X runs to the right and +Z up: the drawing convention. */
export const STANDARD_VIEWS: Record<StandardView, ViewDirection> = {
  front: { label: 'Front', key: '1', from: [0, -1, 0], up: [0, 0, 1] },
  back: { label: 'Back', key: '2', from: [0, 1, 0], up: [0, 0, 1] },
  left: { label: 'Left', key: '3', from: [-1, 0, 0], up: [0, 0, 1] },
  right: { label: 'Right', key: '4', from: [1, 0, 0], up: [0, 0, 1] },
  top: { label: 'Top', key: '5', from: [0, 0, 1], up: [0, 1, 0] },
  bottom: { label: 'Bottom', key: '6', from: [0, 0, -1], up: [0, -1, 0] },
  iso: { label: 'Isometric', key: '7', from: [ISO, -ISO, ISO], up: [0, 0, 1] },
};

export const VIEW_ORDER: StandardView[] = [
  'front',
  'back',
  'left',
  'right',
  'top',
  'bottom',
  'iso',
];

/**
 * How far the camera must sit from the centre of a sphere to show all of it, for a
 * perspective camera with the given vertical field of view. Narrow viewports are limited by
 * their width.
 */
export function fitDistance(radius: number, fovDegrees: number, aspect: number): number {
  const vertical = (fovDegrees * Math.PI) / 360;
  const horizontal = Math.atan(Math.tan(vertical) * aspect);
  return radius / Math.sin(Math.min(vertical, horizontal));
}

/** Half the visible height an orthographic camera needs to show a sphere of this radius. */
export function fitHalfHeight(radius: number, aspect: number): number {
  return aspect >= 1 ? radius : radius / aspect;
}

const POLAR_LIMIT = 1e-3;

/**
 * Turn the camera offset (camera minus target) about the Z axis by `azimuth` and tilt it by
 * `polar`, both in radians. The tilt stops short of the poles so "up" stays defined.
 */
export function orbitOffset(offset: Vec3, azimuth: number, polar: number): Vec3 {
  const radius = Math.hypot(offset[0], offset[1], offset[2]);
  if (radius === 0) return [0, 0, 0];
  const theta = Math.atan2(offset[1], offset[0]) + azimuth;
  const phi = Math.min(
    Math.PI - POLAR_LIMIT,
    Math.max(POLAR_LIMIT, Math.acos(offset[2] / radius) + polar),
  );
  return [
    radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.sin(phi) * Math.sin(theta),
    radius * Math.cos(phi),
  ];
}

/** A grid spacing of 1, 2 or 5 times a power of ten that gives roughly ten cells across. */
export function gridStep(extent: number): number {
  if (!(extent > 0)) return 1;
  const raw = extent / 10;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const scaled = raw / magnitude;
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * magnitude;
}

/** The grid spacing for an envelope: sized to its larger horizontal extent. */
export function gridSpacing(extent: MeshBounds): number {
  const size = boundsSize(extent);
  return gridStep(Math.max(size[0], size[1]));
}

/** Half-width of a square grid about the origin that reaches past the envelope. */
export function gridHalfExtent(bounds: MeshBounds, step: number): number {
  const reach = Math.max(
    Math.abs(bounds.min[0]),
    Math.abs(bounds.max[0]),
    Math.abs(bounds.min[1]),
    Math.abs(bounds.max[1]),
  );
  return Math.max(step, Math.ceil((reach * 1.25) / step) * step);
}
