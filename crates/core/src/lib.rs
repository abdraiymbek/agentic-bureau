//! Rust application command layer. Each migrated operation is kept behind the
//! same contract name and JSON shape as the v0.1 TypeScript implementation.

mod graph;
mod models;

use base64::Engine;
use chrono::{SecondsFormat, Utc};
use omenflow_contracts::{parse_artifact_payload, parse_input, registry, ContractError};
use omenflow_storage::{
    resolve_materialization_path, write_materialized_file, ProjectHandle, StorageError,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

pub use models::{artifact_from_row, event_from_row, revision_from_row};

pub type CoreResult<T> = Result<T, ContractError>;

#[derive(Clone, Debug)]
pub enum Origin {
    User,
    Agent { session_id: String },
    System,
}

impl Origin {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Agent { .. } => "agent",
            Self::System => "system",
        }
    }

    pub fn session_id(&self) -> Option<&str> {
        match self {
            Self::Agent { session_id } => Some(session_id),
            _ => None,
        }
    }
}

pub struct CoreApp {
    app_data_dir: PathBuf,
    projects: HashMap<String, ProjectHandle>,
    recent_projects: Vec<String>,
}

impl CoreApp {
    pub fn new(app_data_dir: impl AsRef<Path>) -> CoreResult<Self> {
        let app_data_dir = app_data_dir.as_ref().to_path_buf();
        fs::create_dir_all(&app_data_dir).map_err(internal)?;
        let settings = fs::read(app_data_dir.join("settings.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .unwrap_or_else(|| json!({}));
        let recent_projects = settings["recentProjects"]
            .as_array()
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        Ok(Self {
            app_data_dir,
            projects: HashMap::new(),
            recent_projects,
        })
    }

    pub fn dispatch(
        &mut self,
        op: &str,
        payload: Value,
        origin: Origin,
        project_id: Option<&str>,
    ) -> CoreResult<Value> {
        let definition = registry()
            .operation(op)
            .ok_or_else(|| ContractError::validation(format!("Unknown operation: {op}")))?;
        if matches!(origin, Origin::Agent { .. }) && !definition.agent_allowed {
            let code = if op == "artifact.apply_edit" {
                "APPROVAL_REQUIRED"
            } else {
                "CAPABILITY_DENIED"
            };
            return Err(ContractError::new(code, format!("Agents cannot call {op}")));
        }
        let payload = parse_input(definition, payload)?;
        match op {
            "project.create" => {
                let path = required_str(&payload, "path")?;
                let name = required_str(&payload, "name")?;
                let intent = required_str(&payload, "intent")?;
                let handle = ProjectHandle::create(path, name, intent).map_err(storage_error)?;
                self.register(handle)
            }
            "project.open" => {
                let path = required_str(&payload, "path")?;
                let canonical = omenflow_storage::canonicalize(path).map_err(storage_error)?;
                if let Some((id, handle)) = self.projects.iter().find(|(_, h)| h.root == canonical)
                {
                    return Ok(
                        json!({"project": handle.project().map_err(storage_error)?, "projectId": id}),
                    );
                }
                let handle = ProjectHandle::open(canonical).map_err(storage_error)?;
                self.register(handle)
            }
            "project.list_open" => Ok(json!({"projects": self.projects.values().map(|h| {
                let project = h.project().ok().flatten().unwrap_or(Value::Null);
                json!({"id": project["id"], "name": project["name"], "root": h.root})
            }).collect::<Vec<_>>()})),
            "project.close" => {
                let id = project_id
                    .ok_or_else(|| ContractError::validation("Project id is required"))?;
                if self.projects.remove(id).is_none() {
                    return Err(ContractError::new(
                        "NOT_FOUND",
                        format!("Project not open: {id}"),
                    ));
                }
                Ok(json!({"ok": true}))
            }
            "app.recent_projects" => {
                let projects = self
                    .recent_projects
                    .iter()
                    .filter(|p| Path::new(p).exists())
                    .collect::<Vec<_>>();
                let mut project_names = serde_json::Map::new();
                for path in &projects {
                    if let Ok(bytes) = fs::read(Path::new(path).join("omenflow.project.json")) {
                        if let Ok(marker) = serde_json::from_slice::<Value>(&bytes) {
                            if let Some(name) = marker["name"].as_str() {
                                project_names.insert((**path).clone(), json!(name));
                            }
                        }
                    }
                }
                Ok(json!({"projects": projects, "projectNames": project_names}))
            }
            _ => {
                let id = project_id.ok_or_else(|| {
                    ContractError::validation(format!("Operation {op} needs a projectId"))
                })?;
                let handle = self.projects.get_mut(id).ok_or_else(|| {
                    ContractError::new("NOT_FOUND", format!("Project not open: {id}"))
                })?;
                if definition.mutating {
                    handle.assert_writable().map_err(storage_error)?;
                }
                dispatch_project(handle, op, &payload, &origin)
            }
        }
    }

    pub fn latest_event_seq(&self, project_id: &str) -> CoreResult<i64> {
        let handle = self
            .projects
            .get(project_id)
            .ok_or_else(|| ContractError::new("NOT_FOUND", "Project not open"))?;
        handle
            .db
            .query_row("SELECT COALESCE(MAX(seq),0) FROM event", [], |row| {
                row.get(0)
            })
            .map_err(internal)
    }

    pub fn events_since(&self, project_id: &str, seq: i64) -> CoreResult<Vec<Value>> {
        let handle = self
            .projects
            .get(project_id)
            .ok_or_else(|| ContractError::new("NOT_FOUND", "Project not open"))?;
        let mut stmt = handle
            .db
            .prepare("SELECT * FROM event WHERE seq>?1 ORDER BY seq LIMIT 500")
            .map_err(internal)?;
        let events = stmt
            .query_map([seq], event_from_row)
            .map_err(internal)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal)?;
        Ok(events)
    }

    fn register(&mut self, handle: ProjectHandle) -> CoreResult<Value> {
        let project = handle
            .project()
            .map_err(storage_error)?
            .ok_or_else(|| ContractError::new("INTERNAL", "Project row missing"))?;
        let id = required_str(&project, "id")?.to_owned();
        if let Some(existing) = self.projects.get(&id) {
            if existing.root != handle.root {
                return Err(ContractError::new(
                    "REVISION_CONFLICT",
                    "Another folder with this project identity is already open",
                ));
            }
        }
        let path = handle.root.to_string_lossy().to_string();
        self.recent_projects.retain(|p| p != &path);
        self.recent_projects.insert(0, path);
        self.recent_projects.truncate(20);
        self.save_settings()?;
        self.projects.insert(id.clone(), handle);
        Ok(json!({"project": project, "projectId": id}))
    }

    fn save_settings(&self) -> CoreResult<()> {
        let path = self.app_data_dir.join("settings.json");
        let mut settings: Value = fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_else(|| json!({}));
        settings["recentProjects"] = json!(self.recent_projects);
        let temp = self
            .app_data_dir
            .join(format!("settings-{}.tmp", uuid::Uuid::new_v4()));
        fs::write(
            &temp,
            serde_json::to_vec_pretty(&settings).map_err(internal)?,
        )
        .map_err(internal)?;
        fs::rename(temp, path).map_err(internal)
    }
}

fn dispatch_project(
    handle: &mut ProjectHandle,
    op: &str,
    payload: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    match op {
        "artifact.list" => artifact_list(handle, payload),
        "artifact.read" => artifact_read(handle, payload),
        "artifact.history" => artifact_history(handle, payload),
        "artifact.read_file" => artifact_read_file(handle, payload),
        "project.changes_since" => changes_since(handle, payload),
        "project.search" => project_search(handle, payload),
        "graph.list" => graph_list(handle),
        "graph.neighbors" => graph::neighbors(handle, payload),
        "graph.impact" => graph::impact(handle, payload),
        "graph.propose_edges" => graph::propose_edges(handle, payload, origin.kind()),
        "job.list" => job_list(handle, payload),
        "proposal.list" => proposal_list(handle, payload),
        "proposal.read" => proposal_read(handle, payload),
        "proposal.submit" => proposal_submit(handle, payload, origin),
        "proposal.approve" => proposal_resolve(handle, payload, "accepted"),
        "proposal.reject" => proposal_resolve(handle, payload, "rejected"),
        "proposal.request_changes" => proposal_resolve(handle, payload, "changes_requested"),
        "artifact.create_draft" => create_draft(handle, payload, origin),
        "artifact.update_draft" => update_draft(handle, payload, origin),
        "artifact.accept_draft" => accept_draft(handle, payload),
        "terminal.state" => Ok(json!({"session": null})),
        _ => Err(ContractError::new(
            "INTERNAL",
            format!("Rust operation {op} has not been ported"),
        )),
    }
}

fn artifact_list(handle: &ProjectHandle, payload: &Value) -> CoreResult<Value> {
    let mut stmt = handle.db.prepare(
        "SELECT * FROM artifact WHERE (?1 IS NULL OR type=?1) AND (?2 IS NULL OR subsystem=?2) AND (?3=1 OR archived=0) ORDER BY created_at LIMIT ?4 OFFSET ?5"
    ).map_err(internal)?;
    let rows = stmt
        .query_map(
            params![
                payload["type"].as_str(),
                payload["subsystem"].as_str(),
                payload["includeArchived"].as_bool().unwrap_or(false) as i64,
                payload["limit"].as_i64().unwrap_or(200),
                payload["offset"].as_i64().unwrap_or(0)
            ],
            artifact_from_row,
        )
        .map_err(internal)?;
    let artifacts = rows
        .map(|row| {
            row.map_err(internal)
                .and_then(|a| artifact_view(handle, &a))
        })
        .collect::<CoreResult<Vec<_>>>()?;
    Ok(json!({"artifacts": artifacts}))
}

fn artifact_view(handle: &ProjectHandle, artifact: &Value) -> CoreResult<Value> {
    let id = required_str(artifact, "id")?;
    let revision = if let Some(selected) = artifact["selectedRevisionId"].as_str() {
        get_revision(handle, selected)?
    } else {
        None
    };
    let draft_count: i64 = handle
        .db
        .query_row(
            "SELECT COUNT(*) FROM revision WHERE artifact_id=?1 AND review_state='draft'",
            [id],
            |row| row.get(0),
        )
        .map_err(internal)?;
    let mut stmt = handle
        .db
        .prepare("SELECT changes FROM proposal WHERE state='pending'")
        .map_err(internal)?;
    let pending = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(internal)?
        .filter_map(Result::ok)
        .filter_map(|changes| serde_json::from_str::<Value>(&changes).ok())
        .any(|changes| {
            changes
                .as_array()
                .is_some_and(|items| items.iter().any(|change| change["artifactId"] == id))
        });
    let mut stmt = handle.db.prepare("SELECT artifact_id,upstream_artifact_id,expected_revision_id,actual_revision_id,path,reason,since_event_seq FROM stale WHERE artifact_id=?1").map_err(internal)?;
    let stale = stmt.query_map([id], |row| {
        Ok(json!({
            "artifactId": row.get::<_, String>(0)?, "upstreamArtifactId": row.get::<_, String>(1)?,
            "expectedRevisionId": row.get::<_, Option<String>>(2)?, "actualRevisionId": row.get::<_, Option<String>>(3)?,
            "path": serde_json::from_str::<Value>(&row.get::<_, String>(4)?).unwrap_or(json!([])),
            "reason": row.get::<_, String>(5)?, "sinceEventSeq": row.get::<_, i64>(6)?,
        }))
    }).map_err(internal)?.collect::<rusqlite::Result<Vec<_>>>().map_err(internal)?;
    let freshness = if stale.iter().any(|s| s["reason"] == "missing_input") {
        "missing_input"
    } else if stale.is_empty() {
        "current"
    } else {
        "stale"
    };
    Ok(
        json!({"artifact": artifact, "revision": revision, "freshness": freshness, "staleReasons": stale, "draftCount": draft_count, "pendingProposal": pending}),
    )
}

fn artifact_read(handle: &ProjectHandle, payload: &Value) -> CoreResult<Value> {
    let id = required_str(payload, "artifactId")?;
    let artifact = require_artifact(handle, id)?;
    let revision = if let Some(id) = payload["revisionId"]
        .as_str()
        .or(artifact["selectedRevisionId"].as_str())
    {
        get_revision(handle, id)?
    } else {
        let mut stmt = handle
            .db
            .prepare("SELECT * FROM revision WHERE artifact_id=?1 ORDER BY seq DESC LIMIT 1")
            .map_err(internal)?;
        stmt.query_row([id], revision_from_row)
            .optional()
            .map_err(internal)?
    };
    if revision.as_ref().is_some_and(|r| r["artifactId"] != id) {
        return Err(ContractError::validation(
            "Revision does not belong to artifact",
        ));
    }
    let mut stmt = handle.db.prepare("SELECT * FROM revision WHERE artifact_id=?1 AND review_state='draft' ORDER BY created_at").map_err(internal)?;
    let drafts = stmt
        .query_map([id], revision_from_row)
        .map_err(internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    Ok(json!({"view": artifact_view(handle, &artifact)?, "revision": revision, "drafts": drafts}))
}

fn artifact_history(handle: &ProjectHandle, payload: &Value) -> CoreResult<Value> {
    let id = required_str(payload, "artifactId")?;
    let mut stmt = handle
        .db
        .prepare("SELECT * FROM revision WHERE artifact_id=?1 ORDER BY seq")
        .map_err(internal)?;
    let revisions = stmt
        .query_map([id], revision_from_row)
        .map_err(internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    Ok(json!({"revisions": revisions}))
}

fn artifact_read_file(handle: &ProjectHandle, payload: &Value) -> CoreResult<Value> {
    let artifact_id = required_str(payload, "artifactId")?;
    let path = required_str(payload, "path")?;
    let artifact = require_artifact(handle, artifact_id)?;
    let revision = if let Some(id) = payload["revisionId"]
        .as_str()
        .or(artifact["selectedRevisionId"].as_str())
    {
        get_revision(handle, id)?
    } else {
        let mut stmt = handle.db.prepare("SELECT * FROM revision WHERE artifact_id=?1 AND review_state NOT IN ('rejected','superseded') ORDER BY seq DESC LIMIT 1").map_err(internal)?;
        stmt.query_row([artifact_id], revision_from_row)
            .optional()
            .map_err(internal)?
    };
    let revision =
        revision.ok_or_else(|| ContractError::new("NOT_FOUND", "Artifact has no revision"))?;
    if revision["artifactId"] != artifact_id {
        return Err(ContractError::validation(
            "Revision does not belong to artifact",
        ));
    }
    let file = revision["files"]
        .as_array()
        .and_then(|files| files.iter().find(|file| file["path"] == path))
        .ok_or_else(|| ContractError::new("NOT_FOUND", format!("File not on revision: {path}")))?;
    let sha = file["sha256"].as_str().ok_or_else(|| {
        ContractError::new(
            "NOT_FOUND",
            format!("Revision has no immutable bytes for {path}"),
        )
    })?;
    let bytes = handle
        .object_store()
        .map_err(storage_error)?
        .read(sha)
        .map_err(storage_error)?;
    Ok(
        json!({"contentBase64": base64::engine::general_purpose::STANDARD.encode(bytes), "sha256": sha}),
    )
}

fn changes_since(handle: &ProjectHandle, payload: &Value) -> CoreResult<Value> {
    let seq = payload["seq"].as_i64().unwrap_or(0);
    let mut stmt = handle
        .db
        .prepare("SELECT * FROM event WHERE seq>?1 ORDER BY seq LIMIT 500")
        .map_err(internal)?;
    let events = stmt
        .query_map([seq], event_from_row)
        .map_err(internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    let next = events
        .last()
        .and_then(|event| event["seq"].as_i64())
        .unwrap_or(seq);
    let high_water: i64 = handle
        .db
        .query_row("SELECT COALESCE(MAX(seq),0) FROM event", [], |row| {
            row.get(0)
        })
        .map_err(internal)?;
    Ok(
        json!({"events": events, "latest": next, "nextCursor": next, "highWater": high_water, "hasMore": next < high_water}),
    )
}

fn project_search(handle: &ProjectHandle, payload: &Value) -> CoreResult<Value> {
    let query = required_str(payload, "query")?.replace('"', " ");
    let query = query.trim();
    if query.is_empty() {
        return Ok(json!({"results": []}));
    }
    let mut stmt = handle.db.prepare(
        "SELECT f.artifact_id, f.revision_id, f.title, snippet(artifact_fts, 3, '«', '»', '…', 12), COALESCE(a.type,'note') FROM artifact_fts f LEFT JOIN artifact a ON a.id=f.artifact_id WHERE artifact_fts MATCH ?1 ORDER BY rank LIMIT ?2"
    ).map_err(internal)?;
    let results = stmt.query_map(params![query, payload["limit"].as_i64().unwrap_or(20)], |row| {
        Ok(json!({"artifactId": row.get::<_, String>(0)?, "revisionId": row.get::<_, String>(1)?, "title": row.get::<_, String>(2)?, "snippet": row.get::<_, String>(3)?, "type": row.get::<_, String>(4)?}))
    }).map_err(|e| ContractError::new("VALIDATION", format!("Search failed: {e}")))?.collect::<rusqlite::Result<Vec<_>>>().map_err(internal)?;
    Ok(json!({"results": results}))
}

fn graph_list(handle: &ProjectHandle) -> CoreResult<Value> {
    Ok(json!({"edges": graph::GraphSnapshot::load(handle, &[])?.edges}))
}

fn job_list(handle: &ProjectHandle, payload: &Value) -> CoreResult<Value> {
    let mut stmt = handle
        .db
        .prepare(
            "SELECT * FROM job WHERE (?1 IS NULL OR status=?1) ORDER BY created_at DESC LIMIT ?2",
        )
        .map_err(internal)?;
    let jobs = stmt
        .query_map(
            params![
                payload["status"].as_str(),
                payload["limit"].as_i64().unwrap_or(50)
            ],
            models::job_from_row,
        )
        .map_err(internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    Ok(json!({"jobs": jobs}))
}

fn proposal_list(handle: &ProjectHandle, payload: &Value) -> CoreResult<Value> {
    let state = payload["state"].as_str();
    let mut stmt = handle.db.prepare("SELECT id,changes,reason,impact,state,created_by,created_by_session,created_at,resolved_at,resolution_rationale FROM proposal WHERE (?1 IS NULL OR state=?1) ORDER BY created_at DESC").map_err(internal)?;
    let proposals = stmt
        .query_map([state], models::proposal_from_row)
        .map_err(internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    Ok(json!({"proposals": proposals}))
}

fn create_draft(handle: &mut ProjectHandle, payload: &Value, origin: &Origin) -> CoreResult<Value> {
    let id = uuid::Uuid::new_v4().to_string();
    let type_name = required_str(payload, "type")?;
    let title = required_str(payload, "title")?;
    let body = parse_artifact_payload(
        type_name,
        if payload["payload"].is_null() {
            json!({})
        } else {
            payload["payload"].clone()
        },
    )?;
    let files = ingest_files(handle, &payload["files"])?;
    let inputs = normalize_inputs(handle, &id, &payload["inputs"])?;
    let file_hashes = files
        .iter()
        .filter_map(|file| file["sha256"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    let digest = models::content_hash(&body, &file_hashes);
    let now = now();
    let rev_id = uuid::Uuid::new_v4().to_string();
    let tx = handle.db.unchecked_transaction().map_err(internal)?;
    tx.execute("INSERT INTO artifact(id,type,title,subsystem,selected_revision_id,archived,created_at) VALUES(?1,?2,?3,?4,NULL,0,?5)", params![id, type_name, title, payload["subsystem"].as_str(), now]).map_err(internal)?;
    tx.execute("INSERT INTO revision(id,artifact_id,parent_id,seq,origin,origin_detail,created_at,payload,content_hash,files,inputs,rationale,review_state) VALUES(?1,?2,NULL,1,?3,?4,?5,?6,?7,?8,?9,?10,'draft')",
        params![rev_id, id, origin.kind(), origin.session_id(), now, body.to_string(), digest, json!(files).to_string(), json!(inputs).to_string(), payload["rationale"].as_str().unwrap_or("")]).map_err(internal)?;
    tx.execute("DELETE FROM artifact_fts WHERE artifact_id=?1", [&id])
        .map_err(internal)?;
    tx.execute(
        "INSERT INTO artifact_fts(artifact_id,revision_id,title,text) VALUES(?1,?2,?3,?4)",
        params![
            id,
            rev_id,
            title,
            body.to_string().chars().take(20_000).collect::<String>()
        ],
    )
    .map_err(internal)?;
    tx.execute(
        "INSERT INTO event(id,type,origin,ts,data) VALUES(?1,'revision.committed',?2,?3,?4)",
        params![
            uuid::Uuid::new_v4().to_string(),
            origin.kind(),
            now,
            json!({"artifactId": id, "revisionId": rev_id, "reviewState": "draft"}).to_string()
        ],
    )
    .map_err(internal)?;
    tx.commit().map_err(internal)?;
    materialize_files(handle, &files, None)?;
    let artifact = require_artifact(handle, &id)?;
    let revision = get_revision(handle, &rev_id)?.unwrap();
    Ok(json!({"artifact": artifact, "revision": revision}))
}

fn update_draft(handle: &mut ProjectHandle, input: &Value, origin: &Origin) -> CoreResult<Value> {
    let artifact_id = required_str(input, "artifactId")?;
    let mut artifact = require_artifact(handle, artifact_id)?;
    if let (Some(requested), Some(selected)) = (
        input["baseRevisionId"].as_str(),
        artifact["selectedRevisionId"].as_str(),
    ) {
        if requested != selected {
            return Err(ContractError::new(
                "REVISION_CONFLICT",
                "Base revision is no longer selected",
            ));
        }
    }
    let parent_id = input["draftRevisionId"]
        .as_str()
        .or(input["baseRevisionId"].as_str())
        .or(artifact["selectedRevisionId"].as_str());
    let parent = parent_id
        .map(|id| get_revision(handle, id))
        .transpose()?
        .flatten();
    if let Some(parent) = &parent {
        if parent["artifactId"] != artifact_id {
            return Err(ContractError::validation(
                "Parent revision does not belong to artifact",
            ));
        }
    }
    let body = parse_artifact_payload(
        required_str(&artifact, "type")?,
        input
            .get("payload")
            .cloned()
            .or_else(|| parent.as_ref().map(|p| p["payload"].clone()))
            .unwrap_or_else(|| json!({})),
    )?;
    let files = if input.get("files").is_some() {
        ingest_files(handle, &input["files"])?
    } else {
        parent
            .as_ref()
            .and_then(|p| p["files"].as_array())
            .cloned()
            .unwrap_or_default()
    };
    let inputs = if input.get("inputs").is_some() {
        normalize_inputs(handle, artifact_id, &input["inputs"])?
    } else {
        parent
            .as_ref()
            .and_then(|p| p["inputs"].as_array())
            .cloned()
            .unwrap_or_default()
    };
    graph::validate_revision_inputs(handle, artifact_id, &inputs)?;
    let hashes = files
        .iter()
        .filter_map(|file| file["sha256"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    let revision_id = uuid::Uuid::new_v4().to_string();
    let next_seq: i64 = handle
        .db
        .query_row(
            "SELECT COALESCE(MAX(seq),0)+1 FROM revision WHERE artifact_id=?1",
            [artifact_id],
            |row| row.get(0),
        )
        .map_err(internal)?;
    let now = now();
    let rationale = input["rationale"]
        .as_str()
        .or_else(|| parent.as_ref().and_then(|p| p["rationale"].as_str()))
        .unwrap_or("");
    let title = input["title"]
        .as_str()
        .unwrap_or(required_str(&artifact, "title")?);
    let tx = handle.db.unchecked_transaction().map_err(internal)?;
    tx.execute("INSERT INTO revision(id,artifact_id,parent_id,seq,origin,origin_detail,created_at,payload,content_hash,files,inputs,rationale,review_state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'draft')", params![revision_id, artifact_id, parent_id, next_seq, origin.kind(), origin.session_id(), now, body.to_string(), models::content_hash(&body, &hashes), json!(files).to_string(), json!(inputs).to_string(), rationale]).map_err(internal)?;
    if input["title"].is_string() {
        tx.execute(
            "UPDATE artifact SET title=?1 WHERE id=?2",
            params![title, artifact_id],
        )
        .map_err(internal)?;
    }
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
            title,
            body.to_string().chars().take(20_000).collect::<String>()
        ],
    )
    .map_err(internal)?;
    tx.execute(
        "INSERT INTO event(id,type,origin,ts,data) VALUES(?1,'revision.committed',?2,?3,?4)",
        params![
            uuid::Uuid::new_v4().to_string(),
            origin.kind(),
            now,
            json!({"artifactId": artifact_id, "revisionId": revision_id, "reviewState": "draft"})
                .to_string()
        ],
    )
    .map_err(internal)?;
    tx.commit().map_err(internal)?;
    materialize_files(handle, &files, parent.as_ref())?;
    artifact = require_artifact(handle, artifact_id)?;
    Ok(json!({"artifact": artifact, "revision": get_revision(handle, &revision_id)?}))
}

fn accept_draft(handle: &mut ProjectHandle, input: &Value) -> CoreResult<Value> {
    let artifact_id = required_str(input, "artifactId")?;
    let artifact = require_artifact(handle, artifact_id)?;
    let revision_id = required_str(input, "draftRevisionId")?;
    let revision = require_revision(handle, revision_id)?;
    validate_active_candidate(&artifact, &revision)?;
    let mut ancestor = Some(revision.clone());
    while let Some(candidate) = &ancestor {
        if candidate["id"] == artifact["selectedRevisionId"] {
            break;
        }
        if !matches!(
            candidate["reviewState"].as_str(),
            Some("draft" | "proposed")
        ) {
            break;
        }
        ancestor = candidate["parentId"]
            .as_str()
            .map(|id| get_revision(handle, id))
            .transpose()?
            .flatten();
    }
    if ancestor.as_ref().map(|a| &a["id"]).unwrap_or(&Value::Null)
        != &artifact["selectedRevisionId"]
    {
        return Err(ContractError::new(
            "REVISION_CONFLICT",
            "Draft is based on an older baseline",
        ));
    }
    assert_simple_approval(&artifact)?;
    graph::GraphSnapshot::load(handle, &[(artifact_id.to_owned(), revision.clone())])?
        .assert_no_cycles()?;
    let prior = artifact["selectedRevisionId"]
        .as_str()
        .map(|id| json!({"artifactId": artifact_id, "revisionId": id}))
        .into_iter()
        .collect::<Vec<_>>();
    let tx = handle.db.unchecked_transaction().map_err(internal)?;
    promote_revision(&tx, &artifact, &revision)?;
    let seq = tx_event(
        &tx,
        "baseline.changed",
        "user",
        json!({"artifactId": artifact_id, "newRevisionId": revision_id, "priorRevisionId": artifact["selectedRevisionId"]}),
    )?;
    tx_decision(
        &tx,
        None,
        "accepted",
        input["rationale"].as_str().unwrap_or(""),
        &prior,
        &[json!({"artifactId": artifact_id, "revisionId": revision_id})],
        seq,
    )?;
    tx.commit().map_err(internal)?;
    let affected = graph::propagate_from(handle, &[artifact_id.to_owned()], seq)?;
    emit(
        handle,
        "impact.propagated",
        &Origin::User,
        json!({"changed": [{"artifactId": artifact_id, "revisionId": revision_id}], "affected": affected}),
    )?;
    Ok(
        json!({"artifact": require_artifact(handle, artifact_id)?, "revision": get_revision(handle, revision_id)?}),
    )
}

fn validate_active_candidate(artifact: &Value, revision: &Value) -> CoreResult<()> {
    if revision["artifactId"] != artifact["id"] {
        return Err(ContractError::validation(
            "Revision does not belong to artifact",
        ));
    }
    if !matches!(revision["reviewState"].as_str(), Some("draft" | "proposed")) {
        return Err(ContractError::validation(
            "Only an active draft can be accepted",
        ));
    }
    Ok(())
}

fn assert_simple_approval(artifact: &Value) -> CoreResult<()> {
    if artifact["type"] == "mechanical" {
        return Err(ContractError::new(
            "TOOL_MISSING",
            "Mechanical verification approval is not ported yet",
        ));
    }
    Ok(())
}

fn promote_revision(
    tx: &rusqlite::Transaction<'_>,
    artifact: &Value,
    revision: &Value,
) -> CoreResult<()> {
    let artifact_id = required_str(artifact, "id")?;
    let revision_id = required_str(revision, "id")?;
    tx.execute(
        "UPDATE revision SET review_state='approved' WHERE id=?1",
        [revision_id],
    )
    .map_err(internal)?;
    tx.execute(
        "UPDATE artifact SET selected_revision_id=?1 WHERE id=?2",
        params![revision_id, artifact_id],
    )
    .map_err(internal)?;
    if let Some(prior) = artifact["selectedRevisionId"].as_str() {
        if prior != revision_id {
            tx.execute("UPDATE revision SET review_state='superseded' WHERE id=?1 AND review_state='approved'", [prior]).map_err(internal)?;
        }
    }
    tx.execute("DELETE FROM stale WHERE artifact_id=?1", [artifact_id])
        .map_err(internal)?;
    graph::sync_selected_inputs(tx, artifact, revision)?;
    Ok(())
}

fn proposal_submit(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    let changes = input["changes"]
        .as_array()
        .ok_or_else(|| ContractError::validation("Missing changes"))?;
    let mut seen = std::collections::HashSet::new();
    let mut overrides = Vec::new();
    let mut changed_ids = Vec::new();
    for change in changes {
        let artifact_id = required_str(change, "artifactId")?;
        if !seen.insert(artifact_id) {
            return Err(ContractError::validation(
                "A proposal cannot change the same artifact twice",
            ));
        }
        let artifact = require_artifact(handle, artifact_id)?;
        let revision = require_revision(handle, required_str(change, "newRevisionId")?)?;
        validate_active_candidate(&artifact, &revision)?;
        graph::validate_revision_inputs(
            handle,
            artifact_id,
            revision["inputs"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[]),
        )?;
        overrides.push((artifact_id.to_owned(), revision));
        changed_ids.push(artifact_id.to_owned());
        if artifact["selectedRevisionId"] != change["baseRevisionId"]
            && !(artifact["selectedRevisionId"].is_null() && change["baseRevisionId"].is_null())
        {
            return Err(ContractError::new(
                "REVISION_CONFLICT",
                "Proposal base does not match selected revision",
            ));
        }
        if change["kind"] == "new_artifact" && !artifact["selectedRevisionId"].is_null()
            || change["kind"] == "baseline_update" && artifact["selectedRevisionId"].is_null()
        {
            return Err(ContractError::new(
                "REVISION_CONFLICT",
                "Proposal kind does not match selected revision",
            ));
        }
    }
    let graph = graph::GraphSnapshot::load(handle, &overrides)?;
    graph.assert_no_cycles()?;
    let affected = graph.downstream(&changed_ids);
    let proposal_id = uuid::Uuid::new_v4().to_string();
    let impact = json!({"affectedArtifactIds": affected, "summary": format!("{} downstream artifact(s) may be affected", affected.len())});
    let tx = handle.db.unchecked_transaction().map_err(internal)?;
    for change in changes {
        tx.execute(
            "UPDATE revision SET review_state='proposed' WHERE id=?1",
            [required_str(change, "newRevisionId")?],
        )
        .map_err(internal)?;
    }
    tx.execute("INSERT INTO proposal(id,changes,reason,impact,state,created_by,created_by_session,created_at,resolved_at,resolution_rationale) VALUES(?1,?2,?3,?4,'pending',?5,?6,?7,NULL,NULL)", params![proposal_id, json!(changes).to_string(), required_str(input, "reason")?, impact.to_string(), origin.kind(), origin.session_id(), now()]).map_err(internal)?;
    tx_event(
        &tx,
        "proposal.submitted",
        origin.kind(),
        json!({"proposalId": proposal_id, "changes": changes.len(), "affected": affected.len(), "reason": input["reason"], "supersedesProposalIds": []}),
    )?;
    tx.commit().map_err(internal)?;
    require_proposal(handle, &proposal_id)
}

fn proposal_read(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    let proposal = require_proposal(handle, required_str(input, "proposalId")?)?;
    let changes = proposal["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|change| -> CoreResult<Value> {
            let artifact = require_artifact(handle, required_str(change, "artifactId")?)?;
            let base = change["baseRevisionId"]
                .as_str()
                .map(|id| get_revision(handle, id))
                .transpose()?
                .flatten();
            let next = get_revision(handle, required_str(change, "newRevisionId")?)?;
            Ok(json!({"change": change, "artifact": artifact, "base": base, "next": next}))
        })
        .collect::<CoreResult<Vec<_>>>()?;
    Ok(json!({"proposal": proposal, "changes": changes}))
}

fn proposal_resolve(handle: &mut ProjectHandle, input: &Value, state: &str) -> CoreResult<Value> {
    let proposal_id = required_str(input, "proposalId")?;
    let proposal = require_proposal(handle, proposal_id)?;
    if proposal["state"] != "pending"
        && !(proposal["state"] == "changes_requested" && state != "changes_requested")
    {
        return Err(ContractError::validation(format!(
            "Proposal already resolved ({})",
            proposal["state"]
        )));
    }
    let changes = proposal["changes"].as_array().unwrap();
    if state == "accepted" {
        let mut overrides = Vec::new();
        for change in changes {
            let artifact = require_artifact(handle, required_str(change, "artifactId")?)?;
            let revision = require_revision(handle, required_str(change, "newRevisionId")?)?;
            validate_active_candidate(&artifact, &revision)?;
            if artifact["selectedRevisionId"] != change["baseRevisionId"]
                && !(artifact["selectedRevisionId"].is_null() && change["baseRevisionId"].is_null())
            {
                return Err(ContractError::new(
                    "REVISION_CONFLICT",
                    "Proposal base is stale",
                ));
            }
            if change["kind"] != "new_artifact" && change["kind"] != "baseline_update" {
                return Err(ContractError::new(
                    "TOOL_MISSING",
                    "This approval change kind is not ported yet",
                ));
            }
            assert_simple_approval(&artifact)?;
            graph::validate_revision_inputs(
                handle,
                required_str(change, "artifactId")?,
                revision["inputs"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
            )?;
            overrides.push((required_str(change, "artifactId")?.to_owned(), revision));
        }
        graph::GraphSnapshot::load(handle, &overrides)?.assert_no_cycles()?;
    }
    let rationale = input["rationale"].as_str().unwrap_or("");
    let tx = handle.db.unchecked_transaction().map_err(internal)?;
    let mut prior = Vec::new();
    let mut next = Vec::new();
    if state == "accepted" {
        for change in changes {
            let artifact_id = required_str(change, "artifactId")?;
            let artifact = require_artifact(handle, artifact_id)?;
            let revision = require_revision(handle, required_str(change, "newRevisionId")?)?;
            if let Some(old) = artifact["selectedRevisionId"].as_str() {
                prior.push(json!({"artifactId": artifact_id, "revisionId": old}));
            }
            promote_revision(&tx, &artifact, &revision)?;
            next.push(json!({"artifactId": artifact_id, "revisionId": revision["id"]}));
        }
    } else if state == "rejected" {
        for change in changes {
            tx.execute("UPDATE revision SET review_state='rejected' WHERE id=?1 AND review_state='proposed'", [required_str(change, "newRevisionId")?]).map_err(internal)?;
        }
    }
    tx.execute(
        "UPDATE proposal SET state=?1,resolved_at=?2,resolution_rationale=?3 WHERE id=?4",
        params![state, now(), rationale, proposal_id],
    )
    .map_err(internal)?;
    let seq = tx_event(
        &tx,
        "proposal.resolved",
        "user",
        json!({"proposalId": proposal_id, "state": state}),
    )?;
    if state != "changes_requested" {
        tx_decision(
            &tx,
            Some(proposal_id),
            state,
            if rationale.is_empty() {
                proposal["reason"].as_str().unwrap_or("")
            } else {
                rationale
            },
            &prior,
            &next,
            seq,
        )?;
    }
    tx.commit().map_err(internal)?;
    if state == "accepted" {
        let ids = changes
            .iter()
            .filter_map(|change| change["artifactId"].as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        let affected = graph::propagate_from(handle, &ids, seq)?;
        emit(
            handle,
            "impact.propagated",
            &Origin::User,
            json!({"changed": next, "affected": affected}),
        )?;
        emit(handle, "bom.changed", &Origin::System, json!({}))?;
    }
    require_proposal(handle, proposal_id)
}

fn require_proposal(handle: &ProjectHandle, id: &str) -> CoreResult<Value> {
    handle.db.query_row("SELECT id,changes,reason,impact,state,created_by,created_by_session,created_at,resolved_at,resolution_rationale FROM proposal WHERE id=?1", [id], models::proposal_from_row).optional().map_err(internal)?
        .ok_or_else(|| ContractError::new("NOT_FOUND", format!("Proposal not found: {id}")))
}

fn require_revision(handle: &ProjectHandle, id: &str) -> CoreResult<Value> {
    get_revision(handle, id)?
        .ok_or_else(|| ContractError::new("NOT_FOUND", format!("Revision not found: {id}")))
}

fn tx_event(
    tx: &rusqlite::Transaction<'_>,
    event_type: &str,
    origin: &str,
    data: Value,
) -> CoreResult<i64> {
    tx.execute(
        "INSERT INTO event(id,type,origin,ts,data) VALUES(?1,?2,?3,?4,?5)",
        params![
            uuid::Uuid::new_v4().to_string(),
            event_type,
            origin,
            now(),
            data.to_string()
        ],
    )
    .map_err(internal)?;
    Ok(tx.last_insert_rowid())
}

fn tx_decision(
    tx: &rusqlite::Transaction<'_>,
    proposal_id: Option<&str>,
    action: &str,
    rationale: &str,
    prior: &[Value],
    next: &[Value],
    event_seq: i64,
) -> CoreResult<()> {
    tx.execute("INSERT INTO decision(id,proposal_id,action,actor,ts,rationale,prior_baseline,new_baseline,event_seq) VALUES(?1,?2,?3,'user',?4,?5,?6,?7,?8)", params![uuid::Uuid::new_v4().to_string(), proposal_id, action, now(), rationale, json!(prior).to_string(), json!(next).to_string(), event_seq]).map_err(internal)?;
    Ok(())
}

fn ingest_files(handle: &ProjectHandle, input: &Value) -> CoreResult<Vec<Value>> {
    let mut files = Vec::new();
    let objects = handle.object_store().map_err(storage_error)?;
    for file in input.as_array().map(Vec::as_slice).unwrap_or(&[]) {
        let relative = required_str(file, "path")?;
        resolve_materialization_path(&handle.root, relative).map_err(storage_error)?;
        let bytes = if let Some(encoded) = file["contentBase64"].as_str() {
            if encoded.len() > registry().max_frame_bytes * 2 {
                return Err(ContractError::validation(
                    "File exceeds bridge ingest limit",
                ));
            }
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|error| {
                    ContractError::validation(format!("Invalid base64 file: {error}"))
                })?
        } else if let Some(source) = file["sourcePath"].as_str() {
            let source = Path::new(source);
            let relative_source = if source.is_absolute() {
                source.strip_prefix(&handle.root).map_err(|_| {
                    ContractError::new("PATH_OUTSIDE_PROJECT", "Source is outside project")
                })?
            } else {
                source
            };
            let source_path =
                resolve_materialization_path(&handle.root, &relative_source.to_string_lossy())
                    .map_err(storage_error)?;
            fs::read(source_path).map_err(internal)?
        } else {
            return Err(ContractError::validation(format!(
                "File entry has no content: {relative}"
            )));
        };
        if bytes.len() > registry().max_frame_bytes {
            return Err(ContractError::validation(
                "File exceeds bridge ingest limit",
            ));
        }
        let sha = objects.put(&bytes).map_err(storage_error)?;
        files.push(json!({"path": relative, "sha256": sha, "role": "source"}));
    }
    Ok(files)
}

fn materialize_files(
    handle: &ProjectHandle,
    files: &[Value],
    parent: Option<&Value>,
) -> CoreResult<()> {
    let objects = handle.object_store().map_err(storage_error)?;
    for file in files {
        let relative = required_str(file, "path")?;
        let sha = required_str(file, "sha256")?;
        let dest = resolve_materialization_path(&handle.root, relative).map_err(storage_error)?;
        let bytes = objects.read(sha).map_err(storage_error)?;
        let overwrite = if dest.exists() {
            let current = fs::read(&dest).map_err(internal)?;
            let current_hash = omenflow_storage::sha256_hex(&current);
            let parent_hash = parent
                .and_then(|revision| revision["files"].as_array())
                .and_then(|items| items.iter().find(|item| item["path"] == relative))
                .and_then(|item| item["sha256"].as_str());
            current_hash == sha || Some(current_hash.as_str()) == parent_hash
        } else {
            true
        };
        if overwrite {
            write_materialized_file(&handle.root, relative, &bytes).map_err(storage_error)?;
        } else {
            let conflict = format!(
                "{relative}.omenflow-conflict-{}",
                Utc::now().timestamp_millis()
            );
            write_materialized_file(&handle.root, &conflict, &bytes).map_err(storage_error)?;
        }
    }
    Ok(())
}

fn normalize_inputs(
    handle: &ProjectHandle,
    artifact_id: &str,
    input: &Value,
) -> CoreResult<Vec<Value>> {
    let mut out = Vec::new();
    for entry in input.as_array().map(Vec::as_slice).unwrap_or(&[]) {
        let upstream_id = required_str(entry, "artifactId")?;
        let upstream = require_artifact(handle, upstream_id)?;
        let revision_id = if let Some(id) = entry["revisionId"].as_str() {
            id.to_owned()
        } else if let Some(id) = upstream["selectedRevisionId"].as_str() {
            id.to_owned()
        } else {
            handle.db.query_row("SELECT id FROM revision WHERE artifact_id=?1 AND review_state NOT IN ('rejected','superseded') ORDER BY seq DESC LIMIT 1", [upstream_id], |row| row.get::<_, String>(0)).optional().map_err(internal)?
                    .ok_or_else(|| ContractError::validation(format!("Input artifact has no revision: {upstream_id}")))?
        };
        let revision = get_revision(handle, &revision_id)?.ok_or_else(|| {
            ContractError::new("NOT_FOUND", format!("Revision not found: {revision_id}"))
        })?;
        if revision["artifactId"] != upstream_id {
            return Err(ContractError::validation(
                "Input revision does not belong to its artifact",
            ));
        }
        let relationship = entry["relationship"].as_str().unwrap_or("depends_on");
        if upstream_id == artifact_id
            && matches!(
                relationship,
                "depends_on" | "derived_from" | "validates" | "connects_to" | "belongs_to"
            )
        {
            return Err(ContractError::new(
                "CYCLE_DETECTED",
                "An artifact cannot depend on itself",
            ));
        }
        let mut recorded = json!({"artifactId": upstream_id, "revisionId": revision_id, "relationship": relationship});
        if let Some(label) = entry["label"].as_str() {
            recorded["label"] = json!(label);
        }
        out.push(recorded);
    }
    Ok(out)
}

fn get_revision(handle: &ProjectHandle, id: &str) -> CoreResult<Option<Value>> {
    handle
        .db
        .query_row(
            "SELECT * FROM revision WHERE id=?1",
            [id],
            revision_from_row,
        )
        .optional()
        .map_err(internal)
}

fn require_artifact(handle: &ProjectHandle, id: &str) -> CoreResult<Value> {
    handle
        .db
        .query_row(
            "SELECT * FROM artifact WHERE id=?1",
            [id],
            artifact_from_row,
        )
        .optional()
        .map_err(internal)?
        .ok_or_else(|| ContractError::new("NOT_FOUND", format!("Artifact not found: {id}")))
}

fn emit(handle: &ProjectHandle, event_type: &str, origin: &Origin, data: Value) -> CoreResult<i64> {
    handle
        .db
        .execute(
            "INSERT INTO event(id,type,origin,ts,data) VALUES(?1,?2,?3,?4,?5)",
            params![
                uuid::Uuid::new_v4().to_string(),
                event_type,
                origin.kind(),
                now(),
                data.to_string()
            ],
        )
        .map_err(internal)?;
    Ok(handle.db.last_insert_rowid())
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn required_str<'a>(value: &'a Value, field: &str) -> CoreResult<&'a str> {
    value[field]
        .as_str()
        .ok_or_else(|| ContractError::validation(format!("Missing {field}")))
}

fn storage_error(error: StorageError) -> ContractError {
    ContractError::new(error.code(), error.to_string())
}

fn internal(error: impl std::fmt::Display) -> ContractError {
    ContractError::new("INTERNAL", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_and_reads_a_draft_without_selecting_it() {
        let temp = tempfile::tempdir().unwrap();
        let mut app = CoreApp::new(temp.path().join("appdata")).unwrap();
        let created = app.dispatch("project.create", json!({"name": "Rust", "path": temp.path().join("project").to_str().unwrap(), "intent": "Test"}), Origin::User, None).unwrap();
        let project_id = created["projectId"].as_str().unwrap();
        let draft = app.dispatch("artifact.create_draft", json!({"type": "requirement", "title": "Payload", "payload": {"statement": "Carry a load", "acceptanceCriterion": "Pass load test"}}), Origin::User, Some(project_id)).unwrap();
        assert_eq!(draft["revision"]["reviewState"], "draft");
        assert!(draft["artifact"]["selectedRevisionId"].is_null());
        assert_eq!(draft["revision"]["payload"]["priority"], "should");
        let artifact_id = draft["artifact"]["id"].as_str().unwrap();
        let list = app
            .dispatch("artifact.list", json!({}), Origin::User, Some(project_id))
            .unwrap();
        assert_eq!(list["artifacts"].as_array().unwrap().len(), 1);
        assert_eq!(list["artifacts"][0]["draftCount"], 1);
        let read = app
            .dispatch(
                "artifact.read",
                json!({"artifactId": artifact_id}),
                Origin::User,
                Some(project_id),
            )
            .unwrap();
        assert_eq!(read["revision"]["id"], draft["revision"]["id"]);
        let search = app
            .dispatch(
                "project.search",
                json!({"query": "Payload"}),
                Origin::User,
                Some(project_id),
            )
            .unwrap();
        assert_eq!(search["results"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn agent_cannot_skip_human_approval_and_bad_payload_leaves_no_artifact() {
        let temp = tempfile::tempdir().unwrap();
        let mut app = CoreApp::new(temp.path().join("appdata")).unwrap();
        let created = app
            .dispatch(
                "project.create",
                json!({"name": "Rust", "path": temp.path().join("project").to_str().unwrap()}),
                Origin::User,
                None,
            )
            .unwrap();
        let project_id = created["projectId"].as_str().unwrap();
        assert_eq!(
            app.dispatch(
                "proposal.approve",
                json!({"proposalId": uuid::Uuid::new_v4().to_string()}),
                Origin::Agent {
                    session_id: "test".into()
                },
                Some(project_id)
            )
            .unwrap_err()
            .code,
            "CAPABILITY_DENIED"
        );
        assert_eq!(
            app.dispatch(
                "artifact.create_draft",
                json!({"type": "requirement", "title": "Broken", "payload": {}}),
                Origin::User,
                Some(project_id)
            )
            .unwrap_err()
            .code,
            "VALIDATION"
        );
        let list = app
            .dispatch("artifact.list", json!({}), Origin::User, Some(project_id))
            .unwrap();
        assert_eq!(list["artifacts"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn draft_review_approval_and_stale_base_guard() {
        let temp = tempfile::tempdir().unwrap();
        let mut app = CoreApp::new(temp.path().join("appdata")).unwrap();
        let created = app
            .dispatch(
                "project.create",
                json!({"name": "Rust", "path": temp.path().join("project").to_str().unwrap()}),
                Origin::User,
                None,
            )
            .unwrap();
        let project_id = created["projectId"].as_str().unwrap();
        let draft = app
            .dispatch(
                "artifact.create_draft",
                json!({"type": "note", "title": "Design note", "payload": {"markdown": "First"}}),
                Origin::Agent {
                    session_id: "test".into(),
                },
                Some(project_id),
            )
            .unwrap();
        let artifact_id = draft["artifact"]["id"].as_str().unwrap();
        let draft_id = draft["revision"]["id"].as_str().unwrap();
        let proposal = app.dispatch("proposal.submit", json!({"changes": [{"artifactId": artifact_id, "newRevisionId": draft_id, "baseRevisionId": null, "kind": "new_artifact"}], "reason": "Ready for review"}), Origin::Agent { session_id: "test".into() }, Some(project_id)).unwrap();
        assert_eq!(proposal["state"], "pending");
        let proposal_id = proposal["id"].as_str().unwrap();
        let read = app
            .dispatch(
                "proposal.read",
                json!({"proposalId": proposal_id}),
                Origin::User,
                Some(project_id),
            )
            .unwrap();
        assert_eq!(read["changes"][0]["next"]["id"], draft_id);
        let approved = app
            .dispatch(
                "proposal.approve",
                json!({"proposalId": proposal_id, "rationale": "Checked"}),
                Origin::User,
                Some(project_id),
            )
            .unwrap();
        assert_eq!(approved["state"], "accepted");
        let record = app
            .dispatch(
                "artifact.read",
                json!({"artifactId": artifact_id}),
                Origin::User,
                Some(project_id),
            )
            .unwrap();
        assert_eq!(record["view"]["artifact"]["selectedRevisionId"], draft_id);
        assert_eq!(record["revision"]["reviewState"], "approved");
        assert_eq!(
            app.dispatch(
                "proposal.approve",
                json!({"proposalId": proposal_id}),
                Origin::User,
                Some(project_id)
            )
            .unwrap_err()
            .code,
            "VALIDATION"
        );
        let second = app.dispatch("artifact.update_draft", json!({"artifactId": artifact_id, "baseRevisionId": draft_id, "payload": {"markdown": "Second"}}), Origin::Agent { session_id: "test".into() }, Some(project_id)).unwrap();
        assert_eq!(second["revision"]["parentId"], draft_id);
        assert_eq!(second["revision"]["seq"], 2);
        let accepted = app
            .dispatch(
                "artifact.accept_draft",
                json!({"artifactId": artifact_id, "draftRevisionId": second["revision"]["id"]}),
                Origin::User,
                Some(project_id),
            )
            .unwrap();
        assert_eq!(accepted["revision"]["reviewState"], "approved");
        assert_eq!(
            app.dispatch(
                "artifact.update_draft",
                json!({"artifactId": artifact_id, "baseRevisionId": draft_id}),
                Origin::User,
                Some(project_id)
            )
            .unwrap_err()
            .code,
            "REVISION_CONFLICT"
        );
    }

    #[test]
    fn baseline_change_marks_recorded_downstream_input_stale() {
        let temp = tempfile::tempdir().unwrap();
        let mut app = CoreApp::new(temp.path().join("appdata")).unwrap();
        let created = app
            .dispatch(
                "project.create",
                json!({"name": "Graph", "path": temp.path().join("project").to_str().unwrap()}),
                Origin::User,
                None,
            )
            .unwrap();
        let project_id = created["projectId"].as_str().unwrap();
        let upstream = app
            .dispatch(
                "artifact.create_draft",
                json!({"type": "note", "title": "Source", "payload": {"markdown": "v1"}}),
                Origin::User,
                Some(project_id),
            )
            .unwrap();
        let upstream_id = upstream["artifact"]["id"].as_str().unwrap();
        let upstream_revision = upstream["revision"]["id"].as_str().unwrap();
        app.dispatch(
            "artifact.accept_draft",
            json!({"artifactId": upstream_id, "draftRevisionId": upstream_revision}),
            Origin::User,
            Some(project_id),
        )
        .unwrap();
        let downstream = app.dispatch("artifact.create_draft", json!({"type": "note", "title": "Derived", "payload": {"markdown": "based on v1"}, "inputs": [{"artifactId": upstream_id, "revisionId": upstream_revision, "relationship": "derived_from"}]}), Origin::User, Some(project_id)).unwrap();
        let downstream_id = downstream["artifact"]["id"].as_str().unwrap();
        app.dispatch(
            "artifact.accept_draft",
            json!({"artifactId": downstream_id, "draftRevisionId": downstream["revision"]["id"]}),
            Origin::User,
            Some(project_id),
        )
        .unwrap();
        let graph = app
            .dispatch("graph.list", json!({}), Origin::User, Some(project_id))
            .unwrap();
        assert_eq!(graph["edges"].as_array().unwrap().len(), 1);
        let impact = app
            .dispatch(
                "graph.impact",
                json!({"refs": [{"artifactId": upstream_id, "revisionId": upstream_revision}]}),
                Origin::User,
                Some(project_id),
            )
            .unwrap();
        assert_eq!(impact["affected"][0]["artifactId"], downstream_id);
        assert_eq!(app.dispatch("graph.propose_edges", json!({"edges": [{"upstreamArtifactId": downstream_id, "downstreamArtifactId": upstream_id, "relationship": "depends_on"}]}), Origin::User, Some(project_id)).unwrap_err().code, "CYCLE_DETECTED");
        let new_upstream = app.dispatch("artifact.update_draft", json!({"artifactId": upstream_id, "baseRevisionId": upstream_revision, "payload": {"markdown": "v2"}}), Origin::User, Some(project_id)).unwrap();
        app.dispatch(
            "artifact.accept_draft",
            json!({"artifactId": upstream_id, "draftRevisionId": new_upstream["revision"]["id"]}),
            Origin::User,
            Some(project_id),
        )
        .unwrap();
        let read = app
            .dispatch(
                "artifact.read",
                json!({"artifactId": downstream_id}),
                Origin::User,
                Some(project_id),
            )
            .unwrap();
        assert_eq!(read["view"]["freshness"], "stale");
        assert_eq!(
            read["view"]["staleReasons"][0]["expectedRevisionId"],
            upstream_revision
        );
    }
}
