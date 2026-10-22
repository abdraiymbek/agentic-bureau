//! What a part measures as, in words: the geometry report that follows a
//! render, the notes that point at likely mistakes, and the brief form of
//! every CAD result for callers with little context to spend.
use super::*;

/// Above this size the optional self-intersection diagnostic is left to an
/// explicit `maxSelfIntersections` assertion.
const DIAGNOSTIC_TRIANGLES: usize = 150_000;
const WALL_SAMPLES: usize = 80;
const THIN_WALL_MM: f64 = 0.4;
const BRIEF_LOOPS: usize = 8;

pub(crate) struct Details {
    pub geometry: Value,
    pub sections: Vec<Value>,
    pub probes: Vec<Value>,
    pub notes: Vec<String>,
    /// Analyses this report did not run, each with the reason.
    pub not_evaluated: Vec<String>,
}

fn axis_index(axis: &str) -> CoreResult<usize> {
    match axis {
        "x" => Ok(0),
        "y" => Ok(1),
        "z" => Ok(2),
        _ => Err(ContractError::validation("Unknown section axis")),
    }
}

fn point(values: &Value, what: &str) -> CoreResult<[f64; 3]> {
    let values = values
        .as_array()
        .filter(|values| values.len() == 3)
        .ok_or_else(|| ContractError::validation(format!("{what} needs three coordinates")))?;
    Ok([0, 1, 2].map(|i| values[i].as_f64().unwrap_or(f64::NAN)))
}

/// Mid-planes on every axis, plus cuts near both ends of z: features that
/// stop short of a face show up near the ends, not in the middle.
fn automatic_planes(mesh: &mesh::Mesh) -> Vec<(usize, f64, &'static str)> {
    let size = mesh.size();
    let mut planes = Vec::new();
    for axis in [2, 1, 0] {
        if size[axis] > 0.0 {
            // Slightly off the exact middle so a mid-height face never becomes the plane.
            planes.push((axis, mesh.bounds_min[axis] + size[axis] * 0.5 + 1e-3, "mid"));
        }
    }
    if size[2] > 0.0 {
        planes.push((2, mesh.bounds_min[2] + size[2] * 0.1 + 1e-3, "near bottom"));
        planes.push((2, mesh.bounds_min[2] + size[2] * 0.9 + 1e-3, "near top"));
    }
    planes
}

/// Measure a mesh for a report: summary, automatic and requested sections,
/// probe points and the notes a careful reviewer would add.
pub(crate) fn details(
    mesh: &mesh::Mesh,
    has_parameters: bool,
    requested_sections: &[Value],
    requested_probes: &[Value],
    cancelled: &dyn Fn() -> bool,
) -> CoreResult<Details> {
    let requested = requested_sections.len() + requested_probes.len();
    if requested > mesh::MAX_ASSERTIONS {
        return Err(mesh::work_limit(
            "CAD inspection probes and sections",
            requested,
            mesh::MAX_ASSERTIONS,
        ));
    }
    let stop = || {
        if cancelled() {
            Err(ContractError::new("CANCELLED", "Analysis was cancelled"))
        } else {
            Ok(())
        }
    };
    let mut notes = Vec::new();
    let mut not_evaluated = Vec::new();
    if mesh.shells > 1 {
        notes.push(format!("{} disconnected bodies — if this should be one part, make the features overlap (a shared face or edge is not enough; overlap by a small amount).", mesh.shells));
    }
    if !mesh.watertight {
        notes.push(format!(
            "Mesh is not closed ({} boundary edges, {} non-manifold edges).",
            mesh.boundary_edges, mesh.non_manifold_edges
        ));
    }
    if mesh.inverted {
        notes.push("Mesh is inside-out (negative signed volume). With polyhedron(), list each face's vertices clockwise when viewed from outside the solid; booleans on an inside-out body cut the wrong side. An open mesh is diagnosed, not flipped.".to_owned());
    }
    let mut sections = Vec::new();
    let mut coarse = None;
    for (axis, at, label) in automatic_planes(mesh) {
        let cut = section::Section::from_mesh(mesh, axis, at);
        if label == "mid" && coarse.is_none() {
            coarse = cut
                .loops
                .iter()
                .find(|item| {
                    item.points.len() <= 24
                        && item
                            .circle
                            .as_ref()
                            .is_some_and(|circle| circle.roundness < expect::MIN_ROUNDNESS)
                })
                .map(|item| item.points.len());
        }
        sections.push(cut.report(Some(label)));
    }
    stop()?;
    for request in requested_sections {
        if let (Some(axis), Some(at)) = (request["axis"].as_str(), request["at"].as_f64()) {
            sections.push(section::Section::from_mesh(mesh, axis_index(axis)?, at).report(None));
        } else if request["origin"].is_array() && request["normal"].is_array() {
            let origin = point(&request["origin"], "Section origin")?;
            let normal = point(&request["normal"], "Section normal")?;
            sections.push(
                section::Section::from_plane(mesh, origin, normal)?.report_plane(origin, normal),
            );
        } else {
            return Err(ContractError::validation(
                "Section needs axis and at, or origin and normal",
            )
            .with_repair("Send {\"axis\": \"z\", \"at\": 2.5} for an axis-aligned cut, or {\"origin\": [x, y, z], \"normal\": [x, y, z]} for an oblique one."));
        }
    }
    let mut probes = Vec::new();
    for probe in requested_probes {
        let xyz = point(probe, "Probe")?;
        probes.push(
            json!({"point": probe, "result": if mesh.contains(xyz) { "solid" } else { "empty" }}),
        );
    }
    stop()?;
    if mesh.triangles.len() > DIAGNOSTIC_TRIANGLES {
        not_evaluated.push(format!(
            "self-intersections: not counted above {DIAGNOSTIC_TRIANGLES} triangles in a report (this mesh has {}); assert maxSelfIntersections in cad_check to count them",
            mesh.triangles.len()
        ));
    } else {
        match mesh.count_intersections() {
            Ok(0) => {}
            Ok(crossings) => notes.push(format!("{crossings} self-intersecting triangle pair(s) — overlapping bodies or piercing faces can still satisfy size and volume. Separate the solids or union them; assert maxSelfIntersections: 0 in cad_check to fail on this.")),
            Err(error) if mesh::is_work_limit(&error) => {
                not_evaluated.push(format!("self-intersections: {}", error.message))
            }
            Err(error) => return Err(error),
        }
    }
    stop()?;
    if let Some(wall) = mesh
        .min_wall_thickness(WALL_SAMPLES)
        .filter(|wall| *wall < THIN_WALL_MM)
    {
        notes.push(format!("Minimum sampled wall thickness is {} mm — a thin skin often means a cutter ended on a face instead of passing through it.", checks::fmt(wall)));
    }
    if let Some(sides) = coarse {
        notes.push(format!("A circular feature renders as a {sides}-sided polygon (coarse faceting). Unless a polygon was intended, set $fn (for example $fn = 64;) so holes and cylinders are round."));
    }
    if !has_parameters {
        notes.push("No top-level parameters found. Exposing key dimensions as `name = value;` at file scope makes the part re-sizable.".to_owned());
    }
    if !not_evaluated.is_empty() {
        notes.push(format!(
            "Not evaluated in this report: {}. This is an optional diagnostic and does not block verification.",
            not_evaluated.join("; ")
        ));
    }
    Ok(Details {
        geometry: mesh.summary(),
        sections,
        probes,
        notes,
        not_evaluated,
    })
}

/// Sections with each distinct outline once. A prismatic part cuts the same
/// near its bottom, middle and top; the digest says so instead of repeating it.
fn features(sections: &Value) -> Vec<Value> {
    let mut out = Vec::<(String, Vec<String>, Value)>::new();
    for item in sections.as_array().into_iter().flatten() {
        let plane = item["plane"].as_str().unwrap_or("");
        let axis = plane.split('=').next().unwrap_or("").to_owned();
        match out
            .iter_mut()
            .find(|(seen_axis, _, loops)| *seen_axis == axis && *loops == item["loops"])
        {
            Some((_, planes, _)) => planes.push(plane.to_owned()),
            None => out.push((axis, vec![plane.to_owned()], item["loops"].clone())),
        }
    }
    out.into_iter()
        .map(|(_, planes, loops)| {
            let mut loops = loops.as_array().cloned().unwrap_or_default();
            if loops.len() > BRIEF_LOOPS {
                let more = loops.len() - BRIEF_LOOPS;
                loops.truncate(BRIEF_LOOPS);
                loops.push(json!(format!("…and {more} more")));
            }
            let plane = if planes.len() > 1 {
                format!("{} (same at {})", planes[0], planes[1..].join(", "))
            } else {
                planes[0].clone()
            };
            json!({"plane": plane, "loops": loops})
        })
        .collect()
}

fn brief_render(render: &Value) -> Value {
    if render["ok"] == true {
        let mut out = json!({"ok": true});
        if render["cached"] == true {
            out["cached"] = json!(true);
        }
        let warnings = render["warnings"].as_array().map(Vec::len).unwrap_or(0);
        if warnings > 0 {
            out["warnings"] = json!(warnings);
            out["hints"] = render["hints"].clone();
        }
        return out;
    }
    let first = |key: &str, count: usize| {
        render[key]
            .as_array()
            .map(|items| items.iter().take(count).cloned().collect::<Vec<_>>())
            .unwrap_or_default()
    };
    json!({"ok": false, "errors": first("errors", 4), "hints": first("hints", 3)})
}

fn measured(full: &Value, out: &mut Value) {
    let geometry = &full["geometry"];
    if geometry.is_object() {
        out["size"] = geometry["bounds"]["size"].clone();
        out["min"] = geometry["bounds"]["min"].clone();
        out["volume"] = geometry["volume"].clone();
        out["bodies"] = geometry["shells"].clone();
        out["watertight"] = geometry["watertight"].clone();
        out["features"] = json!(features(&full["sections"]));
    }
}

fn copy_present(full: &Value, out: &mut Value, keys: &[&str]) {
    for key in keys {
        let value = &full[*key];
        if !value.is_null() && !value.as_array().is_some_and(Vec::is_empty) {
            out[*key] = value.clone();
        }
    }
}

/// Spec items in brief: how many pass, and the words of those that fail,
/// have no assertion or no check shows, each list cut at ten with its count.
fn brief_spec(spec: &Value) -> Value {
    let counts = &spec["counts"];
    let mut out = json!({"items": counts["items"], "passed": counts["passed"]});
    let rows = spec["items"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    for (state, key, count) in [
        ("failed", "failed", "failed"),
        ("unasserted", "unasserted", "unasserted"),
        ("not_shown", "notShown", "notShown"),
    ] {
        let named = rows
            .iter()
            .filter(|row| row["state"] == state)
            .map(|row| match row["statement"] == true {
                true => json!(format!(
                    "requirement \"{}\"",
                    row["item"].as_str().unwrap_or("")
                )),
                false => row["item"].clone(),
            })
            .collect::<Vec<_>>();
        if named.is_empty() {
            continue;
        }
        if named.len() > LISTED_ITEMS {
            out[format!("{key}Count")] = counts[count].clone();
        }
        out[key] = json!(named.into_iter().take(LISTED_ITEMS).collect::<Vec<_>>());
    }
    out
}

/// Entries a brief list of spec items carries.
const LISTED_ITEMS: usize = 10;

/// The brief form of a CAD result: identifiers, the outcome, what failed and
/// the next step. It is a projection of the full result; nothing in it is
/// computed differently, and the evidence it points at is the same.
///
/// `op` is the operation name (`cad.check`) or its tool name (`cad_check`).
pub fn brief(op: &str, full: &Value) -> Value {
    let mut out = json!({"artifactId": full["artifactId"], "revisionId": full["revisionId"]});
    match op.replace('_', ".").as_str() {
        "cad.check" => {
            for key in [
                "ready",
                "verificationStatus",
                "committed",
                "passed",
                "total",
            ] {
                out[key] = full[key].clone();
            }
            out["failed"] = json!(full["checks"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|line| line["pass"] != true)
                .map(|line| json!({"name": line["name"], "detail": line["detail"]}))
                .collect::<Vec<_>>());
            out["scopeChanges"] = full["scopeChanges"].clone();
            copy_present(
                full,
                &mut out,
                &[
                    "droppedFailingAssertions",
                    "loosenedAssertions",
                    "committedExpect",
                    "staleInputs",
                    "notEvaluated",
                    "ignored",
                    "derivedSpec",
                    "notes",
                ],
            );
            if full["spec"].is_object() {
                out["spec"] = brief_spec(&full["spec"]);
            } else if full["expectChanged"] == true {
                // With items the echo would about double the reply, and the
                // caller has just sent them.
                out["normalizedExpect"] = full["normalizedExpect"].clone();
            }
            out["evidenceHash"] = full["evidenceHash"].clone();
        }
        "cad.inspect" => {
            out["render"] = brief_render(&full["render"]);
            measured(full, &mut out);
            copy_present(full, &mut out, &["probes", "notes"]);
        }
        _ => {
            out["render"] = brief_render(&full["render"]);
            measured(full, &mut out);
            copy_present(full, &mut out, &["notes"]);
        }
    }
    copy_present(full, &mut out, &["warnings"]);
    out["nextAction"] = full["nextAction"].clone();
    out["next"] = full["nextStep"].clone();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cad::mesh::fixtures::{cuboid, merged, mesh, plate_with_hole};

    fn measure(mesh: &mesh::Mesh, has_parameters: bool) -> Details {
        details(mesh, has_parameters, &[], &[], &|| false).unwrap()
    }

    #[test]
    fn a_clean_parametric_part_has_five_sections_and_no_notes() {
        let plate = mesh(plate_with_hole([40.0, 30.0, 4.0], [10.0, 12.0], 3.2, 64));
        let report = measure(&plate, true);
        assert!(report.notes.is_empty(), "{:?}", report.notes);
        assert_eq!(report.sections.len(), 5);
        assert_eq!(report.sections[0]["plane"], "z=2.001 (mid)");
        assert_eq!(
            report.sections[0]["loops"],
            json!([
                "material rectangle 40×30 centered (x=20, y=15)",
                "cut-out circle d=3.2 at (x=10, y=12)"
            ])
        );
        assert_eq!(report.geometry["bounds"]["size"], json!([40.0, 30.0, 4.0]));
        assert_eq!(report.geometry["shells"], 1);
    }

    #[test]
    fn notes_point_at_the_usual_mistakes() {
        let two = merged(&[
            cuboid([0.0; 3], [5.0; 3], false),
            cuboid([20.0, 0.0, 0.0], [25.0, 5.0, 5.0], false),
        ]);
        let notes = measure(&two, false).notes;
        assert!(notes[0].starts_with("2 disconnected bodies"));
        assert!(notes
            .last()
            .unwrap()
            .starts_with("No top-level parameters found"));
        let pierced = merged(&[
            cuboid([0.0; 3], [10.0; 3], false),
            cuboid([5.0; 3], [15.0; 3], false),
        ]);
        assert!(measure(&pierced, true)
            .notes
            .iter()
            .any(|note| note.contains("self-intersecting triangle pair(s)")));
        let mut open = cuboid([0.0; 3], [10.0; 3], false);
        open.truncate(10);
        assert!(measure(&mesh(open), true)
            .notes
            .iter()
            .any(|note| note.starts_with("Mesh is not closed (4 boundary edges")));
        let skin = merged(&[
            cuboid([0.0; 3], [20.0; 3], false),
            cuboid([0.2; 3], [19.8; 3], true),
        ]);
        assert!(measure(&skin, true)
            .notes
            .iter()
            .any(|note| note.starts_with("Minimum sampled wall thickness is 0.2 mm")));
        let coarse = mesh(plate_with_hole([20.0, 20.0, 5.0], [10.0, 10.0], 2.5, 8));
        assert!(measure(&coarse, true)
            .notes
            .iter()
            .any(|note| note.starts_with("A circular feature renders as a 8-sided polygon")));
    }

    #[test]
    fn requested_sections_and_probes_are_measured_and_bad_requests_explained() {
        let plate = mesh(plate_with_hole([40.0, 30.0, 4.0], [10.0, 12.0], 3.2, 64));
        let report = details(
            &plate,
            true,
            &[
                json!({"axis": "y", "at": 12}),
                json!({"origin": [10, 12, 2], "normal": [0, 0, 1]}),
            ],
            &[json!([10, 12, 2]), json!([30, 20, 2])],
            &|| false,
        )
        .unwrap();
        assert_eq!(report.sections.len(), 7);
        assert_eq!(report.sections[5]["plane"], "y=12");
        assert!(report.sections[6]["plane"]
            .as_str()
            .unwrap()
            .starts_with("origin=(10, 12, 2)"));
        assert_eq!(report.probes[0]["result"], "empty");
        assert_eq!(report.probes[1]["result"], "solid");
        let error = details(&plate, true, &[json!({"axis": "z"})], &[], &|| false)
            .err()
            .unwrap();
        assert!(error.repair.unwrap().contains("origin"));
        assert_eq!(
            details(&plate, true, &[], &[], &|| true)
                .err()
                .unwrap()
                .code,
            "CANCELLED"
        );
    }

    #[test]
    fn the_feature_digest_states_each_outline_once() {
        let plate = mesh(plate_with_hole([40.0, 30.0, 4.0], [10.0, 12.0], 3.2, 64));
        let report = measure(&plate, true);
        let digest = features(&json!(report.sections));
        assert_eq!(digest.len(), 3, "{digest:?}");
        assert_eq!(
            digest[0]["plane"],
            "z=2.001 (mid) (same at z=0.401 (near bottom), z=3.601 (near top))"
        );
        assert_eq!(digest[0]["loops"].as_array().unwrap().len(), 2);
        let many = json!([{"plane": "z=1", "loops": (0..12).map(|i| format!("loop {i}")).collect::<Vec<_>>()}]);
        let capped = features(&many);
        assert_eq!(capped[0]["loops"].as_array().unwrap().len(), 9);
        assert_eq!(capped[0]["loops"][8], "…and 4 more");
    }

    #[test]
    fn a_brief_write_report_keeps_the_outcome_and_drops_the_rest() {
        let plate = mesh(plate_with_hole([40.0, 30.0, 4.0], [10.0, 12.0], 3.2, 64));
        let report = measure(&plate, true);
        let full = json!({
            "artifactId": "a1", "revisionId": "r1", "title": "Plate", "sourcePath": "artifacts/mechanical/plate.scad",
            "render": {"ok": true, "tool": "openscad 2026.09.18", "ms": 110, "warnings": [], "errors": []},
            "parameters": [{"name": "w", "value": 40, "derived": false}],
            "geometry": report.geometry, "sections": report.sections, "probes": [], "notes": [],
            "nextAction": "commit_assertions",
            "nextStep": {"tool": "cad_check", "why": "Measurements are not verification.", "args": {"artifactId": "a1"}},
            "next": "Compare these measurements with the request.",
        });
        let brief = brief("cad_write_source", &full);
        assert_eq!(
            brief.as_object().unwrap().keys().collect::<Vec<_>>(),
            vec![
                "artifactId",
                "revisionId",
                "render",
                "size",
                "min",
                "volume",
                "bodies",
                "watertight",
                "features",
                "nextAction",
                "next"
            ]
        );
        assert_eq!(brief["render"], json!({"ok": true}));
        assert_eq!(brief["size"], json!([40.0, 30.0, 4.0]));
        assert_eq!(brief["next"]["tool"], "cad_check");
        assert!(brief.to_string().len() < full.to_string().len());
        let failed = json!({
            "artifactId": "a1", "revisionId": "r2",
            "render": {"ok": false, "tool": "openscad", "ms": 9, "warnings": [],
                "errors": ["e1", "e2", "e3", "e4", "e5"], "hints": ["h1"]},
            "notes": ["Render failed — fix the source and call cad_write_source again."],
            "nextAction": "repair_geometry", "nextStep": {"tool": "cad_write_source", "why": "Fix the source."},
        });
        let brief = super::brief("cad.write_source", &failed);
        assert_eq!(brief["render"]["errors"].as_array().unwrap().len(), 4);
        assert_eq!(brief["render"]["hints"], json!(["h1"]));
        assert!(brief.get("size").is_none());
        assert_eq!(brief["notes"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_brief_check_result_keeps_failures_scope_and_the_evidence_hash() {
        let full = json!({
            "artifactId": "a1", "revisionId": "r1", "pass": false, "passed": 2, "total": 3,
            "ready": false, "verificationStatus": "failed", "committed": false,
            "evidenceHash": "abc", "specHash": "def", "scopeChanges": [],
            "checks": [
                {"name": "overall size", "pass": true, "detail": "40×30×4 mm", "tightness": 10.0},
                {"name": "watertight", "pass": true, "detail": "boundary edges 0"},
                {"name": "section z=2: hole d3.2 at (x=5, y=5)", "pass": false, "detail": "found d=3 — DIAMETER off by -0.2", "tightness": 10.0},
            ],
            "droppedFailingAssertions": [], "exploratory": true,
            "work": {"artifactId": "a1", "candidateRevisionId": "r1", "specHash": null, "nextAction": "repair_geometry"},
            "nextAction": "repair_geometry",
            "nextStep": {"tool": "cad_write_source", "why": "Fix the failing geometry.", "args": {"artifactId": "a1"}},
            "next": "Trial failed: 1 of 3 assertions.",
            "normalizedExpect": {"size": [40, 30, 4]}, "expectChanged": false, "ignored": [],
        });
        let brief = brief("cad.check", &full);
        assert_eq!(
            brief,
            json!({
                "artifactId": "a1", "revisionId": "r1", "ready": false, "verificationStatus": "failed",
                "committed": false, "passed": 2, "total": 3,
                "failed": [{"name": "section z=2: hole d3.2 at (x=5, y=5)", "detail": "found d=3 — DIAMETER off by -0.2"}],
                "scopeChanges": [], "evidenceHash": "abc", "nextAction": "repair_geometry",
                "next": {"tool": "cad_write_source", "why": "Fix the failing geometry.", "args": {"artifactId": "a1"}},
            })
        );
        let mut expanded = full.clone();
        expanded["expectChanged"] = json!(true);
        expanded["ignored"] = json!(["expect.tol: unused"]);
        let brief = super::brief("cad.check", &expanded);
        assert_eq!(brief["normalizedExpect"], json!({"size": [40, 30, 4]}));
        assert_eq!(brief["ignored"], json!(["expect.tol: unused"]));
    }
}
