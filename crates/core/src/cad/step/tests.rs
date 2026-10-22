//! STEP export: the probes the render gives, the comparison with an exact
//! solid, the converter run, revisions and destinations, and (opt-in) the
//! real converter on a plate and on a corpus of recorded parts.
use super::*;
use crate::cad::mesh::fixtures::*;
use crate::cad::testing::*;
use std::sync::Mutex;

/* ------------------------------------------------------------------ */
/* The render's probes and the comparison (no engine)                  */
/* ------------------------------------------------------------------ */

/// The answer a converter would give for a solid that is the render.
fn agreeing_answer(mesh: &mesh::Mesh, sampling: &Sampling) -> Value {
    answer_from(mesh, mesh, sampling)
}

/// The answer a converter would give for the solid `exact`, read back, when
/// the render is `render`: its own volume and box, the points classified by
/// it, and pairs at its own faces placed as the core places them on a render.
fn answer_from(exact: &mesh::Mesh, render: &mesh::Mesh, sampling: &Sampling) -> Value {
    let _ = render;
    let inside = sampling
        .points
        .iter()
        .map(|point| if exact.contains(*point) { '1' } else { '0' })
        .collect::<String>();
    let own = super::sampling(exact, 0.0);
    let probes = (0..own.pairs())
        .map(|pair| {
            let (inner, outer) = (
                own.points[own.volume + 2 * pair],
                own.points[own.volume + 2 * pair + 1],
            );
            json!([
                inner[0],
                inner[1],
                inner[2],
                outer[0],
                outer[1],
                outer[2],
                own.patches[pair]
            ])
        })
        .collect::<Vec<_>>();
    json!({"protocol": 1, "ok": true, "ocp": "7.9.3.1", "python": "3.12.14",
        "volume": exact.volume, "bboxMin": exact.bounds_min, "bboxMax": exact.bounds_max,
        "solids": bodies(exact), "faces": 10, "valid": true, "openShells": 0, "freeEdges": 0,
        "unmeshedFaces": 0, "inside": inside, "solidProbes": probes,
        "solidFaces": own.patch_count, "solidUnprobed": own.unprobed.len(), "bytes": 100,
        "approximations": [], "interpretations": []})
}

#[test]
fn samples_are_deterministic_and_classified_by_the_mesh() {
    let plate = mesh(plate_with_hole([40.0, 30.0, 4.0], [20.0, 15.0], 8.0, 64));
    let first = sampling(&plate, 0.0);
    let again = sampling(&plate, 0.0);
    assert_eq!(first.points, again.points);
    assert_eq!(first.patches, again.patches);
    assert_eq!(first.volume, VOLUME_SAMPLES);
    for (point, inside) in first.points.iter().zip(&first.render) {
        assert_eq!(plate.contains(*point), *inside);
    }
    // The box points reach a little beyond the part on every side.
    let low = first.points[..first.volume]
        .iter()
        .fold([f64::INFINITY; 3], |low, p| {
            std::array::from_fn(|a| low[a].min(p[a]))
        });
    assert!(low.iter().all(|value| *value < 0.0), "{low:?}");
    // Each pair is inside then outside the render.
    for pair in 0..first.pairs() {
        let at = first.volume + 2 * pair;
        assert!(first.render[at] && !first.render[at + 1]);
    }
}

#[test]
fn every_surface_of_the_render_is_probed_beyond_its_facets() {
    // A 100 mm plate with one ⌀3 hole: the hole wall is 0.2 % of the area.
    let plate = mesh(plate_with_hole([100.0, 100.0, 5.0], [50.0, 50.0], 3.0, 64));
    let sampling = sampling(&plate, 0.0);
    // Top, bottom, four sides and the hole wall (one smooth patch of 64 facets).
    let patches = sampling
        .patches
        .iter()
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(patches.len(), 7, "{patches:?}");
    let on_wall = (0..sampling.pairs())
        .filter(|pair| {
            let inner = sampling.points[sampling.volume + 2 * pair];
            ((inner[0] - 50.0).powi(2) + (inner[1] - 50.0).powi(2)).sqrt() < 2.0
        })
        .count();
    assert!(
        on_wall >= PAIRS_PER_PATCH,
        "{on_wall} pairs on the hole wall"
    );
    // Probes sit at least 0.001 mm or 1e-5 of the part's size from the faces ...
    let floor = 1e-5 * (2.0f64 * 100.0 * 100.0 + 25.0).sqrt();
    assert_eq!(sampling.offsets, [floor]);
    assert!(sampling.unprobed.is_empty());
    // ... and first three times as far as a facet can lie from the exact surface, then
    // halves of that down to the smallest.
    let offsets = super::sampling(&plate, 0.02).offsets;
    assert_eq!(offsets[0], 0.06);
    assert_eq!(offsets[1], 0.03);
    assert_eq!(*offsets.last().unwrap(), floor);
    assert!(offsets.windows(2).all(|pair| pair[1] < pair[0]));
}

#[test]
fn a_pair_that_crosses_a_small_hole_is_tried_closer_to_its_wall() {
    // A ⌀2 hole in a part whose coarsest curve lies 1.2 mm off its facets: the first
    // offset, 3.6 mm, crosses the hole.
    let plate = mesh(plate_with_hole([100.0, 100.0, 5.0], [50.0, 50.0], 2.0, 64));
    let sampling = sampling(&plate, 1.2);
    assert!((sampling.offsets[0] - 3.6).abs() < 1e-12);
    assert!(sampling.unprobed.is_empty(), "{:?}", sampling.unprobed);
    let on_wall = (0..sampling.pairs())
        .filter(|pair| {
            let inner = sampling.points[sampling.volume + 2 * pair];
            ((inner[0] - 50.0).powi(2) + (inner[1] - 50.0).powi(2)).sqrt() < 3.0
        })
        .count();
    assert!(on_wall >= PAIRS_PER_PATCH, "{on_wall} pairs at the hole");
    // Its pairs, with their guards, fit inside the hole only nearer the wall than the
    // facets' reach, 1.8 mm: they count when they agree ...
    let smallest = sampling
        .pair_offsets
        .iter()
        .copied()
        .fold(f64::INFINITY, f64::min);
    assert!(smallest < sampling.trusted, "{smallest}");
    assert!(accept(&agreeing_answer(&plate, &sampling), &plate, &sampling).is_ok());
    // ... and a solid that lost the hole leaves its wall with none that count.
    let solid = mesh(cuboid([0.0; 3], [100.0, 100.0, 5.0], false));
    let failure = accept(&answer_from(&solid, &plate, &sampling), &plate, &sampling)
        .err()
        .unwrap();
    assert!(
        failure.contains("the only probe pairs that fit lie nearer the faces"),
        "{failure}"
    );
}

#[test]
fn a_surface_no_probe_reaches_is_reported_and_never_vouched_for() {
    // A fin 0.0005 mm thick on a block: no pair is inside then outside at its faces.
    let render = mesh(
        [
            cuboid([0.0; 3], [20.0, 20.0, 5.0], false),
            cuboid([30.0, 0.0, 0.0], [40.0, 10.0, 0.0005], false),
        ]
        .concat(),
    );
    let sampling = sampling(&render, 0.0);
    assert!(!sampling.unprobed.is_empty());
    let reason = sampling.unprobed_reason().unwrap();
    assert!(
        reason.ends_with("surfaces could not be probed, even 0.001 mm from their faces, so a feature lost there would go unseen"),
        "{reason}"
    );
    // An answer that agrees everywhere it can be compared is still refused.
    let failure = accept(&agreeing_answer(&render, &sampling), &render, &sampling)
        .err()
        .unwrap();
    assert_eq!(failure, reason);
}

#[test]
fn a_small_hole_beside_a_scaled_cube_is_probed_with_the_real_bound() {
    // OpenSCAD writes scale([100, 100, 5]) cube(1) as a multmatrix around a unit cube. The
    // plate has a ⌀2 hole, and a ⌀20 boss stands beside it.
    let csg = "difference() {\n\tmultmatrix([[100, 0, 0, 0], [0, 100, 0, 0], [0, 0, 5, 0], [0, 0, 0, 1]]) {\n\t\tcube(size = [1, 1, 1], center = false);\n\t}\n\tmultmatrix([[1, 0, 0, 50], [0, 1, 0, 50], [0, 0, 1, -1], [0, 0, 0, 1]]) {\n\t\tcylinder($fn = 64, $fa = 12, $fs = 2, h = 7, r1 = 1, r2 = 1, center = false);\n\t}\n}\nmultmatrix([[1, 0, 0, 130], [0, 1, 0, 50], [0, 0, 1, 0], [0, 0, 0, 1]]) {\n\tcylinder($fn = 64, $fa = 12, $fs = 2, h = 5, r1 = 10, r2 = 10, center = false);\n}\n";
    let boss = || {
        cylinder([0.0, 0.0], 20.0, 5.0, 64)
            .into_iter()
            .map(|t| t.map(|p| [p[0] + 130.0, p[1] + 50.0, p[2]]))
            .collect::<Vec<_>>()
    };
    let render = mesh(
        [
            plate_with_hole([100.0, 100.0, 5.0], [50.0, 50.0], 2.0, 64),
            boss(),
        ]
        .concat(),
    );
    let bound = csg_sagitta(csg, &render);
    assert!((bound - 10.0 * (1.0 - (std::f64::consts::PI / 64.0).cos())).abs() < 1e-9);
    let sampling = sampling(&render, bound);
    assert!(sampling.offsets[0] < 0.05, "{:?}", sampling.offsets);
    // The exact solid lost the hole: volume, box and points cannot tell, the probes can.
    let solid = mesh([cuboid([0.0; 3], [100.0, 100.0, 5.0], false), boss()].concat());
    assert!((solid.volume - render.volume) / render.volume < 0.001);
    let failure = accept(&answer_from(&solid, &render, &sampling), &render, &sampling)
        .err()
        .unwrap();
    assert!(
        failure.contains("probe pairs at the render's faces classify differently"),
        "{failure}"
    );
}

#[test]
fn material_the_render_does_not_have_is_found_at_the_solid_faces() {
    // The render is a plate and a tall post; the exact solid also has a ⌀3 × 2 boss, as a
    // converter that read an empty intersection() as its other operand would. (Apart, so
    // that no faces of the stand-in meshes coincide.)
    let post = cuboid([80.0, 80.0, 6.0], [90.0, 90.0, 25.0], false);
    let boss = cylinder([30.0, 30.0], 3.0, 2.0, 32)
        .into_iter()
        .map(|t| t.map(|p| [p[0], p[1], p[2] + 6.0]))
        .collect::<Vec<_>>();
    let plate = cuboid([0.0; 3], [100.0, 100.0, 5.0], false);
    let render = mesh([plate.clone(), post.clone()].concat());
    let solid = mesh([plate, post, boss].concat());
    assert!((solid.volume - render.volume) / render.volume < 0.001);
    let sampling = sampling(&render, 0.0);
    let mut answer = answer_from(&solid, &render, &sampling);
    assert_eq!(
        accept(&answer, &render, &sampling).err().unwrap(),
        "it is 3 solids where the render is 2 bodies"
    );
    // A boss standing on the plate adds no body: its faces find it.
    answer["solids"] = json!(2);
    let failure = accept(&answer, &render, &sampling).err().unwrap();
    assert!(
        failure.ends_with("probe pairs at its own faces classify differently in the render, so it has material or a face the render does not"),
        "{failure}"
    );
}

#[test]
fn a_sliver_between_faces_is_not_asked_for_probes() {
    // A 10 × 10 × 5 block with one vertical edge cut by a strip 0.00014 mm wide.
    let e = 1e-4;
    let outline = [
        [0.0, 0.0],
        [10.0, 0.0],
        [10.0, 10.0 - e],
        [10.0 - e, 10.0],
        [0.0, 10.0],
    ];
    let at = |p: [f64; 2], z: f64| [p[0], p[1], z];
    let mut triangles = Vec::new();
    for k in 1..outline.len() - 1 {
        triangles.push([
            at(outline[0], 5.0),
            at(outline[k], 5.0),
            at(outline[k + 1], 5.0),
        ]);
        triangles.push([
            at(outline[0], 0.0),
            at(outline[k + 1], 0.0),
            at(outline[k], 0.0),
        ]);
    }
    for k in 0..outline.len() {
        let (a, b) = (outline[k], outline[(k + 1) % outline.len()]);
        triangles.push([at(a, 0.0), at(b, 0.0), at(b, 5.0)]);
        triangles.push([at(a, 0.0), at(b, 5.0), at(a, 5.0)]);
    }
    let block = mesh(triangles);
    assert!(block.watertight);
    let sampling = sampling(&block, 0.0);
    assert_eq!(sampling.slivers, 1);
    assert_eq!(sampling.patch_count, 6);
    assert!(sampling.unprobed.is_empty());
}

#[test]
fn bodies_are_shells_around_material_not_cavities() {
    let apart = mesh(
        [
            cuboid([0.0; 3], [10.0, 10.0, 10.0], false),
            cuboid([20.0, 0.0, 0.0], [30.0, 10.0, 10.0], false),
        ]
        .concat(),
    );
    assert_eq!(bodies(&apart), 2);
    let hollow = mesh(
        [
            cuboid([0.0; 3], [10.0, 10.0, 10.0], false),
            cuboid([2.0; 3], [8.0, 8.0, 8.0], true),
        ]
        .concat(),
    );
    assert_eq!(bodies(&hollow), 1);
}

#[test]
fn an_exact_answer_that_agrees_with_the_render_is_used() {
    let plate = mesh(plate_with_hole([40.0, 30.0, 4.0], [20.0, 15.0], 8.0, 64));
    let sampling = sampling(&plate, 0.0);
    let checks = accept(&agreeing_answer(&plate, &sampling), &plate, &sampling).unwrap();
    assert_eq!(checks["basis"], "opencascade read-back (OCP 7.9.3.1)");
    assert_eq!(checks["sampleMismatches"], 0);
    assert_eq!(checks["surfaceMismatches"], 0);
    assert_eq!(checks["surfaceProbes"], sampling.pairs());
    assert_eq!(checks["volumeErrorPct"], 0.0);
    assert_eq!(checks["unit"], "mm");
}

#[test]
fn an_exact_answer_is_refused_with_the_first_check_it_fails() {
    let plate = mesh(cuboid([0.0; 3], [40.0, 30.0, 4.0], false));
    let sampling = sampling(&plate, 0.0);
    let agreeing = agreeing_answer(&plate, &sampling);
    let refused = |change: &dyn Fn(&mut Value)| {
        let mut answer = agreeing.clone();
        change(&mut answer);
        accept(&answer, &plate, &sampling).err().unwrap()
    };
    assert_eq!(
        refused(&|a| a["valid"] = json!(false)),
        "OpenCASCADE reports it invalid"
    );
    assert_eq!(
        refused(&|a| a["openShells"] = json!(1)),
        "1 of its shells are open"
    );
    assert_eq!(
        refused(&|a| a["freeEdges"] = json!(3)),
        "it has 3 free edges"
    );
    assert_eq!(
        refused(&|a| a["unmeshedFaces"] = json!(2)),
        "2 of its faces do not tessellate"
    );
    // Touching solids where the render is one body: one face between them has no side out.
    assert_eq!(
        refused(&|a| a["solids"] = json!(9)),
        "it is 9 solids where the render is 1 body"
    );
    assert_eq!(
        refused(&|a| a["volume"] = json!(4800.0 * 1.03)),
        "its volume is 4944 mm³ against the render's 4800 mm³ (3 % apart)"
    );
    assert!(refused(&|a| a["volume"] = json!(4800.0 * 1.006)).contains("0.6 % apart"));
    assert_eq!(
        refused(&|a| a["bboxMax"][0] = json!(40.25)),
        "its bounding box differs from the render's by 0.25 mm"
    );
    // What the converter did not measure never passes.
    assert!(refused(&|a| a["bboxMax"] = Value::Null).starts_with("its bounding box differs"));
    assert!(refused(&|a| a["volume"] = Value::Null).starts_with("its volume is NaN mm³"));
    // Seven of the points through the box disagree.
    let flipped = |a: &mut Value, at: &[usize]| {
        let mut inside = a["inside"].as_str().unwrap().as_bytes().to_vec();
        for &i in at {
            inside[i] = if inside[i] == b'1' { b'0' } else { b'1' };
        }
        a["inside"] = json!(String::from_utf8(inside).unwrap());
    };
    assert_eq!(
        refused(&|a| flipped(a, &[0, 1, 2, 3, 4, 5, 6])),
        "7 of 512 points through its bounding box classify differently from the render"
    );
    // A point on the surface (2) is not a disagreement, nor an agreement: it is counted apart.
    let mut on = agreeing.clone();
    let mut inside = on["inside"].as_str().unwrap().as_bytes().to_vec();
    inside[..10].fill(b'2');
    on["inside"] = json!(String::from_utf8(inside).unwrap());
    let checks = accept(&on, &plate, &sampling).unwrap();
    assert_eq!(
        (&checks["sampleOnSurface"], &checks["sampleMismatches"]),
        (&json!(10), &json!(0))
    );
    // An answer that is none of the three says nothing true about the point.
    let mut garbled = agreeing.clone();
    let mut inside = garbled["inside"].as_str().unwrap().as_bytes().to_vec();
    inside[..4].fill(b'?');
    garbled["inside"] = json!(String::from_utf8(inside).unwrap());
    assert_eq!(
        accept(&garbled, &plate, &sampling).err().unwrap(),
        "4 of 512 points through its bounding box classify differently from the render"
    );
    assert!(refused(&|a| a["inside"] = json!("01")).starts_with("it classified 2 of the"));
    // A tree of flat faces: its facets are the exact faces, so one probe pair that disagrees
    // away from every other face is a lost feature (a stray within the rounding of a face is
    // noise: `a_stray_disagreement_at_the_renders_faces_is_noise_only_within_the_facets_reach`),
    // and three anywhere are refused by their count.
    let pair = |k: usize| sampling.volume + 2 * k + 1;
    assert_eq!(
        refused(&|a| flipped(a, &[pair(0)])),
        format!("1 of {} probe pairs at the render's faces classify differently farther than 0.000014 mm from every face of the render, more than its facets and rounding explain, so a feature of the render is missing or moved", sampling.pairs())
    );
    assert!(refused(&|a| flipped(a, &[pair(0), pair(1), pair(2)]))
        .ends_with("probe pairs at the render's faces classify differently, so a feature of the render is missing or moved"));
    // The same at the solid's own faces, whose pairs the render classifies.
    let moved = |a: &mut Value, pairs: &[usize]| {
        // The outer point moved to where the inner one is, inside the render.
        for &k in pairs {
            for axis in 0..3 {
                a["solidProbes"][k][3 + axis] = a["solidProbes"][k][axis].clone();
            }
        }
    };
    assert_eq!(
        refused(&|a| moved(a, &[0])),
        format!("1 of {} probe pairs at its own faces classify differently in the render farther than 0.000014 mm from every face of the render, whose flat facets are its exact faces, so it has material or a face the render does not", agreeing["solidProbes"].as_array().unwrap().len())
    );
    assert!(refused(&|a| moved(a, &[0, 1, 2])).starts_with("3 of "));
    assert!(refused(&|a| moved(a, &[0, 1, 2])).ends_with(
        "probe pairs at its own faces classify differently in the render, so it has material or a face the render does not"
    ));
    assert_eq!(
        refused(&|a| a["solidProbes"] = Value::Null),
        "it returned no probes of its own faces"
    );
    assert_eq!(
        refused(&|a| a["solidProbes"][0] = json!([1, 2, 3])),
        "its probes of its own faces are not points"
    );
}

#[test]
fn a_pair_nearer_than_the_facets_reach_counts_only_when_it_agrees() {
    // Every pair nearer the faces than the facets can lie from the exact surfaces.
    let render = mesh(plate_with_hole([100.0, 100.0, 5.0], [50.0, 50.0], 3.0, 64));
    let mut sampling = sampling(&render, 0.0);
    sampling.trusted = 1.0;
    let agreeing = agreeing_answer(&render, &sampling);
    let checks = accept(&agreeing, &render, &sampling).unwrap();
    assert_eq!(checks["surfaceSetAside"], 0);
    // A stray disagreement among them says nothing either way.
    let mut stray = agreeing.clone();
    let mut inside = stray["inside"].as_str().unwrap().as_bytes().to_vec();
    for k in 0..3 {
        inside[sampling.volume + 2 * k + 1] = b'1';
    }
    stray["inside"] = json!(String::from_utf8(inside).unwrap());
    let checks = accept(&stray, &render, &sampling).unwrap();
    assert_eq!(checks["surfaceSetAside"], 3);
    assert_eq!(checks["surfaceMismatches"], 0);
    // A hole the exact solid lost leaves its wall with no pair that counts: refused.
    let solid = mesh(cuboid([0.0; 3], [100.0, 100.0, 5.0], false));
    let failure = accept(&answer_from(&solid, &render, &sampling), &render, &sampling)
        .err()
        .unwrap();
    assert!(
        failure.starts_with("on 1 of the render's 7 surfaces the only probe pairs that fit lie nearer the faces than the facets can lie from the exact surfaces (1 mm), and disagree"),
        "{failure}"
    );
}

#[test]
fn a_hole_the_exact_solid_lost_is_found_by_the_probes_at_its_wall() {
    // The render has a ⌀3 hole in a 100 × 100 × 5 plate; the exact solid does not.
    let render = mesh(plate_with_hole([100.0, 100.0, 5.0], [50.0, 50.0], 3.0, 64));
    let solid = mesh(cuboid([0.0; 3], [100.0, 100.0, 5.0], false));
    let sampling = sampling(&render, 0.0);
    let answer = answer_from(&solid, &render, &sampling);
    // Volume (0.07 %), box and the points through the box cannot see it.
    assert!((solid.volume - render.volume) / render.volume < 0.001);
    let failure = accept(&answer, &render, &sampling).err().unwrap();
    assert!(
        failure.contains("probe pairs at the render's faces classify differently"),
        "{failure}"
    );
    // A body the exact solid lost is found the same way, where the box is set by another.
    let column = cuboid([0.0, 0.0, 6.0], [5.0, 5.0, 10.0], false);
    let lifted = |t: Vec<mesh::Triangle>| {
        t.into_iter()
            .map(|t| t.map(|p| [p[0], p[1], p[2] + 6.0]))
            .collect::<Vec<_>>()
    };
    let render = mesh(
        [
            cuboid([0.0; 3], [100.0, 100.0, 5.0], false),
            column.clone(),
            lifted(cylinder([50.0, 50.0], 6.0, 3.0, 64)),
        ]
        .concat(),
    );
    let solid = mesh([cuboid([0.0; 3], [100.0, 100.0, 5.0], false), column].concat());
    let sampling = super::sampling(&render, 0.0);
    assert!((render.volume - solid.volume) / render.volume < 0.005);
    let mut answer = answer_from(&solid, &render, &sampling);
    // As if the lost boss had stood on the plate: the body count cannot tell.
    answer["solids"] = json!(3);
    let failure = accept(&answer, &render, &sampling).err().unwrap();
    assert!(
        failure.contains("a feature of the render is missing or moved"),
        "{failure}"
    );
}

/// A closed `size` × `size` × `height` plate whose top, a grid of `cells` ×
/// `cells` squares, has a spherical dimple of `radius` and `depth` at
/// `centre`: a feature whose faces meet the top at under 30°.
fn dimpled_plate(
    size: f64,
    height: f64,
    cells: usize,
    centre: [f64; 2],
    radius: f64,
    depth: f64,
) -> Vec<mesh::Triangle> {
    let step = size / cells as f64;
    let at = |i: usize| i as f64 * step;
    let top = |i: usize, j: usize| -> mesh::Point {
        let rho = (at(i) - centre[0]).powi(2) + (at(j) - centre[1]).powi(2);
        let sphere = height + radius - depth - (radius * radius - rho).max(0.0).sqrt();
        [at(i), at(j), sphere.min(height)]
    };
    let bottom = |i: usize, j: usize| -> mesh::Point { [at(i), at(j), 0.0] };
    let mut triangles = Vec::new();
    for i in 0..cells {
        for j in 0..cells {
            let (a, b, c, d) = (top(i, j), top(i + 1, j), top(i + 1, j + 1), top(i, j + 1));
            triangles.extend([[a, b, c], [a, c, d]]);
            let (a, b, c, d) = (
                bottom(i, j),
                bottom(i + 1, j),
                bottom(i + 1, j + 1),
                bottom(i, j + 1),
            );
            triangles.extend([[a, c, b], [a, d, c]]);
        }
    }
    for k in 0..cells {
        let (low, high) = (at(k), at(k + 1));
        let quad = |p: [mesh::Point; 4], outward: bool| {
            if outward {
                [[p[0], p[1], p[2]], [p[0], p[2], p[3]]]
            } else {
                [[p[0], p[2], p[1]], [p[0], p[3], p[2]]]
            }
        };
        for (y, outward) in [(0.0, true), (size, false)] {
            triangles.extend(quad(
                [
                    [low, y, 0.0],
                    [high, y, 0.0],
                    [high, y, height],
                    [low, y, height],
                ],
                outward,
            ));
        }
        for (x, outward) in [(0.0, false), (size, true)] {
            triangles.extend(quad(
                [
                    [x, low, 0.0],
                    [x, high, 0.0],
                    [x, high, height],
                    [x, low, height],
                ],
                outward,
            ));
        }
    }
    triangles
}

#[test]
fn a_lost_feature_that_blends_into_its_face_is_found_by_one_pair() {
    // A dimple 0.25 mm deep and 4.4 mm across in a 100 mm plate meets the top at about 13°:
    // it shares the top's patch, so only a pair or two land on it, and volume, box and the
    // points through the box cannot see it. A solid that lost it is refused all the same.
    let (centre, radius, depth) = ([50.3, 50.6], 10.0, 0.25);
    let render = mesh(dimpled_plate(100.0, 5.0, 100, centre, radius, depth));
    assert!(render.watertight && !render.inverted);
    let solid = mesh(cuboid([0.0; 3], [100.0, 100.0, 5.0], false));
    assert!((solid.volume - render.volume) / render.volume < 1e-4);
    // With facets 0.02 mm off the exact surfaces (pairs 0.06 mm out), and as if the tree were
    // of flat faces (pairs 0.0014 mm out, the smallest offset, which is also the guards'
    // margin): a disagreement is explained only within the facets' reach plus the rounding.
    for (bound, within) in [(0.02, "0.03"), (0.0, "0.000021")] {
        let sampling = sampling(&render, bound);
        let patches = sampling
            .patches
            .iter()
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(patches.len(), 6, "the dimple is part of the top's patch");
        assert!(accept(&agreeing_answer(&render, &sampling), &render, &sampling).is_ok());
        // Fewer pairs disagree than the count the comparison allows anywhere.
        let disagree = (0..sampling.pairs())
            .filter(|&pair| {
                let at = sampling.volume + 2 * pair;
                !(solid.contains(sampling.points[at]) && !solid.contains(sampling.points[at + 1]))
            })
            .count();
        assert!(
            (1..=MAX_SURFACE_MISMATCHES).contains(&disagree),
            "{bound}: {disagree} pairs on the dimple"
        );
        let failure = accept(&answer_from(&solid, &render, &sampling), &render, &sampling)
            .err()
            .unwrap();
        assert!(
            failure.ends_with(&format!(" probe pairs at the render's faces classify differently farther than {within} mm from every face of the render, more than its facets and rounding explain, so a feature of the render is missing or moved")),
            "{bound}: {failure}"
        );
    }
}

#[test]
fn a_stray_disagreement_at_the_renders_faces_is_noise_only_within_the_facets_reach() {
    // Facets 0.02 mm off the exact surfaces: pairs first 0.06 mm out, reach 0.03 mm.
    let plate = mesh(cuboid([0.0; 3], [40.0, 30.0, 4.0], false));
    let mut sampling = sampling(&plate, 0.02);
    assert!((sampling.offsets[0] - 0.06).abs() < 1e-12 && (sampling.reach() - 0.03).abs() < 1e-12);
    let top = (0..sampling.pairs())
        .find(|&pair| {
            let inner = sampling.points[sampling.volume + 2 * pair];
            (inner[2] - 3.94).abs() < 1e-9 && inner[0] < 30.0
        })
        .unwrap();
    // Moved 0.01 mm from the top's edge, still on the top.
    let near = (0..sampling.pairs())
        .find(|&pair| pair != top && sampling.points[sampling.volume + 2 * pair][2] > 3.9)
        .unwrap();
    for k in 0..2 {
        sampling.points[sampling.volume + 2 * near + k][0] = 40.0 - 0.01;
    }
    let agreeing = agreeing_answer(&plate, &sampling);
    let flipped = |at: usize| {
        let mut answer = agreeing.clone();
        let mut inside = answer["inside"].as_str().unwrap().as_bytes().to_vec();
        inside[at] = if inside[at] == b'1' { b'0' } else { b'1' };
        answer["inside"] = json!(String::from_utf8(inside).unwrap());
        accept(&answer, &plate, &sampling)
    };
    // The inner point beside the side face: the facets of that face could explain it.
    assert!(flipped(sampling.volume + 2 * near).is_ok());
    // The outer point of a pair in the middle of the top: nothing could.
    assert!(flipped(sampling.volume + 2 * top + 1)
        .err()
        .unwrap()
        .starts_with("1 of "));
    // At the solid's own faces one such pair is still let through (a render's facets can lie
    // farther from the exact surface than the bound says: one corpus part had one), and three
    // are not.
    let probe = |z: f64| json!([20.0, 15.0, z, 20.0, 15.0, z + 0.12, 0]);
    let mut answer = agreeing.clone();
    answer["solidProbes"][0] = probe(4.14);
    assert!(accept(&answer, &plate, &sampling).is_ok());
    for k in 1..3 {
        answer["solidProbes"][k] = probe(4.14);
    }
    assert!(accept(&answer, &plate, &sampling)
        .err()
        .unwrap()
        .starts_with("3 of "));
    // A tree of flat faces: its facets are its exact faces, and only rounding (single-precision
    // corners, the classifier's tolerance) can explain a disagreement, on either side.
    let mut flat = super::sampling(&plate, 0.0);
    assert_eq!(flat.trusted, 0.0);
    assert!((flat.explained() - (1e-5 + 40.0 * f64::from(f32::EPSILON))).abs() < 1e-12);
    let near = (0..flat.pairs())
        .find(|&pair| flat.points[flat.volume + 2 * pair][2] > 3.99)
        .unwrap();
    let stray_beside = |flat: &mut Sampling, gap: f64| {
        for k in 0..2 {
            flat.points[flat.volume + 2 * near + k][0] = 40.0 - gap;
        }
        let mut answer = agreeing_answer(&plate, flat);
        let at = flat.volume + 2 * near;
        let mut inside = answer["inside"].as_str().unwrap().as_bytes().to_vec();
        inside[at] = b'0';
        answer["inside"] = json!(String::from_utf8(inside).unwrap());
        accept(&answer, &plate, flat)
    };
    // 5e-6 mm from the side face: rounding could explain it. 0.01 mm: nothing could.
    assert!(stray_beside(&mut flat, 5e-6).is_ok());
    assert!(stray_beside(&mut flat, 0.01)
        .err()
        .unwrap()
        .starts_with("1 of "));
    let flat = super::sampling(&plate, 0.0);
    let mut answer = agreeing_answer(&plate, &flat);
    answer["solidProbes"][0] = probe(4.0 + 5e-6);
    assert!(accept(&answer, &plate, &flat).is_ok());
    answer["solidProbes"][0] = probe(4.14);
    assert!(accept(&answer, &plate, &flat).err().unwrap().ends_with(
        "whose flat facets are its exact faces, so it has material or a face the render does not"
    ));
}

#[test]
fn the_converter_file_is_checked_by_its_own_bytes() {
    let good = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n#1=MANIFOLD_SOLID_BREP('',#2);\nENDSEC;\nEND-ISO-10303-21;\n";
    let size = Some(good.len() as u64);
    assert_eq!(step_file_problem(good.as_bytes(), size), None);
    assert_eq!(
        step_file_problem(good.as_bytes(), Some(3)).unwrap(),
        format!("is {} bytes, not the 3 it measured", good.len())
    );
    let other = good.replace("AUTOMOTIVE_DESIGN", "CONFIG_CONTROL_DESIGN");
    assert_eq!(
        step_file_problem(other.as_bytes(), Some(other.len() as u64)).unwrap(),
        "does not declare the AP214 schema"
    );
    let empty = good.replace("MANIFOLD_SOLID_BREP", "SHELL_BASED_SURFACE_MODEL");
    assert_eq!(
        step_file_problem(empty.as_bytes(), Some(empty.len() as u64)).unwrap(),
        "holds no solid"
    );
    let cut = &good[..good.len() - 10];
    assert_eq!(
        step_file_problem(cut.as_bytes(), Some(cut.len() as u64)).unwrap(),
        "is not an ISO 10303-21 file"
    );
}

#[test]
fn converter_failures_and_interpretations_are_said_in_words() {
    let python = Path::new("/venv/bin/python3");
    let failure = |stage: &str, reason: &str| {
        converter_failure(&json!({"stage": stage, "reason": reason}), python)
    };
    assert_eq!(
        failure("build", "Unsupported: minkowski"),
        "The exact converter does not rebuild minkowski() yet."
    );
    assert_eq!(
        failure("build", "Unsupported: linear_extrude twist/scale"),
        "OpenCASCADE could not rebuild the CSG tree: Unsupported: linear_extrude twist/scale"
    );
    assert_eq!(
        failure("import", "ModuleNotFoundError: No module named 'OCP'"),
        "Python /venv/bin/python3 cannot import OCP: ModuleNotFoundError: No module named 'OCP'"
    );
    assert!(failure(
        "check",
        "Unsupported: the written STEP file does not read back"
    )
    .starts_with("OpenCASCADE could not write or read back the STEP file"));
    let notes = interpretation_notes(&json!({"interpretations": [
        {"kind": "cylinder", "facets": 12, "count": 3},
        {"kind": "sphere", "facets": 24, "count": 1}]}));
    assert_eq!(
        notes,
        [
            "3 cylinders rendered with 12 facets were exported as true circles.",
            "1 sphere rendered with 24 facets was exported as true spheres.",
        ]
    );
}

#[test]
fn a_faceted_export_over_the_limit_says_why_exact_was_not_used() {
    let error = faceted_refused(
        mesh::work_limit("Faceted STEP triangles", 300_000, faceted::MAX_TRIANGLES),
        Some("No Python with OCP (OpenCASCADE) was found."),
    );
    assert!(error
        .repair
        .unwrap()
        .starts_with("Lower $fn so the render has at most 250000 triangles"));
    assert!(error
        .message
        .ends_with("The exact path was not used: No Python with OCP (OpenCASCADE) was found."));
    assert_eq!(
        error.details.unwrap()["exactReason"],
        "No Python with OCP (OpenCASCADE) was found."
    );
}

/* ------------------------------------------------------------------ */
/* Through the shared application                                       */
/* ------------------------------------------------------------------ */

fn set_python(sandbox: &Sandbox, python: &Path) {
    sandbox
        .core
        .lock()
        .unwrap()
        .dispatch(
            "settings.set",
            json!({"key": "toolPaths.python", "value": python}),
            Origin::User,
            None,
        )
        .unwrap();
}

fn agent() -> Origin {
    Origin::Agent {
        session_id: "sess-step".into(),
    }
}

fn exported_events(sandbox: &Sandbox) -> Vec<Value> {
    sandbox
        .call("project.changes_since", json!({"seq": 0}))
        .unwrap()["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["type"] == "cad.exported")
        .cloned()
        .collect()
}

/// A stand-in Python: it checks how it was run, then does `body` in the
/// export's private folder.
#[cfg(unix)]
fn fake_python(dir: &Path, name: &str, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(name);
    let script = format!(
        "#!/bin/sh\nif [ \"$1\" = \"-c\" ] || [ \"$2\" = \"-c\" ]; then echo 'OMENFLOW-OCP 7.9.3.1 3.12.14'; exit 0; fi\n[ \"$1\" = \"-E\" ] && [ \"$2\" = \"csg_to_step.py\" ] && [ -f csg_to_step.py ] && [ -f request.json ] || {{ echo 'run wrongly' >&2; exit 9; }}\n{body}\n"
    );
    fs::write(&path, script).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

/// The stand-in engine's 20 × 10 × 2 mm cuboid.
fn stand_in_mesh() -> mesh::Mesh {
    mesh(cuboid([0.0; 3], [20.0, 10.0, 2.0], false))
}

const STEP_TEXT: &str = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n#1=MANIFOLD_SOLID_BREP('',#2);\nENDSEC;\nEND-ISO-10303-21;\n";

/// Files an agreeing converter copies into place: its answer for the stand-in
/// cuboid and a STEP file of the size it reports.
#[cfg(unix)]
fn agreeing_files(dir: &Path) -> String {
    let mesh = stand_in_mesh();
    let sampling = sampling(&mesh, 0.0);
    let mut answer = agreeing_answer(&mesh, &sampling);
    answer["bytes"] = json!(STEP_TEXT.len());
    answer["faces"] = json!(6);
    fs::write(dir.join("answer.prepared"), answer.to_string()).unwrap();
    fs::write(dir.join("step.prepared"), STEP_TEXT).unwrap();
    format!(
        "cp '{}' output.step\ncp '{}' answer.json\necho 'OpenCASCADE says this after the answer'",
        dir.join("step.prepared").display(),
        dir.join("answer.prepared").display()
    )
}

/// Check the stand-in part and approve it as the baseline.
#[cfg(unix)]
fn approve(sandbox: &Sandbox, part: &Value) {
    let verified = sandbox
        .call(
            "cad.check",
            json!({"artifactId": part["artifactId"], "autoCommit": true, "expect": {"size": [20, 10, 2]}}),
        )
        .unwrap();
    let proposal = sandbox
        .call(
            "proposal.submit",
            json!({"changes": [{"artifactId": part["artifactId"], "baseRevisionId": null,
                "newRevisionId": part["revisionId"], "kind": "new_artifact"}], "reason": "reviewed"}),
        )
        .unwrap();
    let mut accepted = serde_json::Map::new();
    accepted.insert(
        part["artifactId"].as_str().unwrap().to_owned(),
        verified["evidenceHash"].clone(),
    );
    let resolved = sandbox
        .call(
            "proposal.approve",
            json!({"proposalId": proposal["id"], "rationale": "ok", "verificationEvidence": accepted}),
        )
        .unwrap();
    assert_eq!(resolved["state"], "accepted");
}

#[cfg(unix)]
fn stand_in_part(sandbox: &Sandbox) -> Value {
    sandbox
        .call(
            "cad.write_source",
            json!({"title": "Stand-in plate", "source": "w = 20;\ncube([w, 10, 2]);\n"}),
        )
        .unwrap()
}

#[cfg(unix)]
#[test]
fn the_conversion_runs_off_the_lock_and_an_agreeing_answer_is_exact() {
    let dir = tempfile::tempdir().unwrap();
    let engine = StandIn::new(dir.path());
    engine.release();
    let sandbox = Sandbox::with_engine(&engine.executable);
    let gate = dir.path().join("python-gate");
    let body = format!(
        "while [ ! -f '{}' ]; do sleep 0.02; done\n{}",
        gate.display(),
        agreeing_files(dir.path())
    );
    set_python(&sandbox, &fake_python(dir.path(), "python3", &body));
    let part = stand_in_part(&sandbox);
    let dest = dir.path().join("out/plate.step");
    let result = std::thread::scope(|scope| {
        let export = scope.spawn(|| {
            sandbox.call(
                "cad.export",
                json!({"artifactId": part["artifactId"], "revisionId": part["revisionId"], "format": "step", "destPath": dest}),
            )
        });
        wait_until("the export job", || {
            sandbox
                .jobs("cad_export")
                .iter()
                .any(|job| job["status"] == "running")
        });
        std::thread::sleep(std::time::Duration::from_millis(200));
        let started = std::time::Instant::now();
        assert!(sandbox.call("artifact.list", json!({})).is_ok());
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        assert!(!export.is_finished(), "the converter is still held");
        fs::write(&gate, "").unwrap();
        export.join().unwrap().unwrap()
    });
    assert_eq!(result["method"], "brep", "{result}");
    assert_eq!(result["exact"], true);
    assert_eq!(result["faces"], 6);
    assert_eq!(result["checks"]["surfaceMismatches"], 0);
    assert_eq!(
        result["checks"]["basis"],
        "opencascade read-back (OCP 7.9.3.1)"
    );
    assert_eq!(result["converter"]["ocp"], "7.9.3.1");
    assert_eq!(result["converter"]["version"], json!(*CONVERTER_VERSION));
    assert_eq!(result["verification"], "unverified");
    assert!(result["notes"]
        .as_array()
        .unwrap()
        .contains(&json!("r1 has no passing cad_check (unverified).")));
    assert_eq!(fs::read_to_string(&dest).unwrap(), STEP_TEXT);
    let job = &sandbox.jobs("cad_export")[0];
    assert_eq!(job["status"], "succeeded");
    assert_eq!(
        job["toolVersion"],
        "OCP 7.9.3.1, Python 3.12.14, OpenSCAD 0.0.0-standin"
    );
    // Programs are named, never located; the destination is a file name only.
    assert_eq!(
        job["command"],
        "stand-in-engine -o output.csg input.scad; python3 -E csg_to_step.py request.json"
    );
    assert_eq!(job["inputs"]["destPath"], "plate.step");
    assert_eq!(
        job["outputHashes"]["step"],
        omenflow_storage::sha256_hex(STEP_TEXT.as_bytes())
    );
    assert!(job["log"]
        .as_str()
        .unwrap()
        .contains("OpenCASCADE says this after the answer"));
    let events = exported_events(&sandbox);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["data"]["method"], "brep");
    assert_eq!(events[0]["data"]["destPath"], json!(dest));
    assert!(events[0]["data"].get("projectPath").is_none());
}

#[cfg(unix)]
#[test]
fn the_versions_recorded_are_those_the_converter_ran_with() {
    // OCP was upgraded in the virtual environment after its Python was checked.
    let dir = tempfile::tempdir().unwrap();
    let engine = StandIn::new(dir.path());
    engine.release();
    let sandbox = Sandbox::with_engine(&engine.executable);
    let body = agreeing_files(dir.path());
    let prepared = dir.path().join("answer.prepared");
    let mut answer: Value = serde_json::from_slice(&fs::read(&prepared).unwrap()).unwrap();
    answer["ocp"] = json!("7.9.3.2");
    answer["python"] = json!("3.12.15");
    fs::write(&prepared, answer.to_string()).unwrap();
    set_python(&sandbox, &fake_python(dir.path(), "python3", &body));
    let part = stand_in_part(&sandbox);
    let result = sandbox
        .call(
            "cad.export",
            json!({"artifactId": part["artifactId"], "revisionId": part["revisionId"], "format": "step", "destPath": dir.path().join("p.step")}),
        )
        .unwrap();
    assert_eq!(result["method"], "brep", "{result}");
    assert_eq!(result["converter"]["ocp"], "7.9.3.2");
    assert_eq!(result["converter"]["pythonVersion"], "3.12.15");
    assert_eq!(
        result["checks"]["basis"],
        "opencascade read-back (OCP 7.9.3.2)"
    );
    assert_eq!(
        sandbox.jobs("cad_export")[0]["toolVersion"],
        "OCP 7.9.3.2, Python 3.12.15, OpenSCAD 0.0.0-standin"
    );
}

#[cfg(unix)]
#[test]
fn a_python_that_lost_ocp_is_checked_again_by_the_next_export() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let engine = StandIn::new(dir.path());
    engine.release();
    let sandbox = Sandbox::with_engine(&engine.executable);
    // Its check passed once; then OCP was removed, and the converter cannot import it.
    let checks = dir.path().join("checks");
    let python = dir.path().join("python3");
    fs::write(
        &python,
        format!(
            "#!/bin/sh\nif [ \"$2\" = \"-c\" ]; then echo x >> '{}'; echo 'OMENFLOW-OCP 7.9.3.1 3.12.14'; exit 0; fi\necho '{{\"protocol\": 1, \"ok\": false, \"stage\": \"import\", \"reason\": \"ModuleNotFoundError: No module named OCP\", \"python\": \"3.12.14\"}}' > answer.json\n",
            checks.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&python, fs::Permissions::from_mode(0o755)).unwrap();
    set_python(&sandbox, &python);
    let part = stand_in_part(&sandbox);
    let export = || {
        sandbox
            .call(
                "cad.export",
                json!({"artifactId": part["artifactId"], "revisionId": part["revisionId"], "format": "step", "destPath": dir.path().join("p.step")}),
            )
            .unwrap()
    };
    let checked = || fs::read_to_string(&checks).unwrap().lines().count();
    let result = export();
    assert_eq!(result["method"], "faceted");
    assert!(
        result["reason"]
            .as_str()
            .unwrap()
            .ends_with("cannot import OCP: ModuleNotFoundError: No module named OCP"),
        "{result}"
    );
    assert_eq!(result["converter"]["ocp"], Value::Null);
    assert_eq!(checked(), 1);
    export();
    assert_eq!(checked(), 2, "the remembered success was forgotten");
}

#[cfg(unix)]
#[test]
fn a_cancelled_export_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let engine = StandIn::new(dir.path());
    engine.release();
    let sandbox = Sandbox::with_engine(&engine.executable);
    set_python(&sandbox, &fake_python(dir.path(), "python3", "sleep 30"));
    let part = stand_in_part(&sandbox);
    let dest = dir.path().join("never.step");
    std::thread::scope(|scope| {
        let export = scope.spawn(|| {
            sandbox.call(
                "cad.export",
                json!({"artifactId": part["artifactId"], "revisionId": part["revisionId"], "format": "step", "destPath": dest}),
            )
        });
        wait_until("the export job", || {
            sandbox
                .jobs("cad_export")
                .iter()
                .any(|job| job["status"] == "running")
        });
        std::thread::sleep(std::time::Duration::from_millis(300));
        let job = sandbox.jobs("cad_export")[0]["id"].clone();
        sandbox.call("job.cancel", json!({"jobId": job})).unwrap();
        let started = std::time::Instant::now();
        let error = export.join().unwrap().err().unwrap();
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        assert_eq!(error.code, "CANCELLED");
        assert_eq!(
            error.message,
            "STEP export was cancelled; nothing was written."
        );
    });
    assert!(!dest.exists());
    assert_eq!(sandbox.jobs("cad_export")[0]["status"], "cancelled");
    assert!(exported_events(&sandbox).is_empty());
}

#[cfg(unix)]
#[test]
fn a_converter_that_hangs_is_stopped_at_the_export_limit_and_the_part_is_faceted() {
    let dir = tempfile::tempdir().unwrap();
    let engine = StandIn::new(dir.path());
    engine.release();
    let sandbox = Sandbox::with_engine(&engine.executable);
    set_python(&sandbox, &fake_python(dir.path(), "python3", "sleep 30"));
    let part = stand_in_part(&sandbox);
    let started = std::time::Instant::now();
    let result = sandbox
        .call(
            "cad.export",
            json!({"artifactId": part["artifactId"], "revisionId": part["revisionId"], "format": "step",
                "destPath": dir.path().join("slow.step"), "timeoutMs": 1500}),
        )
        .unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(20));
    assert_eq!(result["method"], "faceted");
    assert_eq!(result["exact"], false);
    let reason = result["reason"].as_str().unwrap();
    assert!(
        reason.ends_with("stopped at the export's 1500 ms limit."),
        "{reason}"
    );
    assert_eq!(result["faces"], 6);
    assert_eq!(result["checks"]["basis"], "construction");
    // The converter that was tried is still named.
    assert_eq!(result["converter"]["pythonVersion"], "3.12.14");
}

#[cfg(unix)]
#[test]
fn a_converter_without_an_answer_is_reported_with_its_last_line() {
    let dir = tempfile::tempdir().unwrap();
    let engine = StandIn::new(dir.path());
    engine.release();
    let sandbox = Sandbox::with_engine(&engine.executable);
    set_python(
        &sandbox,
        &fake_python(
            dir.path(),
            "python3",
            "echo 'Segmentation fault: 11' >&2\nexit 139",
        ),
    );
    let part = stand_in_part(&sandbox);
    let result = sandbox
        .call(
            "cad.export",
            json!({"artifactId": part["artifactId"], "revisionId": part["revisionId"], "format": "step", "destPath": dir.path().join("crash.step")}),
        )
        .unwrap();
    assert_eq!(result["method"], "faceted");
    assert_eq!(
        result["reason"],
        "The exact converter ended without an answer: Segmentation fault: 11"
    );
    let job = &sandbox.jobs("cad_export")[0];
    assert_eq!(job["toolVersion"], faceted::WRITER);
    assert!(job["log"]
        .as_str()
        .unwrap()
        .starts_with("Not exact: The exact converter ended without an answer"));
}

#[cfg(unix)]
#[test]
fn without_a_converter_the_export_is_faceted_and_says_why() {
    let dir = tempfile::tempdir().unwrap();
    let engine = StandIn::new(dir.path());
    engine.release();
    let sandbox = Sandbox::with_engine(&engine.executable);
    let part = stand_in_part(&sandbox);
    let result = sandbox
        .call(
            "cad.export",
            json!({"artifactId": part["artifactId"], "revisionId": part["revisionId"], "format": "step", "destPath": dir.path().join("plain.step")}),
        )
        .unwrap();
    assert_eq!(result["method"], "faceted");
    assert_eq!(result["reason"], "No Python with OCP (OpenCASCADE) was found; exact surfaces need the optional converter (Settings → Engineering tools).");
    assert_eq!(result["converter"], Value::Null);
    // With a Python that cannot import OCP, the configured path is named.
    set_python(&sandbox, &dir.path().join("missing-python"));
    let result = sandbox
        .call(
            "cad.export",
            json!({"artifactId": part["artifactId"], "revisionId": part["revisionId"], "format": "step", "destPath": dir.path().join("plain.step"), "method": "auto"}),
        )
        .unwrap();
    assert!(result["notes"][0]
        .as_str()
        .unwrap()
        .contains("missing-python cannot import OCP (not an executable file); no other Python with OCP was found."));
    // method "faceted" does not look for one at all.
    let faceted = sandbox
        .call(
            "cad.export",
            json!({"artifactId": part["artifactId"], "revisionId": part["revisionId"], "format": "step", "destPath": dir.path().join("plain.step"), "method": "faceted"}),
        )
        .unwrap();
    assert!(faceted.get("reason").is_none());
    assert!(faceted["notes"]
        .as_array()
        .unwrap()
        .iter()
        .all(|note| !note.as_str().unwrap().contains("Python")));
    let text = fs::read_to_string(dir.path().join("plain.step")).unwrap();
    // The header says what the file is and nothing that can go stale, such as its review state.
    assert!(text.contains("FILE_DESCRIPTION(('Faceted solid of the OpenSCAD render of Stand-in plate r1; planar faces, not exact surfaces'),'2;1');"));
    assert!(text.contains("FILE_NAME('stand-in-plate-r1.step',"));
}

#[cfg(unix)]
#[test]
fn an_archive_carries_no_machine_path_from_a_step_export_job() {
    // A Python and a destination outside the project, the home folder and the temporary
    // folder: the job log names the one, the job error the other.
    let dir = tempfile::tempdir().unwrap();
    let engine = StandIn::new(dir.path());
    engine.release();
    let sandbox = Sandbox::with_engine(&engine.executable);
    set_python(&sandbox, Path::new("/opt/omenflow-nowhere/bin/python3"));
    let part = stand_in_part(&sandbox);
    sandbox
        .call(
            "cad.export",
            json!({"artifactId": part["artifactId"], "revisionId": part["revisionId"], "format": "step", "destPath": dir.path().join("p.step")}),
        )
        .unwrap();
    let error = sandbox
        .call(
            "cad.export",
            json!({"artifactId": part["artifactId"], "revisionId": part["revisionId"], "format": "step", "method": "faceted", "destPath": "/dev/null/omen flow/p.step"}),
        )
        .unwrap_err();
    // The person is told where; the job names the file only, as its inputs do.
    assert!(
        error
            .message
            .starts_with("Could not write /dev/null/omen flow/p.step: "),
        "{}",
        error.message
    );
    let jobs = sandbox.jobs("cad_export");
    let failed = jobs.iter().find(|job| job["status"] == "failed").unwrap();
    assert_eq!(failed["inputs"]["destPath"], "p.step");
    assert!(
        failed["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("Could not write p.step: "),
        "{}",
        failed["error"]
    );
    // The Pythons tried are named in full on this machine.
    assert!(jobs.iter().any(|job| job["log"]
        .as_str()
        .unwrap_or("")
        .contains("Python /opt/omenflow-nowhere/bin/python3: not an executable file")));
    let archive = dir.path().join("a.zip");
    sandbox
        .call("project.export_archive", json!({"destPath": archive}))
        .unwrap();
    let mut zip = zip::ZipArchive::new(fs::File::open(&archive).unwrap()).unwrap();
    for name in ["snapshot.json", ".omenflow/state.sqlite"] {
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut zip.by_name(name).unwrap(), &mut bytes).unwrap();
        for leaked in ["/opt/omenflow-nowhere", "omen flow"] {
            assert!(
                !bytes
                    .windows(leaked.len())
                    .any(|window| window == leaked.as_bytes()),
                "{name} still contains {leaked}"
            );
        }
        if name == "snapshot.json" {
            let snapshot: Value = serde_json::from_slice(&bytes).unwrap();
            let archived = snapshot["jobs"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|job| job["kind"] == "cad_export")
                .collect::<Vec<_>>();
            assert!(archived.iter().any(|job| job["log"]
                .as_str()
                .unwrap_or("")
                .contains("Python python3: not an executable file")));
            assert!(archived.iter().any(|job| job["error"]["message"]
                .as_str()
                .unwrap_or("")
                .starts_with("Could not write p.step: ")));
        }
    }
}

#[cfg(unix)]
#[test]
fn an_agent_exports_only_under_exports_and_never_over_other_files() {
    let dir = tempfile::tempdir().unwrap();
    let engine = StandIn::new(dir.path());
    engine.release();
    let sandbox = Sandbox::with_engine(&engine.executable);
    let part = stand_in_part(&sandbox);
    let export = |origin: Origin, dest: Value, format: &str| {
        sandbox.call_as(
            origin,
            "cad.export",
            json!({"artifactId": part["artifactId"], "revisionId": part["revisionId"], "format": format, "destPath": dest, "method": "faceted"}),
        )
    };
    let outside = dir.path().join("outside.step");
    assert_eq!(
        export(agent(), json!(outside), "step").err().unwrap().code,
        "PATH_OUTSIDE_PROJECT"
    );
    for dest in [
        "./artifacts/x.step",
        "exports/../artifacts/x.step",
        "../x.step",
        ".omenflow/x.step",
    ] {
        assert_eq!(
            export(agent(), json!(dest), "step").err().unwrap().code,
            "PATH_OUTSIDE_PROJECT",
            "{dest}"
        );
    }
    for dest in [
        "artifacts/mechanical/x.step",
        "exports/plate.stl",
        "notes/plate.step",
        "exports",
    ] {
        let error = export(agent(), json!(dest), "step").err().unwrap();
        assert_eq!(error.code, "VALIDATION", "{dest}");
        assert_eq!(
            error.message,
            "An agent writes exports only under exports/, as a .step or .stp file"
        );
        assert_eq!(
            error.repair.as_deref(),
            Some("Give destPath under exports/, for example exports/stand-in-plate-r1.step.")
        );
    }
    // A link named exports that leads elsewhere in the project is judged by where it leads.
    let _ = fs::remove_dir_all(sandbox.root.join("exports"));
    std::os::unix::fs::symlink(sandbox.root.join("artifacts"), sandbox.root.join("exports"))
        .unwrap();
    let linked = export(agent(), json!("exports/x.step"), "step")
        .err()
        .unwrap();
    assert_eq!(linked.code, "VALIDATION");
    fs::remove_file(sandbox.root.join("exports")).unwrap();
    // Under exports/ it writes, and may write over what an export wrote before.
    let first = export(agent(), json!("exports/plate.step"), "step").unwrap();
    assert_eq!(
        first["path"],
        json!(sandbox
            .root
            .join("exports/plate.step")
            .canonicalize()
            .unwrap())
    );
    assert!(export(agent(), json!("EXPORTS/plate.STP"), "step").is_ok());
    assert!(export(
        agent(),
        json!(sandbox.root.join("exports/plate.step")),
        "step"
    )
    .is_ok());
    let job = sandbox.jobs("cad_export");
    assert!(job
        .iter()
        .all(|job| !job["inputs"]["destPath"].as_str().unwrap().starts_with('/')));
    // Not over a file the person keeps there.
    fs::write(sandbox.root.join("exports/vendor.step"), "theirs").unwrap();
    let kept = export(agent(), json!("exports/vendor.step"), "step")
        .err()
        .unwrap();
    assert_eq!(kept.code, "VALIDATION");
    assert_eq!(kept.message, "exports/vendor.step already exists and no earlier export wrote it, so an agent does not overwrite it");
    assert_eq!(
        kept.repair.as_deref(),
        Some("Give destPath a new name under exports/, e.g. exports/stand-in-plate-r1.step.")
    );
    assert_eq!(
        fs::read_to_string(sandbox.root.join("exports/vendor.step")).unwrap(),
        "theirs"
    );
    // STL and SCAD follow the same rules with their own extension.
    assert_eq!(
        export(agent(), json!("exports/plate.step"), "stl")
            .err()
            .unwrap()
            .message,
        "An agent writes exports only under exports/, as a .stl file"
    );
    assert!(export(agent(), json!("exports/plate.scad"), "scad").is_ok());
    // A person writes where they choose, inside the project or out, and over files.
    assert!(export(Origin::User, json!(outside), "step").is_ok());
    assert!(export(Origin::User, json!("exports/vendor.step"), "step").is_ok());
    assert!(export(Origin::User, json!("notes/plate.step"), "step").is_ok());
}

#[cfg(unix)]
#[test]
fn exports_follow_the_revision_rules() {
    let dir = tempfile::tempdir().unwrap();
    let engine = StandIn::new(dir.path());
    engine.release();
    let sandbox = Sandbox::with_engine(&engine.executable);
    let part = stand_in_part(&sandbox);
    let export = |origin: Origin, extra: Value| {
        let mut input = json!({"artifactId": part["artifactId"], "format": "step", "destPath": "exports/plate.step", "method": "faceted"});
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        sandbox.call_as(origin, "cad.export", input)
    };
    // A person's default is the baseline, and there is none yet.
    let none = export(Origin::User, json!({})).err().unwrap();
    assert_eq!(none.code, "NOT_FOUND");
    assert_eq!(
        none.message,
        "\"Stand-in plate\" has no baseline to export."
    );
    assert_eq!(
        none.repair.as_deref(),
        Some("Pass revisionId to export a draft, or approve a revision first.")
    );
    let draft = export(Origin::User, json!({"revisionId": part["revisionId"]})).unwrap();
    assert_eq!(draft["isBaseline"], false);
    assert_eq!(draft["reviewState"], "draft");
    assert!(draft["notes"]
        .as_array()
        .unwrap()
        .contains(&json!("r1 is a draft: not reviewed or approved.")));
    // An agent's default is the newest revision.
    let newer = sandbox
        .call(
            "cad.set_param",
            json!({"artifactId": part["artifactId"], "name": "w", "value": 30}),
        )
        .unwrap();
    let agents = export(agent(), json!({})).unwrap();
    assert_eq!(agents["revisionId"], newer["revisionId"]);
    assert_eq!(agents["revisionSeq"], 2);
    // A revision without a render of its own source has nothing checked to export.
    let mut payload = sandbox.revision(&newer["revisionId"])["payload"].clone();
    payload["params"] = json!({"w": 25});
    let edited = sandbox
        .call(
            "artifact.update_draft",
            json!({"artifactId": part["artifactId"], "rationale": "edited by hand", "payload": payload}),
        )
        .unwrap()["revision"]["id"]
        .clone();
    let refused = export(Origin::User, json!({"revisionId": edited}))
        .err()
        .unwrap();
    assert_eq!(refused.code, "VALIDATION");
    assert_eq!(refused.message, "r3 of \"Stand-in plate\" has no render of its own source and parameters, so there is nothing checked to export.");
    assert_eq!(refused.details.unwrap()["reason"], "NO_RENDER");
    assert_eq!(
        refused.repair.as_deref(),
        Some("Render it with Render r3 in the part view, then export again.")
    );
    let refused = export(agent(), json!({"revisionId": edited}))
        .err()
        .unwrap();
    assert_eq!(
        refused.repair.as_deref(),
        Some("Render it with cad_write_source, check it with cad_check, then export again.")
    );
    assert!(
        sandbox.jobs("cad_export").len() == 2,
        "a refused plan opens no job"
    );
    // Not a mechanical part: STEP needs one.
    let note = sandbox
        .call(
            "artifact.create_draft",
            json!({"type": "note", "title": "Notes", "payload": {"markdown": "x"}}),
        )
        .unwrap();
    let error = sandbox
        .call(
            "cad.export",
            json!({"artifactId": note["artifact"]["id"], "revisionId": note["revision"]["id"], "format": "step", "destPath": "exports/n.step"}),
        )
        .err()
        .unwrap();
    assert_eq!(error.code, "VALIDATION");
    assert!(error.message.contains("not a mechanical part"));
}

#[cfg(unix)]
#[test]
fn stl_and_scad_exports_keep_working_and_are_recorded() {
    let dir = tempfile::tempdir().unwrap();
    let engine = StandIn::new(dir.path());
    engine.release();
    let sandbox = Sandbox::with_engine(&engine.executable);
    let part = stand_in_part(&sandbox);
    approve(&sandbox, &part);
    // The input shape and the answer of earlier builds.
    let dest = dir.path().join("copy/plate.stl");
    let result = sandbox
        .call(
            "cad.export",
            json!({"artifactId": part["artifactId"], "destPath": dest}),
        )
        .unwrap();
    assert_eq!(result["path"], json!(dest));
    assert_eq!(result["format"], "stl");
    assert_eq!(result["isBaseline"], true);
    assert_eq!(result["rendered"], true);
    let revision = sandbox.revision(&part["revisionId"]);
    let stored = sandbox.with_handle(|handle| {
        handle
            .object_store()
            .unwrap()
            .read(revision["payload"]["stl"]["sha256"].as_str().unwrap())
            .unwrap()
    });
    assert_eq!(fs::read(&dest).unwrap(), stored);
    let scad = sandbox
        .call(
            "cad.export",
            json!({"artifactId": part["artifactId"], "destPath": dir.path().join("plate.scad"), "format": "scad"}),
        )
        .unwrap();
    assert_eq!(scad["notes"], json!([]));
    assert!(fs::read_to_string(dir.path().join("plate.scad"))
        .unwrap()
        .contains("cube([w, 10, 2])"));
    let events = exported_events(&sandbox);
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["data"]["format"], "stl");
    assert_eq!(events[0]["data"]["bytes"], stored.len());
    // A copy is not staged and keeps the idempotency contract: a retry writes nothing more.
    let keyed = || {
        dispatch_shared(
            &sandbox.core,
            "cad.export",
            json!({"artifactId": part["artifactId"], "destPath": "exports/plate.stl"}),
            Origin::User,
            Some(&sandbox.project_id),
            Some("export-1"),
        )
    };
    let first = keyed().unwrap();
    let again = keyed().unwrap();
    assert_eq!(again["path"], first["path"]);
    assert_eq!(again["idempotent"], true);
    assert_eq!(exported_events(&sandbox).len(), 3);
    assert!(sandbox.jobs("cad_export").is_empty(), "a copy runs no job");
    // Any artifact's stored file, as before.
    let missing = sandbox
        .call(
            "cad.export",
            json!({"artifactId": part["artifactId"], "destPath": dir.path().join("x.stl"), "format": "scad", "revisionId": part["revisionId"]}),
        );
    assert!(missing.is_ok());
}

/* ------------------------------------------------------------------ */
/* With OpenSCAD                                                        */
/* ------------------------------------------------------------------ */

#[cfg(unix)]
#[test]
fn step_csg_is_evaluated_with_the_recorded_parameters() {
    if !engine_available() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let sandbox = Sandbox::new();
    let kept = dir.path().join("kept.csg");
    set_python(
        &sandbox,
        &fake_python(
            dir.path(),
            "python3",
            &format!("cp output.csg '{}'\necho 'no answer here'", kept.display()),
        ),
    );
    let part = sandbox
        .call(
            "cad.write_source",
            json!({"title": "Plate", "source": PLATE}),
        )
        .unwrap();
    let wider = sandbox
        .call(
            "cad.set_param",
            json!({"artifactId": part["artifactId"], "name": "hole_d", "value": 5}),
        )
        .unwrap();
    let result = sandbox
        .call(
            "cad.export",
            json!({"artifactId": part["artifactId"], "revisionId": wider["revisionId"], "format": "step", "destPath": dir.path().join("p.step")}),
        )
        .unwrap();
    assert_eq!(
        result["reason"],
        "The exact converter ended without an answer: no answer here"
    );
    let csg = fs::read_to_string(&kept).unwrap();
    assert_eq!(csg.matches("r1 = 2.5").count(), 4, "{csg}");
    assert!(!csg.contains("r1 = 1.6"));
}

#[test]
fn a_part_exports_as_a_faceted_step_with_its_event_and_job() {
    if !engine_available() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let sandbox = Sandbox::new();
    let part = sandbox
        .call(
            "cad.write_source",
            json!({"title": "Plate", "source": PLATE}),
        )
        .unwrap();
    let dest = dir.path().join("plate.step");
    let result = sandbox
        .call(
            "cad.export",
            json!({"artifactId": part["artifactId"], "revisionId": part["revisionId"], "format": "step", "destPath": dest, "method": "faceted"}),
        )
        .unwrap();
    // $fn = 64 was injected: top, bottom, four sides and 4 × 64 hole facets.
    assert_eq!(result["faces"], 262, "{result}");
    assert_eq!(result["solids"], 1);
    assert_eq!(result["method"], "faceted");
    assert!(result["checks"]["volumeErrorPct"].as_f64().unwrap() < 1e-6);
    assert_eq!(
        result["checks"]["outputHash"],
        sandbox.revision(&part["revisionId"])["payload"]["stl"]["sha256"]
    );
    let bytes = fs::read(&dest).unwrap();
    assert!(bytes.starts_with(b"ISO-10303-21;"));
    assert_eq!(result["bytes"], bytes.len());
    let event = &exported_events(&sandbox)[0];
    assert_eq!(event["data"]["format"], "step");
    assert_eq!(event["data"]["exact"], false);
    let job = &sandbox.jobs("cad_export")[0];
    assert_eq!(job["status"], "succeeded");
    assert_eq!(
        job["outputHashes"]["step"],
        omenflow_storage::sha256_hex(&bytes)
    );
    assert_eq!(
        job["inputHashes"]["stl"],
        sandbox.revision(&part["revisionId"])["payload"]["stl"]["sha256"]
    );
    // The same revision writes the same bytes.
    sandbox
        .call(
            "cad.export",
            json!({"artifactId": part["artifactId"], "revisionId": part["revisionId"], "format": "step", "destPath": dir.path().join("again.step"), "method": "faceted"}),
        )
        .unwrap();
    assert_eq!(fs::read(dir.path().join("again.step")).unwrap(), bytes);
}

/* ------------------------------------------------------------------ */
/* Opt-in: the real converter                                           */
/* ------------------------------------------------------------------ */

const INSTALL: &str = "uv venv --python 3.12 ~/.omenflow-step && uv pip install --python ~/.omenflow-step/bin/python cadquery-ocp-novtk==7.9.3.1.1, then OMENFLOW_PYTHON=~/.omenflow-step/bin/python";

/// The Python with OCP an opt-in test uses, or `None` when the test is not asked for.
fn converter_python(variable: &str) -> Option<python::Python> {
    if std::env::var_os(variable).is_none() {
        eprintln!("SKIPPED: set {variable} (and OMENFLOW_PYTHON) to run the real STEP converter");
        return None;
    }
    let path = std::env::var_os("OMENFLOW_PYTHON")
        .map(PathBuf::from)
        .unwrap_or_else(|| panic!("{variable} needs a Python with OCP: {INSTALL}"));
    let found = python::find(Some(&path), &|| false, None, true)
        .unwrap()
        .found
        .unwrap_or_else(|| panic!("{} cannot import OCP: {INSTALL}", path.display()));
    Some(found)
}

/// The CSG tree of `source` with `params`, from the real engine.
fn csg_of(source: &str, params: &Value) -> String {
    let engine = engine::engine(None).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let (scad, csg) = (
        temp.path().join("input.scad"),
        temp.path().join("output.csg"),
    );
    let request = render::Request::new(source, params, 60_000);
    fs::write(&scad, source).unwrap();
    let (args, _) = render::engine_args(&request, &scad, render::Output::Csg(&csg)).unwrap();
    let run = engine::run(
        &engine.exe,
        &args,
        Duration::from_secs(60),
        temp.path(),
        &|| false,
    )
    .unwrap();
    assert!(run.ok, "{}", run.log);
    fs::read_to_string(csg).unwrap()
}

/// The CSG tree with the last child of its first `difference()` taken out:
/// a cutter the converter "lost". `None` when there is no such child.
fn without_last_cutter(csg: &str) -> Option<String> {
    let start = csg.find("difference() {")? + "difference() ".len();
    let bytes = csg.as_bytes();
    let (mut depth, mut at, mut child_start, mut children) = (0, start, None, Vec::new());
    while at < bytes.len() {
        match bytes[at] {
            b'{' => {
                depth += 1;
                if depth == 2 && child_start.is_none() {
                    child_start = Some(at);
                }
            }
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
                if depth == 1 {
                    if let Some(from) = child_start.take() {
                        children.push((from, at + 1));
                    }
                }
            }
            b';' if depth == 1 => {
                if let Some(from) = child_start.take() {
                    children.push((from, at + 1));
                }
            }
            c if depth == 1 && child_start.is_none() && !c.is_ascii_whitespace() => {
                child_start = Some(at)
            }
            _ => {}
        }
        at += 1;
    }
    let (from, to) = *children.get(1..)?.last()?;
    Some(format!("{}{}", &csg[..from], &csg[to..]))
}

/// The CSG tree with one leaf primitive taken out of what its first
/// `difference()` subtracts (one hole of a pattern, say), or `None`.
fn without_one_cutter(csg: &str) -> Option<String> {
    let whole = without_last_cutter(csg)?;
    // The subtracted children are what the first variant removed; find a leaf in them.
    let start = csg.find("difference() {")?;
    let same = csg
        .bytes()
        .zip(whole.bytes())
        .skip(start)
        .take_while(|(a, b)| a == b)
        .count()
        + start;
    let removed = &csg[same..same + (csg.len() - whole.len())];
    let leaf = removed.lines().rev().find(|line| {
        let line = line.trim_start();
        ["cylinder(", "cube(", "sphere(", "polyhedron("]
            .iter()
            .any(|name| line.starts_with(name))
            && line.ends_with(");")
    })?;
    let at = same + removed.rfind(leaf)?;
    Some(format!("{}{}", &csg[..at], &csg[at + leaf.len()..]))
}

/// Rebuild `csg` with the real converter and compare it with `mesh`.
fn rebuild_csg(python: &python::Python, csg: &str, mesh: &mesh::Mesh) -> Result<Rebuilt, String> {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("output.csg"), csg).unwrap();
    let deadline = Instant::now() + Duration::from_secs(300);
    match rebuild(
        python,
        temp.path(),
        mesh,
        "seeded",
        deadline,
        300_000,
        &|| false,
        &mut Trail::default(),
    ) {
        Ok(rebuilt) => Ok(rebuilt),
        Err(Attempt::Fallback(reason)) => Err(reason),
        Err(Attempt::Stop(error)) => panic!("{error:?}"),
    }
}

#[test]
fn seeded_trees_lose_a_cutter_and_nothing_else() {
    let csg = "difference() {\n\tcube(size = [40, 30, 4], center = false);\n\tgroup() {\n\t\tmultmatrix([[1, 0, 0, 5], [0, 1, 0, 5], [0, 0, 1, -1], [0, 0, 0, 1]]) {\n\t\t\tcylinder($fn = 64, h = 6, r1 = 1.6, r2 = 1.6, center = false);\n\t\t}\n\t\tmultmatrix([[1, 0, 0, 35], [0, 1, 0, 5], [0, 0, 1, -1], [0, 0, 0, 1]]) {\n\t\t\tcylinder($fn = 64, h = 6, r1 = 2.6, r2 = 2.6, center = false);\n\t\t}\n\t}\n}\n";
    let whole = without_last_cutter(csg).unwrap();
    assert!(whole.contains("cube(size = [40, 30, 4]"));
    assert!(!whole.contains("cylinder("), "{whole}");
    let leaf = without_one_cutter(csg).unwrap();
    assert!(
        leaf.contains("r1 = 1.6") && !leaf.contains("r1 = 2.6"),
        "{leaf}"
    );
    assert_eq!(leaf.matches('{').count(), leaf.matches('}').count());
    assert!(without_last_cutter("cube(size = [1, 1, 1], center = false);\n").is_none());
}

/// `OMENFLOW_STEP_E2E=1 OMENFLOW_PYTHON=<python with OCP>`.
#[test]
fn exact_step_of_the_plate_end_to_end() {
    let Some(python) = converter_python("OMENFLOW_STEP_E2E") else {
        return;
    };
    if !engine_available() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let sandbox = Sandbox::new();
    set_python(&sandbox, &python.exe);
    let part = sandbox
        .call(
            "cad.write_source",
            json!({"title": "Plate", "source": PLATE}),
        )
        .unwrap();
    let dest = dir.path().join("plate.step");
    let result = sandbox
        .call(
            "cad.export",
            json!({"artifactId": part["artifactId"], "revisionId": part["revisionId"], "format": "step", "destPath": dest}),
        )
        .unwrap();
    eprintln!("{result:#}");
    assert_eq!(result["method"], "brep", "{result}");
    assert_eq!(result["exact"], true);
    assert_eq!(result["faces"], 10);
    assert_eq!(result["solids"], 1);
    assert!(result["checks"]["volumeErrorPct"].as_f64().unwrap() < 0.2);
    assert!(result["checks"]["sampleMismatches"].as_u64().unwrap() <= 2);
    assert_eq!(result["checks"]["surfaceMismatches"], 0);
    let text = fs::read_to_string(&dest).unwrap();
    assert!(text.matches("CYLINDRICAL_SURFACE").count() >= 4);
    // A tree the converter rebuilt without one of two small holes in a large plate is refused:
    // volume and box cannot tell, the probes at the hole's wall can.
    let source = "$fn = 64;\ndifference() {\n  cube([100, 100, 5]);\n  translate([50, 50, -1]) cylinder(d = 3, h = 7);\n  translate([20, 20, -1]) cylinder(d = 3, h = 7);\n}\n";
    let mesh = rendered_mesh(&sandbox, source);
    let csg = csg_of(source, &json!({}));
    assert!(rebuild_csg(&python, &csg, &mesh).is_ok());
    let seeded = without_last_cutter(&csg).unwrap();
    let reason = rebuild_csg(&python, &seeded, &mesh).err().unwrap();
    assert!(
        reason.contains("probe pairs at the render's faces classify differently"),
        "{reason}"
    );
}

/// The render of `source`, as `cad_write_source` stored it.
fn rendered_mesh(sandbox: &Sandbox, source: &str) -> Arc<mesh::Mesh> {
    let part = sandbox
        .call(
            "cad.write_source",
            json!({"title": "Seeded", "source": source}),
        )
        .unwrap();
    let revision = sandbox.revision(&part["revisionId"]);
    sandbox.with_handle(|handle| {
        let workspace = Workspace::new(&handle.root, None, &|| false).unwrap();
        render::stored_mesh(
            &workspace,
            revision["payload"]["stl"]["sha256"].as_str().unwrap(),
        )
        .unwrap()
    })
}

/// `OMENFLOW_STEP_E2E=1 OMENFLOW_PYTHON=<python with OCP>`: small holes that a large
/// transform or a revolution elsewhere in the tree once hid from the probes, and empty
/// operands, which OpenSCAD keeps as operands.
#[test]
fn exact_rebuilds_follow_openscad_and_a_lost_small_hole_is_refused() {
    let Some(python) = converter_python("OMENFLOW_STEP_E2E") else {
        return;
    };
    if !engine_available() {
        return;
    }
    let sandbox = Sandbox::new();
    for source in [
        // scale() around a unit cube, a ⌀2 hole and a ⌀20 boss beside it.
        "$fn = 64;\ndifference() {\n  scale([100, 100, 5]) cube(1);\n  translate([50, 50, -1]) cylinder(d = 2, h = 7);\n}\ntranslate([130, 50, 0]) cylinder(r = 10, h = 5);\n",
        // A plate 1000 mm from the origin with a ⌀2 hole made by a revolution.
        "translate([1000, 0, 0]) difference() {\n  cube([100, 100, 5]);\n  translate([50, 50, -1]) rotate_extrude($fn = 64) square([1, 7]);\n}\n",
    ] {
        let mesh = rendered_mesh(&sandbox, source);
        let csg = csg_of(source, &json!({}));
        let whole = rebuild_csg(&python, &csg, &mesh).unwrap_or_else(|reason| panic!("{reason}"));
        assert_eq!(whole.checks["surfaceMismatches"], 0, "{}", whole.checks);
        let reason = rebuild_csg(&python, &without_last_cutter(&csg).unwrap(), &mesh)
            .err()
            .unwrap_or_else(|| panic!("a lost hole was accepted: {source}"));
        assert!(reason.contains("classify differently"), "{reason}");
    }
    // An intersection with an empty operand is empty, and so is a difference from one: the
    // ⌀3 boss is not in the render, and must not be in the STEP.
    let plate = "module clip(on) { if (on) cube([2, 2, 2]); }\nmodule body(on) { if (on) cube([10, 10, 10]); }\nunion() {\n  cube([100, 100, 5]);\n  translate([80, 80, 0]) cylinder(r = 5, h = 25, $fn = 64);\n  translate([30, 30, 5]) BOSS;\n}\n";
    let exact = 100.0 * 100.0 * 5.0 + std::f64::consts::PI * 25.0 * 20.0;
    for boss in [
        "intersection() { cylinder(r = 1.5, h = 2, $fn = 32); clip(false); }",
        "difference() { body(false); cylinder(r = 1.5, h = 2, $fn = 32); }",
    ] {
        let source = plate.replace("BOSS", boss);
        let mesh = rendered_mesh(&sandbox, &source);
        let csg = csg_of(&source, &json!({}));
        assert!(csg.contains("group();"), "{csg}");
        let rebuilt = rebuild_csg(&python, &csg, &mesh).unwrap_or_else(|reason| panic!("{reason}"));
        let volume = rebuilt.answer["volume"].as_f64().unwrap();
        assert!(
            (volume - exact).abs() < 0.5,
            "{boss}: {volume} mm³, not {exact}"
        );
    }
    // A sweep of a 2D union is one solid, as the render is one body; a partial revolution
    // starts where OpenSCAD starts it.
    for source in [
        "linear_extrude(5) union() { square(10); translate([10, 0]) square(10); translate([5, 5]) circle(r = 8, $fn = 64); }\n",
        "rotate_extrude(angle = 90, start = 45, $fn = 48) translate([3, 0]) square([2, 5]);\n",
    ] {
        let mesh = rendered_mesh(&sandbox, source);
        let csg = csg_of(source, &json!({}));
        let rebuilt = rebuild_csg(&python, &csg, &mesh).unwrap_or_else(|reason| panic!("{source}: {reason}"));
        assert_eq!(rebuilt.answer["solids"], 1, "{source}");
        assert_eq!(rebuilt.checks["surfaceMismatches"], 0, "{source}");
    }
}

/// `OMENFLOW_STEP_E2E=1 OMENFLOW_PYTHON=<python with OCP>`: a shallow dimple meets the plate
/// at about 11°, so it shares the top's probe pairs and gets one or two. A tree that lost it
/// beside a deep one it kept (both trees give the probes the same facet bound) is refused;
/// volume, box and the points through the box cannot tell.
#[test]
fn a_lost_shallow_dimple_is_refused() {
    let Some(python) = converter_python("OMENFLOW_STEP_E2E") else {
        return;
    };
    if !engine_available() {
        return;
    }
    let sandbox = Sandbox::new();
    for depth in [0.15, 0.2, 0.25] {
        let source = format!(
            "difference() {{\n  cube([100, 100, 5]);\n  translate([20, 20, 13]) sphere(r = 10, $fn = 64);\n  translate([70, 70, {}]) sphere(r = 10, $fn = 64);\n}}\n",
            15.0 - depth
        );
        let mesh = rendered_mesh(&sandbox, &source);
        let csg = csg_of(&source, &json!({}));
        let whole =
            rebuild_csg(&python, &csg, &mesh).unwrap_or_else(|reason| panic!("{depth}: {reason}"));
        assert_eq!(whole.checks["surfaceMismatches"], 0, "{}", whole.checks);
        let seeded = without_last_cutter(&csg).unwrap();
        assert_eq!(seeded.matches("sphere(").count(), 1, "{seeded}");
        let reason = rebuild_csg(&python, &seeded, &mesh)
            .err()
            .unwrap_or_else(|| panic!("a lost dimple {depth} mm deep was accepted"));
        assert!(
            reason.contains("probe pairs at the render's faces classify differently"),
            "{reason}"
        );
    }
}

/// `OMENFLOW_STEP_E2E=1 OMENFLOW_PYTHON=<python with OCP>`: a tree of flat faces (a hexagonal
/// pyramid 1.5 to 3 mm in radius cut 0.2 to 0.3 mm into a plate, meeting it at 5° to 10°),
/// whose facets are its exact faces, so the facet bound is 0 and every pair sits at the
/// smallest offset. A tree that lost the pyramid, or one that adds it as a bump the render has
/// not, is refused although only one or two pairs land on it; volume, box and the points
/// through the box cannot tell.
#[test]
fn a_lost_or_added_flat_dimple_is_refused() {
    let Some(python) = converter_python("OMENFLOW_STEP_E2E") else {
        return;
    };
    if !engine_available() {
        return;
    }
    let sandbox = Sandbox::new();
    let plate = "cube([100, 100, 5]);\n";
    let plain = rendered_mesh(&sandbox, plate);
    for (radius, depth) in [(2.0, 0.2), (2.5, 0.2), (3.0, 0.25), (2.0, 0.3), (1.5, 0.2)] {
        // A cone of 6 facets, its apex `depth` under the top and `radius` wide there.
        let pyramid = format!("cylinder(h = 1, r1 = 0, r2 = {}, $fn = 6)", radius / depth);
        let source = format!(
            "difference() {{\n  cube([100, 100, 5]);\n  translate([50.3, 50.6, {}]) {pyramid};\n}}\n",
            5.0 - depth
        );
        let mesh = rendered_mesh(&sandbox, &source);
        let csg = csg_of(&source, &json!({}));
        assert_eq!(csg_sagitta(&csg, &mesh), 0.0, "{csg}");
        let whole = rebuild_csg(&python, &csg, &mesh)
            .unwrap_or_else(|reason| panic!("{radius}, {depth}: {reason}"));
        assert_eq!(whole.checks["surfaceMismatches"], 0, "{}", whole.checks);
        assert_eq!(whole.checks["solidMismatches"], 0, "{}", whole.checks);
        let seeded = without_last_cutter(&csg).unwrap();
        assert!(!seeded.contains("cylinder("), "{seeded}");
        let reason = rebuild_csg(&python, &seeded, &mesh)
            .err()
            .unwrap_or_else(|| panic!("a lost dimple r{radius} × {depth} mm was accepted"));
        assert!(reason.contains("classify differently"), "{reason}");
        // The same pyramid upside down on the plate, against the plain plate's render.
        let bump = format!(
            "union() {{\n  cube([100, 100, 5]);\n  translate([50.3, 50.6, {}]) mirror([0, 0, 1]) {pyramid};\n}}\n",
            5.0 + depth
        );
        let reason = rebuild_csg(&python, &csg_of(&bump, &json!({})), &plain)
            .err()
            .unwrap_or_else(|| panic!("an added bump r{radius} × {depth} mm was accepted"));
        assert!(reason.contains("classify differently"), "{reason}");
    }
}

/// `OMENFLOW_STEP_E2E=1 OMENFLOW_PYTHON=<python with OCP>`: correct rebuilds of trees of flat
/// faces, where only rounding may explain a disagreement, agree at every pair and point: rotated
/// and scaled cubes, polygons, a polyhedron, 3- to 8-facet holes, 0.5 mm walls, a 0.001 mm
/// step, a 2 m plate and a plate 2.2 m from the origin.
#[test]
fn exact_rebuilds_of_flat_trees_agree_everywhere() {
    let Some(python) = converter_python("OMENFLOW_STEP_E2E") else {
        return;
    };
    if !engine_available() {
        return;
    }
    let sandbox = Sandbox::new();
    for source in [
        "difference() { rotate([12, 23, 34]) cube([40, 30, 10]); rotate([5, 0, 0]) translate([5, 5, -1]) cube([10, 10, 20]); }\n",
        "difference() { linear_extrude(8) polygon([[0, 0], [40, 0], [40, 10], [30, 25], [10, 25], [0, 10]]); translate([20, 10, -1]) cylinder(r = 3, h = 20, $fn = 6); }\n",
        "translate([1000, 2000, 0]) difference() { cube([50, 50, 5]); translate([10, 10, -1]) cube([5, 5, 7]); }\n",
        "for (i = [0:9]) translate([i * 5, 0, 0]) cube([5, 20, i + 1]);\n",
        "polyhedron(points = [[0, 0, 0], [30, 0, 0], [0, 30, 0], [0, 0, 30]], faces = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]]);\n",
        "union() { cube(10); translate([10, 0, 0]) cube([10, 10, 10.001]); }\n",
        "intersection() { scale([1.3, 0.7, 1]) rotate([0, 0, 17]) cube([20, 20, 3]); translate([2, -5, -1]) cube([18, 18, 5]); }\n",
        "rotate([30, 40, 50]) difference() { cube([30, 30, 30], center = true); cylinder(r = 8, h = 40, center = true, $fn = 8); rotate([90, 0, 0]) cylinder(r = 8, h = 40, center = true, $fn = 8); }\n",
        "difference() { cube([20, 20, 20]); translate([0.5, 0.5, 0.5]) cube([19, 19, 20]); }\n",
        "difference() { cube([2000, 1500, 20]); for (x = [100:300:1900]) translate([x, 750, -1]) cylinder(r = 20, h = 30, $fn = 6); }\n",
        "difference() { cube([100, 60, 8]); for (x = [10:10:90]) translate([x, 30, 4]) rotate([0, 45, 0]) cube([3, 70, 3], center = true); }\n",
        "linear_extrude(height = 12) difference() { square([60, 40]); translate([30, 20]) circle(r = 10, $fn = 5); translate([5, 5]) square([10, 0.6]); }\n",
    ] {
        let mesh = rendered_mesh(&sandbox, source);
        let csg = csg_of(source, &json!({}));
        assert_eq!(csg_sagitta(&csg, &mesh), 0.0, "{source}");
        let rebuilt =
            rebuild_csg(&python, &csg, &mesh).unwrap_or_else(|reason| panic!("{source}: {reason}"));
        for key in ["surfaceMismatches", "solidMismatches", "sampleMismatches"] {
            assert_eq!(rebuilt.checks[key], 0, "{source}: {}", rebuilt.checks);
        }
    }
}

/// Shared by the corpus run's report lines.
static CORPUS_LINES: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// The exporter over recorded projects, each `<id>/project` under
/// `OMENFLOW_STEP_CORPUS` (copied first; the originals are never opened).
/// Prints one JSON line per part: the product export, and whether a copy of
/// its CSG tree missing the last cutter of its first `difference()` is
/// refused. `OMENFLOW_STEP_CORPUS_OUT` keeps the STEP files and the lines;
/// `OMENFLOW_STEP_CORPUS_FACETED=1` also writes every part faceted.
#[test]
fn step_corpus_parity() {
    let Some(python) = converter_python("OMENFLOW_STEP_CORPUS") else {
        return;
    };
    if !engine_available() {
        return;
    }
    let corpus = PathBuf::from(std::env::var_os("OMENFLOW_STEP_CORPUS").unwrap());
    let out = std::env::var_os("OMENFLOW_STEP_CORPUS_OUT").map(PathBuf::from);
    let scratch = tempfile::tempdir().unwrap();
    let out = out.unwrap_or_else(|| scratch.path().join("out"));
    fs::create_dir_all(&out).unwrap();
    let mut ids = fs::read_dir(&corpus)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().join("project/omenflow.project.json").is_file())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    ids.sort();
    if let Some(only) = std::env::var_os("OMENFLOW_STEP_CORPUS_ONLY") {
        let only = only
            .to_string_lossy()
            .split(',')
            .map(str::to_owned)
            .collect::<Vec<_>>();
        ids.retain(|id| only.contains(id));
    }
    for id in ids {
        let project = scratch.path().join(&id);
        copy_tree(&corpus.join(&id).join("project"), &project);
        let mut app = CoreApp::new(scratch.path().join(format!("{id}-app"))).unwrap();
        app.dispatch(
            "settings.set",
            json!({"key": "toolPaths.python", "value": python.exe}),
            Origin::User,
            None,
        )
        .unwrap();
        let opened = app
            .dispatch("project.open", json!({"path": project}), Origin::User, None)
            .unwrap();
        let project_id = opened["projectId"].as_str().unwrap().to_owned();
        let parts = app
            .dispatch(
                "artifact.list",
                json!({"type": "mechanical"}),
                Origin::User,
                Some(&project_id),
            )
            .unwrap();
        let Some(artifact_id) = parts["artifacts"]
            .as_array()
            .and_then(|list| list.last())
            .and_then(|view| view["artifact"]["id"].as_str().or(view["id"].as_str()))
            .map(str::to_owned)
        else {
            continue;
        };
        let read = app
            .dispatch(
                "cad.read_source",
                json!({"artifactId": artifact_id}),
                Origin::User,
                Some(&project_id),
            )
            .unwrap();
        let revision_id = read["revisionId"].as_str().unwrap().to_owned();
        let started = Instant::now();
        let exported = app.dispatch(
            "cad.export",
            json!({"artifactId": artifact_id, "revisionId": revision_id, "format": "step", "destPath": out.join(format!("{id}.step"))}),
            Origin::User,
            Some(&project_id),
        );
        let seconds = started.elapsed().as_secs_f64();
        let mut line = match &exported {
            Ok(result) => json!({"id": id, "method": result["method"], "exact": result["exact"],
                "reason": result["reason"], "faces": result["faces"], "solids": result["solids"],
                "bytes": result["bytes"], "checks": result["checks"], "notes": result["notes"],
                "approximations": result["approximations"], "seconds": seconds}),
            Err(error) => json!({"id": id, "error": error, "seconds": seconds}),
        };
        if std::env::var_os("OMENFLOW_STEP_CORPUS_FACETED").is_some() {
            let faceted = app.dispatch(
                "cad.export",
                json!({"artifactId": artifact_id, "revisionId": revision_id, "format": "step", "method": "faceted", "destPath": out.join(format!("{id}-faceted.step"))}),
                Origin::User,
                Some(&project_id),
            );
            line["faceted"] = match faceted {
                Ok(result) => {
                    json!({"faces": result["faces"], "bytes": result["bytes"], "checks": result["checks"]})
                }
                Err(error) => json!({"error": error}),
            };
        }
        // The seeded variant: the same render, a tree missing one cutter.
        let handle = &app.projects[&project_id];
        let revision = require_revision(handle, &revision_id).unwrap();
        let mesh = {
            let workspace = Workspace::new(&handle.root, None, &|| false).unwrap();
            render::stored_mesh(
                &workspace,
                revision["payload"]["stl"]["sha256"].as_str().unwrap(),
            )
            .unwrap()
        };
        let source = source_of(handle, &revision).unwrap().1;
        let params = Value::Object(
            params::effective_params(&revision["payload"]["renderIdentity"]["params"]).unwrap(),
        );
        let tree = csg_of(&source, &params);
        for (key, seeded) in [
            ("seeded", without_last_cutter(&tree)),
            ("seededLeaf", without_one_cutter(&tree)),
        ] {
            if let Some(seeded) = seeded {
                line[key] = match rebuild_csg(&python, &seeded, &mesh) {
                    Ok(rebuilt) => json!({"refused": false, "checks": rebuilt.checks}),
                    Err(reason) => json!({"refused": true, "reason": reason}),
                };
            }
        }
        let text = line.to_string();
        println!("{text}");
        CORPUS_LINES.lock().unwrap().push(text);
    }
    fs::write(
        out.join("corpus.jsonl"),
        CORPUS_LINES.lock().unwrap().join("\n"),
    )
    .unwrap();
}
