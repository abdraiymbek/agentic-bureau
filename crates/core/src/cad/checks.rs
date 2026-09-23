//! Explicit request assertions measured against one immutable mesh.
use super::*;

fn number(value: &Value) -> f64 {
    value.as_f64().unwrap_or(0.0)
}
fn p2(value: &Value) -> [f64; 2] {
    [number(&value[0]), number(&value[1])]
}
fn p3(value: &Value) -> [f64; 3] {
    [number(&value[0]), number(&value[1]), number(&value[2])]
}
fn distance(a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}
fn near(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol
}
fn line(
    name: impl Into<String>,
    pass: bool,
    detail: impl Into<String>,
    tightness: Option<f64>,
) -> Value {
    let mut value = json!({"name":name.into(),"pass":pass,"detail":detail.into()});
    if let Some(tightness) = tightness {
        value["tightness"] = json!(tightness);
    }
    value
}
fn axis_index(axis: &str) -> CoreResult<usize> {
    match axis {
        "x" => Ok(0),
        "y" => Ok(1),
        "z" => Ok(2),
        _ => Err(ContractError::validation("Unknown section axis")),
    }
}
fn fmt(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        format!("{value:.3}")
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_owned()
    }
}
fn vec(values: &[f64]) -> String {
    format!(
        "({})",
        values
            .iter()
            .map(|v| fmt(*v))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

pub fn run(mesh: &mesh::Mesh, expect: &Value) -> CoreResult<Vec<Value>> {
    let mut checks = Vec::new();
    let sections = expect["sections"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let solid = expect["solid"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let empty = expect["empty"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let assertions = solid.len()
        + empty.len()
        + sections
            .iter()
            .map(|s| {
                1 + s["holes"].as_array().map(Vec::len).unwrap_or(0)
                    + s["slots"].as_array().map(Vec::len).unwrap_or(0)
                    + s["polygons"].as_array().map(Vec::len).unwrap_or(0)
            })
            .sum::<usize>();
    if assertions > 512
        || mesh.triangles.len() * (solid.len() + empty.len() + 2 * sections.len()) > 10_000_000
    {
        return Err(ContractError::validation(
            "CAD check exceeds the supported V0.1 work limit",
        ));
    }
    if let Some(maximum) = expect["maxSelfIntersections"].as_u64() {
        let count = mesh.count_intersections()?;
        checks.push(line(
            "self-intersections",
            count <= maximum as usize,
            format!("{count} intersecting triangle pair(s) — allowed {maximum}"),
            Some(1.0 / (maximum as f64 + 1.0)),
        ));
    }
    if expect["bbox"].is_object() {
        let bbox = &expect["bbox"];
        let min = p3(&bbox["min"]);
        let max = p3(&bbox["max"]);
        let tol = bbox["tol"].as_f64().unwrap_or(0.1);
        let pass = (0..3).all(|i| {
            near(mesh.bounds_min[i], min[i], tol) && near(mesh.bounds_max[i], max[i], tol)
        });
        checks.push(line(
            "bounding box",
            pass,
            format!(
                "min {} max {} — expected min {} max {} ±{tol}",
                vec(&mesh.bounds_min),
                vec(&mesh.bounds_max),
                vec(&min),
                vec(&max)
            ),
            Some(1.0 / tol),
        ));
    }
    if expect["volume"].is_object() {
        let value = number(&expect["volume"]["value"]);
        let tol = expect["volume"]["tolPct"].as_f64().unwrap_or(1.5);
        let error = (mesh.volume - value).abs() / value * 100.0;
        let restated = (mesh.volume - value).abs() < 1e-3 && value.fract() != 0.0;
        checks.push(line("volume",error<=tol&&!restated,if restated {format!("{} mm³ — expected value is a copy of the measurement; compute the expected volume from the request",fmt(mesh.volume))}else{format!("{} mm³ — expected {} ±{tol}% (off by {error:.2}%)",fmt(mesh.volume),fmt(value))},Some(1.0/tol)));
    }
    if expect["watertight"] != false {
        checks.push(line(
            "watertight",
            mesh.watertight && !mesh.inverted,
            format!(
                "boundary edges {}, non-manifold {}, inverted {}",
                mesh.boundary_edges, mesh.non_manifold_edges, mesh.inverted
            ),
            None,
        ));
    }
    if let Some(shells) = expect["shells"].as_u64() {
        checks.push(line(
            "single body",
            mesh.shells == shells as usize,
            format!("{} shell(s) — expected {shells}", mesh.shells),
            None,
        ));
    }
    for point in solid {
        let xyz = p3(point);
        let present = mesh.contains(xyz);
        checks.push(line(
            format!("solid at {}", vec(&xyz)),
            present,
            if present {
                "material present"
            } else {
                "EMPTY — expected material"
            },
            None,
        ));
    }
    for point in empty {
        let xyz = p3(point);
        let present = mesh.contains(xyz);
        checks.push(line(
            format!("empty at {}", vec(&xyz)),
            !present,
            if present {
                "MATERIAL — expected empty"
            } else {
                "empty"
            },
            None,
        ));
    }
    let min_round = expect["minRoundness"].as_f64().unwrap_or(0.97);
    for spec in sections {
        let axis = axis_index(required_str(spec, "axis")?)?;
        let at = number(&spec["at"]);
        let slice = section::Section::from_mesh(mesh, axis, at);
        let label = format!("section {}={}", ["x", "y", "z"][axis], fmt(at));
        let axes = [
            ["x", "y", "z"][slice.plane_axes[0]],
            ["x", "y", "z"][slice.plane_axes[1]],
        ];
        let holes = slice.loops.iter().filter(|l| l.is_hole).collect::<Vec<_>>();
        let outers = slice
            .loops
            .iter()
            .filter(|l| !l.is_hole)
            .collect::<Vec<_>>();
        if let Some(count) = spec["holeCount"].as_u64() {
            checks.push(line(
                format!("{label}: hole count"),
                holes.len() == count as usize,
                format!(
                    "{} cut-out loop(s) — expected {count}{}",
                    holes.len(),
                    if holes.is_empty() {
                        String::new()
                    } else {
                        format!(
                            "; found: {}",
                            holes
                                .iter()
                                .map(|l| section::describe(l, axes))
                                .collect::<Vec<_>>()
                                .join("; ")
                        )
                    }
                ),
                None,
            ));
        }
        if let Some(count) = spec["outerCount"].as_u64() {
            checks.push(line(
                format!("{label}: body count"),
                outers.len() == count as usize,
                format!("{} material region(s) — expected {count}", outers.len()),
                None,
            ));
        }
        for hole in spec["holes"].as_array().into_iter().flatten() {
            let center = p2(&hole["center"]);
            let diameter = number(&hole["d"]);
            let tol = hole["tol"].as_f64().unwrap_or(0.1);
            let nearest = holes
                .iter()
                .map(|loop_| (*loop_, distance(loop_.centroid, center)))
                .min_by(|a, b| a.1.total_cmp(&b.1));
            let name = format!(
                "{label}: hole d{} at ({}={}, {}={})",
                fmt(diameter),
                axes[0],
                fmt(center[0]),
                axes[1],
                fmt(center[1])
            );
            if let Some((loop_, distance)) = nearest {
                if distance > tol.max(diameter) {
                    checks.push(line(
                        name,
                        false,
                        format!(
                            "no hole near that position (nearest cut-out {} mm away)",
                            fmt(distance)
                        ),
                        None,
                    ));
                    continue;
                }
                if let Some(circle) = &loop_.circle {
                    let measured = circle.radius * 2.0;
                    let pass = distance <= tol
                        && near(measured, diameter, tol)
                        && circle.roundness >= min_round;
                    checks.push(line(
                        name,
                        pass,
                        format!(
                            "found d={} at {} roundness {}",
                            fmt(measured),
                            vec(&loop_.centroid),
                            circle.roundness
                        ),
                        Some(1.0 / tol),
                    ));
                } else {
                    checks.push(line(
                        name,
                        false,
                        format!(
                            "cut-out at {} is not circular (bbox {}×{})",
                            vec(&loop_.centroid),
                            loop_.size[0],
                            loop_.size[1]
                        ),
                        None,
                    ));
                }
            } else {
                checks.push(line(
                    name,
                    false,
                    "no hole near that position (nearest cut-out none in this plane)",
                    None,
                ));
            }
        }
        for slot in spec["slots"].as_array().into_iter().flatten() {
            let center = p2(&slot["center"]);
            let size = p2(&slot["size"]);
            let tol = slot["tol"].as_f64().unwrap_or(0.1);
            let found = holes.iter().find(|l| {
                (0..2).all(|i| {
                    near(l.size[i], size[i], tol)
                        && near((l.min[i] + l.max[i]) / 2.0, center[i], tol)
                })
            });
            checks.push(line(
                format!(
                    "{label}: cut-out {}×{} at ({axes0}={}, {axes1}={})",
                    fmt(size[0]),
                    fmt(size[1]),
                    fmt(center[0]),
                    fmt(center[1]),
                    axes0 = axes[0],
                    axes1 = axes[1]
                ),
                found.is_some(),
                if let Some(l) = found {
                    format!("found cut-out bbox {}×{}", l.size[0], l.size[1])
                } else {
                    format!(
                        "no cut-out with that footprint; cut-outs present: {}",
                        holes
                            .iter()
                            .map(|l| section::describe(l, axes))
                            .collect::<Vec<_>>()
                            .join("; ")
                    )
                },
                None,
            ));
        }
        for polygon in spec["polygons"].as_array().into_iter().flatten() {
            let center = p2(&polygon["center"]);
            let sides = polygon["sides"].as_u64().unwrap_or(0) as usize;
            let flats = number(&polygon["acrossFlats"]);
            let tol = polygon["tol"].as_f64().unwrap_or(0.1);
            let nearest = holes
                .iter()
                .map(|loop_| (*loop_, distance(loop_.centroid, center)))
                .min_by(|a, b| a.1.total_cmp(&b.1));
            let name = format!(
                "{label}: {sides}-gon across-flats {} at ({}={}, {}={})",
                fmt(flats),
                axes[0],
                fmt(center[0]),
                axes[1],
                fmt(center[1])
            );
            if let Some((l, d)) = nearest {
                let circum = flats / (2.0 * (std::f64::consts::PI / sides as f64).cos());
                let pass = d <= tol
                    && l.points.len() == sides
                    && l.circle.as_ref().is_some_and(|c| {
                        near(c.min_radius * 2.0, flats, tol)
                            && near(c.max_radius * 2.0, circum * 2.0, tol)
                    });
                checks.push(line(
                    name,
                    pass,
                    format!(
                        "found {} sides, across-flats {}, across-corners {}",
                        l.points.len(),
                        l.circle
                            .as_ref()
                            .map(|c| fmt(c.min_radius * 2.0))
                            .unwrap_or("?".into()),
                        l.circle
                            .as_ref()
                            .map(|c| fmt(c.max_radius * 2.0))
                            .unwrap_or("?".into())
                    ),
                    None,
                ));
            } else {
                checks.push(line(name, false, "no cut-out centered there", None));
            }
        }
        if spec["outer"].is_object() {
            let tol = spec["outer"]["tol"].as_f64().unwrap_or(0.1);
            let largest = outers.iter().max_by(|a, b| a.area.total_cmp(&b.area));
            if let Some(outer) = largest {
                if spec["outer"]["size"].is_array() {
                    let expected = p2(&spec["outer"]["size"]);
                    let center = spec["outer"]["center"]
                        .as_array()
                        .map(|_| p2(&spec["outer"]["center"]));
                    let pass = outer.rectangle.as_ref().is_some_and(|r| {
                        (0..2).all(|i| {
                            near(r.size[i], expected[i], tol)
                                && center.is_none_or(|c| near(r.center[i], c[i], tol))
                        })
                    });
                    checks.push(line(
                        format!("{label}: outer rectangle {}×{}", expected[0], expected[1]),
                        pass,
                        format!("found bbox {}×{}", outer.size[0], outer.size[1]),
                        None,
                    ));
                } else if let Some(diameter) = spec["outer"]["d"].as_f64() {
                    let center = spec["outer"]["center"]
                        .as_array()
                        .map(|_| p2(&spec["outer"]["center"]));
                    let pass = outer.circle.as_ref().is_some_and(|c| {
                        near(c.radius * 2.0, diameter, tol)
                            && c.roundness >= min_round
                            && center.is_none_or(|expected| {
                                (0..2).all(|i| near(outer.centroid[i], expected[i], tol))
                            })
                    });
                    checks.push(line(
                        format!("{label}: outer circle d{diameter}"),
                        pass,
                        format!("found bbox {}×{}", outer.size[0], outer.size[1]),
                        None,
                    ));
                }
            } else {
                checks.push(line(
                    format!("{label}: outer profile"),
                    false,
                    "no material in this plane",
                    None,
                ));
            }
        }
        if spec["materialArea"].is_object() {
            let expected = number(&spec["materialArea"]["value"]);
            let tol = spec["materialArea"]["tolPct"].as_f64().unwrap_or(1.5);
            let error = (slice.material_area - expected).abs() / expected * 100.0;
            checks.push(line(
                format!("{label}: material area"),
                error <= tol,
                format!(
                    "{} mm² — expected {expected} ±{tol}%",
                    fmt(slice.material_area)
                ),
                None,
            ));
        }
        if slice.open_chains > 0 {
            checks.push(line(
                format!("{label}: closed"),
                false,
                format!("{} open chain(s) in section", slice.open_chains),
                None,
            ));
        }
    }
    Ok(checks)
}

pub(super) fn preservation(
    reference: &mesh::Mesh,
    candidate: &mesh::Mesh,
    regions: &Value,
) -> CoreResult<Value> {
    let regions = regions
        .as_array()
        .ok_or_else(|| ContractError::validation("Preservation change regions are required"))?;
    if regions.len() > 512
        || 400 * (reference.triangles.len() + candidate.triangles.len() + regions.len())
            > 10_000_000
    {
        return Err(ContractError::validation(
            "Preservation check exceeds the supported work limit",
        ));
    }
    let min =
        std::array::from_fn::<_, 3, _>(|i| reference.bounds_min[i].min(candidate.bounds_min[i]));
    let max =
        std::array::from_fn::<_, 3, _>(|i| reference.bounds_max[i].max(candidate.bounds_max[i]));
    let mut rng = 0x2545_f491u32;
    let mut tested = 0;
    let mut mismatched = 0;
    let mut examples = Vec::new();
    for _ in 0..400 {
        let mut point = [0.0; 3];
        for axis in 0..3 {
            rng ^= rng << 13;
            rng ^= rng >> 17;
            rng ^= rng << 5;
            point[axis] =
                min[axis] + ((rng % 1_000_000) as f64 / 1_000_000.0) * (max[axis] - min[axis]);
        }
        if regions.iter().any(|region| {
            let center = p3(&region["center"]);
            let radius = number(&region["radius"]);
            (0..3)
                .map(|i| (point[i] - center[i]).powi(2))
                .sum::<f64>()
                .sqrt()
                <= radius
        }) {
            continue;
        }
        tested += 1;
        let before = reference.contains(point);
        let after = candidate.contains(point);
        if before != after {
            mismatched += 1;
            if examples.len() < 3 {
                examples.push(format!(
                    "{} was {} now {}",
                    vec(&point),
                    if before { "solid" } else { "empty" },
                    if after { "solid" } else { "empty" }
                ));
            }
        }
    }
    Ok(line(
        "unrelated geometry preserved",
        mismatched == 0,
        format!(
            "{tested} sample points outside change regions, {mismatched} differ{}",
            if examples.is_empty() {
                String::new()
            } else {
                format!(": {}", examples.join("; "))
            }
        ),
        None,
    ))
}
