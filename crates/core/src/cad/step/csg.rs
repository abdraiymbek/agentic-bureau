//! How far the render's facets can lie from the exact surfaces the converter
//! rebuilds, read from OpenSCAD's CSG tree.
//!
//! A circle of radius r drawn with f facets is off by r(1 − cos(π/f)), its
//! sagitta. Each curved primitive's sagitta is stretched by the transforms
//! that enclose it, and only by those: a `scale([100, 100, 5]) cube(1)`
//! beside a small hole does not stretch the hole. A boolean can leave render
//! triangles that span several facets, which no estimate from the triangles
//! sees, so the bound is the largest over the whole tree.
use crate::cad::mesh;
use std::f64::consts::{PI, TAU};

/// A hull of shapes other than upright cylinders or circles is rebuilt from
/// points within this distance of the shapes' surfaces (`csg_to_step.py`).
const HULL_DEFLECTION_MM: f64 = 0.01;
/// Deeper trees are not read; the bound is then zero, which can only make the
/// comparison stricter.
const MAX_DEPTH: usize = 1000;

/// One statement of OpenSCAD's CSG text: `name(args) { children }` or
/// `name(args);`.
struct Node {
    name: String,
    args: String,
    children: Vec<Node>,
}

/// The tree, or `None` for text that is not a CSG tree. Modifier characters
/// (`%`, `#`, `!`, `*`) are skipped: a bound over more primitives than the
/// render has is still a bound.
fn parse(text: &str) -> Option<Vec<Node>> {
    let mut at = 0;
    statements(text.as_bytes(), &mut at, 0)
}

fn skip_space(bytes: &[u8], at: &mut usize) {
    while *at < bytes.len() && bytes[*at].is_ascii_whitespace() {
        *at += 1;
    }
}

fn statements(bytes: &[u8], at: &mut usize, depth: usize) -> Option<Vec<Node>> {
    if depth > MAX_DEPTH {
        return None;
    }
    let mut nodes = Vec::new();
    loop {
        while *at < bytes.len()
            && (bytes[*at].is_ascii_whitespace() || b";%#!*".contains(&bytes[*at]))
        {
            *at += 1;
        }
        let Some(&next) = bytes.get(*at) else {
            return (depth == 0).then_some(nodes);
        };
        if next == b'}' {
            *at += 1;
            return (depth > 0).then_some(nodes);
        }
        let start = *at;
        while *at < bytes.len()
            && (bytes[*at].is_ascii_alphanumeric() || b"_$".contains(&bytes[*at]))
        {
            *at += 1;
        }
        let name = std::str::from_utf8(&bytes[start..*at]).ok()?.to_owned();
        skip_space(bytes, at);
        if name.is_empty() || bytes.get(*at) != Some(&b'(') {
            return None;
        }
        // The arguments run to the matching parenthesis; strings may hold any character.
        let open = *at;
        let (mut level, mut quoted) = (0usize, false);
        loop {
            let c = *bytes.get(*at)?;
            if quoted {
                if c == b'\\' {
                    *at += 1;
                } else if c == b'"' {
                    quoted = false;
                }
            } else if c == b'"' {
                quoted = true;
            } else if c == b'(' || c == b'[' {
                level += 1;
            } else if c == b')' || c == b']' {
                level = level.checked_sub(1)?;
                if level == 0 {
                    break;
                }
            }
            *at += 1;
        }
        let args = std::str::from_utf8(&bytes[open + 1..*at]).ok()?.to_owned();
        *at += 1;
        skip_space(bytes, at);
        let children = if bytes.get(*at) == Some(&b'{') {
            *at += 1;
            statements(bytes, at, depth + 1)?
        } else {
            Vec::new()
        };
        nodes.push(Node {
            name,
            args,
            children,
        });
    }
}

/// The raw value of the named argument, split at top-level commas.
fn argument<'a>(args: &'a str, key: &str) -> Option<&'a str> {
    let (mut level, mut quoted, mut start) = (0usize, false, 0);
    let mut parts = Vec::new();
    for (index, c) in args.char_indices() {
        match c {
            '"' => quoted = !quoted,
            '[' | '(' if !quoted => level += 1,
            ']' | ')' if !quoted => level = level.saturating_sub(1),
            ',' if !quoted && level == 0 => {
                parts.push(&args[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    parts.push(&args[start..]);
    parts.into_iter().find_map(|part| {
        let (name, value) = part.split_once('=')?;
        (name.trim() == key).then(|| value.trim())
    })
}

/// Every number in a value, in order: a scalar, a vector, a matrix.
fn numbers(value: &str) -> Vec<f64> {
    value
        .split(|c: char| !(c.is_ascii_digit() || matches!(c, '.' | '-' | '+' | 'e' | 'E')))
        .filter_map(|token| token.parse::<f64>().ok())
        .collect()
}

fn number(args: &str, key: &str) -> Option<f64> {
    argument(args, key)?.parse::<f64>().ok()
}

/// The 4 × 4 matrix of a `multmatrix`, its one positional argument.
fn matrix(args: &str) -> Option<[[f64; 4]; 4]> {
    let values = numbers(args);
    if values.len() != 16 && values.len() != 12 {
        return None;
    }
    let mut rows = [[0.0, 0.0, 0.0, 1.0]; 4];
    for (index, value) in values.into_iter().enumerate() {
        rows[index / 4][index % 4] = value;
    }
    Some(rows)
}

/// OpenSCAD's facet count for a circle of radius `r` (`get_fragments_from_r`).
fn fragments(r: f64, args: &str) -> f64 {
    let (fn_, fs, fa) = (
        number(args, "$fn").unwrap_or(0.0),
        number(args, "$fs").unwrap_or(2.0),
        number(args, "$fa").unwrap_or(12.0),
    );
    if r < 0.000_000_953_674_316_406_25 {
        return 3.0;
    }
    if fn_ > 0.0 {
        return fn_.floor().max(3.0);
    }
    (360.0 / fa).min(r * TAU / fs).max(5.0).ceil()
}

fn sagitta(r: f64, half_angle: f64) -> f64 {
    r * (1.0 - half_angle.cos())
}

/// The largest factor by which `m` stretches any length: its largest
/// singular value, from the eigenvalues of mᵀm.
fn stretch(m: &[[f64; 3]; 3]) -> f64 {
    let a: [[f64; 3]; 3] =
        std::array::from_fn(|i| std::array::from_fn(|j| (0..3).map(|k| m[k][i] * m[k][j]).sum()));
    let off = a[0][1].powi(2) + a[0][2].powi(2) + a[1][2].powi(2);
    let largest = if off <= f64::MIN_POSITIVE {
        a[0][0].max(a[1][1]).max(a[2][2])
    } else {
        let q = (a[0][0] + a[1][1] + a[2][2]) / 3.0;
        let p =
            (((a[0][0] - q).powi(2) + (a[1][1] - q).powi(2) + (a[2][2] - q).powi(2) + 2.0 * off)
                / 6.0)
                .sqrt();
        let b = |i: usize, j: usize| (a[i][j] - if i == j { q } else { 0.0 }) / p;
        let det = b(0, 0) * (b(1, 1) * b(2, 2) - b(1, 2) * b(2, 1))
            - b(0, 1) * (b(1, 0) * b(2, 2) - b(1, 2) * b(2, 0))
            + b(0, 2) * (b(1, 0) * b(2, 1) - b(1, 1) * b(2, 0));
        q + 2.0 * p * ((det / 2.0).clamp(-1.0, 1.0).acos() / 3.0).cos()
    };
    // A rounding margin: the bound must not fall short.
    largest.max(0.0).sqrt() * (1.0 + 1e-9)
}

/// The farthest a 2D subtree reaches from the y axis, in the frame whose x
/// row is `row` (x' = row · (x, y, 0, 1)): the radius a `rotate_extrude`
/// revolves it at. `None` for shapes it cannot say (text, an import, ...).
fn reach_x(node: &Node, row: [f64; 4]) -> Option<f64> {
    let across = row[0].hypot(row[1]);
    let at = |x: f64, y: f64| (row[0] * x + row[1] * y + row[3]).abs();
    let children = |kids: &[Node]| -> Option<f64> {
        kids.iter()
            .map(|child| reach_x(child, row))
            .try_fold(0.0f64, |far, child| Some(far.max(child?)))
    };
    match node.name.as_str() {
        "multmatrix" => {
            let m = matrix(&node.args)?;
            let next = std::array::from_fn(|j| {
                (0..3).map(|k| row[k] * m[k][j]).sum::<f64>() + if j == 3 { row[3] } else { 0.0 }
            });
            node.children
                .iter()
                .map(|child| reach_x(child, next))
                .try_fold(0.0f64, |far, child| Some(far.max(child?)))
        }
        "square" => {
            let size = numbers(argument(&node.args, "size")?);
            let (x, y) = match size[..] {
                [s] => (s, s),
                [x, y, ..] => (x, y),
                _ => return None,
            };
            let (x0, y0) = if argument(&node.args, "center") == Some("true") {
                (-x / 2.0, -y / 2.0)
            } else {
                (0.0, 0.0)
            };
            Some(
                [(x0, y0), (x0 + x, y0), (x0, y0 + y), (x0 + x, y0 + y)]
                    .into_iter()
                    .map(|(x, y)| at(x, y))
                    .fold(0.0, f64::max),
            )
        }
        "circle" => Some(at(0.0, 0.0) + number(&node.args, "r")?.abs() * across),
        "polygon" => {
            let points = numbers(argument(&node.args, "points")?);
            Some(
                points
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|[x, y]| at(*x, *y))
                    .fold(0.0, f64::max),
            )
        }
        "offset" => {
            let amount = number(&node.args, "r").or_else(|| number(&node.args, "delta"))?;
            Some(children(&node.children)? + amount.abs() * across)
        }
        // What a difference keeps lies within its first child; an intersection's within each.
        "difference" => node
            .children
            .first()
            .map_or(Some(0.0), |first| reach_x(first, row)),
        "intersection" => node
            .children
            .iter()
            .filter_map(|child| reach_x(child, row))
            .reduce(f64::min)
            .or(node.children.is_empty().then_some(0.0)),
        "group" | "union" | "render" | "color" | "hull" => children(&node.children),
        _ => None,
    }
}

/// Walk the tree, keeping the largest sagitta of any curved primitive,
/// stretched by its own enclosing transforms (`linear` is their product).
fn walk(node: &Node, linear: [[f64; 3]; 3], world_reach: f64, bound: &mut f64) {
    let args = node.args.as_str();
    let local = match node.name.as_str() {
        "cylinder" => {
            let r = number(args, "r1")
                .unwrap_or(0.0)
                .max(number(args, "r2").unwrap_or(0.0));
            let facets = fragments(r, args);
            // Three to eight facets are rebuilt as the polygon they are.
            if r > 0.0 && facets > 8.0 {
                sagitta(r, PI / facets)
            } else {
                0.0
            }
        }
        "circle" => {
            let r = number(args, "r").unwrap_or(0.0).abs();
            let facets = fragments(r, args);
            if r > 0.0 && facets > 8.0 {
                sagitta(r, PI / facets)
            } else {
                0.0
            }
        }
        "sphere" => {
            // Rings of `facets` points at (2·ring + 1)·90°/rings from the pole: a face's
            // corners lie half a step apart both ways from its middle.
            let r = number(args, "r").unwrap_or(0.0).abs();
            let facets = fragments(r, args);
            let rings = ((facets + 1.0) / 2.0).floor().max(1.0);
            r * (1.0 - (PI / facets).cos() * (PI / (2.0 * rings)).cos())
        }
        "offset" => number(args, "r").map_or(0.0, |r| {
            let facets = fragments(r.abs(), args);
            sagitta(r.abs(), PI / facets)
        }),
        "rotate_extrude" => {
            // OpenSCAD revolves the profile with the facets of its farthest point from the
            // axis, a fraction of them for a partial turn.
            let radius = node
                .children
                .iter()
                .map(|child| reach_x(child, [1.0, 0.0, 0.0, 0.0]))
                .try_fold(0.0f64, |far, child| Some(far.max(child?)))
                .unwrap_or(world_reach);
            let angle = number(args, "angle").unwrap_or(360.0).abs().min(360.0);
            let facets = (fragments(radius, args) * angle / 360.0).ceil().max(1.0);
            if radius > 0.0 && angle > 0.0 {
                sagitta(radius, angle.to_radians() / facets / 2.0)
            } else {
                0.0
            }
        }
        "hull" => HULL_DEFLECTION_MM,
        _ => 0.0,
    };
    if local > 0.0 {
        *bound = bound.max(local * stretch(&linear));
    }
    let linear = match node.name.as_str() {
        "multmatrix" => matrix(args).map_or(linear, |m| {
            std::array::from_fn(|i| {
                std::array::from_fn(|j| (0..3).map(|k| linear[i][k] * m[k][j]).sum())
            })
        }),
        _ => linear,
    };
    for child in &node.children {
        walk(child, linear, world_reach, bound);
    }
}

/// How far a facet of the render can lie from the exact surface the
/// converter rebuilds, in mm: zero for a tree of flat faces, or for text that
/// is not a CSG tree (the comparison is then only stricter).
pub(super) fn csg_sagitta(csg: &str, mesh: &mesh::Mesh) -> f64 {
    let Some(tree) = parse(csg) else {
        return 0.0;
    };
    // A revolution whose profile cannot be read reaches at most as far from the z axis as
    // the whole part.
    let world_reach = [mesh.bounds_min, mesh.bounds_max]
        .iter()
        .flat_map(|a| [mesh.bounds_min, mesh.bounds_max].map(|b| a[0].hypot(b[1])))
        .fold(0.0, f64::max);
    let identity = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let mut bound = 0.0;
    for node in &tree {
        walk(node, identity, world_reach, &mut bound);
    }
    bound
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cad::mesh::fixtures::*;

    fn part() -> mesh::Mesh {
        mesh(cuboid([0.0; 3], [40.0, 30.0, 4.0], false))
    }

    fn circle_sagitta(r: f64, facets: f64) -> f64 {
        r * (1.0 - (PI / facets).cos())
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() <= 1e-9 * (1.0 + b.abs())
    }

    #[test]
    fn the_tree_is_read_with_its_arguments_and_modifiers() {
        let tree = parse("difference() {\n\tcube(size = [40, 30, 4], center = false);\n%\tmultmatrix([[1, 0, 0, 5], [0, 1, 0, 5], [0, 0, 1, -1], [0, 0, 0, 1]]) {\n\t\ttext(text = \"a, (b]\", size = 10);\n\t}\n\tgroup();\n}\n").unwrap();
        assert_eq!(tree.len(), 1);
        let difference = &tree[0];
        assert_eq!(difference.name, "difference");
        let names = difference
            .children
            .iter()
            .map(|child| child.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, ["cube", "multmatrix", "group"]);
        assert_eq!(
            argument(&difference.children[0].args, "size"),
            Some("[40, 30, 4]")
        );
        assert_eq!(
            argument(&difference.children[1].children[0].args, "text"),
            Some("\"a, (b]\"")
        );
        assert_eq!(
            matrix(&difference.children[1].args).unwrap()[0],
            [1.0, 0.0, 0.0, 5.0]
        );
        // Not a CSG tree: nothing to read, and no bound.
        assert!(parse("solid x\nfacet normal 0 0 1").is_none());
        assert!(parse("cube(size = [1, 1, 1]").is_none());
        assert!(parse("group() {\n").is_none());
        assert_eq!(csg_sagitta("\u{0}\u{1}binary STL", &part()), 0.0);
    }

    #[test]
    fn each_primitive_is_stretched_only_by_its_own_transforms() {
        // OpenSCAD's scale idiom: a unit cube scaled 100 times beside a ⌀2 hole and a
        // ⌀20 boss. The plate's scale does not stretch the cylinders.
        let csg = "difference() {\n\tmultmatrix([[100, 0, 0, 0], [0, 100, 0, 0], [0, 0, 5, 0], [0, 0, 0, 1]]) {\n\t\tcube(size = [1, 1, 1], center = false);\n\t}\n\tmultmatrix([[1, 0, 0, 50], [0, 1, 0, 50], [0, 0, 1, -1], [0, 0, 0, 1]]) {\n\t\tcylinder($fn = 64, $fa = 12, $fs = 2, h = 7, r1 = 1, r2 = 1, center = false);\n\t}\n}\nmultmatrix([[1, 0, 0, 130], [0, 1, 0, 50], [0, 0, 1, 0], [0, 0, 0, 1]]) {\n\tcylinder($fn = 64, $fa = 12, $fs = 2, h = 5, r1 = 10, r2 = 10, center = false);\n}\n";
        assert!(close(csg_sagitta(csg, &part()), circle_sagitta(10.0, 64.0)));
        // A scale that does enclose a primitive stretches it, by its largest factor, also
        // when a rotation inside it turns that factor away from the axes.
        let csg = "multmatrix([[2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 1]]) {\n\tcircle($fn = 32, $fa = 12, $fs = 2, r = 5);\n}\n";
        assert!(close(
            csg_sagitta(csg, &part()),
            2.0 * circle_sagitta(5.0, 32.0)
        ));
        let (c, s) = (
            std::f64::consts::FRAC_1_SQRT_2,
            std::f64::consts::FRAC_1_SQRT_2,
        );
        let csg = format!("multmatrix([[10, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) {{\n\tmultmatrix([[{c}, {}, 0, 0], [{s}, {c}, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) {{\n\t\tcylinder($fn = 64, h = 1, r1 = 1, r2 = 1, center = false);\n\t}}\n}}\n", -s);
        assert!(close(
            csg_sagitta(&csg, &part()),
            10.0 * circle_sagitta(1.0, 64.0)
        ));
        // Without $fn OpenSCAD takes $fa and $fs; a hexagon is rebuilt as the hexagon it is.
        let csg = "group() {\n\tsphere($fn = 0, $fa = 12, $fs = 2, r = 10);\n\tcylinder($fn = 6, $fa = 12, $fs = 2, h = 6, r1 = 50, r2 = 50, center = false);\n}\n";
        let sphere = 10.0 * (1.0 - (PI / 30.0).cos() * (PI / 30.0).cos());
        assert!(close(csg_sagitta(csg, &part()), sphere));
        assert_eq!(
            csg_sagitta("cube(size = [1, 1, 1], center = false);\n", &part()),
            0.0
        );
        // An approximated hull is off by its own deflection.
        let csg = "hull() {\n\tcube(size = [1, 1, 1], center = false);\n\tsphere($fn = 64, r = 0.01);\n}\n";
        assert!(csg_sagitta(csg, &part()) >= HULL_DEFLECTION_MM);
    }

    #[test]
    fn a_revolution_is_bounded_by_its_own_profile_not_by_where_it_stands() {
        // A ⌀10 revolved ring 1000 mm from the origin: its profile reaches 5 mm from its axis.
        let far = mesh(cuboid([995.0, -5.0, 0.0], [1005.0, 5.0, 5.0], false));
        let csg = "multmatrix([[1, 0, 0, 1000], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) {\n\trotate_extrude(angle = 360, convexity = 2, $fn = 48, $fa = 12, $fs = 2) {\n\t\tmultmatrix([[1, 0, 0, 3], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) {\n\t\t\tsquare(size = [2, 5], center = false);\n\t\t}\n\t}\n}\n";
        assert!(close(csg_sagitta(csg, &far), circle_sagitta(5.0, 48.0)));
        // A quarter turn has a quarter of the facets, each as wide.
        let quarter = csg.replace("angle = 360", "angle = 90");
        assert!(close(
            csg_sagitta(&quarter, &far),
            circle_sagitta(5.0, 48.0)
        ));
        // A profile it cannot read reaches as far as the part.
        let text = "rotate_extrude(angle = 360, $fn = 48) {\n\ttext(text = \"O\", size = 10);\n}\n";
        let reach = 1005.0f64.hypot(5.0);
        assert!(close(csg_sagitta(text, &far), circle_sagitta(reach, 48.0)));
        // A circle in the profile counts as well as the revolution.
        let round = "rotate_extrude(angle = 360, $fn = 128) {\n\tmultmatrix([[1, 0, 0, 20], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) {\n\t\tcircle($fn = 16, r = 4);\n\t}\n}\n";
        assert!(close(
            csg_sagitta(round, &far),
            circle_sagitta(24.0, 128.0).max(circle_sagitta(4.0, 16.0))
        ));
        // A polygon reaches its farthest point; an offset grows it; a difference keeps
        // within its first child.
        let profile = "rotate_extrude(angle = 360, $fn = 64) {\n\tdifference() {\n\t\toffset(delta = 1, chamfer = false) {\n\t\t\tpolygon(points = [[2, 0], [6, 0], [6, 3]], paths = undef, convexity = 1);\n\t\t}\n\t\tsquare(size = [100, 1], center = true);\n\t}\n}\n";
        assert!(close(csg_sagitta(profile, &far), circle_sagitta(7.0, 64.0)));
    }

    #[test]
    fn the_largest_stretch_is_the_largest_singular_value() {
        assert!(close(
            stretch(&[[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]),
            1.0
        ));
        assert!(close(
            stretch(&[[3.0, 0.0, 0.0], [0.0, -7.0, 0.0], [0.0, 0.0, 2.0]]),
            7.0
        ));
        // A shear stretches more than any of its columns.
        let shear = [[1.0, 1.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        assert!(close(stretch(&shear), (1.5 + 1.25f64.sqrt()).sqrt()));
        assert!(stretch(&shear) > 2.0f64.sqrt());
    }
}
