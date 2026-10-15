//! Disposable projects for core tests, driven through `CoreApp::dispatch` exactly as
//! the interface and the agent bridge drive them, so every input passes the same
//! contract validation as in the application.
use super::*;

pub(crate) struct TestProject {
    pub app: CoreApp,
    pub id: String,
    _directory: tempfile::TempDir,
}

impl TestProject {
    pub fn new() -> Self {
        Self::with_intent("Carry a camera across rough ground")
    }

    pub fn with_intent(intent: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let mut app = CoreApp::new(directory.path().join("appdata")).unwrap();
        let created = app
            .dispatch(
                "project.create",
                json!({"name": "Rover", "path": directory.path().join("project"), "intent": intent}),
                Origin::User,
                None,
            )
            .unwrap();
        Self {
            id: created["projectId"].as_str().unwrap().to_owned(),
            app,
            _directory: directory,
        }
    }

    pub fn handle(&self) -> &ProjectHandle {
        &self.app.projects[&self.id]
    }

    pub fn call(&mut self, origin: Origin, op: &str, input: Value) -> CoreResult<Value> {
        self.app.dispatch(op, input, origin, Some(&self.id))
    }

    pub fn user(&mut self, op: &str, input: Value) -> Value {
        self.call(Origin::User, op, input)
            .unwrap_or_else(|error| panic!("{op} failed: {error:?}"))
    }

    pub fn agent(&mut self, session: &str, op: &str, input: Value) -> Value {
        self.call(agent(session), op, input)
            .unwrap_or_else(|error| panic!("{op} failed: {error:?}"))
    }

    /// Create a draft artifact and return `(artifact id, revision id)`.
    pub fn draft(
        &mut self,
        origin: Origin,
        kind: &str,
        title: &str,
        payload: Value,
        inputs: Value,
    ) -> (String, String) {
        let created = self
            .call(
                origin,
                "artifact.create_draft",
                json!({"type": kind, "title": title, "payload": payload, "inputs": inputs}),
            )
            .unwrap_or_else(|error| panic!("draft {title} failed: {error:?}"));
        ids(&created)
    }

    /// Save a further draft of an existing artifact and return its revision id.
    pub fn redraft(&mut self, origin: Origin, artifact_id: &str, changes: Value) -> String {
        let mut input = changes;
        input["artifactId"] = json!(artifact_id);
        let updated = self
            .call(origin, "artifact.update_draft", input)
            .unwrap_or_else(|error| panic!("update of {artifact_id} failed: {error:?}"));
        ids(&updated).1
    }

    /// The human accepts a draft as the baseline.
    pub fn accept(&mut self, artifact_id: &str, revision_id: &str) {
        self.user(
            "artifact.accept_draft",
            json!({"artifactId": artifact_id, "draftRevisionId": revision_id}),
        );
    }

    /// Create an artifact and accept it; returns `(artifact id, revision id)`.
    pub fn approved(
        &mut self,
        kind: &str,
        title: &str,
        payload: Value,
        inputs: Value,
    ) -> (String, String) {
        let (artifact_id, revision_id) = self.draft(Origin::User, kind, title, payload, inputs);
        self.accept(&artifact_id, &revision_id);
        (artifact_id, revision_id)
    }
}

pub(crate) fn agent(session: &str) -> Origin {
    Origin::Agent {
        session_id: session.to_owned(),
    }
}

fn ids(written: &Value) -> (String, String) {
    (
        written["artifact"]["id"].as_str().unwrap().to_owned(),
        written["revision"]["id"].as_str().unwrap().to_owned(),
    )
}

pub(crate) fn requirement(statement: &str) -> Value {
    json!({"statement": statement, "acceptanceCriterion": "Shown by test", "priority": "must"})
}

/// Insert `count` artifacts straight into storage and return their ids in
/// listing order. Each has four revisions with a payload; two in three have an
/// approved baseline, every tenth a pending proposal and a stale marker.
/// Neighbours share a creation time, so listing order has to fall back to the
/// order they were created in.
pub(crate) fn seed(handle: &ProjectHandle, count: usize) -> Vec<String> {
    let tx = handle.db.unchecked_transaction().unwrap();
    let mut created = Vec::new();
    for index in 0..count {
        let id = uuid::Uuid::new_v4().to_string();
        let second = index / 2;
        let at = format!("2026-01-01T00:{:02}:{:02}.000Z", second / 60, second % 60);
        let kind = ["requirement", "component", "note", "calculation"][index % 4];
        tx.execute(
            "INSERT INTO artifact(id,type,title,subsystem,selected_revision_id,archived,created_at) \
             VALUES(?1,?2,?3,NULL,NULL,0,?4)",
            params![id, kind, format!("Seeded {index}"), at],
        )
        .unwrap();
        for seq in 1..=4 {
            let revision = uuid::Uuid::new_v4().to_string();
            let approved = seq == 1 && index % 3 != 0;
            tx.execute(
                "INSERT INTO revision(id,artifact_id,parent_id,seq,origin,origin_detail,created_at,\
                 payload,content_hash,files,inputs,rationale,review_state) \
                 VALUES(?1,?2,NULL,?3,'agent','seed',?4,?5,'seed','[]','[]','',?6)",
                params![
                    revision,
                    id,
                    seq,
                    at,
                    json!({"markdown": "word ".repeat(120), "seq": seq}).to_string(),
                    if approved { "approved" } else { "draft" }
                ],
            )
            .unwrap();
            if approved {
                tx.execute(
                    "UPDATE artifact SET selected_revision_id=?1 WHERE id=?2",
                    params![revision, id],
                )
                .unwrap();
            }
        }
        if index % 10 == 0 {
            tx.execute(
                "INSERT INTO proposal(id,changes,reason,impact,state,created_by,created_at) \
                 VALUES(?1,?2,'seeded',NULL,'pending','agent',?3)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    json!([{"artifactId": id}]).to_string(),
                    at
                ],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO stale(artifact_id,upstream_artifact_id,reason,since_event_seq) \
                 VALUES(?1,'upstream','input_changed',1)",
                params![id],
            )
            .unwrap();
        }
        created.push(id);
    }
    tx.commit().unwrap();
    // Creation order: by time, and in the order created within the same time.
    created
}

/// A project for the engineering tests with one fixed agent session.
pub(crate) struct Bench {
    _temp: tempfile::TempDir,
    pub(crate) app: CoreApp,
    pub(crate) project: String,
    session: String,
}

impl Bench {
    pub(crate) fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let mut app = CoreApp::new(temp.path().join("app")).unwrap();
        let created = app
            .dispatch(
                "project.create",
                json!({"path": temp.path().join("project"), "name": "Bench", "intent": "test"}),
                Origin::User,
                None,
            )
            .unwrap();
        Self {
            project: created["projectId"].as_str().unwrap().to_owned(),
            session: uuid::Uuid::new_v4().to_string(),
            app,
            _temp: temp,
        }
    }

    pub(crate) fn user(&mut self, op: &str, payload: Value) -> CoreResult<Value> {
        self.app
            .dispatch(op, payload, Origin::User, Some(&self.project))
    }

    pub(crate) fn agent(&mut self, op: &str, payload: Value) -> CoreResult<Value> {
        let origin = Origin::Agent {
            session_id: self.session.clone(),
        };
        self.app.dispatch(op, payload, origin, Some(&self.project))
    }

    pub(crate) fn root(&self) -> PathBuf {
        self.app.project_root(&self.project).unwrap()
    }

    /// Events of one type, oldest first.
    pub(crate) fn events(&self, event_type: &str) -> Vec<Value> {
        self.app
            .events_since(&self.project, 0)
            .unwrap()
            .into_iter()
            .filter(|event| event["type"] == event_type)
            .collect()
    }

    pub(crate) fn read(&mut self, artifact_id: &str) -> Value {
        self.user("artifact.read", json!({"artifactId": artifact_id}))
            .unwrap()
    }

    /// The human accepts a draft as the approved revision.
    pub(crate) fn accept(&mut self, draft: &Value) -> Value {
        self.user(
            "artifact.accept_draft",
            json!({"artifactId": draft["artifact"]["id"], "draftRevisionId": draft["revision"]["id"]}),
        )
        .unwrap()
    }

    /// The human approves a pending proposal.
    pub(crate) fn approve(&mut self, proposal: &Value) -> Value {
        self.user(
            "proposal.approve",
            json!({"proposalId": proposal["id"], "rationale": "reviewed"}),
        )
        .unwrap()
    }

    /// An agent records a component candidate observed on a product page.
    /// `mass` is a quantity or an explicit unknown; `price` an amount in USD.
    pub(crate) fn component(&mut self, title: &str, mass: Value, price: Option<&str>) -> Value {
        let slug = title
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() {
                    c.to_ascii_lowercase()
                } else {
                    '-'
                }
            })
            .collect::<String>();
        let mut input = json!({
            "title": title, "manufacturer": "Acme", "partNumber": slug,
            "properties": {"mass": {"quantity": mass}},
            "offer": {"seller": "Acme Shop", "url": format!("https://shop.example.test/{slug}")},
        });
        if let Some(amount) = price {
            input["offer"]["price"] = json!({"amount": amount, "currency": "USD"});
        }
        self.agent("component.add_candidate", input).unwrap()
    }
}
