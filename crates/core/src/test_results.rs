//! Test observations are immutable revision records, including the evidence
//! classification and the person or agent who entered them.
//!
//! Who records a result decides where it lands. A person's observation on an
//! approved test becomes part of the approved record at once: the new
//! revision is selected in the same transaction and keeps every earlier
//! result. An agent never moves a baseline: its observation is a draft on top
//! of the approved test, for a person to review. On a test that has no
//! approved revision yet, every result extends the working draft.
//!
//! A new baseline retires the drafts made before it, so when a person records
//! a result while a working draft is open, that draft is carried onto the new
//! baseline as a new draft. Its observations stay in front of the reviewer.
use super::*;

fn issue(path: &str, message: impl Into<String>) -> Value {
    json!({"path": path, "message": message.into()})
}

/// The newest working draft of an artifact made after revision number `after`.
fn newest_draft(
    handle: &ProjectHandle,
    artifact_id: &str,
    after: i64,
) -> CoreResult<Option<Value>> {
    handle
        .db
        .query_row(
            "SELECT * FROM revision WHERE artifact_id=?1 AND review_state IN ('draft','proposed') AND seq>?2 ORDER BY seq DESC LIMIT 1",
            params![artifact_id, after],
            revision_from_row,
        )
        .optional()
        .map_err(internal)
}

/// The requirement revision a result speaks to. It has to be a requirement
/// this test validates; the revision defaults to the one the test was
/// written for.
fn requirement_ref(
    handle: &ProjectHandle,
    current: &Value,
    reference: &Value,
) -> CoreResult<Value> {
    let target = required_str(reference, "artifactId")?;
    let validated = current["inputs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|input| input["relationship"] == "validates")
        .collect::<Vec<_>>();
    let Some(linked) = validated.iter().find(|input| input["artifactId"] == target) else {
        let known = validated
            .iter()
            .filter_map(|input| input["artifactId"].as_str())
            .collect::<Vec<_>>();
        let repair = if known.is_empty() {
            "This test validates no requirement. Leave requirementRef out, or create the test with requirementRefs.".to_owned()
        } else {
            format!(
                "Use a requirement this test validates ({}), or leave requirementRef out.",
                known.join(", ")
            )
        };
        return Err(ContractError::validation(format!(
            "This test does not validate requirement {target}"
        ))
        .with_repair(repair)
        .with_details(json!({"issues": [issue("requirementRef.artifactId", "not a requirement this test validates")], "validates": known})));
    };
    let revision_id = match reference["revisionId"].as_str() {
        Some(id) => {
            if require_revision(handle, id)?["artifactId"] != target {
                return Err(ContractError::validation(
                    "Requirement revision does not belong to the requirement",
                )
                .with_repair("Leave revisionId out to use the revision the test was written for.")
                .with_details(json!({"issues": [issue("requirementRef.revisionId", "must be a revision of requirementRef.artifactId")]})));
            }
            json!(id)
        }
        None => linked["revisionId"].clone(),
    };
    Ok(json!({"artifactId": target, "revisionId": revision_id}))
}

pub(super) fn record_result(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    let artifact_id = required_str(input, "artifactId")?;
    let artifact = require_artifact(handle, artifact_id)?;
    if artifact["type"] != "test" {
        return Err(
            ContractError::validation("Results attach to test artifacts")
                .with_repair("Pass the id of a test artifact; test_create_draft creates one.")
                .with_details(json!({"issues": [issue("artifactId", format!("is a {} artifact", artifact["type"].as_str().unwrap_or("different")))]})),
        );
    }
    let by_agent = matches!(origin, Origin::Agent { .. });
    let baseline = artifact["selectedRevisionId"]
        .as_str()
        .map(|id| require_revision(handle, id))
        .transpose()?;
    // The revision the result is added to.
    let current = match &baseline {
        Some(baseline) if !by_agent => baseline.clone(),
        Some(baseline) => {
            let after = baseline["seq"].as_i64().unwrap_or(0);
            newest_draft(handle, artifact_id, after)?.unwrap_or_else(|| baseline.clone())
        }
        None => match newest_draft(handle, artifact_id, 0)? {
            Some(draft) => draft,
            None => handle
                .db
                .query_row(
                    "SELECT * FROM revision WHERE artifact_id=?1 ORDER BY seq DESC LIMIT 1",
                    [artifact_id],
                    revision_from_row,
                )
                .optional()
                .map_err(internal)?
                .ok_or_else(|| ContractError::validation("Test has no revision"))?,
        },
    };
    let promote = baseline.is_some() && !by_agent;
    // The working draft a person's result would otherwise retire.
    let pending = match (&baseline, promote) {
        (Some(baseline), true) => {
            newest_draft(handle, artifact_id, baseline["seq"].as_i64().unwrap_or(0))?
        }
        _ => None,
    };
    let requirement = input
        .get("requirementRef")
        .filter(|reference| reference.is_object())
        .map(|reference| requirement_ref(handle, &current, reference))
        .transpose()?;
    // Evidence files travel with the revision, so they are materialised,
    // readable and exported like its other files.
    let attachments = ingest_files(handle, &input["attachments"])?
        .into_iter()
        .map(|mut file| {
            file["role"] = json!("attachment");
            file
        })
        .collect::<Vec<_>>();
    let mut result = json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "evidenceKind": input["evidenceKind"],
        "observation": input["observation"],
        "result": input["result"],
        "attachments": attachments,
        "recordedBy": match origin {
            Origin::Agent { session_id } => format!("agent:{}", session_id.chars().take(8).collect::<String>()),
            _ => "user".to_owned(),
        },
        "recordedAt": now(),
    });
    if let Some(requirement) = requirement {
        result["requirementRef"] = requirement;
    }
    for key in ["conditions", "measurementOrigin"] {
        if let Some(value) = input.get(key).filter(|value| !value.is_null()) {
            result[key] = value.clone();
        }
    }
    let mut body = current["payload"].clone();
    let results = body["results"]
        .as_array_mut()
        .ok_or_else(|| ContractError::validation("Test results must be an array"))?;
    results.push(result.clone());
    body = parse_artifact_payload("test", body)?;
    let mut files = current["files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|file| {
            !attachments
                .iter()
                .any(|attachment| attachment["path"] == file["path"])
        })
        .cloned()
        .collect::<Vec<_>>();
    files.extend(attachments.iter().cloned());
    let hashes = files
        .iter()
        .filter_map(|file| file["sha256"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    let revision_id = uuid::Uuid::new_v4().to_string();
    let seq: i64 = handle
        .db
        .query_row(
            "SELECT COALESCE(MAX(seq),0)+1 FROM revision WHERE artifact_id=?1",
            [artifact_id],
            |row| row.get(0),
        )
        .map_err(internal)?;
    let outcome = required_str(input, "result")?;
    let review_state = if promote { "approved" } else { "draft" };
    let timestamp = now();
    let tx = handle.db.unchecked_transaction().map_err(internal)?;
    tx.execute("INSERT INTO revision(id,artifact_id,parent_id,seq,origin,origin_detail,created_at,payload,content_hash,files,inputs,rationale,review_state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![revision_id, artifact_id, current["id"].as_str(), seq, origin.kind(), origin.session_id(), timestamp, body.to_string(), models::content_hash(&body, &hashes), json!(files).to_string(), current["inputs"].to_string(), format!("result: {outcome}"), review_state]).map_err(internal)?;
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
            artifact["title"].as_str(),
            body.to_string().chars().take(20_000).collect::<String>()
        ],
    )
    .map_err(internal)?;
    tx_event(
        &tx,
        "revision.committed",
        origin.kind(),
        json!({"artifactId": artifact_id, "revisionId": revision_id, "reviewState": review_state}),
    )?;
    // An approved revision is always the selected one: the pointer moves in
    // the transaction that writes it, with the decision that explains it.
    let baseline_event = if let (true, Some(prior)) = (promote, &baseline) {
        promote_revision(
            &tx,
            &artifact,
            &json!({"id": revision_id, "inputs": current["inputs"]}),
        )?;
        let event = tx_event(
            &tx,
            "baseline.changed",
            origin.kind(),
            json!({"artifactId": artifact_id, "newRevisionId": revision_id, "priorRevisionId": prior["id"]}),
        )?;
        record_decision(
            &tx,
            &Decision {
                proposal_id: None,
                action: "direct_edit",
                actor: "user",
                rationale: &format!("Recorded test result: {outcome}"),
                prior: &[json!({"artifactId": artifact_id, "revisionId": prior["id"]})],
                next: &[json!({"artifactId": artifact_id, "revisionId": revision_id})],
                event_seq: event,
            },
        )?;
        Some(event)
    } else {
        None
    };
    let carried = match &pending {
        Some(draft) => Some(carry_draft(
            &tx,
            draft,
            &body,
            &files,
            &revision_id,
            seq + 1,
            origin,
        )?),
        None => None,
    };
    tx.commit().map_err(internal)?;
    materialize_files(handle, &attachments, Some(&current))?;
    if let Some(event) = baseline_event {
        // Recomputes what depends on the test and the test's own freshness: a
        // new observation does not make an outdated test current.
        let affected = graph::propagate_from(handle, &[artifact_id.to_owned()], event)?;
        emit(
            handle,
            "impact.propagated",
            origin,
            json!({"changed": [{"artifactId": artifact_id, "revisionId": revision_id}], "affected": affected}),
        )?;
    }
    let mut note = match (promote, baseline.is_some()) {
        (true, _) => "Recorded on the approved test: the new revision is the approved one and keeps the earlier results.",
        (false, true) => "Recorded as a draft on top of the approved test. It becomes part of the approved test when the human accepts it.",
        (false, false) => "Recorded on the draft test, which has no approved revision yet.",
    }
    .to_owned();
    let mut answer = json!({"result": result, "revision": require_revision(handle, &revision_id)?, "approved": promote});
    if let (Some(draft), Some(carried)) = (&pending, &carried) {
        note.push_str(&format!(
            " The working draft r{} was carried onto it as draft r{}, with {} for review.",
            draft["seq"],
            seq + 1,
            count(carried.observations, "observation", "observations")
        ));
        answer["carriedDraft"] = json!({"from": draft["id"], "revisionId": carried.revision_id});
    }
    answer["note"] = json!(note);
    Ok(answer)
}

fn count(number: usize, one: &str, many: &str) -> String {
    format!("{number} {}", if number == 1 { one } else { many })
}

struct Carried {
    revision_id: String,
    /// Results of the draft that the new baseline does not hold.
    observations: usize,
}

/// Rebuild an open working draft on the baseline a person's result just
/// created: the draft's content with the new baseline's results first and
/// the draft's own results after them. The revision keeps the draft's author;
/// the event names the person whose result caused the carry. Runs in the
/// caller's transaction, in which the draft was retired.
fn carry_draft(
    tx: &rusqlite::Connection,
    draft: &Value,
    baseline_body: &Value,
    baseline_files: &[Value],
    baseline_id: &str,
    seq: i64,
    origin: &Origin,
) -> CoreResult<Carried> {
    let recorded = baseline_body["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|result| result["id"].as_str())
        .collect::<std::collections::HashSet<_>>();
    let extra = draft["payload"]["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|result| {
            !result["id"]
                .as_str()
                .is_some_and(|id| recorded.contains(id))
        })
        .cloned()
        .collect::<Vec<_>>();
    let mut body = draft["payload"].clone();
    let mut results = baseline_body["results"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    results.extend(extra.iter().cloned());
    body["results"] = json!(results);
    let body = parse_artifact_payload("test", body)?;
    let mut files = draft["files"].as_array().cloned().unwrap_or_default();
    files.extend(
        baseline_files
            .iter()
            .filter(|file| !files.iter().any(|kept| kept["path"] == file["path"]))
            .cloned()
            .collect::<Vec<_>>(),
    );
    let hashes = files
        .iter()
        .filter_map(|file| file["sha256"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    let artifact_id = required_str(draft, "artifactId")?;
    let revision_id = uuid::Uuid::new_v4().to_string();
    tx.execute("INSERT INTO revision(id,artifact_id,parent_id,seq,origin,origin_detail,created_at,payload,content_hash,files,inputs,rationale,review_state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'draft')",
        params![revision_id, artifact_id, baseline_id, seq, draft["origin"].as_str().unwrap_or("agent"), draft["originDetail"].as_str(), now(), body.to_string(), models::content_hash(&body, &hashes), json!(files).to_string(), draft["inputs"].to_string(), format!("Carried over from draft r{} after a result was recorded on the approved test", draft["seq"])]).map_err(internal)?;
    tx_event(
        tx,
        "revision.committed",
        origin.kind(),
        json!({"artifactId": artifact_id, "revisionId": revision_id, "reviewState": "draft", "carriedFrom": draft["id"]}),
    )?;
    Ok(Carried {
        revision_id,
        observations: extra.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::Bench;

    /// A requirement and a test that validates it; both drafts.
    fn planned(bench: &mut Bench) -> (Value, Value) {
        let requirement = bench
            .user(
                "artifact.create_draft",
                json!({"type": "requirement", "title": "Payload capacity", "payload": {"statement": "Carries 0.3 kg", "acceptanceCriterion": "Drives 5 m with 0.3 kg", "target": {"value": 0.3, "unit": "kg"}}}),
            )
            .unwrap();
        let test = bench
            .agent(
                "test.create_draft",
                json!({"title": "Payload lift test", "procedure": [{"step": 1, "instruction": "Load 0.3 kg and drive 5 m", "expected": "No tipping"}], "requirementRefs": [{"artifactId": requirement["artifact"]["id"]}], "conditions": "Flat floor"}),
            )
            .unwrap();
        (requirement, test)
    }

    fn observation(test: &Value, text: &str, outcome: &str) -> Value {
        json!({"artifactId": test["artifact"]["id"], "evidenceKind": "measured", "observation": text, "result": outcome})
    }

    fn observations(revision: &Value) -> Vec<String> {
        revision["payload"]["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|result| {
                format!(
                    "{}: {} by {}",
                    result["result"].as_str().unwrap(),
                    result["observation"].as_str().unwrap(),
                    &result["recordedBy"].as_str().unwrap()[..4]
                )
            })
            .collect()
    }

    #[test]
    fn a_test_draft_pins_the_requirement_revision_it_validates() {
        let mut bench = Bench::new();
        let (requirement, test) = planned(&mut bench);
        assert_eq!(test["revision"]["reviewState"], "draft");
        assert_eq!(test["revision"]["payload"]["results"], json!([]));
        // No revision was named: the test is written for the requirement's newest revision.
        assert_eq!(
            test["revision"]["inputs"],
            json!([{"artifactId": requirement["artifact"]["id"], "revisionId": requirement["revision"]["id"], "relationship": "validates", "label": "test for requirement"}])
        );
    }

    #[test]
    fn a_person_records_results_on_an_approved_test_and_they_accumulate() {
        let mut bench = Bench::new();
        let (requirement, test) = planned(&mut bench);
        bench.accept(&requirement);
        let approved = bench.accept(&test);
        let id = test["artifact"]["id"].as_str().unwrap().to_owned();

        let first = bench
            .user(
                "test.record_result",
                observation(&test, "Carried 0.3 kg for 5 m in 12 s", "passed"),
            )
            .unwrap();
        assert_eq!(first["approved"], true);
        assert_eq!(first["revision"]["reviewState"], "approved");
        assert_eq!(first["revision"]["parentId"], approved["revision"]["id"]);
        assert_eq!(first["result"]["recordedBy"], "user");
        // The revision that holds the result is the one the test now shows.
        let shown = bench.read(&id);
        assert_eq!(
            shown["view"]["artifact"]["selectedRevisionId"],
            first["revision"]["id"]
        );
        assert_eq!(shown["revision"]["id"], first["revision"]["id"]);
        assert_eq!(
            observations(&shown["revision"]),
            ["passed: Carried 0.3 kg for 5 m in 12 s by user"]
        );

        let second = bench
            .user(
                "test.record_result",
                observation(&test, "Tipped at 3 m on the second run", "failed"),
            )
            .unwrap();
        let shown = bench.read(&id);
        assert_eq!(
            shown["view"]["artifact"]["selectedRevisionId"],
            second["revision"]["id"]
        );
        assert_eq!(
            observations(&shown["revision"]),
            [
                "passed: Carried 0.3 kg for 5 m in 12 s by user",
                "failed: Tipped at 3 m on the second run by user",
            ]
        );
        // One approved revision at a time; the earlier ones are superseded history.
        let history = bench
            .user("artifact.history", json!({"artifactId": id}))
            .unwrap();
        let mut states = history["revisions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|revision| {
                (
                    revision["seq"].as_i64().unwrap(),
                    revision["reviewState"].as_str().unwrap().to_owned(),
                )
            })
            .collect::<Vec<_>>();
        states.sort();
        assert_eq!(
            states,
            [
                (1, "superseded".to_owned()),
                (2, "superseded".to_owned()),
                (3, "approved".to_owned())
            ]
        );
        // The test still validates the requirement and is still current.
        assert_eq!(shown["revision"]["inputs"], approved["revision"]["inputs"]);
        assert_eq!(shown["view"]["freshness"], "current");
        assert_eq!(shown["drafts"], json!([]));
        // The change of baseline is announced and recorded as a decision by the person.
        let changes = bench.events("baseline.changed");
        let last = changes.last().unwrap();
        assert_eq!(last["origin"], "user");
        assert_eq!(last["data"]["newRevisionId"], second["revision"]["id"]);
        assert_eq!(last["data"]["priorRevisionId"], first["revision"]["id"]);
        let decisions: i64 = bench.app.projects[&bench.project]
            .db
            .query_row(
                "SELECT COUNT(*) FROM decision WHERE action='direct_edit' AND rationale LIKE 'Recorded test result:%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(decisions, 2);
    }

    /// A person records a result while the agent's observation waits as a
    /// draft: the new baseline does not drop the agent's observation, it is
    /// carried onto it as a new draft for review.
    #[test]
    fn a_person_result_carries_the_open_agent_draft_onto_the_new_baseline() {
        let mut bench = Bench::new();
        let (requirement, test) = planned(&mut bench);
        bench.accept(&requirement);
        bench.accept(&test);
        let id = test["artifact"]["id"].as_str().unwrap().to_owned();
        let by_agent = bench
            .agent(
                "test.record_result",
                observation(&test, "Log shows 5.1 m travelled", "passed"),
            )
            .unwrap();
        let by_person = bench
            .user(
                "test.record_result",
                observation(&test, "Tipped at 3 m", "failed"),
            )
            .unwrap();
        assert_eq!(by_person["approved"], true);
        let carried = &by_person["carriedDraft"];
        assert_eq!(carried["from"], by_agent["revision"]["id"]);
        assert!(
            by_person["note"]
                .as_str()
                .unwrap()
                .ends_with("The working draft r2 was carried onto it as draft r4, with 1 observation for review."),
            "{by_person}"
        );
        let read = bench.read(&id);
        assert_eq!(read["drafts"].as_array().unwrap().len(), 1);
        let draft = &read["drafts"][0];
        assert_eq!(draft["id"], carried["revisionId"]);
        assert_eq!(draft["parentId"], by_person["revision"]["id"]);
        assert_eq!(draft["origin"], "agent");
        assert_eq!(
            observations(draft),
            [
                "failed: Tipped at 3 m by user",
                "passed: Log shows 5.1 m travelled by agen"
            ]
        );
        // The carried draft is what the reviewer accepts.
        bench
            .user(
                "artifact.accept_draft",
                json!({"artifactId": id, "draftRevisionId": carried["revisionId"]}),
            )
            .unwrap();
        assert_eq!(
            observations(&bench.read(&id)["revision"]),
            [
                "failed: Tipped at 3 m by user",
                "passed: Log shows 5.1 m travelled by agen"
            ]
        );
    }

    #[test]
    fn an_agent_result_on_an_approved_test_is_a_draft_that_keeps_earlier_results() {
        let mut bench = Bench::new();
        let (requirement, test) = planned(&mut bench);
        bench.accept(&requirement);
        bench.accept(&test);
        let id = test["artifact"]["id"].as_str().unwrap().to_owned();
        let by_person = bench
            .user(
                "test.record_result",
                observation(&test, "Carried 0.3 kg for 5 m", "passed"),
            )
            .unwrap();
        let baseline = by_person["revision"]["id"].clone();

        let first = bench
            .agent(
                "test.record_result",
                observation(&test, "Log shows 5.1 m travelled", "passed"),
            )
            .unwrap();
        assert_eq!(first["approved"], false);
        assert_eq!(first["revision"]["reviewState"], "draft");
        assert_eq!(first["revision"]["parentId"], baseline);
        assert!(first["result"]["recordedBy"]
            .as_str()
            .unwrap()
            .starts_with("agent:"));
        assert!(first["note"]
            .as_str()
            .unwrap()
            .contains("when the human accepts it"));
        // The approved test is unchanged by the agent.
        let shown = bench.read(&id);
        assert_eq!(shown["view"]["artifact"]["selectedRevisionId"], baseline);
        assert_eq!(
            observations(&shown["revision"]),
            ["passed: Carried 0.3 kg for 5 m by user"]
        );
        // A second agent result extends its own draft instead of starting again from the baseline.
        let second = bench
            .agent(
                "test.record_result",
                observation(&test, "Second log shows a stall at 4 m", "inconclusive"),
            )
            .unwrap();
        assert_eq!(second["revision"]["parentId"], first["revision"]["id"]);
        assert_eq!(
            observations(&second["revision"]),
            [
                "passed: Carried 0.3 kg for 5 m by user",
                "passed: Log shows 5.1 m travelled by agen",
                "inconclusive: Second log shows a stall at 4 m by agen",
            ]
        );
        assert_eq!(
            bench.read(&id)["view"]["artifact"]["selectedRevisionId"],
            baseline
        );
        // The person accepts the draft: the reviewed results join the approved test.
        bench
            .user(
                "artifact.accept_draft",
                json!({"artifactId": id, "draftRevisionId": second["revision"]["id"]}),
            )
            .unwrap();
        let accepted = bench.read(&id);
        assert_eq!(
            accepted["view"]["artifact"]["selectedRevisionId"],
            second["revision"]["id"]
        );
        assert_eq!(observations(&accepted["revision"]).len(), 3);
        // No agent call moved the baseline.
        assert!(bench
            .events("baseline.changed")
            .iter()
            .all(|event| event["origin"] == "user"));
    }

    #[test]
    fn results_on_a_test_without_an_approved_revision_extend_its_draft() {
        let mut bench = Bench::new();
        let (_, test) = planned(&mut bench);
        let id = test["artifact"]["id"].as_str().unwrap().to_owned();
        let by_agent = bench
            .agent(
                "test.record_result",
                observation(&test, "Dry run on the bench", "not_run"),
            )
            .unwrap();
        let by_person = bench
            .user(
                "test.record_result",
                observation(&test, "Carried 0.3 kg for 5 m", "passed"),
            )
            .unwrap();
        assert_eq!(by_agent["revision"]["reviewState"], "draft");
        assert_eq!(by_person["revision"]["reviewState"], "draft");
        assert_eq!(by_person["approved"], false);
        assert_eq!(
            by_person["revision"]["parentId"],
            by_agent["revision"]["id"]
        );
        assert_eq!(
            observations(&by_person["revision"]),
            [
                "not_run: Dry run on the bench by agen",
                "passed: Carried 0.3 kg for 5 m by user"
            ]
        );
        let shown = bench.read(&id);
        assert!(shown["view"]["artifact"]["selectedRevisionId"].is_null());
        assert_eq!(shown["revision"]["id"], by_person["revision"]["id"]);
        assert!(bench.events("baseline.changed").is_empty());
    }

    #[test]
    fn a_result_names_only_a_requirement_the_test_validates() {
        let mut bench = Bench::new();
        let (requirement, test) = planned(&mut bench);
        let requirement_id = requirement["artifact"]["id"].as_str().unwrap();
        let mut input = observation(&test, "Carried 0.3 kg", "passed");
        input["requirementRef"] = json!({"artifactId": requirement_id});
        input["conditions"] = json!("Flat floor, 21 degC");
        input["measurementOrigin"] = json!("Kitchen scale and tape measure");
        let recorded = bench.user("test.record_result", input).unwrap();
        // The revision defaults to the one the test was written for.
        assert_eq!(
            recorded["result"]["requirementRef"],
            json!({"artifactId": requirement_id, "revisionId": requirement["revision"]["id"]})
        );
        assert_eq!(recorded["result"]["conditions"], "Flat floor, 21 degC");
        assert_eq!(
            recorded["result"]["measurementOrigin"],
            "Kitchen scale and tape measure"
        );
        let other = bench
            .user("artifact.create_draft", json!({"type": "requirement", "title": "Endurance", "payload": {"statement": "Runs 30 min", "acceptanceCriterion": "30 min on one charge"}}))
            .unwrap();
        let mut unrelated = observation(&test, "Ran 31 min", "passed");
        unrelated["requirementRef"] = json!({"artifactId": other["artifact"]["id"]});
        let error = bench.user("test.record_result", unrelated).unwrap_err();
        assert_eq!(error.code, "VALIDATION");
        assert!(error.repair.unwrap().contains(requirement_id));
        assert_eq!(
            error.details.unwrap()["issues"][0]["path"],
            "requirementRef.artifactId"
        );
        let mut mismatched = observation(&test, "Carried 0.3 kg", "passed");
        mismatched["requirementRef"] =
            json!({"artifactId": requirement_id, "revisionId": other["revision"]["id"]});
        let error = bench.user("test.record_result", mismatched).unwrap_err();
        assert_eq!(
            error.details.unwrap()["issues"][0]["path"],
            "requirementRef.revisionId"
        );
        let not_a_test = bench
            .user(
                "test.record_result",
                observation(&requirement, "x", "passed"),
            )
            .unwrap_err();
        assert_eq!(not_a_test.message, "Results attach to test artifacts");
    }

    #[test]
    fn evidence_files_travel_with_the_revision() {
        let mut bench = Bench::new();
        let (requirement, test) = planned(&mut bench);
        bench.accept(&requirement);
        bench.accept(&test);
        let id = test["artifact"]["id"].as_str().unwrap().to_owned();
        let mut input = observation(&test, "Scale reads 0.302 kg", "passed");
        // "run 1: ok" in base64.
        input["attachments"] =
            json!([{"path": "tests/run-1.log", "contentBase64": "cnVuIDE6IG9r"}]);
        let recorded = bench.user("test.record_result", input).unwrap();
        let attachment = &recorded["result"]["attachments"][0];
        assert_eq!(attachment["path"], "tests/run-1.log");
        assert_eq!(attachment["role"], "attachment");
        assert_eq!(recorded["revision"]["files"], json!([attachment]));
        assert_eq!(
            fs::read_to_string(bench.root().join("tests/run-1.log")).unwrap(),
            "run 1: ok"
        );
        let read = bench
            .user(
                "artifact.read_file",
                json!({"artifactId": id, "path": "tests/run-1.log"}),
            )
            .unwrap();
        assert_eq!(read["contentBase64"], "cnVuIDE6IG9r");
        // A later result keeps the earlier evidence file.
        let later = bench
            .user(
                "test.record_result",
                observation(&test, "Repeat run", "passed"),
            )
            .unwrap();
        assert_eq!(later["revision"]["files"], json!([attachment]));
    }

    #[test]
    fn recording_a_result_does_not_hide_that_the_requirement_moved_on() {
        let mut bench = Bench::new();
        let (requirement, test) = planned(&mut bench);
        bench.accept(&requirement);
        bench.accept(&test);
        let id = test["artifact"]["id"].as_str().unwrap().to_owned();
        // The requirement changes after the test was approved.
        bench
            .user(
                "artifact.apply_edit",
                json!({"artifactId": requirement["artifact"]["id"], "baseRevisionId": requirement["revision"]["id"], "payloadPatch": {"statement": "Carries 0.5 kg", "target": {"value": 0.5, "unit": "kg"}}, "rationale": "heavier payload"}),
            )
            .unwrap();
        assert_eq!(bench.read(&id)["view"]["freshness"], "stale");
        bench
            .user(
                "test.record_result",
                observation(&test, "Carried 0.3 kg for 5 m", "passed"),
            )
            .unwrap();
        // The observation was made against the old requirement: the test stays out of date.
        let shown = bench.read(&id);
        assert_eq!(shown["view"]["freshness"], "stale");
        assert_eq!(observations(&shown["revision"]).len(), 1);
    }
}
