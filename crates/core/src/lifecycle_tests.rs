//! Behaviour of revisions, proposals, staleness, events and idempotent replay
//! as a caller of `CoreApp` sees it.

use super::*;
use crate::cad::testing::engine_available;
use std::sync::Mutex;

const SESSION: &str = "session-a";

struct Fixture {
    temp: tempfile::TempDir,
    app: CoreApp,
    project_id: String,
}

fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let mut app = CoreApp::new(temp.path().join("appdata")).unwrap();
    let created = app
        .dispatch(
            "project.create",
            json!({"name": "Lifecycle", "path": temp.path().join("project"), "intent": "test"}),
            Origin::User,
            None,
        )
        .unwrap();
    Fixture {
        project_id: created["projectId"].as_str().unwrap().to_owned(),
        app,
        temp,
    }
}

fn agent() -> Origin {
    Origin::Agent {
        session_id: SESSION.into(),
    }
}

fn text(value: &Value) -> String {
    value
        .as_str()
        .unwrap_or_else(|| panic!("expected a string, got {value}"))
        .to_owned()
}

impl Fixture {
    fn call(&mut self, origin: Origin, op: &str, payload: Value) -> CoreResult<Value> {
        self.app
            .dispatch(op, payload, origin, Some(&self.project_id))
    }

    fn user(&mut self, op: &str, payload: Value) -> Value {
        self.call(Origin::User, op, payload)
            .unwrap_or_else(|error| panic!("{op} as user: {error:?}"))
    }

    fn agent(&mut self, op: &str, payload: Value) -> Value {
        self.call(agent(), op, payload)
            .unwrap_or_else(|error| panic!("{op} as agent: {error:?}"))
    }

    fn handle(&self) -> &ProjectHandle {
        &self.app.projects[&self.project_id]
    }

    fn root(&self) -> PathBuf {
        self.handle().root.clone()
    }

    /// Closes the application and opens the project again in a new one.
    fn reopen(&mut self) -> Value {
        let root = self.root();
        self.app = CoreApp::new(self.temp.path().join("appdata")).unwrap();
        self.app
            .dispatch("project.open", json!({"path": root}), Origin::User, None)
            .unwrap()
    }

    fn undelivered(&mut self) -> Vec<Value> {
        self.app.events_since(&self.project_id, 0).unwrap()
    }

    /// An agent's first draft of a note.
    fn draft_note(&mut self, title: &str, markdown: &str) -> (String, String) {
        let draft = self.agent(
            "artifact.create_draft",
            json!({"type": "note", "title": title, "payload": {"markdown": markdown}}),
        );
        (
            text(&draft["artifact"]["id"]),
            text(&draft["revision"]["id"]),
        )
    }

    /// A note with an approved baseline.
    fn baseline_note(&mut self, title: &str, markdown: &str) -> (String, String) {
        let (artifact, revision) = self.draft_note(title, markdown);
        self.accept(&artifact, &revision);
        (artifact, revision)
    }

    fn accept(&mut self, artifact: &str, revision: &str) {
        self.user(
            "artifact.accept_draft",
            json!({"artifactId": artifact, "draftRevisionId": revision}),
        );
    }

    /// A new agent draft with the artifact's default parent.
    fn revise(&mut self, artifact: &str, markdown: &str) -> String {
        let draft = self.agent(
            "artifact.update_draft",
            json!({"artifactId": artifact, "payload": {"markdown": markdown}}),
        );
        text(&draft["revision"]["id"])
    }

    /// A direct human edit of the baseline; returns the new baseline revision.
    fn edit(&mut self, artifact: &str, base: &str, markdown: &str) -> String {
        let edited = self.user(
            "artifact.apply_edit",
            json!({"artifactId": artifact, "baseRevisionId": base, "payload": {"markdown": markdown}, "rationale": "direct edit"}),
        );
        text(&edited["revision"]["id"])
    }

    fn submit(&mut self, changes: Value, reason: &str) -> Value {
        self.agent(
            "proposal.submit",
            json!({"changes": changes, "reason": reason}),
        )
    }

    fn proposal(&mut self, id: &str) -> Value {
        self.user("proposal.read", json!({"proposalId": id}))
    }

    fn selected(&mut self, artifact: &str) -> Value {
        self.user("artifact.read", json!({"artifactId": artifact}))["view"]["artifact"]
            ["selectedRevisionId"]
            .clone()
    }

    fn review_state(&mut self, artifact: &str, revision: &str) -> String {
        let history = self.user("artifact.history", json!({"artifactId": artifact}));
        let found = history["revisions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|candidate| candidate["id"] == revision)
            .unwrap_or_else(|| panic!("revision {revision} not in history"));
        text(&found["reviewState"])
    }

    fn freshness(&mut self, artifact: &str) -> Value {
        self.user("artifact.read", json!({"artifactId": artifact}))["view"].clone()
    }

    /// Every event recorded so far, oldest first.
    fn events(&mut self) -> Vec<Value> {
        self.user("project.changes_since", json!({"seq": 0}))["events"]
            .as_array()
            .unwrap()
            .clone()
    }

    fn events_of(&mut self, event_type: &str) -> Vec<Value> {
        self.events()
            .into_iter()
            .filter(|event| event["type"] == event_type)
            .collect()
    }

    fn count(&self, sql: &str) -> i64 {
        self.handle()
            .db
            .query_row(sql, [], |row| row.get(0))
            .unwrap()
    }

    /// Makes every later statement matching `table` fail, as a disk or
    /// constraint error in the middle of a mutation would.
    fn fail_inserts_into(&self, table: &str) {
        self.handle()
            .db
            .execute_batch(&format!(
                "CREATE TEMP TRIGGER injected_{table} BEFORE INSERT ON main.{table}
                 BEGIN SELECT RAISE(ABORT, 'injected failure'); END;"
            ))
            .unwrap();
    }

    fn stop_failing(&self, table: &str) {
        self.handle()
            .db
            .execute_batch(&format!("DROP TRIGGER injected_{table};"))
            .unwrap();
    }
}

fn change(artifact: &str, revision: &str, base: Option<&str>) -> Value {
    json!({
        "artifactId": artifact,
        "newRevisionId": revision,
        "baseRevisionId": base,
        "kind": if base.is_some() { "baseline_update" } else { "new_artifact" },
    })
}

fn id_of(value: &Value) -> String {
    text(&value["id"])
}

// 1. Approval never overwrites a newer baseline.

#[test]
fn approval_refuses_a_change_prepared_against_an_older_baseline() {
    let mut f = fixture();
    let (plate, r1) = f.baseline_note("Plate", "v1");
    let draft = f.revise(&plate, "agent change");
    let proposal = id_of(&f.submit(json!([change(&plate, &draft, Some(&r1))]), "agent change"));
    assert_eq!(f.proposal(&proposal)["changes"][0]["baseMoved"], false);

    let r2 = f.edit(&plate, &r1, "human change");

    let read = f.proposal(&proposal);
    assert_eq!(read["changes"][0]["baseMoved"], true);
    assert_eq!(read["proposal"]["changes"][0]["baseMoved"], true);
    assert_eq!(read["changes"][0]["artifact"]["selectedRevisionId"], r2);
    let listed = f.user("proposal.list", json!({"state": "pending"}));
    assert_eq!(listed["proposals"][0]["changes"][0]["baseMoved"], true);

    let error = f
        .call(
            Origin::User,
            "proposal.approve",
            json!({"proposalId": proposal, "rationale": "looks fine"}),
        )
        .unwrap_err();
    assert_eq!(error.code, "REVISION_CONFLICT");
    assert_eq!(error.message, "Proposal base is stale");
    assert!(error.repair.as_deref().unwrap().contains(&r2), "{error:?}");
    let details = error.details.unwrap();
    assert_eq!(details["currentRevisionId"], r2);
    assert_eq!(details["proposalId"], proposal);
    assert_eq!(details["baseRevisionId"], r1);

    assert_eq!(f.selected(&plate), r2);
    assert_eq!(f.review_state(&plate, &r2), "approved");
    assert_eq!(f.review_state(&plate, &draft), "proposed");
    assert_eq!(f.proposal(&proposal)["proposal"]["state"], "pending");
    assert_eq!(f.events_of("baseline.changed").len(), 2);

    let rejected = f.user("proposal.reject", json!({"proposalId": proposal}));
    assert_eq!(rejected["state"], "rejected");
    assert_eq!(f.review_state(&plate, &draft), "rejected");
    assert_eq!(f.proposal(&proposal)["changes"][0]["baseMoved"], false);
}

#[test]
fn a_draft_continued_from_an_older_baseline_can_be_neither_proposed_nor_accepted() {
    let mut f = fixture();
    let (plate, r1) = f.baseline_note("Plate", "v1");
    let stale = f.revise(&plate, "agent v1");
    let r2 = f.edit(&plate, &r1, "human change");
    assert_eq!(f.review_state(&plate, &stale), "superseded");

    // Continuing from the old draft skips the base check of update_draft.
    let continued = text(
        &f.agent(
            "artifact.update_draft",
            json!({"artifactId": plate, "draftRevisionId": stale, "payload": {"markdown": "agent v2"}}),
        )["revision"]["id"],
    );
    // Naming the current baseline as the base does not make the draft include it.
    let error = f
        .call(
            agent(),
            "proposal.submit",
            json!({"changes": [change(&plate, &continued, Some(&r2))], "reason": "agent v2"}),
        )
        .unwrap_err();
    assert_eq!(error.code, "REVISION_CONFLICT");
    assert_eq!(error.message, "Draft is based on an older baseline");
    let repair = error.repair.unwrap();
    assert!(
        repair.contains(&r2) && repair.contains("artifact_update_draft"),
        "{repair}"
    );
    assert_eq!(error.details.unwrap()["currentRevisionId"], r2);
    assert_eq!(f.count("SELECT COUNT(*) FROM proposal"), 0);
    assert_eq!(f.review_state(&plate, &continued), "draft");

    let error = f
        .call(
            Origin::User,
            "artifact.accept_draft",
            json!({"artifactId": plate, "draftRevisionId": continued}),
        )
        .unwrap_err();
    assert_eq!(error.code, "REVISION_CONFLICT");
    assert_eq!(error.details.unwrap()["currentRevisionId"], r2);
    assert_eq!(f.selected(&plate), r2);

    let rebuilt = text(
        &f.agent(
            "artifact.update_draft",
            json!({"artifactId": plate, "baseRevisionId": r2, "payload": {"markdown": "agent v2 on the human change"}}),
        )["revision"]["id"],
    );
    let proposal = id_of(&f.submit(json!([change(&plate, &rebuilt, Some(&r2))]), "rebuilt"));
    f.user("proposal.approve", json!({"proposalId": proposal}));
    assert_eq!(f.selected(&plate), rebuilt);
}

#[test]
fn a_change_built_on_top_of_the_newer_baseline_stays_approvable() {
    let mut f = fixture();
    let (a, a1) = f.baseline_note("A", "a v1");
    let (b, b1) = f.draft_note("B", "b v1");
    let a2 = f.revise(&a, "a v2");
    let first = id_of(&f.submit(
        json!([change(&a, &a2, Some(&a1)), change(&b, &b1, None)]),
        "A and B",
    ));
    let a3 = text(
        &f.agent(
            "artifact.update_draft",
            json!({"artifactId": a, "draftRevisionId": a2, "payload": {"markdown": "a v3"}}),
        )["revision"]["id"],
    );
    // Touches fewer artifacts than the first proposal, so it does not replace it.
    let second = id_of(&f.submit(json!([change(&a, &a3, Some(&a1))]), "A again"));
    assert_eq!(f.proposal(&first)["proposal"]["state"], "pending");

    f.user("proposal.approve", json!({"proposalId": first}));
    assert_eq!(f.selected(&a), a2);
    let read = f.proposal(&second);
    assert_eq!(read["proposal"]["state"], "pending");
    assert_eq!(read["changes"][0]["change"]["baseRevisionId"], a1);
    assert_eq!(read["changes"][0]["baseMoved"], false);

    f.user("proposal.approve", json!({"proposalId": second}));
    assert_eq!(f.selected(&a), a3);
    assert_eq!(f.review_state(&a, &a2), "superseded");
}

/// Accepting a draft that continues a proposed revision accepts that
/// revision with it: the proposal is answered, not left waiting as stale.
#[test]
fn accepting_a_draft_built_on_a_proposal_answers_the_proposal() {
    let mut f = fixture();
    let (need, r1) = f.baseline_note("Payload", "Carry 0.3 kg");
    let r2 = f.revise(&need, "Carry 0.4 kg");
    let proposal = id_of(&f.submit(json!([change(&need, &r2, Some(&r1))]), "raise payload"));
    let r3 = f.revise(&need, "Carry 0.45 kg");
    assert_eq!(f.review_state(&need, &r2), "proposed");
    f.accept(&need, &r3);

    let read = f.proposal(&proposal);
    assert_eq!(read["proposal"]["state"], "superseded");
    assert_eq!(read["changes"][0]["baseMoved"], false);
    assert_eq!(read["proposal"]["impact"]["answeredByRevisionId"], r3);
    assert_eq!(f.review_state(&need, &r2), "superseded");
    assert_eq!(f.review_state(&need, &r3), "approved");
    let status = f.agent("work.status", json!({}));
    assert_eq!(status["waitingOnHuman"], json!([]));
    assert_eq!(
        f.count("SELECT COUNT(*) FROM decision WHERE action='superseded' AND actor='user'"),
        1
    );
    assert_eq!(
        f.count("SELECT COUNT(*) FROM decision WHERE action='rejected'"),
        0
    );
}

/// A proposal over two artifacts, one of which the person accepted directly
/// from a draft built on it, still approves: the other change takes effect
/// and the accepted baseline is not moved back.
#[test]
fn a_proposal_part_of_which_is_already_in_the_baseline_still_approves() {
    let mut f = fixture();
    let (need, r1) = f.baseline_note("Payload", "Carry 0.3 kg");
    let (plan, p1) = f.draft_note("Test plan", "Load 0.4 kg");
    let r2 = f.revise(&need, "Carry 0.4 kg");
    let proposal = id_of(&f.submit(
        json!([change(&need, &r2, Some(&r1)), change(&plan, &p1, None)]),
        "payload and plan",
    ));
    let r3 = f.revise(&need, "Carry 0.45 kg");
    f.accept(&need, &r3);
    let read = f.proposal(&proposal);
    assert_eq!(read["proposal"]["state"], "pending");
    assert_eq!(read["changes"][0]["baseMoved"], false);

    f.user("proposal.approve", json!({"proposalId": proposal}));
    assert_eq!(f.selected(&need), r3);
    assert_eq!(f.selected(&plan), p1);
    assert_eq!(f.review_state(&need, &r2), "superseded");
}

// 2. Supersession and the request-changes state.

#[test]
fn a_replacement_retires_the_changes_requested_proposal_it_covers_and_no_other() {
    let mut f = fixture();
    let (plate, r1) = f.baseline_note("Plate", "plate");
    let holes = f.revise(&plate, "6 mm holes");
    let first = id_of(&f.submit(json!([change(&plate, &holes, Some(&r1))]), "6 mm holes"));
    f.user(
        "proposal.request_changes",
        json!({"proposalId": first, "rationale": "Use 5.5 mm instead"}),
    );
    let (other, other1) = f.draft_note("Unrelated note", "unrelated");
    let unrelated = id_of(&f.submit(json!([change(&other, &other1, None)]), "unrelated"));
    f.user(
        "proposal.request_changes",
        json!({"proposalId": unrelated, "rationale": "Need a clearer title"}),
    );

    let corrected = f.revise(&plate, "5.5 mm holes");
    let replacement = f.submit(
        json!([change(&plate, &corrected, Some(&r1))]),
        "5.5 mm holes",
    );
    let replacement_id = id_of(&replacement);
    assert_eq!(
        replacement["impact"]["supersedesProposalIds"],
        json!([first])
    );
    assert_eq!(replacement["supersedesProposalIds"], json!([first]));
    assert_eq!(replacement["supersededBy"], Value::Null);

    let retired = f.proposal(&first)["proposal"].clone();
    assert_eq!(retired["state"], "superseded");
    assert_eq!(retired["impact"]["supersededByProposalId"], replacement_id);
    assert_eq!(retired["supersededBy"], replacement_id);
    assert_eq!(retired["resolutionRationale"], "Use 5.5 mm instead");
    assert!(retired["resolvedAt"].is_string());
    // The correction continued the returned draft, so that draft is an
    // earlier step of the work under review now.
    assert_eq!(f.review_state(&plate, &holes), "draft");
    assert_eq!(
        f.proposal(&unrelated)["proposal"]["state"],
        "changes_requested"
    );
    let waiting = f.user("proposal.list", json!({"state": "changes_requested"}));
    assert_eq!(
        waiting["proposals"]
            .as_array()
            .unwrap()
            .iter()
            .map(id_of)
            .collect::<Vec<_>>(),
        vec![unrelated.clone()]
    );

    let resolved = f.events_of("proposal.resolved");
    let superseded = resolved
        .iter()
        .find(|event| event["data"]["state"] == "superseded")
        .unwrap();
    assert_eq!(superseded["origin"], "agent");
    assert_eq!(
        superseded["data"],
        json!({"proposalId": first, "state": "superseded", "supersededByProposalId": replacement_id, "sessionId": SESSION})
    );
    let submitted = f.events_of("proposal.submitted");
    assert_eq!(
        submitted.last().unwrap()["data"]["supersedesProposalIds"],
        json!([first])
    );
    assert_eq!(
        f.count("SELECT COUNT(*) FROM decision WHERE action='superseded' AND actor='agent'"),
        1
    );

    f.user(
        "proposal.approve",
        json!({"proposalId": replacement_id, "rationale": "5.5 mm accepted"}),
    );
    assert_eq!(f.selected(&plate), corrected);
    assert_eq!(f.review_state(&plate, &holes), "superseded");
    assert_eq!(f.proposal(&first)["proposal"]["state"], "superseded");
    assert_eq!(
        f.proposal(&unrelated)["proposal"]["state"],
        "changes_requested"
    );
}

#[test]
fn a_newer_proposal_for_the_same_artifact_replaces_a_pending_one() {
    let mut f = fixture();
    let (note, n1) = f.draft_note("Note", "first");
    let first = id_of(&f.submit(json!([change(&note, &n1, None)]), "first"));
    // With no baseline, the next draft continues from the one under review.
    let n2 = f.revise(&note, "second");
    let second = id_of(&f.submit(json!([change(&note, &n2, None)]), "second"));

    assert_eq!(f.proposal(&first)["proposal"]["state"], "superseded");
    // The replacement was built on it, so it is an earlier draft of that work.
    assert_eq!(f.review_state(&note, &n1), "draft");
    let open = f.user("proposal.list", json!({"state": "pending"}));
    assert_eq!(open["proposals"].as_array().unwrap().len(), 1);
    assert_eq!(open["proposals"][0]["id"], second);

    let error = f
        .call(
            Origin::User,
            "proposal.approve",
            json!({"proposalId": first}),
        )
        .unwrap_err();
    assert_eq!(error.code, "VALIDATION");
    assert_eq!(error.message, "Proposal already resolved (superseded)");

    f.user("proposal.approve", json!({"proposalId": second}));
    assert_eq!(f.selected(&note), n2);
    assert_eq!(f.review_state(&note, &n1), "superseded");
}

#[test]
fn proposing_the_same_revision_again_keeps_it_under_review() {
    let mut f = fixture();
    let (note, n1) = f.draft_note("Note", "content");
    let first = id_of(&f.submit(json!([change(&note, &n1, None)]), "terse"));
    f.user(
        "proposal.request_changes",
        json!({"proposalId": first, "rationale": "Say why"}),
    );
    let second = id_of(&f.submit(json!([change(&note, &n1, None)]), "explained"));
    assert_eq!(f.proposal(&first)["proposal"]["state"], "superseded");
    assert_eq!(f.review_state(&note, &n1), "proposed");
    f.user("proposal.approve", json!({"proposalId": second}));
    assert_eq!(f.selected(&note), n1);
}

#[test]
fn requesting_changes_hands_the_proposal_to_the_agent() {
    let mut f = fixture();
    let (note, n1) = f.draft_note("Note", "content");
    let proposal = id_of(&f.submit(json!([change(&note, &n1, None)]), "review please"));
    let requested = f.user(
        "proposal.request_changes",
        json!({"proposalId": proposal, "rationale": "Tighten the tolerance"}),
    );
    assert_eq!(requested["state"], "changes_requested");
    assert_eq!(requested["resolutionRationale"], "Tighten the tolerance");
    assert_eq!(f.review_state(&note, &n1), "proposed");
    assert_eq!(f.count("SELECT COUNT(*) FROM decision"), 0);
    let event = f.events_of("proposal.resolved").pop().unwrap();
    assert_eq!(event["data"]["state"], "changes_requested");
    assert!(
        f.user("proposal.list", json!({"state": "pending"}))["proposals"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    let again = f
        .call(
            Origin::User,
            "proposal.request_changes",
            json!({"proposalId": proposal, "rationale": "And the finish"}),
        )
        .unwrap_err();
    assert_eq!(again.code, "VALIDATION");
    assert!(again.repair.unwrap().contains("waiting on the agent"));
    assert_eq!(
        f.proposal(&proposal)["proposal"]["resolutionRationale"],
        "Tighten the tolerance"
    );

    // The person can still take it as it is.
    let approved = f.user("proposal.approve", json!({"proposalId": proposal}));
    assert_eq!(approved["state"], "accepted");
    assert_eq!(f.selected(&note), n1);
}

#[test]
fn approving_retires_an_older_open_proposal_that_the_decision_answers() {
    let mut f = fixture();
    let (note, n1) = f.draft_note("Note", "first");
    let older = id_of(&f.submit(json!([change(&note, &n1, None)]), "first"));
    let n2 = f.revise(&note, "second");
    let newer = id_of(&f.submit(json!([change(&note, &n2, None)]), "second"));
    // A project written before supersession existed holds both as open.
    f.handle()
        .db
        .execute_batch(&format!(
            "UPDATE proposal SET state='pending',resolved_at=NULL,impact=NULL WHERE id='{older}';
             UPDATE revision SET review_state='proposed' WHERE id='{n1}';"
        ))
        .unwrap();

    f.user("proposal.approve", json!({"proposalId": newer}));
    let retired = f.proposal(&older)["proposal"].clone();
    assert_eq!(retired["state"], "superseded");
    assert_eq!(retired["supersededBy"], newer);
    assert_eq!(f.review_state(&note, &n1), "superseded");
    assert_eq!(f.selected(&note), n2);
}

// 3. The reviewer sees CAD verification.

const SCAD_PATH: &str = "artifacts/mechanical/bracket.scad";
const STL_PATH: &str = "artifacts/mechanical/bracket.stl";

fn encode(text: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(text)
}

/// A mechanical draft carrying a render the way `cad.write_source` leaves it:
/// source, mesh, bounds, an identity tying them together, and the render job
/// that produced them, recorded as the core records one.
fn rendered_part(f: &mut Fixture, source: &str, params: Value) -> (String, String) {
    let mesh = format!("mesh of {source} with {params}");
    let source_hash = omenflow_storage::sha256_hex(source.as_bytes());
    let mesh_hash = omenflow_storage::sha256_hex(mesh.as_bytes());
    let job = uuid::Uuid::new_v4().to_string();
    f.handle()
        .db
        .execute(
            "INSERT INTO job(id,kind,tool,inputs,input_hashes,status,output_hashes,created_at) \
             VALUES(?1,'cad_render','openscad',?2,?3,'succeeded',?4,?5)",
            params![
                job,
                json!({"params": params}).to_string(),
                json!({"source": source_hash}).to_string(),
                json!({"stl": mesh_hash}).to_string(),
                now()
            ],
        )
        .unwrap();
    let draft = f.user(
        "artifact.create_draft",
        json!({
            "type": "mechanical", "title": "Bracket",
            "payload": {
                "scad": {"path": SCAD_PATH, "sha256": source_hash, "role": "source"},
                "stl": {"path": STL_PATH, "sha256": mesh_hash, "role": "output"},
                "params": params, "modelUnit": "mm", "renderJobId": job,
                "bounds": {"min": [0, 0, 0], "max": [20, 10, 2]},
                "renderIdentity": {"version": 1, "sourceHash": source_hash, "params": params,
                    "modelUnit": "mm", "frame": "right-handed-z-up", "engine": "openscad",
                    "engineVersion": "2021.01", "options": "stl", "inputFingerprint": "fingerprint",
                    "outputHash": mesh_hash},
            },
            "files": [
                {"path": SCAD_PATH, "contentBase64": encode(source)},
                {"path": STL_PATH, "contentBase64": encode(&mesh)},
            ],
        }),
    );
    (
        text(&draft["artifact"]["id"]),
        text(&draft["revision"]["id"]),
    )
}

fn has_render(f: &mut Fixture, part: &str) -> Value {
    f.user("cad.read_source", json!({"artifactId": part}))["hasRender"].clone()
}

/// A render identity an agent writes is not a render: the mesh it attaches
/// never came from the source, so nothing can read as rendered or verified.
#[test]
fn a_render_identity_supplied_with_a_draft_is_not_a_render() {
    let mut f = fixture();
    let source = "cube([5, 5, 5]);\n";
    let mesh = "solid fabricated 40 x 30 x 4 box";
    let source_hash = omenflow_storage::sha256_hex(source.as_bytes());
    let mesh_hash = omenflow_storage::sha256_hex(mesh.as_bytes());
    let draft = f.agent(
        "artifact.create_draft",
        json!({
            "type": "mechanical", "title": "Fabricated",
            "payload": {
                "scad": {"path": SCAD_PATH, "sha256": source_hash, "role": "source"},
                "stl": {"path": STL_PATH, "sha256": mesh_hash, "role": "output"},
                "params": {}, "modelUnit": "mm",
                "bounds": {"min": [0, 0, 0], "max": [40, 30, 4]},
                "renderJobId": uuid::Uuid::new_v4().to_string(),
                "renderIdentity": {"version": 1, "sourceHash": source_hash, "params": {},
                    "modelUnit": "mm", "frame": "right-handed-z-up", "engine": "openscad",
                    "engineVersion": "2021.01", "options": "stl", "inputFingerprint": "anything",
                    "outputHash": mesh_hash},
            },
            "files": [
                {"path": SCAD_PATH, "contentBase64": encode(source)},
                {"path": STL_PATH, "contentBase64": encode(mesh)},
            ],
        }),
    );
    let part = text(&draft["artifact"]["id"]);
    let payload = &draft["revision"]["payload"];
    for derived in ["stl", "bounds", "renderIdentity", "renderJobId"] {
        assert!(payload.get(derived).is_none(), "{derived} survived");
    }
    assert_eq!(draft["revision"]["files"].as_array().unwrap().len(), 1);
    assert_eq!(has_render(&mut f, &part), false);
    let status = f.agent("work.status", json!({}));
    assert_eq!(status["outstanding"][0]["kind"], "cad_render_failed");
    if engine_available() {
        let checked = f.agent(
            "cad.check",
            json!({"artifactId": part, "expect": {"size": [40, 30, 4], "bodies": 1}}),
        );
        assert_ne!(checked["verificationStatus"], "passed", "{checked}");
        assert_eq!(checked["ready"], false);
    }
}

#[test]
fn proposal_read_reports_cad_verification_for_mechanical_changes_only() {
    let mut f = fixture();
    let (part, p1) = rendered_part(&mut f, "cube([20, 10, 2]);", json!({}));
    let (note, n1) = f.draft_note("Note", "content");
    let proposal = id_of(&f.submit(
        json!([change(&part, &p1, None), change(&note, &n1, None)]),
        "part and note",
    ));
    let read = f.proposal(&proposal);
    // Rendered, but no check was ever committed for this revision.
    assert_eq!(
        read["changes"][0]["verification"],
        json!({"status": "unverified", "ready": false, "nextAction": "commit_assertions", "render": "ok"})
    );
    assert!(read["changes"][1].get("verification").is_none());
}

#[test]
fn the_reviewer_sees_a_committed_cad_check_and_can_accept_its_scope() {
    if !engine_available() {
        return;
    }
    let mut f = fixture();
    let part = f.agent(
        "cad.write_source",
        json!({"title": "Plate", "source": "cube([20,10,2]);", "timeoutMs": 60000}),
    );
    let (artifact, revision) = (text(&part["artifactId"]), text(&part["revisionId"]));
    let check = f.agent(
        "cad.check",
        json!({"artifactId": artifact, "expect": {
            "bbox": {"min": [0, 0, 0], "max": [20, 10, 2]}, "volume": {"value": 400},
            "solid": [[10, 5, 1]], "empty": [[30, 5, 1]], "maxSelfIntersections": 0,
            "sections": [{"axis": "z", "at": 1, "outerCount": 1, "holeCount": 0, "outer": {"size": [20, 10]}}]
        }}),
    );
    assert_eq!(check["verificationStatus"], "passed", "{check}");
    let proposal = id_of(&f.submit(json!([change(&artifact, &revision, None)]), "plate"));
    let read = f.proposal(&proposal);
    let verification = &read["changes"][0]["verification"];
    assert_eq!(verification["status"], "passed");
    assert_eq!(verification["evidenceHash"], check["evidenceHash"]);
    assert!(verification["evidence"]["expect"].is_object());

    let mut evidence = serde_json::Map::new();
    evidence.insert(artifact.clone(), check["evidenceHash"].clone());
    f.user(
        "proposal.approve",
        json!({"proposalId": proposal, "verificationEvidence": evidence}),
    );
    let accepted = f.events_of("cad.scope.accepted");
    assert_eq!(accepted.len(), 1);
    assert_eq!(accepted[0]["data"]["evidenceHash"], check["evidenceHash"]);
    assert_eq!(f.selected(&artifact), revision);
}

#[test]
fn accepting_a_draft_directly_can_accept_its_verified_scope() {
    if !engine_available() {
        return;
    }
    let mut f = fixture();
    let part = f.agent(
        "cad.write_source",
        json!({"title": "Plate", "source": "cube([20,10,2]);", "timeoutMs": 60000}),
    );
    let (artifact, revision) = (text(&part["artifactId"]), text(&part["revisionId"]));
    let check = f.agent(
        "cad.check",
        json!({"artifactId": artifact, "expect": {"bbox": {"min": [0, 0, 0], "max": [20, 10, 2]}}}),
    );
    assert_eq!(check["verificationStatus"], "passed", "{check}");
    let stale_hash = "0".repeat(64);
    let refused = f
        .call(
            Origin::User,
            "artifact.accept_draft",
            json!({"artifactId": artifact, "draftRevisionId": revision, "verificationEvidenceHash": stale_hash}),
        )
        .unwrap_err();
    assert_eq!(refused.code, "REVISION_CONFLICT");
    assert_eq!(f.selected(&artifact), Value::Null);
    f.user(
        "artifact.accept_draft",
        json!({"artifactId": artifact, "draftRevisionId": revision, "verificationEvidenceHash": check["evidenceHash"]}),
    );
    assert_eq!(f.events_of("cad.scope.accepted").len(), 1);
    assert_eq!(f.selected(&artifact), revision);
}

#[test]
fn listed_items_without_an_assertion_never_establish_verified_scope() {
    if !engine_available() {
        return;
    }
    let mut f = fixture();
    let part = f.agent(
        "cad.write_source",
        json!({"title": "Plate", "source": "cube([20,10,2]);", "timeoutMs": 60000}),
    );
    let (artifact, revision) = (text(&part["artifactId"]), text(&part["revisionId"]));
    let check = f.agent(
        "cad.check",
        json!({"artifactId": artifact, "autoCommit": true, "expect": {"spec": [
            {"item": "plate 20 x 10 x 2", "size": [20, 10, 2]}, {"item": "1 mm chamfer"}]}}),
    );
    assert_eq!(check["verificationStatus"], "partial", "{check}");
    assert_eq!(check["committed"], true);
    let expected = "Listed items without an assertion cannot establish verified scope";
    // Accepting the draft with that evidence as its scope is refused…
    let refused = f
        .call(
            Origin::User,
            "artifact.accept_draft",
            json!({"artifactId": artifact, "draftRevisionId": revision, "verificationEvidenceHash": check["evidenceHash"]}),
        )
        .unwrap_err();
    assert_eq!(
        (refused.code.as_str(), refused.message.as_str()),
        ("VALIDATION", expected)
    );
    assert_eq!(f.selected(&artifact), Value::Null);
    // …and so is approving a proposal with it.
    let proposal = id_of(&f.submit(json!([change(&artifact, &revision, None)]), "plate"));
    let mut evidence = serde_json::Map::new();
    evidence.insert(artifact.clone(), check["evidenceHash"].clone());
    let refused = f
        .call(
            Origin::User,
            "proposal.approve",
            json!({"proposalId": proposal, "verificationEvidence": evidence}),
        )
        .unwrap_err();
    assert_eq!(refused.message, expected);
    assert!(f.events_of("cad.scope.accepted").is_empty());
    assert_eq!(f.selected(&artifact), Value::Null);
}

// 4. Baseline changes and staleness.

/// `up` with a baseline, and `down` with a baseline recorded against it.
fn dependent_pair(f: &mut Fixture) -> (String, String, String, String) {
    let (up, u1) = f.baseline_note("Source", "v1");
    let down = f.agent(
        "artifact.create_draft",
        json!({"type": "note", "title": "Derived", "payload": {"markdown": "from v1"},
            "inputs": [{"artifactId": up, "revisionId": u1, "relationship": "derived_from"}]}),
    );
    let (down, d1) = (text(&down["artifact"]["id"]), text(&down["revision"]["id"]));
    f.accept(&down, &d1);
    (up, u1, down, d1)
}

#[test]
fn a_baseline_change_and_its_stale_records_commit_together_or_not_at_all() {
    let mut f = fixture();
    let (up, u1, down, _) = dependent_pair(&mut f);
    let u2 = f.revise(&up, "v2");
    let events_before = f.events().len();

    f.fail_inserts_into("stale");
    let error = f
        .call(
            Origin::User,
            "artifact.accept_draft",
            json!({"artifactId": up, "draftRevisionId": u2}),
        )
        .unwrap_err();
    assert_eq!(error.code, "INTERNAL");
    assert_eq!(f.selected(&up), u1);
    assert_eq!(f.review_state(&up, &u1), "approved");
    assert_eq!(f.review_state(&up, &u2), "draft");
    assert_eq!(f.freshness(&down)["freshness"], "current");
    assert_eq!(f.events().len(), events_before);
    assert_eq!(f.count("SELECT COUNT(*) FROM decision"), 2);
    assert!(f.handle().db.is_autocommit());

    f.stop_failing("stale");
    f.accept(&up, &u2);
    let view = f.freshness(&down);
    assert_eq!(view["freshness"], "stale");
    assert_eq!(view["staleReasons"][0]["expectedRevisionId"], u1);
    assert_eq!(view["staleReasons"][0]["actualRevisionId"], u2);
    let changed = f.events_of("baseline.changed").pop().unwrap();
    assert_eq!(view["staleReasons"][0]["sinceEventSeq"], changed["seq"]);
    let propagated = f.events_of("impact.propagated").pop().unwrap();
    assert_eq!(
        propagated["data"]["affected"],
        json!([{"artifactId": down, "reason": "input changed", "path": [up, down]}])
    );
}

#[test]
fn staleness_clears_only_when_the_dependent_is_recorded_against_the_new_input() {
    let mut f = fixture();
    let (up, u1, down, d1) = dependent_pair(&mut f);
    let third = f.agent(
        "artifact.create_draft",
        json!({"type": "note", "title": "Third", "payload": {"markdown": "from derived"},
            "inputs": [{"artifactId": down, "revisionId": d1}]}),
    );
    let (third, t1) = (
        text(&third["artifact"]["id"]),
        text(&third["revision"]["id"]),
    );
    f.accept(&third, &t1);

    let u2 = f.edit(&up, &u1, "v2");
    assert_eq!(f.freshness(&down)["freshness"], "stale");
    let inherited = f.freshness(&third);
    assert_eq!(inherited["staleReasons"][0]["upstreamArtifactId"], up);
    assert_eq!(
        inherited["staleReasons"][0]["path"],
        json!([up, down, third])
    );

    // Rewording the dependent says nothing about the input it was recorded against.
    let d2 = f.edit(&down, &d1, "reworded, still from v1");
    let still = f.freshness(&down);
    assert_eq!(still["freshness"], "stale");
    assert_eq!(still["staleReasons"][0]["expectedRevisionId"], u1);

    // Declaring the input again, without a revision, records the current baseline.
    let updated = f.agent(
        "artifact.update_draft",
        json!({"artifactId": down, "baseRevisionId": d2, "payload": {"markdown": "from v2"},
            "inputs": [{"artifactId": up, "relationship": "derived_from"}]}),
    );
    assert_eq!(updated["revision"]["inputs"][0]["revisionId"], u2);
    let d3 = text(&updated["revision"]["id"]);
    f.accept(&down, &d3);
    let fresh = f.freshness(&down);
    assert_eq!(fresh["freshness"], "current");
    assert_eq!(fresh["staleReasons"], json!([]));
    let propagated = f.events_of("impact.propagated").pop().unwrap();
    assert_eq!(
        propagated["data"]["affected"][0],
        json!({"artifactId": down, "reason": "inputs restored", "path": [down]})
    );
    // What was built on the old revision of the dependent is now behind it,
    // and no longer blamed on the source.
    let behind = f.freshness(&third);
    assert_eq!(behind["staleReasons"].as_array().unwrap().len(), 1);
    assert_eq!(behind["staleReasons"][0]["upstreamArtifactId"], down);
    assert_eq!(behind["staleReasons"][0]["actualRevisionId"], d3);
}

#[test]
fn a_cause_that_persists_keeps_the_event_it_was_first_recorded_at() {
    let mut f = fixture();
    let (a, a1) = f.baseline_note("A", "a v1");
    let (b, b1) = f.baseline_note("B", "b v1");
    let c = f.agent(
        "artifact.create_draft",
        json!({"type": "note", "title": "C", "payload": {"markdown": "from a and b"},
            "inputs": [{"artifactId": a, "revisionId": a1}, {"artifactId": b, "revisionId": b1}]}),
    );
    let (c, c1) = (text(&c["artifact"]["id"]), text(&c["revision"]["id"]));
    f.accept(&c, &c1);

    f.edit(&a, &a1, "a v2");
    let first = f.freshness(&c)["staleReasons"][0]["sinceEventSeq"].clone();
    f.edit(&b, &b1, "b v2");
    let reasons = f.freshness(&c)["staleReasons"].clone();
    assert_eq!(reasons[0]["upstreamArtifactId"], a);
    assert_eq!(reasons[0]["sinceEventSeq"], first);
    assert_eq!(reasons[1]["upstreamArtifactId"], b);
    assert!(reasons[1]["sinceEventSeq"].as_i64() > first.as_i64());
}

#[test]
fn opening_a_project_repairs_stale_records_and_writes_nothing_when_they_are_right() {
    let mut f = fixture();
    let (up, u1, down, _) = dependent_pair(&mut f);
    let u2 = f.edit(&up, &u1, "v2");
    assert_eq!(f.freshness(&down)["freshness"], "stale");
    // What a crash between a baseline change and its propagation leaves: the
    // dependent still reads as current, and an old record lingers elsewhere.
    f.handle()
        .db
        .execute_batch(&format!(
            "DELETE FROM stale;
             INSERT INTO stale(artifact_id,upstream_artifact_id,expected_revision_id,actual_revision_id,path,reason,since_event_seq)
             VALUES('{up}','{down}',NULL,NULL,'[]','missing_input',1);"
        ))
        .unwrap();
    assert_eq!(f.freshness(&down)["freshness"], "current");
    let events_before = f.events().len();

    let opened = f.reopen();
    assert!(opened.get("warnings").is_none());
    let repaired = f.freshness(&down);
    assert_eq!(repaired["freshness"], "stale");
    assert_eq!(repaired["staleReasons"][0]["expectedRevisionId"], u1);
    assert_eq!(repaired["staleReasons"][0]["actualRevisionId"], u2);
    assert_eq!(f.freshness(&up)["freshness"], "current");
    let events = f.events();
    assert_eq!(events.len(), events_before + 1);
    let event = events.last().unwrap();
    assert_eq!(event["type"], "impact.propagated");
    assert_eq!(event["origin"], "system");
    assert_eq!(event["data"]["reconciled"], true);
    assert_eq!(
        event["data"]["affected"],
        json!([
            {"artifactId": up, "reason": "inputs restored", "path": [up]},
            {"artifactId": down, "reason": "input changed", "path": [up, down]},
        ])
    );
    assert_eq!(repaired["staleReasons"][0]["sinceEventSeq"], event["seq"]);
    // The repair happened before anyone was listening; it is not replayed.
    assert!(f.undelivered().is_empty());

    f.reopen();
    assert_eq!(f.events().len(), events_before + 1);
}

fn candidate(f: &mut Fixture, title: &str, part_number: &str) -> (String, String) {
    let component = f.agent(
        "component.add_candidate",
        json!({"title": title, "manufacturer": "Acme", "partNumber": part_number,
            "offer": {"seller": "Acme", "url": format!("https://shop.example.test/{part_number}")}}),
    );
    (
        text(&component["artifact"]["id"]),
        text(&component["revision"]["id"]),
    )
}

#[test]
fn replacing_a_component_marks_what_depended_on_the_replaced_one() {
    let mut f = fixture();
    let (old, old1) = candidate(&mut f, "Motor A", "MA-1");
    f.accept(&old, &old1);
    let mount = f.agent(
        "artifact.create_draft",
        json!({"type": "note", "title": "Mount notes", "payload": {"markdown": "sized for motor A"},
            "inputs": [{"artifactId": old, "revisionId": old1}]}),
    );
    let (mount, m1) = (
        text(&mount["artifact"]["id"]),
        text(&mount["revision"]["id"]),
    );
    f.accept(&mount, &m1);
    let (new, new1) = candidate(&mut f, "Motor B", "MB-1");

    let selection = f.agent(
        "component.propose_selection",
        json!({"artifactId": new, "revisionId": new1, "bomLines": [{"quantity": 2}],
            "replacesArtifactId": old, "reason": "Motor B replaces motor A"}),
    );
    f.user(
        "proposal.approve",
        json!({"proposalId": selection["proposal"]["id"]}),
    );

    let listed = f.user("artifact.list", json!({}));
    assert!(listed["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .all(|view| view["artifact"]["id"] != old));
    let view = f.freshness(&mount);
    assert_eq!(view["freshness"], "missing_input");
    assert_eq!(view["staleReasons"][0]["upstreamArtifactId"], old);
    assert_eq!(view["staleReasons"][0]["path"], json!([old, mount]));
    let propagated = f.events_of("impact.propagated").pop().unwrap();
    assert!(propagated["data"]["affected"]
        .as_array()
        .unwrap()
        .contains(&json!({"artifactId": mount, "reason": "missing input", "path": [old, mount]})));
    assert_eq!(f.events().last().unwrap()["type"], "bom.changed");
    // The line follows the component to the revision this approval selected.
    let bom = f.user("bom.read", json!({}));
    assert_eq!(
        bom["lines"][0]["line"]["componentRevisionId"],
        f.selected(&new)
    );
}

/// An approval that changes no component, BOM line or replaced part does not
/// announce a BOM change.
#[test]
fn only_an_approval_that_changes_the_bom_announces_it() {
    let mut f = fixture();
    let (note, n1) = f.draft_note("Bench notes", "Measured by hand.");
    let proposal = id_of(&f.submit(json!([change(&note, &n1, None)]), "notes"));
    f.user("proposal.approve", json!({"proposalId": proposal}));
    assert_eq!(f.events_of("proposal.resolved").len(), 1);
    assert!(f.events_of("bom.changed").is_empty());

    let (motor, m1) = candidate(&mut f, "Motor", "M-1");
    let proposal = id_of(&f.submit(json!([change(&motor, &m1, None)]), "motor"));
    f.user("proposal.approve", json!({"proposalId": proposal}));
    assert_eq!(f.events_of("bom.changed").len(), 1);
}

#[test]
fn a_bom_edit_changes_the_lines_and_leaves_the_component_and_its_dependents_alone() {
    let mut f = fixture();
    let (motor, m1) = candidate(&mut f, "Motor", "M-1");
    f.accept(&motor, &m1);
    let mount = f.agent(
        "artifact.create_draft",
        json!({"type": "note", "title": "Mount notes", "payload": {"markdown": "sized for the motor"},
            "inputs": [{"artifactId": motor, "revisionId": m1}]}),
    );
    let (mount, mount1) = (
        text(&mount["artifact"]["id"]),
        text(&mount["revision"]["id"]),
    );
    f.accept(&mount, &mount1);
    let edit = f.agent(
        "bom.propose_edit",
        json!({"lines": [{"componentArtifactId": motor, "quantity": 4}], "reason": "four motors"}),
    );
    let carrier = text(&edit["proposal"]["changes"][0]["newRevisionId"]);
    assert_eq!(
        edit["proposal"]["changes"][0]["bomLines"][0]["componentRevisionId"],
        m1.as_str()
    );
    f.user(
        "proposal.approve",
        json!({"proposalId": edit["proposal"]["id"]}),
    );
    // The baseline is the one the edit copied; the copy is retired.
    assert_eq!(f.selected(&motor), m1.as_str());
    assert_eq!(f.review_state(&motor, &carrier), "superseded");
    let bom = f.user("bom.read", json!({}));
    assert_eq!(bom["lines"][0]["line"]["componentRevisionId"], m1.as_str());
    assert_eq!(bom["lines"][0]["line"]["quantity"], 4.0);
    assert_eq!(bom["lines"][0]["componentRevisionCurrent"], true);
    // Nothing that depends on the motor went stale.
    let view = f.freshness(&mount);
    assert_eq!(view["freshness"], "current");
    assert_eq!(view["staleReasons"], json!([]));
    assert_eq!(f.events().last().unwrap()["type"], "bom.changed");
    let propagated = f.events_of("impact.propagated").pop().unwrap();
    assert_eq!(propagated["data"]["changed"], json!([]));
    assert_eq!(propagated["data"]["affected"], json!([]));

    // A bom_edit change whose revision really changes the component is an
    // ordinary baseline change.
    let changed = f.agent(
        "artifact.update_draft",
        json!({"artifactId": motor, "baseRevisionId": m1,
            "payload": {"manufacturer": "Acme", "partNumber": "M-2"}}),
    );
    let changed = text(&changed["revision"]["id"]);
    let proposal = f.submit(
        json!([{"artifactId": motor, "baseRevisionId": m1, "newRevisionId": changed, "kind": "bom_edit",
            "bomLines": [{"componentArtifactId": motor, "componentRevisionId": changed, "quantity": 1,
                "subsystem": null, "offerId": null, "location": null, "notes": ""}]}]),
        "new part number",
    );
    f.user("proposal.approve", json!({"proposalId": proposal["id"]}));
    assert_eq!(f.selected(&motor), changed.as_str());
    assert_eq!(f.freshness(&mount)["freshness"], "stale");
}

// 5. Events: project, session, delivery.

#[test]
fn each_event_is_delivered_once_and_names_its_project() {
    let mut f = fixture();
    let project = f.project_id.clone();
    // What happened before the project was opened is read, not delivered.
    assert!(f.undelivered().is_empty());

    let before = f.app.latest_event_seq(&project).unwrap();
    f.draft_note("Note", "content");
    let window = f.app.events_since(&project, before).unwrap();
    assert_eq!(window.len(), 1);
    assert_eq!(window[0]["type"], "revision.committed");
    assert_eq!(window[0]["projectId"], project);
    // A second caller whose window overlaps the first gets nothing twice.
    assert!(f.app.events_since(&project, before).unwrap().is_empty());

    // An event recorded outside any dispatch is not lost: it goes out with
    // the next delivery, in order.
    f.app
        .upsert_session(
            &project,
            &json!({"id": "s-1", "adapterId": "custom", "executablePath": "/bin/sh", "state": "running", "startedAt": now(), "pid": 1}),
        )
        .unwrap();
    let before = f.app.latest_event_seq(&project).unwrap();
    f.agent("ui.focus_terminal", json!({}));
    let window = f.app.events_since(&project, before).unwrap();
    assert_eq!(
        window.iter().map(|e| text(&e["type"])).collect::<Vec<_>>(),
        vec!["session.state", "ui.focus_terminal"]
    );
    assert!(window.iter().all(|event| event["projectId"] == project));
    assert!(f.events().iter().all(|event| event["projectId"] == project));

    // Delivery belongs to the open project: closing ends it.
    f.app
        .dispatch("project.close", json!({}), Origin::User, Some(&project))
        .unwrap();
    assert_eq!(
        f.app.events_since(&project, 0).unwrap_err().code,
        "NOT_FOUND"
    );
}

#[test]
fn events_caused_by_an_agent_record_its_session() {
    let mut f = fixture();
    let (note, n1) = f.draft_note("Note", "content");
    let committed = f.events_of("revision.committed").pop().unwrap();
    assert_eq!(committed["origin"], "agent");
    assert_eq!(committed["data"]["sessionId"], SESSION);

    f.accept(&note, &n1);
    let accepted = f.events_of("baseline.changed").pop().unwrap();
    assert_eq!(accepted["origin"], "user");
    assert!(accepted["data"].get("sessionId").is_none());
    f.edit(&note, &n1, "by hand");
    let by_hand = f.events_of("revision.committed").pop().unwrap();
    assert_eq!(by_hand["origin"], "user");
    assert!(by_hand["data"].get("sessionId").is_none());

    // A module that passes only the origin kind to the recorder is covered too.
    let test = f.agent(
        "test.create_draft",
        json!({"title": "Bench test", "procedure": [{"step": 1, "instruction": "Power on"}]}),
    );
    f.agent(
        "test.record_result",
        json!({"artifactId": test["artifact"]["id"], "evidenceKind": "assumed", "observation": "not built yet", "result": "not_run"}),
    );
    let recorded = f.events_of("revision.committed").pop().unwrap();
    assert_eq!(recorded["data"]["artifactId"], test["artifact"]["id"]);
    assert_eq!(recorded["data"]["sessionId"], SESSION);

    f.agent(
        "ui.suggest_action",
        json!({"title": "Review the bench test"}),
    );
    let suggested = f.events_of("ui.suggested_action").pop().unwrap();
    assert_eq!(suggested["data"]["sessionId"], SESSION);
    f.user("ui.focus_terminal", json!({}));
    let focused = f.events_of("ui.focus_terminal").pop().unwrap();
    assert!(focused["data"].get("sessionId").is_none());
}

#[test]
fn a_background_render_delivers_its_events_once_alongside_foreground_work() {
    if !engine_available() {
        return;
    }
    let mut f = fixture();
    let project = f.project_id.clone();
    let start = f.app.latest_event_seq(&project).unwrap();
    let forwarded = Arc::new(Mutex::new(Vec::<Value>::new()));
    let sink = Arc::clone(&forwarded);
    f.app
        .set_event_hook(Arc::new(move |event| sink.lock().unwrap().push(event)));

    let part = f.agent(
        "cad.write_source",
        json!({"title": "Plate", "source": "cube([20,10,2]);", "timeoutMs": 60000}),
    );
    let mut delivered = f.undelivered();
    let queued = f.agent(
        "cad.render",
        json!({"artifactId": part["artifactId"], "revisionId": part["revisionId"], "timeoutMs": 60000}),
    );
    let job = text(&queued["job"]["id"]);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    // Foreground calls keep recording and delivering events while the worker renders.
    loop {
        f.agent("ui.focus_terminal", json!({}));
        delivered.extend(f.undelivered());
        let status = f.user("job.read", json!({"jobId": job}))["job"]["status"].clone();
        if status == "succeeded" {
            break;
        }
        assert!(status == "queued" || status == "running", "render {status}");
        assert!(
            std::time::Instant::now() < deadline,
            "render did not finish"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let recorded = |f: &mut Fixture| {
        f.events()
            .iter()
            .filter_map(|event| event["seq"].as_i64())
            .filter(|seq| *seq > start)
            .collect::<Vec<_>>()
    };
    // The worker's last write is the job's final state; once that has been
    // delivered, by either side, nothing more is on its way.
    let mut seen = loop {
        delivered.extend(f.undelivered());
        let mut seen = delivered.clone();
        seen.extend(forwarded.lock().unwrap().iter().cloned());
        if seen.iter().any(|event| {
            event["type"] == "job.updated"
                && event["data"]["jobId"] == job
                && event["data"]["status"] == "succeeded"
        }) {
            break seen;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "worker events never arrived"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    seen.sort_by_key(|event| event["seq"].as_i64());
    assert_eq!(
        seen.iter()
            .filter_map(|event| event["seq"].as_i64())
            .collect::<Vec<_>>(),
        recorded(&mut f),
        "every event exactly once"
    );
    assert!(seen.iter().all(|event| event["projectId"] == project));
    // The draft the worker committed is attributed to the agent that asked for it.
    let rendered = seen
        .iter()
        .rfind(|event| event["type"] == "revision.committed")
        .unwrap();
    assert_ne!(rendered["data"]["revisionId"], part["revisionId"]);
    assert_eq!(rendered["data"]["sessionId"], SESSION);
    assert!(f.undelivered().is_empty());
}

// 6. Idempotent replay.

#[test]
fn a_failed_call_is_not_kept_under_its_key_and_a_successful_one_replays() {
    let mut f = fixture();
    let project = f.project_id.clone();
    let input = json!({"path": SCAD_PATH, "type": "mechanical", "title": "Bracket"});
    let import = |f: &mut Fixture| {
        f.app.dispatch_idempotent(
            "artifact.import_file",
            input.clone(),
            agent(),
            Some(&project),
            Some("import-1"),
        )
    };
    // The file is not there yet: a failure that depends on the state of the world.
    assert!(import(&mut f).is_err());
    assert_eq!(f.count("SELECT COUNT(*) FROM idempotency"), 0);
    assert_eq!(f.count("SELECT COUNT(*) FROM artifact"), 0);

    fs::write(f.root().join(SCAD_PATH), "cube(5);").unwrap();
    let first = import(&mut f).unwrap();
    assert!(first.get("idempotent").is_none());
    let replay = import(&mut f).unwrap();
    assert_eq!(replay["idempotent"], true);
    assert_eq!(replay["revision"]["id"], first["revision"]["id"]);
    assert_eq!(f.count("SELECT COUNT(*) FROM artifact"), 1);
    assert_eq!(f.count("SELECT COUNT(*) FROM idempotency"), 1);
}

#[test]
fn an_attempt_cut_short_by_a_restart_is_reported_once_and_then_runs() {
    let mut f = fixture();
    let project = f.project_id.clone();
    let op = "artifact.create_draft";
    let input = json!({"type": "note", "title": "Note", "payload": {"markdown": "content"}});
    let parsed = parse_input(registry().operation(op).unwrap(), input.clone()).unwrap();
    // A previous process reserved the key and stopped before recording a result.
    idempotency::reserve(
        f.handle(),
        &format!("{SESSION}:{op}:k-1"),
        &idempotency::request_hash(op, &parsed),
        "a previous process",
    )
    .unwrap();
    let create = |f: &mut Fixture| {
        f.app
            .dispatch_idempotent(op, input.clone(), agent(), Some(&project), Some("k-1"))
    };
    let interrupted = create(&mut f).unwrap_err();
    assert_eq!(interrupted.code, "REVISION_CONFLICT");
    assert!(interrupted.repair.unwrap().contains("free to reuse"));
    assert_eq!(f.count("SELECT COUNT(*) FROM artifact"), 0);

    let created = create(&mut f).unwrap();
    assert_eq!(
        create(&mut f).unwrap()["revision"]["id"],
        created["revision"]["id"]
    );
    assert_eq!(f.count("SELECT COUNT(*) FROM artifact"), 1);
}

#[test]
fn a_failed_project_creation_does_not_block_its_key() {
    let temp = tempfile::tempdir().unwrap();
    let mut app = CoreApp::new(temp.path().join("appdata")).unwrap();
    let target = temp.path().join("project");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("unrelated.txt"), "already here").unwrap();
    let input = json!({"name": "Rover", "path": target, "intent": "test"});
    let create = |app: &mut CoreApp| {
        app.dispatch_idempotent(
            "project.create",
            input.clone(),
            Origin::User,
            None,
            Some("create-1"),
        )
    };
    assert_eq!(create(&mut app).unwrap_err().code, "VALIDATION");
    // The person empties the folder and presses the button again.
    fs::remove_file(target.join("unrelated.txt")).unwrap();
    let created = create(&mut app).unwrap();
    assert!(created["projectId"].is_string());
    assert_eq!(create(&mut app).unwrap()["idempotent"], true);
}

// 7. Generic edits of a mechanical artifact.

#[test]
fn editing_baseline_parameters_removes_the_geometry_they_no_longer_describe() {
    let mut f = fixture();
    let (part, r1) = rendered_part(
        &mut f,
        "width = 20;\ncube([width, 10, 2]);",
        json!({"width": 20}),
    );
    f.accept(&part, &r1);
    assert_eq!(has_render(&mut f, &part), true);

    let edited = f.user(
        "artifact.apply_edit",
        json!({"artifactId": part, "baseRevisionId": r1, "payloadPatch": {"params": {"width": 30}}, "rationale": "wider"}),
    );
    let revision = &edited["revision"];
    assert_eq!(revision["reviewState"], "approved");
    assert_eq!(revision["payload"]["params"], json!({"width": 30}));
    for derived in ["stl", "bounds", "renderIdentity", "renderJobId"] {
        assert!(
            revision["payload"].get(derived).is_none(),
            "{derived} survived"
        );
    }
    let files = revision["files"].as_array().unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0]["path"], SCAD_PATH);
    assert_eq!(has_render(&mut f, &part), false);

    // Going back to the rendered revision brings its geometry back with it.
    let reverted = f.user(
        "artifact.revert",
        json!({"artifactId": part, "toRevisionId": r1, "rationale": "narrow again"}),
    );
    let first = f.user(
        "artifact.read",
        json!({"artifactId": part, "revisionId": r1}),
    )["revision"]
        .clone();
    assert_eq!(reverted["revision"]["payload"], first["payload"]);
    assert_eq!(reverted["revision"]["files"], first["files"]);
    assert_eq!(has_render(&mut f, &part), true);
    let event = f.events_of("baseline.changed").pop().unwrap();
    assert_eq!(event["data"]["reverted"], true);
}

#[test]
fn editing_baseline_source_points_the_record_at_the_new_source_and_needs_a_render() {
    let mut f = fixture();
    let (part, r1) = rendered_part(
        &mut f,
        "width = 20;\ndepth = 10;\ncube([width, depth, 2]);",
        json!({"width": 25, "depth": 12}),
    );
    f.accept(&part, &r1);
    let source = "width = 40;\ndepth = 10;\ncube([width, depth, 2]);";
    let edited = f.user(
        "artifact.apply_edit",
        json!({"artifactId": part, "baseRevisionId": r1, "fileWrites": [{"path": SCAD_PATH, "contentBase64": encode(source)}], "rationale": "widen"}),
    );
    assert!(edited.get("warnings").is_none(), "{edited}");
    let revision = &edited["revision"];
    let source_hash = omenflow_storage::sha256_hex(source.as_bytes());
    assert_eq!(revision["payload"]["scad"]["sha256"], source_hash);
    assert_eq!(
        revision["files"],
        json!([{"path": SCAD_PATH, "sha256": source_hash, "role": "source"}])
    );
    assert!(revision["payload"].get("stl").is_none());
    assert!(revision["payload"].get("renderIdentity").is_none());
    // The width the author rewrote wins over the override recorded for the old
    // source; the untouched depth override still applies.
    assert_eq!(revision["payload"]["params"], json!({"depth": 12}));
    assert_eq!(has_render(&mut f, &part), false);
    assert_eq!(
        fs::read_to_string(f.root().join(SCAD_PATH)).unwrap(),
        source
    );
    let read = f.user("cad.read_source", json!({"artifactId": part}));
    assert_eq!(read["source"], source);
}

#[test]
fn a_draft_that_changes_a_part_through_the_generic_tool_drops_its_render_too() {
    let mut f = fixture();
    let (part, r1) = rendered_part(
        &mut f,
        "width = 20;\ncube([width, 10, 2]);",
        json!({"width": 20}),
    );
    let first = f.user(
        "artifact.read",
        json!({"artifactId": part, "revisionId": r1}),
    )["revision"]
        .clone();
    let mut payload = first["payload"].clone();
    payload["params"] = json!({"width": 22});
    let draft = f.agent(
        "artifact.update_draft",
        json!({"artifactId": part, "draftRevisionId": r1, "payload": payload}),
    );
    assert!(draft["revision"]["payload"].get("renderIdentity").is_none());
    assert!(draft["revision"]["payload"].get("stl").is_none());
    assert_eq!(draft["revision"]["files"].as_array().unwrap().len(), 1);
    // A change that leaves source and parameters alone keeps the render.
    let mut payload = first["payload"].clone();
    payload["material"] = json!("PETG");
    let relabelled = f.agent(
        "artifact.update_draft",
        json!({"artifactId": part, "draftRevisionId": r1, "payload": payload}),
    );
    assert!(relabelled["revision"]["payload"]["renderIdentity"].is_object());
    assert_eq!(relabelled["revision"]["files"], first["files"]);
}

#[test]
fn an_engine_rendered_baseline_reads_as_unrendered_after_a_parameter_edit() {
    if !engine_available() {
        return;
    }
    let mut f = fixture();
    let part = f.user(
        "cad.write_source",
        json!({"title": "Plate", "source": "width = 20;\ncube([width, 10, 2]);", "timeoutMs": 60000}),
    );
    let (artifact, revision) = (text(&part["artifactId"]), text(&part["revisionId"]));
    f.accept(&artifact, &revision);
    assert_eq!(has_render(&mut f, &artifact), true);
    let edited = f.user(
        "artifact.apply_edit",
        json!({"artifactId": artifact, "baseRevisionId": revision, "payloadPatch": {"params": {"width": 35}}}),
    );
    assert!(edited["revision"]["payload"].get("stl").is_none());
    assert!(edited["revision"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .all(|file| !text(&file["path"]).ends_with(".stl")));
    assert_eq!(has_render(&mut f, &artifact), false);
    // Rendering the edited baseline produces geometry for the new width.
    let rendered = f.user("cad.inspect", json!({"artifactId": artifact}));
    assert_eq!(rendered["dimensions"]["x"], "35 mm", "{rendered}");
}

// 8. Reads stay honest and bounded.

#[test]
fn reading_an_unknown_revision_is_an_error_not_an_empty_artifact() {
    let mut f = fixture();
    let (note, _) = f.draft_note("Note", "content");
    let (_, other_revision) = f.draft_note("Other", "content");
    let unknown = uuid::Uuid::new_v4().to_string();
    let error = f
        .call(
            agent(),
            "artifact.read",
            json!({"artifactId": note, "revisionId": unknown}),
        )
        .unwrap_err();
    assert_eq!(error.code, "NOT_FOUND");
    assert!(error.message.contains(&unknown));
    let error = f
        .call(
            agent(),
            "artifact.read",
            json!({"artifactId": note, "revisionId": other_revision}),
        )
        .unwrap_err();
    assert_eq!(error.code, "VALIDATION");
}

#[test]
fn open_drafts_stay_bounded_however_long_the_work_runs() {
    let mut f = fixture();
    let (note, n1) = f.baseline_note("Note", "v1");
    let mut line = vec![f.revise(&note, "step 0")];
    for step in 1..6 {
        let next = f.agent(
            "artifact.update_draft",
            json!({"artifactId": note, "draftRevisionId": line.last().unwrap(), "payload": {"markdown": format!("step {step}")}}),
        );
        line.push(text(&next["revision"]["id"]));
    }
    let read = f.user("artifact.read", json!({"artifactId": note}));
    assert_eq!(read["drafts"].as_array().unwrap().len(), 1);
    assert_eq!(read["drafts"][0]["id"], *line.last().unwrap());
    assert_eq!(read["view"]["draftCount"], 1);
    // Earlier steps stay part of the line the newest draft was built from.
    assert_eq!(f.review_state(&note, &line[0]), "draft");

    // Starting over from the baseline abandons that line, and says so.
    let restarted = f.agent(
        "artifact.update_draft",
        json!({"artifactId": note, "baseRevisionId": n1, "payload": {"markdown": "fresh start"}}),
    );
    let restart = text(&restarted["revision"]["id"]);
    for step in &line {
        assert_eq!(f.review_state(&note, step), "superseded");
    }
    assert_eq!(
        restarted["warnings"],
        json!([format!(
            "Draft r7 ({}) was retired: this revision was built on r1, not on it. It stays in artifact_history.",
            line[5]
        )])
    );
    let read = f.user("artifact.read", json!({"artifactId": note}));
    assert_eq!(read["drafts"].as_array().unwrap().len(), 1);
    assert_eq!(read["drafts"][0]["id"], restart);
    assert_eq!(
        f.user("artifact.history", json!({"artifactId": note}))["revisions"]
            .as_array()
            .unwrap()
            .len(),
        8
    );

    // A retired draft is not a candidate, and the error says which one is.
    let error = f
        .call(
            agent(),
            "proposal.submit",
            json!({"changes": [change(&note, &line[5], Some(&n1))], "reason": "old id"}),
        )
        .unwrap_err();
    assert_eq!(error.code, "VALIDATION");
    assert!(error.repair.unwrap().contains(&restart));

    f.accept(&note, &restart);
    let read = f.user("artifact.read", json!({"artifactId": note}));
    assert!(read["drafts"].as_array().unwrap().is_empty());
    assert_eq!(read["view"]["draftCount"], 0);
}

/// An update that names no revision continues the open draft, whatever it
/// carries: one that only links an input keeps the draft's content, and the
/// draft is not retired behind the caller's back.
#[test]
fn an_update_naming_no_revision_continues_the_open_draft() {
    let mut f = fixture();
    let (need, n1) = f.baseline_note("Payload", "Carry 0.3 kg");
    let (context, _) = f.baseline_note("Context", "ctx");
    let r2 = f.revise(&need, "Carry 0.5 kg");
    let linked = f.agent(
        "artifact.update_draft",
        json!({"artifactId": need, "inputs": [{"artifactId": context, "relationship": "depends_on"}]}),
    );
    assert_eq!(linked["revision"]["parentId"], r2);
    assert_eq!(linked["revision"]["payload"]["markdown"], "Carry 0.5 kg");
    assert!(linked.get("warnings").is_none(), "{linked}");
    assert_eq!(f.review_state(&need, &r2), "draft");
    let read = f.agent("artifact.read", json!({"artifactId": need}));
    assert_eq!(read["drafts"].as_array().unwrap().len(), 1);
    assert_eq!(read["drafts"][0]["id"], linked["revision"]["id"]);

    // A full payload continues the line too, keeping the draft's inputs.
    let rewritten = f.agent(
        "artifact.update_draft",
        json!({"artifactId": need, "payload": {"markdown": "Carry 0.6 kg"}}),
    );
    assert_eq!(rewritten["revision"]["parentId"], linked["revision"]["id"]);
    assert_eq!(rewritten["revision"]["inputs"][0]["artifactId"], context);
    assert_eq!(f.selected(&need), n1);
}

#[test]
fn work_under_review_keeps_the_steps_it_was_built_from() {
    let mut f = fixture();
    let (note, n1) = f.baseline_note("Note", "v1");
    let step = f.revise(&note, "step");
    let candidate = text(
        &f.agent(
            "artifact.update_draft",
            json!({"artifactId": note, "draftRevisionId": step, "payload": {"markdown": "candidate"}}),
        )["revision"]["id"],
    );
    f.submit(json!([change(&note, &candidate, Some(&n1))]), "candidate");
    // A second line, started from the baseline on purpose.
    let aside = text(
        &f.agent(
            "artifact.update_draft",
            json!({"artifactId": note, "baseRevisionId": n1, "payload": {"markdown": "another idea"}}),
        )["revision"]["id"],
    );
    assert_eq!(f.review_state(&note, &step), "draft");
    assert_eq!(f.review_state(&note, &candidate), "proposed");
    let read = f.user("artifact.read", json!({"artifactId": note}));
    assert_eq!(
        read["drafts"]
            .as_array()
            .unwrap()
            .iter()
            .map(id_of)
            .collect::<Vec<_>>(),
        vec![aside]
    );
}

// 9. Agent-authored payloads.

/// A unit an agent writes in words with one meaning is saved as its symbol
/// and the change reported; any other unit is refused, never stored as if
/// something could convert it.
#[test]
fn agent_units_are_symbols_or_refused() {
    let mut f = fixture();
    let created = f.agent(
        "artifact.create_draft",
        json!({"type": "requirement", "title": "Slope", "payload": {
            "statement": "Climb a 15 degree ramp", "acceptanceCriterion": "Climbs it",
            "target": {"value": 15, "unit": "degree"}}}),
    );
    assert_eq!(
        created["revision"]["payload"]["target"],
        json!({"value": 15, "unit": "deg"})
    );
    assert_eq!(
        created["notes"],
        json!(["payload.target.unit: read \"degree\" as deg"])
    );
    let assumed = f.agent(
        "artifact.create_draft",
        json!({"type": "assumption", "title": "Run time", "payload": {
            "statement": "One charge lasts 40 minutes", "reason": "Bench run", "owner": "agent",
            "value": {"value": 40, "unit": "Minutes"}}}),
    );
    assert_eq!(assumed["revision"]["payload"]["value"]["unit"], "min");
    let part = f.agent(
        "artifact.create_draft",
        json!({"type": "component", "title": "Servo", "payload": {"partNumber": "MG996R",
            "properties": {"mass": {"quantity": {"value": 55, "unit": "grams"}}}}}),
    );
    assert_eq!(
        part["revision"]["payload"]["properties"]["mass"]["quantity"]["unit"],
        "g"
    );
    let candidate = f.agent(
        "component.add_candidate",
        json!({"title": "Motor", "manufacturer": "Acme", "partNumber": "M-1",
            "offer": {"seller": "Acme", "url": "https://shop.example.test/m-1"},
            "properties": {"mass": {"quantity": {"value": 0.1, "unit": "kilograms"}}}}),
    );
    assert_eq!(
        candidate["revision"]["payload"]["properties"]["mass"]["quantity"]["unit"],
        "kg"
    );
    assert_eq!(
        candidate["notes"],
        json!(["properties.mass.quantity.unit: read \"kilograms\" as kg"])
    );
    let wiring = f.agent(
        "artifact.create_draft",
        json!({"type": "wiring", "title": "Harness", "payload": {}}),
    );
    let pins = f.agent(
        "wiring.set_pins",
        json!({"artifactId": wiring["artifact"]["id"], "pins": [{
            "componentArtifactId": part["artifact"]["id"], "pin": "V+", "type": "power",
            "voltageRange": {"min": {"value": 4.8, "unit": "volts"}, "max": {"value": 6, "unit": "V"}}}]}),
    );
    assert_eq!(
        pins["payload"]["pins"][0]["voltageRange"]["min"]["unit"],
        "V"
    );
    assert_eq!(
        pins["notes"],
        json!(["pins[0].voltageRange.min.unit: read \"volts\" as V"])
    );
    // A symbol the table reads stays as written.
    let kept = f.agent(
        "artifact.update_draft",
        json!({"artifactId": created["artifact"]["id"], "payload": {
            "statement": "Climb a 15 degree ramp", "acceptanceCriterion": "Climbs it",
            "target": {"value": 0.26, "unit": "rad"}}}),
    );
    assert!(kept.get("notes").is_none(), "{kept}");

    let artifacts = f.count("SELECT COUNT(*) FROM artifact");
    for (unit, expected) in [
        ("pounds", Some("lb (mass) or lbf (force)")),
        ("furlongs", None),
    ] {
        let refused = f
            .call(
                agent(),
                "artifact.create_draft",
                json!({"type": "requirement", "title": "Payload", "payload": {
                    "statement": "Carry the camera", "acceptanceCriterion": "Carries it",
                    "target": {"value": 2, "unit": unit}}}),
            )
            .unwrap_err();
        assert_eq!(refused.code, "INVALID_UNITS", "{unit}");
        assert_eq!(
            refused.message,
            format!("Unknown unit '{unit}' at payload.target.unit")
        );
        let details = refused.details.as_deref().unwrap();
        assert_eq!(details["issues"][0]["path"], "payload.target.unit");
        assert_eq!(details["issues"][0]["expected"].as_str(), expected);
        assert!(refused.repair.unwrap().contains("kg, g, mm"));
    }
    let refused = f
        .call(
            agent(),
            "component.add_candidate",
            json!({"title": "Wheel", "manufacturer": "Acme", "partNumber": "W-1",
                "source": {"url": "https://shop.example.test/w-1", "title": "Wheel"},
                "properties": {"mass": {"quantity": {"value": 3, "unit": "ounces"}}}}),
        )
        .unwrap_err();
    assert_eq!(refused.code, "INVALID_UNITS");
    // Nothing was written, not even the source the call would have captured.
    assert_eq!(f.count("SELECT COUNT(*) FROM artifact"), artifacts);
}

#[test]
fn an_undeclared_key_in_an_agent_payload_is_rejected_with_the_nearest_key() {
    let mut f = fixture();
    let input = json!({"type": "requirement", "title": "Supply", "payload": {
        "statement": "Operate from 12 V.", "acceptanceCriterion": "Runs at 12 V.",
        "acceptanceCriteria": "prose that would vanish"}});
    let error = f
        .call(agent(), "artifact.create_draft", input.clone())
        .unwrap_err();
    assert_eq!(error.code, "VALIDATION");
    let issues = error.issues();
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].path, "acceptanceCriteria");
    assert_eq!(issues[0].nearest.as_deref(), Some("acceptanceCriterion"));
    assert!(error.repair.unwrap().contains("tool_describe"));
    assert_eq!(f.count("SELECT COUNT(*) FROM artifact"), 0);

    // The interface keeps its lenient reading of the same payload.
    let created = f.user("artifact.create_draft", input);
    assert!(created["revision"]["payload"]
        .get("acceptanceCriteria")
        .is_none());
    assert!(created.get("notes").is_none());

    let artifact = text(&created["artifact"]["id"]);
    let error = f
        .call(
            agent(),
            "artifact.update_draft",
            json!({"artifactId": artifact, "payload": {"statement": "Operate from 12 V.", "acceptanceCriterion": "Runs.", "rational": "why"}}),
        )
        .unwrap_err();
    assert_eq!(error.code, "VALIDATION");
    assert_eq!(error.issues()[0].path, "rational");
}

#[test]
fn requirement_features_survive_ui_and_agent_writes() {
    let mut f = fixture();
    let features = json!([
        {"label": "Groove bottom Ø50 at z = 8", "quantity": {"value": 50, "unit": "mm"},
         "expect": {"sections": [{"axis": "z", "at": 8, "outer": {"d": 50}}]}},
        {"label": "Both flanks straight"}]);
    let payload = json!({"statement": "A V-groove at z = 8.", "acceptanceCriterion": "Measured.",
        "priority": "must", "features": features});
    let created = f.agent(
        "artifact.create_draft",
        json!({"type": "requirement", "title": "V-groove", "payload": payload}),
    );
    assert_eq!(created["revision"]["payload"]["features"], features);
    let artifact = text(&created["artifact"]["id"]);
    // A person's edit of another field keeps them, as the stage form sends
    // the recorded payload back.
    let mut edited = payload.clone();
    edited["statement"] = json!("A symmetric V-groove at z = 8.");
    let updated = f.user(
        "artifact.update_draft",
        json!({"artifactId": artifact, "payload": edited}),
    );
    assert_eq!(updated["revision"]["payload"]["features"], features);
    // An assertion the checker would not read is refused on write, with its path.
    let mut wrong = payload.clone();
    wrong["features"][0]["expect"]["sections"][0]["outer"]["diameter"] = json!(50);
    let error = f
        .call(
            agent(),
            "artifact.update_draft",
            json!({"artifactId": artifact, "payload": wrong}),
        )
        .unwrap_err();
    assert_eq!(error.code, "VALIDATION");
    assert_eq!(
        error.issues()[0].path,
        "payload.features[0].expect.sections[0].outer.diameter"
    );
    let error = f
        .call(
            Origin::User,
            "artifact.update_draft",
            json!({"artifactId": artifact, "payload": wrong}),
        )
        .unwrap_err();
    assert_eq!(error.code, "VALIDATION");
    // Labels are short: the words of one dimension or feature.
    let mut long = payload;
    long["features"][1]["label"] = json!("x".repeat(201));
    let error = f
        .call(
            agent(),
            "artifact.update_draft",
            json!({"artifactId": artifact, "payload": long}),
        )
        .unwrap_err();
    assert_eq!(error.code, "VALIDATION");
}

#[test]
fn lossless_repairs_to_an_agent_payload_are_reported_in_notes() {
    let mut f = fixture();
    let created = f.agent(
        "artifact.create_draft",
        json!({"type": "requirement", "title": "Supply", "payload": {
            "statement": "Operate from 12 V.", "acceptance_criterion": "Runs at 12 V.", "target": "12 V"}}),
    );
    assert_eq!(
        created["revision"]["payload"]["acceptanceCriterion"],
        "Runs at 12 V."
    );
    assert_eq!(
        created["revision"]["payload"]["target"],
        json!({"value": 12, "unit": "V"})
    );
    let notes = created["notes"].as_array().unwrap();
    assert_eq!(notes.len(), 2, "{notes:?}");
    assert!(notes
        .iter()
        .any(|note| text(note).contains("acceptance_criterion")));
    assert!(notes.iter().any(|note| text(note).contains("12 V")));

    let artifact = text(&created["artifact"]["id"]);
    let updated = f.agent(
        "artifact.update_draft",
        json!({"artifactId": artifact, "payload": {
            "statement": "Operate from 12 V.", "acceptanceCriterion": "Runs at 12 V.", "target": "13.2 V"}}),
    );
    assert_eq!(updated["revision"]["payload"]["target"]["value"], 13.2);
    assert_eq!(updated["notes"].as_array().unwrap().len(), 1);
    let retitled = f.agent(
        "artifact.update_draft",
        json!({"artifactId": artifact, "title": "Supply voltage"}),
    );
    assert!(retitled.get("notes").is_none());
}

// 10. Atomic mutations and what happens after the commit.

#[test]
fn a_direct_edit_or_revert_that_cannot_complete_leaves_no_trace() {
    let mut f = fixture();
    let (note, n1) = f.baseline_note("Note", "v1");
    let n2 = f.edit(&note, &n1, "v2");
    let revisions = f.count("SELECT COUNT(*) FROM revision");
    let events = f.count("SELECT COUNT(*) FROM event");

    f.fail_inserts_into("decision");
    let edit = f
        .call(
            Origin::User,
            "artifact.apply_edit",
            json!({"artifactId": note, "baseRevisionId": n2, "payload": {"markdown": "v3"}}),
        )
        .unwrap_err();
    assert_eq!(edit.code, "INTERNAL");
    let revert = f
        .call(
            Origin::User,
            "artifact.revert",
            json!({"artifactId": note, "toRevisionId": n1}),
        )
        .unwrap_err();
    assert_eq!(revert.code, "INTERNAL");
    assert_eq!(f.count("SELECT COUNT(*) FROM revision"), revisions);
    assert_eq!(f.count("SELECT COUNT(*) FROM event"), events);
    assert_eq!(f.selected(&note), n2);

    f.stop_failing("decision");
    let n3 = f.edit(&note, &n2, "v3");
    assert_eq!(f.selected(&note), n3);
    assert_eq!(f.count("SELECT COUNT(*) FROM revision"), revisions + 1);
}

#[test]
fn a_proposal_that_cannot_be_recorded_changes_no_revision() {
    let mut f = fixture();
    let (note, n1) = f.draft_note("Note", "content");
    f.fail_inserts_into("proposal");
    assert!(f
        .call(
            agent(),
            "proposal.submit",
            json!({"changes": [change(&note, &n1, None)], "reason": "review"}),
        )
        .is_err());
    assert_eq!(f.review_state(&note, &n1), "draft");
    assert!(f.events_of("proposal.submitted").is_empty());
}

#[test]
fn a_working_file_that_cannot_be_written_is_a_warning_on_a_saved_draft() {
    let mut f = fixture();
    let project = f.project_id.clone();
    // `artifacts/research` is a directory, so no file can be written there.
    let input = json!({"type": "note", "title": "Log", "payload": {"markdown": "log"},
        "files": [{"path": "artifacts/research", "contentBase64": encode("content")}]});
    let created = f
        .app
        .dispatch_idempotent(
            "artifact.create_draft",
            input.clone(),
            agent(),
            Some(&project),
            Some("log-1"),
        )
        .unwrap();
    let warnings = created["warnings"].as_array().unwrap();
    assert_eq!(warnings.len(), 1);
    assert!(
        text(&warnings[0]).contains("artifacts/research"),
        "{warnings:?}"
    );
    assert!(text(&warnings[0]).starts_with("The revision is saved"));
    assert_eq!(
        created["revision"]["files"][0]["path"],
        "artifacts/research"
    );
    assert_eq!(f.count("SELECT COUNT(*) FROM artifact"), 1);
    // The saved call replays as the success it was, warning included.
    let replay = f
        .app
        .dispatch_idempotent(
            "artifact.create_draft",
            input,
            agent(),
            Some(&project),
            Some("log-1"),
        )
        .unwrap();
    assert_eq!(replay["revision"]["id"], created["revision"]["id"]);
    assert_eq!(replay["warnings"], created["warnings"]);
    assert_eq!(f.count("SELECT COUNT(*) FROM artifact"), 1);
}

#[test]
fn a_file_changed_outside_the_app_is_left_alone_and_said_so() {
    let mut f = fixture();
    let path = "artifacts/research/log.txt";
    let created = f.agent(
        "artifact.create_draft",
        json!({"type": "note", "title": "Log", "payload": {"markdown": "log"},
            "files": [{"path": path, "contentBase64": encode("one")}]}),
    );
    assert!(created.get("warnings").is_none());
    fs::write(f.root().join(path), "edited by hand").unwrap();
    let updated = f.agent(
        "artifact.update_draft",
        json!({"artifactId": created["artifact"]["id"], "files": [{"path": path, "contentBase64": encode("two")}]}),
    );
    let warning = text(&updated["warnings"][0]);
    assert!(warning.contains("changed outside Omen Flow"), "{warning}");
    assert_eq!(
        fs::read_to_string(f.root().join(path)).unwrap(),
        "edited by hand"
    );
    let beside = fs::read_dir(f.root().join("artifacts/research"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .find(|name| name.starts_with("log.txt.omenflow-conflict-"))
        .unwrap();
    assert!(warning.contains(&beside));
    assert_eq!(
        fs::read_to_string(f.root().join("artifacts/research").join(beside)).unwrap(),
        "two"
    );
}

// 11. Agent writes that take effect without review are attributed.

#[test]
fn links_added_by_an_agent_are_recorded_with_their_origin_and_session() {
    let mut f = fixture();
    let (requirement, _) = f.draft_note("Requirement", "must");
    let (test, _) = f.draft_note("Test", "checks");
    let added = f.agent(
        "graph.propose_edges",
        json!({"edges": [{"upstreamArtifactId": requirement, "downstreamArtifactId": test, "relationship": "validates"}]}),
    );
    assert_eq!(added["edges"][0]["createdBy"], "agent");
    let event = f.events_of("graph.changed").pop().unwrap();
    assert_eq!(event["origin"], "agent");
    assert_eq!(event["data"]["sessionId"], SESSION);
    assert_eq!(event["data"]["added"][0]["id"], added["edges"][0]["id"]);
    let listed = f.user("graph.list", json!({}));
    assert_eq!(listed["edges"][0]["createdBy"], "agent");

    // A refused batch records nothing.
    assert_eq!(
        f.call(
            agent(),
            "graph.propose_edges",
            json!({"edges": [{"upstreamArtifactId": test, "downstreamArtifactId": requirement, "relationship": "depends_on"}]}),
        )
        .unwrap_err()
        .code,
        "CYCLE_DETECTED"
    );
    assert_eq!(f.events_of("graph.changed").len(), 1);
}

#[test]
fn a_link_can_be_removed_again_by_whoever_may_remove_it() {
    let mut f = fixture();
    let (requirement, r1) = f.baseline_note("Requirement", "must");
    let (test, _) = f.draft_note("Test", "checks");
    let edge = |upstream: &str, downstream: &str| json!({"edges": [{"upstreamArtifactId": upstream, "downstreamArtifactId": downstream, "relationship": "validates"}]});
    let added = f.agent("graph.propose_edges", edge(&requirement, &test));
    let by_agent = text(&added["edges"][0]["id"]);
    assert_eq!(added["undo"]["tool"], "graph_remove_edges");
    assert_eq!(added["undo"]["args"], json!({"edgeIds": [by_agent]}));
    let (other, _) = f.draft_note("Other test", "checks");
    let by_person =
        text(&f.user("graph.propose_edges", edge(&requirement, &other))["edges"][0]["id"]);
    // A link that mirrors a recorded input of an approved revision.
    let derived = f.agent(
        "artifact.create_draft",
        json!({"type": "note", "title": "Derived", "payload": {"markdown": "from the requirement"},
            "inputs": [{"artifactId": requirement, "revisionId": r1}]}),
    );
    f.accept(
        &text(&derived["artifact"]["id"]),
        &text(&derived["revision"]["id"]),
    );
    let edges = f.user("graph.list", json!({}))["edges"].clone();
    let recorded = text(
        &edges
            .as_array()
            .unwrap()
            .iter()
            .find(|edge| !edge["requiredUpstreamRevisionId"].is_null())
            .unwrap()["id"],
    );

    let denied = f
        .call(
            agent(),
            "graph.remove_edges",
            json!({"edgeIds": [by_agent, by_person]}),
        )
        .unwrap_err();
    assert_eq!(denied.code, "CAPABILITY_DENIED", "{denied:?}");
    assert!(denied.repair.unwrap().contains("added by a person"));
    let refused = f
        .call(
            Origin::User,
            "graph.remove_edges",
            json!({"edgeIds": [recorded]}),
        )
        .unwrap_err();
    assert_eq!(refused.code, "VALIDATION");
    let missing = f
        .call(
            agent(),
            "graph.remove_edges",
            json!({"edgeIds": [uuid::Uuid::new_v4().to_string()]}),
        )
        .unwrap_err();
    assert_eq!(missing.code, "NOT_FOUND");
    // Nothing was removed by the refused calls, the first id included.
    assert_eq!(
        f.user("graph.list", json!({}))["edges"]
            .as_array()
            .unwrap()
            .len(),
        3
    );

    let removed = f.agent("graph.remove_edges", json!({"edgeIds": [by_agent]}));
    assert_eq!(removed["removed"][0]["id"], by_agent);
    let event = f.events_of("graph.changed").pop().unwrap();
    assert_eq!(event["origin"], "agent");
    assert_eq!(event["data"]["removed"][0]["id"], by_agent);
    assert_eq!(event["data"]["sessionId"], SESSION);
    f.user("graph.remove_edges", json!({"edgeIds": [by_person]}));
    let left = f.user("graph.list", json!({}))["edges"].clone();
    assert_eq!(left.as_array().unwrap().len(), 1);
    assert_eq!(left[0]["id"], recorded);
}

#[test]
fn a_rename_made_through_a_draft_is_recorded_with_the_title_it_replaced() {
    let mut f = fixture();
    let (note, _) = f.baseline_note("Motor mount", "content");
    f.agent(
        "artifact.update_draft",
        json!({"artifactId": note, "title": "Motor bracket"}),
    );
    let event = f.events_of("artifact.renamed").pop().unwrap();
    assert_eq!(event["origin"], "agent");
    assert_eq!(
        event["data"],
        json!({"artifactId": note, "title": "Motor bracket", "previousTitle": "Motor mount", "sessionId": SESSION})
    );
    // Sending the title it already has is not a rename.
    f.agent(
        "artifact.update_draft",
        json!({"artifactId": note, "title": "Motor bracket", "payload": {"markdown": "more"}}),
    );
    assert_eq!(f.events_of("artifact.renamed").len(), 1);
    // The person can put it back with a direct edit.
    let baseline = text(&f.selected(&note));
    f.user(
        "artifact.apply_edit",
        json!({"artifactId": note, "baseRevisionId": baseline, "title": "Motor mount"}),
    );
    let back = f.events_of("artifact.renamed").pop().unwrap();
    assert_eq!(back["origin"], "user");
    assert_eq!(back["data"]["previousTitle"], "Motor bracket");
}
