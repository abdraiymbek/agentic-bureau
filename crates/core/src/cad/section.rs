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
    pub plane_axes: [usize; 2],
    pub loops: Vec<Loop>,
    pub material_area: f64,
    pub open_chains: usize,
}
fn r3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}
fn key(p: P2) -> (i64, i64) {
    ((p[0] / 1e-6).round() as i64, (p[1] / 1e-6).round() as i64)
}
fn distance(a: P2, b: P2) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
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
fn simplify(points: Vec<P2>) -> Vec<P2> {
    if points.len() < 4 {
        return points;
    }
    let mut result = Vec::new();
    for i in 0..points.len() {
        let p = points[(i + points.len() - 1) % points.len()];
        let c = points[i];
        let q = points[(i + 1) % points.len()];
        let cross = (c[0] - p[0]) * (q[1] - c[1]) - (c[1] - p[1]) * (q[0] - c[0]);
        let length = distance(p, q);
        if length > 0.0 && cross.abs() / length < 1e-6 {
            continue;
        }
        result.push(c);
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
            [u, v],
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
        let (axis, plane_axes, u, v) =
            if n[2].abs() > 0.999 && n[0].abs() < 1e-6 && n[1].abs() < 1e-6 {
                (2, [0, 1], [1.0, 0.0, 0.0], [0.0, n[2].signum(), 0.0])
            } else if n[1].abs() > 0.999 && n[0].abs() < 1e-6 && n[2].abs() < 1e-6 {
                (1, [0, 2], [1.0, 0.0, 0.0], [0.0, 0.0, n[1].signum()])
            } else if n[0].abs() > 0.999 && n[1].abs() < 1e-6 && n[2].abs() < 1e-6 {
                (0, [1, 2], [0.0, 1.0, 0.0], [0.0, 0.0, n[0].signum()])
            } else {
                let helper = if n[1].abs() < 0.9 {
                    [0.0, 1.0, 0.0]
                } else {
                    [1.0, 0.0, 0.0]
                };
                let u = cross(helper, n);
                let ul = dot(u, u).sqrt();
                let u = u.map(|x| x / ul);
                (2, [0, 1], u, cross(n, u))
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
            plane_axes,
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
        plane_axes: [usize; 2],
        distance_to_plane: impl Fn([f64; 3]) -> f64,
        project: impl Fn([f64; 3]) -> P2,
    ) -> Self {
        let mut segments = Vec::<(P2, P2)>::new();
        for triangle in &mesh.triangles {
            let mut points = Vec::new();
            for e in 0..3 {
                let p = triangle[e];
                let q = triangle[(e + 1) % 3];
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
        let mut by_end = HashMap::<(i64, i64), Vec<usize>>::new();
        for (i, (a, b)) in segments.iter().enumerate() {
            by_end.entry(key(*a)).or_default().push(i);
            by_end.entry(key(*b)).or_default().push(i);
        }
        let mut used = vec![false; segments.len()];
        let mut paths = Vec::new();
        let mut open_chains = 0;
        for i in 0..segments.len() {
            if used[i] {
                continue;
            }
            used[i] = true;
            let mut path = vec![segments[i].0, segments[i].1];
            let mut current = segments[i].1;
            let start = key(segments[i].0);
            let mut closed = false;
            for _ in 0..=segments.len() {
                let ck = key(current);
                if ck == start {
                    closed = true;
                    break;
                }
                let next = by_end
                    .get(&ck)
                    .and_then(|list| list.iter().find(|&&j| !used[j]))
                    .copied();
                let Some(j) = next else {
                    break;
                };
                used[j] = true;
                let (a, b) = segments[j];
                current = if key(a) == ck { b } else { a };
                path.push(current);
            }
            if closed {
                path.pop();
                let simple = simplify(path);
                if simple.len() >= 3 {
                    paths.push(simple);
                }
            } else {
                open_chains += 1;
            }
        }
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
        loops.sort_by(|a, b| {
            a.depth
                .cmp(&b.depth)
                .then_with(|| b.area.total_cmp(&a.area))
        });
        Self {
            axis,
            at,
            plane_axes,
            loops,
            material_area,
            open_chains,
        }
    }
    pub fn report(&self, label: Option<&str>) -> Value {
        let axis = ["x", "y", "z"][self.axis];
        let axes = [
            ["x", "y", "z"][self.plane_axes[0]],
            ["x", "y", "z"][self.plane_axes[1]],
        ];
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
        report["plane"] = json!(format!(
            "origin=({}) n=({})",
            origin
                .iter()
                .map(|v| r3(*v).to_string())
                .collect::<Vec<_>>()
                .join(", "),
            normal
                .iter()
                .map(|v| r3(*v).to_string())
                .collect::<Vec<_>>()
                .join(", ")
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
