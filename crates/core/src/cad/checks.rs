//! Explicit request assertions measured against one immutable mesh. Every
//! assertion yields one PASS/FAIL line with the measured and expected values;
//! a failing line says what is off and what usually causes it.
use super::*;
use expect::{LINEAR_TOLERANCE, MIN_ROUNDNESS, PERCENT_TOLERANCE};

/// Facts about the part that are not in the mesh.
#[derive(Clone, Copy, Default)]
pub(crate) struct Context {
    /// The source uses curved primitives, so the faceted mesh cannot match an
    /// analytic volume to the last digit.
    pub curved_source: bool,
}

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
pub(crate) fn fmt(value: f64) -> String {
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
fn by(values: &[f64]) -> String {
    values.iter().map(|v| fmt(*v)).collect::<Vec<_>>().join("×")
}

const SECTION_ASSERTIONS: [&str; 7] = [
    "holes",
    "holeCount",
    "outerCount",
    "slots",
    "polygons",
    "outer",
    "materialArea",
];

pub(crate) fn run(mesh: &mesh::Mesh, expect: &Value, context: Context) -> CoreResult<Vec<Value>> {
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
    if assertions > mesh::MAX_ASSERTIONS {
        return Err(mesh::work_limit(
            "CAD check assertions",
            assertions,
            mesh::MAX_ASSERTIONS,
        ));
    }
    let default_tol = expect["tol"].as_f64().unwrap_or(LINEAR_TOLERANCE);
    let tol_of = |item: &Value| item["tol"].as_f64().unwrap_or(default_tol);
    if let Some(maximum) = expect["maxSelfIntersections"].as_u64() {
        let tightness = Some(1.0 / (maximum as f64 + 1.0));
        match mesh.count_intersections() {
            Ok(count) => checks.push(line(
                "self-intersections",
                count <= maximum as usize,
                format!("{count} intersecting triangle pair(s) — allowed {maximum}"),
                tightness,
            )),
            Err(error) if mesh::is_work_limit(&error) => checks.push(line(
                "self-intersections",
                false,
                format!(
                    "NOT EVALUATED — {}. This mesh has {} triangles; lower $fn or drop this assertion and report intersections as not verified.",
                    error.message,
                    mesh.triangles.len()
                ),
                tightness,
            )),
            Err(error) => return Err(error),
        }
    }
    if expect["size"].is_array() {
        let expected = p3(&expect["size"]);
        let measured = mesh.size();
        let off = (0..3)
            .filter(|i| !near(measured[*i], expected[*i], default_tol))
            .map(|i| {
                format!(
                    "{} off by {}",
                    ["x", "y", "z"][i],
                    fmt(measured[i] - expected[i])
                )
            })
            .collect::<Vec<_>>();
        checks.push(line(
            "overall size",
            off.is_empty(),
            format!(
                "{} mm — expected {} ±{default_tol}{}",
                by(&measured),
                by(&expected),
                if off.is_empty() {
                    String::new()
                } else {
                    format!(" — {}", off.join(", "))
                }
            ),
            Some(1.0 / default_tol),
        ));
    }
    if expect["bbox"].is_object() {
        let bbox = &expect["bbox"];
        let min = p3(&bbox["min"]);
        let max = p3(&bbox["max"]);
        let tol = tol_of(bbox);
        let pass = (0..3).all(|i| {
            near(mesh.bounds_min[i], min[i], tol) && near(mesh.bounds_max[i], max[i], tol)
        });
        let size_matches = (0..3).all(|i| near(mesh.size()[i], max[i] - min[i], tol));
        checks.push(line(
            "bounding box",
            pass,
            format!(
                "min {} max {} — expected min {} max {} ±{tol}{}",
                vec(&mesh.bounds_min),
                vec(&mesh.bounds_max),
                vec(&min),
                vec(&max),
                if pass {
                    ""
                } else if size_matches {
                    " — the size is right but the part sits at a different position; move it or state the corners where the request puts them"
                } else {
                    " — the envelope differs; compare each dimension with the request"
                }
            ),
            Some(1.0 / tol),
        ));
    }
    if expect["volume"].is_object() {
        let value = number(&expect["volume"]["value"]);
        let tol = expect["volume"]["tolPct"]
            .as_f64()
            .unwrap_or(PERCENT_TOLERANCE);
        let error = (mesh.volume - value).abs() / value * 100.0;
        // An expectation that restates a faceted measurement to the last digit
        // proves nothing. A prismatic part measures its analytic volume exactly.
        let restated =
            context.curved_source && (mesh.volume - value).abs() < 1e-3 && value.fract() != 0.0;
        checks.push(line(
            "volume",
            error <= tol && !restated,
            if restated {
                format!("{} mm³ — expected value is a copy of the measurement; compute the expected volume from the request (nominal dimensions) instead", fmt(mesh.volume))
            } else {
                format!(
                    "{} mm³ — expected {} ±{tol}% (off by {error:.2}%)",
                    fmt(mesh.volume),
                    fmt(value)
                )
            },
            Some(1.0 / tol),
        ));
    }
    if expect["watertight"] != false {
        let closed = mesh.watertight && !mesh.inverted;
        checks.push(line(
            "watertight",
            closed,
            format!(
                "boundary edges {}, non-manifold {}, inverted {}{}",
                mesh.boundary_edges,
                mesh.non_manifold_edges,
                mesh.inverted,
                if closed {
                    ""
                } else if mesh.inverted {
                    " — the faces point inward; list each polyhedron face clockwise seen from outside"
                } else {
                    " — the surface is open or shares an edge between more than two faces; overlap touching features slightly instead of sharing a face or edge"
                }
            ),
            None,
        ));
    }
    if let Some(shells) = expect["shells"].as_u64() {
        let pass = mesh.shells == shells as usize;
        checks.push(line(
            "single body",
            pass,
            format!(
                "{} shell(s) — expected {shells}{}",
                mesh.shells,
                if pass {
                    ""
                } else if mesh.shells > shells as usize {
                    " — features that should be one part must overlap, not merely touch; an enclosed cavity also counts as a shell"
                } else {
                    " — bodies that should be separate have merged"
                }
            ),
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
    let min_round = expect["minRoundness"].as_f64().unwrap_or(MIN_ROUNDNESS);
    for spec in sections {
        let axis = axis_index(required_str(spec, "axis")?)?;
        let at = number(&spec["at"]);
        let slice = section::Section::from_mesh(mesh, axis, at);
        let label = format!("section {}={}", ["x", "y", "z"][axis], fmt(at));
        let axes = slice.labels;
        let holes = slice.loops.iter().filter(|l| l.is_hole).collect::<Vec<_>>();
        let outers = slice
            .loops
            .iter()
            .filter(|l| !l.is_hole)
            .collect::<Vec<_>>();
        let present = || {
            let found = holes
                .iter()
                .map(|l| section::describe(l, axes))
                .collect::<Vec<_>>()
                .join("; ");
            if found.is_empty() {
                "none".to_owned()
            } else {
                found
            }
        };
        if !SECTION_ASSERTIONS.iter().any(|key| {
            spec.get(*key).is_some_and(|value| {
                !value.is_null() && !value.as_array().is_some_and(Vec::is_empty)
            })
        }) {
            checks.push(line(
                format!("{label}: assertions"),
                false,
                "this section asserts nothing — add holes, holeCount, outerCount, slots, polygons, outer or materialArea for this plane, or remove the section",
                None,
            ));
        }
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
                        format!("; found: {}", present())
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
            let tol = tol_of(hole);
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
            let Some((loop_, offset)) = nearest.filter(|(_, offset)| *offset <= tol.max(diameter))
            else {
                checks.push(line(
                    name,
                    false,
                    format!(
                        "no hole near that position (nearest cut-out {}); cut-outs in this plane: {}",
                        nearest
                            .map(|(_, offset)| format!("{} mm away", fmt(offset)))
                            .unwrap_or_else(|| "none in this plane".into()),
                        present()
                    ),
                    None,
                ));
                continue;
            };
            let Some(circle) = &loop_.circle else {
                checks.push(line(
                    name,
                    false,
                    format!(
                        "cut-out at {} is not circular (bbox {})",
                        vec(&loop_.centroid),
                        by(&loop_.size)
                    ),
                    None,
                ));
                continue;
            };
            let measured = circle.radius * 2.0;
            let position_ok = offset <= tol;
            let diameter_ok = near(measured, diameter, tol);
            let round_ok = circle.roundness >= min_round;
            let mut detail = format!(
                "found d={} at {} roundness {}",
                fmt(measured),
                vec(&loop_.centroid),
                circle.roundness
            );
            if !position_ok {
                detail.push_str(&format!(" — POSITION off by {}", fmt(offset)));
            }
            if !diameter_ok {
                detail.push_str(&format!(" — DIAMETER off by {}", fmt(measured - diameter)));
            }
            if !round_ok {
                detail.push_str(&format!(
                    " — FACETED (roundness < {min_round}; increase $fn)"
                ));
            }
            checks.push(line(
                name,
                position_ok && diameter_ok && round_ok,
                detail,
                Some(1.0 / tol),
            ));
        }
        for slot in spec["slots"].as_array().into_iter().flatten() {
            let center = p2(&slot["center"]);
            let size = p2(&slot["size"]);
            let tol = tol_of(slot);
            let found = holes.iter().find(|l| {
                (0..2).all(|i| {
                    near(l.size[i], size[i], tol)
                        && near((l.min[i] + l.max[i]) / 2.0, center[i], tol)
                })
            });
            checks.push(line(
                format!(
                    "{label}: cut-out {} at ({}={}, {}={})",
                    by(&size),
                    axes[0],
                    fmt(center[0]),
                    axes[1],
                    fmt(center[1])
                ),
                found.is_some(),
                match found {
                    Some(l) => format!("found cut-out bbox {}", by(&l.size)),
                    None => format!(
                        "no cut-out with that footprint; cut-outs present: {}",
                        present()
                    ),
                },
                Some(1.0 / tol),
            ));
        }
        for polygon in spec["polygons"].as_array().into_iter().flatten() {
            let center = p2(&polygon["center"]);
            let sides = polygon["sides"].as_u64().unwrap_or(0) as usize;
            let flats = number(&polygon["acrossFlats"]);
            let tol = tol_of(polygon);
            let corners = flats / (std::f64::consts::PI / sides as f64).cos();
            let name = format!(
                "{label}: {sides}-gon across-flats {} at ({}={}, {}={})",
                fmt(flats),
                axes[0],
                fmt(center[0]),
                axes[1],
                fmt(center[1])
            );
            let nearest = holes
                .iter()
                .map(|loop_| (*loop_, distance(loop_.centroid, center)))
                .min_by(|a, b| a.1.total_cmp(&b.1));
            let Some((l, _)) = nearest.filter(|(_, offset)| *offset <= tol) else {
                checks.push(line(
                    name,
                    false,
                    format!(
                        "no cut-out centered there (nearest {})",
                        nearest
                            .map(|(_, offset)| format!("{} mm away", fmt(offset)))
                            .unwrap_or_else(|| "none".into())
                    ),
                    None,
                ));
                continue;
            };
            let pass = l.points.len() == sides
                && l.circle.as_ref().is_some_and(|c| {
                    near(c.min_radius * 2.0, flats, tol) && near(c.max_radius * 2.0, corners, tol)
                });
            let measured = |pick: fn(&section::Circle) -> f64| {
                l.circle
                    .as_ref()
                    .map(|c| fmt(pick(c) * 2.0))
                    .unwrap_or_else(|| "?".into())
            };
            checks.push(line(
                name,
                pass,
                format!(
                    "found {} sides, across-flats {}, across-corners {} (expected {} / {})",
                    l.points.len(),
                    measured(|c| c.min_radius),
                    measured(|c| c.max_radius),
                    fmt(flats),
                    fmt(corners)
                ),
                Some(1.0 / tol),
            ));
        }
        if spec["outer"].is_object() {
            let outline = &spec["outer"];
            let tol = tol_of(outline);
            let center = outline["center"].as_array().map(|_| p2(&outline["center"]));
            let largest = outers.iter().max_by(|a, b| a.area.total_cmp(&b.area));
            match largest {
                None => checks.push(line(
                    format!("{label}: outer profile"),
                    false,
                    "no material in this plane",
                    None,
                )),
                Some(outer) if outline["size"].is_array() => {
                    let expected = p2(&outline["size"]);
                    let pass = outer.rectangle.as_ref().is_some_and(|r| {
                        (0..2).all(|i| {
                            near(r.size[i], expected[i], tol)
                                && center.is_none_or(|c| near(r.center[i], c[i], tol))
                        })
                    });
                    checks.push(line(
                        format!("{label}: outer rectangle {}", by(&expected)),
                        pass,
                        match &outer.rectangle {
                            Some(r) => {
                                format!("found {} centered {}", by(&r.size), vec(&r.center))
                            }
                            None => {
                                format!("outer loop is not rectangular (bbox {})", by(&outer.size))
                            }
                        },
                        Some(1.0 / tol),
                    ));
                }
                Some(outer) => {
                    if let Some(diameter) = outline["d"].as_f64() {
                        let pass = outer.circle.as_ref().is_some_and(|c| {
                            near(c.radius * 2.0, diameter, tol)
                                && c.roundness >= min_round
                                && center.is_none_or(|expected| {
                                    (0..2).all(|i| near(outer.centroid[i], expected[i], tol))
                                })
                        });
                        checks.push(line(
                            format!("{label}: outer circle d{}", fmt(diameter)),
                            pass,
                            match &outer.circle {
                                Some(c) => format!(
                                    "found d={} at {} roundness {}",
                                    fmt(c.radius * 2.0),
                                    vec(&outer.centroid),
                                    c.roundness
                                ),
                                None => {
                                    format!("outer loop is not circular (bbox {})", by(&outer.size))
                                }
                            },
                            Some(1.0 / tol),
                        ));
                    } else {
                        checks.push(line(
                            format!("{label}: outer profile"),
                            false,
                            "outer needs size [a, b] for a rectangle or d for a circle",
                            None,
                        ));
                    }
                }
            }
        }
        if spec["materialArea"].is_object() {
            let expected = number(&spec["materialArea"]["value"]);
            let tol = spec["materialArea"]["tolPct"]
                .as_f64()
                .unwrap_or(PERCENT_TOLERANCE);
            let error = (slice.material_area - expected).abs() / expected * 100.0;
            checks.push(line(
                format!("{label}: material area"),
                error <= tol,
                format!(
                    "{} mm² — expected {} ±{tol}%",
                    fmt(slice.material_area),
                    fmt(expected)
                ),
                Some(1.0 / tol),
            ));
        }
        if slice.open_chains > 0 {
            checks.push(line(
                format!("{label}: closed"),
                false,
                format!("{} open chain(s) in section — either the mesh is not closed here or the plane coincides with a face or edge; move `at` into the feature", slice.open_chains),
                None,
            ));
        }
    }
    Ok(checks)
}

/// Modification support: sample points across both parts and require
/// inside/outside agreement everywhere outside the declared change regions.
pub(crate) fn preservation(
    reference: &mesh::Mesh,
    candidate: &mesh::Mesh,
    regions: &[Value],
) -> CoreResult<Value> {
    const SAMPLES: usize = 400;
    if regions.len() > mesh::MAX_ASSERTIONS {
        return Err(mesh::work_limit(
            "Preservation change regions",
            regions.len(),
            mesh::MAX_ASSERTIONS,
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
    for _ in 0..SAMPLES {
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
                format!(
                    ": {} — restore the geometry there, or declare the region if the request asks for that change",
                    examples.join("; ")
                )
            }
        ),
        None,
    ))
}

/// Assertions that pass now only because their tolerance grew since they
/// last failed on the same geometry.
pub(crate) fn loosened(prior: &[Value], current: &[Value]) -> Vec<String> {
    current
        .iter()
        .filter(|check| check["pass"] == true)
        .filter_map(|check| {
            let name = check["name"].as_str()?;
            let before = prior.iter().find(|item| item["name"] == name)?;
            let (was, now) = (before["tightness"].as_f64()?, check["tightness"].as_f64()?);
            (before["pass"] == false && now < was - 1e-12).then(|| name.to_owned())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cad::mesh::fixtures::{cuboid, cylinder, merged, mesh, plate_with_hole};

    fn check(mesh: &mesh::Mesh, expect: Value) -> Vec<Value> {
        run(mesh, &expect, Context::default()).unwrap()
    }

    fn only(lines: &[Value], name: &str) -> Value {
        let found = lines
            .iter()
            .filter(|item| item["name"].as_str().unwrap().contains(name))
            .collect::<Vec<_>>();
        assert_eq!(found.len(), 1, "{name} in {lines:?}");
        found[0].clone()
    }

    fn plate() -> mesh::Mesh {
        mesh(plate_with_hole([40.0, 30.0, 4.0], [10.0, 12.0], 3.2, 64))
    }

    #[test]
    fn a_correct_expectation_passes_every_line() {
        let lines = check(
            &plate(),
            json!({
                "size": [40, 30, 4],
                "bbox": {"min": [0, 0, 0], "max": [40, 30, 4]},
                "shells": 1,
                "solid": [[30, 20, 2]],
                "empty": [[10, 12, 2], [50, 0, 0]],
                "maxSelfIntersections": 0,
                "sections": [{"axis": "z", "at": 2, "holeCount": 1, "outerCount": 1,
                    "holes": [{"center": [10, 12], "d": 3.2}],
                    "outer": {"size": [40, 30], "center": [20, 15]},
                    "materialArea": {"value": 1191.97}}],
            }),
        );
        assert_eq!(lines.len(), 13, "{lines:?}");
        assert!(lines.iter().all(|item| item["pass"] == true), "{lines:?}");
        assert_eq!(
            only(&lines, "hole d3.2")["name"],
            "section z=2: hole d3.2 at (x=10, y=12)"
        );
        assert_eq!(only(&lines, "overall size")["tightness"], json!(10.0));
    }

    #[test]
    fn a_generic_check_still_reports_watertightness() {
        let lines = check(&plate(), json!({}));
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["name"], "watertight");
        assert!(check(&plate(), json!({"watertight": false})).is_empty());
    }

    #[test]
    fn size_and_envelope_failures_say_which_dimension_or_that_the_part_moved() {
        let lines = check(&plate(), json!({"size": [40, 31, 4]}));
        let size = only(&lines, "overall size");
        assert_eq!(size["pass"], false);
        assert!(size["detail"].as_str().unwrap().contains("y off by -1"));
        let moved = check(
            &plate(),
            json!({"bbox": {"min": [-20, -15, 0], "max": [20, 15, 4]}}),
        );
        assert!(only(&moved, "bounding box")["detail"]
            .as_str()
            .unwrap()
            .contains("sits at a different position"));
        let wrong = check(
            &plate(),
            json!({"bbox": {"min": [0, 0, 0], "max": [40, 30, 5]}}),
        );
        assert!(only(&wrong, "bounding box")["detail"]
            .as_str()
            .unwrap()
            .contains("envelope differs"));
        let loose = check(&plate(), json!({"size": [40, 30.4, 4], "tol": 0.5}));
        assert_eq!(only(&loose, "overall size")["pass"], true);
    }

    #[test]
    fn volume_within_tolerance_passes_and_a_copied_faceted_measurement_does_not() {
        let cube = mesh(cuboid([0.0; 3], [12.5, 3.3, 2.0], false));
        let exact = check(&cube, json!({"volume": {"value": 82.5}}));
        assert_eq!(only(&exact, "volume")["pass"], true, "{exact:?}");
        let off = check(&cube, json!({"volume": {"value": 90}}));
        assert!(only(&off, "volume")["detail"]
            .as_str()
            .unwrap()
            .contains("off by 8.33%"));
        let rod = mesh(cylinder([0.0, 0.0], 10.0, 20.0, 64));
        let copied = run(
            &rod,
            &json!({"volume": {"value": rod.volume}}),
            Context {
                curved_source: true,
            },
        )
        .unwrap();
        assert_eq!(only(&copied, "volume")["pass"], false);
        assert!(only(&copied, "volume")["detail"]
            .as_str()
            .unwrap()
            .contains("copy of the measurement"));
        let analytic = run(
            &rod,
            &json!({"volume": {"value": 1570.8}}),
            Context {
                curved_source: true,
            },
        )
        .unwrap();
        assert_eq!(only(&analytic, "volume")["pass"], true, "{analytic:?}");
    }

    #[test]
    fn probes_and_body_counts_explain_their_failures() {
        let lines = check(
            &plate(),
            json!({"solid": [[10, 12, 2]], "empty": [[30, 20, 2]], "shells": 2}),
        );
        assert_eq!(
            only(&lines, "solid at")["detail"],
            "EMPTY — expected material"
        );
        assert_eq!(
            only(&lines, "empty at")["detail"],
            "MATERIAL — expected empty"
        );
        assert!(only(&lines, "single body")["detail"]
            .as_str()
            .unwrap()
            .contains("have merged"));
        let two = merged(&[
            cuboid([0.0; 3], [5.0; 3], false),
            cuboid([20.0, 0.0, 0.0], [25.0, 5.0, 5.0], false),
        ]);
        assert!(
            only(&check(&two, json!({"shells": 1})), "single body")["detail"]
                .as_str()
                .unwrap()
                .contains("must overlap")
        );
    }

    #[test]
    fn hole_failures_name_position_diameter_and_faceting() {
        let section = |holes: Value| json!({"sections": [{"axis": "z", "at": 2, "holes": holes}]});
        let moved = check(&plate(), section(json!([{"center": [10.5, 12], "d": 3.2}])));
        let detail = only(&moved, "hole d3.2")["detail"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(detail.contains("POSITION off by 0.5"), "{detail}");
        assert!(!detail.contains("DIAMETER"));
        let sized = check(&plate(), section(json!([{"center": [10, 12], "d": 3.5}])));
        assert!(only(&sized, "hole d3.5")["detail"]
            .as_str()
            .unwrap()
            .contains("DIAMETER off by -0.3"));
        let missing = check(&plate(), section(json!([{"center": [30, 20], "d": 3.2}])));
        let detail = only(&missing, "hole d3.2")["detail"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(detail.contains("no hole near that position"), "{detail}");
        assert!(
            detail.contains("cut-out circle d=3.2 at (x=10, y=12)"),
            "{detail}"
        );
        let coarse = mesh(plate_with_hole([20.0, 20.0, 5.0], [10.0, 10.0], 2.5, 8));
        let faceted = check(
            &coarse,
            json!({"sections": [{"axis": "z", "at": 2.5, "holes": [{"center": [10, 10], "d": 2.5}]}]}),
        );
        assert!(only(&faceted, "hole d2.5")["detail"]
            .as_str()
            .unwrap()
            .contains("FACETED (roundness < 0.97; increase $fn)"));
        let relaxed = check(
            &coarse,
            json!({"minRoundness": 0.9, "sections": [{"axis": "z", "at": 2.5, "holes": [{"center": [10, 10], "d": 2.5}]}]}),
        );
        assert_eq!(only(&relaxed, "hole d2.5")["pass"], true);
        let square = mesh(plate_with_hole([20.0, 20.0, 5.0], [10.0, 10.0], 6.0, 4));
        let not_round = check(
            &square,
            json!({"sections": [{"axis": "z", "at": 2.5, "holes": [{"center": [10, 10], "d": 6}]}]}),
        );
        assert!(only(&not_round, "hole d6")["detail"]
            .as_str()
            .unwrap()
            .contains("is not circular (bbox 6×6)"));
        let none = check(
            &mesh(cuboid([0.0; 3], [10.0; 3], false)),
            json!({"sections": [{"axis": "z", "at": 5, "holes": [{"center": [5, 5], "d": 2}]}]}),
        );
        assert!(only(&none, "hole d2")["detail"]
            .as_str()
            .unwrap()
            .contains("none in this plane"));
    }

    #[test]
    fn slots_polygons_and_counts_are_measured_from_the_cut_out_loops() {
        let window = mesh(plate_with_hole([20.0, 20.0, 5.0], [10.0, 10.0], 6.0, 4));
        let lines = check(
            &window,
            json!({"sections": [{"axis": "z", "at": 2.5, "holeCount": 1,
                "slots": [{"center": [10, 10], "size": [6, 6]}, {"center": [10, 10], "size": [8, 6]}]}]}),
        );
        assert_eq!(only(&lines, "cut-out 6×6")["pass"], true);
        let missing = only(&lines, "cut-out 8×6");
        assert_eq!(missing["pass"], false);
        assert!(missing["detail"]
            .as_str()
            .unwrap()
            .contains("cut-outs present: cut-out"));
        let hex = mesh(plate_with_hole([30.0, 30.0, 5.0], [15.0, 15.0], 8.0, 6));
        let flats = 8.0 * (std::f64::consts::PI / 6.0).cos();
        let trap = check(
            &hex,
            json!({"sections": [{"axis": "z", "at": 2.5, "holeCount": 2,
                "polygons": [
                    {"center": [15, 15], "sides": 6, "acrossFlats": flats},
                    {"center": [15, 15], "sides": 6, "acrossFlats": 5.5},
                    {"center": [5, 5], "sides": 6, "acrossFlats": flats}]}]}),
        );
        assert_eq!(
            only(&trap, "across-flats 6.928 at (x=15")["pass"],
            true,
            "{trap:?}"
        );
        let wrong = only(&trap, "across-flats 5.5");
        assert_eq!(wrong["pass"], false);
        assert!(wrong["detail"]
            .as_str()
            .unwrap()
            .contains("(expected 5.5 / 6.351)"));
        assert!(only(&trap, "at (x=5, y=5)")["detail"]
            .as_str()
            .unwrap()
            .contains("no cut-out centered there"));
        let count = only(&trap, "hole count");
        assert_eq!(count["pass"], false);
        assert!(count["detail"]
            .as_str()
            .unwrap()
            .contains("1 cut-out loop(s) — expected 2; found: cut-out 6-gon"));
    }

    #[test]
    fn outlines_are_checked_as_rectangles_or_circles_and_say_when_they_are_neither() {
        let cube = mesh(cuboid([0.0; 3], [20.0, 10.0, 2.0], false));
        let cut = |outer: Value| json!({"sections": [{"axis": "z", "at": 1, "outer": outer}]});
        assert_eq!(
            only(
                &check(&cube, cut(json!({"size": [20, 10]}))),
                "outer rectangle 20×10"
            )["detail"],
            "found 20×10 centered (10, 5)"
        );
        let shifted = check(&cube, cut(json!({"size": [20, 10], "center": [0, 0]})));
        assert_eq!(only(&shifted, "outer rectangle")["pass"], false);
        let round = check(&cube, cut(json!({"d": 20})));
        assert_eq!(
            only(&round, "outer circle d20")["detail"],
            "outer loop is not circular (bbox 20×10)"
        );
        let rod = mesh(cylinder([5.0, 5.0], 10.0, 20.0, 64));
        let rod_cut = |outer: Value| json!({"sections": [{"axis": "z", "at": 10, "outer": outer}]});
        assert_eq!(
            only(
                &check(&rod, rod_cut(json!({"d": 10, "center": [5, 5]}))),
                "outer circle"
            )["pass"],
            true
        );
        assert_eq!(
            only(
                &check(&rod, rod_cut(json!({"size": [10, 10]}))),
                "outer rectangle"
            )["detail"],
            "outer loop is not rectangular (bbox 10×10)"
        );
        let nothing = check(
            &rod,
            json!({"sections": [{"axis": "z", "at": 30, "outer": {"d": 10}}]}),
        );
        assert_eq!(
            only(&nothing, "outer profile")["detail"],
            "no material in this plane"
        );
        let area = check(
            &cube,
            json!({"sections": [{"axis": "z", "at": 1, "materialArea": {"value": 150}}]}),
        );
        assert_eq!(
            only(&area, "material area")["detail"],
            "200 mm² — expected 150 ±1.5%"
        );
    }

    #[test]
    fn a_section_that_asserts_nothing_cannot_pass() {
        let lines = check(&plate(), json!({"sections": [{"axis": "z", "at": 2}]}));
        let empty = only(&lines, "assertions");
        assert_eq!(empty["pass"], false);
        assert!(empty["detail"]
            .as_str()
            .unwrap()
            .contains("asserts nothing"));
        let listed = check(
            &plate(),
            json!({"sections": [{"axis": "z", "at": 2, "holes": []}]}),
        );
        assert_eq!(only(&listed, "assertions")["pass"], false);
        let zero = check(
            &plate(),
            json!({"sections": [{"axis": "z", "at": 2, "holeCount": 1}]}),
        );
        assert!(zero.iter().all(|item| item["pass"] == true));
    }

    #[test]
    fn an_open_section_tells_the_caller_to_move_the_plane() {
        let mut open = cuboid([0.0; 3], [10.0; 3], false);
        open.truncate(10);
        let lines = check(
            &mesh(open),
            json!({"watertight": false, "sections": [{"axis": "z", "at": 5, "outerCount": 1}]}),
        );
        assert!(only(&lines, "closed")["detail"]
            .as_str()
            .unwrap()
            .contains("move `at` into the feature"));
    }

    #[test]
    fn a_cut_through_hole_vertices_measures_the_whole_outline() {
        // x = 20 and y = 15 run through the hole's axis and two of its
        // vertices, so at the corners of the material the cut meets the hole
        // wall twice, a hair apart. Checker v2 dropped both points of such a
        // corner and measured half the material.
        let part = mesh(plate_with_hole([40.0, 30.0, 6.0], [20.0, 15.0], 8.0, 16));
        let lines = check(
            &part,
            json!({"sections": [
                {"axis": "x", "at": 20, "outerCount": 2, "holeCount": 0,
                    "materialArea": {"value": 132, "tolPct": 0.1}},
                {"axis": "y", "at": 15, "outerCount": 2, "holeCount": 0,
                    "materialArea": {"value": 192, "tolPct": 0.1}}]}),
        );
        assert_eq!(lines.len(), 7, "{lines:?}");
        assert!(lines.iter().all(|item| item["pass"] == true), "{lines:?}");
    }

    #[test]
    fn interpenetrating_bodies_fail_the_self_intersection_limit() {
        let pierced = merged(&[
            cuboid([0.0; 3], [10.0; 3], false),
            cuboid([5.0; 3], [15.0; 3], false),
        ]);
        let lines = check(
            &pierced,
            json!({"maxSelfIntersections": 0, "watertight": false}),
        );
        assert_eq!(only(&lines, "self-intersections")["pass"], false);
        let clean = check(&plate(), json!({"maxSelfIntersections": 0}));
        assert_eq!(
            only(&clean, "self-intersections")["detail"],
            "0 intersecting triangle pair(s) — allowed 0"
        );
    }

    #[test]
    fn too_many_assertions_is_a_structured_work_limit() {
        let probes = (0..513).map(|i| json!([i, 0, 0])).collect::<Vec<_>>();
        let error = run(&plate(), &json!({"solid": probes}), Context::default())
            .err()
            .unwrap();
        assert!(mesh::is_work_limit(&error));
    }

    #[test]
    fn preservation_passes_inside_declared_regions_and_fails_elsewhere() {
        let original = mesh(cuboid([0.0; 3], [60.0, 40.0, 4.0], false));
        let same = mesh(cuboid([0.0; 3], [60.0, 40.0, 4.0], false));
        let region = [json!({"center": [5, 5, 2], "radius": 4})];
        assert_eq!(
            preservation(&original, &same, &region).unwrap()["pass"],
            true
        );
        let grown = mesh(cuboid([0.0; 3], [60.0, 40.0, 8.0], false));
        let changed = preservation(&original, &grown, &region).unwrap();
        assert_eq!(changed["pass"], false);
        assert!(changed["detail"].as_str().unwrap().contains("differ: ("));
        let drilled = mesh(plate_with_hole([60.0, 40.0, 4.0], [5.0, 5.0], 4.0, 32));
        assert_eq!(
            preservation(&original, &drilled, &region).unwrap()["pass"],
            true
        );
        let wide = mesh(plate_with_hole([60.0, 40.0, 4.0], [30.0, 20.0], 30.0, 32));
        assert_eq!(
            preservation(&original, &wide, &region).unwrap()["pass"],
            false
        );
    }

    #[test]
    fn a_pass_bought_with_a_looser_tolerance_is_flagged() {
        assert_eq!(
            loosened(
                &[json!({"name": "bounding box", "pass": false, "tightness": 10})],
                &[json!({"name": "bounding box", "pass": true, "tightness": 0.2})]
            ),
            vec!["bounding box"]
        );
        assert!(loosened(
            &[json!({"name": "volume", "pass": false, "tightness": 1.0 / 1.5})],
            &[json!({"name": "volume", "pass": true, "tightness": 1.0 / 1.5})]
        )
        .is_empty());
        assert!(loosened(
            &[json!({"name": "bounding box", "pass": true, "tightness": 10})],
            &[json!({"name": "bounding box", "pass": true, "tightness": 0.2})]
        )
        .is_empty());
    }
}
