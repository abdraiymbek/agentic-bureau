//! History shapes remain additive: existing callers get every full revision,
//! while lists that only need headers can page without reading content.
use super::*;
use crate::testkit::TestProject;

fn history(project: &mut TestProject, count: usize) -> String {
    let (artifact, first) = project.draft(
        Origin::User,
        "note",
        "Revision history",
        json!({"markdown": "context ".repeat(300)}),
        json!([]),
    );
    let mut parent = first.clone();
    for seq in 2..=count {
        let id = uuid::Uuid::new_v4().to_string();
        project.handle().db.execute(
            "INSERT INTO revision(id,artifact_id,parent_id,seq,origin,origin_detail,created_at,payload,content_hash,files,inputs,rationale,review_state)
             SELECT ?1,artifact_id,?2,?3,origin,origin_detail,created_at,payload,content_hash,files,inputs,rationale,review_state FROM revision WHERE id=?4",
            params![id, parent, seq as i64, first],
        ).unwrap();
        parent = id;
    }
    artifact
}

#[test]
fn history_keeps_the_unpaged_full_default_and_pages_every_header_once() {
    let mut project = TestProject::new();
    let artifact = history(&mut project, 507);
    let whole = project.user("artifact.history", json!({"artifactId": artifact}));
    let revisions = whole["revisions"].as_array().unwrap();
    assert_eq!(revisions.len(), 507);
    assert!(whole.get("hasMore").is_none());
    assert!(revisions
        .iter()
        .all(|revision| revision["payload"]["markdown"].is_string()));
    let mut collected = Vec::new();
    let mut input = json!({"artifactId": artifact, "fields": "summary", "limit": 37});
    loop {
        let page = project.user("artifact.history", input.clone());
        assert_eq!(page["total"], 507);
        assert_eq!(page["fields"], "summary");
        let rows = page["revisions"].as_array().unwrap();
        assert!(rows.len() <= 37);
        for row in rows {
            for absent in ["payload", "files", "inputs", "contentHash"] {
                assert!(
                    row.get(absent).is_none(),
                    "{absent} must not be read for a header"
                );
            }
            collected.push(row["id"].clone());
        }
        if page["hasMore"] == false {
            assert!(page["nextCursor"].is_null());
            break;
        }
        assert_eq!(
            page["nextCursor"],
            rows.last().unwrap()["seq"].as_i64().unwrap().to_string()
        );
        input["cursor"] = page["nextCursor"].clone();
    }
    assert_eq!(
        collected,
        revisions
            .iter()
            .map(|revision| revision["id"].clone())
            .collect::<Vec<_>>()
    );
    let first = project.user(
        "artifact.history",
        json!({"artifactId": artifact, "limit": 1}),
    );
    assert_eq!(first["revisions"][0], revisions[0]);
    assert_eq!(first["hasMore"], true);
    let cursor_only = project.user(
        "artifact.history",
        json!({"artifactId": artifact, "cursor": "1"}),
    );
    assert_eq!(cursor_only["revisions"].as_array().unwrap().len(), 200);
    assert_eq!(cursor_only["revisions"][0], revisions[1]);
}

#[test]
fn history_empty_and_invalid_cursor_cases_are_explicit() {
    let mut project = TestProject::new();
    let missing = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        project.user("artifact.history", json!({"artifactId": missing})),
        json!({"revisions": []})
    );
    let empty = project.user(
        "artifact.history",
        json!({"artifactId": missing, "limit": 1, "fields": "summary"}),
    );
    assert_eq!(empty["revisions"], json!([]));
    assert_eq!(empty["hasMore"], false);
    assert_eq!(empty["total"], 0);
    assert!(empty["nextCursor"].is_null());
    for cursor in ["bad", "0", "-2", "9223372036854775808"] {
        let error = project
            .call(
                Origin::User,
                "artifact.history",
                json!({"artifactId": missing, "cursor": cursor}),
            )
            .unwrap_err();
        assert_eq!(error.code, "VALIDATION");
        assert!(error.repair.unwrap().contains("nextCursor"));
    }
}
