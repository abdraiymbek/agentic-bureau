//! A STEP file (ISO 10303-21, AP214) of a rendered mesh, written without any
//! CAD kernel: the faceted path of `cad_export`, always available.
//!
//! Edge-connected coplanar triangles merge into one planar `ADVANCED_FACE`
//! with inner loops for its holes, every edge-connected shell becomes one
//! `CLOSED_SHELL`, and a shell that encloses a cavity (negative volume) is
//! written as a void of the solid around it. Every vertex is a vertex of the
//! render: nothing is moved, so the solid is the checked mesh with fewer,
//! larger faces. The output is a pure function of the mesh and the header.
use super::*;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fmt::Write as _;

pub(crate) const WRITER: &str = "omenflow-faceted-step-1";
/// Largest render written as faceted STEP: about 253 bytes of STEP per
/// triangle were measured, so about 63 MB at the limit.
pub(crate) const MAX_TRIANGLES: usize = 250_000;

/// Vertices closer than this are one vertex, as in the mesh analysis, so
/// "closed" means what the render report said.
const WELD: f64 = 1e-5;

type P = [f64; 3];

fn sub(a: P, b: P) -> P {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn add(a: P, b: P) -> P {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn cross(a: P, b: P) -> P {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn dot(a: P, b: P) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn norm(a: P) -> f64 {
    dot(a, a).sqrt()
}
fn scale(a: P, s: f64) -> P {
    [a[0] * s, a[1] * s, a[2] * s]
}

/// What the file says about itself.
pub(crate) struct Header<'a> {
    pub product: &'a str,
    pub description: &'a str,
    pub file_name: &'a str,
    /// ISO 8601, to the second. The revision's own time, so a revision always
    /// writes the same bytes.
    pub timestamp: &'a str,
}

pub(crate) struct Faceted {
    pub text: String,
    pub faces: usize,
    pub inner_loops: usize,
    pub edges: usize,
    pub vertices: usize,
    pub solids: usize,
    pub voids: usize,
    /// Regions whose boundary touched itself and were written one face per triangle.
    pub traced_by_triangle: usize,
    /// Volume enclosed by the written faces (Newell), in model units cubed.
    pub volume: f64,
    /// Distance within which a vertex counts as on a plane or a line.
    pub tolerance: f64,
}

struct Face {
    normal: P,
    /// `loops[0]` is the outer boundary, counter-clockwise about `normal`;
    /// the rest are holes.
    loops: Vec<Vec<u32>>,
}

struct Shell {
    faces: Vec<Face>,
    /// Signed: negative for a cavity.
    volume: f64,
    triangles: Vec<[u32; 3]>,
}

fn lost(detail: &str) -> ContractError {
    ContractError::new(
        "INTERNAL",
        format!("The faceted STEP writer lost geometry; nothing was written ({detail})."),
    )
}

fn not_closed() -> ContractError {
    ContractError::new(
        "INTERNAL",
        "The faceted STEP writer was given a render that is not a closed solid; nothing was written.",
    )
}

/// The mesh as a STEP solid. The caller has checked that the mesh is one
/// closed, outward solid (`watertight && !inverted`).
pub(crate) fn write(mesh: &mesh::Mesh, header: &Header<'_>) -> CoreResult<Faceted> {
    write_limited(mesh, header, MAX_TRIANGLES)
}

fn write_limited(
    mesh: &mesh::Mesh,
    header: &Header<'_>,
    max_triangles: usize,
) -> CoreResult<Faceted> {
    if mesh.triangles.len() > max_triangles {
        return Err(mesh::work_limit(
            "Faceted STEP triangles",
            mesh.triangles.len(),
            max_triangles,
        ));
    }
    let built = Built::new(mesh)?;
    built.check(mesh)?;
    Ok(built.emit(header))
}

struct Built {
    vertices: Vec<P>,
    shells: Vec<Shell>,
    /// Each cavity's shell with the shell of the solid it lies in.
    voids: Vec<(usize, usize)>,
    tolerance: f64,
    traced_by_triangle: usize,
    volume: f64,
}

impl Built {
    fn new(mesh: &mesh::Mesh) -> CoreResult<Self> {
        // 1. Weld exactly as the mesh analysis does; the first occurrence gives the position.
        let mut ids = HashMap::<[i64; 3], u32>::new();
        let mut vertices = Vec::<P>::new();
        let mut tris = Vec::<[u32; 3]>::with_capacity(mesh.triangles.len());
        for triangle in &mesh.triangles {
            let corner = triangle.map(|point| {
                *ids.entry(point.map(|value| (value / WELD).round() as i64))
                    .or_insert_with(|| {
                        vertices.push(point);
                        (vertices.len() - 1) as u32
                    })
            });
            if corner[0] != corner[1] && corner[1] != corner[2] && corner[0] != corner[2] {
                tris.push(corner);
            }
        }
        let size = mesh.size();
        let diagonal = norm(size);
        let largest = (0..3)
            .map(|axis| mesh.bounds_min[axis].abs().max(mesh.bounds_max[axis].abs()))
            .fold(0.0, f64::max);
        // The f32 storage noise of the render, about 3e-4 mm for a 300 mm part.
        let tolerance = (1e-6 * diagonal)
            .max(4.0 * f64::from(f32::EPSILON) * largest)
            .max(1e-9);
        // 2. Directed edges: each once, and its reverse once.
        let mut owner = HashMap::<(u32, u32), u32>::with_capacity(tris.len() * 3);
        for (index, t) in tris.iter().enumerate() {
            for edge in edges_of(t) {
                if owner.insert(edge, index as u32).is_some() {
                    return Err(not_closed());
                }
            }
        }
        let twin = |(from, to): (u32, u32)| owner.get(&(to, from)).copied();
        let mut neighbours = Vec::with_capacity(tris.len());
        for t in &tris {
            let mut across = [0u32; 3];
            for (k, edge) in edges_of(t).into_iter().enumerate() {
                across[k] = twin(edge).ok_or_else(not_closed)?;
            }
            neighbours.push(across);
        }
        // 3. Shells: edge-connected components, in order of their first triangle.
        let mut shell_of = vec![u32::MAX; tris.len()];
        let mut members_of = Vec::<Vec<u32>>::new();
        for start in 0..tris.len() {
            if shell_of[start] != u32::MAX {
                continue;
            }
            let id = members_of.len() as u32;
            shell_of[start] = id;
            let mut stack = vec![start as u32];
            let mut members = Vec::new();
            while let Some(t) = stack.pop() {
                members.push(t);
                for next in neighbours[t as usize] {
                    if shell_of[next as usize] == u32::MAX {
                        shell_of[next as usize] = id;
                        stack.push(next);
                    }
                }
            }
            members.sort_unstable();
            members_of.push(members);
        }
        // 4. Planar regions of each shell, then their loops.
        let raw = tris
            .iter()
            .map(|t| {
                let [a, b, c] = t.map(|v| vertices[v as usize]);
                cross(sub(b, a), sub(c, a))
            })
            .collect::<Vec<_>>();
        let degenerate = 1e-14 * diagonal * diagonal;
        let mut region_of = vec![u32::MAX; tris.len()];
        let mut traced_by_triangle = 0;
        let mut shells = Vec::new();
        for members in members_of {
            let volume = members
                .iter()
                .map(|&t| {
                    let [a, b, c] = tris[t as usize].map(|v| vertices[v as usize]);
                    dot(a, cross(b, c)) / 6.0
                })
                .sum::<f64>();
            // The largest triangle seeds first, so every face is held to the plane of its
            // best-conditioned triangle.
            let mut order = members.clone();
            order.sort_by(|a, b| {
                norm(raw[*b as usize])
                    .total_cmp(&norm(raw[*a as usize]))
                    .then(a.cmp(b))
            });
            let mut faces = Vec::new();
            for &seed in &order {
                if region_of[seed as usize] != u32::MAX {
                    continue;
                }
                let length = norm(raw[seed as usize]);
                if length <= degenerate {
                    return Err(lost("a degenerate triangle borders no face"));
                }
                let normal = scale(raw[seed as usize], 1.0 / length);
                let offset = dot(normal, vertices[tris[seed as usize][0] as usize]);
                region_of[seed as usize] = seed;
                let mut queue = VecDeque::from([seed]);
                let mut region = Vec::new();
                while let Some(t) = queue.pop_front() {
                    region.push(t);
                    for next in neighbours[t as usize] {
                        if region_of[next as usize] != u32::MAX {
                            continue;
                        }
                        // Every test is against the seed's plane, so no face drifts however
                        // many triangles it takes in, and curved facets are never merged.
                        let on_plane = tris[next as usize].iter().all(|&v| {
                            (dot(normal, vertices[v as usize]) - offset).abs() <= tolerance
                        });
                        let r = raw[next as usize];
                        if on_plane && (norm(r) <= degenerate || dot(normal, r) > 0.0) {
                            region_of[next as usize] = seed;
                            queue.push_back(next);
                        }
                    }
                }
                region.sort_unstable();
                match loops_of(&region, &tris, &vertices, &region_of, seed, normal, &twin) {
                    Some(loops) => faces.push(Face { normal, loops }),
                    None => {
                        // The boundary touches itself: one face per triangle is still exact.
                        traced_by_triangle += 1;
                        for &t in &region {
                            let r = raw[t as usize];
                            if norm(r) <= degenerate {
                                return Err(lost("a degenerate triangle lies in a pinched face"));
                            }
                            faces.push(Face {
                                normal: scale(r, 1.0 / norm(r)),
                                loops: vec![tris[t as usize].to_vec()],
                            });
                        }
                    }
                }
            }
            shells.push(Shell {
                faces,
                volume,
                triangles: members.iter().map(|&t| tris[t as usize]).collect(),
            });
        }
        simplify(&mut shells, &vertices, tolerance);
        let volume = shells
            .iter()
            .flat_map(|shell| &shell.faces)
            .map(|face| {
                let area = face
                    .loops
                    .iter()
                    .fold([0.0; 3], |sum, lp| add(sum, vector_area(lp, &vertices)));
                dot(area, vertices[face.loops[0][0] as usize]) / 3.0
            })
            .sum();
        let voids = attach_voids(&shells, &vertices)?;
        Ok(Self {
            vertices,
            shells,
            voids,
            tolerance,
            traced_by_triangle,
            volume,
        })
    }

    /// The faces still close every shell and enclose the render's volume.
    fn check(&self, mesh: &mesh::Mesh) -> CoreResult<()> {
        for shell in &self.shells {
            let mut uses = HashMap::<(u32, u32), (u32, u32)>::new();
            for lp in shell.faces.iter().flat_map(|face| &face.loops) {
                for i in 0..lp.len() {
                    let (a, b) = (lp[i], lp[(i + 1) % lp.len()]);
                    let entry = uses.entry((a.min(b), a.max(b))).or_default();
                    if a < b {
                        entry.0 += 1;
                    } else {
                        entry.1 += 1;
                    }
                }
            }
            if uses.values().any(|&used| used != (1, 1)) {
                return Err(lost("an edge is not shared by exactly two faces"));
            }
        }
        let allowed = 1e-9 * mesh.volume.max(1.0) + self.tolerance.max(WELD) * mesh.area;
        if (self.volume - mesh.volume).abs() > allowed {
            return Err(lost(&format!(
                "its faces enclose {} against the render's {}",
                self.volume, mesh.volume
            )));
        }
        Ok(())
    }

    fn emit(&self, header: &Header<'_>) -> Faceted {
        let mut out = Writer::default();
        let app = out.add(
            "APPLICATION_CONTEXT('core data for automotive mechanical design processes')".into(),
        );
        out.add(format!(
            "APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#{app})"
        ));
        let product_context = out.add(format!("PRODUCT_CONTEXT('',#{app},'mechanical')"));
        let definition_context = out.add(format!(
            "PRODUCT_DEFINITION_CONTEXT('part definition',#{app},'design')"
        ));
        let name = step_string(header.product);
        let product = out.add(format!(
            "PRODUCT('{name}','{name}','',(#{product_context}))"
        ));
        out.add(format!(
            "PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#{product}))"
        ));
        let formation = out.add(format!("PRODUCT_DEFINITION_FORMATION('','',#{product})"));
        let definition = out.add(format!(
            "PRODUCT_DEFINITION('design','',#{formation},#{definition_context})"
        ));
        let shape = out.add(format!("PRODUCT_DEFINITION_SHAPE('','',#{definition})"));
        let length = out.add("(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))".into());
        let angle = out.add("(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))".into());
        let solid_angle = out.add("(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())".into());
        let uncertainty = out.add(format!(
            "UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE({}),#{length},'distance_accuracy_value','confusion accuracy')",
            real((10.0 * self.tolerance).max(1e-7))
        ));
        let context = out.add(format!(
            "(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#{uncertainty}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#{length},#{angle},#{solid_angle}))REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY'))"
        ));
        let origin = out.add("CARTESIAN_POINT('',(0.,0.,0.))".into());
        let z = out.direction([0.0, 0.0, 1.0]);
        let x = out.direction([1.0, 0.0, 0.0]);
        let axis = out.add(format!("AXIS2_PLACEMENT_3D('',#{origin},#{z},#{x})"));

        let (mut faces, mut inner_loops, mut edges, mut vertices) = (0, 0, 0, 0);
        let mut closed = Vec::with_capacity(self.shells.len());
        for shell in &self.shells {
            // A cavity is written as a closed solid of its own and used reversed.
            let flip = shell.volume < 0.0;
            // Vertices and edges belong to their shell.
            let mut points = HashMap::<u32, (usize, usize)>::new();
            let mut curves = HashMap::<(u32, u32), usize>::new();
            let mut written = Vec::with_capacity(shell.faces.len());
            for face in &shell.faces {
                let normal = if flip {
                    scale(face.normal, -1.0)
                } else {
                    face.normal
                };
                let mut bounds = Vec::with_capacity(face.loops.len());
                for (index, lp) in face.loops.iter().enumerate() {
                    let mut lp = lp.clone();
                    if flip {
                        lp.reverse();
                    }
                    let mut oriented = Vec::with_capacity(lp.len());
                    for i in 0..lp.len() {
                        let (a, b) = (lp[i], lp[(i + 1) % lp.len()]);
                        for v in [a, b] {
                            if let std::collections::hash_map::Entry::Vacant(slot) = points.entry(v)
                            {
                                let p = self.vertices[v as usize];
                                let point = out.add(format!(
                                    "CARTESIAN_POINT('',({},{},{}))",
                                    real(p[0]),
                                    real(p[1]),
                                    real(p[2])
                                ));
                                let vertex = out.add(format!("VERTEX_POINT('',#{point})"));
                                slot.insert((point, vertex));
                            }
                        }
                        let key = (a.min(b), a.max(b));
                        let curve = match curves.get(&key) {
                            Some(&curve) => curve,
                            None => {
                                let (start, end) = (points[&key.0], points[&key.1]);
                                let d = sub(
                                    self.vertices[key.1 as usize],
                                    self.vertices[key.0 as usize],
                                );
                                let direction = out.direction(scale(d, 1.0 / norm(d)));
                                let vector = out.add(format!("VECTOR('',#{direction},1.)"));
                                let line = out.add(format!("LINE('',#{},#{vector})", start.0));
                                let curve = out.add(format!(
                                    "EDGE_CURVE('',#{},#{},#{line},.T.)",
                                    start.1, end.1
                                ));
                                curves.insert(key, curve);
                                curve
                            }
                        };
                        oriented.push(out.add(format!(
                            "ORIENTED_EDGE('',*,*,#{curve},{})",
                            if a == key.0 { ".T." } else { ".F." }
                        )));
                    }
                    let edge_loop = out.add(format!("EDGE_LOOP('',({}))", refs(&oriented)));
                    let kind = if index == 0 {
                        "FACE_OUTER_BOUND"
                    } else {
                        inner_loops += 1;
                        "FACE_BOUND"
                    };
                    bounds.push(out.add(format!("{kind}('',#{edge_loop},.T.)")));
                }
                let n = out.direction(normal);
                let u = out.direction(basis(normal).0);
                let placement = out.add(format!(
                    "AXIS2_PLACEMENT_3D('',#{},#{n},#{u})",
                    points[&face.loops[0][0]].0
                ));
                let plane = out.add(format!("PLANE('',#{placement})"));
                written.push(out.add(format!(
                    "ADVANCED_FACE('',({}),#{plane},.T.)",
                    refs(&bounds)
                )));
            }
            faces += written.len();
            edges += curves.len();
            vertices += points.len();
            closed.push(out.add(format!("CLOSED_SHELL('',({}))", refs(&written))));
        }
        let mut solids = Vec::new();
        for (index, shell) in self.shells.iter().enumerate() {
            if shell.volume < 0.0 {
                continue;
            }
            let held = self
                .voids
                .iter()
                .filter(|(_, around)| *around == index)
                .map(|(void, _)| {
                    out.add(format!(
                        "ORIENTED_CLOSED_SHELL('',*,#{},.F.)",
                        closed[*void]
                    ))
                })
                .collect::<Vec<_>>();
            solids.push(if held.is_empty() {
                out.add(format!("MANIFOLD_SOLID_BREP('',#{})", closed[index]))
            } else {
                out.add(format!(
                    "BREP_WITH_VOIDS('',#{},({}))",
                    closed[index],
                    refs(&held)
                ))
            });
        }
        let items = std::iter::once(axis)
            .chain(solids.iter().copied())
            .collect::<Vec<_>>();
        let representation = out.add(format!(
            "ADVANCED_BREP_SHAPE_REPRESENTATION('',({}),#{context})",
            refs(&items)
        ));
        out.add(format!(
            "SHAPE_DEFINITION_REPRESENTATION(#{shape},#{representation})"
        ));
        let mut text = String::with_capacity(out.data.len() + 512);
        text.push_str("ISO-10303-21;\nHEADER;\n");
        let _ = writeln!(
            text,
            "FILE_DESCRIPTION(('{}'),'2;1');",
            step_string(header.description)
        );
        let _ = writeln!(
            text,
            "FILE_NAME('{}','{}',(''),(''),'Bureau faceted STEP writer 1','Bureau','');",
            step_string(header.file_name),
            step_string(header.timestamp)
        );
        text.push_str(
            "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n",
        );
        text.push_str(&out.data);
        text.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
        Faceted {
            text,
            faces,
            inner_loops,
            edges,
            vertices,
            solids: solids.len(),
            voids: self.voids.len(),
            traced_by_triangle: self.traced_by_triangle,
            volume: self.volume,
            tolerance: self.tolerance,
        }
    }
}

fn edges_of(t: &[u32; 3]) -> [(u32, u32); 3] {
    [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])]
}

/// Twice the area vector of a closed polygon (Newell), halved.
fn vector_area(lp: &[u32], vertices: &[P]) -> P {
    let mut sum = [0.0; 3];
    for i in 0..lp.len() {
        let (a, b) = (
            vertices[lp[i] as usize],
            vertices[lp[(i + 1) % lp.len()] as usize],
        );
        sum = add(sum, cross(a, b));
    }
    scale(sum, 0.5)
}

/// An in-plane basis: `u` across the axis `normal` is least aligned with.
fn basis(normal: P) -> (P, P) {
    let axis = if normal[0].abs() <= normal[1].abs() && normal[0].abs() <= normal[2].abs() {
        [1.0, 0.0, 0.0]
    } else if normal[1].abs() <= normal[2].abs() {
        [0.0, 1.0, 0.0]
    } else {
        [0.0, 0.0, 1.0]
    };
    let u = cross(normal, axis);
    let u = scale(u, 1.0 / norm(u));
    (u, cross(normal, u))
}

/// The boundary loops of one planar region, outer first, or `None` when the
/// region's boundary touches itself or does not have exactly one outer loop.
fn loops_of(
    members: &[u32],
    tris: &[[u32; 3]],
    vertices: &[P],
    region_of: &[u32],
    tag: u32,
    normal: P,
    twin: &dyn Fn((u32, u32)) -> Option<u32>,
) -> Option<Vec<Vec<u32>>> {
    let mut next = BTreeMap::<u32, u32>::new();
    for &t in members {
        for edge in edges_of(&tris[t as usize]) {
            let across = twin(edge)?;
            if region_of[across as usize] != tag && next.insert(edge.0, edge.1).is_some() {
                return None;
            }
        }
    }
    let mut loops = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for &start in next.keys() {
        if !seen.insert(start) {
            continue;
        }
        let mut lp = vec![start];
        let mut at = next[&start];
        while at != start {
            if !seen.insert(at) {
                return None;
            }
            lp.push(at);
            at = *next.get(&at)?;
        }
        loops.push(lp);
    }
    let (u, v) = basis(normal);
    let area = |lp: &Vec<u32>| {
        (0..lp.len())
            .map(|i| {
                let (a, b) = (
                    vertices[lp[i] as usize],
                    vertices[lp[(i + 1) % lp.len()] as usize],
                );
                dot(a, u) * dot(b, v) - dot(b, u) * dot(a, v)
            })
            .sum::<f64>()
            / 2.0
    };
    let outer = loops
        .iter()
        .enumerate()
        .filter(|(_, lp)| area(lp) > 0.0)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if outer.len() != 1 || loops.iter().any(|lp| lp.len() < 3) {
        return None;
    }
    let first = loops.remove(outer[0]);
    loops.insert(0, first);
    Some(loops)
}

/// Drop vertices that only continue a straight edge between the same two
/// faces. Returns how many were dropped.
fn simplify(shells: &mut [Shell], vertices: &[P], tolerance: f64) -> usize {
    type Use = (usize, usize, usize, usize);
    let mut removed = 0;
    for _ in 0..8 {
        let mut uses = BTreeMap::<u32, Vec<Use>>::new();
        for (s, shell) in shells.iter().enumerate() {
            for (f, face) in shell.faces.iter().enumerate() {
                for (l, lp) in face.loops.iter().enumerate() {
                    for (i, &v) in lp.iter().enumerate() {
                        uses.entry(v).or_default().push((s, f, l, i));
                    }
                }
            }
        }
        let mut lengths = BTreeMap::<(usize, usize, usize), usize>::new();
        let mut drop = BTreeMap::<(usize, usize, usize), Vec<u32>>::new();
        for (&v, used) in &uses {
            if used.len() != 2 || (used[0].0, used[0].1) == (used[1].0, used[1].1) {
                continue;
            }
            let around = |&(s, f, l, i): &Use| {
                let lp = &shells[s].faces[f].loops[l];
                (lp[(i + lp.len() - 1) % lp.len()], lp[(i + 1) % lp.len()])
            };
            let ((a0, c0), (a1, c1)) = (around(&used[0]), around(&used[1]));
            if a0 != c1 || c0 != a1 {
                continue;
            }
            let (a, w, c) = (
                vertices[a0 as usize],
                vertices[v as usize],
                vertices[c0 as usize],
            );
            let span = norm(sub(c, a));
            if span == 0.0 || norm(cross(sub(w, a), sub(c, a))) / span > tolerance {
                continue;
            }
            let fits = used.iter().all(|&(s, f, l, _)| {
                *lengths
                    .entry((s, f, l))
                    .or_insert(shells[s].faces[f].loops[l].len())
                    > 3
            });
            if !fits {
                continue;
            }
            for &(s, f, l, _) in used {
                *lengths.get_mut(&(s, f, l)).expect("counted above") -= 1;
                drop.entry((s, f, l)).or_default().push(v);
            }
            removed += 1;
        }
        if drop.is_empty() {
            break;
        }
        for ((s, f, l), gone) in drop {
            shells[s].faces[f].loops[l].retain(|v| !gone.contains(v));
        }
    }
    removed
}

/// Each cavity with the solid it lies in: the smallest positive shell that
/// contains it. Shell indices, in shell order.
fn attach_voids(shells: &[Shell], vertices: &[P]) -> CoreResult<Vec<(usize, usize)>> {
    let mut solids = Vec::new();
    for (index, shell) in shells.iter().enumerate() {
        if shell.volume > 0.0 && shells.iter().any(|other| other.volume < 0.0) {
            let triangles = shell
                .triangles
                .iter()
                .map(|t| t.map(|v| vertices[v as usize]))
                .collect();
            solids.push((index, shell.volume, mesh::Mesh::from_triangles(triangles)?));
        }
    }
    let mut voids = Vec::new();
    for (index, shell) in shells.iter().enumerate() {
        if shell.volume >= 0.0 {
            continue;
        }
        // A point on the cavity's surface: inside the solid around it, never on that solid.
        let [a, b, c] = shell.triangles[0].map(|v| vertices[v as usize]);
        let probe = scale(add(add(a, b), c), 1.0 / 3.0);
        let around = solids
            .iter()
            .filter(|(_, _, solid)| solid.contains(probe))
            .min_by(|x, y| x.1.total_cmp(&y.1).then(x.0.cmp(&y.0)))
            .ok_or_else(|| lost("a cavity lies in no solid"))?;
        voids.push((index, around.0));
    }
    Ok(voids)
}

/// The entity list of the DATA section, numbered as written.
#[derive(Default)]
struct Writer {
    data: String,
    count: usize,
    directions: HashMap<String, usize>,
}

impl Writer {
    fn add(&mut self, entity: String) -> usize {
        self.count += 1;
        let _ = writeln!(self.data, "#{}={entity};", self.count);
        self.count
    }

    /// One `DIRECTION` per distinct text.
    fn direction(&mut self, d: P) -> usize {
        let text = format!("({},{},{})", unit(d[0]), unit(d[1]), unit(d[2]));
        if let Some(&id) = self.directions.get(&text) {
            return id;
        }
        let id = self.add(format!("DIRECTION('',{text})"));
        self.directions.insert(text, id);
        id
    }
}

fn refs(ids: &[usize]) -> String {
    ids.iter()
        .map(|id| format!("#{id}"))
        .collect::<Vec<_>>()
        .join(",")
}

/// A STEP real: always with a decimal point and never an exponent. A value
/// that is exactly an f32 (every render vertex) prints as that f32.
pub(crate) fn real(x: f64) -> String {
    if x == 0.0 {
        return "0.".into();
    }
    let mut text = if f64::from(x as f32) == x {
        format!("{}", x as f32)
    } else {
        format!("{x}")
    };
    if !text.contains('.') {
        text.push('.');
    }
    text
}

/// A direction component, rounded so equal directions share one entity.
fn unit(x: f64) -> String {
    let rounded = (x * 1e12).round() / 1e12;
    if rounded == 0.0 {
        return "0.".into();
    }
    let mut text = format!("{rounded}");
    if !text.contains('.') {
        text.push('.');
    }
    text
}

/// The inside of a Part 21 string: quotes and backslashes doubled, anything
/// outside printable ASCII as `\X2\` UTF-16 code units.
pub(crate) fn step_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut wide = false;
    for ch in text.chars() {
        if (' '..='~').contains(&ch) {
            if wide {
                out.push_str("\\X0\\");
                wide = false;
            }
            match ch {
                '\'' => out.push_str("''"),
                '\\' => out.push_str("\\\\"),
                _ => out.push(ch),
            }
        } else {
            if !wide {
                out.push_str("\\X2\\");
                wide = true;
            }
            let mut units = [0u16; 2];
            for unit in ch.encode_utf16(&mut units) {
                let _ = write!(out, "{unit:04X}");
            }
        }
    }
    if wide {
        out.push_str("\\X0\\");
    }
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::cad::mesh::fixtures::*;
    use regex::Regex;

    /// A UV sphere: `rings` bands of `segments` facets, wound outward unless `invert`.
    pub(crate) fn sphere(
        centre: P,
        radius: f64,
        rings: usize,
        segments: usize,
        invert: bool,
    ) -> Vec<mesh::Triangle> {
        let at = |ring: usize, segment: usize| -> P {
            let polar = std::f64::consts::PI * ring as f64 / rings as f64;
            let azimuth = std::f64::consts::TAU * (segment % segments) as f64 / segments as f64;
            [
                centre[0] + radius * polar.sin() * azimuth.cos(),
                centre[1] + radius * polar.sin() * azimuth.sin(),
                centre[2] + radius * polar.cos(),
            ]
        };
        let mut out = Vec::new();
        for ring in 0..rings {
            for segment in 0..segments {
                let (a, b) = (at(ring, segment), at(ring, segment + 1));
                let (c, d) = (at(ring + 1, segment), at(ring + 1, segment + 1));
                if ring > 0 {
                    out.push([a, c, b]);
                }
                if ring + 1 < rings {
                    out.push([b, c, d]);
                }
            }
        }
        if invert {
            for t in &mut out {
                t.swap(1, 2);
            }
        }
        out
    }

    fn header() -> Header<'static> {
        Header {
            product: "Test part",
            description: "Faceted solid of the OpenSCAD render of Test part r1; planar faces, not exact surfaces",
            file_name: "test-part-r1.step",
            timestamp: "2026-10-21T12:00:00",
        }
    }

    fn entities(text: &str) -> Vec<(usize, String, String)> {
        let pattern = Regex::new(r"^#(\d+)=([A-Z_0-9]*)\((.*)\);$").unwrap();
        text.lines()
            .filter_map(|line| pattern.captures(line))
            .map(|found| {
                (
                    found[1].parse().unwrap(),
                    found[2].to_owned(),
                    found[3].to_owned(),
                )
            })
            .collect()
    }

    fn count(text: &str, name: &str) -> usize {
        entities(text)
            .iter()
            .filter(|(_, kind, _)| kind == name)
            .count()
    }

    fn written(triangles: Vec<mesh::Triangle>) -> (mesh::Mesh, Faceted) {
        let mesh = mesh(triangles);
        assert!(
            mesh.watertight && !mesh.inverted,
            "fixture is a closed outward solid"
        );
        let faceted = write(&mesh, &header()).unwrap();
        (mesh, faceted)
    }

    #[test]
    fn a_cube_is_six_faces_twelve_edges_and_eight_vertices() {
        let (_, faceted) = written(cuboid([0.0; 3], [40.0, 30.0, 4.0], false));
        let text = &faceted.text;
        assert!(text.starts_with("ISO-10303-21;\nHEADER;\n"));
        assert!(text.ends_with("ENDSEC;\nEND-ISO-10303-21;\n"));
        assert!(text.contains("FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));"));
        assert_eq!(count(text, "ADVANCED_FACE"), 6);
        assert_eq!(count(text, "EDGE_CURVE"), 12);
        assert_eq!(count(text, "VERTEX_POINT"), 8);
        assert_eq!(count(text, "ORIENTED_EDGE"), 24);
        assert_eq!(count(text, "MANIFOLD_SOLID_BREP"), 1);
        assert_eq!(count(text, "PLANE"), 6);
        assert_eq!((faceted.faces, faceted.edges, faceted.vertices), (6, 12, 8));
        assert_eq!(
            (faceted.solids, faceted.voids, faceted.inner_loops),
            (1, 0, 0)
        );
        // The six axis directions and nothing else are shared by every plane and line.
        assert_eq!(count(text, "DIRECTION"), 6);
        // Entities are numbered in the order they are written.
        let ids = entities(text).iter().map(|e| e.0).collect::<Vec<_>>();
        assert!(ids.windows(2).all(|pair| pair[1] == pair[0] + 1));
    }

    #[test]
    fn every_edge_is_used_twice_in_opposite_directions() {
        let (_, faceted) = written(plate_with_hole([40.0, 30.0, 4.0], [20.0, 15.0], 8.0, 64));
        let found = entities(&faceted.text);
        let mut uses = HashMap::<String, (usize, usize)>::new();
        for (_, kind, args) in &found {
            if kind == "ORIENTED_EDGE" {
                let parts = args.split(',').collect::<Vec<_>>();
                let entry = uses.entry(parts[3].to_owned()).or_default();
                if parts[4] == ".T." {
                    entry.0 += 1;
                } else {
                    entry.1 += 1;
                }
            }
        }
        assert_eq!(uses.len(), count(&faceted.text, "EDGE_CURVE"));
        assert!(uses.values().all(|used| *used == (1, 1)), "{uses:?}");
    }

    #[test]
    fn a_hole_is_an_inner_loop_and_the_euler_poincare_formula_holds() {
        let (_, faceted) = written(plate_with_hole([40.0, 30.0, 4.0], [20.0, 15.0], 8.0, 64));
        // Top and bottom with the hole, four sides, one face per facet of the hole wall.
        assert_eq!(faceted.faces, 70);
        assert_eq!(faceted.inner_loops, 2);
        assert_eq!(count(&faceted.text, "FACE_BOUND"), 2);
        // Collinear rim points on the outer edges were dropped: only the box's corners remain.
        assert_eq!(faceted.vertices, 8 + 2 * 64);
        // V − E + F − H = 2(S − G), one solid of genus one.
        let (v, e, f, h) = (
            faceted.vertices as i64,
            faceted.edges as i64,
            faceted.faces as i64,
            faceted.inner_loops as i64,
        );
        let (solids, genus) = (1, 1);
        assert_eq!(v - e + f - h, 2 * (solids - genus));
    }

    #[test]
    fn curved_facets_stay_separate_and_coplanar_triangles_merge() {
        let (_, faceted) = written(cylinder([0.0, 0.0], 10.0, 5.0, 32));
        assert_eq!(faceted.faces, 32 + 2);
        // The cap fans' centres are inside their faces, not vertices of them.
        assert_eq!(faceted.vertices, 64);
    }

    #[test]
    fn two_bodies_are_two_solids_and_a_cavity_is_a_void() {
        let (_, apart) = written(
            [
                cuboid([0.0; 3], [10.0; 3], false),
                cuboid([20.0, 0.0, 0.0], [30.0, 10.0, 10.0], false),
            ]
            .concat(),
        );
        assert_eq!((apart.solids, apart.voids), (2, 0));
        assert_eq!(count(&apart.text, "MANIFOLD_SOLID_BREP"), 2);
        let (mesh, hollow) = written(
            [
                cuboid([0.0; 3], [10.0; 3], false),
                cuboid([2.0; 3], [8.0; 3], true),
            ]
            .concat(),
        );
        assert_eq!((hollow.solids, hollow.voids), (1, 1));
        assert_eq!(count(&hollow.text, "BREP_WITH_VOIDS"), 1);
        assert_eq!(count(&hollow.text, "MANIFOLD_SOLID_BREP"), 0);
        assert_eq!(count(&hollow.text, "CLOSED_SHELL"), 2);
        assert!(hollow.text.contains("ORIENTED_CLOSED_SHELL('',*,#"));
        assert!(hollow
            .text
            .lines()
            .any(|line| line.contains("ORIENTED_CLOSED_SHELL") && line.ends_with(",.F.);")));
        assert!((hollow.volume - mesh.volume).abs() < 1e-9);
        assert!((mesh.volume - (1000.0 - 216.0)).abs() < 1e-9);
    }

    /// The shell ids each solid entity names, in order.
    fn solid_shells(text: &str) -> Vec<(String, String)> {
        let found = entities(text);
        let shells = found
            .iter()
            .filter(|(_, kind, _)| kind == "CLOSED_SHELL")
            .map(|(id, _, _)| format!("#{id}"))
            .collect::<Vec<_>>();
        found
            .iter()
            .filter(|(_, kind, _)| kind == "MANIFOLD_SOLID_BREP" || kind == "BREP_WITH_VOIDS")
            .map(|(_, kind, args)| {
                let shell = args
                    .split(',')
                    .nth(1)
                    .unwrap()
                    .trim_matches(['(', ')'])
                    .to_owned();
                let index = shells.iter().position(|s| *s == shell).unwrap();
                (kind.clone(), format!("shell {index}"))
            })
            .collect()
    }

    #[test]
    fn a_void_belongs_to_the_solid_around_it() {
        // A cavity in the second of two solids.
        let (_, second) = written(
            [
                cuboid([0.0; 3], [10.0; 3], false),
                cuboid([20.0, 0.0, 0.0], [30.0, 10.0, 10.0], false),
                cuboid([22.0, 2.0, 2.0], [28.0, 8.0, 8.0], true),
            ]
            .concat(),
        );
        assert_eq!(
            solid_shells(&second.text),
            [
                ("MANIFOLD_SOLID_BREP".to_owned(), "shell 0".to_owned()),
                ("BREP_WITH_VOIDS".to_owned(), "shell 1".to_owned()),
            ]
        );
        // A ball loose in a hollow sphere: the cavity belongs to the shell, the ball is its own solid.
        let (mesh, nested) = written(
            [
                sphere([0.0; 3], 10.0, 12, 24, false),
                sphere([0.0; 3], 6.0, 12, 24, true),
                sphere([0.0; 3], 3.0, 12, 24, false),
            ]
            .concat(),
        );
        assert_eq!((nested.solids, nested.voids), (2, 1));
        assert_eq!(
            solid_shells(&nested.text),
            [
                ("BREP_WITH_VOIDS".to_owned(), "shell 0".to_owned()),
                ("MANIFOLD_SOLID_BREP".to_owned(), "shell 2".to_owned()),
            ]
        );
        assert!((nested.volume - mesh.volume).abs() < 1e-6 * mesh.volume);
    }

    #[test]
    fn the_written_faces_enclose_the_render_volume() {
        for triangles in [
            cuboid([-3.0, 1.0, 2.5], [7.25, 4.0, 9.0], false),
            plate_with_hole([100.0, 100.0, 5.0], [50.0, 50.0], 3.0, 64),
            cylinder([1.0, 2.0], 12.0, 30.0, 96),
            sphere([5.0, 5.0, 5.0], 4.0, 16, 32, false),
        ] {
            let (mesh, faceted) = written(triangles);
            assert!(
                (faceted.volume - mesh.volume).abs() <= 1e-9 * mesh.volume.max(1.0),
                "{} against {}",
                faceted.volume,
                mesh.volume
            );
        }
    }

    #[test]
    fn an_open_or_non_manifold_mesh_is_refused() {
        let mut open = cuboid([0.0; 3], [1.0; 3], false);
        open.pop();
        let open = mesh::Mesh::from_triangles(open).unwrap();
        let error = write(&open, &header()).err().unwrap();
        assert_eq!(error.code, "INTERNAL");
        assert!(
            error.message.contains("not a closed solid"),
            "{}",
            error.message
        );
        // Two boxes sharing one edge: that edge has four faces.
        let edge = mesh::Mesh::from_triangles(
            [
                cuboid([0.0; 3], [1.0; 3], false),
                cuboid([1.0, 1.0, 0.0], [2.0, 2.0, 1.0], false),
            ]
            .concat(),
        )
        .unwrap();
        assert!(edge.non_manifold_edges > 0);
        assert_eq!(write(&edge, &header()).err().unwrap().code, "INTERNAL");
    }

    #[test]
    fn a_pinched_region_is_traced_as_triangles() {
        // Two coplanar triangles that share only vertex 0: its boundary touches itself there.
        let vertices = [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [-1.0, 0.0, 0.0],
            [-1.0, -1.0, 0.0],
        ];
        let tris = [[0, 1, 2], [0, 3, 4]];
        let region_of = [7, 7, 9];
        let outside = |_: (u32, u32)| Some(2);
        assert!(loops_of(
            &[0, 1],
            &tris,
            &vertices,
            &region_of,
            7,
            [0.0, 0.0, 1.0],
            &outside
        )
        .is_none());
        let single = loops_of(
            &[0],
            &tris,
            &vertices,
            &region_of,
            7,
            [0.0, 0.0, 1.0],
            &outside,
        )
        .unwrap();
        assert_eq!(single, vec![vec![0, 1, 2]]);
    }

    #[test]
    fn output_is_deterministic() {
        let triangles = [
            plate_with_hole([40.0, 30.0, 4.0], [20.0, 15.0], 8.0, 48),
            cuboid([50.0, 0.0, 0.0], [60.0, 10.0, 10.0], false),
            cuboid([52.0, 2.0, 2.0], [58.0, 8.0, 8.0], true),
        ]
        .concat();
        let first = write(&mesh(triangles.clone()), &header()).unwrap().text;
        for _ in 0..3 {
            assert_eq!(
                write(&mesh(triangles.clone()), &header()).unwrap().text,
                first
            );
        }
    }

    #[test]
    fn numbers_and_strings_follow_part_21() {
        assert_eq!(real(3.0), "3.");
        assert_eq!(real(-0.5), "-0.5");
        assert_eq!(real(f64::from(0.1f32)), "0.1");
        assert_eq!(real(0.0), "0.");
        assert_eq!(real(-0.0), "0.");
        assert_eq!(real(1e-7), "0.0000001");
        assert_eq!(real(1234567.0), "1234567.");
        assert!(!real(1e20).contains('e'));
        assert_eq!(unit(std::f64::consts::FRAC_1_SQRT_2), "0.707106781187");
        assert_eq!(unit(-1e-13), "0.");
        assert_eq!(
            step_string("Bracket ø6 'left'"),
            "Bracket \\X2\\00F8\\X0\\6 ''left''"
        );
        assert_eq!(step_string("a\\b"), "a\\\\b");
        assert_eq!(step_string("Ø€"), "\\X2\\00D820AC\\X0\\");
        assert_eq!(step_string("🛰"), "\\X2\\D83DDEF0\\X0\\");
        let (_, faceted) = written(cuboid([0.0; 3], [1.0; 3], false));
        let named = write(
            &mesh(cuboid([0.0; 3], [1.0; 3], false)),
            &Header {
                product: "Halter 'Ø6'",
                ..header()
            },
        )
        .unwrap();
        assert!(named
            .text
            .contains("PRODUCT('Halter ''\\X2\\00D8\\X0\\6''','Halter ''\\X2\\00D8\\X0\\6''',''"));
        assert!(faceted
            .text
            .contains("FILE_NAME('test-part-r1.step','2026-10-21T12:00:00',"));
    }

    #[test]
    fn a_mesh_over_the_triangle_limit_is_refused_before_any_work() {
        let cube = mesh(cuboid([0.0; 3], [1.0; 3], false));
        let error = write_limited(&cube, &header(), 11).err().unwrap();
        assert!(mesh::is_work_limit(&error), "{error:?}");
        assert!(error.message.contains("Faceted STEP triangles"));
        assert!(write_limited(&cube, &header(), 12).is_ok());
    }
}
