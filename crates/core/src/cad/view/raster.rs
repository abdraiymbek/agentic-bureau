//! Drawing a mesh into one panel: a depth-buffered, shaded orthographic view
//! with its feature edges (visible ones solid, hidden ones dashed), or a
//! section with its material filled. Only +, −, ×, ÷ and square roots are
//! used, so a mesh and a request give the same pixels on every machine.
use super::*;
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

pub(super) const BG: u8 = 0;
pub(super) const INK: u8 = 1;
pub(super) const HIDDEN: u8 = 2;
pub(super) const FRAME: u8 = 3;
pub(super) const FILL: u8 = 4;
const SHADE: u8 = 5;
const SHADES: f64 = 8.0;
pub(super) const BACK: u8 = 13;

/// The fixed colours of a drawing, by index: background, ink, hidden edges,
/// panel frames, section fill, eight shades from light to dark, back faces.
pub(super) const PALETTE: [[u8; 3]; 14] = [
    [0xFF, 0xFF, 0xFF],
    [0x00, 0x00, 0x00],
    [0x60, 0x60, 0x60],
    [0xC4, 0xC4, 0xC4],
    [0xBF, 0xD7, 0xEE],
    [0xF4, 0xF4, 0xF4],
    [0xE8, 0xE8, 0xE8],
    [0xDC, 0xDC, 0xDC],
    [0xD0, 0xD0, 0xD0],
    [0xC4, 0xC4, 0xC4],
    [0xB8, 0xB8, 0xB8],
    [0xAC, 0xAC, 0xAC],
    [0xA0, 0xA0, 0xA0],
    [0xE6, 0xC4, 0xC4],
];

/// Two faces meeting at more than 30° make a drawn edge. A literal, not a
/// computed cosine, so the threshold is the same everywhere.
const COS_CREASE: f64 = 0.866_025_403_784_438_7;
/// Vertices closer than this are one vertex, as `mesh.rs` welds them.
const WELD: f64 = 1e-5;
/// Facing threshold: a face whose normal is this close to perpendicular to
/// the view direction is seen edge on.
const FACING: f64 = 1e-9;
/// Dash length of hidden edges, in pixels.
pub(super) const DASH: i64 = 4;

pub(super) fn sub(a: P3, b: P3) -> P3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
pub(super) fn dot(a: P3, b: P3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
pub(super) fn cross(a: P3, b: P3) -> P3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
pub(super) fn normalize(a: P3) -> P3 {
    let length = dot(a, a).sqrt();
    if length > 0.0 {
        [a[0] / length, a[1] / length, a[2] / length]
    } else {
        [0.0; 3]
    }
}

/// An indexed picture, row by row.
pub(super) struct Canvas {
    pub width: usize,
    pub height: usize,
    pub pixels: Vec<u8>,
}

impl Canvas {
    pub fn new(width: usize, height: usize) -> Self {
        Self {
            width,
            height,
            pixels: vec![BG; width * height],
        }
    }

    pub fn set(&mut self, x: i64, y: i64, colour: u8) {
        if x >= 0 && y >= 0 && (x as usize) < self.width && (y as usize) < self.height {
            self.pixels[y as usize * self.width + x as usize] = colour;
        }
    }

    #[cfg(test)]
    pub fn get(&self, x: usize, y: usize) -> u8 {
        self.pixels[y * self.width + x]
    }

    /// Copy the non-background pixels of `panel` with its corner at (x, y).
    pub fn blit(&mut self, panel: &Canvas, x: i64, y: i64) {
        for row in 0..panel.height {
            for column in 0..panel.width {
                let colour = panel.pixels[row * panel.width + column];
                if colour != BG {
                    self.set(x + column as i64, y + row as i64, colour);
                }
            }
        }
    }

    /// A one-pixel outline.
    pub fn outline(&mut self, x: i64, y: i64, width: i64, height: i64, colour: u8) {
        for i in 0..width {
            self.set(x + i, y, colour);
            self.set(x + i, y + height - 1, colour);
        }
        for j in 0..height {
            self.set(x, y + j, colour);
            self.set(x + width - 1, y + j, colour);
        }
    }

    pub fn text(&mut self, text: &str, x: i64, y: i64, k: usize) {
        font::draw(text, x, y, k, &mut |px, py| self.set(px, py, INK));
    }
}

/// A fast hash for welding vertex keys. Ids are given in order of first
/// appearance, so the drawing does not depend on the hash.
#[derive(Default)]
struct WeldHasher(u64);

impl Hasher for WeldHasher {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        for chunk in bytes.chunks(8) {
            let mut word = [0u8; 8];
            word[..chunk.len()].copy_from_slice(chunk);
            self.write_u64(u64::from_le_bytes(word));
        }
    }

    fn write_u64(&mut self, value: u64) {
        self.0 = (self.0.rotate_left(5) ^ value).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }

    fn write_i64(&mut self, value: i64) {
        self.write_u64(value as u64);
    }
}

/// An edge shared by the faces `faces[0]` and `faces[1]`; `NONE` in the
/// second place for a boundary or non-manifold edge, which is always drawn.
#[derive(Clone, Copy)]
struct Edge {
    ends: [u32; 2],
    faces: [u32; 2],
    crease: bool,
}

const NONE: u32 = u32::MAX;

/// The mesh with its vertices welded: face normals and the edges a drawing
/// can show. Built once per call and shared by every panel.
pub(super) struct Topology {
    pub points: Vec<P3>,
    normals: Vec<P3>,
    edges: Vec<Edge>,
    /// Closed and wound outward: faces turned away are never seen.
    closed: bool,
}

impl Topology {
    pub fn new(mesh: &mesh::Mesh) -> Self {
        // Ids in order of first appearance, so the result does not depend on
        // the map's iteration order.
        let mut ids =
            HashMap::<[i64; 3], u32, BuildHasherDefault<WeldHasher>>::with_capacity_and_hasher(
                mesh.triangles.len() / 2 + 8,
                Default::default(),
            );
        let mut points = Vec::new();
        let mut corners = Vec::with_capacity(mesh.triangles.len());
        for triangle in &mesh.triangles {
            corners.push(triangle.map(|p| {
                let key = p.map(|value| (value / WELD).round() as i64);
                *ids.entry(key).or_insert_with(|| {
                    points.push(p);
                    (points.len() - 1) as u32
                })
            }));
        }
        let normals = mesh
            .triangles
            .iter()
            .map(|t| normalize(cross(sub(t[1], t[0]), sub(t[2], t[0]))))
            .collect::<Vec<_>>();
        let mut halves = Vec::with_capacity(mesh.triangles.len() * 3);
        for (face, c) in corners.iter().enumerate() {
            if c[0] == c[1] || c[1] == c[2] || c[0] == c[2] {
                continue;
            }
            for (a, b) in [(c[0], c[1]), (c[1], c[2]), (c[2], c[0])] {
                halves.push((
                    (u64::from(a.min(b)) << 32) | u64::from(a.max(b)),
                    face as u32,
                ));
            }
        }
        halves.sort_unstable();
        let edges = halves
            .chunk_by(|a, b| a.0 == b.0)
            .map(|group| {
                let ends = [(group[0].0 >> 32) as u32, (group[0].0 & 0xffff_ffff) as u32];
                match group {
                    [(_, f), (_, g)] => Edge {
                        ends,
                        faces: [*f, *g],
                        crease: dot(normals[*f as usize], normals[*g as usize]) < COS_CREASE,
                    },
                    _ => Edge {
                        ends,
                        faces: [group[0].1, NONE],
                        crease: true,
                    },
                }
            })
            .collect();
        Self {
            points,
            normals,
            edges,
            closed: mesh.watertight && !mesh.inverted,
        }
    }

    /// Whether faces turned away from the viewer are left out of a view.
    pub fn closed(&self) -> bool {
        self.closed
    }

    /// [u min, u max, v min, v max] of the mesh in a view, mm.
    pub fn extent(&self, frame: &Frame) -> [f64; 4] {
        let mut extent = [
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
        ];
        for p in &self.points {
            let (u, v) = (dot(*p, frame.right), dot(*p, frame.up));
            extent[0] = extent[0].min(u);
            extent[1] = extent[1].max(u);
            extent[2] = extent[2].min(v);
            extent[3] = extent[3].max(v);
        }
        extent
    }
}

/// Where model coordinates land in a panel: content centred, `scale` mm per
/// pixel, u to the right and v up.
#[derive(Clone, Copy, Debug)]
pub(super) struct Placement {
    pub extent: [f64; 4],
    pub scale: f64,
    pub offset: [f64; 2],
}

impl Placement {
    pub fn centred(extent: [f64; 4], scale: f64, width: usize, height: usize) -> Self {
        let content = [
            (extent[1] - extent[0]) / scale,
            (extent[3] - extent[2]) / scale,
        ];
        Self {
            extent,
            scale,
            offset: [
                (width as f64 - content[0]) / 2.0,
                (height as f64 - content[1]) / 2.0,
            ],
        }
    }

    /// Pixel position of the in-plane point (u, v).
    pub fn map(&self, u: f64, v: f64) -> (f64, f64) {
        (
            (u - self.extent[0]) / self.scale + self.offset[0],
            (self.extent[3] - v) / self.scale + self.offset[1],
        )
    }

    /// The model (u, v) at the panel's top left corner.
    pub fn origin(&self) -> [f64; 2] {
        [
            self.extent[0] - self.offset[0] * self.scale,
            self.extent[3] + self.offset[1] * self.scale,
        ]
    }
}

/// The pixels of the line from `a` to `b`, one per column or row along its
/// longer axis, where it crosses that column's or row's middle, with how far
/// along the line that is (0 to 1). Stepping by pixel rather than by
/// fractions of the length leaves no row out where rounding would skip one.
fn line(a: (f64, f64), b: (f64, f64), mut visit: impl FnMut(i64, i64, f64)) {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let along_x = dx.abs() >= dy.abs();
    let (from, to) = if along_x { (a.0, b.0) } else { (a.1, b.1) };
    for major in from.min(to).floor() as i64..=from.max(to).floor() as i64 {
        let t = if to == from {
            0.0
        } else {
            ((major as f64 + 0.5 - from) / (to - from)).clamp(0.0, 1.0)
        };
        if along_x {
            visit(major, (a.1 + t * dy).floor() as i64, t);
        } else {
            visit((a.0 + t * dx).floor() as i64, major, t);
        }
    }
}

/// One orthographic or isometric view. `hidden`: dash the edges that are
/// behind a surface.
pub(super) fn view_panel(
    mesh: &mesh::Mesh,
    topology: &Topology,
    frame: &Frame,
    placement: &Placement,
    size: (usize, usize),
    hidden: bool,
) -> Canvas {
    let (width, height) = size;
    let mut panel = Canvas::new(width, height);
    let project = |p: P3| {
        let (x, y) = placement.map(dot(p, frame.right), dot(p, frame.up));
        (x, y, -dot(p, frame.from))
    };
    let mut depth = vec![f64::INFINITY; width * height];
    let light = normalize(
        [0, 1, 2].map(|i| 0.85 * frame.from[i] + 0.45 * frame.up[i] - 0.30 * frame.right[i]),
    );
    for (index, triangle) in mesh.triangles.iter().enumerate() {
        let normal = topology.normals[index];
        let colour = if dot(normal, frame.from) > FACING {
            let lit = dot(normal, light).max(0.0);
            SHADE + ((1.0 - lit) * SHADES).floor().clamp(0.0, SHADES - 1.0) as u8
        } else if topology.closed {
            continue;
        } else {
            BACK
        };
        let q = triangle.map(project);
        let area = (q[1].0 - q[0].0) * (q[2].1 - q[0].1) - (q[2].0 - q[0].0) * (q[1].1 - q[0].1);
        if area.abs() < 1e-12 {
            continue;
        }
        let bound = |pick: fn(&(f64, f64, f64)) -> f64, limit: usize| {
            let low = q.iter().map(pick).fold(f64::INFINITY, f64::min);
            let high = q.iter().map(pick).fold(f64::NEG_INFINITY, f64::max);
            (
                low.floor().max(0.0) as i64,
                (high.ceil() as i64).min(limit as i64 - 1),
            )
        };
        let (x0, x1) = bound(|p| p.0, width);
        let (y0, y1) = bound(|p| p.1, height);
        let inverse = 1.0 / area;
        for py in y0..=y1 {
            let cy = py as f64 + 0.5;
            for px in x0..=x1 {
                let cx = px as f64 + 0.5;
                let w0 = ((q[1].0 - cx) * (q[2].1 - cy) - (q[2].0 - cx) * (q[1].1 - cy)) * inverse;
                let w1 = ((q[2].0 - cx) * (q[0].1 - cy) - (q[0].0 - cx) * (q[2].1 - cy)) * inverse;
                let w2 = 1.0 - w0 - w1;
                if w0 < 0.0 || w1 < 0.0 || w2 < 0.0 {
                    continue;
                }
                let d = w0 * q[0].2 + w1 * q[1].2 + w2 * q[2].2;
                let at = py as usize * width + px as usize;
                if d < depth[at] {
                    depth[at] = d;
                    panel.pixels[at] = colour;
                }
            }
        }
    }
    // Feature edges over the shading: visible ink wins over a dash.
    let tolerance = 1.5 * placement.scale;
    let mut ink = vec![BG; width * height];
    for edge in &topology.edges {
        let silhouette = edge.faces[1] != NONE && {
            let facing = |face: u32| dot(topology.normals[face as usize], frame.from) > FACING;
            facing(edge.faces[0]) != facing(edge.faces[1])
        };
        if !(edge.crease || silhouette) {
            continue;
        }
        let a = project(topology.points[edge.ends[0] as usize]);
        let b = project(topology.points[edge.ends[1] as usize]);
        let along_x = (b.0 - a.0).abs() >= (b.1 - a.1).abs();
        line((a.0, a.1), (b.0, b.1), |x, y, t| {
            if x < 0 || y < 0 || x >= width as i64 || y >= height as i64 {
                return;
            }
            let at = y as usize * width + x as usize;
            let d = a.2 + t * (b.2 - a.2);
            if d <= depth[at] + tolerance {
                ink[at] = INK;
            } else if hidden
                && ink[at] == BG
                // The dash follows the screen, not the edge, so the short
                // segments of a hidden circle still read as dashed.
                && (if along_x { x } else { y }).div_euclid(DASH) % 2 == 0
            {
                ink[at] = HIDDEN;
            }
        });
    }
    for (pixel, mark) in panel.pixels.iter_mut().zip(ink) {
        if mark != BG {
            *pixel = mark;
        }
    }
    panel
}

/// A section in the frame of its matching view: material filled by parity
/// across every loop, so holes stay empty and islands in them are filled
/// again, then the outlines in ink.
pub(super) fn section_panel(
    cut: &section::Section,
    placement: &Placement,
    size: (usize, usize),
    k: usize,
) -> Canvas {
    let (width, height) = size;
    let mut panel = Canvas::new(width, height);
    let edges = cut
        .loops
        .iter()
        .flat_map(|item| {
            let points = &item.points;
            (0..points.len()).map(move |i| (points[i], points[(i + 1) % points.len()]))
        })
        .map(|(a, b)| (placement.map(a[0], a[1]), placement.map(b[0], b[1])))
        .collect::<Vec<_>>();
    let mut crossings = Vec::new();
    for row in 0..height {
        let cy = row as f64 + 0.5;
        crossings.clear();
        for (a, b) in &edges {
            if (a.1 > cy) != (b.1 > cy) {
                crossings.push(a.0 + (cy - a.1) / (b.1 - a.1) * (b.0 - a.0));
            }
        }
        crossings.sort_by(f64::total_cmp);
        for [start, end] in crossings.as_chunks::<2>().0 {
            let first = (start - 0.5).ceil().max(0.0) as i64;
            let last = ((end - 0.5).floor() as i64).min(width as i64 - 1);
            for x in first..=last {
                panel.set(x, row as i64, FILL);
            }
        }
    }
    for (a, b) in &edges {
        line(*a, *b, |x, y, _| panel.set(x, y, INK));
    }
    if cut.loops.is_empty() {
        let text = font::clip("NO MATERIAL", width, k);
        let x = (width as i64 - font::width(text, k) as i64) / 2;
        let y = (height as i64 - (font::HEIGHT * k) as i64) / 2;
        panel.text(text, x, y, k);
    }
    panel
}
