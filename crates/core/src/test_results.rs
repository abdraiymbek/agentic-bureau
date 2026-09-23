//! Test observations are immutable revision records, including the evidence
//! classification and the person or agent who entered them.
use super::*;

pub(super) fn record_result(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    let artifact_id = required_str(input, "artifactId")?;
    let artifact = require_artifact(handle, artifact_id)?;
    if artifact["type"] != "test" {
        return Err(ContractError::validation(
            "Results attach to test artifacts",
        ));
    }
    let current = if let Some(id) = artifact["selectedRevisionId"].as_str() {
        require_revision(handle, id)?
    } else {
        handle
            .db
            .query_row(
                "SELECT * FROM revision WHERE artifact_id=?1 ORDER BY seq DESC LIMIT 1",
                [artifact_id],
                revision_from_row,
            )
            .optional()
            .map_err(internal)?
            .ok_or_else(|| ContractError::validation("Test has no revision"))?
    };
    let files = ingest_files(handle, &input["attachments"])?;
    let mut result = json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "evidenceKind": input["evidenceKind"],
        "observation": input["observation"],
        "result": input["result"],
        "attachments": files,
        "recordedBy": match origin {
            Origin::Agent { session_id } => format!("agent:{}", session_id.chars().take(8).collect::<String>()),
            _ => "user".to_owned(),
        },
        "recordedAt": now(),
    });
    for key in ["requirementRef", "conditions", "measurementOrigin"] {
        if let Some(value) = input.get(key) {
            result[key] = value.clone();
        }
    }
    let mut body = current["payload"].clone();
    let results = body["results"]
        .as_array_mut()
        .ok_or_else(|| ContractError::validation("Test results must be an array"))?;
    results.push(result.clone());
    body = parse_artifact_payload("test", body)?;
    let revision_id = uuid::Uuid::new_v4().to_string();
    let seq: i64 = handle
        .db
        .query_row(
            "SELECT COALESCE(MAX(seq),0)+1 FROM revision WHERE artifact_id=?1",
            [artifact_id],
            |row| row.get(0),
        )
        .map_err(internal)?;
    let review_state = if current["reviewState"] == "approved" {
        "approved"
    } else {
        "draft"
    };
    let hashes = current["files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|file| file["sha256"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    let timestamp = now();
    let tx = handle.db.unchecked_transaction().map_err(internal)?;
    tx.execute("INSERT INTO revision(id,artifact_id,parent_id,seq,origin,origin_detail,created_at,payload,content_hash,files,inputs,rationale,review_state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![revision_id, artifact_id, current["id"].as_str(), seq, origin.kind(), origin.session_id(), timestamp, body.to_string(), models::content_hash(&body, &hashes), current["files"].to_string(), current["inputs"].to_string(), format!("result: {}", required_str(input, "result")?), review_state]).map_err(internal)?;
    tx.execute(
        "DELETE FROM artifact_fts WHERE artifact_id=?1",
        [artifact_id],
    )
    .map_err(internal)?;
    tx.execute(
        "INSERT INTO artifact_fts(artifact_id,revision_id,title,text) VALUES(?1,?2,?3,?4)",
        params![
            artifact_id,
            revision_id,
            artifact["title"].as_str(),
            body.to_string().chars().take(20_000).collect::<String>()
        ],
    )
    .map_err(internal)?;
    tx_event(
        &tx,
        "revision.committed",
        origin.kind(),
        json!({"artifactId": artifact_id, "revisionId": revision_id, "reviewState": review_state}),
    )?;
    tx.commit().map_err(internal)?;
    Ok(json!({"result": result, "revision": require_revision(handle, &revision_id)?}))
}
