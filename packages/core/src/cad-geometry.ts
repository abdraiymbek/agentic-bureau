/** Pure geometry report work; executed in the packaged cancellable worker. */
import { BureauError } from '@bureau/contracts';
import {
  analyzeMesh,
  assertCadInspectionBudget,
  containsPoint,
  countIntersectingPairs,
  crossSection,
  crossSectionPlane,
  minWallThickness,
  type Axis,
  type MeshReport,
  type TriangleBuffer,
  type Vec3,
} from './mesh.js';
import { describeLoop, fmtNum } from './cad-checks.js';
import type { ScadParameter } from './scad-params.js';
import type { GeometrySummary, SectionReport } from './cad.js';
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function geometrySummary(report: MeshReport, unit: string): GeometrySummary {
  return {
    unit,
    bounds: {
      min: report.bounds.min.map(r3) as Vec3,
      max: report.bounds.max.map(r3) as Vec3,
      size: report.bounds.size.map(r3) as Vec3,
    },
    volume: r3(report.volume),
    surfaceArea: r3(report.surfaceArea),
    triangles: report.triangles,
    watertight: report.topology.watertight && !report.invertedNormals,
    shells: report.topology.shells,
  };
}

const MAX_LOOPS_PER_SECTION = 16;

function sectionReport(
  tris: TriangleBuffer,
  axis: Axis,
  at: number,
  label?: string,
): SectionReport {
  const s = crossSection(tris, axis, at);
  const [a, b] = s.planeAxes;
  const loops = s.loops.slice(0, MAX_LOOPS_PER_SECTION).map((l) => describeLoop(l, a, b));
  if (s.loops.length > MAX_LOOPS_PER_SECTION)
    loops.push(`…and ${s.loops.length - MAX_LOOPS_PER_SECTION} more loops`);
  if (s.loops.length === 0) loops.push('no material in this plane');
  if (s.openChains > 0)
    loops.push(`warning: ${s.openChains} open chain(s) — mesh is not closed at this plane`);
  return { plane: `${axis}=${fmtNum(r3(at))}${label ? ` (${label})` : ''}`, loops };
}

function autoSections(tris: TriangleBuffer, report: MeshReport): SectionReport[] {
  const { min, max } = report.bounds;
  const out: SectionReport[] = [];
  for (const axis of ['z', 'y', 'x'] as Axis[]) {
    const i = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
    const span = max[i]! - min[i]!;
    if (span <= 0) continue;
    // Slightly off the exact middle so a mid-height face never becomes the plane.
    out.push(sectionReport(tris, axis, min[i]! + span * 0.5 + 1e-3, 'mid'));
  }
  // Parts are usually built up along Z: features that stop short of a face
  // (blind bores, cutters that end early) show up near the ends, not the middle.
  const zSpan = max[2]! - min[2]!;
  if (zSpan > 0) {
    out.push(sectionReport(tris, 'z', min[2]! + zSpan * 0.1 + 1e-3, 'near bottom'));
    out.push(sectionReport(tris, 'z', min[2]! + zSpan * 0.9 + 1e-3, 'near top'));
  }
  return out;
}

function geometryNotes(
  report: MeshReport,
  tris: TriangleBuffer,
  params: ScadParameter[],
): string[] {
  const notes: string[] = [];
  if (report.topology.shells > 1) {
    notes.push(
      `${report.topology.shells} disconnected bodies — if this should be one part, make the features overlap or touch (a shared face is not enough; overlap by a small amount).`,
    );
  }
  if (!report.topology.watertight) {
    notes.push(
      `Mesh is not closed (${report.topology.boundaryEdges} boundary edges, ${report.topology.nonManifoldEdges} non-manifold edges).`,
    );
  }
  if (report.invertedNormals) {
    notes.push(
      "Mesh is inside-out (negative signed volume). With polyhedron(), list each face's vertices clockwise when viewed from outside the solid; booleans on an inside-out body cut the wrong side. Open meshes are diagnosed, not auto-flipped.",
    );
  }
  let crossings = 0;
  try {
    crossings = countIntersectingPairs(tris);
  } catch (error) {
    if (
      error instanceof BureauError &&
      (error.details as { reason?: string } | undefined)?.reason === 'CAD_WORK_LIMIT'
    ) {
      notes.push(
        `Self-intersections not evaluated: ${error.message}. This report does not establish intersection-free geometry.`,
      );
    } else throw error;
  }
  if (crossings > 0) {
    notes.push(
      `${crossings} self-intersecting triangle pair(s) — overlapping bodies or piercing faces can still satisfy bbox/volume. Separate the solids or boolean them; cad.check maxSelfIntersections: 0 to fail on this.`,
    );
  }
  const wall = minWallThickness(tris, 80);
  if (wall !== null && wall < 0.4) {
    notes.push(
      `Minimum sampled wall thickness is ${fmtNum(wall)} mm — thin skins often mean a cutter ended on a face instead of through it.`,
    );
  }
  // Faceting check on any circular loop in the mid sections.
  let coarse: string | null = null;
  const { min, max } = report.bounds;
  for (const axis of ['z', 'y', 'x'] as Axis[]) {
    const i = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
    if (max[i]! - min[i]! <= 0) continue;
    const s = crossSection(tris, axis, min[i]! + (max[i]! - min[i]!) * 0.5 + 1e-3);
    for (const l of s.loops) {
      if (
        l.circle &&
        l.circle.roundness >= 0.75 &&
        l.circle.roundness < 0.97 &&
        l.points.length <= 24
      ) {
        coarse = `${l.points.length}-sided`;
        break;
      }
    }
    if (coarse) break;
  }
  if (coarse) {
    notes.push(
      `A circular feature renders as a ${coarse} polygon (coarse faceting). Unless a polygon was intended, set $fn (e.g. $fn = 64;) so holes and cylinders are round.`,
    );
  }
  if (params.length === 0)
    notes.push(
      'No top-level parameters found. Exposing key dimensions as `name = value;` at file scope makes the part re-sizable via params.',
    );
  return notes;
}

export type ExtraSection = { axis?: Axis; at?: number; origin?: Vec3; normal?: Vec3 };

function extraSectionReport(tris: TriangleBuffer, spec: ExtraSection): SectionReport {
  if (spec.origin && spec.normal) {
    const s = crossSectionPlane(tris, spec.origin, spec.normal);
    const [a, b] = s.planeAxes;
    const loops = s.loops.slice(0, MAX_LOOPS_PER_SECTION).map((l) => describeLoop(l, a, b));
    if (s.loops.length > MAX_LOOPS_PER_SECTION)
      loops.push(`…and ${s.loops.length - MAX_LOOPS_PER_SECTION} more loops`);
    if (s.loops.length === 0) loops.push('no material in this plane');
    if (s.openChains > 0)
      loops.push(`warning: ${s.openChains} open chain(s) — mesh is not closed at this plane`);
    return {
      plane: `origin=(${spec.origin.map(fmtNum).join(', ')}) n=(${spec.normal.map(fmtNum).join(', ')})`,
      loops,
    };
  }
  if (spec.axis === undefined || spec.at === undefined) {
    return { plane: 'invalid section (need axis+at or origin+normal)', loops: [] };
  }
  return sectionReport(tris, spec.axis, spec.at);
}

export interface GeometryDetails {
  geometry: GeometrySummary;
  sections: SectionReport[];
  probes?: { point: Vec3; result: 'solid' | 'empty' }[];
  notes: string[];
}
export function inspectGeometry(args: {
  tris: TriangleBuffer;
  unit: string;
  params: ScadParameter[];
  extraSections?: ExtraSection[];
  probes?: Vec3[];
}): GeometryDetails {
  const { tris } = args;
  assertCadInspectionBudget(tris, args.probes?.length ?? 0, args.extraSections?.length ?? 0);
  const report = analyzeMesh(tris);
  return {
    geometry: geometrySummary(report, args.unit),
    sections: [
      ...autoSections(tris, report),
      ...(args.extraSections ?? []).map((s) => extraSectionReport(tris, s)),
    ],
    ...(args.probes?.length
      ? {
          probes: args.probes.map((p) => ({
            point: p,
            result: containsPoint(tris, p) ? ('solid' as const) : ('empty' as const),
          })),
        }
      : {}),
    notes: geometryNotes(report, tris, args.params),
  };
}
