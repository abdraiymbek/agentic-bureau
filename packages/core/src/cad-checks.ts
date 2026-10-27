/**
 * Deterministic CAD verification. An `Expectation` states what must be true
 * of a part (envelope, volume, material/empty points, cross-section features);
 * `runChecks` measures the rendered mesh and returns one PASS/FAIL line per
 * assertion with measured vs expected values.
 *
 * The same engine backs the agent-facing `cad.check` tool and the evaluation
 * suite, so "the model declares intent, software verifies" is one code path.
 */
import type { Expectation } from '@bureau/contracts';
import {
  analyzeMesh,
  assertFiniteMesh,
  assertIntersectionBudget,
  MAX_CAD_CHECK_TRIANGLE_VISITS,
  MAX_CAD_CHECK_ASSERTIONS,
  meshWorkLimit,
  containsPoint,
  countIntersectingPairs,
  crossSection,
  type SectionLoop,
  type TriangleBuffer,
  type Vec3,
} from './mesh.js';

/* Strongly-typed view of a parsed Expectation (zod validated the array lengths). */
type V2 = [number, number];
interface HoleT {
  center: V2;
  d: number;
  tol?: number;
}
interface SectionT {
  axis: 'x' | 'y' | 'z';
  at: number;
  holes?: HoleT[];
  holeCount?: number;
  outerCount?: number;
  slots?: { center: V2; size: V2; tol?: number }[];
  polygons?: { center: V2; sides: number; acrossFlats: number; tol?: number }[];
  outer?: { size?: V2; d?: number; center?: V2; tol?: number };
  materialArea?: { value: number; tolPct?: number };
}
interface ExpectationT {
  bbox?: { min: Vec3; max: Vec3; tol?: number };
  volume?: { value: number; tolPct?: number };
  solid?: Vec3[];
  empty?: Vec3[];
  sections?: SectionT[];
  watertight?: boolean;
  shells?: number;
  minRoundness?: number;
  maxSelfIntersections?: number;
  preserve?: { changeRegions: { center: Vec3; radius: number }[] };
}

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
  /** 1 / tolerance — higher is stricter. Used to flag silently loosened retries. */
  tightness?: number;
}

const LIN_TOL = 0.1; // mm
const VOL_TOL_PCT = 1.5;

export function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, '');
}
function vec(v: readonly number[]): string {
  return `(${v.map(fmtNum).join(', ')})`;
}
function nearest(
  loops: SectionLoop[],
  c: [number, number],
): { loop: SectionLoop | null; dist: number } {
  let loop: SectionLoop | null = null;
  let dist = Infinity;
  for (const l of loops) {
    const d = Math.hypot(l.centroid[0] - c[0], l.centroid[1] - c[1]);
    if (d < dist) {
      dist = d;
      loop = l;
    }
  }
  return { loop, dist };
}

export function runChecks(tris: TriangleBuffer, expIn: Expectation): CheckResult[] {
  const exp = expIn as unknown as ExpectationT;
  assertFiniteMesh(tris);
  const assertionCount =
    (exp.solid?.length ?? 0) +
    (exp.empty?.length ?? 0) +
    (exp.sections ?? []).reduce(
      (sum, section) =>
        sum +
        1 +
        (section.holes?.length ?? 0) +
        (section.slots?.length ?? 0) +
        (section.polygons?.length ?? 0),
      0,
    );
  if (assertionCount > MAX_CAD_CHECK_ASSERTIONS)
    meshWorkLimit('CAD check assertions', assertionCount, MAX_CAD_CHECK_ASSERTIONS);
  if (exp.maxSelfIntersections !== undefined) assertIntersectionBudget(tris);
  const visits =
    (tris.length / 9) *
    ((exp.solid?.length ?? 0) + (exp.empty?.length ?? 0) + (exp.sections?.length ?? 0) * 2);
  if (visits > MAX_CAD_CHECK_TRIANGLE_VISITS)
    meshWorkLimit('CAD check triangle visits', visits, MAX_CAD_CHECK_TRIANGLE_VISITS);
  const out: CheckResult[] = [];
  const report = analyzeMesh(tris);
  const minRound = exp.minRoundness ?? 0.97;

  if (report.triangles === 0) {
    return [{ name: 'geometry', pass: false, detail: 'mesh has no triangles' }];
  }

  if (exp.bbox) {
    const tol = exp.bbox.tol ?? LIN_TOL;
    const okMin = exp.bbox.min.every((v, i) => Math.abs(v - report.bounds.min[i]!) <= tol);
    const okMax = exp.bbox.max.every((v, i) => Math.abs(v - report.bounds.max[i]!) <= tol);
    out.push({
      name: 'bounding box',
      pass: okMin && okMax,
      detail: `min ${vec(report.bounds.min)} max ${vec(report.bounds.max)} — expected min ${vec(exp.bbox.min)} max ${vec(exp.bbox.max)} ±${tol}`,
      tightness: 1 / tol,
    });
  }

  if (exp.volume) {
    const tolPct = exp.volume.tolPct ?? VOL_TOL_PCT;
    const err = (Math.abs(report.volume - exp.volume.value) / exp.volume.value) * 100;
    // An expectation that restates the measurement to the last digit proves
    // nothing; an analytic volume with curved features never matches a
    // faceted mesh that closely (prismatic parts with integer volumes can).
    const restated =
      Math.abs(report.volume - exp.volume.value) < 1e-3 && !Number.isInteger(exp.volume.value);
    out.push({
      name: 'volume',
      pass: err <= tolPct && !restated,
      detail: restated
        ? `${fmtNum(report.volume)} mm³ — expected value is a copy of the measurement; compute the expected volume from the request (nominal dimensions) instead`
        : `${fmtNum(report.volume)} mm³ — expected ${fmtNum(exp.volume.value)} ±${tolPct}% (off by ${err.toFixed(2)}%)`,
      tightness: 1 / tolPct,
    });
  }

  if (exp.watertight !== false) {
    out.push({
      name: 'watertight',
      pass: report.topology.watertight && !report.invertedNormals,
      detail: `boundary edges ${report.topology.boundaryEdges}, non-manifold ${report.topology.nonManifoldEdges}, inverted ${report.invertedNormals}`,
    });
  }
  if (exp.shells !== undefined) {
    out.push({
      name: 'single body',
      pass: report.topology.shells === exp.shells,
      detail: `${report.topology.shells} shell(s) — expected ${exp.shells}`,
    });
  }
  if (exp.maxSelfIntersections !== undefined) {
    const pairs = countIntersectingPairs(tris);
    out.push({
      name: 'self-intersections',
      pass: pairs <= exp.maxSelfIntersections,
      detail: `${pairs} intersecting triangle pair(s) — allowed ${exp.maxSelfIntersections}`,
      tightness: 1 / (exp.maxSelfIntersections + 1),
    });
  }

  for (const p of exp.solid ?? []) {
    const inside = containsPoint(tris, p);
    out.push({
      name: `solid at ${vec(p)}`,
      pass: inside,
      detail: inside ? 'material present' : 'EMPTY — expected material',
    });
  }
  for (const p of exp.empty ?? []) {
    const inside = containsPoint(tris, p);
    out.push({
      name: `empty at ${vec(p)}`,
      pass: !inside,
      detail: inside ? 'MATERIAL — expected empty' : 'empty',
    });
  }

  for (const spec of exp.sections ?? []) {
    const s = crossSection(tris, spec.axis, spec.at);
    const label = `section ${spec.axis}=${fmtNum(spec.at)}`;
    const holes = s.loops.filter((l) => l.isHole);
    const outers = s.loops.filter((l) => !l.isHole);
    const [a, b] = s.planeAxes;

    if (spec.holeCount !== undefined) {
      out.push({
        name: `${label}: hole count`,
        pass: holes.length === spec.holeCount,
        detail:
          `${holes.length} cut-out loop(s) — expected ${spec.holeCount}` +
          (holes.length ? `; found: ${holes.map((l) => describeLoop(l, a, b)).join('; ')}` : ''),
      });
    }
    if (spec.outerCount !== undefined) {
      out.push({
        name: `${label}: body count`,
        pass: outers.length === spec.outerCount,
        detail: `${outers.length} material region(s) — expected ${spec.outerCount}`,
      });
    }
    for (const h of spec.holes ?? []) {
      const tol = h.tol ?? LIN_TOL;
      const { loop: best, dist } = nearest(holes, h.center);
      const name = `${label}: hole d${fmtNum(h.d)} at (${a}=${fmtNum(h.center[0])}, ${b}=${fmtNum(h.center[1])})`;
      if (!best || dist > Math.max(tol, h.d)) {
        out.push({
          name,
          pass: false,
          detail: `no hole near that position (nearest cut-out ${best ? fmtNum(dist) + ' mm away' : 'none in this plane'})`,
        });
        continue;
      }
      const posOk = dist <= tol;
      if (best.circle) {
        const measuredD = best.circle.radius * 2;
        const dOk = Math.abs(measuredD - h.d) <= tol;
        const roundOk = best.circle.roundness >= minRound;
        out.push({
          name,
          pass: posOk && dOk && roundOk,
          detail:
            `found d=${fmtNum(measuredD)} at (${fmtNum(best.centroid[0])}, ${fmtNum(best.centroid[1])}) roundness ${best.circle.roundness}` +
            (!posOk ? ` — POSITION off by ${fmtNum(dist)}` : '') +
            (!dOk ? ` — DIAMETER off by ${fmtNum(measuredD - h.d)}` : '') +
            (!roundOk ? ` — FACETED (roundness < ${minRound}; increase $fn)` : ''),
          tightness: 1 / tol,
        });
      } else {
        out.push({
          name,
          pass: false,
          detail: `cut-out at (${fmtNum(best.centroid[0])}, ${fmtNum(best.centroid[1])}) is not circular (bbox ${best.bbox.size.map(fmtNum).join('×')})`,
        });
      }
    }
    for (const sl of spec.slots ?? []) {
      const tol = sl.tol ?? LIN_TOL;
      const name = `${label}: cut-out ${sl.size.map(fmtNum).join('×')} at (${a}=${fmtNum(sl.center[0])}, ${b}=${fmtNum(sl.center[1])})`;
      const match = holes.find(
        (l) =>
          Math.abs(l.bbox.size[0] - sl.size[0]) <= tol &&
          Math.abs(l.bbox.size[1] - sl.size[1]) <= tol &&
          Math.abs((l.bbox.min[0] + l.bbox.max[0]) / 2 - sl.center[0]) <= tol &&
          Math.abs((l.bbox.min[1] + l.bbox.max[1]) / 2 - sl.center[1]) <= tol,
      );
      out.push({
        name,
        pass: !!match,
        detail: match
          ? `found cut-out bbox ${match.bbox.size.map(fmtNum).join('×')}`
          : `no cut-out with that footprint; cut-outs present: ${holes.map((l) => describeLoop(l, a, b)).join('; ') || 'none'}`,
      });
    }
    for (const pg of spec.polygons ?? []) {
      const tol = pg.tol ?? LIN_TOL;
      const apothem = pg.acrossFlats / 2;
      const circum = apothem / Math.cos(Math.PI / pg.sides);
      const name = `${label}: ${pg.sides}-gon across-flats ${fmtNum(pg.acrossFlats)} at (${a}=${fmtNum(pg.center[0])}, ${b}=${fmtNum(pg.center[1])})`;
      const { loop: best, dist } = nearest(holes, pg.center);
      if (!best || dist > tol) {
        out.push({
          name,
          pass: false,
          detail: `no cut-out centered there (nearest ${best ? fmtNum(dist) + ' mm away' : 'none'})`,
        });
        continue;
      }
      const c = best.circle;
      const okSides = best.points.length === pg.sides;
      const okFlats = !!c && Math.abs(c.minRadius * 2 - pg.acrossFlats) <= tol;
      const okCorners = !!c && Math.abs(c.maxRadius * 2 - circum * 2) <= tol;
      out.push({
        name,
        pass: okSides && okFlats && okCorners,
        detail: `found ${best.points.length} sides, across-flats ${c ? fmtNum(c.minRadius * 2) : '?'}, across-corners ${c ? fmtNum(c.maxRadius * 2) : '?'} (expected ${fmtNum(pg.acrossFlats)} / ${fmtNum(circum * 2)})`,
      });
    }
    if (spec.outer) {
      const tol = spec.outer.tol ?? LIN_TOL;
      const o = [...outers].sort((p, q) => q.area - p.area)[0];
      if (!o) {
        out.push({
          name: `${label}: outer profile`,
          pass: false,
          detail: 'no material in this plane',
        });
      } else if (spec.outer.size) {
        const ok =
          !!o.rectangle &&
          Math.abs(o.rectangle.size[0] - spec.outer.size[0]) <= tol &&
          Math.abs(o.rectangle.size[1] - spec.outer.size[1]) <= tol &&
          (!spec.outer.center ||
            (Math.abs(o.rectangle.center[0] - spec.outer.center[0]) <= tol &&
              Math.abs(o.rectangle.center[1] - spec.outer.center[1]) <= tol));
        out.push({
          name: `${label}: outer rectangle ${spec.outer.size.map(fmtNum).join('×')}`,
          pass: ok,
          detail: o.rectangle
            ? `found ${o.rectangle.size.map(fmtNum).join('×')} centered (${o.rectangle.center.map(fmtNum).join(', ')})`
            : `outer loop is not rectangular (bbox ${o.bbox.size.map(fmtNum).join('×')})`,
        });
      } else if (spec.outer.d) {
        const ok =
          !!o.circle &&
          Math.abs(o.circle.radius * 2 - spec.outer.d) <= tol &&
          o.circle.roundness >= minRound &&
          (!spec.outer.center ||
            (Math.abs(o.centroid[0] - spec.outer.center[0]) <= tol &&
              Math.abs(o.centroid[1] - spec.outer.center[1]) <= tol));
        out.push({
          name: `${label}: outer circle d${fmtNum(spec.outer.d)}`,
          pass: ok,
          detail: o.circle
            ? `found d=${fmtNum(o.circle.radius * 2)} at (${fmtNum(o.centroid[0])}, ${fmtNum(o.centroid[1])}) roundness ${o.circle.roundness}`
            : `outer loop is not circular (bbox ${o.bbox.size.map(fmtNum).join('×')})`,
        });
      }
    }
    if (spec.materialArea) {
      const tolPct = spec.materialArea.tolPct ?? VOL_TOL_PCT;
      const err =
        (Math.abs(s.materialArea - spec.materialArea.value) / spec.materialArea.value) * 100;
      out.push({
        name: `${label}: material area`,
        pass: err <= tolPct,
        detail: `${fmtNum(s.materialArea)} mm² — expected ${fmtNum(spec.materialArea.value)} ±${tolPct}%`,
      });
    }
    if (s.openChains > 0) {
      out.push({
        name: `${label}: closed`,
        pass: false,
        detail: `${s.openChains} open chain(s) in section — either the mesh is not closed here or the plane coincides with a face/edge; move \`at\` into the feature`,
      });
    }
  }
  return out;
}

/** One-line description of a section loop for feedback text. */
export function describeLoop(l: SectionLoop, a: string, b: string): string {
  const kind = l.isHole ? 'cut-out' : 'material';
  if (l.circle && l.circle.roundness >= 0.9) {
    return `${kind} circle d=${fmtNum(l.circle.radius * 2)} at (${a}=${fmtNum(l.centroid[0])}, ${b}=${fmtNum(l.centroid[1])})${l.circle.roundness < 0.97 ? ` roundness ${l.circle.roundness}` : ''}`;
  }
  if (l.circle && l.points.length <= 12) {
    return `${kind} ${l.points.length}-gon across-flats ${fmtNum(l.circle.minRadius * 2)} at (${a}=${fmtNum(l.centroid[0])}, ${b}=${fmtNum(l.centroid[1])})`;
  }
  if (l.rectangle) {
    return `${kind} rectangle ${l.rectangle.size.map(fmtNum).join('×')} centered (${a}=${fmtNum(l.rectangle.center[0])}, ${b}=${fmtNum(l.rectangle.center[1])})`;
  }
  return `${kind} shape bbox ${l.bbox.size.map(fmtNum).join('×')} centered (${a}=${fmtNum((l.bbox.min[0] + l.bbox.max[0]) / 2)}, ${b}=${fmtNum((l.bbox.min[1] + l.bbox.max[1]) / 2)}) area ${fmtNum(l.area)}`;
}

/**
 * Modification support: sample points in the original part's bounding box and
 * require inside/outside agreement between original and modified meshes for
 * every point outside the declared change regions.
 */
export function preservationCheck(
  original: TriangleBuffer,
  modified: TriangleBuffer,
  changeRegions: { center: Vec3; radius: number }[],
  samples = 400,
): CheckResult {
  assertFiniteMesh(original);
  assertFiniteMesh(modified);
  const visits = samples * ((original.length + modified.length) / 9 + changeRegions.length);
  if (visits > MAX_CAD_CHECK_TRIANGLE_VISITS)
    meshWorkLimit('Preservation check triangle visits', visits, MAX_CAD_CHECK_TRIANGLE_VISITS);
  const b0 = analyzeMesh(original).bounds;
  const b1 = analyzeMesh(modified).bounds;
  const min: Vec3 = [
    Math.min(b0.min[0], b1.min[0]),
    Math.min(b0.min[1], b1.min[1]),
    Math.min(b0.min[2], b1.min[2]),
  ];
  const size: Vec3 = [
    Math.max(b0.max[0], b1.max[0]) - min[0],
    Math.max(b0.max[1], b1.max[1]) - min[1],
    Math.max(b0.max[2], b1.max[2]) - min[2],
  ];
  let rng = 0x2545f491;
  const rand = () => {
    rng ^= rng << 13;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    return ((rng >>> 0) % 1_000_000) / 1_000_000;
  };
  let tested = 0;
  let mismatched = 0;
  const examples: string[] = [];
  for (let i = 0; i < samples; i++) {
    const p: Vec3 = [
      min[0] + rand() * size[0],
      min[1] + rand() * size[1],
      min[2] + rand() * size[2],
    ];
    if (
      changeRegions.some(
        (r) => Math.hypot(p[0] - r.center[0], p[1] - r.center[1], p[2] - r.center[2]) <= r.radius,
      )
    )
      continue;
    tested++;
    const a = containsPoint(original, p);
    const m = containsPoint(modified, p);
    if (a !== m) {
      mismatched++;
      if (examples.length < 3)
        examples.push(`${vec(p)} was ${a ? 'solid' : 'empty'} now ${m ? 'solid' : 'empty'}`);
    }
  }
  return {
    name: 'unrelated geometry preserved',
    pass: mismatched === 0,
    detail:
      `${tested} sample points outside change regions, ${mismatched} differ` +
      (examples.length ? `: ${examples.join('; ')}` : ''),
  };
}

/**
 * Flag assertions that now pass only because the tolerance grew (same name,
 * prior FAIL, current PASS, lower tightness). Dropped prior FAILs are a
 * separate check in `cad.check`.
 */
export function findLoosenedAssertions(
  prior: { name: string; pass: boolean; tightness?: number }[],
  current: { name: string; pass: boolean; tightness?: number }[],
): string[] {
  const byName = new Map(prior.map((c) => [c.name, c]));
  const out: string[] = [];
  for (const c of current) {
    const p = byName.get(c.name);
    if (!p || p.pass || !c.pass) continue;
    if (p.tightness === undefined || c.tightness === undefined) continue;
    if (c.tightness < p.tightness - 1e-12) out.push(c.name);
  }
  return out;
}
