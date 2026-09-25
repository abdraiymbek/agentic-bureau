//! Rust application command layer. Each migrated operation is kept behind the
//! same contract name and JSON shape as the v0.1 TypeScript implementation.

mod archive;
mod build;
mod cad;
mod calculation;
mod components;
mod graph;
mod models;
mod simple;
mod test_results;
mod wiring;

use base64::Engine;
use chrono::{SecondsFormat, Utc};
use omenflow_contracts::{parse_artifact_payload, parse_input, registry, ContractError};
use omenflow_storage::{
    resolve_materialization_path, write_materialized_file, ProjectHandle, StorageError,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

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
    event_hook: Option<Arc<dyn Fn(Value) + Send + Sync>>,
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
            event_hook: None,
        })
    }

    pub fn set_event_hook(&mut self, hook: Arc<dyn Fn(Value) + Send + Sync>) {
        self.event_hook = Some(hook);
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
            "project.import_archive" => {
                let archive_path = required_str(&payload, "archivePath")?;
                let dest = required_str(&payload, "destDir")?;
                let copy = payload["newIdentity"].as_bool().unwrap_or(false);
                let handle = archive::import_archive(archive_path, dest, copy)?;
                let mut result = self.register(handle)?;
                result["readOnly"] = json!(false);
                Ok(result)
            }
            "project.list_open" => Ok(json!({"projects": self.projects.values().map(|h| {
                let project = h.project().ok().flatten().unwrap_or(Value::Null);
                json!({"id": project["id"], "name": project["name"], "root": h.root})
            }).collect::<Vec<_>>()})),
            "project.close" => {
                let id = project_id
                    .ok_or_else(|| ContractError::validation("Project id is required"))?;
                if let Some(handle) = self.projects.get(id).filter(|handle| !handle.read_only) {
                    handle.db.execute("UPDATE job SET status='cancelled',finished_at=?1 WHERE status IN ('queued','running')",[now()]).map_err(internal)?;
                }
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
            "app.diagnostics" => Ok(
                json!({"appDataDir": self.app_data_dir, "openProjects": self.projects.keys().collect::<Vec<_>>(), "versions": {"rust": env!("CARGO_PKG_VERSION")}}),
            ),
            "settings.get" => {
                let settings = self.read_settings();
                if let Some(key) = payload["key"].as_str() {
                    let mut parts = key.split('.');
                    let first = parts.next().unwrap_or("");
                    let second = parts.next().unwrap_or("");
                    Ok(json!({"value": settings[first][second]}))
                } else {
                    Ok(json!({"settings": settings}))
                }
            }
            "settings.set" => {
                let key = required_str(&payload, "key")?;
                let mut parts = key.split('.');
                let first = parts.next().unwrap_or("");
                let second = parts.next().unwrap_or("");
                if first.is_empty()
                    || second.is_empty()
                    || [first, second]
                        .iter()
                        .any(|part| matches!(*part, "__proto__" | "constructor" | "prototype"))
                {
                    return Err(ContractError::validation(format!(
                        "Bad settings key: {key}"
                    )));
                }
                let mut settings = self.read_settings();
                if !settings[first].is_object() {
                    settings[first] = json!({});
                }
                settings[first][second] = payload["value"].clone();
                self.write_settings(&settings)?;
                Ok(json!({"ok": true}))
            }
            _ => {
                let event_hook = self.event_hook.clone();
                let id = project_id.ok_or_else(|| {
                    ContractError::validation(format!("Operation {op} needs a projectId"))
                })?;
                let handle = self.projects.get_mut(id).ok_or_else(|| {
                    ContractError::new("NOT_FOUND", format!("Project not open: {id}"))
                })?;
                if definition.mutating {
                    handle.assert_writable().map_err(storage_error)?;
                }
                if op == "cad.render" {
                    let queued = cad::queue_render(handle, &payload, &origin)?;
                    let root = handle.root.clone();
                    let job_id = required_str(&queued["job"], "id")?.to_owned();
                    let mut input = payload.clone();
                    input["revisionId"] = queued["job"]["inputs"]["revisionId"].clone();
                    std::thread::spawn(move || {
                        let Ok(mut worker) = ProjectHandle::open_worker(&root) else {
                            return;
                        };
                        let before = worker
                            .db
                            .query_row("SELECT COALESCE(MAX(seq),0) FROM event", [], |row| {
                                row.get::<_, i64>(0)
                            })
                            .unwrap_or(0);
                        let _ = cad::finish_queued_render(&mut worker, &input, &origin, &job_id);
                        if let Some(hook) = event_hook {
                            if let Ok(mut stmt) = worker
                                .db
                                .prepare("SELECT * FROM event WHERE seq>?1 ORDER BY seq")
                            {
                                if let Ok(events) = stmt.query_map([before], event_from_row) {
                                    for event in events.flatten() {
                                        hook(event);
                                    }
                                }
                            }
                        }
                    });
                    return Ok(queued);
                }
                dispatch_project(handle, op, &payload, &origin)
            }
        }
    }

    /// Durable at-most-once dispatch for project mutations. A committed result
    /// is journaled before the SQLite replay row is completed; an interrupted
    /// pending attempt cannot silently execute twice.
    pub fn dispatch_idempotent(
        &mut self,
        op: &str,
        payload: Value,
        origin: Origin,
        project_id: Option<&str>,
        idempotency_key: Option<&str>,
    ) -> CoreResult<Value> {
        let Some(key) = idempotency_key.filter(|key| !key.is_empty()) else {
            return self.dispatch(op, payload, origin, project_id);
        };
        let definition = registry()
            .operation(op)
            .ok_or_else(|| ContractError::validation(format!("Unknown operation: {op}")))?;
        if !definition.mutating {
            return self.dispatch(op, payload, origin, project_id);
        }
        let parsed = parse_input(definition, payload)?;
        let Some(project_id) = project_id else {
            return self.dispatch_app_idempotent(op, parsed, origin, key);
        };
        let who = origin.session_id().unwrap_or("user");
        let replay_key = format!("{who}:{op}:{key}");
        let hash = format!(
            "{:x}",
            Sha256::digest(json!({"op":op,"payload":parsed}).to_string().as_bytes())
        );
        let root = self.project_root(project_id)?;
        let handle = self
            .projects
            .get(project_id)
            .ok_or_else(|| ContractError::new("NOT_FOUND", "Project not open"))?;
        if let Some((prior_hash, response)) = handle
            .db
            .query_row(
                "SELECT request_hash,response FROM idempotency WHERE key=?1",
                [&replay_key],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(internal)?
        {
            if prior_hash != hash {
                return Err(ContractError::validation(
                    "Idempotency key reused with different payload",
                ));
            }
            let prior: Value = serde_json::from_str(&response).map_err(internal)?;
            if prior["operationPending"] == true {
                if let Some(journal) = read_result_journal(&root, &replay_key, &hash) {
                    handle
                        .db
                        .execute(
                            "UPDATE idempotency SET response=?1 WHERE key=?2",
                            params![journal.to_string(), replay_key],
                        )
                        .map_err(internal)?;
                    clear_result_journal(&root, &replay_key);
                    return Ok(with_replay_marker(journal, true));
                }
                return Err(ContractError::new("REVISION_CONFLICT", "Previous attempt was interrupted; inspect its jobs/revisions before retrying with a new key"));
            }
            if let Some(error) = prior.get("operationFailure") {
                return Err(serde_json::from_value(error.clone()).map_err(internal)?);
            }
            return Ok(with_replay_marker(prior, false));
        }
        handle
            .db
            .execute(
                "INSERT INTO idempotency(key,request_hash,response,created_at) VALUES(?1,?2,?3,?4)",
                params![
                    replay_key,
                    hash,
                    json!({"operationPending":true}).to_string(),
                    now()
                ],
            )
            .map_err(internal)?;
        match self.dispatch(op, parsed, origin, Some(project_id)) {
            Ok(result) => {
                write_result_journal(&root, &replay_key, &hash, &result)?;
                self.projects
                    .get(project_id)
                    .ok_or_else(|| ContractError::new("NOT_FOUND", "Project not open"))?
                    .db
                    .execute(
                        "UPDATE idempotency SET response=?1 WHERE key=?2",
                        params![result.to_string(), replay_key],
                    )
                    .map_err(internal)?;
                clear_result_journal(&root, &replay_key);
                Ok(result)
            }
            Err(error) => {
                if let Some(handle) = self.projects.get(project_id) {
                    let _ = handle.db.execute(
                        "UPDATE idempotency SET response=?1 WHERE key=?2",
                        params![json!({"operationFailure":error}).to_string(), replay_key],
                    );
                }
                Err(error)
            }
        }
    }

    fn dispatch_app_idempotent(
        &mut self,
        op: &str,
        payload: Value,
        origin: Origin,
        key: &str,
    ) -> CoreResult<Value> {
        if !matches!(op, "project.create" | "project.import_archive") {
            return self.dispatch(op, payload, origin, None);
        }
        let path_key = if op == "project.create" {
            "path"
        } else {
            "destDir"
        };
        let path = required_str(&payload, path_key)?.to_owned();
        let replay_key = format!("{}:{op}:{key}", origin.session_id().unwrap_or("user"));
        let request_hash = format!(
            "{:x}",
            Sha256::digest(json!({"op":op,"payload":payload}).to_string().as_bytes())
        );
        let reservations_path = self.app_data_dir.join("reservations.json");
        let mut table = fs::read(&reservations_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .unwrap_or_else(|| json!({"reservations":{}}));
        if !table["reservations"].is_object() {
            table["reservations"] = json!({});
        }
        let prior = table["reservations"][&replay_key].clone();
        if !prior.is_null() {
            if prior["requestHash"] != request_hash {
                return Err(ContractError::validation(
                    "Idempotency key reused with different payload",
                ));
            }
            if prior["state"] == "completed" {
                return Ok(with_replay_marker(prior["result"].clone(), false));
            }
            if prior["state"] == "failed" && prior["error"].is_object() {
                return Err(serde_json::from_value(prior["error"].clone()).map_err(internal)?);
            }
        }
        let timestamp = prior["createdAt"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(now);
        table["reservations"][&replay_key] = json!({"op":op,"requestHash":request_hash,"state":"reserved","projectPath":path,"createdAt":timestamp});
        self.save_reservations(&table)?;
        // A crash can happen after the project files were committed and before
        // the app-level replay row. Recover the result from the durable marker.
        let marker = Path::new(&path).join("omenflow.project.json");
        let recovered = prior["state"] == "reserved" && marker.is_file();
        let result = if recovered {
            self.dispatch("project.open", json!({"path":path}), origin.clone(), None)
        } else {
            self.dispatch(op, payload, origin, None)
        };
        match result {
            Ok(value) => {
                table["reservations"][&replay_key]["state"] = json!("completed");
                table["reservations"][&replay_key]["result"] = value.clone();
                self.save_reservations(&table)?;
                Ok(if recovered {
                    with_replay_marker(value, true)
                } else {
                    value
                })
            }
            Err(error) => {
                if !marker.is_file() {
                    table["reservations"][&replay_key]["state"] = json!("failed");
                    table["reservations"][&replay_key]["error"] = json!(error);
                    self.save_reservations(&table)?;
                }
                Err(error)
            }
        }
    }

    fn save_reservations(&self, table: &Value) -> CoreResult<()> {
        let path = self.app_data_dir.join("reservations.json");
        let temp = self
            .app_data_dir
            .join(format!("reservations-{}.tmp", uuid::Uuid::new_v4()));
        fs::write(&temp, serde_json::to_vec_pretty(table).map_err(internal)?).map_err(internal)?;
        fs::rename(&temp, &path).map_err(internal)
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

    pub fn project_root(&self, project_id: &str) -> CoreResult<PathBuf> {
        self.projects
            .get(project_id)
            .map(|handle| handle.root.clone())
            .ok_or_else(|| ContractError::new("NOT_FOUND", "Project not open"))
    }

    pub fn proposal_wait_snapshot(&self, project_id: &str, proposal_id: &str) -> CoreResult<Value> {
        let handle = self
            .projects
            .get(project_id)
            .ok_or_else(|| ContractError::new("NOT_FOUND", "Project not open"))?;
        let state = handle
            .db
            .query_row(
                "SELECT state FROM proposal WHERE id=?1",
                [proposal_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(internal)?
            .ok_or_else(|| {
                ContractError::new("NOT_FOUND", format!("Proposal not found: {proposal_id}"))
            })?;
        Ok(json!({"state":state,"cursor":self.latest_event_seq(project_id)?}))
    }

    pub fn adapter_config(&self, adapter_id: &str) -> Value {
        self.read_settings()["adapters"][adapter_id].clone()
    }

    pub fn configure_adapter(&self, adapter_id: &str, input: &Value) -> CoreResult<()> {
        let mut settings = self.read_settings();
        if !settings["adapters"].is_object() {
            settings["adapters"] = json!({});
        }
        let mut current = settings["adapters"][adapter_id].clone();
        if !current.is_object() {
            current = json!({});
        }
        for key in [
            "executablePath",
            "args",
            "env",
            "lastTestAt",
            "lastTestOk",
            "lastError",
        ] {
            if let Some(value) = input.get(key) {
                current[key] = value.clone();
            }
        }
        settings["adapters"][adapter_id] = current;
        self.write_settings(&settings)
    }

    pub fn upsert_session(&self, project_id: &str, info: &Value) -> CoreResult<()> {
        let handle = self
            .projects
            .get(project_id)
            .ok_or_else(|| ContractError::new("NOT_FOUND", "Project not open"))?;
        handle.db.execute("INSERT INTO session(id,adapter_id,executable_path,state,pid,exit_code,started_at,ended_at,last_error) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(id) DO UPDATE SET adapter_id=excluded.adapter_id,executable_path=excluded.executable_path,state=excluded.state,pid=excluded.pid,exit_code=excluded.exit_code,started_at=excluded.started_at,ended_at=excluded.ended_at,last_error=excluded.last_error", params![info["id"].as_str(), info["adapterId"].as_str(), info["executablePath"].as_str(), info["state"].as_str(), info["pid"].as_i64(), info["exitCode"].as_i64(), info["startedAt"].as_str(), info["endedAt"].as_str(), info["lastError"].as_str()]).map_err(internal)?;
        emit(handle, "session.state", &Origin::System, info.clone())?;
        Ok(())
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
        if !handle.read_only {
            handle.db.execute("UPDATE job SET status='interrupted',finished_at=?1 WHERE status IN ('queued','running')",[now()]).map_err(internal)?;
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
        let mut settings = self.read_settings();
        settings["recentProjects"] = json!(self.recent_projects);
        self.write_settings(&settings)
    }

    fn read_settings(&self) -> Value {
        fs::read(self.app_data_dir.join("settings.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_else(
                || json!({"recentProjects": [], "adapters": {}, "prefs": {}, "toolPaths": {}}),
            )
    }

    fn write_settings(&self, settings: &Value) -> CoreResult<()> {
        let path = self.app_data_dir.join("settings.json");
        let temp = self
            .app_data_dir
            .join(format!("settings-{}.tmp", uuid::Uuid::new_v4()));
        fs::write(
            &temp,
            serde_json::to_vec_pretty(settings).map_err(internal)?,
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
        "project.rename" => {
            handle
                .rename(required_str(payload, "name")?)
                .map_err(storage_error)?;
            Ok(json!({"project": handle.project().map_err(storage_error)?}))
        }
        "project.export_archive" => archive::export_archive(handle, payload),
        "project.update_intent" => {
            let intent = required_str(payload, "intent")?;
            let tx = handle.db.unchecked_transaction().map_err(internal)?;
            tx.execute("UPDATE project SET intent=?1", [intent])
                .map_err(internal)?;
            tx_event(
                &tx,
                "project.intent_changed",
                origin.kind(),
                json!({"intent": intent}),
            )?;
            tx.commit().map_err(internal)?;
            Ok(json!({"project": handle.project().map_err(storage_error)?}))
        }
        "artifact.list" => artifact_list(handle, payload),
        "artifact.read" => artifact_read(handle, payload),
        "artifact.history" => artifact_history(handle, payload),
        "artifact.compare" => artifact_compare(handle, payload),
        "artifact.archive" => artifact_archive(handle, payload),
        "artifact.set_subsystem" => artifact_set_subsystem(handle, payload),
        "artifact.read_file" => artifact_read_file(handle, payload),
        "artifact.reveal" => simple::artifact_reveal(handle, payload),
        "project.summary" => simple::project_summary(handle, payload),
        "project.changes_since" => changes_since(handle, payload),
        "project.search" => project_search(handle, payload),
        "graph.list" => graph_list(handle),
        "graph.neighbors" => graph::neighbors(handle, payload),
        "graph.impact" => graph::impact(handle, payload),
        "graph.propose_edges" => graph::propose_edges(handle, payload, origin.kind()),
        "job.list" => job_list(handle, payload),
        "job.read" => simple::job_read(handle, payload),
        "job.cancel" => simple::job_cancel(handle, payload, origin),
        "tool.list" => simple::tool_list(),
        "tool.describe" => simple::tool_describe(payload),
        "tool.doctor" => simple::tool_doctor(payload),
        "source.capture" => simple::source_capture(handle, payload, origin),
        "source.read" => simple::source_read(handle, payload),
        "test.create_draft" => simple::test_create_draft(handle, payload, origin),
        "test.record_result" => test_results::record_result(handle, payload, origin),
        "build.preview" => build::preview(handle, false),
        "build.export" => build::export(handle, payload, origin),
        "calculation.templates" => calculation::templates(),
        "calculation.explain_inputs" => calculation::explain_inputs(handle, payload),
        "calculation.run" => calculation::run(handle, payload, origin),
        "cad.export" => simple::cad_export(handle, payload),
        "cad.probe" => cad::probe(),
        "cad.read_source" => cad::read_source(handle, payload),
        "cad.validate_source" => cad::validate_source(handle, payload),
        "cad.write_source" => cad::write_source(handle, payload, origin),
        "cad.inspect" => cad::inspect(handle, payload, origin),
        "cad.check" => cad::check(handle, payload, origin),
        "cad.patch_source" => cad::patch_source(handle, payload, origin),
        "cad.set_param" => cad::set_param(handle, payload, origin),
        "cad.compose" => cad::compose(handle, payload, origin),
        "cad.render" => cad::render(handle, payload, origin),
        "component.add_candidate" => components::add_candidate(handle, payload, origin),
        "component.add_offer" => components::add_offer(handle, payload, origin),
        "component.compare" => components::compare(handle, payload),
        "component.propose_selection" => components::propose_selection(handle, payload, origin),
        "bom.read" => components::bom_read(handle),
        "bom.propose_edit" => components::bom_propose_edit(handle, payload, origin),
        "bom.update_line" => components::bom_update_line(handle, payload),
        "bom.remove_line" => components::bom_remove_line(handle, payload),
        "bom.export" => components::bom_export(handle, payload),
        "wiring.validate" => wiring::validate(handle, payload),
        "wiring.render" => wiring::render(handle, payload),
        "wiring.set_pins" => wiring::set_pins(handle, payload, origin),
        "wiring.set_connections" => wiring::set_connections(handle, payload, origin),
        "ui.open_artifact" => {
            emit(
                handle,
                "ui.open_artifact",
                origin,
                json!({"artifactId": payload["artifactId"]}),
            )?;
            Ok(json!({"ok":true}))
        }
        "ui.request_review" => {
            emit(
                handle,
                "ui.request_review",
                origin,
                json!({"proposalId": payload["proposalId"]}),
            )?;
            Ok(json!({"ok":true}))
        }
        "ui.suggest_action" => {
            emit(
                handle,
                "ui.suggested_action",
                origin,
                json!({"title": payload["title"], "detail": payload["detail"]}),
            )?;
            Ok(json!({"ok":true}))
        }
        "ui.focus_terminal" => {
            emit(handle, "ui.focus_terminal", origin, json!({}))?;
            Ok(json!({"ok":true}))
        }
        "proposal.list" => proposal_list(handle, payload),
        "proposal.read" => proposal_read(handle, payload),
        "proposal.submit" => proposal_submit(handle, payload, origin),
        "proposal.approve" => proposal_resolve(handle, payload, "accepted"),
        "proposal.reject" => proposal_resolve(handle, payload, "rejected"),
        "proposal.request_changes" => proposal_resolve(handle, payload, "changes_requested"),
        "artifact.create_draft" => create_draft(handle, payload, origin),
        "artifact.update_draft" => update_draft(handle, payload, origin),
        "artifact.import_file" => artifact_import_file(handle, payload, origin),
        "artifact.apply_edit" => apply_edit(handle, payload),
        "artifact.accept_draft" => accept_draft(handle, payload),
        "artifact.revert" => revert_artifact(handle, payload),
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

fn artifact_compare(handle: &ProjectHandle, payload: &Value) -> CoreResult<Value> {
    let artifact_id = required_str(payload, "artifactId")?;
    let artifact = require_artifact(handle, artifact_id)?;
    let from = require_revision(handle, required_str(payload, "fromRevisionId")?)?;
    let to = require_revision(handle, required_str(payload, "toRevisionId")?)?;
    if from["artifactId"] != artifact_id || to["artifactId"] != artifact_id {
        return Err(ContractError::validation(
            "Revisions do not belong to artifact",
        ));
    }
    let mut payload_diff = Vec::new();
    diff_payloads(
        Some(&from["payload"]),
        Some(&to["payload"]),
        "",
        &mut payload_diff,
    );
    let from_files = from["files"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let to_files = to["files"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let added_files = to_files
        .iter()
        .filter(|file| {
            !from_files
                .iter()
                .any(|prior| prior["path"] == file["path"] && prior["sha256"] == file["sha256"])
        })
        .cloned()
        .collect::<Vec<_>>();
    let removed_files = from_files
        .iter()
        .filter(|file| {
            !to_files
                .iter()
                .any(|next| next["path"] == file["path"] && next["sha256"] == file["sha256"])
        })
        .cloned()
        .collect::<Vec<_>>();
    let from_inputs = from["inputs"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let to_inputs = to["inputs"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let added_inputs = to_inputs
        .iter()
        .filter(|item| {
            !from_inputs.iter().any(|prior| {
                prior["artifactId"] == item["artifactId"]
                    && prior["revisionId"] == item["revisionId"]
            })
        })
        .cloned()
        .collect::<Vec<_>>();
    let removed_inputs = from_inputs
        .iter()
        .filter(|item| {
            !to_inputs.iter().any(|next| {
                next["artifactId"] == item["artifactId"] && next["revisionId"] == item["revisionId"]
            })
        })
        .cloned()
        .collect::<Vec<_>>();
    Ok(
        json!({"artifact": artifact, "from": from, "to": to, "payloadDiff": payload_diff, "fileDiff": {"added": added_files, "removed": removed_files}, "inputDiff": {"added": added_inputs, "removed": removed_inputs}}),
    )
}

fn diff_payloads(from: Option<&Value>, to: Option<&Value>, path: &str, out: &mut Vec<Value>) {
    if from == to {
        return;
    }
    let from_object = from.and_then(Value::as_object);
    let to_object = to.and_then(Value::as_object);
    if let (Some(from_object), Some(to_object)) = (from_object, to_object) {
        for key in from_object
            .keys()
            .chain(to_object.keys())
            .collect::<std::collections::BTreeSet<_>>()
        {
            let nested = if path.is_empty() {
                key.clone()
            } else {
                format!("{path}.{key}")
            };
            diff_payloads(from_object.get(key), to_object.get(key), &nested, out);
        }
        return;
    }
    if let (Some(from_items), Some(to_items)) =
        (from.and_then(Value::as_array), to.and_then(Value::as_array))
    {
        for index in 0..from_items.len().max(to_items.len()) {
            let nested = if path.is_empty() {
                index.to_string()
            } else {
                format!("{path}.{index}")
            };
            diff_payloads(from_items.get(index), to_items.get(index), &nested, out);
        }
        return;
    }
    let mut entry = serde_json::Map::new();
    entry.insert(
        "path".into(),
        json!(if path.is_empty() { "(root)" } else { path }),
    );
    if let Some(value) = from {
        entry.insert("from".into(), value.clone());
    }
    if let Some(value) = to {
        entry.insert("to".into(), value.clone());
    }
    out.push(Value::Object(entry));
}

fn artifact_archive(handle: &ProjectHandle, payload: &Value) -> CoreResult<Value> {
    let id = required_str(payload, "artifactId")?;
    require_artifact(handle, id)?;
    let archived = payload["archived"].as_bool().unwrap_or(true);
    let tx = handle.db.unchecked_transaction().map_err(internal)?;
    tx.execute(
        "UPDATE artifact SET archived=?1 WHERE id=?2",
        params![archived as i64, id],
    )
    .map_err(internal)?;
    let seq = tx_event(
        &tx,
        "artifact.archived",
        "user",
        json!({"artifactId": id, "archived": archived}),
    )?;
    tx.commit().map_err(internal)?;
    graph::propagate_from(handle, &[id.to_owned()], seq)?;
    Ok(json!({"ok": true}))
}

fn artifact_set_subsystem(handle: &ProjectHandle, payload: &Value) -> CoreResult<Value> {
    let id = required_str(payload, "artifactId")?;
    require_artifact(handle, id)?;
    handle
        .db
        .execute(
            "UPDATE artifact SET subsystem=?1 WHERE id=?2",
            params![payload["subsystem"].as_str(), id],
        )
        .map_err(internal)?;
    Ok(json!({"ok": true}))
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
    let parent = if let Some(id) = parent_id {
        Some(require_revision(handle, id)?)
    } else {
        handle.db.query_row(
            "SELECT * FROM revision WHERE artifact_id=?1 AND review_state IN ('draft','proposed') ORDER BY seq DESC LIMIT 1",
            [artifact_id], revision_from_row,
        ).optional().map_err(internal)?
    };
    let parent_id = parent.as_ref().and_then(|revision| revision["id"].as_str());
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
    accept_draft_with_action(handle, input, "accepted")
}

fn accept_draft_with_action(
    handle: &mut ProjectHandle,
    input: &Value,
    action: &str,
) -> CoreResult<Value> {
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
        action,
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

fn artifact_import_file(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    let path = required_str(input, "path")?;
    let file = json!({"path": path, "sourcePath": path});
    if let Some(artifact_id) = input["artifactId"].as_str() {
        update_draft(
            handle,
            &json!({"artifactId": artifact_id, "files": [file], "rationale": input["rationale"]}),
            origin,
        )
    } else {
        let type_name = input["type"].as_str().ok_or_else(|| {
            ContractError::validation("import_file needs type+title for new artifacts")
        })?;
        let title = input["title"].as_str().ok_or_else(|| {
            ContractError::validation("import_file needs type+title for new artifacts")
        })?;
        create_draft(
            handle,
            &json!({"type": type_name, "title": title, "payload": {}, "files": [file], "inputs": [], "rationale": input["rationale"]}),
            origin,
        )
    }
}

fn apply_edit(handle: &mut ProjectHandle, input: &Value) -> CoreResult<Value> {
    let artifact_id = required_str(input, "artifactId")?;
    let base_id = required_str(input, "baseRevisionId")?;
    let artifact = require_artifact(handle, artifact_id)?;
    if artifact["selectedRevisionId"] != base_id {
        return Err(ContractError::new(
            "REVISION_CONFLICT",
            "Base revision is no longer selected",
        ));
    }
    let parent = require_revision(handle, base_id)?;
    let mut payload = input.get("payload").cloned();
    if let Some(patch) = input["payloadPatch"].as_object() {
        let mut base = parent["payload"].as_object().cloned().unwrap_or_default();
        for (key, value) in patch {
            base.insert(key.clone(), value.clone());
        }
        payload = Some(Value::Object(base));
    }
    let mut update = json!({"artifactId": artifact_id, "baseRevisionId": base_id, "rationale": input["rationale"]});
    if let Some(payload) = payload {
        update["payload"] = payload;
    }
    if let Some(title) = input["title"].as_str() {
        update["title"] = json!(title);
    }
    if let Some(writes) = input["fileWrites"].as_array() {
        if !writes.is_empty() {
            let overwritten = writes
                .iter()
                .filter_map(|file| file["path"].as_str())
                .collect::<std::collections::HashSet<_>>();
            let store = handle.object_store().map_err(storage_error)?;
            let mut files = Vec::new();
            for file in parent["files"].as_array().into_iter().flatten() {
                let path = required_str(file, "path")?;
                if overwritten.contains(path) {
                    continue;
                }
                let sha = required_str(file, "sha256")?;
                files.push(json!({"path": path, "contentBase64": base64::engine::general_purpose::STANDARD.encode(store.read(sha).map_err(storage_error)?)}));
            }
            files.extend(writes.iter().cloned());
            update["files"] = json!(files);
        }
    }
    let draft = update_draft(handle, &update, &Origin::User)?;
    accept_draft_with_action(
        handle,
        &json!({"artifactId": artifact_id, "draftRevisionId": draft["revision"]["id"], "rationale": input["rationale"]}),
        "direct_edit",
    )
}

fn revert_artifact(handle: &mut ProjectHandle, input: &Value) -> CoreResult<Value> {
    let artifact_id = required_str(input, "artifactId")?;
    let artifact = require_artifact(handle, artifact_id)?;
    let target = require_revision(handle, required_str(input, "toRevisionId")?)?;
    if target["artifactId"] != artifact_id {
        return Err(ContractError::validation(
            "Revision does not belong to artifact",
        ));
    }
    let store = handle.object_store().map_err(storage_error)?;
    let mut files = Vec::new();
    for file in target["files"].as_array().into_iter().flatten() {
        let sha = required_str(file, "sha256")?;
        files.push(json!({"path": file["path"], "contentBase64": base64::engine::general_purpose::STANDARD.encode(store.read(sha).map_err(storage_error)?)}));
    }
    let mut draft_input = json!({"artifactId": artifact_id, "payload": target["payload"], "files": files, "inputs": target["inputs"], "rationale": format!("Revert to revision {}: {}", target["seq"], input["rationale"].as_str().unwrap_or(""))});
    if let Some(selected) = artifact["selectedRevisionId"].as_str() {
        draft_input["baseRevisionId"] = json!(selected);
    }
    let draft = update_draft(handle, &draft_input, &Origin::User)?;
    accept_draft_with_action(
        handle,
        &json!({"artifactId": artifact_id, "draftRevisionId": draft["revision"]["id"], "rationale": input["rationale"]}),
        "revert",
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
    // Human selection of a baseline is allowed even when CAD verification is
    // incomplete. Readiness remains labeled by the verification evidence.
    let _ = artifact;
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
    let mut accepted_scopes = Vec::<(String, Value)>::new();
    if state == "accepted" {
        for (artifact_id, hash) in input["verificationEvidence"]
            .as_object()
            .into_iter()
            .flat_map(|m| m.iter())
        {
            let change = changes
                .iter()
                .find(|change| {
                    change["artifactId"].as_str() == Some(artifact_id.as_str())
                        && change["kind"] != "archive"
                })
                .ok_or_else(|| {
                    ContractError::validation("Verification scope is not part of this proposal")
                })?;
            let revision = require_revision(handle, required_str(change, "newRevisionId")?)?;
            accepted_scopes.push((
                artifact_id.clone(),
                cad::validate_scope_accept(
                    handle,
                    &revision,
                    hash.as_str().ok_or_else(|| {
                        ContractError::validation("Evidence hash must be a string")
                    })?,
                )?,
            ));
        }
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
            if !matches!(
                change["kind"].as_str(),
                Some(
                    "new_artifact"
                        | "baseline_update"
                        | "component_selection"
                        | "bom_edit"
                        | "archive"
                )
            ) {
                return Err(ContractError::new(
                    "TOOL_MISSING",
                    "This approval change kind is not ported yet",
                ));
            }
            assert_simple_approval(&artifact)?;
            if let Some(lines) = change["bomLines"].as_array() {
                for line in lines {
                    let component_id = required_str(line, "componentArtifactId")?;
                    let component = require_artifact(handle, component_id)?;
                    if component["type"] != "component" {
                        return Err(ContractError::validation(
                            "BOM line target must be a component",
                        ));
                    }
                    let linked =
                        require_revision(handle, required_str(line, "componentRevisionId")?)?;
                    if linked["artifactId"] != component_id {
                        return Err(ContractError::validation(
                            "BOM line revision does not belong to component",
                        ));
                    }
                }
            }
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
    for (artifact_id, scope) in &accepted_scopes {
        tx.execute("INSERT INTO meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![format!("cad.scope.accepted.{artifact_id}"),json!({"evidenceHash":scope["evidenceHash"],"specHash":scope["specHash"],"expect":scope["expect"],"revisionId":scope["revisionId"]}).to_string()]).map_err(internal)?;
        tx_event(
            &tx,
            "cad.scope.accepted",
            "user",
            json!({"artifactId":artifact_id,"revisionId":scope["revisionId"],
            "evidenceHash":scope["evidenceHash"],"specHash":scope["specHash"],"scopeChanges":scope["scopeChanges"]}),
        )?;
    }
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
            if change["kind"] == "archive" {
                tx.execute("UPDATE artifact SET archived=1 WHERE id=?1", [artifact_id])
                    .map_err(internal)?;
            } else {
                promote_revision(&tx, &artifact, &revision)?;
                next.push(json!({"artifactId": artifact_id, "revisionId": revision["id"]}));
            }
            if change["kind"] == "component_selection" {
                if let Some(replaced) = change["replacesArtifactId"].as_str() {
                    tx.execute("UPDATE artifact SET archived=1 WHERE id=?1", [replaced])
                        .map_err(internal)?;
                }
            }
            if let Some(lines) = change["bomLines"].as_array() {
                for line in lines {
                    tx.execute("INSERT INTO bom_line(id,component_artifact_id,component_revision_id,subsystem,quantity,offer_id,location,notes) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)", params![uuid::Uuid::new_v4().to_string(), line["componentArtifactId"].as_str(), line["componentRevisionId"].as_str(), line["subsystem"].as_str(), line["quantity"].as_f64(), line["offerId"].as_str(), line["location"].as_str(), line["notes"].as_str().unwrap_or("")]).map_err(internal)?;
                }
            }
            if let Some(ids) = change["removeBomLineIds"].as_array() {
                for id in ids.iter().filter_map(Value::as_str) {
                    tx.execute("DELETE FROM bom_line WHERE id=?1", [id])
                        .map_err(internal)?;
                }
            }
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

fn journal_path(root: &Path, key: &str) -> PathBuf {
    let digest = format!("{:x}", Sha256::digest(key.as_bytes()));
    root.join(".omenflow/recovery/idempotency")
        .join(format!("{digest}.json"))
}

fn write_result_journal(root: &Path, key: &str, hash: &str, response: &Value) -> CoreResult<()> {
    use std::io::Write;
    let path = journal_path(root, key);
    fs::create_dir_all(path.parent().unwrap()).map_err(internal)?;
    let temporary = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(internal)?;
        file.write_all(
            json!({"key":key,"requestHash":hash,"response":response,"writtenAt":now()})
                .to_string()
                .as_bytes(),
        )
        .map_err(internal)?;
        file.sync_all().map_err(internal)?;
        fs::rename(&temporary, &path).map_err(internal)
    })();
    let _ = fs::remove_file(&temporary);
    result
}

fn read_result_journal(root: &Path, key: &str, hash: &str) -> Option<Value> {
    let journal: Value = serde_json::from_slice(&fs::read(journal_path(root, key)).ok()?).ok()?;
    if journal["key"] == key
        && journal["requestHash"] == hash
        && journal["response"]["operationPending"] != true
    {
        Some(journal["response"].clone())
    } else {
        None
    }
}

fn clear_result_journal(root: &Path, key: &str) {
    let _ = fs::remove_file(journal_path(root, key));
}

fn with_replay_marker(mut response: Value, recovered: bool) -> Value {
    if let Some(object) = response.as_object_mut() {
        object.insert("idempotent".into(), json!(true));
        if recovered {
            object.insert("recovered".into(), json!(true));
        }
    }
    response
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
    fn newer_read_only_project_can_close_without_writing_its_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        ProjectHandle::create(&root, "Future", "test").unwrap();
        let marker = root.join("omenflow.project.json");
        let mut value: Value = serde_json::from_slice(&fs::read(&marker).unwrap()).unwrap();
        value["version"] = json!(999);
        fs::write(&marker, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        let mut app = CoreApp::new(temp.path().join("appdata")).unwrap();
        let opened = app
            .dispatch("project.open", json!({"path":root}), Origin::User, None)
            .unwrap();
        app.dispatch(
            "project.close",
            json!({}),
            Origin::User,
            opened["projectId"].as_str(),
        )
        .unwrap();
    }

    #[test]
    fn cad_render_returns_a_queued_job_and_commits_a_new_draft_in_background() {
        if cad::probe().ok().and_then(|v| v["available"].as_bool()) != Some(true) {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let mut app = CoreApp::new(temp.path().join("appdata")).unwrap();
        let created = app
            .dispatch(
                "project.create",
                json!({"name":"Async CAD","path":temp.path().join("project")}),
                Origin::User,
                None,
            )
            .unwrap();
        let id = created["projectId"].as_str().unwrap();
        let source = app
            .dispatch(
                "cad.write_source",
                json!({"title":"Plate","source":"cube([20,10,2]);","timeoutMs":30000}),
                Origin::User,
                Some(id),
            )
            .unwrap();
        let queued=app.dispatch("cad.render",json!({"artifactId":source["artifactId"],"revisionId":source["revisionId"],"timeoutMs":30000}),Origin::User,Some(id)).unwrap();
        assert_eq!(queued["job"]["status"], "queued");
        let job_id = queued["job"]["id"].as_str().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let job = app
                .dispatch("job.read", json!({"jobId":job_id}), Origin::User, Some(id))
                .unwrap();
            if job["job"]["status"] == "succeeded" {
                break;
            }
            assert!(
                job["job"]["status"] == "queued" || job["job"]["status"] == "running",
                "{job}"
            );
            assert!(
                std::time::Instant::now() < deadline,
                "render job timed out: {job}"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let history = app
            .dispatch(
                "artifact.history",
                json!({"artifactId":source["artifactId"]}),
                Origin::User,
                Some(id),
            )
            .unwrap();
        assert_eq!(history["revisions"].as_array().unwrap().len(), 2);
        assert_eq!(history["revisions"][1]["reviewState"], "draft");
    }

    #[test]
    fn app_level_create_replays_across_restart_without_second_project() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("appdata");
        let input = json!({"name":"Replay","path":temp.path().join("project"),"intent":"test"});
        let first = CoreApp::new(&data)
            .unwrap()
            .dispatch_idempotent(
                "project.create",
                input.clone(),
                Origin::User,
                None,
                Some("create-1"),
            )
            .unwrap();
        let second = CoreApp::new(&data)
            .unwrap()
            .dispatch_idempotent(
                "project.create",
                input.clone(),
                Origin::User,
                None,
                Some("create-1"),
            )
            .unwrap();
        assert_eq!(first["projectId"], second["projectId"]);
        assert_eq!(second["idempotent"], true);
        let changed = CoreApp::new(&data).unwrap().dispatch_idempotent(
            "project.create",
            json!({"name":"Changed","path":temp.path().join("project"),"intent":"test"}),
            Origin::User,
            None,
            Some("create-1"),
        );
        assert_eq!(changed.unwrap_err().code, "VALIDATION");
    }

    #[test]
    fn structured_drafts_keep_content_files_and_offer_notifications() {
        let temp = tempfile::tempdir().unwrap();
        let mut app = CoreApp::new(temp.path().join("app")).unwrap();
        let project = app
            .dispatch(
                "project.create",
                json!({"name":"Content","path":temp.path().join("project")}),
                Origin::User,
                None,
            )
            .unwrap();
        let pid = project["projectId"].as_str().unwrap();
        let examples: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/artifact-payloads.json"
        ))
        .unwrap();
        for (kind, payload) in examples.as_object().unwrap() {
            let first = app.dispatch("artifact.create_draft", json!({"type":kind,"title":kind,"payload":payload,"files":[{"path":format!("{kind}.txt"),"contentBase64":"c2F2ZWQgY29udGVudA=="}]}), Origin::User, Some(pid)).unwrap();
            let id = first["artifact"]["id"].as_str().unwrap();
            let second = app
                .dispatch(
                    "artifact.update_draft",
                    json!({"artifactId":id,"title":format!("Updated {kind}")}),
                    Origin::User,
                    Some(pid),
                )
                .unwrap();
            assert_eq!(second["revision"]["parentId"], first["revision"]["id"]);
            assert_eq!(second["revision"]["payload"], first["revision"]["payload"]);
            assert_eq!(second["revision"]["files"], first["revision"]["files"]);
            assert!(second["artifact"]["selectedRevisionId"].is_null());
            let schema = app
                .dispatch(
                    "tool.describe",
                    json!({"op":"artifact.create_draft","artifactType":kind}),
                    Origin::User,
                    Some(pid),
                )
                .unwrap();
            assert!(schema["payloadSchema"]["properties"].is_object());
            if kind == "component" {
                app.dispatch("component.add_offer", json!({"artifactId":id,"seller":"Example","url":"https://example.com/part","price":null}), Origin::User, Some(pid)).unwrap();
                let events = app
                    .dispatch(
                        "project.changes_since",
                        json!({"seq":0}),
                        Origin::User,
                        Some(pid),
                    )
                    .unwrap();
                assert!(events["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|event| event["type"] == "component.offer_added"
                        && event["data"]["artifactId"] == id));
            }
            if kind == "wiring" {
                let mut body = payload.clone();
                let first_connection = body["connections"][0].clone();
                body["connections"] = json!((0..5)
                    .map(|index| {
                        let mut c = first_connection.clone();
                        c["id"] = json!(uuid::Uuid::new_v4().to_string());
                        c["signalRole"] = json!(format!("Signal <{index}>"));
                        if index == 3 {
                            c["to"] = c["from"].clone();
                        }
                        if index == 4 {
                            let from = c["from"].clone();
                            c["from"] = c["to"].clone();
                            c["to"] = from;
                        }
                        c
                    })
                    .collect::<Vec<_>>());
                let wiring = app
                    .dispatch(
                        "artifact.update_draft",
                        json!({"artifactId":id,"payload":body}),
                        Origin::User,
                        Some(pid),
                    )
                    .unwrap();
                let rendered = app
                    .dispatch(
                        "wiring.render",
                        json!({"artifactId":id,"revisionId":wiring["revision"]["id"]}),
                        Origin::User,
                        Some(pid),
                    )
                    .unwrap();
                let svg = rendered["diagramSvg"].as_str().unwrap();
                assert!(svg.contains("VIN") && svg.contains("OUT") && svg.contains("12 V"));
                assert!(svg.contains("Signal &lt;4&gt;"));
                assert_eq!(svg.matches("<path ").count(), 5);
                assert!(svg.contains("244")); // fifth connection gets a separate row, not a recycled lane
            }
        }
    }

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
    fn idempotent_project_mutation_replays_without_duplicating_revision() {
        let temp = tempfile::tempdir().unwrap();
        let mut app = CoreApp::new(temp.path().join("appdata")).unwrap();
        let created = app
            .dispatch(
                "project.create",
                json!({"name":"Replay","path":temp.path().join("project"),"intent":"test"}),
                Origin::User,
                None,
            )
            .unwrap();
        let id = created["projectId"].as_str().unwrap();
        let input = json!({"type":"requirement","title":"Load","payload":{"statement":"Carry load","acceptanceCriterion":"Pass test"}});
        let first = app
            .dispatch_idempotent(
                "artifact.create_draft",
                input.clone(),
                Origin::User,
                Some(id),
                Some("draft-1"),
            )
            .unwrap();
        let stored_hash: String = app.projects[id]
            .db
            .query_row("SELECT request_hash FROM idempotency WHERE key='user:artifact.create_draft:draft-1'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            stored_hash,
            "ab11b3035d62963e45098bf8b5a6626af9e42dd9db6bb742b680f53472a2b4fe"
        );
        let replay = app
            .dispatch_idempotent(
                "artifact.create_draft",
                input.clone(),
                Origin::User,
                Some(id),
                Some("draft-1"),
            )
            .unwrap();
        assert_eq!(first["revision"]["id"], replay["revision"]["id"]);
        assert_eq!(replay["idempotent"], true);
        assert_eq!(
            app.dispatch("artifact.list", json!({}), Origin::User, Some(id))
                .unwrap()["artifacts"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let changed = json!({"type":"requirement","title":"Other","payload":{"statement":"Carry load","acceptanceCriterion":"Pass test"}});
        assert_eq!(
            app.dispatch_idempotent(
                "artifact.create_draft",
                changed,
                Origin::User,
                Some(id),
                Some("draft-1")
            )
            .unwrap_err()
            .code,
            "VALIDATION"
        );
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
