//! CAD operations end to end, through `dispatch_shared`, against the real
//! OpenSCAD engine.
use super::testing::*;
use super::*;

fn write(sandbox: &Sandbox, title: &str, source: &str) -> Value {
    sandbox
        .call(
            "cad.write_source",
            json!({"title": title, "source": source, "timeoutMs": 60_000}),
        )
        .unwrap()
}

fn plate(sandbox: &Sandbox) -> Value {
    let report = write(sandbox, "Sensor plate", PLATE);
    assert_eq!(report["render"]["ok"], true, "{report}");
    report
}

fn check(sandbox: &Sandbox, artifact_id: &Value, extra: Value) -> Value {
    let mut input = json!({"artifactId": artifact_id});
    input
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().cloned().unwrap());
    sandbox.call("cad.check", input).unwrap()
}

fn evidence(sandbox: &Sandbox, result: &Value) -> Value {
    sandbox.with_handle(|handle| {
        let bytes = handle
            .object_store()
            .unwrap()
            .read(result["evidenceHash"].as_str().unwrap())
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    })
}

fn readiness_of(sandbox: &Sandbox, revision_id: &Value) -> Value {
    let revision = sandbox.revision(revision_id);
    sandbox.with_handle(|handle| readiness(handle, &revision).unwrap())
}

#[test]
fn write_source_renders_measures_and_records_the_job() {
    if !engine_available() {
        return;
    }
    let sandbox = Sandbox::new();
    let (report, events) = sandbox.call_with_events(
        "cad.write_source",
        json!({"title": "Sensor plate", "source": PLATE, "timeoutMs": 60_000}),
    );
    let report = report.unwrap();
    assert_eq!(report["render"]["ok"], true, "{report}");
    assert_eq!(
        report["sourcePath"],
        "artifacts/mechanical/sensor-plate.scad"
    );
    assert_eq!(
        report["geometry"]["bounds"]["size"],
        json!([40.0, 30.0, 4.0])
    );
    assert_eq!(report["geometry"]["shells"], 1);
    assert_eq!(report["geometry"]["watertight"], true);
    let mid = report["sections"][0]["loops"].as_array().unwrap();
    assert_eq!(mid.len(), 5, "{mid:?}");
    assert_eq!(mid[0], "material rectangle 40×30 centered (x=20, y=15)");
    assert!(mid[1..].iter().all(|item| item
        .as_str()
        .unwrap()
        .starts_with("cut-out circle d=3.2 at ")));
    assert_eq!(
        report["parameters"],
        json!([
            {"name": "$fn", "value": 64, "derived": false},
            {"name": "hole_d", "value": 3.2, "derived": false},
            {"name": "inset", "value": 5, "derived": false},
        ])
    );
    let notes = report["notes"].as_array().unwrap();
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert!(notes[0].as_str().unwrap().starts_with("Injected $fn = 64"));
    assert_eq!(report["nextStep"]["tool"], "cad_check");

    let revision = sandbox.revision(&report["revisionId"]);
    assert_eq!(revision["files"].as_array().unwrap().len(), 2);
    assert_eq!(
        revision["payload"]["paramManifest"][1],
        json!({"name": "hole_d", "dimension": "number"})
    );
    let jobs = sandbox.jobs("cad_render");
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0]["status"], "succeeded");
    assert_eq!(revision["payload"]["renderJobId"], jobs[0]["id"]);
    assert_eq!(
        jobs[0]["outputHashes"]["stl"],
        revision["payload"]["stl"]["sha256"]
    );
    let kinds = events
        .iter()
        .map(|event| {
            format!(
                "{} {}",
                event["type"].as_str().unwrap(),
                event["data"]["status"].as_str().unwrap_or("")
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        kinds,
        vec![
            "job.updated running",
            "revision.committed ",
            "job.updated succeeded"
        ]
    );
    assert!(events
        .iter()
        .all(|event| event["projectId"] == sandbox.project_id));
    assert_eq!(events[0]["data"]["kind"], "cad_render");
    assert_eq!(events[0]["data"]["artifactId"], report["artifactId"]);

    let source = sandbox
        .call(
            "cad.read_source",
            json!({"artifactId": report["artifactId"]}),
        )
        .unwrap();
    assert_eq!(source["hasRender"], true);
    assert!(source["source"]
        .as_str()
        .unwrap()
        .starts_with("$fn = 64;\n"));
    assert_eq!(
        readiness_of(&sandbox, &report["revisionId"])["status"],
        "unverified"
    );
}

#[test]
fn auto_commit_verifies_in_one_call_with_the_strength_of_trial_then_commit() {
    if !engine_available() {
        return;
    }
    let sandbox = Sandbox::new();
    let one = plate(&sandbox);
    let single = check(
        &sandbox,
        &one["artifactId"],
        json!({"expect": plate_expectation(), "autoCommit": true}),
    );
    assert_eq!(single["ready"], true, "{single}");
    assert_eq!(single["verificationStatus"], "passed");
    assert_eq!(single["committed"], true);
    assert_eq!(single["exploratory"], false);
    assert_eq!(
        (&single["passed"], &single["total"]),
        (&json!(11), &json!(11))
    );
    assert_eq!(single["nextAction"], "request_review");
    assert_eq!(single["expectChanged"], true);
    assert!(single["ignored"].as_array().unwrap().is_empty());
    assert_eq!(
        single["normalizedExpect"]["sections"],
        json!([{"axis": "z", "at": 2, "holes": [
            {"center": [5, 5], "d": 3.2}, {"center": [35, 5], "d": 3.2},
            {"center": [5, 25], "d": 3.2}, {"center": [35, 25], "d": 3.2}]}])
    );
    assert_eq!(single["normalizedExpect"]["shells"], 1);
    let ready = readiness_of(&sandbox, &one["revisionId"]);
    assert_eq!(
        (&ready["status"], &ready["ready"]),
        (&json!("passed"), &json!(true))
    );
    assert_eq!(ready["evidenceHash"], single["evidenceHash"]);
    assert_eq!(
        sandbox.with_handle(|handle| build::preview(handle, false).unwrap())["counts"]["ready"],
        0
    );

    // The same part and expectation through the two-step protocol.
    let two = plate(&sandbox);
    let trial = check(
        &sandbox,
        &two["artifactId"],
        json!({"expect": plate_expectation(), "exploratory": true}),
    );
    assert_eq!(
        (&trial["ready"], &trial["committed"]),
        (&json!(false), &json!(false))
    );
    assert_eq!(trial["verificationStatus"], "passed");
    assert_eq!(trial["nextAction"], "commit_assertions");
    assert_eq!(trial["nextStep"]["args"]["exploratory"], false);
    assert_eq!(
        readiness_of(&sandbox, &two["revisionId"])["status"],
        "unverified"
    );
    let committed = check(
        &sandbox,
        &two["artifactId"],
        json!({"expect": plate_expectation(), "exploratory": false}),
    );
    assert_eq!(committed["ready"], true);
    let (first, second) = (evidence(&sandbox, &single), evidence(&sandbox, &committed));
    for key in [
        "specHash",
        "expect",
        "checks",
        "status",
        "pass",
        "integrity",
        "scopeChanges",
        "exploratory",
        "checkerVersion",
        "coverage",
        "outputHash",
    ] {
        assert_eq!(first[key], second[key], "{key}");
    }
}

#[test]
fn a_failing_auto_commit_binds_nothing_and_says_fix_not_commit() {
    if !engine_available() {
        return;
    }
    let sandbox = Sandbox::new();
    let part = plate(&sandbox);
    let mut wrong = plate_expectation();
    wrong["holes"][0]["d"] = json!(4);
    let failed = check(
        &sandbox,
        &part["artifactId"],
        json!({"expect": wrong, "autoCommit": true}),
    );
    assert_eq!(failed["ready"], false);
    assert_eq!(failed["verificationStatus"], "failed");
    assert_eq!(
        (&failed["committed"], &failed["exploratory"]),
        (&json!(false), &json!(true))
    );
    assert_eq!(failed["nextAction"], "repair_geometry");
    assert_eq!(failed["work"]["nextAction"], "repair_geometry");
    assert_eq!(failed["nextStep"]["tool"], "cad_write_source");
    let next = failed["next"].as_str().unwrap();
    assert!(
        next.starts_with("Trial failed: 1 of 11 assertions. Nothing was committed."),
        "{next}"
    );
    assert!(next.contains("Do not commit a failing trial"));
    let line = failed["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|line| line["pass"] == false)
        .unwrap();
    assert!(
        line["detail"]
            .as_str()
            .unwrap()
            .contains("DIAMETER off by -0.8"),
        "{line}"
    );
    assert_eq!(
        readiness_of(&sandbox, &part["revisionId"])["status"],
        "unverified"
    );

    // Nothing was bound, so the corrected expectation verifies cleanly.
    let fixed = check(
        &sandbox,
        &part["artifactId"],
        json!({"expect": plate_expectation(), "autoCommit": true}),
    );
    assert_eq!(fixed["ready"], true, "{fixed}");
    assert!(fixed["scopeChanges"].as_array().unwrap().is_empty());

    // A committed check binds even when it fails; correcting it afterwards
    // is a scope change that a human has to accept.
    let other = plate(&sandbox);
    let bound = check(&sandbox, &other["artifactId"], json!({"expect": wrong}));
    assert_eq!(
        (&bound["verificationStatus"], &bound["committed"]),
        (&json!("failed"), &json!(true))
    );
    let corrected = check(
        &sandbox,
        &other["artifactId"],
        json!({"expect": plate_expectation(), "autoCommit": true}),
    );
    assert_eq!(corrected["verificationStatus"], "scope_changed");
    assert_eq!(
        (&corrected["ready"], &corrected["committed"]),
        (&json!(false), &json!(false))
    );
    assert_eq!(
        corrected["scopeChanges"],
        json!(["dropped previously failing assertions", "sections"])
    );
    assert_eq!(corrected["nextAction"], "restore_assertions");
    let ready = readiness_of(&sandbox, &other["revisionId"]);
    assert_eq!(ready["status"], "failed");
    assert_eq!(ready["failed"].as_array().unwrap().len(), 1);
}

#[test]
fn readiness_is_the_same_in_check_results_work_state_and_summaries() {
    if !engine_available() {
        return;
    }
    let sandbox = Sandbox::new();
    let part = plate(&sandbox);
    let passed = check(
        &sandbox,
        &part["artifactId"],
        json!({"expect": {"bbox": {"min": [0, 0, 0], "max": [40, 30, 4]}, "shells": 1}}),
    );
    assert_eq!(passed["verificationStatus"], "passed");
    let revision = sandbox.revision(&part["revisionId"]);
    sandbox.with_handle(|handle| {
        let latest = latest_verification(handle, &revision).unwrap();
        assert_eq!(latest["status"], passed["verificationStatus"]);
        assert_eq!(latest["ready"], passed["ready"]);
        assert_eq!(latest["nextAction"], passed["nextAction"]);
        assert_eq!(latest["evidenceHash"], passed["evidenceHash"]);
        let work: Value = serde_json::from_str(
            &handle
                .db
                .query_row(
                    "SELECT value FROM meta WHERE key='work.active'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(work["nextAction"], passed["nextAction"]);
        assert_eq!(work["candidateRevisionId"], part["revisionId"]);
        assert_eq!(work["specHash"], passed["specHash"]);
    });

    // The same numbers written as floats are the same scope.
    let floats = check(
        &sandbox,
        &part["artifactId"],
        json!({"expect": {"bbox": {"min": [0.0, 0.0, 0.0], "max": [40.0, 30.0, 4.0]}, "shells": 1.0}}),
    );
    assert_eq!(floats["verificationStatus"], "passed", "{floats}");
    assert_eq!(floats["specHash"], passed["specHash"]);

    // A trial never replaces the bound expectation; a reduced commit is a scope change.
    let trial = check(
        &sandbox,
        &part["artifactId"],
        json!({"expect": {"shells": 1}, "exploratory": true}),
    );
    assert_eq!(trial["verificationStatus"], "scope_changed");
    assert_eq!(trial["work"]["specHash"], passed["specHash"]);
    assert_eq!(
        readiness_of(&sandbox, &part["revisionId"])["status"],
        "passed"
    );
    let reduced = check(
        &sandbox,
        &part["artifactId"],
        json!({"expect": {"shells": 1}}),
    );
    assert_eq!(reduced["verificationStatus"], "scope_changed");
    assert_eq!(reduced["scopeChanges"], json!(["bbox"]));
    assert_eq!(reduced["work"]["specHash"], passed["specHash"]);
    let ready = readiness_of(&sandbox, &part["revisionId"]);
    assert_eq!(
        (&ready["status"], &ready["nextAction"]),
        (&json!("scope_changed"), &json!("restore_assertions"))
    );

    // A section that asserts nothing cannot pass, and generic checks alone are partial.
    let other = plate(&sandbox);
    let hollow = check(
        &sandbox,
        &other["artifactId"],
        json!({"expect": {"sections": [{"axis": "z", "at": 2}]}, "exploratory": true}),
    );
    assert_eq!(hollow["verificationStatus"], "failed");
    assert_eq!(hollow["nextAction"], "repair_geometry");
    let generic = check(
        &sandbox,
        &other["artifactId"],
        json!({"expect": {}, "autoCommit": true}),
    );
    assert_eq!(
        (&generic["verificationStatus"], &generic["committed"]),
        (&json!("partial"), &json!(false))
    );
}

#[test]
fn verification_history_is_not_cut_off_by_unrelated_checks() {
    if !engine_available() {
        return;
    }
    let sandbox = Sandbox::new();
    let part = plate(&sandbox);
    let passed = check(
        &sandbox,
        &part["artifactId"],
        json!({"expect": plate_expectation(), "autoCommit": true}),
    );
    assert_eq!(passed["ready"], true);
    sandbox.with_handle(|handle| {
        for index in 0..260 {
            handle.db.execute(
                "INSERT INTO job(id,kind,tool,inputs,status,log,output_hashes,created_at) VALUES(?1,'cad_check','omenflow-geometry',?2,'succeeded','','{}',?3)",
                params![format!("other-{index}"), json!({"artifactId": format!("part-{index}"), "revisionId": "r", "expect": {"shells": 1}}).to_string(), now()],
            ).unwrap();
        }
    });
    assert_eq!(
        readiness_of(&sandbox, &part["revisionId"])["status"],
        "passed"
    );
    let reduced = check(
        &sandbox,
        &part["artifactId"],
        json!({"expect": {"size": [40, 30, 4]}}),
    );
    assert_eq!(reduced["verificationStatus"], "scope_changed");
    assert_eq!(
        reduced["scopeChanges"],
        json!(["empty", "sections", "shells"])
    );
}

#[test]
fn repeated_and_failed_renders_come_from_the_cache() {
    if !engine_available() {
        return;
    }
    let sandbox = Sandbox::new();
    let first = plate(&sandbox);
    assert!(first["render"].get("cached").is_none());
    let again = sandbox
        .call(
            "cad.write_source",
            json!({"artifactId": first["artifactId"], "source": PLATE}),
        )
        .unwrap();
    assert_eq!(again["render"]["cached"], true, "{again}");
    assert!(again["render"]["tool"]
        .as_str()
        .unwrap()
        .ends_with("(cached)"));
    assert_eq!(again["geometry"], first["geometry"]);
    let (one, two) = (
        sandbox.revision(&first["revisionId"]),
        sandbox.revision(&again["revisionId"]),
    );
    assert_eq!(
        one["payload"]["stl"]["sha256"],
        two["payload"]["stl"]["sha256"]
    );
    assert_eq!(
        two["payload"]["renderIdentity"],
        one["payload"]["renderIdentity"]
    );
    let jobs = sandbox.jobs("cad_render");
    assert_eq!(jobs.len(), 2);
    assert!(jobs[0]["command"]
        .as_str()
        .unwrap()
        .starts_with("render cache ("));
    assert!(!jobs[1]["command"]
        .as_str()
        .unwrap()
        .starts_with("render cache"));

    // A parameter variant is rendered once and then reused by check and inspect.
    let variant = json!({"artifactId": first["artifactId"], "params": {"hole_d": 4}});
    let inspected = sandbox.call("cad.inspect", variant.clone()).unwrap();
    assert!(inspected["render"].get("cached").is_none());
    assert!(inspected["sections"][0]["loops"][1]
        .as_str()
        .unwrap()
        .starts_with("cut-out circle d=4 at"));
    assert_eq!(
        sandbox.call("cad.inspect", variant).unwrap()["render"]["cached"],
        true
    );

    // A source that cannot render is not rendered again for every check.
    let broken = write(
        &sandbox,
        "Broken",
        "difference() {\n  cube(5);\n  cube(20, center = true);\n}\n",
    );
    assert_eq!(broken["render"]["ok"], false);
    for _ in 0..2 {
        let error = sandbox
            .call(
                "cad.check",
                json!({"artifactId": broken["artifactId"], "expect": {"shells": 1}}),
            )
            .err()
            .unwrap();
        assert_eq!(error.code, "VALIDATION");
        assert_eq!(
            error.message,
            "Cannot check: Current top level object is empty."
        );
        assert!(error
            .repair
            .as_deref()
            .unwrap()
            .contains("cad_write_source"));
        let details = error.details.unwrap();
        assert!(details["hints"][0]
            .as_str()
            .unwrap()
            .starts_with("Nothing was rendered"));
    }
    let renders = sandbox
        .jobs("cad_render")
        .into_iter()
        .filter(|job| job["inputs"]["artifactId"] == broken["artifactId"])
        .collect::<Vec<_>>();
    assert_eq!(renders.len(), 3);
    assert!(renders[..2].iter().all(|job| job["status"] == "failed"
        && job["command"]
            .as_str()
            .unwrap()
            .starts_with("render cache (")));
    assert!(sandbox
        .jobs("cad_check")
        .iter()
        .all(
            |job| job["inputs"]["artifactId"] != broken["artifactId"] || job["status"] == "failed"
        ));
}

#[test]
fn set_param_edits_exactly_one_assignment_and_rerenders() {
    if !engine_available() {
        return;
    }
    let sandbox = Sandbox::new();
    let source = "h = 6; // post height\nd = 5;\nbase = 2 * d;\ncube([base, base, 2]);\ntranslate([d, d, 2])\n  cylinder(\n    h = h,\n    d = d\n  );\n";
    let part = write(&sandbox, "Post", source);
    assert_eq!(part["render"]["ok"], true, "{part}");
    assert_eq!(part["geometry"]["bounds"]["size"], json!([10.0, 10.0, 8.0]));
    assert_eq!(
        part["parameters"],
        json!([
            {"name": "$fn", "value": 64, "derived": false},
            {"name": "h", "value": 6, "derived": false, "comment": "post height"},
            {"name": "d", "value": 5, "derived": false},
            {"name": "base", "value": 10, "derived": true, "expr": "2 * d"},
        ])
    );
    let taller = sandbox
        .call(
            "cad.set_param",
            json!({"artifactId": part["artifactId"], "name": "h", "value": 8}),
        )
        .unwrap();
    assert_eq!(taller["render"]["ok"], true, "{taller}");
    assert_eq!(
        taller["geometry"]["bounds"]["size"],
        json!([10.0, 10.0, 10.0])
    );
    let saved = sandbox
        .call("cad.read_source", json!({"artifactId": part["artifactId"]}))
        .unwrap();
    assert_eq!(
        saved["source"],
        format!("$fn = 64;\n{}", source.replacen("h = 6;", "h = 8;", 1))
    );
    assert_eq!(saved["recordedParams"], json!({"h": 8}));
    assert_eq!(saved["revisionId"], taller["revisionId"]);
    assert_eq!(
        sandbox.revision(&taller["revisionId"])["rationale"],
        "set h"
    );
    assert_eq!(
        sandbox.revision(&taller["revisionId"])["payload"]["paramManifest"][1],
        json!({"name": "h", "dimension": "number", "description": "post height"})
    );

    // A derived value becomes a literal; the names it was derived from stay.
    let wider = sandbox
        .call(
            "cad.set_param",
            json!({"artifactId": part["artifactId"], "name": "base", "value": 14.5}),
        )
        .unwrap();
    assert_eq!(
        wider["geometry"]["bounds"]["size"],
        json!([14.5, 14.5, 10.0])
    );
    assert!(sandbox
        .call("cad.read_source", json!({"artifactId": part["artifactId"]}))
        .unwrap()["source"]
        .as_str()
        .unwrap()
        .contains("d = 5;\nbase = 14.5;\n"));

    let error = sandbox
        .call(
            "cad.set_param",
            json!({"artifactId": part["artifactId"], "name": "height", "value": 9}),
        )
        .err()
        .unwrap();
    assert!(
        error
            .message
            .contains("Top-level variables in this source: $fn, h, d, base."),
        "{}",
        error.message
    );
    assert_eq!(sandbox.revisions(&part["artifactId"]).len(), 3);
    assert_eq!(sandbox.jobs("cad_render").len(), 3);
}

#[test]
fn titles_that_slug_alike_or_have_no_latin_letters_get_their_own_files() {
    if !engine_available() {
        return;
    }
    let sandbox = Sandbox::new();
    let titles = [
        "Motor Mount",
        "motor-mount",
        "Motor mount!",
        "Кронштейн",
        "Пластина датчика",
    ];
    let mut paths = Vec::new();
    for (index, title) in titles.iter().enumerate() {
        let report = write(
            &sandbox,
            title,
            &format!("cube([{}, 10, 2]);\n", 10 + index),
        );
        assert_eq!(report["render"]["ok"], true, "{report}");
        let path = report["sourcePath"].as_str().unwrap().to_owned();
        let id = report["artifactId"].as_str().unwrap();
        match index {
            0 => assert_eq!(path, "artifacts/mechanical/motor-mount.scad"),
            1 | 2 => assert_eq!(
                path,
                format!("artifacts/mechanical/motor-mount-{}.scad", &id[..8])
            ),
            _ => assert_eq!(path, format!("artifacts/mechanical/part-{}.scad", &id[..8])),
        }
        assert_eq!(
            fs::read_to_string(sandbox.root.join(&path)).unwrap(),
            format!("cube([{}, 10, 2]);\n", 10 + index)
        );
        assert_eq!(
            sandbox.revision(&report["revisionId"])["payload"]["scad"]["path"],
            path
        );
        paths.push(path);
    }
    paths.sort();
    paths.dedup();
    assert_eq!(paths.len(), titles.len());
    let stray = fs::read_dir(sandbox.root.join("artifacts/mechanical"))
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .contains("omenflow-conflict")
        })
        .count();
    assert_eq!(stray, 0);
    // A revision keeps its part's path.
    let first = sandbox
        .call("artifact.list", json!({"type": "mechanical"}))
        .unwrap()["artifacts"][0]["artifact"]["id"]
        .clone();
    let revised = sandbox
        .call(
            "cad.write_source",
            json!({"artifactId": first, "title": "Renamed", "source": "cube([11, 11, 2]);\n"}),
        )
        .unwrap();
    assert_eq!(
        revised["sourcePath"],
        "artifacts/mechanical/motor-mount.scad"
    );
    assert!(revised["notes"][0]
        .as_str()
        .unwrap()
        .starts_with("title was ignored"));
}

#[test]
fn a_failed_render_is_saved_explained_and_reported_as_not_ready() {
    if !engine_available() {
        return;
    }
    let sandbox = Sandbox::new();
    let report = write(
        &sandbox,
        "Typo",
        "w = 20;\ncube([width, 10, 2]);\ndifference() {\n  cube(5)\n}\n",
    );
    assert_eq!(report["render"]["ok"], false, "{report}");
    assert!(report.get("geometry").is_none());
    let errors = report["render"]["errors"].as_array().unwrap();
    assert!(
        errors[0]
            .as_str()
            .unwrap()
            .starts_with("ERROR: Parser error"),
        "{errors:?}"
    );
    let hints = report["render"]["hints"].as_array().unwrap();
    assert!(
        hints[0]
            .as_str()
            .unwrap()
            .starts_with("Syntax error at or just before the reported line (line 5: `}`)"),
        "{hints:?}"
    );
    assert!(report["notes"][0]
        .as_str()
        .unwrap()
        .starts_with("Render failed"));
    assert_eq!(report["nextAction"], "repair_geometry");
    assert_eq!(report["nextStep"]["tool"], "cad_write_source");
    assert!(!report["next"].as_str().unwrap().contains("cad_check"));
    let revision = sandbox.revision(&report["revisionId"]);
    assert_eq!(revision["reviewState"], "draft");
    assert_eq!(revision["files"].as_array().unwrap().len(), 1);
    assert!(revision["payload"].get("stl").is_none());
    let job = &sandbox.jobs("cad_render")[0];
    assert_eq!(job["status"], "failed");
    assert_eq!(revision["payload"]["renderJobId"], job["id"]);
    let ready = readiness_of(&sandbox, &report["revisionId"]);
    assert_eq!(
        (&ready["status"], &ready["render"]),
        (&json!("unverified"), &json!("failed"))
    );
    assert!(ready["summary"]
        .as_str()
        .unwrap()
        .starts_with("The render failed: ERROR: Parser error"));

    // Warnings on a render that succeeds are explained too: here the unknown
    // variable silently became a default cube.
    let warned = write(&sandbox, "Unknown variable", "cube([width, 10, 2]);\n");
    assert_eq!(warned["render"]["ok"], true);
    assert!(warned["render"]["hints"][0]
        .as_str()
        .unwrap()
        .starts_with("Unknown variable width (line 1: `cube([width, 10, 2]);`)"));
    assert!(warned["notes"][0]
        .as_str()
        .unwrap()
        .starts_with("OpenSCAD reported warnings"));
    let brief = sandbox
        .call(
            "cad.write_source",
            json!({"artifactId": report["artifactId"], "source": "cube(5)\n", "detail": "brief"}),
        )
        .unwrap();
    assert_eq!(brief["render"]["ok"], false);
    assert!(brief["render"]["errors"].as_array().unwrap().len() <= 4);
    assert!(brief.get("parameters").is_none() && brief.get("sourcePath").is_none());
    assert_eq!(brief["next"]["tool"], "cad_write_source");
}

#[test]
fn inside_out_source_is_displayed_outward_but_cannot_verify() {
    if !engine_available() {
        return;
    }
    let sandbox = Sandbox::new();
    let inverted = "polyhedron(points=[[0,0,0],[10,0,0],[10,10,0],[0,10,0],[0,0,10],[10,0,10],[10,10,10],[0,10,10]], faces=[[3,2,1,0],[5,6,7,4],[1,5,4,0],[2,6,5,1],[3,7,6,2],[0,4,7,3]]);\n";
    let report = write(&sandbox, "Inverted", inverted);
    assert_eq!(report["render"]["ok"], true, "{report}");
    assert!(report["notes"].as_array().unwrap().iter().any(|note| note
        .as_str()
        .unwrap()
        .starts_with("NOT VERIFIED: the source produces inside-out geometry")));
    assert_eq!(report["geometry"]["watertight"], true);
    assert_eq!(report["geometry"]["volume"], 1000.0);
    let revision = sandbox.revision(&report["revisionId"]);
    assert_eq!(
        revision["payload"]["renderIdentity"]["sourceOrientationCorrected"],
        true
    );
    let stored = sandbox.with_handle(|handle| {
        let bytes = handle
            .object_store()
            .unwrap()
            .read(revision["payload"]["stl"]["sha256"].as_str().unwrap())
            .unwrap();
        mesh::Mesh::read(&bytes).unwrap()
    });
    assert!(!stored.inverted && stored.watertight);
    let checked = check(
        &sandbox,
        &report["artifactId"],
        json!({"expect": {"size": [10, 10, 10]}, "autoCommit": true}),
    );
    assert_eq!(checked["verificationStatus"], "failed");
    assert_eq!(checked["committed"], false);
    let winding = checked["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|line| line["name"] == "source winding")
        .unwrap();
    assert_eq!(winding["pass"], false);
    assert_eq!(evidence(&sandbox, &checked)["integrity"]["pass"], false);
}

#[test]
fn patch_source_replaces_one_snippet_and_explains_a_miss() {
    if !engine_available() {
        return;
    }
    let sandbox = Sandbox::new();
    let part = plate(&sandbox);
    let patched = sandbox
        .call(
            "cad.patch_source",
            json!({"artifactId": part["artifactId"], "oldString": "hole_d = 3.2;", "newString": "hole_d = 4.5;", "detail": "brief"}),
        )
        .unwrap();
    assert_eq!(patched["render"], json!({"ok": true}));
    assert_eq!(patched["size"], json!([40.0, 30.0, 4.0]));
    assert_eq!(patched["bodies"], 1);
    assert!(patched["features"][0]["loops"][1]
        .as_str()
        .unwrap()
        .starts_with("cut-out circle d=4.5 at"));
    assert_eq!(patched["features"].as_array().unwrap().len(), 3);
    assert!(patched["features"][0]["plane"]
        .as_str()
        .unwrap()
        .contains("same at"));
    assert_eq!(
        sandbox.revision(&patched["revisionId"])["rationale"],
        "source patched"
    );
    let miss = sandbox
        .call(
            "cad.patch_source",
            json!({"artifactId": part["artifactId"], "oldString": "hole_d  =  4.5;", "newString": "hole_d = 5;"}),
        )
        .err()
        .unwrap();
    assert!(miss.message.starts_with("oldString was not found"));
    assert!(miss
        .repair
        .unwrap()
        .contains("differs only in whitespace starts at line 3: `hole_d = 4.5;`"));
    let twice = sandbox
        .call(
            "cad.patch_source",
            json!({"artifactId": part["artifactId"], "oldString": "inset", "newString": "edge"}),
        )
        .err()
        .unwrap();
    assert_eq!(twice.details.unwrap()["occurrences"], 5);
    assert_eq!(sandbox.revisions(&part["artifactId"]).len(), 2);
}

/// The size of a result as an agent reads it, without what changes from
/// machine to machine or run to run: every id and content hash, the engine's
/// name and version (`render.tool`) and the render time (`render.ms`) become
/// one fixed placeholder each. Keys stay, so a field the brief leaves out
/// still counts in the full result. The same result then measures the same
/// with OpenSCAD 2021.01 or a 2026 snapshot, on a fast or a slow render.
fn outcome_size(result: &Value) -> usize {
    fn uniform(value: &Value, key: &str) -> Value {
        let id = |text: &str| {
            text.len() == 36
                && text.char_indices().all(|(index, c)| {
                    if [8, 13, 18, 23].contains(&index) {
                        c == '-'
                    } else {
                        c.is_ascii_hexdigit()
                    }
                })
        };
        let hash = |text: &str| text.len() == 64 && text.chars().all(|c| c.is_ascii_hexdigit());
        match value {
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(key, item)| (key.clone(), uniform(item, key)))
                    .collect(),
            ),
            Value::Array(items) => {
                Value::Array(items.iter().map(|item| uniform(item, key)).collect())
            }
            Value::String(_) if key == "tool" => json!("<engine>"),
            Value::Number(_) if key == "ms" => json!(0),
            Value::String(text) if id(text) => json!("<id>"),
            Value::String(text) if hash(text) => json!("<hash>"),
            other => other.clone(),
        }
    }
    uniform(result, "").to_string().len()
}

#[test]
fn outcome_size_ignores_ids_hashes_engine_version_and_render_time() {
    let result = |id: &str, tool: &str, ms: u64, hash: &str| {
        json!({"artifactId": id, "render": {"ok": true, "tool": tool, "ms": ms},
               "evidenceHash": hash, "next": {"args": {"artifactId": id}}, "volume": 4671.527})
    };
    let measured = outcome_size(&result(
        "c938e40f-529d-4f6e-bbd6-8beeb2c2c88f",
        "openscad 2026.09.18",
        61,
        &"a".repeat(64),
    ));
    assert_eq!(
        measured,
        outcome_size(&result(
            "402c59b0-36db-4141-ac43-0bfbd9fbec24",
            "openscad 2021.01",
            1250,
            &"0".repeat(64),
        ))
    );
    // What describes the outcome still counts in full.
    assert!(
        outcome_size(&json!({"volume": 4671.527, "watertight": true}))
            > outcome_size(&json!({"volume": 1.5}))
    );
    assert!(
        outcome_size(&json!({"notes": ["a longer note"]}))
            > outcome_size(&json!({"notes": ["a note"]}))
    );
}

#[test]
fn brief_results_keep_the_outcome_in_a_fraction_of_the_size() {
    if !engine_available() {
        return;
    }
    let sandbox = Sandbox::new();
    let full = plate(&sandbox);
    let brief = sandbox
        .call(
            "cad.write_source",
            json!({"artifactId": full["artifactId"], "source": PLATE, "detail": "brief"}),
        )
        .unwrap();
    assert!(
        outcome_size(&brief) * 2 < outcome_size(&full),
        "{} vs {}",
        outcome_size(&brief),
        outcome_size(&full)
    );
    // What a brief result leaves out, so it cannot creep back in.
    for left_out in [
        "parameters",
        "geometry",
        "sections",
        "probes",
        "nextStep",
        "title",
    ] {
        assert!(brief.get(left_out).is_none(), "{left_out} in {brief}");
    }
    assert!(brief["render"].get("tool").is_none() && brief["render"].get("ms").is_none());
    assert!(brief["next"].is_object(), "the next step, not the prose");
    assert_eq!(brief["size"], full["geometry"]["bounds"]["size"]);
    assert_eq!(brief["volume"], full["geometry"]["volume"]);
    assert_eq!(
        (&brief["bodies"], &brief["watertight"]),
        (&json!(1), &json!(true))
    );
    assert_eq!(brief["next"], full["nextStep"]);
    let mut wrong = plate_expectation();
    wrong["size"] = json!([40, 31, 4]);
    let input = json!({"artifactId": full["artifactId"], "expect": wrong, "exploratory": true});
    let full_check = sandbox.call("cad.check", input.clone()).unwrap();
    let mut brief_input = input;
    brief_input["detail"] = json!("brief");
    let brief_check = sandbox.call("cad.check", brief_input).unwrap();
    assert!(
        outcome_size(&brief_check) * 2 < outcome_size(&full_check),
        "{} vs {}",
        outcome_size(&brief_check),
        outcome_size(&full_check)
    );
    assert_eq!(brief_check["ready"], false);
    assert_eq!(brief_check["verificationStatus"], "failed");
    assert_eq!(
        (&brief_check["passed"], &brief_check["total"]),
        (&json!(10), &json!(11))
    );
    assert_eq!(brief_check["failed"].as_array().unwrap().len(), 1);
    assert_eq!(brief_check["failed"][0]["name"], "overall size");
    assert_eq!(brief_check["next"]["tool"], "cad_write_source");
    assert_eq!(
        brief_check["normalizedExpect"],
        full_check["normalizedExpect"]
    );
    assert!(brief_check.get("checks").is_none() && brief_check.get("work").is_none());
    assert_eq!(
        cad_brief("cad_check", &full_check)["failed"],
        brief_check["failed"]
    );
    let inspected = sandbox
        .call(
            "cad.inspect",
            json!({"artifactId": full["artifactId"], "detail": "brief", "sections": [{"axis": "y", "at": 5}], "probes": [[5, 5, 2], [20, 15, 2]]}),
        )
        .unwrap();
    assert_eq!(inspected["probes"][0]["result"], "empty");
    assert_eq!(inspected["probes"][1]["result"], "solid");
    assert_eq!(inspected["features"].as_array().unwrap().len(), 4);
    assert!(inspected.get("sections").is_none() && inspected.get("parameters").is_none());
}

#[test]
fn a_parameter_variant_is_diagnostic_only() {
    if !engine_available() {
        return;
    }
    let sandbox = Sandbox::new();
    let part = plate(&sandbox);
    let mut bigger = plate_expectation();
    for hole in bigger["holes"].as_array_mut().unwrap() {
        hole["d"] = json!(4);
    }
    let variant = check(
        &sandbox,
        &part["artifactId"],
        json!({"expect": bigger, "params": {"hole_d": 4}, "autoCommit": true}),
    );
    assert_eq!(
        (&variant["pass"], &variant["ready"]),
        (&json!(true), &json!(false))
    );
    assert_eq!(variant["verificationStatus"], "unverified");
    assert_eq!(
        (&variant["committed"], &variant["exploratory"]),
        (&json!(false), &json!(true))
    );
    assert!(variant["next"]
        .as_str()
        .unwrap()
        .starts_with("Parameter-variant diagnostic only"));
    assert_eq!(
        variant["ignored"],
        json!(["autoCommit: a parameter variant is never committed"])
    );
    assert_eq!(
        readiness_of(&sandbox, &part["revisionId"])["status"],
        "unverified"
    );
    let error = sandbox
        .call(
            "cad.check",
            json!({"artifactId": part["artifactId"], "expect": {}, "params": {"hole": 4}}),
        )
        .err()
        .unwrap();
    assert!(error.repair.unwrap().contains("hole → hole_d"));
    assert_eq!(sandbox.jobs("cad_check").len(), 1);
}

#[test]
fn preservation_compares_with_the_baseline_and_renders_it_when_needed() {
    if !engine_available() {
        return;
    }
    let sandbox = Sandbox::new();
    let base = write(&sandbox, "Bracket", "cube([60, 40, 4]);\n");
    let drilled = sandbox
        .call(
            "cad.write_source",
            json!({"artifactId": base["artifactId"], "source": "difference() {\n  cube([60, 40, 4]);\n  translate([5, 5, -1]) cylinder(d = 4, h = 6);\n}\n"}),
        )
        .unwrap();
    assert_eq!(drilled["render"]["ok"], true, "{drilled}");
    let kept = check(
        &sandbox,
        &base["artifactId"],
        json!({"expect": {"size": [60, 40, 4], "holes": [{"at": [5, 5, 2], "d": 4}],
            "preserve": {"changeRegions": [{"center": [5, 5, 2], "radius": 4}]}}, "autoCommit": true}),
    );
    assert_eq!(kept["ready"], true, "{kept}");
    let line = kept["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|line| line["name"] == "unrelated geometry preserved")
        .unwrap();
    assert!(line["detail"].as_str().unwrap().starts_with(&format!(
        "Compared with baseline/reference revision {}: ",
        base["revisionId"].as_str().unwrap()
    )));
    assert_eq!(
        evidence(&sandbox, &kept)["preservation"]["revisionId"],
        base["revisionId"]
    );
    let fresh = write(&sandbox, "New part", "cube(5);\n");
    let none = check(
        &sandbox,
        &fresh["artifactId"],
        json!({"expect": {"preserve": {"changeRegions": []}}, "exploratory": true}),
    );
    assert_eq!(none["verificationStatus"], "failed");
    assert!(none["checks"][1]["detail"]
        .as_str()
        .unwrap()
        .starts_with("No prior baseline/reference revision exists"));
}

#[test]
fn a_composition_of_drafts_passes_its_checks_but_waits_on_its_inputs() {
    if !engine_available() {
        return;
    }
    let sandbox = Sandbox::new();
    let base = write(&sandbox, "Base", "w = 20;\ncube([w, 20, 2]);\n");
    let post = write(&sandbox, "Post", "w = 4;\ncube([w, 4, 10]);\n");
    let composed = sandbox
        .call(
            "cad.compose",
            json!({"title": "Base with post", "instances": [
                {"artifactId": base["artifactId"]},
                {"artifactId": post["artifactId"], "translate": [8, 8, 1]}]}),
        )
        .unwrap();
    assert_eq!(composed["render"]["ok"], true, "{composed}");
    assert_eq!(
        composed["geometry"]["bounds"]["size"],
        json!([20.0, 20.0, 11.0])
    );
    assert_eq!(composed["geometry"]["shells"], 1);
    assert!(composed["notes"][0]
        .as_str()
        .unwrap()
        .starts_with("Instances #0 and #1 overlap after transform"));
    let revision = sandbox.revision(&composed["revisionId"]);
    assert_eq!(revision["inputs"].as_array().unwrap().len(), 2);
    assert_eq!(revision["inputs"][1]["revisionId"], post["revisionId"]);
    let checked = check(
        &sandbox,
        &composed["artifactId"],
        json!({"expect": {"size": [20, 20, 11], "bodies": 1}, "autoCommit": true}),
    );
    assert_eq!(
        (&checked["pass"], &checked["committed"]),
        (&json!(true), &json!(true))
    );
    assert_eq!(checked["verificationStatus"], "unverified");
    assert_eq!(checked["ready"], false);
    assert_eq!(checked["nextAction"], "resolve_inputs");
    assert_eq!(checked["staleInputs"].as_array().unwrap().len(), 2);
    let ready = readiness_of(&sandbox, &composed["revisionId"]);
    assert_eq!(
        (&ready["status"], &ready["ready"]),
        (&checked["verificationStatus"], &checked["ready"])
    );
    assert_eq!(ready["nextAction"], checked["nextAction"]);
}

#[test]
fn review_can_accept_a_verified_scope_and_later_reductions_are_flagged() {
    if !engine_available() {
        return;
    }
    let sandbox = Sandbox::new();
    let report = write(&sandbox, "Plate", "width = 20;\ncube([width, 10, 2]);\n");
    let verified = check(
        &sandbox,
        &report["artifactId"],
        json!({"expect": {
            "bbox": {"min": [0, 0, 0], "max": [20, 10, 2]}, "volume": {"value": 400},
            "solid": [[10, 5, 1]], "empty": [[30, 5, 1]], "maxSelfIntersections": 0,
            "sections": [{"axis": "z", "at": 1, "outerCount": 1, "holeCount": 0, "outer": {"size": [20, 10]}}]}}),
    );
    assert_eq!(verified["verificationStatus"], "passed", "{verified}");
    let active_work = || -> Value {
        sandbox.with_handle(|handle| {
            serde_json::from_str(
                &handle
                    .db
                    .query_row(
                        "SELECT value FROM meta WHERE key='work.active'",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .unwrap(),
            )
            .unwrap()
        })
    };
    // A failing trial afterwards moves the work record on to fixing.
    let trial = check(
        &sandbox,
        &report["artifactId"],
        json!({"exploratory": true, "expect": {"bbox": {"min": [0, 0, 0], "max": [25, 10, 2]}}}),
    );
    assert_eq!(trial["committed"], false, "{trial}");
    assert_ne!(active_work()["nextAction"], "request_review");
    let proposal = sandbox
        .call(
            "proposal.submit",
            json!({"changes": [{"artifactId": report["artifactId"], "baseRevisionId": null,
                "newRevisionId": report["revisionId"], "kind": "new_artifact"}], "reason": "reviewed plate"}),
        )
        .unwrap();
    let mut accepted = serde_json::Map::new();
    accepted.insert(
        report["artifactId"].as_str().unwrap().to_owned(),
        verified["evidenceHash"].clone(),
    );
    let resolved = sandbox
        .call(
            "proposal.approve",
            json!({"proposalId": proposal["id"], "rationale": "dimensions reviewed", "verificationEvidence": accepted}),
        )
        .unwrap();
    assert_eq!(resolved["state"], "accepted");
    assert_eq!(
        readiness_of(&sandbox, &report["revisionId"])["status"],
        "passed"
    );
    // The active-work record follows the accepted scope.
    let work = active_work();
    assert_eq!(work["artifactId"], report["artifactId"]);
    assert_eq!(work["candidateRevisionId"], report["revisionId"]);
    assert_eq!(work["specHash"], evidence(&sandbox, &verified)["specHash"]);
    assert_eq!(work["expect"], evidence(&sandbox, &verified)["expect"]);
    assert_eq!(work["nextAction"], "request_review");
    assert_eq!(
        sandbox.call("build.preview", json!({})).unwrap()["counts"]["ready"],
        1
    );
    let weakened = check(
        &sandbox,
        &report["artifactId"],
        json!({"expect": {"bbox": {"min": [0, 0, 0], "max": [20, 10, 2]}}}),
    );
    assert_eq!(weakened["verificationStatus"], "scope_changed");
    assert_eq!(
        sandbox.call("build.preview", json!({})).unwrap()["counts"]["ready"],
        0
    );
}

#[test]
fn a_queued_render_can_be_cancelled_and_an_interrupted_one_is_marked() {
    if !engine_available() {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let mut handle = ProjectHandle::create(temp.path().join("cad"), "CAD", "test").unwrap();
    let report = write_source(
        &mut handle,
        &json!({"title": "Plate", "source": "cube([20, 10, 2]);\n", "timeoutMs": 60_000}),
        &Origin::User,
    )
    .unwrap();
    assert_eq!(report["render"]["ok"], true);
    let input = json!({"artifactId": report["artifactId"], "revisionId": report["revisionId"]});
    let queued = queue_render(&handle, &input, &Origin::User).unwrap();
    assert_eq!(queued["job"]["status"], "queued");
    let job_id = queued["job"]["id"].as_str().unwrap();
    simple::job_cancel(&handle, &json!({"jobId": job_id}), &Origin::User).unwrap();
    assert_eq!(
        finish_queued_render(&mut handle, &input, &Origin::User, job_id)
            .unwrap_err()
            .code,
        "CANCELLED"
    );
    assert_eq!(jobs::read(&handle, job_id).unwrap()["status"], "cancelled");
    let orphan = queue_render(&handle, &input, &Origin::User).unwrap();
    let reopened = CoreApp::new(temp.path().join("appdata"))
        .unwrap()
        .dispatch(
            "project.open",
            json!({"path": handle.root}),
            Origin::User,
            None,
        )
        .unwrap();
    assert_eq!(reopened["projectId"], handle.file.id);
    assert_eq!(
        jobs::read(&handle, orphan["job"]["id"].as_str().unwrap()).unwrap()["status"],
        "interrupted"
    );
    // Only the newest revision can be rendered: the result becomes its successor.
    let newer = write_source(
        &mut handle,
        &json!({"artifactId": report["artifactId"], "source": "cube([21, 10, 2]);\n"}),
        &Origin::User,
    )
    .unwrap();
    let stale = queue_render(&handle, &input, &Origin::User).unwrap_err();
    assert_eq!(stale.code, "REVISION_CONFLICT");
    assert_eq!(
        stale.details.unwrap()["currentRevisionId"],
        newer["revisionId"]
    );
}

#[test]
fn source_can_be_validated_without_rendering() {
    if !engine_available() {
        return;
    }
    let sandbox = Sandbox::new();
    let good = plate(&sandbox);
    let valid = sandbox
        .call(
            "cad.validate_source",
            json!({"artifactId": good["artifactId"]}),
        )
        .unwrap();
    assert_eq!(valid["ok"], true, "{valid}");
    let bad = write(&sandbox, "Bad", "cube(5\n");
    let invalid = sandbox
        .call(
            "cad.validate_source",
            json!({"artifactId": bad["artifactId"]}),
        )
        .unwrap();
    assert_eq!(invalid["ok"], false);
    assert!(invalid["errors"][0]
        .as_str()
        .unwrap()
        .contains("Parser error"));
    assert!(invalid["hints"][0]
        .as_str()
        .unwrap()
        .starts_with("Syntax error"));
}

#[test]
fn a_part_with_hundreds_of_thousands_of_triangles_is_rendered_measured_and_checked() {
    if !engine_available() {
        return;
    }
    let sandbox = Sandbox::new();
    // A ball with an 8 mm bore along z, turned from its profile: the half-disc beyond
    // the bore. The same part as a sphere minus a cylinder, but without a 3D boolean,
    // which OpenSCAD 2021.01 (CGAL; Ubuntu and Debian ship it) takes over two minutes
    // to compute at this size while current snapshots (Manifold) take seconds. This test
    // is about measuring and checking a mesh this large, not about the engine's speed.
    let source = "rotate_extrude($fn = 560)\n  intersection() {\n    circle(d = 30, $fn = 560);\n    translate([4, -20]) square([20, 40]);\n  }\n";
    let started = std::time::Instant::now();
    let report = sandbox
        .call(
            "cad.write_source",
            json!({"title": "Drilled ball", "source": source, "timeoutMs": 120_000}),
        )
        .unwrap();
    let written = started.elapsed();
    assert_eq!(report["render"]["ok"], true, "{report}");
    let triangles = report["geometry"]["triangles"].as_u64().unwrap();
    assert!(triangles > 250_000, "{triangles}");
    assert_eq!(report["geometry"]["watertight"], true);
    assert_eq!(
        report["limits"]["notEvaluated"].as_array().unwrap().len(),
        1,
        "{}",
        report["limits"]
    );
    assert!(report["notes"].as_array().unwrap().iter().any(|note| note
        .as_str()
        .unwrap()
        .contains("does not block verification")));
    let started = std::time::Instant::now();
    let checked = check(
        &sandbox,
        &report["artifactId"],
        // The bore takes the poles off: the height is 2·√(15² − 4²) ≈ 28.914 mm.
        json!({"expect": {"size": [30, 30, 28.914], "bodies": 1, "maxSelfIntersections": 0,
            "holes": [{"at": [0, 0, 0], "d": 8}], "solid": [[10, 0, 0]], "empty": [[20, 0, 0]]}, "autoCommit": true}),
    );
    let measured = started.elapsed();
    assert_eq!(checked["ready"], true, "{checked}");
    assert_eq!(checked["total"], 8);
    eprintln!("{triangles} triangles: write {written:?}, check {measured:?}");
}
