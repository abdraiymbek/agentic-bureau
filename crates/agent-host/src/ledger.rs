//! The agent call ledger: one record for every call an agent makes through
//! the bridge, whether it succeeded or not. Records carry what was called,
//! how it ended and which artifacts it named; arguments are never stored.
//!
//! Each project keeps its recent records in memory and appends every record
//! to `.omenflow/work/<sessionId>/calls.jsonl`, so the history survives a
//! restart of the app.

use omenflow_contracts::Profile;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Records kept in memory per project.
const RING: usize = 2_000;
/// Session folders read when a project's history is loaded, newest first.
const SESSIONS_LOADED: usize = 200;
/// Artifact ids kept on one record.
const ARTIFACT_IDS: usize = 8;
/// Longest error message kept on one record, in characters.
const MESSAGE_CHARS: usize = 300;

pub const DEFAULT_ACTIVITY_LIMIT: usize = 100;
pub const MAX_ACTIVITY_LIMIT: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Via {
    /// A `tools/call` over MCP.
    Mcp,
    /// `omenflow call` from the agent's shell.
    Call,
}

/// One recorded agent call (spec section 3, `AgentCallRecord`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCallRecord {
    /// Monotonic within the project.
    pub seq: u64,
    /// ISO time the call finished.
    pub at: String,
    pub project_id: String,
    pub session_id: String,
    /// The name as the agent called it.
    pub tool: String,
    /// The operation that ran; the called name when none did.
    pub op: String,
    pub via: Via,
    pub ok: bool,
    pub code: Option<String>,
    pub message: Option<String>,
    pub duration_ms: u64,
    pub mutating: bool,
    pub artifact_ids: Vec<String>,
    /// Input repairs the host applied before running the call.
    pub notes: Vec<String>,
    /// What else the host ran inside the call, in order: the cad_check a
    /// source write with `expect` ran, the work_status attached to a
    /// committed check. Absent from records of calls that ran nothing else,
    /// and from those of earlier builds.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub also_ran: Vec<AlsoRan>,
}

/// One operation the host ran inside an agent's call (`AgentCallAlsoRan`).
/// The record's own `ok` says how the call ended; this says how the inner run
/// ended, in the inner operation's own terms. Every field has a default, so a
/// record a later build wrote with more or fewer fields still loads.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AlsoRan {
    /// Underscore tool name: `cad_check`, `work_status`.
    pub tool: String,
    pub op: String,
    /// False when it did not run to an answer; `code` then says why.
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// The answer was replayed for a retried call with the same idempotency
    /// key; nothing ran again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replayed: Option<bool>,
    /// cad_check: the status it recorded, whether it was committed and its
    /// assertion counts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub committed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    /// work_status: the scope it answered for, whether it was ready and how
    /// many blockers it listed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ready: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blockers: Option<u64>,
}

/// What `dispatch_agent` knows about a finished call.
pub struct CallOutcome {
    pub project_id: String,
    pub session_id: String,
    pub tool: String,
    pub op: String,
    pub via: Via,
    pub ok: bool,
    pub code: Option<String>,
    pub message: Option<String>,
    pub duration_ms: u64,
    pub mutating: bool,
    pub artifact_ids: Vec<String>,
    pub notes: Vec<String>,
    pub also_ran: Vec<AlsoRan>,
}

/// One agent session as the ledger knows it (spec section 3,
/// `AgentSessionSummary`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSummary {
    pub session_id: String,
    pub adapter_id: String,
    pub model: Option<String>,
    pub profile: Profile,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub calls: u64,
    pub errors: u64,
}

#[derive(Default)]
struct ProjectLedger {
    next_seq: u64,
    records: VecDeque<AgentCallRecord>,
    /// In start order.
    sessions: Vec<AgentSessionSummary>,
    root: Option<PathBuf>,
}

#[derive(Default)]
pub struct Ledger {
    projects: Mutex<HashMap<String, ProjectLedger>>,
}

impl Ledger {
    /// Tell the ledger where a project lives. The first call for a project
    /// loads the history earlier sessions left on disk. Callers attach a
    /// project before its first record; if calls were recorded first, they
    /// keep the numbers already published and the earlier history stays on
    /// disk only.
    pub fn attach_project(&self, project_id: &str, root: &Path) {
        let mut projects = self.lock();
        let project = projects.entry(project_id.to_owned()).or_default();
        match &project.root {
            Some(known) if known == root => return,
            Some(_) => {
                move_project(project, project_id, root);
                return;
            }
            None => {}
        }
        project.root = Some(root.to_owned());
        let (records, sessions) = load_history(root, project_id);
        let stored = records.last().map_or(0, |record| record.seq);
        project.next_seq = project.next_seq.max(stored);
        if project.records.is_empty() {
            project.records = records.into();
        } else {
            for record in &project.records {
                append_line(root, &record.session_id, "calls.jsonl", record);
            }
        }
        let live = std::mem::take(&mut project.sessions);
        project.sessions = sessions
            .into_iter()
            .filter(|loaded| {
                live.iter()
                    .all(|known| known.session_id != loaded.session_id)
            })
            .collect();
        for session in live {
            write_session(root, &session);
            project.sessions.push(session);
        }
    }

    #[cfg(test)]
    fn project_root(&self, project_id: &str) -> Option<PathBuf> {
        self.lock()
            .get(project_id)
            .and_then(|project| project.root.clone())
    }

    /// Register a session when its grant is issued.
    pub fn begin_session(
        &self,
        project_id: &str,
        session_id: &str,
        adapter_id: &str,
        model: Option<&str>,
        profile: Profile,
    ) {
        let summary = AgentSessionSummary {
            session_id: session_id.to_owned(),
            adapter_id: adapter_id.to_owned(),
            model: model.map(str::to_owned),
            profile,
            started_at: crate::now(),
            ended_at: None,
            calls: 0,
            errors: 0,
        };
        let mut projects = self.lock();
        let project = projects.entry(project_id.to_owned()).or_default();
        project
            .sessions
            .retain(|session| session.session_id != session_id);
        if let Some(root) = &project.root {
            write_session(root, &summary);
        }
        project.sessions.push(summary);
    }

    /// Mark a session ended when its grant is revoked.
    pub fn end_session(&self, session_id: &str) {
        let mut projects = self.lock();
        for project in projects.values_mut() {
            let root = project.root.clone();
            if let Some(session) = project
                .sessions
                .iter_mut()
                .find(|session| session.session_id == session_id && session.ended_at.is_none())
            {
                session.ended_at = Some(crate::now());
                if let Some(root) = root {
                    write_session(&root, session);
                }
            }
        }
    }

    /// Record a finished call and return the record as stored.
    pub fn record(&self, outcome: CallOutcome) -> AgentCallRecord {
        let mut projects = self.lock();
        let project = projects.entry(outcome.project_id.clone()).or_default();
        project.next_seq += 1;
        let record = AgentCallRecord {
            seq: project.next_seq,
            at: crate::now(),
            project_id: outcome.project_id,
            session_id: outcome.session_id,
            tool: outcome.tool,
            op: outcome.op,
            via: outcome.via,
            ok: outcome.ok,
            code: outcome.code,
            message: outcome.message.as_deref().map(one_line),
            duration_ms: outcome.duration_ms,
            mutating: outcome.mutating,
            artifact_ids: outcome.artifact_ids,
            notes: outcome.notes,
            also_ran: outcome.also_ran,
        };
        if let Some(session) = project
            .sessions
            .iter_mut()
            .find(|session| session.session_id == record.session_id)
        {
            session.calls += 1;
            session.errors += u64::from(!record.ok);
        }
        if let Some(root) = &project.root {
            append_line(root, &record.session_id, "calls.jsonl", &record);
        }
        project.records.push_back(record.clone());
        trim(&mut project.records);
        record
    }

    /// Calls and failed calls recorded for a session so far.
    pub fn counters(&self, session_id: &str) -> (u64, u64) {
        self.lock()
            .values()
            .flat_map(|project| project.sessions.iter())
            .find(|session| session.session_id == session_id)
            .map_or((0, 0), |session| (session.calls, session.errors))
    }

    /// The `agent.activity` result: the most recent `limit` calls before
    /// `before_seq` (all of them when it is absent), oldest first, and every
    /// session the ledger knows for the project.
    pub fn activity(
        &self,
        project_id: &str,
        limit: usize,
        session_id: Option<&str>,
        before_seq: Option<u64>,
    ) -> Value {
        let projects = self.lock();
        let Some(project) = projects.get(project_id) else {
            return json!({"calls": [], "sessions": []});
        };
        let limit = limit.clamp(1, MAX_ACTIVITY_LIMIT);
        let mut calls = project
            .records
            .iter()
            .rev()
            .filter(|record| before_seq.is_none_or(|before| record.seq < before))
            .filter(|record| session_id.is_none_or(|session| record.session_id == session))
            .take(limit)
            .collect::<Vec<_>>();
        calls.reverse();
        let sessions = project
            .sessions
            .iter()
            .filter(|session| session_id.is_none_or(|wanted| session.session_id == wanted))
            .collect::<Vec<_>>();
        json!({"calls": calls, "sessions": sessions})
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, ProjectLedger>> {
        self.projects
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// A project that was moved, or opened again from another folder, keeps its
/// history where it is now: the records and sessions found there, then what
/// was recorded since that folder last saw a write.
fn move_project(project: &mut ProjectLedger, project_id: &str, root: &Path) {
    let (records, sessions) = load_history(root, project_id);
    let stored = records.last().map_or(0, |record| record.seq);
    let unwritten = project
        .records
        .iter()
        .filter(|record| record.seq > stored)
        .cloned()
        .collect::<Vec<_>>();
    for record in &unwritten {
        append_line(root, &record.session_id, "calls.jsonl", record);
    }
    project.records = records.into();
    project.records.extend(unwritten);
    trim(&mut project.records);
    project.next_seq = project.next_seq.max(stored);
    let live = std::mem::take(&mut project.sessions);
    project.sessions = sessions
        .into_iter()
        .filter(|loaded| {
            live.iter()
                .all(|known| known.session_id != loaded.session_id)
        })
        .collect();
    for session in live {
        write_session(root, &session);
        project.sessions.push(session);
    }
    project.root = Some(root.to_owned());
}

fn trim(records: &mut VecDeque<AgentCallRecord>) {
    while records.len() > RING {
        records.pop_front();
    }
}

/// An error message as one bounded line.
fn one_line(message: &str) -> String {
    let flat = message.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= MESSAGE_CHARS {
        return flat;
    }
    let mut cut = flat.chars().take(MESSAGE_CHARS - 1).collect::<String>();
    cut.push('…');
    cut
}

fn session_dir(root: &Path, session_id: &str) -> Option<PathBuf> {
    // A session id becomes a folder name; refuse anything that could leave
    // the work folder.
    let safe = !session_id.is_empty()
        && session_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-');
    // A project that is no longer at `root` (moved, deleted) gets no new
    // folders there: the write is skipped instead of re-creating the tree.
    (safe && root.join(".omenflow").is_dir()).then(|| root.join(".omenflow/work").join(session_id))
}

/// Append one JSON line to a session's sidecar. The ledger never fails a
/// call: a record that cannot be written stays in memory only.
fn append_line(root: &Path, session_id: &str, file: &str, value: &impl Serialize) {
    let Some(dir) = session_dir(root, session_id) else {
        return;
    };
    let Ok(mut line) = serde_json::to_vec(value) else {
        return;
    };
    line.push(b'\n');
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(file))
    {
        let _ = file.write_all(&line);
    }
}

/// Who a session was. Counters are not stored here: they are counted from
/// the session's records when history is loaded.
fn write_session(root: &Path, session: &AgentSessionSummary) {
    let Some(dir) = session_dir(root, &session.session_id) else {
        return;
    };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(bytes) = serde_json::to_vec(session) {
        let _ = fs::write(dir.join("session.json"), bytes);
    }
}

/// Records and sessions earlier runs left under `.omenflow/work`, oldest
/// first. Lines that do not parse, or that belong to another project, are
/// skipped.
fn load_history(root: &Path, project_id: &str) -> (Vec<AgentCallRecord>, Vec<AgentSessionSummary>) {
    let Ok(entries) = fs::read_dir(root.join(".omenflow/work")) else {
        return (Vec::new(), Vec::new());
    };
    let mut folders = entries
        .flatten()
        .filter(|entry| entry.path().join("calls.jsonl").is_file())
        .map(|entry| {
            let modified = entry
                .path()
                .join("calls.jsonl")
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok();
            (modified, entry.path())
        })
        .collect::<Vec<_>>();
    folders.sort();
    let skipped = folders.len().saturating_sub(SESSIONS_LOADED);
    let mut records = Vec::new();
    let mut sessions = Vec::new();
    for (_, folder) in folders.into_iter().skip(skipped) {
        let own = fs::read_to_string(folder.join("calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<AgentCallRecord>(line).ok())
            .filter(|record| record.project_id == project_id)
            .collect::<Vec<_>>();
        let stored = fs::read(folder.join("session.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<AgentSessionSummary>(&bytes).ok());
        if let Some(mut session) = stored {
            session.calls = own.len() as u64;
            session.errors = own.iter().filter(|record| !record.ok).count() as u64;
            // A session whose host stopped before it ended did end.
            if session.ended_at.is_none() {
                session.ended_at = own.last().map(|record| record.at.clone());
            }
            sessions.push(session);
        }
        records.extend(own);
    }
    records.sort_by_key(|record| record.seq);
    sessions.sort_by(|left, right| left.started_at.cmp(&right.started_at));
    let surplus = records.len().saturating_sub(RING);
    records.drain(..surplus);
    (records, sessions)
}

/// Artifact ids a call named: in its input wherever a key says so, and in
/// its result where the result is about one artifact or a set of changes.
/// List results are not scanned; a listing touches nothing.
pub fn artifact_ids(input: &Value, result: Option<&Value>) -> Vec<String> {
    let mut ids = Vec::new();
    collect_input_ids(input, 0, &mut ids);
    if let Some(result) = result {
        for pointer in [
            "/artifactId",
            "/artifact/id",
            "/view/artifact/id",
            "/revision/artifactId",
        ] {
            push_id(result.pointer(pointer), &mut ids);
        }
        for change in result["changes"].as_array().into_iter().flatten() {
            push_id(change.get("artifactId"), &mut ids);
        }
    }
    ids.truncate(ARTIFACT_IDS);
    ids
}

fn collect_input_ids(value: &Value, depth: usize, ids: &mut Vec<String>) {
    if depth > 4 {
        return;
    }
    match value {
        Value::Object(fields) => {
            for (key, child) in fields {
                if key == "artifactId" || key.ends_with("ArtifactId") {
                    push_id(Some(child), ids);
                } else if key == "artifactIds" {
                    for id in child.as_array().into_iter().flatten() {
                        push_id(Some(id), ids);
                    }
                } else {
                    collect_input_ids(child, depth + 1, ids);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_input_ids(item, depth + 1, ids);
            }
        }
        _ => {}
    }
}

/// Only a value that is an id is kept: whatever else an agent put under an
/// id's key is an argument, and arguments are never stored.
fn push_id(value: Option<&Value>, ids: &mut Vec<String>) {
    if let Some(id) = value.and_then(Value::as_str) {
        if uuid::Uuid::parse_str(id).is_ok() && !ids.iter().any(|known| known == id) {
            ids.push(id.to_owned());
        }
    }
}

/// The message a record keeps of an error: the error's own message without
/// the values the call sent. A validation error quotes what it received;
/// that is an argument, and arguments are never stored.
pub fn stored_message(error: &omenflow_contracts::ContractError) -> String {
    let mut message = error.message.clone();
    let issues = error
        .details
        .as_deref()
        .and_then(|details| details["issues"].as_array())
        .cloned()
        .unwrap_or_default();
    for received in issues
        .iter()
        .filter_map(|issue| issue["received"].as_str())
        .filter(|received| !received.is_empty())
    {
        message = message
            .replace(&format!(", received {received}"), "")
            .replace(received, "a value");
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder that holds a project, as the ledger writes into.
    fn project() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join(".omenflow")).unwrap();
        temp
    }

    fn outcome(project: &str, session: &str, tool: &str, ok: bool) -> CallOutcome {
        CallOutcome {
            project_id: project.to_owned(),
            session_id: session.to_owned(),
            tool: tool.to_owned(),
            op: tool.replace('_', "."),
            via: Via::Mcp,
            ok,
            code: (!ok).then(|| "VALIDATION".to_owned()),
            message: (!ok).then(|| "Invalid input:\n  artifactId: required".to_owned()),
            duration_ms: 3,
            mutating: false,
            artifact_ids: Vec::new(),
            notes: Vec::new(),
            also_ran: Vec::new(),
        }
    }

    #[test]
    fn records_are_numbered_per_project_and_counted_per_session() {
        let ledger = Ledger::default();
        ledger.begin_session("p1", "s1", "codex", Some("gpt-6-luna"), Profile::Compact);
        ledger.begin_session("p2", "s2", "claude-code", None, Profile::Standard);
        let first = ledger.record(outcome("p1", "s1", "project_summary", true));
        let second = ledger.record(outcome("p1", "s1", "artifact_read", false));
        let other = ledger.record(outcome("p2", "s2", "project_summary", true));
        assert_eq!((first.seq, second.seq, other.seq), (1, 2, 1));
        assert_eq!(ledger.counters("s1"), (2, 1));
        assert_eq!(ledger.counters("s2"), (1, 0));
        assert_eq!(ledger.counters("unknown"), (0, 0));
        assert_eq!(
            second.message.as_deref(),
            Some("Invalid input: artifactId: required")
        );
        assert_eq!(second.code.as_deref(), Some("VALIDATION"));
    }

    #[test]
    fn a_record_serialises_as_the_contract_shape() {
        let ledger = Ledger::default();
        let mut call = outcome("p", "s", "cad_check", true);
        call.op = "cad.check".into();
        call.mutating = true;
        call.artifact_ids = vec!["a1".into()];
        call.notes = vec!["renamed revisionID → revisionId".into()];
        let record = ledger.record(call);
        let value = serde_json::to_value(&record).unwrap();
        assert_eq!(
            value.as_object().unwrap().keys().collect::<Vec<_>>(),
            [
                "seq",
                "at",
                "projectId",
                "sessionId",
                "tool",
                "op",
                "via",
                "ok",
                "code",
                "message",
                "durationMs",
                "mutating",
                "artifactIds",
                "notes"
            ]
        );
        assert_eq!(value["via"], "mcp");
        assert_eq!(value["code"], Value::Null);
        assert_eq!(value["message"], Value::Null);
        assert_eq!(value["artifactIds"], json!(["a1"]));
        assert_eq!(serde_json::to_value(Via::Call).unwrap(), "call");

        let mut write = outcome("p", "s", "cad_write_source", true);
        write.also_ran = vec![
            AlsoRan {
                tool: "cad_check".into(),
                op: "cad.check".into(),
                ok: true,
                verification_status: Some("failed".into()),
                committed: Some(false),
                passed: Some(1),
                total: Some(2),
                ..AlsoRan::default()
            },
            AlsoRan {
                tool: "cad_check".into(),
                op: "cad.check".into(),
                code: Some("INPUT_CHANGED".into()),
                ..AlsoRan::default()
            },
        ];
        let value = serde_json::to_value(ledger.record(write)).unwrap();
        assert_eq!(
            value["alsoRan"],
            json!([
                {"tool": "cad_check", "op": "cad.check", "ok": true, "verificationStatus": "failed",
                 "committed": false, "passed": 1, "total": 2},
                {"tool": "cad_check", "op": "cad.check", "ok": false, "code": "INPUT_CHANGED"}
            ])
        );
    }

    /// Records of earlier builds have no alsoRan; a later build may write
    /// entries with fields this one does not know or lacks ones it does.
    /// Either way the record loads.
    #[test]
    fn records_load_with_or_without_also_ran_and_with_unknown_fields() {
        let earlier = json!({"seq": 1, "at": "t", "projectId": "p", "sessionId": "s",
            "tool": "work_status", "op": "work.status", "via": "mcp", "ok": true, "code": null,
            "message": null, "durationMs": 3, "mutating": false, "artifactIds": [], "notes": []});
        let record: AgentCallRecord = serde_json::from_value(earlier.clone()).unwrap();
        assert!(record.also_ran.is_empty());
        assert_eq!(serde_json::to_value(&record).unwrap(), earlier);
        let mut later = earlier;
        later["alsoRan"] = json!([{"tool": "cad_view", "pictures": 1}, {"op": "cad.check"}]);
        let record: AgentCallRecord = serde_json::from_value(later).unwrap();
        assert_eq!(record.also_ran.len(), 2);
        assert_eq!(record.also_ran[0].tool, "cad_view");
        assert!(!record.also_ran[1].ok);
    }

    #[test]
    fn activity_pages_backwards_and_filters_by_session() {
        let ledger = Ledger::default();
        ledger.begin_session("p", "s1", "codex", None, Profile::Full);
        ledger.begin_session("p", "s2", "custom", None, Profile::Compact);
        for index in 0..6 {
            let session = if index % 2 == 0 { "s1" } else { "s2" };
            ledger.record(outcome("p", session, "artifact_list", index != 3));
        }
        let seqs = |value: &Value| {
            value["calls"]
                .as_array()
                .unwrap()
                .iter()
                .map(|call| call["seq"].as_u64().unwrap())
                .collect::<Vec<_>>()
        };
        let latest = ledger.activity("p", 4, None, None);
        assert_eq!(seqs(&latest), [3, 4, 5, 6]);
        let earlier = ledger.activity("p", 4, None, Some(3));
        assert_eq!(seqs(&earlier), [1, 2]);
        let one = ledger.activity("p", 100, Some("s2"), None);
        assert_eq!(seqs(&one), [2, 4, 6]);
        assert_eq!(one["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(one["sessions"][0]["calls"], 3);
        assert_eq!(one["sessions"][0]["errors"], 1);
        assert_eq!(one["sessions"][0]["profile"], "compact");
        assert_eq!(one["sessions"][0]["model"], Value::Null);
        assert_eq!(latest["sessions"].as_array().unwrap().len(), 2);
        assert_eq!(seqs(&ledger.activity("p", 0, None, None)), [6]);
        assert_eq!(
            ledger.activity("nowhere", 10, None, None),
            json!({"calls": [], "sessions": []})
        );
    }

    #[test]
    fn the_ring_keeps_only_the_most_recent_records() {
        let ledger = Ledger::default();
        for _ in 0..RING + 5 {
            ledger.record(outcome("p", "s", "artifact_list", true));
        }
        let all = ledger.activity("p", MAX_ACTIVITY_LIMIT, None, None);
        assert_eq!(all["calls"].as_array().unwrap().len(), MAX_ACTIVITY_LIMIT);
        assert_eq!(all["calls"][MAX_ACTIVITY_LIMIT - 1]["seq"], RING as u64 + 5);
        let oldest = ledger.activity("p", 1, None, Some(7));
        assert_eq!(oldest["calls"][0]["seq"], 6);
        assert_eq!(ledger.activity("p", 1, None, Some(6))["calls"], json!([]));
    }

    #[test]
    fn history_survives_a_restart_and_the_sequence_continues() {
        let temp = project();
        let session = "0b0f9a54-7f0e-4a8e-9d4e-0d5b3d1f2a11";
        {
            let ledger = Ledger::default();
            ledger.attach_project("p", temp.path());
            ledger.begin_session("p", session, "claude-code", Some("haiku"), Profile::Compact);
            ledger.record(outcome("p", session, "project_summary", true));
            ledger.record(outcome("p", session, "artifact_read", false));
            ledger.end_session(session);
        }
        let file = temp
            .path()
            .join(".omenflow/work")
            .join(session)
            .join("calls.jsonl");
        let lines = fs::read_to_string(&file).unwrap();
        assert_eq!(lines.lines().count(), 2);
        let stored: Value = serde_json::from_str(lines.lines().next().unwrap()).unwrap();
        assert_eq!(stored["tool"], "project_summary");
        assert!(stored.get("arguments").is_none() && stored.get("input").is_none());

        let ledger = Ledger::default();
        ledger.attach_project("p", temp.path());
        let history = ledger.activity("p", 100, None, None);
        assert_eq!(history["calls"].as_array().unwrap().len(), 2);
        let summary = &history["sessions"][0];
        assert_eq!(summary["sessionId"], session);
        assert_eq!(summary["adapterId"], "claude-code");
        assert_eq!(summary["model"], "haiku");
        assert_eq!(
            (&summary["calls"], &summary["errors"]),
            (&json!(2), &json!(1))
        );
        assert!(summary["endedAt"].is_string());

        let next = "5b6b1c0e-9f4c-4a51-8a55-0c1e6f3a7d22";
        ledger.begin_session("p", next, "codex", None, Profile::Standard);
        let record = ledger.record(outcome("p", next, "work_status", true));
        assert_eq!(record.seq, 3, "the sequence continues after a restart");
        assert_eq!(
            ledger.activity("p", 100, None, None)["sessions"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn calls_recorded_before_the_folder_is_known_keep_their_numbers() {
        let temp = project();
        let old = "11111111-1111-4111-8111-111111111111";
        {
            let ledger = Ledger::default();
            ledger.attach_project("p", temp.path());
            ledger.begin_session("p", old, "codex", None, Profile::Full);
            for _ in 0..3 {
                ledger.record(outcome("p", old, "project_summary", true));
            }
        }
        let new = "22222222-2222-4222-8222-222222222222";
        let ledger = Ledger::default();
        ledger.begin_session("p", new, "codex", None, Profile::Full);
        let early = ledger.record(outcome("p", new, "artifact_list", true));
        assert_eq!(early.seq, 1);
        assert_eq!(ledger.project_root("p"), None);
        ledger.attach_project("p", temp.path());
        assert_eq!(ledger.project_root("p").as_deref(), Some(temp.path()));
        // The published record keeps its number; new ones continue above
        // everything on disk.
        assert_eq!(ledger.record(outcome("p", new, "work_status", true)).seq, 4);
        let seqs = ledger.activity("p", 100, None, None)["calls"]
            .as_array()
            .unwrap()
            .iter()
            .map(|call| call["seq"].as_u64().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(seqs, [1, 4]);
        let written = fs::read_to_string(
            temp.path()
                .join(".omenflow/work")
                .join(new)
                .join("calls.jsonl"),
        )
        .unwrap();
        assert_eq!(written.lines().count(), 2);
        assert_eq!(ledger.counters(new), (2, 0));
        let sessions = ledger.activity("p", 100, None, None)["sessions"].clone();
        assert_eq!(sessions.as_array().unwrap().len(), 2);
    }

    #[test]
    fn unsafe_session_ids_never_become_paths() {
        let temp = project();
        let ledger = Ledger::default();
        ledger.attach_project("p", temp.path());
        ledger.begin_session("p", "../escape", "custom", None, Profile::Compact);
        ledger.record(outcome("p", "../escape", "project_summary", true));
        assert!(!temp.path().join(".omenflow/escape").exists());
        assert!(!temp.path().join(".omenflow/work").exists());
        assert_eq!(ledger.counters("../escape"), (1, 0));
    }

    #[test]
    fn artifact_ids_come_from_named_keys_only() {
        let id = |n: u32| format!("00000000-0000-4000-8000-{n:012}");
        let input = json!({
            "artifactId": id(1),
            "pins": [{"componentArtifactId": id(2), "pin": "VCC"}, {"componentArtifactId": id(3)}],
            "edges": [{"upstreamArtifactId": id(4), "downstreamArtifactId": id(1)}],
            "artifactIds": [id(5), id(6)],
            "title": "not an id",
            "revisionId": id(9)
        });
        let result = json!({
            "artifact": {"id": id(7)},
            "revision": {"id": id(10), "artifactId": id(7)},
            "changes": [{"artifactId": id(8)}],
            "artifacts": [{"id": id(11)}]
        });
        assert_eq!(
            artifact_ids(&input, Some(&result)),
            [id(1), id(2), id(3), id(4), id(5), id(6), id(7), id(8)]
        );
        let many = json!({"artifactIds": (0..20).map(id).collect::<Vec<_>>()});
        assert_eq!(artifact_ids(&many, None).len(), ARTIFACT_IDS);
        assert!(artifact_ids(&json!({"artifactId": 7, "x": {"artifactId": ""}}), None).is_empty());
        // Whatever else sits under an id's key is an argument, not an id.
        assert!(artifact_ids(
            &json!({"artifactId": "my-secret-api-key-123", "sourceArtifactId": "Camera tray"}),
            None
        )
        .is_empty());
    }

    #[test]
    fn a_stored_message_never_quotes_what_the_call_sent() {
        let error = omenflow_contracts::ContractError::validation(
            "Invalid input: artifactId: expected string (uuid), received \"my-secret-api-key-123\"",
        )
        .with_details(json!({"issues": [{"path": "artifactId", "kind": "format",
            "message": "expected string (uuid), received \"my-secret-api-key-123\"",
            "expected": "string (uuid)", "received": "\"my-secret-api-key-123\""}]}));
        let stored = stored_message(&error);
        assert_eq!(stored, "Invalid input: artifactId: expected string (uuid)");
        let unit = omenflow_contracts::ContractError::new(
            "INVALID_UNITS",
            "Unknown unit 'hunter2' at payload.target.unit",
        )
        .with_details(json!({"issues": [{"path": "payload.target.unit", "received": "hunter2"}]}));
        assert!(!stored_message(&unit).contains("hunter2"));
        let plain = omenflow_contracts::ContractError::new("NOT_FOUND", "Proposal not found");
        assert_eq!(stored_message(&plain), "Proposal not found");
    }

    /// A project closed, moved and opened again keeps its id: what is
    /// recorded afterwards goes to the folder it is in now, and the folder it
    /// left is not made again.
    #[test]
    fn a_moved_project_keeps_its_history_where_it_is_now() {
        let parent = tempfile::tempdir().unwrap();
        let (before, after) = (parent.path().join("proj"), parent.path().join("proj-moved"));
        fs::create_dir_all(before.join(".omenflow")).unwrap();
        let first = "11111111-1111-4111-8111-111111111111";
        let ledger = Ledger::default();
        ledger.attach_project("p", &before);
        ledger.begin_session("p", first, "codex", None, Profile::Full);
        ledger.record(outcome("p", first, "project_summary", true));
        ledger.end_session(first);
        fs::rename(&before, &after).unwrap();

        // A write that comes before the ledger hears of the move is skipped.
        let second = "22222222-2222-4222-8222-222222222222";
        ledger.begin_session("p", second, "codex", None, Profile::Full);
        ledger.record(outcome("p", second, "artifact_list", true));
        assert!(!before.exists(), "the old folder was made again");

        ledger.attach_project("p", &after);
        ledger.record(outcome("p", second, "work_status", true));
        assert!(!before.exists());
        let calls = |session: &str| {
            fs::read_to_string(
                after
                    .join(".omenflow/work")
                    .join(session)
                    .join("calls.jsonl"),
            )
            .unwrap()
            .lines()
            .count()
        };
        assert_eq!(calls(first), 1);
        assert_eq!(calls(second), 2);
        assert!(after
            .join(".omenflow/work")
            .join(second)
            .join("session.json")
            .is_file());
        let activity = ledger.activity("p", 100, None, None);
        let seqs = activity["calls"]
            .as_array()
            .unwrap()
            .iter()
            .map(|call| call["seq"].as_u64().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(seqs, [1, 2, 3]);
        assert_eq!(activity["sessions"].as_array().unwrap().len(), 2);
        // After a restart the moved folder holds the whole history.
        let reloaded = Ledger::default();
        reloaded.attach_project("p", &after);
        assert_eq!(
            reloaded.activity("p", 100, None, None)["calls"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
    }

    #[test]
    fn long_messages_are_cut_to_one_line() {
        let long = "word ".repeat(200);
        let line = one_line(&long);
        assert_eq!(line.chars().count(), MESSAGE_CHARS);
        assert!(line.ends_with('…'));
        assert!(!line.contains('\n'));
    }
}
