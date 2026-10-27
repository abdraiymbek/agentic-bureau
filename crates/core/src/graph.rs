use crate::{
    emit, internal, models, now, record_event, require_artifact, require_revision, txn, CoreResult,
    Origin,
};
use bureau_contracts::ContractError;
use bureau_storage::ProjectHandle;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};

fn evaluating(relationship: &str) -> bool {
    matches!(relationship, "depends_on" | "derived_from" | "validates")
}

#[derive(Default)]
pub struct GraphSnapshot {
    pub artifacts: HashMap<String, Value>,
    pub selected: HashMap<String, Value>,
    pub edges: Vec<Value>,
    /// Artifact ids in creation order, so everything derived from the
    /// snapshot comes out the same way on every call.
    order: Vec<String>,
    outgoing: HashMap<String, Vec<usize>>,
    incoming: HashMap<String, Vec<usize>>,
}

impl GraphSnapshot {
    pub fn load(handle: &ProjectHandle, overrides: &[(String, Value)]) -> CoreResult<Self> {
        let mut graph = Self::default();
        let mut stmt = handle
            .db
            .prepare("SELECT * FROM artifact ORDER BY created_at, rowid")
            .map_err(internal)?;
        for artifact in stmt
            .query_map([], models::artifact_from_row)
            .map_err(internal)?
        {
            let artifact = artifact.map_err(internal)?;
            let id = artifact["id"].as_str().unwrap_or_default().to_owned();
            graph.order.push(id.clone());
            graph.artifacts.insert(id, artifact);
        }
        let mut stmt = handle.db.prepare("SELECT r.* FROM artifact a JOIN revision r ON r.id=a.selected_revision_id AND r.artifact_id=a.id").map_err(internal)?;
        for revision in stmt
            .query_map([], models::revision_from_row)
            .map_err(internal)?
        {
            let revision = revision.map_err(internal)?;
            graph.selected.insert(
                revision["artifactId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                revision,
            );
        }
        for (id, revision) in overrides {
            graph.selected.insert(id.clone(), revision.clone());
        }
        let mut recorded = Vec::new();
        for id in &graph.order {
            if let (Some(artifact), Some(revision)) =
                (graph.artifacts.get(id), graph.selected.get(id))
            {
                for (index, input) in revision["inputs"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .enumerate()
                {
                    recorded.push(input_edge(artifact, revision, input, index));
                }
            }
        }
        for edge in recorded {
            graph.add_edge(edge);
        }
        let mut stmt = handle
            .db
            .prepare(
                "SELECT * FROM edge WHERE required_upstream_revision_id IS NULL ORDER BY created_at, id",
            )
            .map_err(internal)?;
        for edge in stmt
            .query_map([], models::edge_from_row)
            .map_err(internal)?
        {
            graph.add_edge(edge.map_err(internal)?);
        }
        Ok(graph)
    }

    fn add_edge(&mut self, edge: Value) {
        let index = self.edges.len();
        if let Some(id) = edge["upstreamArtifactId"].as_str() {
            self.outgoing.entry(id.to_owned()).or_default().push(index);
        }
        if let Some(id) = edge["downstreamArtifactId"].as_str() {
            self.incoming.entry(id.to_owned()).or_default().push(index);
        }
        self.edges.push(edge);
    }

    pub fn assert_no_cycles(&self) -> CoreResult<()> {
        let mut degrees: HashMap<&str, usize> =
            self.artifacts.keys().map(|id| (id.as_str(), 0)).collect();
        for edge in &self.edges {
            if evaluating(edge["relationship"].as_str().unwrap_or("")) {
                if let Some(id) = edge["downstreamArtifactId"].as_str() {
                    if self
                        .artifacts
                        .contains_key(edge["upstreamArtifactId"].as_str().unwrap_or(""))
                    {
                        if let Some(degree) = degrees.get_mut(id) {
                            *degree += 1;
                        }
                    }
                }
            }
        }
        let mut queue = degrees
            .iter()
            .filter(|(_, d)| **d == 0)
            .map(|(id, _)| *id)
            .collect::<VecDeque<_>>();
        let mut visited = 0;
        while let Some(id) = queue.pop_front() {
            visited += 1;
            for &edge_index in self.outgoing.get(id).into_iter().flatten() {
                let edge = &self.edges[edge_index];
                if !evaluating(edge["relationship"].as_str().unwrap_or("")) {
                    continue;
                }
                if let Some(next) = edge["downstreamArtifactId"].as_str() {
                    if let Some(degree) = degrees.get_mut(next) {
                        *degree -= 1;
                        if *degree == 0 {
                            queue.push_back(next);
                        }
                    }
                }
            }
        }
        if visited != self.artifacts.len() {
            return Err(ContractError::new(
                "CYCLE_DETECTED",
                "Revision inputs would create a dependency cycle",
            ));
        }
        Ok(())
    }

    pub fn downstream(&self, roots: &[String]) -> Vec<String> {
        let mut visited = roots.iter().cloned().collect::<HashSet<_>>();
        let mut queue = roots.iter().cloned().collect::<VecDeque<_>>();
        let mut result = Vec::new();
        while let Some(id) = queue.pop_front() {
            for &index in self.outgoing.get(&id).into_iter().flatten() {
                let edge = &self.edges[index];
                if !evaluating(edge["relationship"].as_str().unwrap_or("")) {
                    continue;
                }
                if let Some(next) = edge["downstreamArtifactId"].as_str() {
                    if visited.insert(next.to_owned()) {
                        result.push(next.to_owned());
                        queue.push_back(next.to_owned());
                    }
                }
            }
        }
        result
    }

    pub fn findings(&self, event_seq: i64) -> CoreResult<HashMap<String, Vec<Value>>> {
        self.assert_no_cycles()?;
        let mut degrees: HashMap<String, usize> =
            self.artifacts.keys().map(|id| (id.clone(), 0)).collect();
        for edge in &self.edges {
            if evaluating(edge["relationship"].as_str().unwrap_or("")) {
                if let Some(id) = edge["downstreamArtifactId"].as_str() {
                    if self
                        .artifacts
                        .contains_key(edge["upstreamArtifactId"].as_str().unwrap_or(""))
                    {
                        if let Some(degree) = degrees.get_mut(id) {
                            *degree += 1;
                        }
                    }
                }
            }
        }
        let mut queue = degrees
            .iter()
            .filter(|(_, d)| **d == 0)
            .map(|(id, _)| id.clone())
            .collect::<VecDeque<_>>();
        let mut findings = HashMap::<String, Vec<Value>>::new();
        while let Some(id) = queue.pop_front() {
            let artifact = &self.artifacts[&id];
            let revision = self.selected.get(&id);
            // Causes keep the order of the recorded inputs, so the reason shown
            // first is the same on every evaluation.
            let mut by_cause = Map::new();
            if !artifact["selectedRevisionId"].is_null() && revision.is_none() {
                by_cause.insert(id.clone(), json!({"artifactId": id, "upstreamArtifactId": id, "expectedRevisionId": artifact["selectedRevisionId"], "actualRevisionId": null, "path": [id], "reason": "missing_input", "sinceEventSeq": event_seq}));
            }
            for input in revision
                .and_then(|r| r["inputs"].as_array())
                .into_iter()
                .flatten()
            {
                if !evaluating(input["relationship"].as_str().unwrap_or("")) {
                    continue;
                }
                let Some(upstream_id) = input["artifactId"].as_str() else {
                    continue;
                };
                let upstream = self.artifacts.get(upstream_id);
                let actual = upstream.and_then(|a| a["selectedRevisionId"].as_str());
                let missing = upstream.is_none_or(|a| a["archived"] == true)
                    || actual.is_none()
                    || !self.selected.contains_key(upstream_id);
                if missing || Some(input["revisionId"].as_str().unwrap_or("")) != actual {
                    let reason = if missing {
                        "missing_input"
                    } else {
                        "input_changed"
                    };
                    // One upstream can be recorded at several revisions: the
                    // first outdated one stands unless a later one is missing.
                    if missing || !by_cause.contains_key(upstream_id) {
                        by_cause.insert(upstream_id.to_owned(), json!({"artifactId": id, "upstreamArtifactId": upstream_id, "expectedRevisionId": input["revisionId"], "actualRevisionId": actual, "path": [upstream_id, id], "reason": reason, "sinceEventSeq": event_seq}));
                    }
                }
                for cause in findings.get(upstream_id).into_iter().flatten() {
                    let cause_id = cause["upstreamArtifactId"].as_str().unwrap_or("");
                    if !by_cause.contains_key(cause_id) {
                        let mut inherited = cause.clone();
                        inherited["artifactId"] = json!(id);
                        if let Some(path) = inherited["path"].as_array_mut() {
                            path.push(json!(id));
                        }
                        by_cause.insert(cause_id.to_owned(), inherited);
                    }
                }
            }
            findings.insert(
                id.clone(),
                by_cause.into_iter().map(|(_, cause)| cause).collect(),
            );
            for &index in self.outgoing.get(&id).into_iter().flatten() {
                let edge = &self.edges[index];
                if !evaluating(edge["relationship"].as_str().unwrap_or("")) {
                    continue;
                }
                if let Some(next) = edge["downstreamArtifactId"].as_str() {
                    if let Some(degree) = degrees.get_mut(next) {
                        *degree -= 1;
                        if *degree == 0 {
                            queue.push_back(next.to_owned());
                        }
                    }
                }
            }
        }
        Ok(findings)
    }
}

pub(crate) fn input_edge(artifact: &Value, revision: &Value, input: &Value, index: usize) -> Value {
    let revision_id = revision["id"].as_str().unwrap_or("");
    let hash = format!(
        "{:x}",
        Sha256::digest(format!("{revision_id}:{index}").as_bytes())
    );
    let id = format!(
        "{}-{}-5{}-a{}-{}",
        &hash[..8],
        &hash[8..12],
        &hash[13..16],
        &hash[17..20],
        &hash[20..32]
    );
    json!({"id": id, "upstreamArtifactId": input["artifactId"], "downstreamArtifactId": artifact["id"], "relationship": input["relationship"], "requiredUpstreamRevisionId": input["revisionId"], "label": input["label"].as_str().unwrap_or(""), "createdBy": "system", "createdAt": artifact["createdAt"]})
}

pub fn validate_revision_inputs(
    handle: &ProjectHandle,
    artifact_id: &str,
    inputs: &[Value],
) -> CoreResult<()> {
    for input in inputs {
        let upstream_id = input["artifactId"]
            .as_str()
            .ok_or_else(|| ContractError::validation("Input artifact missing"))?;
        require_artifact(handle, upstream_id)?;
        let revision = require_revision(handle, input["revisionId"].as_str().unwrap_or(""))?;
        if revision["artifactId"] != upstream_id {
            return Err(ContractError::validation(
                "Input revision does not belong to its artifact",
            ));
        }
        if upstream_id == artifact_id && evaluating(input["relationship"].as_str().unwrap_or("")) {
            return Err(ContractError::new(
                "CYCLE_DETECTED",
                "An artifact cannot depend on itself",
            ));
        }
    }
    if handle
        .db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM artifact WHERE id=?1)",
            [artifact_id],
            |r| r.get::<_, i64>(0),
        )
        .map_err(internal)?
        == 0
    {
        return Ok(());
    }
    let graph = GraphSnapshot::load(
        handle,
        &[(
            artifact_id.to_owned(),
            json!({"id": "candidate", "artifactId": artifact_id, "inputs": inputs}),
        )],
    )?;
    graph.assert_no_cycles()
}

pub fn sync_selected_inputs(db: &Connection, artifact: &Value, revision: &Value) -> CoreResult<()> {
    let artifact_id = artifact["id"]
        .as_str()
        .ok_or_else(|| ContractError::new("INTERNAL", "Artifact row has no id"))?;
    db.execute("DELETE FROM edge WHERE downstream_artifact_id=?1 AND required_upstream_revision_id IS NOT NULL", [artifact_id]).map_err(internal)?;
    for (index, input) in revision["inputs"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let edge = input_edge(artifact, revision, input, index);
        db.execute("INSERT INTO edge(id,upstream_artifact_id,downstream_artifact_id,relationship,required_upstream_revision_id,label,created_by,created_at) VALUES(?1,?2,?3,?4,?5,?6,'system',?7)", params![edge["id"].as_str(), edge["upstreamArtifactId"].as_str(), artifact_id, edge["relationship"].as_str(), edge["requiredUpstreamRevisionId"].as_str(), edge["label"].as_str(), artifact["createdAt"].as_str()]).map_err(internal)?;
    }
    Ok(())
}

/// The stale rows recorded for one artifact, oldest first.
fn stale_rows(db: &Connection, artifact_id: &str) -> CoreResult<Vec<Value>> {
    let mut stmt = db
        .prepare(
            "SELECT upstream_artifact_id,expected_revision_id,actual_revision_id,path,reason,since_event_seq
             FROM stale WHERE artifact_id=?1 ORDER BY rowid",
        )
        .map_err(internal)?;
    let rows = stmt
        .query_map([artifact_id], |row| {
            Ok(json!({
                "upstreamArtifactId": row.get::<_, String>(0)?,
                "expectedRevisionId": row.get::<_, Option<String>>(1)?,
                "actualRevisionId": row.get::<_, Option<String>>(2)?,
                "path": serde_json::from_str::<Value>(&row.get::<_, String>(3)?).unwrap_or(json!([])),
                "reason": row.get::<_, String>(4)?,
                "sinceEventSeq": row.get::<_, i64>(5)?,
            }))
        })
        .map_err(internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    Ok(rows)
}

const CAUSE_FIELDS: [&str; 5] = [
    "upstreamArtifactId",
    "expectedRevisionId",
    "actualRevisionId",
    "path",
    "reason",
];

fn same_cause(recorded: &Value, current: &Value) -> bool {
    CAUSE_FIELDS
        .iter()
        .all(|field| recorded[*field] == current[*field])
}

/// An artifact has one row per upstream cause, so the two lists agree when
/// they are the same size and every recorded row has its match.
fn same_causes(recorded: &[Value], current: &[Value]) -> bool {
    recorded.len() == current.len()
        && recorded
            .iter()
            .all(|row| current.iter().any(|cause| same_cause(row, cause)))
}

/// Makes the stale rows of one artifact say what `current` found. Rows that
/// already say it are left alone, and a cause that persists keeps the event it
/// was first recorded at; only a new cause is dated `event_seq`.
fn store_findings(
    db: &Connection,
    artifact_id: &str,
    recorded: &[Value],
    current: &[Value],
    event_seq: i64,
) -> CoreResult<()> {
    if same_causes(recorded, current) {
        return Ok(());
    }
    db.execute("DELETE FROM stale WHERE artifact_id=?1", [artifact_id])
        .map_err(internal)?;
    for cause in current {
        let since = recorded
            .iter()
            .find(|prior| same_cause(prior, cause))
            .and_then(|prior| prior["sinceEventSeq"].as_i64())
            .unwrap_or(event_seq);
        db.execute("INSERT INTO stale(artifact_id,upstream_artifact_id,expected_revision_id,actual_revision_id,path,reason,since_event_seq) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![artifact_id, cause["upstreamArtifactId"].as_str(), cause["expectedRevisionId"].as_str(), cause["actualRevisionId"].as_str(), cause["path"].to_string(), cause["reason"].as_str(), since]).map_err(internal)?;
    }
    Ok(())
}

fn affected_entry(id: &str, current: &[Value], had_stale: bool, path: &[String]) -> Option<Value> {
    if let Some(first) = current.first() {
        Some(
            json!({"artifactId": id, "reason": if first["reason"] == "missing_input" { "missing input" } else { "input changed" }, "path": first["path"]}),
        )
    } else if had_stale {
        Some(json!({"artifactId": id, "reason": "inputs restored", "path": path}))
    } else {
        None
    }
}

/// Re-evaluates freshness for the changed artifacts and everything downstream
/// of them, and returns what is now out of date or restored. It writes inside
/// the caller's transaction when there is one, so a baseline never moves
/// without the stale records that follow from it.
pub fn propagate_from(
    handle: &ProjectHandle,
    changed_ids: &[String],
    event_seq: i64,
) -> CoreResult<Vec<Value>> {
    txn::atomically(handle, || {
        let graph = GraphSnapshot::load(handle, &[])?;
        let findings = graph.findings(event_seq)?;
        let mut affected = Vec::new();
        let mut visited = changed_ids.iter().cloned().collect::<HashSet<_>>();
        let mut queue = changed_ids
            .iter()
            .map(|id| (id.clone(), vec![id.clone()]))
            .collect::<VecDeque<_>>();
        while let Some((id, path)) = queue.pop_front() {
            let recorded = stale_rows(&handle.db, &id)?;
            let current = findings.get(&id).map(Vec::as_slice).unwrap_or(&[]);
            store_findings(&handle.db, &id, &recorded, current, event_seq)?;
            affected.extend(affected_entry(&id, current, !recorded.is_empty(), &path));
            for &index in graph.outgoing.get(&id).into_iter().flatten() {
                let edge = &graph.edges[index];
                if !evaluating(edge["relationship"].as_str().unwrap_or("")) {
                    continue;
                }
                if let Some(next) = edge["downstreamArtifactId"].as_str() {
                    if visited.insert(next.to_owned()) {
                        let mut next_path = path.clone();
                        next_path.push(next.to_owned());
                        queue.push_back((next.to_owned(), next_path));
                    }
                }
            }
        }
        Ok(affected)
    })
}

/// Repairs stale records that no longer match the baselines: the state a
/// crash between a baseline change and its propagation, or a build that
/// propagated outside the transaction, leaves behind. Nothing is written when
/// the records are already right. Returns the artifacts whose freshness was
/// corrected, and records them in one `impact.propagated` event.
pub fn reconcile(handle: &ProjectHandle) -> CoreResult<Vec<Value>> {
    txn::atomically(handle, || {
        let graph = GraphSnapshot::load(handle, &[])?;
        let findings = graph.findings(0)?;
        let mut repairs = Vec::new();
        for id in &graph.order {
            let recorded = stale_rows(&handle.db, id)?;
            let current = findings.get(id).cloned().unwrap_or_default();
            if !same_causes(&recorded, &current) {
                repairs.push((id.clone(), recorded, current));
            }
        }
        if repairs.is_empty() {
            return Ok(Vec::new());
        }
        let affected = repairs
            .iter()
            .filter_map(|(id, recorded, current)| {
                affected_entry(id, current, !recorded.is_empty(), std::slice::from_ref(id))
            })
            .collect::<Vec<_>>();
        let seq = emit(
            handle,
            "impact.propagated",
            &Origin::System,
            json!({"changed": [], "affected": affected, "reconciled": true}),
        )?;
        for (id, recorded, current) in &repairs {
            store_findings(&handle.db, id, recorded, current, seq)?;
        }
        Ok(affected)
    })
}

/// Adds manual links between artifacts. They take effect without review, so
/// each batch is recorded with who added it: the edge rows carry the origin
/// and the `graph.changed` event the agent session. `remove_edges` undoes
/// them.
pub fn propose_edges(handle: &ProjectHandle, input: &Value, origin: &str) -> CoreResult<Value> {
    let entries = input["edges"]
        .as_array()
        .ok_or_else(|| ContractError::validation("Missing edges"))?;
    txn::atomically(handle, || {
        let mut graph = GraphSnapshot::load(handle, &[])?;
        let mut added = Vec::new();
        for entry in entries {
            let up = entry["upstreamArtifactId"]
                .as_str()
                .ok_or_else(|| ContractError::validation("Missing upstreamArtifactId"))?;
            let down = entry["downstreamArtifactId"]
                .as_str()
                .ok_or_else(|| ContractError::validation("Missing downstreamArtifactId"))?;
            require_artifact(handle, up)?;
            require_artifact(handle, down)?;
            if up == down {
                return Err(ContractError::validation("Self-edge not allowed"));
            }
            let edge = json!({"id": uuid::Uuid::new_v4().to_string(), "upstreamArtifactId": up, "downstreamArtifactId": down, "relationship": entry["relationship"], "requiredUpstreamRevisionId": null, "label": entry["label"].as_str().unwrap_or(""), "createdBy": origin, "createdAt": now()});
            graph.add_edge(edge.clone());
            added.push(edge);
        }
        graph.assert_no_cycles()?;
        for edge in &added {
            handle.db.execute("INSERT INTO edge(id,upstream_artifact_id,downstream_artifact_id,relationship,required_upstream_revision_id,label,created_by,created_at) VALUES(?1,?2,?3,?4,NULL,?5,?6,?7)", params![edge["id"].as_str(), edge["upstreamArtifactId"].as_str(), edge["downstreamArtifactId"].as_str(), edge["relationship"].as_str(), edge["label"].as_str(), origin, edge["createdAt"].as_str()]).map_err(internal)?;
        }
        record_event(
            &handle.db,
            "graph.changed",
            origin,
            None,
            json!({"added": added, "removed": []}),
        )?;
        let ids = added
            .iter()
            .map(|edge| edge["id"].clone())
            .collect::<Vec<_>>();
        Ok(json!({"edges": added, "undo": {
            "tool": "graph_remove_edges",
            "args": {"edgeIds": ids},
            "why": "Removes these links again. It is not a listed tool: call it through tool_call.",
        }}))
    })
}

/// Removes manual links. A link derived from a revision's recorded inputs is
/// part of that revision and is not removed here; an agent removes only links
/// an agent added, so it cannot quietly undo what a person recorded.
pub fn remove_edges(handle: &ProjectHandle, input: &Value, origin: &str) -> CoreResult<Value> {
    let ids = input["edgeIds"]
        .as_array()
        .ok_or_else(|| ContractError::validation("Missing edgeIds"))?;
    txn::atomically(handle, || {
        let mut removed = Vec::new();
        for id in ids.iter().filter_map(Value::as_str) {
            let edge = handle
                .db
                .query_row(
                    "SELECT * FROM edge WHERE id=?1",
                    [id],
                    models::edge_from_row,
                )
                .optional()
                .map_err(internal)?
                .ok_or_else(|| ContractError::not_found("edge", id, "graph_list"))?;
            if !edge["requiredUpstreamRevisionId"].is_null() {
                return Err(ContractError::validation(format!(
                    "Edge {id} comes from an artifact's recorded inputs and cannot be removed on its own"
                ))
                .with_repair(
                    "Save a draft of the downstream artifact with the inputs it should have (artifact_update_draft); the link follows the approved inputs.",
                ));
            }
            if origin == "agent" && edge["createdBy"] != "agent" {
                return Err(ContractError::capability_denied(
                    "graph.remove_edges",
                    format!("Edge {id} was added by a person. Ask them to remove it."),
                ));
            }
            handle
                .db
                .execute("DELETE FROM edge WHERE id=?1", [id])
                .map_err(internal)?;
            removed.push(edge);
        }
        record_event(
            &handle.db,
            "graph.changed",
            origin,
            None,
            json!({"added": [], "removed": removed}),
        )?;
        Ok(json!({"removed": removed}))
    })
}

pub fn neighbors(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    let id = input["artifactId"]
        .as_str()
        .ok_or_else(|| ContractError::validation("Missing artifactId"))?;
    let graph = GraphSnapshot::load(handle, &[])?;
    let direction = input["direction"].as_str().unwrap_or("both");
    let max_depth = input["depth"].as_u64().unwrap_or(1) as usize;
    let relationship = input["relationship"].as_str();
    let mut seen = HashMap::<String, usize>::from([(id.to_owned(), 0)]);
    let mut reached = vec![id.to_owned()];
    let mut queue = VecDeque::from([(id.to_owned(), 0)]);
    let mut edge_ids = HashSet::new();
    let mut edges = Vec::new();
    while let Some((current, depth)) = queue.pop_front() {
        if depth >= max_depth {
            continue;
        }
        let mut indices = Vec::new();
        if direction != "upstream" {
            indices.extend(graph.outgoing.get(&current).into_iter().flatten().copied());
        }
        if direction != "downstream" {
            indices.extend(graph.incoming.get(&current).into_iter().flatten().copied());
        }
        for index in indices {
            let edge = &graph.edges[index];
            if relationship.is_some_and(|r| edge["relationship"] != r) {
                continue;
            }
            if edge_ids.insert(edge["id"].as_str().unwrap_or("").to_owned()) {
                edges.push(edge.clone());
            }
            let next = if edge["upstreamArtifactId"] == current {
                edge["downstreamArtifactId"].as_str()
            } else {
                edge["upstreamArtifactId"].as_str()
            };
            if let Some(next) = next {
                if !seen.contains_key(next) {
                    seen.insert(next.to_owned(), depth + 1);
                    reached.push(next.to_owned());
                    queue.push_back((next.to_owned(), depth + 1));
                }
            }
        }
    }
    let mut artifacts = Vec::new();
    for id in reached {
        let depth = seen[&id];
        if let Some(artifact) = graph.artifacts.get(&id) {
            let stale: Option<String> = handle
                .db
                .query_row(
                    "SELECT reason FROM stale WHERE artifact_id=?1 LIMIT 1",
                    [&id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(internal)?;
            let freshness = match stale.as_deref() {
                Some("missing_input") => "missing_input",
                Some(_) => "stale",
                None => "current",
            };
            artifacts.push(json!({"id": id, "title": artifact["title"], "type": artifact["type"], "depth": depth, "freshness": freshness}));
        }
    }
    Ok(json!({"artifacts": artifacts, "edges": edges}))
}

pub fn impact(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    let refs = input["refs"]
        .as_array()
        .ok_or_else(|| ContractError::validation("Missing refs"))?;
    let graph = GraphSnapshot::load(handle, &[])?;
    let roots = refs
        .iter()
        .filter_map(|r| r["artifactId"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    let mut visited = roots.iter().cloned().collect::<HashSet<_>>();
    let mut queue = roots.iter().cloned().collect::<VecDeque<_>>();
    let mut parent = HashMap::<String, String>::new();
    let mut traversed = Vec::new();
    while let Some(id) = queue.pop_front() {
        for &index in graph.outgoing.get(&id).into_iter().flatten() {
            let edge = &graph.edges[index];
            if !evaluating(edge["relationship"].as_str().unwrap_or("")) {
                continue;
            }
            if let Some(next) = edge["downstreamArtifactId"].as_str() {
                if visited.insert(next.to_owned()) {
                    parent.insert(next.to_owned(), id.clone());
                    traversed.push(edge.clone());
                    queue.push_back(next.to_owned());
                }
            }
        }
    }
    let offset = input["offset"].as_u64().unwrap_or(0) as usize;
    let limit = input["limit"].as_u64().unwrap_or(200) as usize;
    let mut affected = Vec::new();
    for edge in traversed.iter().skip(offset).take(limit) {
        let id = edge["downstreamArtifactId"].as_str().unwrap_or("");
        let artifact = graph.artifacts.get(id);
        let mut path = vec![id.to_owned()];
        if input["includePaths"].as_bool().unwrap_or(true) {
            let mut current = id;
            while let Some(previous) = parent.get(current) {
                path.push(previous.clone());
                current = previous;
            }
            path.reverse();
            if path.len() > 32 {
                path = path[..16]
                    .iter()
                    .chain(path[path.len() - 16..].iter())
                    .cloned()
                    .collect();
            }
        }
        affected.push(json!({"artifactId": id, "title": artifact.map(|a| a["title"].clone()).unwrap_or(json!(id)), "type": artifact.map(|a| a["type"].clone()).unwrap_or(json!("note")), "reason": if edge["requiredUpstreamRevisionId"].is_null() { "upstream input changed" } else { "recorded input revision changed" }, "path": path}));
    }
    let has_more = offset + affected.len() < traversed.len();
    Ok(
        json!({"changedRefs": refs, "affected": affected, "unaffectedSelectedComponentIds": [], "totalAffected": traversed.len(), "hasMore": has_more, "offset": offset}),
    )
}
