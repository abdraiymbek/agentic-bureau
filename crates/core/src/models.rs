use rusqlite::{types::Type, Error, Row};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

fn parse_json(row: &Row<'_>, index: usize) -> rusqlite::Result<Value> {
    let value: String = row.get(index)?;
    serde_json::from_str(&value)
        .map_err(|error| Error::FromSqlConversionFailure(index, Type::Text, Box::new(error)))
}

pub fn artifact_from_row(row: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>("id")?,
        "type": row.get::<_, String>("type")?,
        "title": row.get::<_, String>("title")?,
        "subsystem": row.get::<_, Option<String>>("subsystem")?,
        "selectedRevisionId": row.get::<_, Option<String>>("selected_revision_id")?,
        "archived": row.get::<_, i64>("archived")? != 0,
        "createdAt": row.get::<_, String>("created_at")?,
    }))
}

pub fn edge_from_row(row: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>("id")?,
        "upstreamArtifactId": row.get::<_, String>("upstream_artifact_id")?,
        "downstreamArtifactId": row.get::<_, String>("downstream_artifact_id")?,
        "relationship": row.get::<_, String>("relationship")?,
        "requiredUpstreamRevisionId": row.get::<_, Option<String>>("required_upstream_revision_id")?,
        "label": row.get::<_, String>("label")?,
        "createdBy": row.get::<_, String>("created_by")?,
        "createdAt": row.get::<_, String>("created_at")?,
    }))
}

pub fn revision_from_row(row: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>("id")?,
        "artifactId": row.get::<_, String>("artifact_id")?,
        "parentId": row.get::<_, Option<String>>("parent_id")?,
        "seq": row.get::<_, i64>("seq")?,
        "origin": row.get::<_, String>("origin")?,
        "originDetail": row.get::<_, Option<String>>("origin_detail")?,
        "createdAt": row.get::<_, String>("created_at")?,
        "payload": parse_json(row, 7)?,
        "contentHash": row.get::<_, String>("content_hash")?,
        "files": parse_json(row, 9)?,
        "inputs": parse_json(row, 10)?,
        "rationale": row.get::<_, String>("rationale")?,
        "reviewState": row.get::<_, String>("review_state")?,
    }))
}

pub fn proposal_from_row(row: &Row<'_>) -> rusqlite::Result<Value> {
    let impact: Option<String> = row.get("impact")?;
    Ok(json!({
        "id": row.get::<_, String>("id")?,
        "changes": parse_json(row, 1)?,
        "reason": row.get::<_, String>("reason")?,
        "impact": impact.map(|s| serde_json::from_str::<Value>(&s)).transpose().map_err(|error| Error::FromSqlConversionFailure(3, Type::Text, Box::new(error)))?,
        "state": row.get::<_, String>("state")?,
        "createdBy": row.get::<_, String>("created_by")?,
        "createdBySession": row.get::<_, Option<String>>("created_by_session")?,
        "createdAt": row.get::<_, String>("created_at")?,
        "resolvedAt": row.get::<_, Option<String>>("resolved_at")?,
        "resolutionRationale": row.get::<_, Option<String>>("resolution_rationale")?,
    }))
}

pub fn event_from_row(row: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "seq": row.get::<_, i64>("seq")?,
        "id": row.get::<_, String>("id")?,
        "type": row.get::<_, String>("type")?,
        "origin": row.get::<_, String>("origin")?,
        "ts": row.get::<_, String>("ts")?,
        "data": parse_json(row, 5)?,
    }))
}

pub fn job_from_row(row: &Row<'_>) -> rusqlite::Result<Value> {
    let error: Option<String> = row.get("error")?;
    Ok(json!({
        "id": row.get::<_, String>("id")?, "kind": row.get::<_, String>("kind")?,
        "tool": row.get::<_, String>("tool")?, "toolVersion": row.get::<_, Option<String>>("tool_version")?,
        "inputs": parse_json(row, 4)?, "inputHashes": parse_json(row, 5)?,
        "command": row.get::<_, Option<String>>("command")?, "status": row.get::<_, String>("status")?,
        "log": row.get::<_, String>("log")?, "outputHashes": parse_json(row, 9)?,
        "error": error.map(|s| serde_json::from_str::<Value>(&s)).transpose().map_err(|e| Error::FromSqlConversionFailure(10, Type::Text, Box::new(e)))?,
        "sessionId": row.get::<_, Option<String>>("session_id")?, "createdAt": row.get::<_, String>("created_at")?,
        "startedAt": row.get::<_, Option<String>>("started_at")?, "finishedAt": row.get::<_, Option<String>>("finished_at")?,
    }))
}

fn strip_presentational(value: &Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .filter(|(key, _)| {
                    !matches!(key.as_str(), "title" | "description" | "notes" | "label")
                })
                .map(|(key, value)| (key.clone(), strip_presentational(value)))
                .collect::<Map<String, Value>>(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(strip_presentational).collect()),
        _ => value.clone(),
    }
}

pub fn content_hash(payload: &Value, file_hashes: &[String]) -> String {
    let mut hash = Sha256::new();
    hash.update(strip_presentational(payload).to_string());
    let mut files = file_hashes.to_vec();
    files.sort();
    for file in files {
        hash.update(file);
    }
    format!("{:x}", hash.finalize())
}
