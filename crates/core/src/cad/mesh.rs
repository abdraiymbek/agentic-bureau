use super::*;
use std::collections::{HashMap, HashSet};

pub(super) type Point = [f64; 3];
pub(super) type Triangle = [Point; 3];

pub(super) struct Mesh {
    pub triangles: Vec<Triangle>,
    pub bounds_min: Point,
    pub bounds_max: Point,
    pub volume: f64,
    pub area: f64,
    pub watertight: bool,
    pub inverted: bool,
    pub shells: usize,
    pub boundary_edges: usize,
    pub non_manifold_edges: usize,
}

fn sub(a: Point, b: Point) -> Point {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn cross(a: Point, b: Point) -> Point {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn dot(a: Point, b: Point) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn root(parent: &mut [usize], x: usize) -> usize {
    let mut i = x;
    while parent[i] != i {
        parent[i] = parent[parent[i]];
        i = parent[i];
    }
    i
}

impl Mesh {
    pub fn count_intersections(&self) -> CoreResult<usize> {
        let count = self.triangles.len();
        if count.saturating_mul(count.saturating_sub(1)) / 2 > 8_000_000 {
            return Err(ContractError::validation(
                "Self-intersection candidate pairs exceed the supported work limit",
            ));
        }
        let boxes = self
            .triangles
            .iter()
            .map(|t| {
                let min = std::array::from_fn(|axis| {
                    t.iter().map(|p| p[axis]).fold(f64::INFINITY, f64::min)
                });
                let max = std::array::from_fn(|axis| {
                    t.iter().map(|p| p[axis]).fold(f64::NEG_INFINITY, f64::max)
                });
                (min, max)
            })
            .collect::<Vec<(Point, Point)>>();
        let mut overlaps = 0;
        let mut hits = 0;
        for a in 0..count {
            for b in a + 1..count {
                if !(0..3).all(|axis| {
                    boxes[a].0[axis] <= boxes[b].1[axis] + 1e-9
                        && boxes[a].1[axis] >= boxes[b].0[axis] - 1e-9
                }) {
                    continue;
                }
                overlaps += 1;
                if overlaps > 100_000 {
                    return Err(ContractError::validation(
                        "Self-intersection overlapping pairs exceed the supported work limit",
                    ));
                }
                let shared = self.triangles[a]
                    .iter()
                    .filter(|p| {
                        self.triangles[b]
                            .iter()
                            .any(|q| (0..3).all(|i| (p[i] - q[i]).abs() < 1e-6))
                    })
                    .count();
                if shared >= 2 {
                    continue;
                }
                if triangles_intersect(&self.triangles[a], &self.triangles[b]) {
                    hits += 1;
                }
            }
        }
        Ok(hits)
    }
    pub fn read(bytes: &[u8]) -> CoreResult<Self> {
        if bytes.len() > 6_000_000 {
            return Err(ContractError::validation(
                "STL byte size exceeds the supported V0.1 work limit",
            ));
        }
        let raw = stl_io::read_stl(&mut std::io::Cursor::new(bytes))
            .map_err(|e| ContractError::validation(format!("Invalid STL mesh: {e}")))?;
        if raw.faces.is_empty() || raw.faces.len() > 100_000 {
            return Err(ContractError::validation(
                "Mesh triangle count is empty or exceeds the supported V0.1 work limit",
            ));
        }
        let mut min = [f64::INFINITY; 3];
        let mut max = [f64::NEG_INFINITY; 3];
        let mut volume = 0.0;
        let mut area = 0.0;
        let mut triangles = Vec::with_capacity(raw.faces.len());
        let mut edges = HashMap::<(usize, usize), (usize, usize)>::new();
        let mut parent = (0..raw.faces.len()).collect::<Vec<_>>();
        for (index, face) in raw.faces.iter().enumerate() {
            let t = face.vertices.map(|v| raw.vertices[v].0.map(f64::from));
            for p in &t {
                for axis in 0..3 {
                    if !p[axis].is_finite() {
                        return Err(ContractError::validation(
                            "STL contains non-finite coordinates",
                        ));
                    }
                    min[axis] = min[axis].min(p[axis]);
                    max[axis] = max[axis].max(p[axis]);
                }
            }
            let ab = sub(t[1], t[0]);
            let ac = sub(t[2], t[0]);
            let normal = cross(ab, ac);
            area += dot(normal, normal).sqrt() * 0.5;
            volume += dot(t[0], cross(t[1], t[2])) / 6.0;
            for (a, b) in [(0, 1), (1, 2), (2, 0)] {
                let (a, b) = (face.vertices[a], face.vertices[b]);
                let key = (a.min(b), a.max(b));
                if let Some((count, first)) = edges.get_mut(&key) {
                    *count += 1;
                    let ra = root(&mut parent, *first);
                    let rb = root(&mut parent, index);
                    parent[ra] = rb;
                } else {
                    edges.insert(key, (1, index));
                }
            }
            triangles.push(t);
        }
        let mut roots = HashSet::new();
        for i in 0..parent.len() {
            roots.insert(root(&mut parent, i));
        }
        let boundary_edges = edges.values().filter(|(n, _)| *n == 1).count();
        let non_manifold_edges = edges.values().filter(|(n, _)| *n > 2).count();
        let inverted = volume < 0.0;
        Ok(Self {
            triangles,
            bounds_min: min,
            bounds_max: max,
            volume: volume.abs(),
            area,
            watertight: boundary_edges == 0 && non_manifold_edges == 0,
            inverted,
            shells: roots.len(),
            boundary_edges,
            non_manifold_edges,
        })
    }

    pub fn summary(&self) -> Value {
        let r3 = |v: f64| (v * 1000.0).round() / 1000.0;
        let size = std::array::from_fn::<_, 3, _>(|i| r3(self.bounds_max[i] - self.bounds_min[i]));
        json!({"unit":"mm","bounds":{"min":self.bounds_min.map(r3),"max":self.bounds_max.map(r3),"size":size},
            "volume":r3(self.volume),"surfaceArea":r3(self.area),"triangles":self.triangles.len(),
            "watertight":self.watertight&&!self.inverted,"shells":self.shells})
    }

    pub fn contains(&self, point: Point) -> bool {
        const DIRECTIONS: [Point; 5] = [
            [0.577350269, 0.577350269, 0.577350269],
            [-0.267261242, 0.534522484, 0.801783726],
            [0.801783726, -0.267261242, -0.534522484],
            [-0.40824829, -0.816496581, 0.40824829],
            [0.301511345, -0.904534034, 0.301511345],
        ];
        let mut inside = 0;
        for direction in DIRECTIONS {
            let mut distances = Vec::new();
            for triangle in &self.triangles {
                let e1 = sub(triangle[1], triangle[0]);
                let e2 = sub(triangle[2], triangle[0]);
                let p = cross(direction, e2);
                let det = dot(e1, p);
                if det.abs() < 1e-12 {
                    continue;
                }
                let inv = 1.0 / det;
                let tvec = sub(point, triangle[0]);
                let u = dot(tvec, p) * inv;
                if !(0.0..=1.0).contains(&u) {
                    continue;
                }
                let q = cross(tvec, e1);
                let v = dot(direction, q) * inv;
                if v < 0.0 || u + v > 1.0 {
                    continue;
                }
                let distance = dot(e2, q) * inv;
                if distance > 1e-9 {
                    distances.push(distance);
                }
            }
            distances.sort_by(f64::total_cmp);
            let mut hits = 0;
            let mut previous = f64::NEG_INFINITY;
            for distance in distances {
                let epsilon = (16.0 * f64::EPSILON * distance.abs()).max(1e-8);
                if distance - previous > epsilon {
                    hits += 1;
                    previous = distance;
                }
            }
            if hits % 2 == 1 {
                inside += 1;
            }
        }
        inside > 2
    }
}

fn segment_hits_triangle(a: Point, b: Point, triangle: &Triangle) -> bool {
    let direction = sub(b, a);
    let edge1 = sub(triangle[1], triangle[0]);
    let edge2 = sub(triangle[2], triangle[0]);
    let p = cross(direction, edge2);
    let det = dot(edge1, p);
    if det.abs() < 1e-12 {
        return false;
    }
    let inv = 1.0 / det;
    let t = sub(a, triangle[0]);
    let u = dot(t, p) * inv;
    if !(0.0..=1.0).contains(&u) {
        return false;
    }
    let q = cross(t, edge1);
    let v = dot(direction, q) * inv;
    if v < 0.0 || u + v > 1.0 {
        return false;
    }
    let distance = dot(edge2, q) * inv;
    distance > 1e-6 && distance < 1.0 - 1e-6
}

fn triangles_intersect(a: &Triangle, b: &Triangle) -> bool {
    (0..3).any(|i| {
        segment_hits_triangle(a[i], a[(i + 1) % 3], b)
            || segment_hits_triangle(b[i], b[(i + 1) % 3], a)
    })
}
