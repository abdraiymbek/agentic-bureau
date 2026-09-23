use crate::{internal, models, now, require_artifact, require_revision, CoreResult};
use omenflow_contracts::ContractError;
use omenflow_storage::ProjectHandle;
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};
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
    outgoing: HashMap<String, Vec<usize>>,
    incoming: HashMap<String, Vec<usize>>,
}

impl GraphSnapshot {
    pub fn load(handle: &ProjectHandle, overrides: &[(String, Value)]) -> CoreResult<Self> {
        let mut graph = Self::default();
        let mut stmt = handle
            .db
            .prepare("SELECT * FROM artifact")
            .map_err(internal)?;
        for artifact in stmt
            .query_map([], models::artifact_from_row)
            .map_err(internal)?
        {
            let artifact = artifact.map_err(internal)?;
            graph
                .artifacts
                .insert(artifact["id"].as_str().unwrap().to_owned(), artifact);
        }
        let mut stmt = handle.db.prepare("SELECT r.* FROM artifact a JOIN revision r ON r.id=a.selected_revision_id AND r.artifact_id=a.id").map_err(internal)?;
        for revision in stmt
            .query_map([], models::revision_from_row)
            .map_err(internal)?
        {
            let revision = revision.map_err(internal)?;
            graph.selected.insert(
                revision["artifactId"].as_str().unwrap().to_owned(),
                revision,
            );
        }
        for (id, revision) in overrides {
            graph.selected.insert(id.clone(), revision.clone());
        }
        let selected = graph
            .selected
            .iter()
            .map(|(id, revision)| (id.clone(), revision.clone()))
            .collect::<Vec<_>>();
        for (id, revision) in selected {
            if let Some(artifact) = graph.artifacts.get(&id) {
                let artifact = artifact.clone();
                for (index, input) in revision["inputs"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .enumerate()
                {
                    graph.add_edge(input_edge(&artifact, &revision, input, index));
                }
            }
        }
        let mut stmt = handle
            .db
            .prepare("SELECT * FROM edge WHERE required_upstream_revision_id IS NULL")
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
            let mut by_cause = HashMap::<String, Value>::new();
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
                    by_cause.insert(upstream_id.to_owned(), json!({"artifactId": id, "upstreamArtifactId": upstream_id, "expectedRevisionId": input["revisionId"], "actualRevisionId": actual, "path": [upstream_id, id], "reason": reason, "sinceEventSeq": event_seq}));
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
            findings.insert(id.clone(), by_cause.into_values().collect());
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

fn input_edge(artifact: &Value, revision: &Value, input: &Value, index: usize) -> Value {
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

pub fn sync_selected_inputs(
    tx: &Transaction<'_>,
    artifact: &Value,
    revision: &Value,
) -> CoreResult<()> {
    let artifact_id = artifact["id"].as_str().unwrap();
    tx.execute("DELETE FROM edge WHERE downstream_artifact_id=?1 AND required_upstream_revision_id IS NOT NULL", [artifact_id]).map_err(internal)?;
    for (index, input) in revision["inputs"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let edge = input_edge(artifact, revision, input, index);
        tx.execute("INSERT INTO edge(id,upstream_artifact_id,downstream_artifact_id,relationship,required_upstream_revision_id,label,created_by,created_at) VALUES(?1,?2,?3,?4,?5,?6,'system',?7)", params![edge["id"].as_str(), edge["upstreamArtifactId"].as_str(), artifact_id, edge["relationship"].as_str(), edge["requiredUpstreamRevisionId"].as_str(), edge["label"].as_str(), artifact["createdAt"].as_str()]).map_err(internal)?;
    }
    Ok(())
}

pub fn propagate_from(
    handle: &ProjectHandle,
    changed_ids: &[String],
    event_seq: i64,
) -> CoreResult<Vec<Value>> {
    let graph = GraphSnapshot::load(handle, &[])?;
    let findings = graph.findings(event_seq)?;
    let mut affected = Vec::new();
    let mut ids = changed_ids.to_vec();
    ids.extend(graph.downstream(changed_ids));
    let tx = handle.db.unchecked_transaction().map_err(internal)?;
    for id in ids {
        let had_stale: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM stale WHERE artifact_id=?1",
                [&id],
                |r| r.get(0),
            )
            .map_err(internal)?;
        let current = findings.get(&id).cloned().unwrap_or_default();
        tx.execute("DELETE FROM stale WHERE artifact_id=?1", [&id])
            .map_err(internal)?;
        for record in &current {
            tx.execute("INSERT INTO stale(artifact_id,upstream_artifact_id,expected_revision_id,actual_revision_id,path,reason,since_event_seq) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![id, record["upstreamArtifactId"].as_str(), record["expectedRevisionId"].as_str(), record["actualRevisionId"].as_str(), record["path"].to_string(), record["reason"].as_str(), event_seq]).map_err(internal)?;
        }
        if let Some(first) = current.first() {
            affected.push(json!({"artifactId": id, "reason": if first["reason"] == "missing_input" { "missing input" } else { "input changed" }, "path": first["path"]}));
        } else if had_stale > 0 {
            affected.push(json!({"artifactId": id, "reason": "inputs restored", "path": [id]}));
        }
    }
    tx.commit().map_err(internal)?;
    Ok(affected)
}

pub fn propose_edges(handle: &ProjectHandle, input: &Value, origin: &str) -> CoreResult<Value> {
    let entries = input["edges"]
        .as_array()
        .ok_or_else(|| ContractError::validation("Missing edges"))?;
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
    let tx = handle.db.unchecked_transaction().map_err(internal)?;
    for edge in &added {
        tx.execute("INSERT INTO edge(id,upstream_artifact_id,downstream_artifact_id,relationship,required_upstream_revision_id,label,created_by,created_at) VALUES(?1,?2,?3,?4,NULL,?5,?6,?7)", params![edge["id"].as_str(), edge["upstreamArtifactId"].as_str(), edge["downstreamArtifactId"].as_str(), edge["relationship"].as_str(), edge["label"].as_str(), origin, edge["createdAt"].as_str()]).map_err(internal)?;
    }
    tx.commit().map_err(internal)?;
    Ok(json!({"edges": added}))
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
    let mut queue = VecDeque::from([(id.to_owned(), 0)]);
    let mut edges = HashMap::<String, Value>::new();
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
            let edge_id = edge["id"].as_str().unwrap_or("").to_owned();
            edges.insert(edge_id, edge.clone());
            let next = if edge["upstreamArtifactId"] == current {
                edge["downstreamArtifactId"].as_str()
            } else {
                edge["upstreamArtifactId"].as_str()
            };
            if let Some(next) = next {
                if !seen.contains_key(next) {
                    seen.insert(next.to_owned(), depth + 1);
                    queue.push_back((next.to_owned(), depth + 1));
                }
            }
        }
    }
    let mut artifacts = Vec::new();
    for (id, depth) in seen {
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
    Ok(json!({"artifacts": artifacts, "edges": edges.into_values().collect::<Vec<_>>()}))
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
