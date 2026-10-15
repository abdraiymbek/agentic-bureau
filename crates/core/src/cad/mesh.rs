//! Deterministic triangle-mesh analysis: bounds, volume, topology, point
//! containment, self-intersection and wall thickness on an STL triangle soup.
//!
//! Coordinates are whatever the STL carries (model units, millimetres by
//! convention). Ray and overlap queries go through a bounding-volume
//! hierarchy, so their cost grows with the logarithm of the triangle count
//! and a detailed part does not hit a work limit on an ordinary check.
use super::*;
use std::collections::HashMap;
use std::sync::OnceLock;

pub(crate) type Point = [f64; 3];
pub(crate) type Triangle = [Point; 3];

/// Largest STL accepted for rendering, storage and analysis.
pub(crate) const MAX_MESH_BYTES: usize = 32_000_000;
pub(crate) const MAX_TRIANGLES: usize = 600_000;
/// Assertions (probes, sections, section features) in one check or inspection.
pub(crate) const MAX_ASSERTIONS: usize = 512;
/// Triangle pairs with overlapping boxes examined by one self-intersection
/// count. Beyond this the count is reported as not evaluated.
pub(crate) const MAX_INTERSECTION_CANDIDATES: usize = 20_000_000;

const WELD: f64 = 1e-5;
const LEAF_TRIANGLES: usize = 8;

/// A bounded-work refusal. The analysis was not evaluated; nothing is
/// inferred from it.
pub(crate) fn work_limit(operation: &str, actual: usize, limit: usize) -> ContractError {
    ContractError::validation(format!(
        "{operation} exceeds the supported work limit ({actual} > {limit})"
    ))
    .with_repair("Reduce tessellation ($fn), split the part or the check into smaller pieces, or leave this check out and report its coverage as not verified.")
    .with_details(json!({"reason": "CAD_WORK_LIMIT", "operation": operation, "actual": actual, "limit": limit, "status": "not_evaluated"}))
}

pub(crate) fn is_work_limit(error: &ContractError) -> bool {
    error
        .details
        .as_deref()
        .is_some_and(|details| details["reason"] == "CAD_WORK_LIMIT")
}

pub(crate) struct Mesh {
    pub triangles: Vec<Triangle>,
    pub bounds_min: Point,
    pub bounds_max: Point,
    pub volume: f64,
    pub area: f64,
    pub watertight: bool,
    /// Negative signed volume: the faces point inward.
    pub inverted: bool,
    pub shells: usize,
    pub boundary_edges: usize,
    pub non_manifold_edges: usize,
    index: OnceLock<Bvh>,
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
fn root(parent: &mut [u32], start: u32) -> u32 {
    let mut at = start;
    while parent[at as usize] != at {
        parent[at as usize] = parent[parent[at as usize] as usize];
        at = parent[at as usize];
    }
    at
}

/// Möller–Trumbore: distance along `direction` at which the ray from
/// `origin` crosses the triangle, when it does so in front of the origin.
fn ray_triangle(origin: Point, direction: Point, triangle: &Triangle) -> Option<f64> {
    let edge1 = sub(triangle[1], triangle[0]);
    let edge2 = sub(triangle[2], triangle[0]);
    let p = cross(direction, edge2);
    let det = dot(edge1, p);
    if det.abs() < 1e-12 {
        return None;
    }
    let inv = 1.0 / det;
    let offset = sub(origin, triangle[0]);
    let u = dot(offset, p) * inv;
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let q = cross(offset, edge1);
    let v = dot(direction, q) * inv;
    if v < 0.0 || u + v > 1.0 {
        return None;
    }
    let distance = dot(edge2, q) * inv;
    (distance > 1e-9).then_some(distance)
}

fn segment_hits_triangle(a: Point, b: Point, triangle: &Triangle) -> bool {
    ray_triangle(a, sub(b, a), triangle)
        .is_some_and(|distance| distance > 1e-6 && distance < 1.0 - 1e-6)
}

fn triangles_intersect(a: &Triangle, b: &Triangle) -> bool {
    (0..3).any(|i| {
        segment_hits_triangle(a[i], a[(i + 1) % 3], b)
            || segment_hits_triangle(b[i], b[(i + 1) % 3], a)
    })
}

fn shared_vertices(a: &Triangle, b: &Triangle) -> usize {
    a.iter()
        .filter(|p| {
            b.iter()
                .any(|q| (0..3).all(|axis| (p[axis] - q[axis]).abs() < 1e-6))
        })
        .count()
}

#[derive(Clone, Copy)]
struct Bounds {
    min: Point,
    max: Point,
}

impl Bounds {
    const EMPTY: Self = Self {
        min: [f64::INFINITY; 3],
        max: [f64::NEG_INFINITY; 3],
    };

    fn of(triangle: &Triangle) -> Self {
        let mut bounds = Self::EMPTY;
        for point in triangle {
            bounds.add(*point);
        }
        bounds
    }

    fn add(&mut self, point: Point) {
        for (axis, value) in point.into_iter().enumerate() {
            self.min[axis] = self.min[axis].min(value);
            self.max[axis] = self.max[axis].max(value);
        }
    }

    fn join(&mut self, other: &Self) {
        self.add(other.min);
        self.add(other.max);
    }

    fn overlaps(&self, other: &Self) -> bool {
        (0..3).all(|axis| {
            self.min[axis] <= other.max[axis] + 1e-9 && self.max[axis] >= other.min[axis] - 1e-9
        })
    }

    /// Conservative slab test for the half-line `origin + t·direction`, t ≥ 0.
    fn hit_by_ray(&self, origin: Point, direction: Point) -> bool {
        let mut near = 0.0f64;
        let mut far = f64::INFINITY;
        for axis in 0..3 {
            let pad = 1e-7 + 1e-9 * self.max[axis].abs().max(self.min[axis].abs());
            let (low, high) = (self.min[axis] - pad, self.max[axis] + pad);
            if direction[axis].abs() < 1e-300 {
                if origin[axis] < low || origin[axis] > high {
                    return false;
                }
                continue;
            }
            let inv = 1.0 / direction[axis];
            let (a, b) = ((low - origin[axis]) * inv, (high - origin[axis]) * inv);
            near = near.max(a.min(b));
            far = far.min(a.max(b));
            if near > far {
                return false;
            }
        }
        true
    }
}

struct Node {
    bounds: Bounds,
    /// Leaf: first entry in `order`. Branch: index of the second child; the
    /// first child is the next node.
    link: u32,
    /// Triangles in a leaf; zero for a branch.
    count: u32,
}

/// Median-split bounding-volume hierarchy over the triangles.
struct Bvh {
    nodes: Vec<Node>,
    order: Vec<u32>,
    boxes: Vec<Bounds>,
}

impl Bvh {
    fn build(triangles: &[Triangle]) -> Self {
        let boxes = triangles.iter().map(Bounds::of).collect::<Vec<_>>();
        let centroids = boxes
            .iter()
            .map(|bounds| std::array::from_fn(|axis| (bounds.min[axis] + bounds.max[axis]) * 0.5))
            .collect::<Vec<Point>>();
        let mut bvh = Self {
            nodes: Vec::with_capacity(triangles.len() / (LEAF_TRIANGLES / 2) + 1),
            order: (0..triangles.len() as u32).collect(),
            boxes,
        };
        if !triangles.is_empty() {
            bvh.split(0, triangles.len(), &centroids);
        }
        bvh
    }

    fn split(&mut self, start: usize, end: usize, centroids: &[Point]) -> u32 {
        let mut bounds = Bounds::EMPTY;
        let mut spread = Bounds::EMPTY;
        for &triangle in &self.order[start..end] {
            bounds.join(&self.boxes[triangle as usize]);
            spread.add(centroids[triangle as usize]);
        }
        let index = self.nodes.len() as u32;
        self.nodes.push(Node {
            bounds,
            link: start as u32,
            count: (end - start) as u32,
        });
        let axis = (0..3)
            .max_by(|a, b| {
                (spread.max[*a] - spread.min[*a]).total_cmp(&(spread.max[*b] - spread.min[*b]))
            })
            .unwrap_or(0);
        if end - start <= LEAF_TRIANGLES || spread.max[axis] - spread.min[axis] <= 0.0 {
            return index;
        }
        let middle = (end - start) / 2;
        self.order[start..end].select_nth_unstable_by(middle, |a, b| {
            centroids[*a as usize][axis].total_cmp(&centroids[*b as usize][axis])
        });
        self.split(start, start + middle, centroids);
        let second = self.split(start + middle, end, centroids);
        self.nodes[index as usize].link = second;
        self.nodes[index as usize].count = 0;
        index
    }

    fn leaf(&self, node: &Node) -> &[u32] {
        &self.order[node.link as usize..(node.link + node.count) as usize]
    }

    fn ray(&self, origin: Point, direction: Point, mut visit: impl FnMut(u32)) {
        if self.nodes.is_empty() {
            return;
        }
        let mut stack = vec![0u32];
        while let Some(index) = stack.pop() {
            let node = &self.nodes[index as usize];
            if !node.bounds.hit_by_ray(origin, direction) {
                continue;
            }
            if node.count > 0 {
                self.leaf(node).iter().copied().for_each(&mut visit);
            } else {
                stack.push(index + 1);
                stack.push(node.link);
            }
        }
    }

    /// Every unordered pair of triangles whose boxes overlap, once.
    fn overlapping_pairs(
        &self,
        visit: &mut impl FnMut(u32, u32) -> CoreResult<()>,
    ) -> CoreResult<()> {
        if self.nodes.is_empty() {
            return Ok(());
        }
        let mut stack = vec![(0u32, 0u32)];
        while let Some((a, b)) = stack.pop() {
            let (first, second) = (&self.nodes[a as usize], &self.nodes[b as usize]);
            if a == b {
                if first.count > 0 {
                    let leaf = self.leaf(first);
                    for (i, &left) in leaf.iter().enumerate() {
                        for &right in &leaf[i + 1..] {
                            if self.boxes[left as usize].overlaps(&self.boxes[right as usize]) {
                                visit(left, right)?;
                            }
                        }
                    }
                } else {
                    stack.push((a + 1, a + 1));
                    stack.push((first.link, first.link));
                    stack.push((a + 1, first.link));
                }
                continue;
            }
            if !first.bounds.overlaps(&second.bounds) {
                continue;
            }
            match (first.count > 0, second.count > 0) {
                (true, true) => {
                    for &left in self.leaf(first) {
                        for &right in self.leaf(second) {
                            if self.boxes[left as usize].overlaps(&self.boxes[right as usize]) {
                                visit(left, right)?;
                            }
                        }
                    }
                }
                (false, _) => {
                    stack.push((a + 1, b));
                    stack.push((first.link, b));
                }
                (true, false) => {
                    stack.push((a, b + 1));
                    stack.push((a, second.link));
                }
            }
        }
        Ok(())
    }
}

fn parse_stl(bytes: &[u8]) -> CoreResult<Vec<Triangle>> {
    if bytes.len() > MAX_MESH_BYTES {
        return Err(work_limit("STL byte size", bytes.len(), MAX_MESH_BYTES));
    }
    if bytes.len() >= 84 {
        let count = u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as usize;
        if count.checked_mul(50).and_then(|size| size.checked_add(84)) == Some(bytes.len()) {
            if count > MAX_TRIANGLES {
                return Err(work_limit("Mesh triangles", count, MAX_TRIANGLES));
            }
            return Ok(bytes[84..]
                .as_chunks::<50>()
                .0
                .iter()
                .map(|record| {
                    std::array::from_fn(|vertex| {
                        std::array::from_fn(|axis| {
                            let at = 12 + vertex * 12 + axis * 4;
                            f64::from(f32::from_le_bytes([
                                record[at],
                                record[at + 1],
                                record[at + 2],
                                record[at + 3],
                            ]))
                        })
                    })
                })
                .collect());
        }
    }
    let raw = stl_io::read_stl(&mut std::io::Cursor::new(bytes))
        .map_err(|error| ContractError::validation(format!("Invalid STL mesh: {error}")))?;
    if raw.faces.len() > MAX_TRIANGLES {
        return Err(work_limit("Mesh triangles", raw.faces.len(), MAX_TRIANGLES));
    }
    Ok(raw
        .faces
        .iter()
        .map(|face| {
            face.vertices
                .map(|vertex| raw.vertices[vertex].0.map(f64::from))
        })
        .collect())
}

impl Mesh {
    pub fn read(bytes: &[u8]) -> CoreResult<Self> {
        Self::from_triangles(parse_stl(bytes)?)
    }

    pub fn from_triangles(triangles: Vec<Triangle>) -> CoreResult<Self> {
        if triangles.is_empty() {
            return Err(ContractError::validation("Mesh has no triangles"));
        }
        if triangles.len() > MAX_TRIANGLES {
            return Err(work_limit("Mesh triangles", triangles.len(), MAX_TRIANGLES));
        }
        let mut bounds = Bounds::EMPTY;
        let mut volume = 0.0;
        let mut area = 0.0;
        let mut ids = HashMap::<[i64; 3], u32>::new();
        let mut corners = Vec::<[u32; 3]>::with_capacity(triangles.len());
        for triangle in &triangles {
            if !triangle.iter().flatten().all(|value| value.is_finite()) {
                return Err(ContractError::validation(
                    "STL contains non-finite coordinates",
                ));
            }
            let normal = cross(sub(triangle[1], triangle[0]), sub(triangle[2], triangle[0]));
            area += dot(normal, normal).sqrt() * 0.5;
            volume += dot(triangle[0], cross(triangle[1], triangle[2])) / 6.0;
            corners.push(triangle.map(|point| {
                bounds.add(point);
                let next = ids.len() as u32;
                *ids.entry(point.map(|value| (value / WELD).round() as i64))
                    .or_insert(next)
            }));
        }
        // An edge is closed when exactly two faces use it in opposite directions.
        let mut edges = Vec::<(u32, u32, bool)>::with_capacity(corners.len() * 3);
        let mut parent = (0..ids.len() as u32).collect::<Vec<_>>();
        for [a, b, c] in &corners {
            for (from, to) in [(a, b), (b, c)] {
                let (x, y) = (root(&mut parent, *from), root(&mut parent, *to));
                parent[x as usize] = y;
            }
            if a == b || b == c || a == c {
                continue;
            }
            for (from, to) in [(*a, *b), (*b, *c), (*c, *a)] {
                edges.push((from.min(to), from.max(to), from < to));
            }
        }
        edges.sort_unstable();
        let (mut boundary_edges, mut non_manifold_edges) = (0, 0);
        for group in edges.chunk_by(|a, b| (a.0, a.1) == (b.0, b.1)) {
            let forward = group.iter().filter(|edge| edge.2).count();
            let backward = group.len() - forward;
            if group.len() == 1 {
                boundary_edges += 1;
            } else if group.len() > 2 || forward > 1 || backward > 1 {
                non_manifold_edges += 1;
            }
        }
        let mut shells = (0..ids.len() as u32)
            .map(|vertex| root(&mut parent, vertex))
            .collect::<Vec<_>>();
        shells.sort_unstable();
        shells.dedup();
        Ok(Self {
            triangles,
            bounds_min: bounds.min,
            bounds_max: bounds.max,
            volume: volume.abs(),
            area,
            watertight: boundary_edges == 0 && non_manifold_edges == 0,
            inverted: volume < 0.0,
            shells: shells.len(),
            boundary_edges,
            non_manifold_edges,
            index: OnceLock::new(),
        })
    }

    /// Reverse the winding of a closed inside-out mesh so it displays and
    /// measures as a solid. An open mesh is left alone: flipping it would be a
    /// guess. The flag says whether the source needed the correction.
    pub fn outward(mut self) -> (Self, bool) {
        if !self.watertight || !self.inverted {
            return (self, false);
        }
        for triangle in &mut self.triangles {
            triangle.swap(1, 2);
        }
        self.inverted = false;
        self.index = OnceLock::new();
        (self, true)
    }

    /// Binary STL of the mesh as held. Normals are left zero; readers recompute them.
    pub fn to_binary_stl(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(84 + self.triangles.len() * 50);
        out.extend_from_slice(b"omenflow");
        out.resize(80, 0);
        out.extend_from_slice(&(self.triangles.len() as u32).to_le_bytes());
        for triangle in &self.triangles {
            out.extend_from_slice(&[0; 12]);
            for value in triangle.iter().flatten() {
                out.extend_from_slice(&(*value as f32).to_le_bytes());
            }
            out.extend_from_slice(&[0; 2]);
        }
        out
    }

    pub fn size(&self) -> Point {
        std::array::from_fn(|axis| self.bounds_max[axis] - self.bounds_min[axis])
    }

    pub fn summary(&self) -> Value {
        let r3 = |v: f64| (v * 1000.0).round() / 1000.0;
        json!({"unit":"mm","bounds":{"min":self.bounds_min.map(r3),"max":self.bounds_max.map(r3),"size":self.size().map(r3)},
            "volume":r3(self.volume),"surfaceArea":r3(self.area),"triangles":self.triangles.len(),
            "watertight":self.watertight&&!self.inverted,"shells":self.shells})
    }

    fn index(&self) -> &Bvh {
        self.index.get_or_init(|| Bvh::build(&self.triangles))
    }

    /// Inside/outside by ray parity, majority over five directions so a ray
    /// grazing an edge or vertex cannot flip the answer.
    pub fn contains(&self, point: Point) -> bool {
        const DIRECTIONS: [Point; 5] = [
            [0.577350269, 0.577350269, 0.577350269],
            [-0.267261242, 0.534522484, 0.801783726],
            [0.801783726, -0.267261242, -0.534522484],
            [-0.40824829, -0.816496581, 0.40824829],
            [0.301511345, -0.904534034, 0.301511345],
        ];
        let index = self.index();
        let mut inside = 0;
        let mut distances = Vec::new();
        for direction in DIRECTIONS {
            distances.clear();
            index.ray(point, direction, |triangle| {
                if let Some(distance) =
                    ray_triangle(point, direction, &self.triangles[triangle as usize])
                {
                    distances.push(distance);
                }
            });
            // A face diagonal or vertex belongs to several triangles but is one
            // surface crossing; opposite sides of a thin wall stay distinct.
            distances.sort_by(f64::total_cmp);
            let mut hits = 0;
            let mut previous = f64::NEG_INFINITY;
            for &distance in &distances {
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
        inside > DIRECTIONS.len() / 2
    }

    /// Triangle pairs whose interiors cross. Faces that share an edge are
    /// neighbours, not intersections.
    pub fn count_intersections(&self) -> CoreResult<usize> {
        let mut candidates = 0usize;
        let mut hits = 0usize;
        self.index().overlapping_pairs(&mut |a, b| {
            candidates += 1;
            if candidates > MAX_INTERSECTION_CANDIDATES {
                return Err(work_limit(
                    "Self-intersection candidate pairs",
                    candidates,
                    MAX_INTERSECTION_CANDIDATES,
                ));
            }
            let (first, second) = (&self.triangles[a as usize], &self.triangles[b as usize]);
            if shared_vertices(first, second) < 2 && triangles_intersect(first, second) {
                hits += 1;
            }
            Ok(())
        })?;
        Ok(hits)
    }

    /// Thinnest wall seen from up to `samples` faces: the distance from a face
    /// centre, along its inward normal, to the next surface.
    pub fn min_wall_thickness(&self, samples: usize) -> Option<f64> {
        let step = (self.triangles.len() / samples.max(1)).max(1);
        let index = self.index();
        let mut thinnest = f64::INFINITY;
        for (at, triangle) in self.triangles.iter().enumerate().step_by(step) {
            let mut normal = cross(sub(triangle[1], triangle[0]), sub(triangle[2], triangle[0]));
            let length = dot(normal, normal).sqrt();
            if length < 1e-12 {
                continue;
            }
            let sign = if self.inverted { -1.0 } else { 1.0 };
            normal = normal.map(|value| sign * value / length);
            let centre: Point = std::array::from_fn(|axis| {
                (triangle[0][axis] + triangle[1][axis] + triangle[2][axis]) / 3.0
            });
            let origin: Point = std::array::from_fn(|axis| centre[axis] - normal[axis] * 1e-4);
            let inward = normal.map(|value| -value);
            index.ray(origin, inward, |other| {
                if other as usize != at {
                    if let Some(distance) =
                        ray_triangle(origin, inward, &self.triangles[other as usize])
                    {
                        thinnest = thinnest.min(distance);
                    }
                }
            });
        }
        thinnest.is_finite().then_some(thinnest)
    }
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    /// Axis-aligned box as twelve outward-wound triangles; `invert` turns it inside out.
    pub(crate) fn cuboid(min: Point, max: Point, invert: bool) -> Vec<Triangle> {
        let v = [
            [min[0], min[1], min[2]],
            [max[0], min[1], min[2]],
            [max[0], max[1], min[2]],
            [min[0], max[1], min[2]],
            [min[0], min[1], max[2]],
            [max[0], min[1], max[2]],
            [max[0], max[1], max[2]],
            [min[0], max[1], max[2]],
        ];
        [
            [0, 2, 1],
            [0, 3, 2],
            [4, 5, 6],
            [4, 6, 7],
            [0, 1, 5],
            [0, 5, 4],
            [3, 7, 6],
            [3, 6, 2],
            [0, 4, 7],
            [0, 7, 3],
            [1, 2, 6],
            [1, 6, 5],
        ]
        .iter()
        .map(|face: &[usize; 3]| {
            if invert {
                [v[face[0]], v[face[2]], v[face[1]]]
            } else {
                [v[face[0]], v[face[1]], v[face[2]]]
            }
        })
        .collect()
    }

    /// A `size` plate with its corner at the origin and one through hole along
    /// z: a regular `facets`-gon inscribed in the hole circle, as OpenSCAD
    /// renders a cylinder.
    pub(crate) fn plate_with_hole(
        size: Point,
        centre: [f64; 2],
        diameter: f64,
        facets: usize,
    ) -> Vec<Triangle> {
        let radius = diameter / 2.0;
        let ring = (0..facets)
            .map(|i| {
                let angle = std::f64::consts::TAU * i as f64 / facets as f64;
                (angle.cos(), angle.sin())
            })
            .collect::<Vec<_>>();
        let hole = ring
            .iter()
            .map(|(c, s)| [centre[0] + radius * c, centre[1] + radius * s])
            .collect::<Vec<_>>();
        let edge = ring
            .iter()
            .map(|(c, s)| {
                let reach = |towards: f64, from: f64, extent: f64| {
                    if towards > 1e-12 {
                        (extent - from) / towards
                    } else if towards < -1e-12 {
                        -from / towards
                    } else {
                        f64::INFINITY
                    }
                };
                let t = reach(*c, centre[0], size[0]).min(reach(*s, centre[1], size[1]));
                [centre[0] + t * c, centre[1] + t * s]
            })
            .collect::<Vec<_>>();
        let corners = [
            [size[0], size[1]],
            [0.0, size[1]],
            [0.0, 0.0],
            [size[0], 0.0],
        ];
        let on_same_side = |a: [f64; 2], b: [f64; 2]| {
            (0..2).any(|axis| {
                (a[axis] - b[axis]).abs() < 1e-9
                    && ((a[axis]).abs() < 1e-9 || (a[axis] - size[axis]).abs() < 1e-9)
            })
        };
        let at = |p: [f64; 2], z: f64| [p[0], p[1], z];
        let (bottom, top) = (0.0, size[2]);
        let mut out = Vec::new();
        for i in 0..facets {
            let j = (i + 1) % facets;
            let mut rim = vec![edge[i]];
            if !on_same_side(edge[i], edge[j]) {
                let corner = corners
                    .iter()
                    .copied()
                    .find(|corner| on_same_side(edge[i], *corner) && on_same_side(*corner, edge[j]))
                    .expect("adjacent rim points meet at one corner");
                rim.push(corner);
            }
            rim.push(edge[j]);
            // Annulus between the hole and the rim, top (counter-clockwise) and bottom.
            let mut fan = vec![hole[i]];
            fan.extend(rim.iter().copied());
            fan.push(hole[j]);
            for k in 1..fan.len() - 1 {
                out.push([at(fan[0], top), at(fan[k], top), at(fan[k + 1], top)]);
                out.push([
                    at(fan[0], bottom),
                    at(fan[k + 1], bottom),
                    at(fan[k], bottom),
                ]);
            }
            // Hole wall faces the hole axis; the outer wall faces away from it.
            out.push([at(hole[i], bottom), at(hole[i], top), at(hole[j], top)]);
            out.push([at(hole[i], bottom), at(hole[j], top), at(hole[j], bottom)]);
            for pair in rim.windows(2) {
                out.push([at(pair[0], bottom), at(pair[1], bottom), at(pair[1], top)]);
                out.push([at(pair[0], bottom), at(pair[1], top), at(pair[0], top)]);
            }
        }
        out
    }

    /// A `facets`-sided prism along z from 0 to `height`, as OpenSCAD renders a cylinder.
    pub(crate) fn cylinder(
        centre: [f64; 2],
        diameter: f64,
        height: f64,
        facets: usize,
    ) -> Vec<Triangle> {
        let ring = (0..facets)
            .map(|i| {
                let angle = std::f64::consts::TAU * i as f64 / facets as f64;
                [
                    centre[0] + diameter / 2.0 * angle.cos(),
                    centre[1] + diameter / 2.0 * angle.sin(),
                ]
            })
            .collect::<Vec<_>>();
        let at = |p: [f64; 2], z: f64| [p[0], p[1], z];
        let mut out = Vec::new();
        for i in 0..facets {
            let (a, b) = (ring[i], ring[(i + 1) % facets]);
            out.push([at(centre, height), at(a, height), at(b, height)]);
            out.push([at(centre, 0.0), at(b, 0.0), at(a, 0.0)]);
            out.push([at(a, 0.0), at(b, 0.0), at(b, height)]);
            out.push([at(a, 0.0), at(b, height), at(a, height)]);
        }
        out
    }

    pub(crate) fn mesh(triangles: Vec<Triangle>) -> Mesh {
        Mesh::from_triangles(triangles).unwrap()
    }

    pub(crate) fn merged(parts: &[Vec<Triangle>]) -> Mesh {
        mesh(parts.concat())
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    fn brute_contains(mesh: &Mesh, point: Point) -> bool {
        let directions: [Point; 5] = [
            [0.577350269, 0.577350269, 0.577350269],
            [-0.267261242, 0.534522484, 0.801783726],
            [0.801783726, -0.267261242, -0.534522484],
            [-0.40824829, -0.816496581, 0.40824829],
            [0.301511345, -0.904534034, 0.301511345],
        ];
        let mut inside = 0;
        for direction in directions {
            let mut distances = mesh
                .triangles
                .iter()
                .filter_map(|triangle| ray_triangle(point, direction, triangle))
                .collect::<Vec<_>>();
            distances.sort_by(f64::total_cmp);
            let mut hits = 0;
            let mut previous = f64::NEG_INFINITY;
            for distance in distances {
                if distance - previous > (16.0 * f64::EPSILON * distance.abs()).max(1e-8) {
                    hits += 1;
                    previous = distance;
                }
            }
            inside += hits % 2;
        }
        inside > 2
    }

    fn brute_intersections(mesh: &Mesh) -> usize {
        let mut hits = 0;
        for a in 0..mesh.triangles.len() {
            for b in a + 1..mesh.triangles.len() {
                let (first, second) = (&mesh.triangles[a], &mesh.triangles[b]);
                if Bounds::of(first).overlaps(&Bounds::of(second))
                    && shared_vertices(first, second) < 2
                    && triangles_intersect(first, second)
                {
                    hits += 1;
                }
            }
        }
        hits
    }

    /// A box whose six faces are each split along either diagonal, by `mask`.
    fn diagonal_box(lo: f64, hi: f64, mask: u32) -> Vec<Triangle> {
        let v = [
            [lo, lo, lo],
            [hi, lo, lo],
            [hi, hi, lo],
            [lo, hi, lo],
            [lo, lo, hi],
            [hi, lo, hi],
            [hi, hi, hi],
            [lo, hi, hi],
        ];
        [
            [0, 3, 2, 1],
            [4, 5, 6, 7],
            [0, 1, 5, 4],
            [1, 2, 6, 5],
            [2, 3, 7, 6],
            [3, 0, 4, 7],
        ]
        .iter()
        .enumerate()
        .flat_map(|(i, [a, b, c, d])| {
            if mask & (1 << i) != 0 {
                [[v[*a], v[*b], v[*d]], [v[*b], v[*c], v[*d]]]
            } else {
                [[v[*a], v[*b], v[*c]], [v[*a], v[*c], v[*d]]]
            }
        })
        .collect()
    }

    fn lcg(state: &mut u64) -> f64 {
        *state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((*state >> 11) as f64) / ((1u64 << 53) as f64)
    }

    #[test]
    fn cube_reports_bounds_volume_area_and_closed_topology() {
        let cube = mesh(cuboid([0.0, 0.0, 0.0], [10.0, 20.0, 30.0], false));
        assert_eq!(cube.bounds_min, [0.0, 0.0, 0.0]);
        assert_eq!(cube.bounds_max, [10.0, 20.0, 30.0]);
        assert!((cube.volume - 6000.0).abs() < 1e-9);
        assert!((cube.area - 2200.0).abs() < 1e-9);
        assert!(cube.watertight && !cube.inverted);
        assert_eq!(
            (cube.shells, cube.boundary_edges, cube.non_manifold_edges),
            (1, 0, 0)
        );
        assert_eq!(cube.summary()["bounds"]["size"], json!([10.0, 20.0, 30.0]));
    }

    #[test]
    fn separate_bodies_open_faces_and_inconsistent_winding_are_reported() {
        let two = merged(&[
            cuboid([0.0; 3], [5.0; 3], false),
            cuboid([20.0, 0.0, 0.0], [25.0, 5.0, 5.0], false),
        ]);
        assert_eq!(two.shells, 2);
        assert!((two.volume - 250.0).abs() < 1e-9);
        let mut open = cuboid([0.0; 3], [10.0; 3], false);
        open.truncate(10);
        let open = mesh(open);
        assert!(!open.watertight);
        assert_eq!(open.boundary_edges, 4);
        let mut twisted = cuboid([0.0; 3], [10.0; 3], false);
        twisted[0].swap(1, 2);
        let twisted = mesh(twisted);
        assert!(!twisted.watertight);
        assert_eq!(twisted.boundary_edges, 0);
        assert_eq!(twisted.non_manifold_edges, 3);
    }

    #[test]
    fn negative_zero_and_exporter_noise_weld_to_one_vertex() {
        let mut cube = cuboid([0.0; 3], [10.0; 3], false);
        for triangle in cube.iter_mut().step_by(2) {
            for point in triangle.iter_mut() {
                for value in point.iter_mut() {
                    if *value == 0.0 {
                        *value = -0.0;
                    } else {
                        *value += 2e-6;
                    }
                }
            }
        }
        let cube = mesh(cube);
        assert!(cube.watertight, "{} boundary edges", cube.boundary_edges);
        assert_eq!(cube.shells, 1);
    }

    #[test]
    fn inside_out_closed_mesh_is_flagged_and_can_be_turned_outward() {
        let inverted = mesh(cuboid([0.0; 3], [10.0, 20.0, 30.0], true));
        assert!(inverted.inverted && inverted.watertight);
        assert!(!inverted.summary()["watertight"].as_bool().unwrap());
        let (fixed, corrected) = inverted.outward();
        assert!(corrected);
        assert!(!fixed.inverted && fixed.watertight);
        let reread = Mesh::read(&fixed.to_binary_stl()).unwrap();
        assert!(!reread.inverted);
        assert!((reread.volume - 6000.0).abs() < 1e-6);
        assert!(reread.contains([5.0, 10.0, 15.0]));
        assert!(!reread.contains([15.0, 10.0, 15.0]));
        let (same, corrected) = mesh(cuboid([0.0; 3], [1.0; 3], false)).outward();
        assert!(!corrected && !same.inverted);
        let open = mesh(vec![[[0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [5.0, 8.0, 0.0]]]);
        assert!(!open.outward().1);
    }

    #[test]
    fn containment_does_not_depend_on_how_faces_are_triangulated() {
        for mask in 0..64 {
            let shell = merged(&[
                diagonal_box(0.0, 20.0, mask),
                diagonal_box(2.0, 18.0, mask ^ 42),
            ]);
            for cavity in [[10.0, 10.0, 10.0], [3.0, 4.0, 5.0], [17.0, 16.0, 15.0]] {
                assert!(!shell.contains(cavity), "cavity {mask} at {cavity:?}");
            }
            for material in [[1.0, 10.0, 10.0], [19.0, 9.0, 10.0], [10.0, 1.0, 9.0]] {
                assert!(shell.contains(material), "material {mask} at {material:?}");
            }
            assert!(!shell.contains([30.0, 10.0, 10.0]));
        }
        let thin = merged(&[diagonal_box(0.0, 20.0, 21), diagonal_box(0.001, 19.999, 42)]);
        assert!(thin.contains([0.0005, 10.0, 10.0]));
        assert!(!thin.contains([10.0, 10.0, 10.0]));
    }

    #[test]
    fn indexed_queries_agree_with_exhaustive_search() {
        let plate = merged(&[
            plate_with_hole([60.0, 40.0, 6.0], [22.0, 17.0], 9.0, 48),
            cuboid([10.0, 10.0, 6.0], [14.0, 14.0, 12.0], false),
            cuboid([55.0, 35.0, 2.0], [70.0, 50.0, 9.0], false),
        ]);
        let mut state = 7u64;
        for _ in 0..600 {
            let point = [
                -5.0 + 80.0 * lcg(&mut state),
                -5.0 + 60.0 * lcg(&mut state),
                -3.0 + 18.0 * lcg(&mut state),
            ];
            assert_eq!(
                plate.contains(point),
                brute_contains(&plate, point),
                "{point:?}"
            );
        }
        assert_eq!(
            plate.count_intersections().unwrap(),
            brute_intersections(&plate)
        );
        assert!(plate.count_intersections().unwrap() > 0);
    }

    #[test]
    fn clean_solids_have_no_self_intersections_and_piercing_ones_do() {
        assert_eq!(
            mesh(cuboid([0.0; 3], [10.0; 3], false))
                .count_intersections()
                .unwrap(),
            0
        );
        assert_eq!(
            mesh(plate_with_hole([40.0, 30.0, 4.0], [20.0, 15.0], 6.0, 64))
                .count_intersections()
                .unwrap(),
            0
        );
        let pierced = merged(&[
            cuboid([0.0; 3], [10.0; 3], false),
            cuboid([5.0; 3], [15.0; 3], false),
        ]);
        assert!(pierced.count_intersections().unwrap() > 0);
    }

    #[test]
    fn wall_thickness_of_a_hollow_cube_is_its_wall() {
        let hollow = merged(&[
            cuboid([0.0; 3], [20.0; 3], false),
            cuboid([2.0; 3], [18.0; 3], true),
        ]);
        let wall = hollow.min_wall_thickness(80).unwrap();
        assert!((1.5..2.6).contains(&wall), "{wall}");
    }

    #[test]
    fn plate_fixture_is_a_closed_solid_of_the_stated_volume() {
        let facets = 64;
        let plate = mesh(plate_with_hole(
            [100.0, 40.0, 6.0],
            [50.0, 20.0],
            8.0,
            facets,
        ));
        let hole_area = facets as f64 * 0.5 * 16.0 * (std::f64::consts::TAU / facets as f64).sin();
        assert!(
            plate.watertight && !plate.inverted,
            "{} open edges",
            plate.boundary_edges
        );
        assert_eq!(plate.shells, 1);
        assert!((plate.volume - (24_000.0 - hole_area * 6.0)).abs() < 1e-6);
        assert!(!plate.contains([50.0, 20.0, 3.0]));
        assert!(plate.contains([10.0, 10.0, 3.0]));
        assert!(plate.contains([50.0, 24.5, 3.0]));
        assert!(!plate.contains([50.0, 23.5, 3.0]));
        let offset = mesh(plate_with_hole([40.0, 30.0, 4.0], [7.0, 22.0], 3.2, 32));
        assert!(offset.watertight && !offset.inverted);
    }

    #[test]
    fn stl_limits_are_checked_before_triangles_are_allocated() {
        let oversized = vec![0u8; MAX_MESH_BYTES + 1];
        let error = Mesh::read(&oversized).err().unwrap();
        assert!(is_work_limit(&error), "{error}");
        assert_eq!(error.details.as_deref().unwrap()["status"], "not_evaluated");
        let mut declared = vec![0u8; 84 + (MAX_TRIANGLES + 1) * 50];
        declared[80..84].copy_from_slice(&((MAX_TRIANGLES + 1) as u32).to_le_bytes());
        assert!(is_work_limit(&Mesh::read(&declared).err().unwrap()));
        let mut stl = mesh(cuboid([0.0; 3], [1.0; 3], false)).to_binary_stl();
        stl[96..100].copy_from_slice(&f32::INFINITY.to_le_bytes());
        assert!(Mesh::read(&stl)
            .err()
            .unwrap()
            .message
            .contains("non-finite"));
        let ascii = "solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid x\n";
        assert_eq!(Mesh::read(ascii.as_bytes()).unwrap().triangles.len(), 1);
        assert!(Mesh::read(b"not a mesh").is_err());
    }

    #[test]
    fn a_detailed_mesh_is_measured_and_probed_within_the_limits() {
        // 120 × 120 × 6 faces × 2 = 172,800 triangles on a cube surface.
        let n = 120usize;
        let step = 30.0 / n as f64;
        let mut triangles = Vec::with_capacity(n * n * 12);
        for axis in 0..3 {
            let (u, v) = ((axis + 1) % 3, (axis + 2) % 3);
            for (level, outward) in [(0.0, false), (30.0, true)] {
                for i in 0..n {
                    for j in 0..n {
                        let corner = |di: usize, dj: usize| {
                            let mut point = [0.0; 3];
                            point[axis] = level;
                            point[u] = (i + di) as f64 * step;
                            point[v] = (j + dj) as f64 * step;
                            point
                        };
                        let quad = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
                        if outward {
                            triangles.push([quad[0], quad[1], quad[2]]);
                            triangles.push([quad[0], quad[2], quad[3]]);
                        } else {
                            triangles.push([quad[0], quad[2], quad[1]]);
                            triangles.push([quad[0], quad[3], quad[2]]);
                        }
                    }
                }
            }
        }
        let cube = mesh(triangles);
        assert_eq!(cube.triangles.len(), 172_800);
        assert!(cube.watertight && !cube.inverted);
        assert!((cube.volume - 27_000.0).abs() < 1e-6);
        assert!(cube.contains([15.0, 15.0, 15.0]));
        assert!(!cube.contains([31.0, 15.0, 15.0]));
        assert_eq!(cube.count_intersections().unwrap(), 0);
        assert!((cube.min_wall_thickness(80).unwrap() - 30.0).abs() < 1e-3);
    }
}
