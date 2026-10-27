//! A source write with `expect`: cad_write_source, cad_patch_source or
//! cad_set_param saves and renders a revision, then cad_check checks exactly
//! that revision with autoCommit, in the one call the agent made. And the
//! session's work status on every reply that committed a check, so a reply
//! that says ready needs no work_status call after it.
//!
//! Nothing here judges anything: the check is the core's cad_check and the
//! status is the core's work_status, each reported as it came back. The
//! call's ledger record lists both under `alsoRan`, as run by the host.

use super::{dispatch_core, parse_agent, present, AlsoRan, CallTrace, Grant, Shared};
use bureau_contracts::{registry, ContractError, Operation};
use serde_json::{json, Value};

/// Operations that take `expect` and check the revision they saved.
pub(crate) const CHECKED_WRITES: [&str; 3] =
    ["cad.write_source", "cad.patch_source", "cad.set_param"];

/// The artifact id `expect` is validated with for a part that has none yet.
/// It only completes cad_check's input for validation; nothing is sent with it.
const NEW_PART: &str = "00000000-0000-4000-8000-000000000000";

/// Blockers a digest names; its summary counts every one.
const DIGEST_BLOCKERS: usize = 3;

/// What a reply says instead of "call work_status" when the work status it
/// carries is ready, for the scope it covered. Recorded work is all the gate
/// knows, so it never says the request is done.
macro_rules! ready {
    ($scope:literal) => {
        concat!(
            "workStatus.ready is true: nothing recorded in ",
            $scope,
            " blocks. Do the rest of the request if any; otherwise give your final answer, mention workStatus.summary, and say the work is a draft awaiting the person's review."
        )
    };
}

/// [`ready!`] for a work status of one session.
pub(crate) const READY: &str = ready!("this session");

/// [`ready!`] for a conversation continuation's, which read the sessions of
/// the turns it continues with its own (`workStatus.sessionIds`).
pub(crate) const READY_CONTINUED: &str =
    ready!("this session or the turns it continues (workStatus.sessionIds)");

/// What a reply says instead of "call work_status" when the work status it
/// carries is not ready and its first blocker names no call.
const NOT_READY: &str = "workStatus.ready is false: make the next call each blocker names, or name the blockers you cannot resolve.";

fn check_op() -> &'static Operation {
    registry()
        .operation("cad.check")
        .expect("cad.check is in the registry")
}

/// Take `expect` out of a checked write's input and validate it as cad_check
/// would, with the same repairs and refusals, before anything is written.
/// `Ok(None)`: an ordinary write.
pub(crate) fn take_expect(
    op: &Operation,
    input: &mut Value,
    trace: &mut CallTrace,
) -> Result<Option<Value>, ContractError> {
    if !CHECKED_WRITES.contains(&op.name.as_str()) {
        return Ok(None);
    }
    let Some(expect) = input
        .as_object_mut()
        .and_then(|fields| fields.remove("expect"))
    else {
        return Ok(None);
    };
    let artifact_id = input["artifactId"].as_str().unwrap_or(NEW_PART);
    let probe = json!({"artifactId": artifact_id, "expect": expect});
    let parsed =
        parse_agent(check_op(), probe, trace).map_err(|error| as_write_error(op, error))?;
    Ok(Some(parsed["expect"].clone()))
}

/// A validation error from cad_check's schema, told as the write's own: the
/// paths already read `expect…`; the tool, the retry hint and the example
/// become the write's.
fn as_write_error(op: &Operation, mut error: ContractError) -> ContractError {
    let check = check_op();
    if let Some(repair) = error.repair.take() {
        error.repair = Some(repair.replace(
            &format!("Then call {} again.", check.tool_name),
            &format!("Then call {} again.", op.tool_name),
        ));
    }
    if let Some(details) = error.details.as_deref_mut() {
        details["op"] = json!(op.name);
        details["tool"] = json!(op.tool_name);
        match &op.example {
            Some(example) => details["example"] = example.clone(),
            None => {
                if let Some(fields) = details.as_object_mut() {
                    fields.remove("example");
                }
            }
        }
    }
    error
}

/// The write, then, when it rendered, cad_check of the revision it saved.
/// A failing check is a successful call: the revision is saved either way.
pub(crate) fn run(
    shared: &Shared,
    grant: &Grant,
    op: &Operation,
    input: &Value,
    expect: Value,
    idempotency_key: Option<&str>,
    trace: &mut CallTrace,
) -> Result<Value, ContractError> {
    let write = dispatch_core(shared, grant, op, input.clone(), idempotency_key)?;
    if write["render"]["ok"] != true {
        return Ok(unchecked(write));
    }
    // Pinned to the saved revision, so an edit made meanwhile is never the
    // one checked; the check reads the render the write stored.
    let mut check_input = json!({
        "artifactId": write["artifactId"],
        "revisionId": write["revisionId"],
        "expect": expect,
        "autoCommit": true,
    });
    for key in ["detail", "timeoutMs"] {
        if let Some(value) = input.get(key) {
            check_input[key] = value.clone();
        }
    }
    // A key of its own: a retried call replays the check as well as the
    // write, and a key the agent later sends with cad_check names only that
    // call.
    let key = idempotency_key.map(|key| format!("{key}#check"));
    let check = dispatch_core(shared, grant, check_op(), check_input, key.as_deref());
    trace.also_ran.push(check_ran(&check));
    Ok(merge(write, check))
}

/// The ledger's account of the check a write ran.
fn check_ran(check: &Result<Value, ContractError>) -> AlsoRan {
    let ran = AlsoRan {
        tool: "cad_check".to_owned(),
        op: "cad.check".to_owned(),
        ..AlsoRan::default()
    };
    match check {
        Ok(check) => AlsoRan {
            ok: true,
            replayed: (check["idempotent"] == true).then_some(true),
            verification_status: check["verificationStatus"].as_str().map(str::to_owned),
            committed: check["committed"].as_bool(),
            passed: check["passed"].as_u64(),
            total: check["total"].as_u64(),
            ..ran
        },
        Err(error) => AlsoRan {
            code: Some(error.code.clone()),
            ..ran
        },
    }
}

/// A write whose render failed: nothing was checked, and it is not ready.
/// The write's own next step (fix the source) stands.
fn unchecked(mut write: Value) -> Value {
    write["ready"] = json!(false);
    write["check"] = json!({"skipped": "The render failed, so nothing was checked. Fix the source and send it again with the same expect."});
    write
}

/// One reply for the write and its check: the write's report, the check's
/// outcome on top (ready, verificationStatus, nextAction, next, nextStep)
/// and the rest of the check under `check`. `ready` is true only when the
/// check said so.
pub(crate) fn merge(mut write: Value, check: Result<Value, ContractError>) -> Value {
    let Some(fields) = write.as_object_mut() else {
        return write;
    };
    // A full report gives the next step as text plus `nextStep`; a brief one
    // as the step itself.
    let full = fields.contains_key("nextStep");
    for key in ["nextAction", "nextStep", "next"] {
        fields.remove(key);
    }
    match check {
        Ok(Value::Object(mut check)) => {
            check.remove("artifactId");
            check.remove("revisionId");
            let ready = check.remove("ready") == Some(json!(true));
            fields.insert("ready".into(), json!(ready));
            fields.insert(
                "verificationStatus".into(),
                check.remove("verificationStatus").unwrap_or(Value::Null),
            );
            for key in ["nextAction", "next", "nextStep"] {
                if let Some(value) = check.remove(key) {
                    fields.insert(key.into(), value);
                }
            }
            fields.insert("check".into(), Value::Object(check));
        }
        Ok(other) => {
            fields.insert("ready".into(), json!(false));
            fields.insert("check".into(), other);
        }
        Err(error) => {
            let again = json!({"artifactId": fields.get("artifactId"), "revisionId": fields.get("revisionId"), "autoCommit": true});
            fields.insert("ready".into(), json!(false));
            fields.insert(
                "check".into(),
                json!({"error": {"code": error.code, "message": error.message, "repair": error.repair}}),
            );
            let why = "The part was saved but not checked (see check.error): check this revision with the same expect, corrected if check.error names it, and autoCommit true.";
            let step = json!({"tool": "cad_check", "why": why, "args": again});
            fields.insert("nextAction".into(), json!("commit_assertions"));
            if full {
                fields.insert("next".into(), json!(why));
                fields.insert("nextStep".into(), step);
            } else {
                fields.insert("next".into(), step);
            }
        }
    }
    write
}

/// Put the session's work status on a reply that committed a check:
/// `{scope, ready, summary, blockers}` from work_status, as the agent would
/// get it (for a conversation continuation, over the turns it continues
/// too, named in `sessionIds`). A reply that pointed at work_status points
/// past it.
pub(crate) fn attach_work_status(
    shared: &Shared,
    grant: &Grant,
    op: &Operation,
    result: &mut Value,
    trace: &mut CallTrace,
) {
    let committed = match op.name.as_str() {
        "cad.check" => result["committed"] == true,
        name if CHECKED_WRITES.contains(&name) => result["check"]["committed"] == true,
        _ => false,
    };
    if !committed || !result.is_object() {
        return;
    }
    let Some(status_op) = registry().operation("work.status") else {
        return;
    };
    // A status that cannot be read is left out; the agent then calls
    // work_status itself, as it always could. Read as the agent's own call
    // would be, so a conversation continuation's covers the turns it
    // continues.
    let Ok(status) = super::work_status(shared, grant, &json!({})) else {
        return;
    };
    let mut digest = digest(&status);
    present::callable_next(&mut digest, grant.profile, 0);
    trace.also_ran.push(AlsoRan {
        tool: status_op.tool_name.clone(),
        op: status_op.name.clone(),
        ok: true,
        scope: status["scope"].as_str().map(str::to_owned),
        ready: status["ready"].as_bool(),
        blockers: status["counts"]["blockers"].as_u64(),
        sessions: status["sessionIds"]
            .as_array()
            .map(|sessions| sessions.len() as u64),
        ..AlsoRan::default()
    });
    point_past_work_status(result, &digest);
    result["workStatus"] = digest;
}

/// A `next` or `nextStep` that names work_status asks for the answer the
/// reply now carries. Ready: say so, and that the request may hold more.
/// Not ready: the first blocker's own next call.
fn point_past_work_status(result: &mut Value, digest: &Value) {
    let instead = if digest["ready"] == true {
        let chain = digest["sessionIds"]
            .as_array()
            .is_some_and(|sessions| sessions.len() > 1);
        json!({"tool": null, "why": if chain { READY_CONTINUED } else { READY }})
    } else {
        digest["blockers"][0]["next"]
            .as_object()
            .filter(|next| next.get("tool").is_some_and(Value::is_string))
            .map_or_else(
                || json!({"tool": null, "why": NOT_READY}),
                |next| Value::Object(next.clone()),
            )
    };
    for key in ["next", "nextStep"] {
        if result[key]["tool"] == "work_status" {
            result[key] = instead.clone();
        }
    }
}

/// The part of a work_status answer a check reply carries, with the
/// sessions it covers when the answer names them (a conversation
/// continuation's).
pub(crate) fn digest(status: &Value) -> Value {
    let blockers = status["outstanding"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item["severity"] == "blocker")
        .take(DIGEST_BLOCKERS)
        .map(|item| {
            json!({"kind": item["kind"], "artifactId": item["artifactId"], "title": item["title"], "next": item["next"]})
        })
        .collect::<Vec<_>>();
    let mut digest = json!({"scope": status["scope"], "ready": status["ready"], "summary": status["summary"], "blockers": blockers});
    if let Some(sessions) = status.get("sessionIds").filter(|ids| ids.is_array()) {
        digest["sessionIds"] = sessions.clone();
    }
    digest
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_reply() -> Value {
        json!({"artifactId": "a", "revisionId": "r", "render": {"ok": true}, "size": [20, 10, 2],
               "notes": [], "nextAction": "commit_assertions",
               "next": {"tool": "cad_check", "why": "Measurements are not verification."}})
    }

    #[test]
    fn a_brief_check_is_merged_on_top_of_the_write() {
        let check = json!({"artifactId": "a", "revisionId": "r", "ready": true,
            "verificationStatus": "passed", "committed": true, "passed": 3, "total": 3,
            "failed": [], "nextAction": "request_review",
            "next": {"tool": "work_status", "why": "Confirm nothing else is outstanding."}});
        let merged = merge(write_reply(), Ok(check));
        assert_eq!(
            merged,
            json!({"artifactId": "a", "revisionId": "r", "render": {"ok": true}, "size": [20, 10, 2],
                   "notes": [], "ready": true, "verificationStatus": "passed",
                   "nextAction": "request_review",
                   "next": {"tool": "work_status", "why": "Confirm nothing else is outstanding."},
                   "check": {"committed": true, "passed": 3, "total": 3, "failed": []}})
        );
    }

    #[test]
    fn a_full_check_keeps_its_text_and_its_step() {
        let check = json!({"artifactId": "a", "revisionId": "r", "ready": false,
            "verificationStatus": "failed", "committed": false, "checks": [{"name": "size", "pass": false}],
            "nextAction": "repair_geometry", "next": "Trial failed: 1 of 3 assertions.",
            "nextStep": {"tool": "cad_write_source", "why": "Fix the failing geometry."}});
        let merged = merge(write_reply(), Ok(check));
        assert_eq!(merged["ready"], false);
        assert_eq!(merged["verificationStatus"], "failed");
        assert_eq!(merged["next"], "Trial failed: 1 of 3 assertions.");
        assert_eq!(merged["nextStep"]["tool"], "cad_write_source");
        assert_eq!(merged["check"]["checks"][0]["name"], "size");
        assert!(merged["check"].get("artifactId").is_none());
        // `ready` is the check's only when it is literally true.
        let odd = merge(write_reply(), Ok(json!({"ready": "yes"})));
        assert_eq!(odd["ready"], false);
    }

    #[test]
    fn a_check_that_did_not_run_says_the_part_is_saved_and_how_to_check_it() {
        let error = ContractError::new("INPUT_CHANGED", "The part changed while it was checked")
            .with_repair("Check it again.");
        let merged = merge(write_reply(), Err(error));
        assert_eq!(merged["ready"], false);
        assert_eq!(merged["check"]["error"]["code"], "INPUT_CHANGED");
        assert_eq!(merged["nextAction"], "commit_assertions");
        assert_eq!(
            merged["next"]["args"],
            json!({"artifactId": "a", "revisionId": "r", "autoCommit": true})
        );
        assert_eq!(merged["next"]["tool"], "cad_check");
        assert!(merged.get("verificationStatus").is_none());
        // A full report keeps its form: text, and the step beside it.
        let mut full = write_reply();
        full["nextStep"] = full["next"].take();
        full["next"] = json!("Compare these measurements with the request.");
        let merged = merge(
            full,
            Err(ContractError::new("CANCELLED", "The check was cancelled")),
        );
        assert!(merged["next"]
            .as_str()
            .unwrap()
            .starts_with("The part was saved"));
        assert_eq!(merged["nextStep"]["tool"], "cad_check");
        let ran = check_ran(&Err(ContractError::new("CANCELLED", "stopped")));
        assert_eq!((ran.ok, ran.code.as_deref()), (false, Some("CANCELLED")));
    }

    #[test]
    fn a_digest_names_the_first_blockers_and_counts_them_all() {
        let item = |n: u64, severity: &str| {
            json!({"kind": "cad_unverified", "severity": severity, "artifactId": format!("a{n}"),
                   "title": format!("Part {n}"), "detail": "long detail",
                   "next": {"tool": "cad_check", "why": "Check it.", "args": {"artifactId": format!("a{n}")}}})
        };
        let status = json!({"ready": false, "scope": "session", "summary": "4 parts are not verified.",
            "outstanding": [item(1, "blocker"), item(2, "advice"), item(3, "blocker"), item(4, "blocker"), item(5, "blocker")],
            "counts": {"blockers": 4}});
        let digest = digest(&status);
        assert_eq!(digest["summary"], "4 parts are not verified.");
        assert_eq!(digest["scope"], "session");
        let ids = digest["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|blocker| blocker["artifactId"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(ids, ["a1", "a3", "a4"]);
        assert!(digest["blockers"][0].get("detail").is_none());
        assert!(
            digest.get("sessionIds").is_none(),
            "an ordinary session's answer names no sessions"
        );
        // A conversation continuation's answer names the sessions it read.
        let mut continued = status;
        continued["sessionIds"] = json!(["s1", "s2"]);
        assert_eq!(super::digest(&continued)["sessionIds"], json!(["s1", "s2"]));
    }

    #[test]
    fn a_reply_that_pointed_at_work_status_points_past_it() {
        let to_status =
            json!({"tool": "work_status", "why": "Confirm nothing else is outstanding."});
        let mut brief = json!({"next": to_status});
        point_past_work_status(&mut brief, &json!({"ready": true, "blockers": []}));
        assert_eq!(brief["next"], json!({"tool": null, "why": READY}));
        // The ready text never orders a stop: the gate knows recorded work
        // only, and the request may hold more.
        assert_eq!(
            READY,
            "workStatus.ready is true: nothing recorded in this session blocks. Do the rest of the request if any; otherwise give your final answer, mention workStatus.summary, and say the work is a draft awaiting the person's review."
        );
        // A continuation's digest read the turns it continues too, and says so.
        let mut continued = json!({"next": to_status});
        point_past_work_status(
            &mut continued,
            &json!({"ready": true, "blockers": [], "sessionIds": ["s1", "s2"]}),
        );
        assert_eq!(
            continued["next"],
            json!({"tool": null, "why": READY_CONTINUED})
        );
        assert_eq!(
            READY_CONTINUED,
            "workStatus.ready is true: nothing recorded in this session or the turns it continues (workStatus.sessionIds) blocks. Do the rest of the request if any; otherwise give your final answer, mention workStatus.summary, and say the work is a draft awaiting the person's review."
        );

        let mut full = json!({"next": "Verified.", "nextStep": to_status});
        let blocked = json!({"ready": false, "blockers": [
            {"kind": "cad_unverified", "next": {"tool": "cad_check", "why": "Check it.", "via": "tool_call"}}]});
        point_past_work_status(&mut full, &blocked);
        assert_eq!(full["next"], "Verified.");
        assert_eq!(
            full["nextStep"],
            json!({"tool": "cad_check", "why": "Check it.", "via": "tool_call"})
        );

        let mut waiting = json!({"next": to_status});
        point_past_work_status(
            &mut waiting,
            &json!({"ready": false, "blockers": [{"kind": "changes_requested", "next": null}]}),
        );
        assert_eq!(waiting["next"], json!({"tool": null, "why": NOT_READY}));

        // Any other next step is the check's own and stays.
        let mut fix = json!({"next": {"tool": "cad_write_source", "why": "Fix it."}});
        point_past_work_status(&mut fix, &json!({"ready": true, "blockers": []}));
        assert_eq!(fix["next"]["tool"], "cad_write_source");
    }

    /// A checked write's example is in its description, its `example` and
    /// every VALIDATION reply about its expect, so an agent that copies it
    /// must not be refused again: each one's expect is the spec form
    /// cad_check accepts, and the description shows the same expect.
    #[test]
    fn every_checked_write_example_is_an_expect_cad_check_accepts() {
        assert!(
            check_op().input_schema["properties"]["expect"]["properties"]
                .get("spec")
                .is_some(),
            "cad_check takes expect.spec"
        );
        let mut shown = 0;
        for name in CHECKED_WRITES {
            let op = registry().operation(name).unwrap();
            let Some(example) = op.example.clone() else {
                continue;
            };
            if example.get("expect").is_none() {
                continue;
            }
            shown += 1;
            let described = op
                .description
                .split_once("Example: ")
                .map(|(_, json)| serde_json::from_str::<Value>(json).unwrap());
            if let Some(described) = &described {
                assert_eq!(described["expect"], example["expect"], "{name}");
            }
            for mut input in [Some(example), described].into_iter().flatten() {
                let mut trace = CallTrace {
                    op: name.to_owned(),
                    mutating: true,
                    input: Value::Null,
                    notes: Vec::new(),
                    images: Vec::new(),
                    also_ran: Vec::new(),
                };
                let expect = take_expect(op, &mut input, &mut trace)
                    .unwrap_or_else(|error| panic!("{name}'s example: {error:?}"));
                assert!(expect.is_some_and(|expect| expect.get("spec").is_some()));
                assert!(input.get("expect").is_none(), "taken out of the write");
            }
        }
        assert!(shown > 0, "cad_write_source's example shows expect");
    }
}

/// The plumbing with a stand-in engine: what is saved, checked, replayed and
/// recorded. Geometry is the stand-in's fixed box; nothing here is a claim
/// about OpenSCAD.
#[cfg(all(test, unix))]
mod engine_tests {
    use super::*;
    use crate::test_support::{StandInEngine, Workspace};
    use bureau_contracts::Profile;

    fn setup(name: &str) -> (Workspace, StandInEngine) {
        let workspace = Workspace::new(name);
        let engine = StandInEngine::new(workspace.temp.path(), [20.0, 10.0, 2.0]);
        workspace.user(
            "settings.set",
            json!({"key": "toolPaths.openscad", "value": engine.executable}),
        );
        (workspace, engine)
    }

    fn revisions(workspace: &Workspace, id: &Value) -> usize {
        workspace.user("artifact.history", json!({"artifactId": id}))["revisions"]
            .as_array()
            .unwrap()
            .len()
    }

    fn jobs(workspace: &Workspace) -> usize {
        workspace.user("job.list", json!({}))["jobs"]
            .as_array()
            .unwrap()
            .len()
    }

    #[test]
    fn a_write_with_expect_is_checked_in_the_same_call() {
        let (workspace, engine) = setup("Write and check");
        let mut client = workspace.mcp(Profile::Compact);
        let passing = client.call(
            "cad_write_source",
            json!({"title": "Box", "source": "cube([20, 10, 2]);", "expect": {"size": [20, 10, 2], "bodies": 1}}),
        );
        assert!(!passing.is_error, "{}", passing.text);
        println!(
            "passing reply ({} chars): {}",
            passing.text.len(),
            passing.text
        );
        let body = &passing.body;
        assert_eq!(body["ready"], true);
        assert_eq!(body["verificationStatus"], "passed");
        assert_eq!(body["check"]["committed"], true);
        assert_eq!(body["workStatus"]["ready"], true);
        assert_eq!(body["workStatus"]["scope"], "session");
        assert_eq!(body["next"], json!({"tool": null, "why": READY}));
        assert_eq!(engine.renders(), 1, "the check reads the stored render");
        let recorded = workspace.recorded();
        assert_eq!(recorded.len(), 1, "one call, one record");
        assert_eq!(recorded[0]["op"], "cad.write_source");
        assert_eq!(recorded[0]["notes"], json!([]));
        assert_eq!(
            recorded[0]["alsoRan"],
            json!([
                {"tool": "cad_check", "op": "cad.check", "ok": true, "verificationStatus": "passed",
                 "committed": true, "passed": body["check"]["passed"], "total": body["check"]["total"]},
                {"tool": "work_status", "op": "work.status", "ok": true, "scope": "session",
                 "ready": true, "blockers": 0}
            ])
        );
        assert!(body["check"]["total"].as_u64().unwrap() >= 2);

        let id = body["artifactId"].clone();
        let failing = client.call(
            "cad_write_source",
            json!({"artifactId": id, "source": "cube([20, 10, 2]); // again", "expect": {"size": [40, 30, 4]}}),
        );
        assert!(
            !failing.is_error,
            "a failing check is a saved write: {}",
            failing.text
        );
        assert_eq!(failing.body["ready"], false);
        assert_eq!(failing.body["verificationStatus"], "failed");
        assert_eq!(failing.body["check"]["committed"], false);
        assert!(failing.body.get("workStatus").is_none());
        assert_eq!(failing.body["next"]["tool"], "cad_write_source");
        assert_eq!(engine.renders(), 2);
        assert_eq!(
            workspace.last_recorded()["alsoRan"][0]["verificationStatus"],
            "failed"
        );

        let broken = client.call(
            "cad_write_source",
            json!({"artifactId": id, "source": "FAIL", "expect": {"size": [20, 10, 2]}}),
        );
        assert!(!broken.is_error, "{}", broken.text);
        assert_eq!(broken.body["ready"], false);
        assert!(broken.body["check"]["skipped"].is_string());
        assert_eq!(broken.body["nextAction"], "repair_geometry");
        assert!(
            workspace.last_recorded().get("alsoRan").is_none(),
            "nothing else ran"
        );

        let before = (revisions(&workspace, &id), engine.renders());
        let misspelled = client.call(
            "cad_write_source",
            json!({"artifactId": id, "source": "cube([20, 10, 2]);", "expect": {"sise": [20, 10, 2]}}),
        );
        assert!(misspelled.is_error);
        assert_eq!(misspelled.body["code"], "VALIDATION");
        assert_eq!(
            misspelled.body["message"],
            "Invalid input for cad_write_source: 1 problem, listed in issues."
        );
        assert_eq!(misspelled.body["issues"][0]["path"], "expect.sise");
        assert_eq!(misspelled.body["issues"][0]["nearest"], "size");
        assert!(misspelled.body["repair"]
            .as_str()
            .unwrap()
            .contains("Then call cad_write_source again."));
        assert_eq!(
            misspelled.body["example"],
            *registry()
                .operation("cad.write_source")
                .unwrap()
                .example
                .as_ref()
                .unwrap()
        );
        assert_eq!(
            (revisions(&workspace, &id), engine.renders()),
            before,
            "nothing is written for a refused expect"
        );
        assert_eq!(workspace.last_recorded()["op"], "cad.write_source");
    }

    #[test]
    fn a_retried_call_replays_the_write_and_its_check() {
        let (workspace, engine) = setup("Write and check, retried");
        let mut client = workspace.mcp(Profile::Compact);
        let call = json!({"title": "Box", "source": "cube([20, 10, 2]);",
            "expect": {"size": [20, 10, 2], "bodies": 1}, "idempotencyKey": "k-1"});
        let first = client.call("cad_write_source", call.clone());
        assert_eq!(first.body["ready"], true, "{}", first.text);
        let (renders, jobs_before) = (engine.renders(), jobs(&workspace));
        let again = client.call("cad_write_source", call);
        assert!(!again.is_error, "{}", again.text);
        assert_eq!(again.body["revisionId"], first.body["revisionId"]);
        assert_eq!(again.body["idempotent"], true);
        assert_eq!(again.body["check"]["idempotent"], true);
        assert_eq!(again.body["ready"], true);
        assert_eq!(again.body["workStatus"]["ready"], true);
        assert_eq!(again.body["next"], json!({"tool": null, "why": READY}));
        assert_eq!(
            (engine.renders(), jobs(&workspace)),
            (renders, jobs_before),
            "a replay renders nothing and starts no job"
        );
        assert_eq!(workspace.last_recorded()["alsoRan"][0]["replayed"], true);
        let id = first.body["artifactId"].clone();
        assert_eq!(revisions(&workspace, &id), 1);

        // The same key with another expect: the write replays, the check is
        // refused for the changed payload, and nothing is called ready.
        let changed = client.call(
            "cad_write_source",
            json!({"title": "Box", "source": "cube([20, 10, 2]);",
                   "expect": {"size": [20, 10, 3]}, "idempotencyKey": "k-1"}),
        );
        assert!(!changed.is_error, "{}", changed.text);
        assert_eq!(changed.body["ready"], false);
        assert_eq!(changed.body["check"]["error"]["code"], "VALIDATION");
        assert_eq!(changed.body["next"]["tool"], "cad_check");
        assert!(changed.body.get("workStatus").is_none());

        // The agent's own key on cad_check names only that call.
        let direct = client.call(
            "cad_check",
            json!({"artifactId": id, "autoCommit": true, "expect": {"size": [20, 10, 2], "bodies": 1}, "idempotencyKey": "k-1"}),
        );
        assert!(!direct.is_error, "{}", direct.text);
        assert_eq!(direct.body["ready"], true);
        assert_eq!(revisions(&workspace, &id), 1);
    }

    #[test]
    fn a_committed_check_carries_the_session_work_status() {
        let (workspace, engine) = setup("Digest");
        let mut client = workspace.mcp(Profile::Compact);
        let written = client.call(
            "cad_write_source",
            json!({"title": "Box", "source": "cube([20, 10, 2]);"}),
        );
        assert!(
            written.body.get("workStatus").is_none(),
            "no check, no digest"
        );
        let id = written.body["artifactId"].clone();
        let trial = client.call(
            "cad_check",
            json!({"artifactId": id, "exploratory": true, "expect": {"size": [20, 10, 2]}}),
        );
        assert_eq!(trial.body["committed"], false);
        assert!(
            trial.body.get("workStatus").is_none(),
            "a trial binds nothing"
        );

        // A second part nobody checked: the digest is not ready and the
        // reply points at that part's own next call, routed for compact.
        let other = client.call(
            "cad_write_source",
            json!({"title": "Spacer", "source": "w = 20;\ncube([w, 10, 2]);"}),
        );
        let committed = client.call(
            "cad_check",
            json!({"artifactId": id, "autoCommit": true, "expect": {"size": [20, 10, 2], "bodies": 1}}),
        );
        assert!(!committed.is_error, "{}", committed.text);
        let status = &committed.body["workStatus"];
        assert_eq!(status["ready"], false, "{}", committed.text);
        assert_eq!(
            status["blockers"][0]["artifactId"],
            other.body["artifactId"]
        );
        assert_eq!(committed.body["next"], status["blockers"][0]["next"]);
        assert_eq!(committed.body["next"]["tool"], "cad_check");
        assert_eq!(
            workspace.last_recorded()["alsoRan"],
            json!([{"tool": "work_status", "op": "work.status", "ok": true, "scope": "session",
                    "ready": false, "blockers": status["blockers"].as_array().unwrap().len()}])
        );

        // cad_set_param is not listed for compact; through tool_call it
        // takes expect the same way, and checking the last part leaves
        // nothing recorded that blocks.
        let renders = engine.renders();
        let param = client.call(
            "tool_call",
            json!({"tool": "cad_set_param", "input": {"artifactId": other.body["artifactId"], "name": "w", "value": 21,
                   "expect": {"size": [20, 10, 2], "bodies": 1}}}),
        );
        assert!(!param.is_error, "{}", param.text);
        assert_eq!(param.body["ready"], true);
        assert_eq!(param.body["workStatus"]["ready"], true);
        assert_eq!(param.body["next"], json!({"tool": null, "why": READY}));
        assert_eq!(engine.renders(), renders + 1);
        let recorded = workspace.last_recorded();
        assert_eq!(
            (&recorded["tool"], &recorded["op"]),
            (&json!("tool_call"), &json!("cad.set_param"))
        );
        assert_eq!(recorded["alsoRan"].as_array().unwrap().len(), 2);
    }

    /// A conversation continuation's work_status and its digest cover the
    /// turns it continues: checking one part is not ready while the earlier
    /// turn's other part is unverified, and is once that part is checked. A
    /// new session that continues nothing answers for itself alone.
    #[test]
    fn a_continuations_digest_covers_the_turns_it_continues() {
        let (workspace, _engine) = setup("Continued digest");
        let mut earlier = workspace.mcp(Profile::Compact);
        let written = |client: &mut crate::test_support::McpClient, title: &str| {
            let reply = client.call(
                "cad_write_source",
                json!({"title": title, "source": "cube([20, 10, 2]);"}),
            );
            assert!(!reply.is_error, "{}", reply.text);
            reply.body["artifactId"].clone()
        };
        let (bracket, spacer) = (
            written(&mut earlier, "Bracket"),
            written(&mut earlier, "Spacer"),
        );
        let mut unrelated = workspace.mcp(Profile::Compact);
        let alone = unrelated.call("work_status", json!({}));
        assert_eq!(alone.body["ready"], true, "{}", alone.text);

        let mut continuation =
            workspace.mcp_continuing(Profile::Compact, std::slice::from_ref(&earlier.session_id));
        let status = continuation.call("work_status", json!({}));
        assert_eq!(status.body["ready"], false, "{}", status.text);
        assert_eq!(status.body["summary"], "2 parts are not verified.");
        assert_eq!(
            status.body["sessionIds"],
            json!([earlier.session_id, continuation.session_id])
        );
        let check = |client: &mut crate::test_support::McpClient, id: &Value| {
            let reply = client.call(
                "cad_check",
                json!({"artifactId": id, "autoCommit": true, "expect": {"size": [20, 10, 2], "bodies": 1}}),
            );
            assert!(!reply.is_error, "{}", reply.text);
            assert_eq!(reply.body["committed"], true, "{}", reply.text);
            reply.body
        };
        let chain = json!([earlier.session_id, continuation.session_id]);
        let first = check(&mut continuation, &bracket);
        let digest = &first["workStatus"];
        assert_eq!(digest["ready"], false, "{first}");
        assert_eq!(digest["blockers"][0]["artifactId"], spacer);
        assert_eq!(digest["sessionIds"], chain, "the digest names what it read");
        assert_eq!(first["next"], digest["blockers"][0]["next"]);
        // The ledger says how many sessions the status read, so the
        // earlier turn's blocker is not shown as this session's.
        assert_eq!(
            workspace.last_recorded()["alsoRan"],
            json!([{"tool": "work_status", "op": "work.status", "ok": true, "scope": "session",
                    "ready": false, "blockers": 1, "sessions": 2}])
        );
        let second = check(&mut continuation, &spacer);
        assert_eq!(second["workStatus"]["ready"], true, "{second}");
        assert_eq!(second["workStatus"]["sessionIds"], chain);
        assert_eq!(
            second["workStatus"]["summary"],
            "2 parts verified. 2 drafts are not submitted for review."
        );
        assert_eq!(
            second["next"],
            json!({"tool": null, "why": READY_CONTINUED})
        );
        let status = continuation.call("work_status", json!({}));
        assert_eq!(status.body["ready"], true, "{}", status.text);
    }

    /// A spec item without an assertion commits the check as partial: the
    /// passing assertions bind, and the digest is not ready and names the
    /// item through its own next call.
    #[test]
    fn a_partial_check_gives_a_digest_that_names_the_missing_item() {
        let (workspace, engine) = setup("Partial digest");
        let mut client = workspace.mcp(Profile::Compact);
        let missing = "Ø4 hole through the middle";
        let partial = client.call(
            "cad_write_source",
            json!({"title": "Box", "source": "cube([20, 10, 2]);", "expect": {"bodies": 1, "spec": [
                {"item": "box 20 x 10 x 2 mm", "size": [20, 10, 2]},
                {"item": missing}]}}),
        );
        assert!(!partial.is_error, "{}", partial.text);
        let body = &partial.body;
        assert_eq!(body["check"]["committed"], true, "{}", partial.text);
        assert_eq!(
            (&body["ready"], &body["verificationStatus"]),
            (&json!(false), &json!("partial"))
        );
        let status = &body["workStatus"];
        assert_eq!(status["ready"], false, "{}", partial.text);
        let blocker = &status["blockers"][0];
        assert_eq!(
            (&blocker["kind"], &blocker["artifactId"]),
            (&json!("cad_spec_unasserted"), &body["artifactId"])
        );
        assert_eq!(blocker["next"]["tool"], "cad_check");
        let items = blocker["next"]["args"]["expect"]["spec"]
            .as_array()
            .unwrap();
        assert!(
            items.iter().any(|item| item["item"] == missing),
            "the next call carries the item to assert: {blocker}"
        );
        assert!(blocker["next"]["why"].as_str().unwrap().contains(missing));
        assert_eq!(
            status["summary"],
            "1 part has items its committed check does not show."
        );
        // The reply's own next is the same repair, never another work_status.
        assert_eq!(body["next"]["tool"], "cad_check");
        assert!(body["next"]["why"].as_str().unwrap().contains(missing));
        assert_eq!(engine.renders(), 1);
        assert_eq!(
            workspace.last_recorded()["alsoRan"][1],
            json!({"tool": "work_status", "op": "work.status", "ok": true, "scope": "session",
                   "ready": false, "blockers": 1})
        );
    }
}
