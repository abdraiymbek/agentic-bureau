//! Small domain operations shared by the desktop UI and agent bridge.
use super::*;
use omenflow_contracts::Profile;
use reads::{clip, current_revision_sql, format_quantity, statement, HEAD_REVISION};
use std::collections::hash_map::Entry;
use std::collections::{BTreeMap, HashMap};

/// Outstanding items a summary carries; `work_status` has the full list.
const SUMMARY_WORK_ITEMS: usize = 6;
const SUMMARY_STALE_ARTIFACTS: usize = 50;
/// Room kept inside the budget for the note that says what was cut.
const OMITTED_NOTE_CHARS: usize = 240;

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
        .ok_or_else(|| ContractError::not_found("job", id, "job_list"))?;
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

/// The tool catalogue, or one tool's schema and example. Names resolve in
/// dotted or underscore form.
pub(super) fn tool_describe(input: &Value) -> CoreResult<Value> {
    let payload_schema = input["artifactType"]
        .as_str()
        .map(|kind| {
            registry()
                .artifact_payload_schemas
                .get(kind)
                .cloned()
                .ok_or_else(|| ContractError::validation(format!("Unknown artifact type: {kind}")))
        })
        .transpose()?;
    let Some(requested) = input["tool"].as_str().or(input["op"].as_str()) else {
        // The tools a small model sees first come first, so a reader that
        // cuts the catalogue short loses the least used ones.
        let mut tools = registry().agent_tools().collect::<Vec<_>>();
        tools.sort_by_key(|operation| operation.tier);
        let mut catalogue = serde_json::Map::new();
        if let Some(schema) = payload_schema {
            catalogue.insert("artifactType".into(), input["artifactType"].clone());
            catalogue.insert("payloadSchema".into(), schema);
        }
        catalogue.insert(
            "tools".into(),
            tools
                .into_iter()
                .map(|operation| {
                    json!({
                        "tool": operation.tool_name,
                        "pack": operation.pack,
                        "tier": operation.tier,
                        "summary": operation.summary,
                        "mutating": operation.mutating,
                    })
                })
                .collect(),
        );
        catalogue.insert(
            "next".into(),
            json!({
                "tool": "tool_describe",
                "why": "Pass tool to get that tool's input schema and an example call",
            }),
        );
        return Ok(Value::Object(catalogue));
    };
    let operation = registry()
        .resolve(requested)
        .ok_or_else(|| registry().unknown_operation(requested))?;
    let mut result = json!({
        "op": operation.name,
        "tool": operation.tool_name,
        "description": operation.description,
        "mutating": operation.mutating,
        "pack": operation.pack,
        "tier": operation.tier,
        "summary": operation.summary,
        "agentAllowed": operation.agent_allowed,
        "example": operation.example,
        "inputSchema": operation.input_schema,
    });
    if let Some(schema) = payload_schema {
        result["payloadSchema"] = schema;
    }
    Ok(result)
}

/// The refusal an agent gets for an operation only the human may run, with
/// what to do instead.
pub(super) fn human_only(op: &str) -> ContractError {
    match op {
        "artifact.apply_edit" => ContractError::new(
            "APPROVAL_REQUIRED",
            "Agents cannot call artifact.apply_edit; the baseline changes only when the human approves",
        )
        .with_repair(
            "Save the change as a draft with artifact_update_draft (cad_write_source for a part). When review was asked for, submit it with proposal_submit and wait with proposal_wait.",
        )
        .with_details(json!({"op": op})),
        "proposal.approve"
        | "proposal.reject"
        | "proposal.request_changes"
        | "artifact.accept_draft"
        | "artifact.revert"
        | "artifact.archive" => ContractError::capability_denied(
            op,
            "Only the human decides what becomes the baseline. Submit the change with proposal_submit, then call proposal_wait, or stop and report the proposal id.",
        ),
        _ => ContractError::capability_denied(
            op,
            "Tell the human what you need done in the app. Call tool_describe with no arguments to list the tools you can call.",
        ),
    }
}

/// The `model` an adapter is configured with: `None` when the caller did not
/// send it, null to go back to the CLI's own default.
pub(super) fn adapter_model(input: &Value) -> CoreResult<Option<Value>> {
    match input.get("model") {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(Value::Null)),
        Some(Value::String(model)) => Ok(Some(match model.trim() {
            "" => Value::Null,
            model => json!(model),
        })),
        Some(_) => Err(
            ContractError::validation("Adapter model must be a string or null").with_repair(
                "Send the model id the CLI accepts, or null to use the CLI's default model.",
            ),
        ),
    }
}

/// The capability `profile` an adapter is configured with: `auto` or a
/// profile name. `None` when the caller did not send it.
pub(super) fn adapter_profile(input: &Value) -> CoreResult<Option<Value>> {
    let Some(profile) = input.get("profile") else {
        return Ok(None);
    };
    let name = profile.as_str().map(str::trim).unwrap_or_default();
    if name.eq_ignore_ascii_case("auto") {
        return Ok(Some(json!("auto")));
    }
    name.parse::<Profile>()
        .map(|profile| Some(json!(profile)))
        .map_err(|_| {
            ContractError::validation(format!("Unknown adapter profile: {profile}"))
                .with_repair("Use auto, compact, standard or full.")
        })
}

pub(super) fn tool_doctor(input: &Value) -> CoreResult<Value> {
    if input["toolId"].as_str().is_some_and(|id| id != "openscad") {
        return Ok(json!({"results": {}}));
    }
    let probe =
        cad::probe().unwrap_or_else(|error| json!({"available":false,"error":error.message}));
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

/// The bounded first read of a project: what it is for, what it states, what
/// is unfinished and what to call next.
pub(super) fn project_summary(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    let project = handle
        .project()
        .map_err(storage_error)?
        .ok_or_else(|| ContractError::new("NOT_FOUND", "Project row missing"))?;
    let counts = statement(
        handle,
        "SELECT type, COUNT(*) FROM artifact WHERE archived=0 GROUP BY type",
    )?
    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
    .map_err(internal)?
    .collect::<rusqlite::Result<BTreeMap<String, i64>>>()
    .map_err(internal)?;

    let mut stale_reasons = HashMap::<String, String>::new();
    let mut stale_artifacts = Vec::new();
    let mut stmt = statement(
        handle,
        "SELECT s.artifact_id, s.reason, a.title FROM stale s JOIN artifact a ON a.id=s.artifact_id \
         WHERE a.archived=0 ORDER BY a.created_at, a.id, s.reason='missing_input' DESC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(internal)?;
    for row in rows {
        let (id, reason, title) = row.map_err(internal)?;
        // A missing input sorts first, so it names the artifact's state.
        if let Entry::Vacant(slot) = stale_reasons.entry(id) {
            stale_artifacts
                .push(json!({"artifactId": slot.key(), "reason": reason, "title": title}));
            slot.insert(reason);
        }
    }
    let stale_total = stale_artifacts.len();
    stale_artifacts.truncate(SUMMARY_STALE_ARTIFACTS);

    // Each statement comes from the approved revision, or from the newest
    // draft when nothing is approved yet.
    let mut requirements = Vec::new();
    let mut assumptions = Vec::new();
    let mut stmt = statement(
        handle,
        &format!(
            "SELECT a.id, a.type, a.title, a.selected_revision_id IS NOT NULL, r.review_state, \
             r.payload FROM artifact a LEFT JOIN revision r ON r.id={} \
             WHERE a.archived=0 AND a.type IN ('requirement','assumption') \
             ORDER BY a.created_at, a.id",
            current_revision_sql()
        ),
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, bool>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(internal)?;
    for row in rows {
        let (id, kind, title, approved, review_state, payload) = row.map_err(internal)?;
        let body: Value = payload
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(Value::Null);
        let stated = body["statement"].as_str().unwrap_or_default();
        let review = if approved {
            "approved"
        } else if review_state.as_deref() == Some("proposed") {
            "in_review"
        } else {
            "draft"
        };
        if kind == "requirement" {
            let freshness = match stale_reasons.get(&id).map(String::as_str) {
                None => "current",
                Some("missing_input") => "missing_input",
                Some(_) => "stale",
            };
            requirements.push(json!({
                "id": id,
                "title": title,
                "statement": stated,
                "target": format_quantity(&body["target"]),
                "priority": body["priority"].as_str().unwrap_or("should"),
                "freshness": freshness,
                "review": review,
            }));
        } else {
            assumptions.push(json!({
                "id": id,
                "title": title,
                "statement": stated,
                "needsValidation": body["needsValidation"].as_bool().unwrap_or(true),
                "review": review,
            }));
        }
    }
    // Must before should before could, so a tight budget keeps what matters.
    requirements.sort_by_key(|row| match row["priority"].as_str() {
        Some("must") => 0,
        Some("should") => 1,
        _ => 2,
    });

    let pending = statement(
        handle,
        "SELECT id, reason, changes FROM proposal WHERE state='pending' ORDER BY created_at DESC",
    )?
    .query_map([], |row| {
        let changes: String = row.get(2)?;
        Ok(json!({
            "id": row.get::<_, String>(0)?,
            "reason": row.get::<_, String>(1)?,
            "changes": serde_json::from_str::<Vec<Value>>(&changes).unwrap_or_default().len(),
        }))
    })
    .map_err(internal)?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(internal)?;
    let decisions = statement(
        handle,
        "SELECT id, action, actor, ts, rationale FROM decision ORDER BY ts DESC LIMIT 10",
    )?
    .query_map([], |row| {
        Ok(json!({
            "id": row.get::<_, String>(0)?,
            "action": row.get::<_, String>(1)?,
            "actor": row.get::<_, String>(2)?,
            "ts": row.get::<_, String>(3)?,
            "rationale": row.get::<_, String>(4)?,
        }))
    })
    .map_err(internal)?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(internal)?;
    let events = statement(
        handle,
        "SELECT seq, type, ts FROM event ORDER BY seq DESC LIMIT 10",
    )?
    .query_map([], |row| {
        Ok(json!({
            "seq": row.get::<_, i64>(0)?,
            "type": row.get::<_, String>(1)?,
            "ts": row.get::<_, String>(2)?,
        }))
    })
    .map_err(internal)?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(internal)?;

    let work = gate::project_work(handle)?;
    let mut active_work = json!({
        "ready": work.ready(),
        "summary": work.summary(),
        "blockers": work.blockers(),
        "advice": work.advice(),
        "outstanding": work.outstanding().take(SUMMARY_WORK_ITEMS).collect::<Vec<_>>(),
        "waitingOnHuman": work.waiting_on_human(),
    });
    if let Some(cad) = cad_work_in_progress(handle)? {
        active_work["cad"] = cad;
    }
    let mut next = Vec::new();
    for item in work
        .outstanding()
        .filter(|item| item["severity"] == "blocker")
    {
        let tool = &item["next"]["tool"];
        if tool.is_string() && !next.iter().any(|known: &Value| known["tool"] == *tool) {
            next.push(json!({
                "tool": tool,
                "why": format!(
                    "{}: {}",
                    item["title"].as_str().unwrap_or_default(),
                    item["next"]["why"].as_str().unwrap_or_default()
                ),
            }));
        }
        if next.len() == 2 {
            break;
        }
    }
    // What to call next informs; it never suggests work nobody asked for.
    if counts.is_empty() {
        next.push(json!({
            "tool": "guide_read",
            "why": "The project holds no artifacts yet; guide_read lists a playbook for each kind of work",
        }));
    }
    next.push(json!({
        "tool": "work_status",
        "why": "Call before you say the work is done; it lists what is unfinished",
    }));

    let mut summary = json!({
        "project": {"id": project["id"], "name": project["name"], "intent": project["intent"]},
        "counts": counts,
        "requirements": requirements,
        "assumptions": assumptions,
        "activeWork": active_work,
        "next": next,
        "pendingProposals": pending,
        "staleArtifacts": stale_artifacts,
        "recentDecisions": decisions,
        "recentEvents": events,
        "tools": "Call tool_describe with no arguments for every tool, guide_read for a step-by-step playbook.",
        "rules": "Drafts are free. The baseline changes only through a proposal the human approves. Call work_status before you say the work is done.",
        "truncated": false,
        "detailTools": ["project_search", "artifact_read", "proposal_list"],
    });
    let mut omitted = serde_json::Map::new();
    if stale_total > SUMMARY_STALE_ARTIFACTS {
        omitted.insert(
            "staleArtifacts".into(),
            json!(stale_total - SUMMARY_STALE_ARTIFACTS),
        );
    }
    fit_budget(
        &mut summary,
        input["budget"].as_u64().unwrap_or(6_000) as usize,
        omitted,
    );
    Ok(summary)
}

/// The part the last committed or trial check worked on, while that revision
/// is still the newest one in play for the part.
fn cad_work_in_progress(handle: &ProjectHandle) -> CoreResult<Option<Value>> {
    let recorded = statement(handle, "SELECT value FROM meta WHERE key='work.active'")?
        .query_row([], |row| row.get::<_, String>(0))
        .optional()
        .map_err(internal)?
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or(Value::Null);
    let (Some(artifact_id), Some(candidate)) = (
        recorded["artifactId"].as_str(),
        recorded["candidateRevisionId"].as_str(),
    ) else {
        return Ok(None);
    };
    let head = statement(
        handle,
        &format!("SELECT {HEAD_REVISION} FROM artifact a WHERE a.id=?1 AND a.archived=0"),
    )?
    .query_row([artifact_id], |row| row.get::<_, Option<String>>(0))
    .optional()
    .map_err(internal)?
    .flatten();
    Ok((head.as_deref() == Some(candidate)).then(|| {
        json!({
            "artifactId": artifact_id,
            "candidateRevisionId": candidate,
            "specHash": recorded["specHash"],
            "nextAction": recorded["nextAction"],
        })
    }))
}

fn json_chars(value: &Value) -> usize {
    value.to_string().chars().count()
}

/// Cut a summary down to `budget` characters, least important content first:
/// event and decision history, then long prose, then whole rows, and the
/// requirements last. Quantities and ids are never shortened; what was cut is
/// counted under `omitted`.
fn fit_budget(summary: &mut Value, budget: usize, mut omitted: serde_json::Map<String, Value>) {
    if !omitted.is_empty() {
        summary["truncated"] = json!(true);
        summary["omitted"] = Value::Object(omitted.clone());
    }
    let mut size = json_chars(summary);
    if size > budget {
        let budget = budget.saturating_sub(OMITTED_NOTE_CHARS);
        let mut drop_rows = |summary: &mut Value, pointer: &str, keep: usize, size: &mut usize| {
            let Some(rows) = summary.pointer_mut(pointer).and_then(Value::as_array_mut) else {
                return;
            };
            let mut dropped = 0;
            while *size > budget && rows.len() > keep {
                let row = rows.pop().map_or(0, |row| json_chars(&row));
                // The separating comma goes with every row but the last one.
                *size -= row + usize::from(!rows.is_empty());
                dropped += 1;
            }
            if dropped > 0 {
                let name = pointer.trim_start_matches('/').replace('/', ".");
                let before = omitted.get(&name).and_then(Value::as_u64).unwrap_or(0);
                omitted.insert(name, json!(before + dropped));
            }
        };
        drop_rows(summary, "/recentEvents", 0, &mut size);
        drop_rows(summary, "/recentDecisions", 0, &mut size);
        if size > budget {
            clip_text(summary, "/project/intent", 600);
            for (rows, field, limit) in [
                ("/requirements", "statement", 280),
                ("/assumptions", "statement", 280),
                ("/pendingProposals", "reason", 160),
                ("/activeWork/outstanding", "detail", 160),
                ("/activeWork/waitingOnHuman", "reason", 160),
                ("/next", "why", 160),
            ] {
                let rows = summary.pointer_mut(rows).and_then(Value::as_array_mut);
                for row in rows.into_iter().flatten() {
                    clip_text(row, &format!("/{field}"), limit);
                }
            }
            size = json_chars(summary);
        }
        for (pointer, keep) in [
            ("/staleArtifacts", 0),
            ("/pendingProposals", 0),
            ("/assumptions", 0),
            ("/activeWork/outstanding", 0),
            ("/activeWork/waitingOnHuman", 0),
            ("/next", 1),
            ("/requirements", 0),
        ] {
            drop_rows(summary, pointer, keep, &mut size);
        }
        for pointer in ["/project/intent", "/project/name"] {
            while size > budget {
                let length = summary
                    .pointer(pointer)
                    .and_then(Value::as_str)
                    .map_or(0, |text| text.chars().count());
                if length == 0 {
                    break;
                }
                // Half of the text before its ellipsis, so every pass is
                // shorter than the last and two characters end at none.
                clip_text(summary, pointer, (length - 1) / 2);
                size = json_chars(summary);
            }
        }
        summary["truncated"] = json!(true);
    }
    if !omitted.is_empty() {
        summary["truncated"] = json!(true);
        summary["omitted"] = Value::Object(omitted);
    }
}

/// Shorten the string at `pointer` to `limit` characters; to nothing when
/// `limit` is zero.
fn clip_text(value: &mut Value, pointer: &str, limit: usize) {
    if let Some(slot) = value.pointer_mut(pointer) {
        if let Some(text) = slot.as_str() {
            let clipped = if limit == 0 {
                String::new()
            } else {
                clip(text, limit)
            };
            *slot = json!(clipped);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{agent, requirement, TestProject};

    fn describe(input: Value) -> CoreResult<Value> {
        TestProject::new().call(Origin::User, "tool.describe", input)
    }

    #[test]
    fn describe_resolves_underscore_dotted_and_prefixed_names() {
        for name in [
            "cad_write_source",
            "cad.write_source",
            "CAD_Write_Source",
            "mcp__omenflow__cad_write_source",
        ] {
            let described = describe(json!({"tool": name})).unwrap();
            assert_eq!(described["op"], "cad.write_source", "{name}");
            assert_eq!(described["tool"], "cad_write_source");
            assert_eq!(described["mutating"], true);
            assert_eq!(described["pack"], "cad");
            assert_eq!(described["tier"], "core");
            assert_eq!(described["agentAllowed"], true);
            assert!(described["inputSchema"]["properties"]["source"].is_object());
            assert_eq!(
                Some(&described["example"]),
                registry()
                    .operation("cad.write_source")
                    .unwrap()
                    .example
                    .as_ref()
            );
        }
        // The older argument name still works, and tool wins when both are sent.
        assert_eq!(
            describe(json!({"op": "artifact_read_file"})).unwrap()["op"],
            "artifact.read_file"
        );
        assert_eq!(
            describe(json!({"op": "cad.check", "tool": "work_status"})).unwrap()["op"],
            "work.status"
        );
        let human_only = describe(json!({"tool": "proposal_approve"})).unwrap();
        assert_eq!(human_only["agentAllowed"], false);
        assert!(human_only["example"].is_null());
    }

    #[test]
    fn describe_without_a_tool_is_the_catalogue() {
        let catalogue = describe(json!({})).unwrap();
        let tools = catalogue["tools"].as_array().unwrap();
        assert_eq!(tools.len(), registry().agent_tools().count());
        for tool in tools {
            let keys = tool.as_object().unwrap().keys().collect::<Vec<_>>();
            assert_eq!(keys, ["tool", "pack", "tier", "summary", "mutating"]);
            let name = tool["tool"].as_str().unwrap();
            assert!(!name.contains('.'), "{name}");
            let operation = registry().resolve(name).unwrap();
            assert!(operation.agent_tool);
            assert_eq!(tool["summary"], operation.summary.as_str());
            assert_eq!(tool["mutating"], operation.mutating);
        }
        // The smallest profile's tools first, in registry order within a tier.
        let tiers = tools
            .iter()
            .map(|tool| tool["tier"].as_str().unwrap())
            .collect::<Vec<_>>();
        let mut grouped = tiers.clone();
        grouped.sort_by_key(|tier| {
            ["core", "standard", "full"]
                .iter()
                .position(|name| name == tier)
        });
        assert_eq!(tiers, grouped);
        let core = tools
            .iter()
            .filter(|tool| tool["tier"] == "core")
            .map(|tool| tool["tool"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(core.len(), 13);
        assert_eq!(core[0], "project_summary");
        assert!(core.contains(&"work_status") && core.contains(&"tool_describe"));
        assert_eq!(catalogue["next"]["tool"], "tool_describe");
        assert!(catalogue.get("payloadSchema").is_none());
    }

    #[test]
    fn describe_adds_payload_fields_and_suggests_the_nearest_tool() {
        let with_tool =
            describe(json!({"tool": "artifact_create_draft", "artifactType": "requirement"}))
                .unwrap();
        assert_eq!(with_tool["op"], "artifact.create_draft");
        assert!(with_tool["payloadSchema"]["properties"]["statement"].is_object());
        assert_eq!(with_tool["example"]["type"], "requirement");

        let alone = describe(json!({"artifactType": "component"})).unwrap();
        assert_eq!(alone["artifactType"], "component");
        assert!(alone["payloadSchema"]["properties"]["partNumber"].is_object());
        assert!(alone["tools"].is_array());

        let unknown = describe(json!({"tool": "cad_chek"})).unwrap_err();
        assert_eq!(unknown.code, "NOT_FOUND");
        assert_eq!(unknown.message, "Unknown operation: cad_chek");
        assert_eq!(
            unknown.repair.as_deref(),
            Some(
                "Did you mean cad_check? Call tool_describe with no arguments to list every tool."
            )
        );
        assert_eq!(unknown.details.unwrap()["nearest"], "cad_check");
    }

    #[test]
    fn an_agent_is_told_what_to_do_instead_of_a_human_only_operation() {
        let mut project = TestProject::new();
        let id = uuid::Uuid::new_v4().to_string();

        let approve = project
            .call(agent("s1"), "proposal.approve", json!({"proposalId": id}))
            .unwrap_err();
        assert_eq!(approve.code, "CAPABILITY_DENIED");
        assert_eq!(
            approve.message,
            "Agents cannot call proposal.approve; only the human can do this"
        );
        let repair = approve.repair.unwrap();
        assert!(
            repair.contains("proposal_submit") && repair.contains("proposal_wait"),
            "{repair}"
        );
        assert_eq!(approve.details.unwrap()["op"], "proposal.approve");

        let edit = project
            .call(
                agent("s1"),
                "artifact.apply_edit",
                json!({"artifactId": id, "baseRevisionId": id, "payload": {}}),
            )
            .unwrap_err();
        assert_eq!(edit.code, "APPROVAL_REQUIRED");
        assert!(edit.repair.unwrap().contains("artifact_update_draft"));

        let settings = project
            .call(
                agent("s1"),
                "settings.set",
                json!({"key": "prefs.theme", "value": "paper"}),
            )
            .unwrap_err();
        assert_eq!(settings.code, "CAPABILITY_DENIED");
        assert!(settings.repair.unwrap().contains("tool_describe"));
        // The human is not refused.
        project.user(
            "settings.set",
            json!({"key": "prefs.theme", "value": "paper"}),
        );
    }

    #[test]
    fn missing_records_name_their_listing_tool_and_conflicts_the_current_revision() {
        let mut project = TestProject::new();
        let missing = uuid::Uuid::new_v4().to_string();
        for (op, input, tool) in [
            ("job.read", json!({"jobId": missing}), "job_list"),
            (
                "proposal.read",
                json!({"proposalId": missing}),
                "proposal_list",
            ),
            (
                "artifact.history",
                json!({"artifactId": missing}),
                "artifact_list",
            ),
            (
                "artifact.update_draft",
                json!({"artifactId": missing, "payload": {}}),
                "artifact_list",
            ),
        ] {
            // artifact.history of an unknown artifact is an empty list, not an error.
            let Err(error) = project.call(agent("s1"), op, input) else {
                assert_eq!(op, "artifact.history");
                continue;
            };
            assert_eq!(error.code, "NOT_FOUND", "{op}");
            assert!(
                error.repair.as_deref().unwrap().contains(tool),
                "{op}: {error:?}"
            );
            let details = error.details.unwrap();
            assert_eq!(details["id"], missing.as_str());
            assert_eq!(details["listingTool"], tool);
        }

        let (note, first) = project.approved("note", "Plan", json!({"markdown": "v1"}), json!([]));
        let second = project.redraft(
            Origin::User,
            &note,
            json!({"baseRevisionId": first, "payload": {"markdown": "v2"}}),
        );
        project.accept(&note, &second);
        let conflict = project
            .call(
                agent("s1"),
                "artifact.update_draft",
                json!({"artifactId": note, "baseRevisionId": first, "payload": {"markdown": "v3"}}),
            )
            .unwrap_err();
        assert_eq!(conflict.code, "REVISION_CONFLICT");
        assert_eq!(conflict.message, "Base revision is no longer selected");
        assert!(conflict.repair.unwrap().contains(&second));
        assert_eq!(
            conflict.details.unwrap()["currentRevisionId"],
            second.as_str()
        );
    }

    #[test]
    fn adapter_model_and_profile_are_saved_with_the_other_adapter_settings() {
        let directory = tempfile::tempdir().unwrap();
        let app = CoreApp::new(directory.path()).unwrap();
        app.configure_adapter(
            "codex",
            &json!({
                "executablePath": "/opt/homebrew/bin/codex",
                "args": ["--full-auto"],
                "model": " gpt-5.5-mini ",
                "profile": "compact",
            }),
        )
        .unwrap();
        // A new process reads what the last one saved.
        let app = CoreApp::new(directory.path()).unwrap();
        assert_eq!(
            app.adapter_config("codex"),
            json!({
                "executablePath": "/opt/homebrew/bin/codex",
                "args": ["--full-auto"],
                "model": "gpt-5.5-mini",
                "profile": "compact",
            })
        );

        // Keys that are not sent stay as they were; null clears the model.
        app.configure_adapter("codex", &json!({"model": null, "profile": "Auto"}))
            .unwrap();
        let saved = app.adapter_config("codex");
        assert_eq!(saved["executablePath"], "/opt/homebrew/bin/codex");
        assert!(saved["model"].is_null());
        assert_eq!(saved["profile"], "auto");
        app.configure_adapter("codex", &json!({"model": "  "}))
            .unwrap();
        assert!(app.adapter_config("codex")["model"].is_null());
        app.configure_adapter("codex", &json!({"lastTestOk": true}))
            .unwrap();
        assert_eq!(app.adapter_config("codex")["profile"], "auto");

        for bad in [
            json!({"profile": "tiny"}),
            json!({"profile": 3}),
            json!({"model": 5}),
        ] {
            let error = app.configure_adapter("codex", &bad).unwrap_err();
            assert_eq!(error.code, "VALIDATION", "{bad}");
            assert!(error.repair.is_some());
        }
        assert_eq!(app.adapter_config("codex")["profile"], "auto");
        assert!(app.adapter_config("claude-code").is_null());
    }

    fn drafted_requirements(project: &mut TestProject) -> (String, String) {
        let mut payload = requirement("Carry a 300 g camera");
        payload["target"] = json!({"value": 300, "unit": "g"});
        let (known, _) = project.draft(agent("s1"), "requirement", "Payload", payload, json!([]));
        let mut open = requirement("Survive a drop onto concrete");
        open["target"] = json!({"unknown": true, "reason": "drop height not agreed"});
        open["priority"] = json!("could");
        let (unknown, _) = project.draft(agent("s1"), "requirement", "Drop", open, json!([]));
        (known, unknown)
    }

    #[test]
    fn summary_states_requirements_that_exist_only_as_drafts() {
        let mut project = TestProject::new();
        let (known, unknown) = drafted_requirements(&mut project);
        let mut ranged = requirement("Run from a regulated 5 V rail");
        ranged["target"] = json!({"value": 5, "unit": "V", "min": 4.75, "max": 5.25});
        ranged["priority"] = json!("should");
        let (approved, _) = project.approved("requirement", "Supply", ranged, json!([]));
        project.draft(
            agent("s1"),
            "assumption",
            "Flat ground",
            json!({"statement": "The test track is level", "reason": "Lab floor", "owner": "team"}),
            json!([]),
        );

        let summary = project.agent("s1", "project.summary", json!({}));
        assert_eq!(summary["truncated"], false);
        assert_eq!(
            summary["counts"],
            json!({"assumption": 1, "requirement": 3})
        );
        // Must before should before could.
        assert_eq!(
            summary["requirements"],
            json!([
                {"id": known, "title": "Payload", "statement": "Carry a 300 g camera",
                 "target": "300 g", "priority": "must", "freshness": "current", "review": "draft"},
                {"id": approved, "title": "Supply", "statement": "Run from a regulated 5 V rail",
                 "target": "5 [4.75–5.25] V", "priority": "should", "freshness": "current", "review": "approved"},
                {"id": unknown, "title": "Drop", "statement": "Survive a drop onto concrete",
                 "target": "unknown (drop height not agreed)", "priority": "could", "freshness": "current", "review": "draft"},
            ])
        );
        assert_eq!(
            summary["assumptions"][0]["statement"],
            "The test track is level"
        );
        assert_eq!(summary["assumptions"][0]["needsValidation"], true);
        assert_eq!(summary["assumptions"][0]["review"], "draft");

        // Tool names are the ones an agent can call.
        assert_eq!(
            summary["detailTools"],
            json!(["project_search", "artifact_read", "proposal_list"])
        );
        let text = summary.to_string();
        for dotted in ["tool.list", "project.search", "artifact.read", "cad.check"] {
            assert!(!text.contains(dotted), "{dotted}");
        }
        let next = summary["next"].as_array().unwrap();
        assert_eq!(next.len(), 1);
        assert_eq!(next[0]["tool"], "work_status");
        assert!(summary["rules"].as_str().unwrap().contains("work_status"));
        for suggestion in next {
            assert!(registry()
                .resolve(suggestion["tool"].as_str().unwrap())
                .is_some());
            assert!(suggestion["why"].is_string());
        }
    }

    #[test]
    fn summary_reports_unfinished_work_and_what_to_call_next() {
        let mut project = TestProject::new();
        let empty = project.user("project.summary", json!({}));
        assert_eq!(
            empty["activeWork"],
            json!({
                "ready": true,
                "summary": "Nothing is unfinished in this project.",
                "blockers": 0,
                "advice": 0,
                "outstanding": [],
                "waitingOnHuman": [],
            })
        );
        assert_eq!(empty["next"][0]["tool"], "guide_read");
        assert_eq!(empty["next"][1]["tool"], "work_status");

        drafted_requirements(&mut project);
        let (budget, budget_at) = project.draft(
            agent("s1"),
            "calculation",
            "Mass budget",
            json!({"expression": "chassis + battery"}),
            json!([]),
        );
        let (plan, plan_at) = project.draft(
            agent("s1"),
            "note",
            "Test plan",
            json!({"markdown": "v1"}),
            json!([]),
        );
        let submit = |project: &mut TestProject, artifact: &str, revision: &str| {
            project.agent(
                "s1",
                "proposal.submit",
                json!({
                    "changes": [{"artifactId": artifact, "newRevisionId": revision, "baseRevisionId": null, "kind": "new_artifact"}],
                    "reason": format!("Review {artifact}"),
                }),
            )
        };
        let returned = submit(&mut project, &plan, &plan_at);
        project.user(
            "proposal.request_changes",
            json!({"proposalId": returned["id"], "rationale": "State the load"}),
        );
        let waiting = submit(&mut project, &budget, &budget_at);

        // A session that did none of this still sees it: the summary covers
        // the project, so work can be picked up again.
        let summary = project.agent("s9", "project.summary", json!({}));
        let work = &summary["activeWork"];
        assert_eq!(work["ready"], false);
        assert_eq!(work["blockers"], 2);
        assert_eq!(work["advice"], 2);
        assert_eq!(
            work["summary"],
            "1 calculation has not been run. 1 proposal was returned for changes. 2 drafts are not submitted for review. 1 proposal awaits the human's decision."
        );
        let kinds = work["outstanding"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["kind"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            kinds,
            [
                "calculation_not_run",
                "changes_requested",
                "draft_unproposed",
                "draft_unproposed"
            ]
        );
        assert_eq!(
            work["outstanding"][0]["next"]["args"]["artifactId"],
            budget.as_str()
        );
        assert_eq!(work["waitingOnHuman"][0]["proposalId"], waiting["id"]);
        assert_eq!(summary["pendingProposals"][0]["id"], waiting["id"]);
        assert_eq!(
            summary["next"],
            json!([
                {"tool": "calculation_run", "why": "Mass budget: Run it so the result is computed and recorded with its unit"},
                {"tool": "proposal_read", "why": "Test plan: Read the request, revise the draft, then submit a new proposal"},
                {"tool": "work_status", "why": "Call before you say the work is done; it lists what is unfinished"},
            ])
        );
    }

    /// A project with work but no requirement is not told to capture one: an
    /// agent asked for a part should make the part.
    #[test]
    fn next_never_suggests_work_nobody_asked_for() {
        let mut project = TestProject::new();
        project.draft(
            agent("s1"),
            "note",
            "Bench notes",
            json!({"markdown": "Measured by hand."}),
            json!([]),
        );
        let summary = project.agent("s1", "project.summary", json!({}));
        assert!(summary["requirements"].as_array().unwrap().is_empty());
        assert_eq!(
            summary["next"],
            json!([{"tool": "work_status", "why": "Call before you say the work is done; it lists what is unfinished"}])
        );
        assert!(!summary["next"].to_string().contains("requirement"));
    }

    #[test]
    fn summary_fits_its_budget_by_cutting_history_before_requirements() {
        let mut project =
            TestProject::with_intent(&"Carry a camera across rough ground. ".repeat(60));
        for index in 0..24 {
            let mut payload = requirement(&format!(
                "Requirement {index}: the rover keeps working when condition {index} holds for an hour"
            ));
            payload["priority"] = json!(["must", "should", "could"][index % 3]);
            payload["target"] = json!({"value": index, "unit": "kg"});
            let (id, revision) = project.draft(
                agent("s1"),
                "requirement",
                &format!("Need {index}"),
                payload,
                json!([]),
            );
            if index < 12 {
                project.accept(&id, &revision);
            }
        }
        for index in 0..6 {
            project.draft(
                agent("s1"),
                "assumption",
                &format!("Assumption {index}"),
                json!({"statement": format!("Assumption {index} holds"), "reason": "Bench notes", "owner": "team"}),
                json!([]),
            );
        }
        let chars = |summary: &Value| summary.to_string().chars().count();
        let rows = |summary: &Value, key: &str| summary[key].as_array().unwrap().len();

        let whole = project.user("project.summary", json!({"budget": 200_000}));
        assert_eq!(whole["truncated"], false);
        assert!(whole.get("omitted").is_none());
        assert_eq!(rows(&whole, "requirements"), 24);
        assert_eq!(rows(&whole, "recentEvents"), 10);
        assert_eq!(rows(&whole, "recentDecisions"), 10);

        // A little too large: only event history goes.
        let trimmed = project.user("project.summary", json!({"budget": chars(&whole) - 100}));
        assert!(chars(&trimmed) <= chars(&whole) - 100);
        assert_eq!(trimmed["truncated"], true);
        assert!(rows(&trimmed, "recentEvents") < 10);
        assert_eq!(rows(&trimmed, "recentDecisions"), 10);
        assert_eq!(rows(&trimmed, "requirements"), 24);
        assert_eq!(trimmed["project"]["intent"], whole["project"]["intent"]);
        assert_eq!(
            trimmed["omitted"]["recentEvents"],
            10 - rows(&trimmed, "recentEvents")
        );

        for budget in [6_000, 4_000, 2_500, 1_500] {
            let summary = project.user("project.summary", json!({"budget": budget}));
            assert!(chars(&summary) <= budget, "{} > {budget}", chars(&summary));
            assert_eq!(summary["truncated"], true);
            let requirements = summary["requirements"].as_array().unwrap();
            for row in requirements
                .iter()
                .chain(summary["assumptions"].as_array().unwrap())
            {
                assert!(row["statement"].is_string(), "{row}");
            }
            if requirements.len() < 24 {
                // Requirements are the last rows to go, least important first.
                for emptied in [
                    "recentEvents",
                    "recentDecisions",
                    "assumptions",
                    "staleArtifacts",
                ] {
                    assert_eq!(rows(&summary, emptied), 0, "{emptied} at {budget}");
                }
                assert_eq!(summary["omitted"]["requirements"], 24 - requirements.len());
                let kept_could = requirements
                    .iter()
                    .filter(|row| row["priority"] == "could")
                    .count();
                let kept_must = requirements
                    .iter()
                    .filter(|row| row["priority"] == "must")
                    .count();
                assert!(kept_could == 0 || kept_must == 8, "{requirements:?}");
            }
            // Quantities are dropped with their row, never shortened.
            for row in requirements {
                assert!(row["target"].as_str().unwrap().ends_with(" kg"), "{row}");
            }
            assert!(summary["activeWork"]["summary"].is_string());
            assert_eq!(summary["next"][0]["tool"], "work_status");
        }

        // Below the size of the fixed frame nothing more can go; it still answers.
        let frame = project.user("project.summary", json!({"budget": 200}));
        assert_eq!(frame["truncated"], true);
        assert_eq!(rows(&frame, "requirements"), 0);
        assert_eq!(frame["project"]["intent"], "");
        assert!(chars(&frame) < 1_200, "{}", chars(&frame));
    }
}
