//! What the read side costs on a synthetic project.
//!
//! `cargo run --release -p bureau-core --example read_costs -- [ARTIFACTS] [FOLDER]`
//!
//! Seeds a project (600 artifacts unless told otherwise) straight into
//! storage, opens it through `CoreApp` and times the reads the interface and
//! agents issue most. The project lives in a temporary folder that is removed
//! afterwards, unless an empty FOLDER is named to keep it for inspection. Each artifact has an approved
//! baseline and four later revisions with a payload of about 1.5 kB; tests
//! and calculations link to requirements; every sixth artifact is stale and
//! every fifteenth has a pending proposal. Nothing is asserted: the table is
//! for comparing one build with another on the same machine.
use bureau_core::{CoreApp, Origin};
use bureau_storage::ProjectHandle;
use rusqlite::params;
use serde_json::json;
use std::time::Instant;

const SAMPLES: usize = 21;
const SESSION: &str = "bench-session";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let count = match std::env::args().nth(1) {
        Some(text) => text.parse::<usize>()?,
        None => 600,
    };
    let directory = tempfile::tempdir()?;
    let root = match std::env::args().nth(2) {
        Some(folder) => std::path::PathBuf::from(folder),
        None => directory.path().join("project"),
    };
    let seeded = Instant::now();
    let part = seed(&root, count)?;
    println!(
        "{count} artifacts, {} revisions seeded in {:.0} ms",
        count * 5,
        seeded.elapsed().as_secs_f64() * 1000.0
    );

    let mut app = CoreApp::new(directory.path().join("appdata"))?;
    let opened = app.dispatch("project.open", json!({"path": root}), Origin::User, None)?;
    let project = opened["projectId"].as_str().ok_or("no project id")?;
    let agent = Origin::Agent {
        session_id: SESSION.to_owned(),
    };
    let reads = [
        ("artifact.list", json!({}), Origin::User),
        ("artifact.list", json!({"limit": 500}), Origin::User),
        (
            "artifact.list",
            json!({"limit": 500, "fields": "summary"}),
            Origin::User,
        ),
        ("artifact.list", json!({"type": "component"}), agent.clone()),
        ("artifact.read", json!({"artifactId": part}), Origin::User),
        ("artifact.read", json!({"artifactId": part}), agent.clone()),
        ("graph.list", json!({}), Origin::User),
        ("project.summary", json!({}), agent.clone()),
        ("project.coverage", json!({}), Origin::User),
        ("work.status", json!({}), Origin::User),
        ("work.status", json!({}), agent.clone()),
        (
            "project.search",
            json!({"query": "payload 300 g"}),
            agent.clone(),
        ),
        ("project.search", json!({"query": "ayloa"}), agent.clone()),
    ];
    println!(
        "{:<17} {:<38} {:>6} {:>9} {:>9} {:>10}",
        "operation", "input", "origin", "p50 ms", "p95 ms", "bytes"
    );
    for (op, input, origin) in reads {
        let mut times = Vec::with_capacity(SAMPLES);
        let mut bytes = 0;
        for _ in 0..SAMPLES {
            let started = Instant::now();
            let result = app.dispatch(op, input.clone(), origin.clone(), Some(project))?;
            times.push(started.elapsed().as_secs_f64() * 1000.0);
            bytes = result.to_string().len();
        }
        times.sort_by(f64::total_cmp);
        println!(
            "{op:<17} {:<38} {:>6} {:>9.2} {:>9.2} {bytes:>10}",
            input.to_string(),
            origin.kind(),
            times[SAMPLES / 2],
            times[SAMPLES * 95 / 100]
        );
    }
    Ok(())
}

/// Write the synthetic project and return the id of one mechanical artifact.
fn seed(root: &std::path::Path, count: usize) -> Result<String, Box<dyn std::error::Error>> {
    let handle = ProjectHandle::create(
        root,
        "Read costs",
        "Carry a 300 g payload over rough ground",
    )?;
    let tx = handle.db.unchecked_transaction()?;
    let kinds = [
        "requirement",
        "component",
        "mechanical",
        "calculation",
        "test",
        "component",
        "mechanical",
        "wiring",
        "assumption",
        "note",
    ];
    let filler = "Design intent and context recorded with the artifact. ".repeat(24);
    let mut requirements = Vec::<(String, String)>::new();
    let mut mechanical = None;
    for index in 0..count {
        let id = uuid::Uuid::new_v4().to_string();
        let kind = kinds[index % kinds.len()];
        let at = format!(
            "2026-01-01T{:02}:{:02}:{:02}.000Z",
            index / 3600,
            index / 60 % 60,
            index % 60
        );
        tx.execute(
            "INSERT INTO artifact(id,type,title,subsystem,selected_revision_id,archived,created_at) \
             VALUES(?1,?2,?3,NULL,NULL,0,?4)",
            params![id, kind, format!("{kind} {index}"), at],
        )?;
        let upstream = requirements.get(index % requirements.len().max(1));
        let inputs = match (kind, upstream) {
            ("test", Some((artifact, revision))) => {
                json!([{"artifactId": artifact, "revisionId": revision, "relationship": "validates"}])
            }
            ("calculation" | "mechanical", Some((artifact, revision))) => {
                json!([{"artifactId": artifact, "revisionId": revision, "relationship": "depends_on"}])
            }
            _ => json!([]),
        };
        let priority = ["must", "should", "could"][index % 3];
        let mut baseline = String::new();
        for seq in 1..=5 {
            let revision = uuid::Uuid::new_v4().to_string();
            let state = match seq {
                1 => "superseded",
                2 => "approved",
                _ => "draft",
            };
            let payload = match kind {
                "requirement" => json!({
                    "statement": format!("Requirement {index}: carry a 300 g payload. {filler}"),
                    "target": {"value": 300, "unit": "g"},
                    "acceptanceCriterion": "Shown by test",
                    "priority": priority,
                }),
                "assumption" => json!({
                    "statement": format!("Assumption {index}. {filler}"),
                    "reason": "Bench notes", "owner": "team", "needsValidation": true,
                }),
                "component" => json!({
                    "partNumber": format!("PN-{index}"), "manufacturer": "Example", "status": "candidate",
                    "description": filler, "properties": {"mass": {"quantity": {"value": 55, "unit": "g"}}},
                }),
                "mechanical" => json!({
                    "scad": {"path": format!("parts/part-{index}.scad"), "sha256": "a".repeat(64), "role": "source"},
                    "stl": {"path": format!("parts/part-{index}.stl"), "sha256": "b".repeat(64), "role": "output"},
                    "params": {}, "modelUnit": "mm", "material": filler,
                    "renderIdentity": {
                        "version": 1, "sourceHash": "a".repeat(64), "params": {}, "modelUnit": "mm",
                        "frame": "right-handed-z-up", "engine": "openscad", "engineVersion": "2021.01",
                        "options": "stl", "inputFingerprint": "c".repeat(64), "outputHash": "b".repeat(64),
                    },
                }),
                "calculation" => json!({
                    "expression": "chassis + battery", "limitations": [filler],
                    "result": {"quantity": {"value": 0.412, "unit": "kg"}}, "evidenceKind": "calculated",
                }),
                "test" => json!({
                    "procedure": [{"step": 1, "instruction": filler}],
                    "results": [{
                        "id": uuid::Uuid::new_v4().to_string(), "evidenceKind": "measured",
                        "observation": "Carried 0.3 kg for 5 m", "result": "passed",
                        "recordedBy": "user", "recordedAt": at,
                    }],
                }),
                "wiring" => json!({"pins": [], "connections": [], "coverageNote": filler}),
                _ => json!({"markdown": format!("Note {index} about the payload. {filler}")}),
            };
            let files = if kind == "mechanical" {
                json!([payload["scad"], payload["stl"]])
            } else {
                json!([])
            };
            tx.execute(
                "INSERT INTO revision(id,artifact_id,parent_id,seq,origin,origin_detail,created_at,\
                 payload,content_hash,files,inputs,rationale,review_state) \
                 VALUES(?1,?2,NULL,?3,'agent',?4,?5,?6,'seed',?7,?8,'',?9)",
                params![
                    revision,
                    id,
                    seq,
                    if index % 20 == 0 { SESSION } else { "other-session" },
                    at,
                    payload.to_string(),
                    files.to_string(),
                    inputs.to_string(),
                    state
                ],
            )?;
            if seq == 2 {
                baseline = revision.clone();
                tx.execute(
                    "UPDATE artifact SET selected_revision_id=?1 WHERE id=?2",
                    params![revision, id],
                )?;
            }
            if seq == 5 {
                tx.execute(
                    "INSERT INTO artifact_fts(artifact_id,revision_id,title,text) VALUES(?1,?2,?3,?4)",
                    params![id, revision, format!("{kind} {index}"), payload.to_string()],
                )?;
            }
        }
        if kind == "requirement" {
            requirements.push((id.clone(), baseline.clone()));
        }
        if kind == "mechanical" && mechanical.is_none() {
            mechanical = Some(id.clone());
        }
        if kind == "component" && index % 4 == 1 {
            tx.execute(
                "INSERT INTO offer(id,component_artifact_id,seller,url,price_amount,price_currency,\
                 quantity_basis,observed_at) VALUES(?1,?2,'Example','https://example.com/p','12.50','USD',1,?3)",
                params![uuid::Uuid::new_v4().to_string(), id, at],
            )?;
        }
        if index % 6 == 5 {
            tx.execute(
                "INSERT INTO stale(artifact_id,upstream_artifact_id,reason,since_event_seq) \
                 VALUES(?1,?2,'input_changed',1)",
                params![id, requirements[0].0],
            )?;
        }
        if index % 15 == 0 {
            tx.execute(
                "INSERT INTO proposal(id,changes,reason,impact,state,created_by,created_by_session,created_at) \
                 VALUES(?1,?2,'Seeded proposal',NULL,'pending','agent',?3,?4)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    json!([{"artifactId": id, "newRevisionId": baseline, "baseRevisionId": null, "kind": "new_artifact"}])
                        .to_string(),
                    SESSION,
                    at
                ],
            )?;
        }
        for (event, event_type) in [
            "revision.committed",
            "baseline.changed",
            "impact.propagated",
        ]
        .into_iter()
        .enumerate()
        {
            tx.execute(
                "INSERT INTO event(id,type,origin,ts,data) VALUES(?1,?2,'agent',?3,?4)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    event_type,
                    at,
                    json!({"artifactId": id, "index": event}).to_string()
                ],
            )?;
        }
        if index % 3 == 0 {
            tx.execute(
                "INSERT INTO decision(id,proposal_id,action,actor,ts,rationale,event_seq) \
                 VALUES(?1,NULL,'accepted','user',?2,'Reviewed',1)",
                params![uuid::Uuid::new_v4().to_string(), at],
            )?;
        }
    }
    // Two hundred committed checks, as a part that has been iterated on has.
    for check in 0..200 {
        tx.execute(
            "INSERT INTO job(id,kind,tool,inputs,status,log,output_hashes,session_id,created_at) \
             VALUES(?1,'cad_check','omenflow-geometry',?2,'succeeded','PASS bbox',?3,?4,?5)",
            params![
                uuid::Uuid::new_v4().to_string(),
                json!({"artifactId": mechanical, "expect": {"bbox": {"min": [0, 0, 0], "max": [20, 10, 2]}}})
                    .to_string(),
                json!({"verification": "d".repeat(64)}).to_string(),
                SESSION,
                format!("2026-02-01T00:{:02}:{:02}.000Z", check / 60, check % 60)
            ],
        )?;
    }
    tx.commit()?;
    Ok(mechanical.ok_or("no mechanical artifact seeded")?)
}
