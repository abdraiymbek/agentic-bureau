//! Small domain operations shared by the desktop UI and agent bridge.
use super::*;
use std::collections::BTreeMap;

pub(super) fn artifact_reveal(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    let artifact = require_artifact(handle, required_str(input, "artifactId")?)?;
    let revision = artifact["selectedRevisionId"]
        .as_str()
        .map(|id| get_revision(handle, id))
        .transpose()?
        .flatten();
    let path = revision
        .as_ref()
        .and_then(|r| r["files"].as_array())
        .and_then(|files| files.first())
        .and_then(|file| file["path"].as_str())
        .ok_or_else(|| ContractError::new("NOT_FOUND", "Artifact has no file to reveal"))?;
    let absolute = resolve_materialization_path(&handle.root, path).map_err(storage_error)?;
    Ok(json!({"ok": true, "path": absolute}))
}

pub(super) fn job_read(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    let id = required_str(input, "jobId")?;
    let job = handle
        .db
        .query_row("SELECT * FROM job WHERE id=?1", [id], models::job_from_row)
        .optional()
        .map_err(internal)?
        .ok_or_else(|| ContractError::new("NOT_FOUND", format!("Job not found: {id}")))?;
    Ok(json!({"job": job}))
}

pub(super) fn job_cancel(
    handle: &ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    let id = required_str(input, "jobId")?;
    let job = job_read(handle, input)?["job"].clone();
    if let Origin::Agent { session_id } = origin {
        if job["sessionId"] != session_id.as_str() {
            return Err(ContractError::new(
                "CAPABILITY_DENIED",
                "An agent can only cancel its own jobs",
            ));
        }
    }
    // All jobs loaded at startup are interrupted; live jobs have their own
    // cancellation handles in the engine host. Never relabel a finished job.
    if matches!(job["status"].as_str(), Some("queued" | "running")) {
        handle
            .db
            .execute(
                "UPDATE job SET status='cancelled',finished_at=?1 WHERE id=?2",
                params![now(), id],
            )
            .map_err(internal)?;
        emit(
            handle,
            "job.updated",
            origin,
            json!({"jobId": id, "status": "cancelled"}),
        )?;
    }
    job_read(handle, input)
}

pub(super) fn tool_list() -> CoreResult<Value> {
    Ok(
        json!({"tools": [{"toolId": "openscad", "kind": "cad", "available": null, "version": null}], "note": "Probe individual tools for live availability."}),
    )
}

pub(super) fn tool_describe(input: &Value) -> CoreResult<Value> {
    let requested = required_str(input, "op")?;
    let name = requested.replace('_', ".");
    let operation = registry()
        .operation(requested)
        .or_else(|| registry().operation(&name))
        .ok_or_else(|| {
            ContractError::new("NOT_FOUND", format!("Unknown operation: {requested}"))
        })?;
    Ok(
        json!({"op": operation.name, "tool": operation.tool_name, "description": operation.description, "mutating": operation.mutating, "inputSchema": operation.input_schema}),
    )
}

pub(super) fn tool_doctor(input: &Value) -> CoreResult<Value> {
    if input["toolId"].as_str().is_some_and(|id| id != "openscad") {
        return Ok(json!({"results": {}}));
    }
    let result = std::process::Command::new("openscad")
        .arg("--version")
        .output();
    let probe = match result {
        Ok(output) => {
            json!({"available": output.status.success(), "version": String::from_utf8_lossy(if output.stdout.is_empty() { &output.stderr } else { &output.stdout }).trim(), "path": "openscad"})
        }
        Err(error) => json!({"available": false, "error": error.to_string()}),
    };
    Ok(json!({"results": {"openscad": probe}}))
}

pub(super) fn source_capture(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    if input["url"].as_str().is_none() && input["filePath"].as_str().is_none() {
        return Err(ContractError::validation("Source needs a url or filePath"));
    }
    let mut payload = serde_json::Map::new();
    payload.insert(
        "kind".into(),
        json!(if input["url"].is_string() {
            "url"
        } else {
            "file"
        }),
    );
    for key in [
        "url",
        "title",
        "publisher",
        "locator",
        "excerpt",
        "sourceKind",
    ] {
        if !input[key].is_null() {
            payload.insert(key.into(), input[key].clone());
        }
    }
    if let Some(file_path) = input["filePath"].as_str() {
        let source = Path::new(file_path);
        let absolute = if matches!(origin, Origin::Agent { .. }) || !source.is_absolute() {
            let relative = if source.is_absolute() {
                source
                    .strip_prefix(&handle.root)
                    .map_err(|_| {
                        ContractError::new("PATH_OUTSIDE_PROJECT", "Source path is outside project")
                    })?
                    .to_string_lossy()
                    .to_string()
            } else {
                file_path.to_owned()
            };
            resolve_materialization_path(&handle.root, &relative).map_err(storage_error)?
        } else {
            source.to_path_buf()
        };
        let bytes = fs::read(&absolute).map_err(|_| {
            ContractError::new("NOT_FOUND", format!("Source file not found: {file_path}"))
        })?;
        let sha = handle
            .object_store()
            .map_err(storage_error)?
            .put(&bytes)
            .map_err(storage_error)?;
        payload.insert("fileHash".into(), json!(sha));
    }
    payload.insert("retrievedAt".into(), json!(now()));
    create_draft(
        handle,
        &json!({"type": "source", "title": input["title"], "payload": payload, "files": [], "inputs": [], "rationale": "source capture"}),
        origin,
    )
}

pub(super) fn source_read(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    let artifact = require_artifact(handle, required_str(input, "sourceId")?)?;
    if artifact["type"] != "source" {
        return Err(ContractError::validation("Not a source artifact"));
    }
    let revision = if let Some(id) = artifact["selectedRevisionId"].as_str() {
        get_revision(handle, id)?
    } else {
        handle
            .db
            .query_row(
                "SELECT * FROM revision WHERE artifact_id=?1 ORDER BY seq DESC LIMIT 1",
                [required_str(&artifact, "id")?],
                revision_from_row,
            )
            .optional()
            .map_err(internal)?
    };
    Ok(
        json!({"artifact": artifact, "payload": revision.as_ref().map(|r| &r["payload"]), "revision": revision}),
    )
}

pub(super) fn test_create_draft(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    let refs = input["requirementRefs"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let inputs = refs.iter().map(|reference| json!({"artifactId":reference["artifactId"],"revisionId":reference["revisionId"],"relationship":"validates","label":"test for requirement"})).collect::<Vec<_>>();
    let mut body = json!({"procedure":input["procedure"],"results":[]});
    if let Some(conditions) = input["conditions"].as_str() {
        body["conditions"] = json!(conditions);
    }
    create_draft(
        handle,
        &json!({"type":"test","title":input["title"],"payload":body,"files":[],"inputs":inputs,"rationale":"test procedure"}),
        origin,
    )
}

pub(super) fn cad_export(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    let artifact = require_artifact(handle, required_str(input, "artifactId")?)?;
    let revision_id = artifact["selectedRevisionId"]
        .as_str()
        .ok_or_else(|| ContractError::new("NOT_FOUND", "Artifact has no baseline"))?;
    let revision = require_revision(handle, revision_id)?;
    let format = required_str(input, "format")?;
    let file = revision["files"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|file| {
            file["path"]
                .as_str()
                .is_some_and(|path| path.ends_with(&format!(".{format}")))
        })
        .ok_or_else(|| ContractError::new("NOT_FOUND", format!("No .{format} on baseline")))?;
    let sha = required_str(file, "sha256")?;
    let bytes = handle
        .object_store()
        .map_err(storage_error)?
        .read(sha)
        .map_err(storage_error)?;
    let destination = Path::new(required_str(input, "destPath")?);
    fs::create_dir_all(
        destination
            .parent()
            .ok_or_else(|| ContractError::validation("Destination has no parent"))?,
    )
    .map_err(internal)?;
    fs::write(destination, bytes).map_err(internal)?;
    Ok(json!({"path":destination}))
}

pub(super) fn project_summary(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    let project = handle
        .project()
        .map_err(storage_error)?
        .ok_or_else(|| ContractError::new("NOT_FOUND", "Project row missing"))?;
    let mut counts = BTreeMap::<String, usize>::new();
    let mut requirements = Vec::new();
    let mut assumptions = Vec::new();
    let mut stmt = handle
        .db
        .prepare("SELECT * FROM artifact WHERE archived=0 ORDER BY created_at")
        .map_err(internal)?;
    let artifacts = stmt
        .query_map([], artifact_from_row)
        .map_err(internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    for artifact in artifacts {
        let kind = required_str(&artifact, "type")?;
        *counts.entry(kind.into()).or_default() += 1;
        if !matches!(kind, "requirement" | "assumption") {
            continue;
        }
        let revision = artifact["selectedRevisionId"]
            .as_str()
            .map(|id| get_revision(handle, id))
            .transpose()?
            .flatten();
        let body = revision.as_ref().map(|r| &r["payload"]);
        if kind == "requirement" {
            let target = body
                .and_then(|p| p.get("target"))
                .filter(|v| v.get("value").is_some())
                .map(|v| format!("{} {}", v["value"], v["unit"].as_str().unwrap_or("")));
            let stale_count: i64 = handle
                .db
                .query_row(
                    "SELECT COUNT(*) FROM stale WHERE artifact_id=?1",
                    [required_str(&artifact, "id")?],
                    |row| row.get(0),
                )
                .map_err(internal)?;
            requirements.push(json!({"id": artifact["id"], "title": artifact["title"], "statement": body.map(|p| &p["statement"]).unwrap_or(&Value::Null), "target": target, "priority": body.map(|p| &p["priority"]).unwrap_or(&Value::Null), "freshness": if stale_count == 0 { "current" } else { "stale" }}));
        } else {
            assumptions.push(json!({"id": artifact["id"], "title": artifact["title"], "statement": body.map(|p| &p["statement"]).unwrap_or(&Value::Null), "needsValidation": body.map(|p| &p["needsValidation"]).unwrap_or(&Value::Null)}));
        }
    }
    let mut summary = json!({
        "project": {"id": project["id"], "name": project["name"], "intent": project["intent"]},
        "counts": counts, "requirements": requirements, "assumptions": assumptions,
        "pendingProposals": [], "staleArtifacts": [], "recentDecisions": [], "recentEvents": [],
        "tools": "omenflow call <op> or omenflow mcp — see tool.list",
        "rules": "Accepted engineering changes go through proposals; drafts are free.",
        "activeWork": null, "truncated": false,
        "detailTools": ["project.search", "artifact.read", "proposal.list"]
    });
    let mut stmt = handle
        .db
        .prepare(
            "SELECT id,reason,changes FROM proposal WHERE state='pending' ORDER BY created_at DESC",
        )
        .map_err(internal)?;
    summary["pendingProposals"] = json!(stmt.query_map([], |row| { let changes: String = row.get(2)?; Ok(json!({"id": row.get::<_, String>(0)?, "reason": row.get::<_, String>(1)?, "changes": serde_json::from_str::<Vec<Value>>(&changes).unwrap_or_default().len()})) }).map_err(internal)?.collect::<rusqlite::Result<Vec<_>>>().map_err(internal)?);
    let mut stmt = handle.db.prepare("SELECT s.artifact_id,s.reason,COALESCE(a.title,s.artifact_id) FROM stale s LEFT JOIN artifact a ON a.id=s.artifact_id").map_err(internal)?;
    summary["staleArtifacts"] = json!(stmt.query_map([], |row| Ok(json!({"artifactId": row.get::<_, String>(0)?, "reason": row.get::<_, String>(1)?, "title": row.get::<_, String>(2)?}))).map_err(internal)?.collect::<rusqlite::Result<Vec<_>>>().map_err(internal)?);
    let mut stmt = handle
        .db
        .prepare("SELECT id,action,actor,ts,rationale FROM decision ORDER BY ts DESC LIMIT 10")
        .map_err(internal)?;
    summary["recentDecisions"] = json!(stmt.query_map([], |row| Ok(json!({"id": row.get::<_, String>(0)?, "action": row.get::<_, String>(1)?, "actor": row.get::<_, String>(2)?, "ts": row.get::<_, String>(3)?, "rationale": row.get::<_, String>(4)?}))).map_err(internal)?.collect::<rusqlite::Result<Vec<_>>>().map_err(internal)?);
    let mut stmt = handle
        .db
        .prepare("SELECT seq,type,ts FROM event ORDER BY seq DESC LIMIT 10")
        .map_err(internal)?;
    summary["recentEvents"] = json!(stmt.query_map([], |row| Ok(json!({"seq": row.get::<_, i64>(0)?, "type": row.get::<_, String>(1)?, "ts": row.get::<_, String>(2)?}))).map_err(internal)?.collect::<rusqlite::Result<Vec<_>>>().map_err(internal)?);
    let budget = input["budget"].as_u64().unwrap_or(12_000) as usize;
    for key in [
        "requirements",
        "assumptions",
        "pendingProposals",
        "staleArtifacts",
        "recentDecisions",
        "recentEvents",
    ] {
        while summary.to_string().len() > budget && !summary[key].as_array().unwrap().is_empty() {
            summary["truncated"] = json!(true);
            summary[key].as_array_mut().unwrap().pop();
        }
    }
    Ok(summary)
}
