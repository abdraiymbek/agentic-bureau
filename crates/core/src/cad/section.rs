//! Mesh/plane intersections with ordered material and cut-out loops.
use super::*;
use std::collections::HashMap;

type P2 = [f64; 2];

#[derive(Clone)]
pub struct Circle {
    pub radius: f64,
    pub min_radius: f64,
    pub max_radius: f64,
    pub roundness: f64,
}
#[derive(Clone)]
pub struct Rectangle {
    pub size: P2,
    pub center: P2,
}
#[derive(Clone)]
pub struct Loop {
    pub points: Vec<P2>,
    pub area: f64,
    pub centroid: P2,
    pub min: P2,
    pub max: P2,
    pub size: P2,
    pub depth: usize,
    pub is_hole: bool,
    pub circle: Option<Circle>,
    pub rectangle: Option<Rectangle>,
}
pub struct Section {
    pub axis: usize,
    pub at: f64,
    /// Names of the two in-plane coordinates: model axes for an axis-aligned
    /// cut, `u` and `v` for an oblique one.
    pub labels: [&'static str; 2],
    pub loops: Vec<Loop>,
    pub material_area: f64,
    pub open_chains: usize,
}

const AXES: [&str; 3] = ["x", "y", "z"];
fn r3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}
/// The grid segment ends are joined on, and the farthest apart two ends
/// that no key joins may be to join.
const STEP: f64 = 1e-6;
fn key(p: P2) -> (i64, i64) {
    ((p[0] / STEP).round() as i64, (p[1] / STEP).round() as i64)
}
fn distance(a: P2, b: P2) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}
/// The two ends of an edge in one fixed order, whichever way a triangle
/// walks it.
fn ordered(p: [f64; 3], q: [f64; 3]) -> ([f64; 3], [f64; 3]) {
    let later = p
        .iter()
        .zip(&q)
        .map(|(a, b)| a.total_cmp(b))
        .find(|order| order.is_ne())
        == Some(std::cmp::Ordering::Greater);
    if later {
        (q, p)
    } else {
        (p, q)
    }
}

/// Join segments end to end: the closed loops, as points, and how many
/// chains stayed open. Ends join by their rounded key. An end with nothing
/// left at its key joins the nearest end within one step instead, or closes
/// its loop when that is the start: a crossing that falls on a rounding
/// boundary, computed a hair to either side, still meets its twin.
fn chain(segments: &[(P2, P2)]) -> (Vec<Vec<P2>>, usize) {
    let mut by_end = HashMap::<(i64, i64), Vec<usize>>::new();
    for (i, (a, b)) in segments.iter().enumerate() {
        by_end.entry(key(*a)).or_default().push(i);
        by_end.entry(key(*b)).or_default().push(i);
    }
    // The nearest end of an unused segment within one step of `point`:
    // its distance, the segment, and whether it is the segment's first end.
    let near = |point: P2, used: &[bool]| {
        let (x, y) = key(point);
        let mut best: Option<(f64, usize, bool)> = None;
        for cell in (-1..=1).flat_map(|dx| (-1..=1).map(move |dy| (x + dx, y + dy))) {
            for &j in by_end.get(&cell).into_iter().flatten() {
                if used[j] {
                    continue;
                }
                for (first, end) in [(true, segments[j].0), (false, segments[j].1)] {
                    let gap = distance(point, end);
                    if gap <= STEP && best.is_none_or(|(nearest, _, _)| gap < nearest) {
                        best = Some((gap, j, first));
                    }
                }
            }
        }
        best
    };
    let mut used = vec![false; segments.len()];
    let mut closed = Vec::new();
    let mut open_chains = 0;
    for i in 0..segments.len() {
        if used[i] {
            continue;
        }
        used[i] = true;
        let (start, mut current) = segments[i];
        let mut path = vec![start, current];
        let mut done = false;
        for _ in 0..=segments.len() {
            let ck = key(current);
            if ck == key(start) {
                done = true;
                break;
            }
            let exact = by_end
                .get(&ck)
                .and_then(|list| list.iter().find(|&&j| !used[j]))
                .map(|&j| (j, key(segments[j].0) == ck));
            let next = match exact {
                Some(next) => next,
                None => {
                    let back = distance(current, start);
                    match near(current, &used) {
                        Some((gap, j, first)) if gap < back => (j, first),
                        _ if back <= STEP => {
                            done = true;
                            break;
                        }
                        Some((_, j, first)) => (j, first),
                        None => break,
                    }
                }
            };
            let (j, from_first) = next;
            used[j] = true;
            current = if from_first {
                segments[j].1
            } else {
                segments[j].0
            };
            path.push(current);
        }
        if done {
            path.pop();
            closed.push(path);
        } else {
            open_chains += 1;
        }
    }
    (closed, open_chains)
}
fn area(points: &[P2]) -> f64 {
    points
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let q = points[(i + 1) % points.len()];
            p[0] * q[1] - q[0] * p[1]
        })
        .sum::<f64>()
        / 2.0
}
fn inside(point: P2, poly: &[P2]) -> bool {
    let mut result = false;
    let mut previous = poly.len() - 1;
    for current in 0..poly.len() {
        let a = poly[current];
        let b = poly[previous];
        if (a[1] > point[1]) != (b[1] > point[1])
            && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]
        {
            result = !result;
        }
        previous = current;
    }
    result
}
/// Is `c` within 1e-6 of the line through `p` and `q`?
fn collinear(p: P2, c: P2, q: P2) -> bool {
    let cross = (c[0] - p[0]) * (q[1] - c[1]) - (c[1] - p[1]) * (q[0] - c[0]);
    let length = distance(p, q);
    length > 0.0 && cross.abs() / length < 1e-6
}

/// Drop the points that lie on the line between the points kept around
/// them. Each point is judged against kept neighbours only: judged against
/// its original neighbours, both points of a nearly doubled corner look
/// collinear and the corner was lost.
fn simplify(points: Vec<P2>) -> Vec<P2> {
    if points.len() < 4 {
        return points;
    }
    let mut result: Vec<P2> = Vec::with_capacity(points.len());
    for &c in &points {
        while result.len() >= 2 && collinear(result[result.len() - 2], result[result.len() - 1], c)
        {
            result.pop();
        }
        result.push(c);
    }
    // The seam: the last points against the first ones.
    while result.len() > 3 {
        let n = result.len();
        if collinear(result[n - 2], result[n - 1], result[0]) {
            result.pop();
        } else if collinear(result[n - 1], result[0], result[1]) {
            result.remove(0);
        } else {
            break;
        }
    }
    if result.len() >= 3 {
        result
    } else {
        points
    }
}
fn circle(points: &[P2], centroid: P2) -> Option<Circle> {
    if points.len() < 5 {
        return None;
    }
    let mut min = f64::INFINITY;
    let mut max: f64 = 0.0;
    for i in 0..points.len() {
        let a = points[i];
        let b = points[(i + 1) % points.len()];
        max = max.max(distance(a, centroid));
        let dx = b[0] - a[0];
        let dy = b[1] - a[1];
        let length = dx * dx + dy * dy;
        let t = if length > 0.0 {
            ((centroid[0] - a[0]) * dx + (centroid[1] - a[1]) * dy) / length
        } else {
            0.0
        }
        .clamp(0.0, 1.0);
        min = min.min(distance([a[0] + t * dx, a[1] + t * dy], centroid));
    }
    let roundness = if max > 0.0 { min / max } else { 0.0 };
    if roundness < 0.75 {
        None
    } else {
        Some(Circle {
            radius: r3(max),
            min_radius: r3(min),
            max_radius: r3(max),
            roundness: r3(roundness),
        })
    }
}
fn rectangle(points: &[P2], area: f64, min: P2, max: P2) -> Option<Rectangle> {
    let size = [max[0] - min[0], max[1] - min[1]];
    if size[0] <= 0.0
        || size[1] <= 0.0
        || ((area - size[0] * size[1]) / (size[0] * size[1])).abs() > 0.01
    {
        return None;
    }
    let _ = points;
    Some(Rectangle {
        size: size.map(r3),
        center: [r3((min[0] + max[0]) / 2.0), r3((min[1] + max[1]) / 2.0)],
    })
}

impl Section {
    pub fn from_mesh(mesh: &mesh::Mesh, axis: usize, at: f64) -> Self {
        let in_plane = (0..3).filter(|&i| i != axis).collect::<Vec<_>>();
        let u = in_plane[0];
        let v = in_plane[1];
        let shift = if mesh
            .triangles
            .iter()
            .flat_map(|t| t.iter())
            .any(|p| (p[axis] - at).abs() < 1e-9)
        {
            1e-6
        } else {
            0.0
        };
        Self::build(
            mesh,
            axis,
            at,
            [AXES[u], AXES[v]],
            |p| p[axis] - at - shift,
            |p| [p[u], p[v]],
        )
    }

    pub fn from_plane(mesh: &mesh::Mesh, origin: [f64; 3], normal: [f64; 3]) -> CoreResult<Self> {
        if !origin.iter().chain(normal.iter()).all(|v| v.is_finite()) {
            return Err(ContractError::validation(
                "Section plane must contain finite values",
            ));
        }
        let length = normal.iter().map(|v| v * v).sum::<f64>().sqrt();
        if length < 1e-12 {
            return Err(ContractError::validation("Section normal cannot be zero"));
        }
        let n = normal.map(|v| v / length);
        let (axis, labels, u, v) = if n[2].abs() > 0.999 && n[0].abs() < 1e-6 && n[1].abs() < 1e-6 {
            (2, ["x", "y"], [1.0, 0.0, 0.0], [0.0, n[2].signum(), 0.0])
        } else if n[1].abs() > 0.999 && n[0].abs() < 1e-6 && n[2].abs() < 1e-6 {
            (1, ["x", "z"], [1.0, 0.0, 0.0], [0.0, 0.0, n[1].signum()])
        } else if n[0].abs() > 0.999 && n[1].abs() < 1e-6 && n[2].abs() < 1e-6 {
            (0, ["y", "z"], [0.0, 1.0, 0.0], [0.0, 0.0, n[0].signum()])
        } else {
            let helper = if n[1].abs() < 0.9 {
                [0.0, 1.0, 0.0]
            } else {
                [1.0, 0.0, 0.0]
            };
            let u = cross(helper, n);
            let ul = dot(u, u).sqrt();
            let u = u.map(|x| x / ul);
            (2, ["u", "v"], u, cross(n, u))
        };
        let shift = if mesh
            .triangles
            .iter()
            .flat_map(|t| t.iter())
            .any(|p| dot(sub(*p, origin), n).abs() < 1e-9)
        {
            1e-6
        } else {
            0.0
        };
        Ok(Self::build(
            mesh,
            axis,
            origin[axis],
            labels,
            |p| dot(sub(p, origin), n) - shift,
            |p| {
                let relative = sub(p, origin);
                [dot(relative, u), dot(relative, v)]
            },
        ))
    }

    fn build(
        mesh: &mesh::Mesh,
        axis: usize,
        at: f64,
        labels: [&'static str; 2],
        distance_to_plane: impl Fn([f64; 3]) -> f64,
        project: impl Fn([f64; 3]) -> P2,
    ) -> Self {
        let mut segments = Vec::<(P2, P2)>::new();
        for triangle in &mesh.triangles {
            let mut points = Vec::new();
            for e in 0..3 {
                // The two triangles that share an edge walk it in opposite
                // directions; taking its ends in one order gives both the
                // same crossing to the last bit, so they join.
                let (p, q) = ordered(triangle[e], triangle[(e + 1) % 3]);
                let pa = distance_to_plane(p);
                let qa = distance_to_plane(q);
                if (pa > 0.0 && qa > 0.0) || (pa < 0.0 && qa < 0.0) || pa == qa {
                    continue;
                }
                let t = pa / (pa - qa);
                let hit = [
                    p[0] + t * (q[0] - p[0]),
                    p[1] + t * (q[1] - p[1]),
                    p[2] + t * (q[2] - p[2]),
                ];
                points.push(project(hit));
            }
            if points.len() == 2 && distance(points[0], points[1]) > 1e-9 {
                segments.push((points[0], points[1]));
            }
        }
        let (closed, open_chains) = chain(&segments);
        let paths = closed
            .into_iter()
            .map(simplify)
            .filter(|simple| simple.len() >= 3)
            .collect::<Vec<_>>();
        let mut loops = Vec::new();
        for points in paths {
            let signed = area(&points);
            let surface = signed.abs();
            let mut centroid = [0.0, 0.0];
            for i in 0..points.len() {
                let p = points[i];
                let q = points[(i + 1) % points.len()];
                let f = p[0] * q[1] - q[0] * p[1];
                centroid[0] += (p[0] + q[0]) * f;
                centroid[1] += (p[1] + q[1]) * f;
            }
            if signed.abs() > 1e-12 {
                centroid = [centroid[0] / (6.0 * signed), centroid[1] / (6.0 * signed)];
            } else {
                centroid = points[0];
            }
            let mut min = [f64::INFINITY; 2];
            let mut max = [f64::NEG_INFINITY; 2];
            for p in &points {
                for j in 0..2 {
                    min[j] = min[j].min(p[j]);
                    max[j] = max[j].max(p[j]);
                }
            }
            let size = [r3(max[0] - min[0]), r3(max[1] - min[1])];
            loops.push(Loop {
                circle: circle(&points, centroid),
                rectangle: rectangle(&points, surface, min, max),
                points,
                area: surface,
                centroid: centroid.map(r3),
                min: min.map(r3),
                max: max.map(r3),
                size,
                depth: 0,
                is_hole: false,
            });
        }
        for i in 0..loops.len() {
            let point = loops[i].points[0];
            let surface = loops[i].area;
            let depth = (0..loops.len())
                .filter(|&j| j != i && loops[j].area > surface && inside(point, &loops[j].points))
                .count();
            loops[i].depth = depth;
            loops[i].is_hole = depth % 2 == 1;
        }
        let material_area = r3(loops
            .iter()
            .map(|l| if l.is_hole { -l.area } else { l.area })
            .sum());
        // Copies of one feature have the same rounded area; their position
        // orders them, so the order never follows the mesh's triangle order.
        loops.sort_by(|a, b| {
            a.depth
                .cmp(&b.depth)
                .then_with(|| r3(b.area).total_cmp(&r3(a.area)))
                .then_with(|| a.centroid[0].total_cmp(&b.centroid[0]))
                .then_with(|| a.centroid[1].total_cmp(&b.centroid[1]))
        });
        Self {
            axis,
            at,
            labels,
            loops,
            material_area,
            open_chains,
        }
    }
    pub fn report(&self, label: Option<&str>) -> Value {
        let axis = AXES[self.axis];
        let axes = self.labels;
        let mut descriptions = self
            .loops
            .iter()
            .take(16)
            .map(|item| describe(item, axes))
            .collect::<Vec<_>>();
        if self.loops.is_empty() {
            descriptions.push("no material in this plane".into());
        }
        if self.loops.len() > 16 {
            descriptions.push(format!("…and {} more loops", self.loops.len() - 16));
        }
        if self.open_chains > 0 {
            descriptions.push(format!(
                "warning: {} open chain(s) — mesh is not closed at this plane",
                self.open_chains
            ));
        }
        json!({"plane":format!("{axis}={}{}",r3(self.at),label.map(|s|format!(" ({s})")).unwrap_or_default()),"loops":descriptions})
    }

    pub fn report_plane(&self, origin: [f64; 3], normal: [f64; 3]) -> Value {
        let mut report = self.report(None);
        let list = |values: [f64; 3]| {
            values
                .iter()
                .map(|v| r3(*v).to_string())
                .collect::<Vec<_>>()
                .join(", ")
        };
        report["plane"] = json!(format!(
            "origin=({}) n=({}){}",
            list(origin),
            list(normal),
            if self.labels == ["u", "v"] {
                "; u and v are in-plane distances from the origin"
            } else {
                ""
            }
        ));
        report
    }
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub fn describe(item: &Loop, axes: [&str; 2]) -> String {
    let kind = if item.is_hole { "cut-out" } else { "material" };
    if let Some(circle) = &item.circle {
        if circle.roundness >= 0.9 {
            return format!(
                "{kind} circle d={} at ({}={}, {}={}){}",
                r3(circle.radius * 2.0),
                axes[0],
                item.centroid[0],
                axes[1],
                item.centroid[1],
                if circle.roundness < 0.97 {
                    format!(" roundness {}", circle.roundness)
                } else {
                    String::new()
                }
            );
        }
        if item.points.len() <= 12 {
            return format!(
                "{kind} {}-gon across-flats {} at ({}={}, {}={})",
                item.points.len(),
                r3(circle.min_radius * 2.0),
                axes[0],
                item.centroid[0],
                axes[1],
                item.centroid[1]
            );
        }
    }
    if let Some(rect) = &item.rectangle {
        return format!(
            "{kind} rectangle {}×{} centered ({}={}, {}={})",
            rect.size[0], rect.size[1], axes[0], rect.center[0], axes[1], rect.center[1]
        );
    }
    format!(
        "{kind} shape bbox {}×{} centered ({}={}, {}={}) area {}",
        item.size[0],
        item.size[1],
        axes[0],
        r3((item.min[0] + item.max[0]) / 2.0),
        axes[1],
        r3((item.min[1] + item.max[1]) / 2.0),
        r3(item.area)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cad::mesh::fixtures::{cuboid, merged, mesh, plate_with_hole};

    #[test]
    fn mid_plane_of_a_box_is_one_material_rectangle() {
        let cube = mesh(cuboid([0.0; 3], [10.0, 20.0, 30.0], false));
        let cut = Section::from_mesh(&cube, 2, 15.0);
        assert_eq!(cut.labels, ["x", "y"]);
        assert_eq!((cut.loops.len(), cut.open_chains), (1, 0));
        let outline = &cut.loops[0];
        assert!(!outline.is_hole);
        assert_eq!(outline.rectangle.as_ref().unwrap().size, [10.0, 20.0]);
        assert_eq!(outline.rectangle.as_ref().unwrap().center, [5.0, 10.0]);
        assert!((cut.material_area - 200.0).abs() < 1e-9);
        assert_eq!(
            cut.report(Some("mid")),
            json!({"plane": "z=15 (mid)", "loops": ["material rectangle 10×20 centered (x=5, y=10)"]})
        );
        assert_eq!(Section::from_mesh(&cube, 1, 3.0).labels, ["x", "z"]);
        assert_eq!(Section::from_mesh(&cube, 0, 3.0).labels, ["y", "z"]);
    }

    #[test]
    fn a_plane_on_a_face_is_nudged_inside_and_a_plane_outside_is_empty() {
        let cube = mesh(cuboid([0.0; 3], [10.0; 3], false));
        let bottom = Section::from_mesh(&cube, 2, 0.0);
        assert_eq!((bottom.loops.len(), bottom.open_chains), (1, 0));
        let outside = Section::from_mesh(&cube, 2, 12.0);
        assert!(outside.loops.is_empty());
        assert_eq!(
            outside.report(None)["loops"],
            json!(["no material in this plane"])
        );
    }

    #[test]
    fn a_hole_is_a_nested_circular_cut_out_with_its_diameter_and_position() {
        let facets = 64;
        let plate = mesh(plate_with_hole(
            [100.0, 40.0, 6.0],
            [50.0, 20.0],
            8.0,
            facets,
        ));
        let cut = Section::from_mesh(&plate, 2, 3.0);
        assert_eq!((cut.loops.len(), cut.open_chains), (2, 0));
        let outline = cut.loops.iter().find(|item| !item.is_hole).unwrap();
        let hole = cut.loops.iter().find(|item| item.is_hole).unwrap();
        assert_eq!(outline.rectangle.as_ref().unwrap().size, [100.0, 40.0]);
        assert_eq!(hole.depth, 1);
        assert_eq!(hole.centroid, [50.0, 20.0]);
        let circle = hole.circle.as_ref().unwrap();
        assert!((circle.radius - 4.0).abs() < 1e-3);
        assert!(circle.roundness > 0.99);
        let hole_area = facets as f64 * 0.5 * 16.0 * (std::f64::consts::TAU / facets as f64).sin();
        assert!((cut.material_area - (4000.0 - hole_area)).abs() < 1e-2);
        assert_eq!(
            describe(hole, cut.labels),
            "cut-out circle d=8 at (x=50, y=20)"
        );
    }

    #[test]
    fn coarse_holes_report_their_roundness_and_polygons_their_flats() {
        let pentagon = mesh(plate_with_hole([20.0, 20.0, 5.0], [10.0, 10.0], 2.5, 8));
        let cut = Section::from_mesh(&pentagon, 2, 2.5);
        let hole = cut.loops.iter().find(|item| item.is_hole).unwrap();
        assert_eq!(hole.points.len(), 8);
        let circle = hole.circle.as_ref().unwrap();
        assert!((circle.roundness - (std::f64::consts::PI / 8.0).cos()).abs() < 2e-3);
        assert!(describe(hole, cut.labels)
            .starts_with("cut-out circle d=2.5 at (x=10, y=10) roundness 0.92"));
        let hex = mesh(plate_with_hole([30.0, 30.0, 5.0], [15.0, 15.0], 8.0, 6));
        let cut = Section::from_mesh(&hex, 2, 2.5);
        let trap = cut.loops.iter().find(|item| item.is_hole).unwrap();
        assert_eq!(
            describe(trap, cut.labels),
            "cut-out 6-gon across-flats 6.928 at (x=15, y=15)"
        );
    }

    #[test]
    fn separate_bodies_and_islands_nest_by_depth() {
        let nested = merged(&[
            cuboid([0.0; 3], [20.0; 3], false),
            cuboid([2.0; 3], [18.0; 3], true),
            cuboid([8.0; 3], [12.0; 3], false),
            cuboid([30.0, 0.0, 0.0], [35.0, 5.0, 20.0], false),
        ]);
        let cut = Section::from_mesh(&nested, 2, 10.0);
        let depths = cut.loops.iter().map(|item| item.depth).collect::<Vec<_>>();
        assert_eq!(depths, vec![0, 0, 1, 2]);
        assert_eq!(cut.loops.iter().filter(|item| item.is_hole).count(), 1);
        assert!((cut.material_area - (400.0 - 256.0 + 16.0 + 25.0)).abs() < 1e-9);
    }

    #[test]
    fn copies_of_one_feature_are_listed_by_position_whatever_the_triangle_order() {
        let right = cuboid([50.0, 0.0, 0.0], [80.0, 10.0, 4.0], false);
        let left = cuboid([0.0; 3], [30.0, 10.0, 4.0], false);
        for body in [
            merged(&[right.clone(), left.clone()]),
            merged(&[left, right]),
        ] {
            assert_eq!(
                Section::from_mesh(&body, 1, 5.0).report(None)["loops"],
                json!([
                    "material rectangle 30×4 centered (x=15, z=2)",
                    "material rectangle 30×4 centered (x=65, z=2)"
                ])
            );
        }
    }

    #[test]
    fn a_nearly_doubled_corner_is_kept() {
        // A cut just off a hole's vertex meets the hole wall twice, 6e-7 mm
        // apart, at the corner of the outline.
        let corner = 11.000_000_05;
        let points = vec![
            [corner, 0.0],
            [0.0, 0.0],
            [0.0, 6.0],
            [5.0, 6.0],
            [10.999_999_9, 6.0],
            [corner, 6.0],
            [corner, 3.0],
        ];
        assert_eq!(
            simplify(points),
            vec![[corner, 0.0], [0.0, 0.0], [0.0, 6.0], [corner, 6.0]]
        );
    }

    /// The box x 0..7.5, y 10..50, z 0..6 with its bottom and top faces
    /// split along the diagonal from (7.5, 10) to (0, 50), as the plate of a
    /// reported cad_view was: the corner at (0, 50) to the first vertex of a
    /// Ø5 hole at (5, 10).
    fn diagonal_box() -> Vec<mesh::Triangle> {
        cuboid([0.0, 10.0, 0.0], [7.5, 50.0, 6.0], false)
            .into_iter()
            .map(|triangle| triangle.map(|p| [7.5 - p[0], p[1], p[2]]))
            .collect()
    }

    #[test]
    fn a_crossing_on_a_rounding_boundary_still_closes_its_loop() {
        // y = 25.001 crosses the diagonal at x = 7.5 × 24.999 / 40 =
        // 4.6873125, a half-micron: the two triangles that share the edge
        // walk it in opposite directions, and one of them computed
        // 4.687312499999999, which rounded to the neighbouring key.
        let cut = Section::from_mesh(&mesh(diagonal_box()), 1, 25.001);
        assert_eq!((cut.loops.len(), cut.open_chains), (1, 0));
        let outline = &cut.loops[0];
        assert_eq!(outline.rectangle.as_ref().unwrap().size, [7.5, 6.0]);
        assert!((cut.material_area - 45.0).abs() < 1e-9);
        assert_eq!(
            cut.report(None)["loops"],
            json!(["material rectangle 7.5×6 centered (x=3.75, z=3)"])
        );
    }

    #[test]
    fn ends_a_hair_apart_across_a_key_boundary_join_and_ends_farther_apart_do_not() {
        // 4.6873125 / 1e-6 rounds up, 4.687312499999999 / 1e-6 down.
        let (a, twin) = ([4.687_312_5, 0.0], [4.687_312_499_999_999, 0.0]);
        assert_ne!(key(a), key(twin));
        let (top, origin, left) = ([4.687_312_5, 3.0], [0.0, 0.0], [0.0, 3.0]);
        // Inside the chain…
        let (closed, open) = chain(&[(origin, a), (twin, top), (top, left), (left, origin)]);
        assert_eq!((closed.len(), open), (1, 0));
        assert_eq!(closed[0].len(), 4);
        // …and where it closes on its start.
        let (closed, open) = chain(&[(a, origin), (origin, left), (left, top), (top, twin)]);
        assert_eq!((closed.len(), open), (1, 0));
        assert_eq!(closed[0], vec![a, origin, left, top]);
        // A gap wider than one step stays open, as before: the chain is
        // walked from each side of it.
        let gap = [4.687_32, 0.0];
        let (closed, open) = chain(&[(origin, a), (gap, top), (top, left), (left, origin)]);
        assert_eq!((closed.len(), open), (0, 2));
    }

    #[test]
    fn an_open_mesh_reports_open_chains_instead_of_inventing_a_loop() {
        let mut open = cuboid([0.0; 3], [10.0; 3], false);
        open.truncate(10);
        let cut = Section::from_mesh(&mesh(open), 2, 5.0);
        assert_eq!(cut.open_chains, 1);
        assert!(cut.loops.is_empty());
        assert!(cut.report(None)["loops"][1]
            .as_str()
            .unwrap()
            .contains("1 open chain(s)"));
    }

    #[test]
    fn an_axis_aligned_plane_request_matches_the_axis_section() {
        let cube = mesh(cuboid([0.0; 3], [10.0, 20.0, 30.0], false));
        let plane = Section::from_plane(&cube, [0.0, 0.0, 15.0], [0.0, 0.0, 1.0]).unwrap();
        assert_eq!(plane.labels, ["x", "y"]);
        assert_eq!(
            plane.loops[0].rectangle.as_ref().unwrap().size,
            [10.0, 20.0]
        );
    }

    #[test]
    fn an_oblique_plane_is_measured_in_its_own_coordinates() {
        let cube = mesh(cuboid([0.0; 3], [20.0; 3], false));
        let cut = Section::from_plane(&cube, [10.0, 0.0, 10.0], [1.0, 0.0, 1.0]).unwrap();
        assert_eq!(cut.labels, ["u", "v"]);
        assert_eq!((cut.loops.len(), cut.open_chains), (1, 0));
        let diagonal = 20.0 * std::f64::consts::SQRT_2;
        let size = cut.loops[0].size;
        assert!((size[0].max(size[1]) - diagonal).abs() < 0.01, "{size:?}");
        assert!((size[0].min(size[1]) - 20.0).abs() < 0.01);
        let report = cut.report_plane([10.0, 0.0, 10.0], [1.0, 0.0, 1.0]);
        assert!(report["plane"]
            .as_str()
            .unwrap()
            .contains("u and v are in-plane"));
        assert!(report["loops"][0].as_str().unwrap().contains("u="));
    }

    #[test]
    fn plane_requests_must_be_finite_and_have_a_direction() {
        let cube = mesh(cuboid([0.0; 3], [1.0; 3], false));
        assert!(Section::from_plane(&cube, [0.0; 3], [0.0; 3]).is_err());
        assert!(Section::from_plane(&cube, [f64::NAN, 0.0, 0.0], [0.0, 0.0, 1.0]).is_err());
    }
}
