//! Requirement to evidence traceability. For each requirement: the tests,
//! calculations and design artifacts linked to it, whether each is current,
//! and the result it records. A verdict is only ever the outcome a test
//! result recorded; numbers are never compared here to infer one.
use super::*;
use reads::{clip, format_quantity, statement, HEAD_REVISION};
use std::collections::hash_map::Entry as Slot;
use std::collections::{HashMap, HashSet};

/// Relationships that tie an artifact to a requirement, strongest first.
const RELATIONS: [&str; 3] = ["validates", "derived_from", "depends_on"];

/// Artifact types that can substantiate a requirement. Other requirements,
/// assumptions, sources, notes and subsystems state or organise needs; they
/// do not show one is met.
const EVIDENCE_TYPES: [&str; 9] = [
    "test",
    "calculation",
    "mechanical",
    "component",
    "wiring",
    "software",
    "assembly",
    "architecture",
    "concept",
];

const RESULT_CHARS: usize = 160;

struct Revision {
    id: String,
    review_state: String,
    inputs: Value,
    /// Loaded for requirements, tests and calculations only.
    payload: Value,
}

struct Entry {
    kind: String,
    title: String,
    created_at: String,
    baseline: Option<Revision>,
    /// Newest revision in play when it is not the baseline.
    draft: Option<Revision>,
}

impl Entry {
    /// What the artifact currently states: its baseline, else its draft.
    fn current(&self) -> Option<&Revision> {
        self.baseline.as_ref().or(self.draft.as_ref())
    }
}

struct Link {
    /// Index into `RELATIONS`.
    relation: usize,
    /// Requirement revision the evidence recorded as its input.
    pinned: Option<String>,
    /// Made by the evidence's baseline rather than only by a draft of it.
    approved: bool,
    /// Declared as an input or an edge, not only named by one test result.
    declared: bool,
    /// A person stands behind the link: it is part of an approved revision,
    /// or an edge a person drew. An edge an agent drew takes effect without
    /// review, so it never makes evidence current.
    reviewed: bool,
}

impl Link {
    fn strength(&self) -> u8 {
        u8::from(self.approved) + u8::from(self.approved && self.reviewed)
    }
}

struct Outcome {
    evidence_kind: Value,
    result: Option<String>,
    verdict: &'static str,
    /// The artifact is of a kind that records a result and has none.
    missing: bool,
    /// Requirement revision the recorded result names.
    pinned: Option<String>,
    /// For a calculation: whether the engine computes its recorded result,
    /// and the result as written when it does not.
    computed: Option<(bool, Option<String>)>,
}

pub(super) fn project_coverage(handle: &ProjectHandle) -> CoreResult<Value> {
    let mut entries = HashMap::<String, Entry>::new();
    load_revisions(
        handle,
        "r.id=a.selected_revision_id WHERE a.archived=0",
        &mut entries,
        |entry, revision| entry.baseline = Some(revision),
    )?;
    load_revisions(
        handle,
        &format!(
            "r.id={HEAD_REVISION} WHERE a.archived=0 AND r.review_state IN ('draft','proposed')"
        ),
        &mut entries,
        |entry, revision| entry.draft = Some(revision),
    )?;
    let mut order = entries.keys().map(String::as_str).collect::<Vec<_>>();
    order.sort_by_key(|id| (entries[*id].created_at.as_str(), *id));
    let is_requirement = |id: &str| {
        entries
            .get(id)
            .is_some_and(|entry| entry.kind == "requirement")
    };

    // requirement id → evidence id → how they are linked
    let mut links = HashMap::<&str, HashMap<&str, Link>>::new();
    let mut connect = |requirement: &str, evidence: &str, link: Link| {
        let (Some((requirement, _)), Some((evidence, _))) = (
            entries.get_key_value(requirement),
            entries.get_key_value(evidence),
        ) else {
            return;
        };
        match links
            .entry(requirement.as_str())
            .or_default()
            .entry(evidence.as_str())
        {
            Slot::Vacant(slot) => {
                slot.insert(link);
            }
            Slot::Occupied(mut slot) => {
                let known = slot.get_mut();
                if link.strength() > known.strength() {
                    *known = link;
                } else if link.strength() == known.strength() {
                    known.relation = known.relation.min(link.relation);
                    known.pinned = link.pinned.or(known.pinned.take());
                    known.declared |= link.declared;
                }
            }
        }
    };
    for id in &order {
        let entry = &entries[*id];
        if !EVIDENCE_TYPES.contains(&entry.kind.as_str()) {
            continue;
        }
        // The baseline first, so a draft only adds links the baseline lacks.
        for (revision, approved) in [(&entry.baseline, true), (&entry.draft, false)] {
            let Some(revision) = revision else {
                continue;
            };
            for input in revision.inputs.as_array().into_iter().flatten() {
                let relation = RELATIONS
                    .iter()
                    .position(|name| input["relationship"] == *name);
                if let (Some(relation), Some(target)) = (relation, input["artifactId"].as_str()) {
                    if is_requirement(target) {
                        connect(
                            target,
                            id,
                            Link {
                                relation,
                                pinned: input["revisionId"].as_str().map(str::to_owned),
                                approved,
                                declared: true,
                                reviewed: true,
                            },
                        );
                    }
                }
            }
            for result in revision.payload["results"].as_array().into_iter().flatten() {
                if let Some(target) = result["requirementRef"]["artifactId"].as_str() {
                    if entry.kind == "test" && is_requirement(target) {
                        connect(
                            target,
                            id,
                            Link {
                                relation: 0,
                                pinned: None,
                                approved,
                                declared: false,
                                reviewed: true,
                            },
                        );
                    }
                }
            }
        }
    }
    let mut stmt = statement(
        handle,
        "SELECT upstream_artifact_id, downstream_artifact_id, relationship, created_by FROM edge \
         WHERE required_upstream_revision_id IS NULL ORDER BY created_at, id",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(internal)?;
    for row in rows {
        let (upstream, downstream, relationship, created_by) = row.map_err(internal)?;
        let relation = RELATIONS.iter().position(|name| relationship == *name);
        let evidence = entries
            .get(&downstream)
            .filter(|entry| EVIDENCE_TYPES.contains(&entry.kind.as_str()));
        if let (Some(relation), Some(evidence)) = (relation, evidence) {
            if is_requirement(&upstream) {
                connect(
                    &upstream,
                    &downstream,
                    Link {
                        relation,
                        pinned: None,
                        approved: evidence.baseline.is_some(),
                        declared: true,
                        reviewed: created_by != "agent",
                    },
                );
            }
        }
    }
    let stale = statement(handle, "SELECT DISTINCT artifact_id FROM stale")?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(internal)?
        .collect::<rusqlite::Result<HashSet<_>>>()
        .map_err(internal)?;

    let position = order
        .iter()
        .enumerate()
        .map(|(index, id)| (*id, index))
        .collect::<HashMap<_, _>>();
    let mut requirements = Vec::new();
    let mut totals = [0_usize; 4];
    for id in &order {
        let entry = &entries[*id];
        let Some(current) = entry.current().filter(|_| entry.kind == "requirement") else {
            continue;
        };
        let mut linked = links
            .get(id)
            .map(|found| found.iter().collect::<Vec<_>>())
            .unwrap_or_default();
        linked.sort_by_key(|(evidence_id, _)| position[**evidence_id]);
        let mut evidence = Vec::new();
        let mut states = Vec::new();
        for (evidence_id, link) in linked {
            let source = &entries[*evidence_id];
            let revision = if link.approved {
                source.baseline.as_ref()
            } else {
                source.draft.as_ref()
            };
            let Some(revision) = revision else {
                continue;
            };
            let outcome = match source.kind.as_str() {
                "test" => test_outcome(&revision.payload, id, link.declared),
                "calculation" => calculation_outcome(&revision.payload),
                _ => Outcome {
                    evidence_kind: Value::Null,
                    result: None,
                    verdict: "unknown",
                    missing: false,
                    pinned: None,
                    computed: None,
                },
            };
            let moved = |pinned: &Option<String>| {
                pinned
                    .as_deref()
                    .is_some_and(|revision| revision != current.id)
            };
            let state = if !link.approved {
                "draft"
            } else if !link.reviewed {
                // Reported as a draft link; the reason says who made it.
                "unreviewed"
            } else if stale.contains(*evidence_id) || moved(&link.pinned) || moved(&outcome.pinned)
            {
                "stale"
            } else if outcome.missing {
                "no_result"
            } else {
                "current"
            };
            states.push((
                state,
                source.kind.as_str(),
                state == "current" && outcome.result.is_some(),
            ));
            let state = if state == "unreviewed" {
                "draft"
            } else {
                state
            };
            let mut item = json!({
                "artifactId": evidence_id,
                "type": source.kind,
                "title": source.title,
                "relation": RELATIONS[link.relation],
                "state": state,
                "evidenceKind": outcome.evidence_kind,
                "result": outcome.result,
                "verdict": outcome.verdict,
                "linkReviewed": link.approved && link.reviewed,
            });
            if let Some((computed, written)) = outcome.computed {
                item["computed"] = json!(computed);
                if let Some(written) = written {
                    item["recordedResult"] = json!(written);
                }
            }
            evidence.push(item);
        }
        let (coverage, reason) = coverage_of(&states);
        totals[["covered", "partial", "stale", "none"]
            .iter()
            .position(|name| *name == coverage)
            .unwrap_or(3)] += 1;
        let payload = &current.payload;
        requirements.push(json!({
            "artifactId": id,
            "title": entry.title,
            "statement": payload["statement"].as_str().unwrap_or_default(),
            "target": payload["target"],
            "priority": payload["priority"].as_str().unwrap_or("should"),
            "review": if entry.baseline.is_some() {
                "approved"
            } else if current.review_state == "proposed" {
                "in_review"
            } else {
                "draft"
            },
            "coverage": coverage,
            "reason": reason,
            "evidence": evidence,
        }));
    }
    Ok(json!({
        "requirements": requirements,
        "totals": {
            "requirements": totals.iter().sum::<usize>(),
            "covered": totals[0],
            "partial": totals[1],
            "stale": totals[2],
            "none": totals[3],
        },
    }))
}

/// One revision per artifact matched by `join`, handed to `place`.
fn load_revisions(
    handle: &ProjectHandle,
    join: &str,
    entries: &mut HashMap<String, Entry>,
    place: impl Fn(&mut Entry, Revision),
) -> CoreResult<()> {
    let mut stmt = statement(
        handle,
        &format!(
            "SELECT a.id, a.type, a.title, a.created_at, r.id, r.review_state, r.inputs, \
             CASE WHEN a.type IN ('requirement','test','calculation') THEN r.payload END \
             FROM artifact a JOIN revision r ON {join}"
        ),
    )?;
    let parse = |text: Option<String>| {
        text.and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(Value::Null)
    };
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                Revision {
                    id: row.get(4)?,
                    review_state: row.get(5)?,
                    inputs: parse(row.get(6)?),
                    payload: parse(row.get(7)?),
                },
            ))
        })
        .map_err(internal)?;
    for row in rows {
        let (id, kind, title, created_at, revision) = row.map_err(internal)?;
        let entry = entries.entry(id).or_insert(Entry {
            kind,
            title,
            created_at,
            baseline: None,
            draft: None,
        });
        place(entry, revision);
    }
    Ok(())
}

/// The newest observation a test recorded for this requirement. A result
/// that names no requirement speaks for every requirement the test declares
/// (`declared`), not for one that only another result names.
fn test_outcome(payload: &Value, requirement_id: &str, declared: bool) -> Outcome {
    let observed = payload["results"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .find(|result| {
            let named = &result["requirementRef"]["artifactId"];
            (named == requirement_id || (declared && named.is_null()))
                && !matches!(result["result"].as_str(), Some("planned" | "not_run"))
        });
    let Some(result) = observed else {
        return Outcome {
            evidence_kind: Value::Null,
            result: None,
            verdict: "unknown",
            missing: true,
            pinned: None,
            computed: None,
        };
    };
    let observation = result["observation"].as_str().unwrap_or_default().trim();
    let text = match result["units"].as_str().filter(|units| !units.is_empty()) {
        Some(units) if observation.parse::<f64>().is_ok() => format!("{observation} {units}"),
        Some(units) => format!("{observation} (units: {units})"),
        None => observation.to_owned(),
    };
    Outcome {
        evidence_kind: result["evidenceKind"].clone(),
        result: Some(clip(&text, RESULT_CHARS)).filter(|text| !text.is_empty()),
        verdict: match result["result"].as_str() {
            Some("passed") => "pass",
            Some("failed") => "fail",
            _ => "unknown",
        },
        missing: false,
        pinned: result["requirementRef"]["revisionId"]
            .as_str()
            .map(str::to_owned),
        computed: None,
    }
}

/// A calculation's result is evidence only when the engine computes it from
/// the inputs it records. Anything else written in the payload is shown as
/// written and not computed, with no result and no "calculated" kind.
fn calculation_outcome(payload: &Value) -> Outcome {
    let recorded = &payload["result"];
    let text = recorded["text"]
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty());
    let written = format_quantity(&recorded["quantity"])
        .or_else(|| text.map(|text| clip(text, RESULT_CHARS)));
    if calculation::computed(payload) {
        return Outcome {
            evidence_kind: json!("calculated"),
            result: written,
            verdict: "unknown",
            missing: false,
            pinned: None,
            computed: Some((true, None)),
        };
    }
    Outcome {
        evidence_kind: match payload["evidenceKind"].as_str() {
            Some("calculated") | None => Value::Null,
            Some(kind) => json!(kind),
        },
        result: None,
        verdict: "unknown",
        missing: true,
        pinned: None,
        computed: Some((false, written)),
    }
}

/// `(coverage, reason)` from each evidence item's state, type and whether it
/// is current with a recorded result.
fn coverage_of(states: &[(&str, &str, bool)]) -> (&'static str, String) {
    if states.is_empty() {
        return ("none", "No evidence is linked.".to_owned());
    }
    let describe = |state: &str| {
        let kinds = states
            .iter()
            .filter(|item| item.0 == state)
            .map(|item| item.1)
            .collect::<Vec<_>>();
        let total = kinds.len();
        let (one, many) = match state {
            "current" => ("is current", "are current"),
            "stale" => ("is out of date", "are out of date"),
            "draft" => ("is a draft", "are drafts"),
            "unreviewed" => (
                "is linked by an agent and not reviewed",
                "are linked by an agent and not reviewed",
            ),
            _ => ("has no result", "have no result"),
        };
        (total > 0).then(|| {
            format!(
                "{} {}",
                counted(&kinds),
                if total == 1 { one } else { many }
            )
        })
    };
    let current = describe("current");
    let other = ["stale", "draft", "unreviewed", "no_result"]
        .into_iter()
        .filter_map(describe)
        .collect::<Vec<_>>()
        .join("; ");
    let unproven = if states.iter().any(|item| item.2) {
        ""
    } else {
        " No current test or calculation result is recorded."
    };
    match current {
        None => (
            "stale",
            format!("Evidence is linked but none is current: {other}."),
        ),
        Some(current) if other.is_empty() => ("covered", format!("{current}.{unproven}")),
        Some(current) => ("partial", format!("{current}; {other}.{unproven}")),
    }
}

/// `1 calculation and 2 tests`, in the order the types first appear.
fn counted(kinds: &[&str]) -> String {
    let mut groups = Vec::<(&str, usize)>::new();
    for kind in kinds {
        match groups.iter_mut().find(|group| group.0 == *kind) {
            Some(group) => group.1 += 1,
            None => groups.push((kind, 1)),
        }
    }
    let phrases = groups
        .into_iter()
        .map(|(kind, count)| {
            let (one, many) = match kind {
                "test" => ("test", "tests"),
                "calculation" => ("calculation", "calculations"),
                "mechanical" => ("part", "parts"),
                "component" => ("component", "components"),
                "wiring" => ("wiring diagram", "wiring diagrams"),
                "software" => ("software artifact", "software artifacts"),
                "assembly" => ("assembly", "assemblies"),
                "architecture" => ("architecture record", "architecture records"),
                _ => ("concept", "concepts"),
            };
            format!("{count} {}", if count == 1 { one } else { many })
        })
        .collect::<Vec<_>>();
    match phrases.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("{} and {last}", rest.join(", ")),
        _ => phrases.concat(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{agent, requirement, TestProject};
    use reads::statements_during;

    fn observed(outcome: &str, observation: &str) -> Value {
        json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "evidenceKind": "measured",
            "observation": observation,
            "result": outcome,
            "recordedBy": "user",
            "recordedAt": "2026-03-01T10:00:00.000Z",
        })
    }

    fn test_of(results: Value) -> Value {
        json!({"procedure": [{"step": 1, "instruction": "Load the tray and drive 5 m"}], "results": results})
    }

    /// A calculation as `calculation.run` records it: the result is what the
    /// engine computes from the recorded inputs.
    fn calculation(kilograms: f64) -> Value {
        let half = json!({"value": kilograms / 2.0, "unit": "kg"});
        json!({
            "expression": "chassis + battery",
            "inputs": [{"name": "chassis", "quantity": half}, {"name": "battery", "quantity": half}],
            "result": {"quantity": {"value": kilograms, "unit": "kg"}},
            "evidenceKind": "calculated",
        })
    }

    fn link(artifact: &str, revision: &str, relationship: &str) -> Value {
        json!([{"artifactId": artifact, "revisionId": revision, "relationship": relationship}])
    }

    fn row<'a>(report: &'a Value, requirement_id: &str) -> &'a Value {
        report["requirements"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["artifactId"] == requirement_id)
            .unwrap_or_else(|| panic!("no row for {requirement_id} in {report}"))
    }

    #[test]
    fn coverage_is_covered_partial_stale_or_none_from_recorded_links() {
        let mut project = TestProject::new();
        let need = |project: &mut TestProject, title: &str| {
            project.approved("requirement", title, requirement(title), json!([]))
        };
        let (unlinked, _) = need(&mut project, "Unlinked need");
        let (covered, covered_at) = need(&mut project, "Covered need");
        let (partial, partial_at) = need(&mut project, "Partly covered need");
        let (moved, moved_at) = need(&mut project, "Changed need");
        let (untested, untested_at) = need(&mut project, "Untested need");

        let (load_test, _) = project.approved(
            "test",
            "Load test",
            test_of(json!([observed(
                "passed",
                "Carried 0.3 kg for 5 m without tipping"
            )])),
            link(&covered, &covered_at, "validates"),
        );
        let (budget, _) = project.approved(
            "calculation",
            "Mass budget",
            calculation(0.412_37),
            link(&covered, &covered_at, "depends_on"),
        );
        project.approved(
            "test",
            "Slope test",
            test_of(json!([observed("passed", "Held on a 15 degree slope")])),
            link(&partial, &partial_at, "validates"),
        );
        project.draft(
            agent("s1"),
            "calculation",
            "Tipping margin",
            calculation(1.8),
            link(&partial, &partial_at, "derived_from"),
        );
        project.approved(
            "test",
            "Range test",
            test_of(json!([observed("passed", "Drove 120 m on one charge")])),
            link(&moved, &moved_at, "validates"),
        );
        let stricter = project.redraft(
            Origin::User,
            &moved,
            json!({"baseRevisionId": moved_at, "payload": requirement("Drive 200 m on one charge")}),
        );
        project.accept(&moved, &stricter);
        project.approved(
            "test",
            "Drop test",
            test_of(json!([observed("planned", "Drop from 0.5 m")])),
            link(&untested, &untested_at, "validates"),
        );

        let (report, statements) =
            statements_during(|| project.user("project.coverage", json!({})));
        assert_eq!(statements, 4);
        assert_eq!(
            report["totals"],
            json!({"requirements": 5, "covered": 1, "partial": 1, "stale": 2, "none": 1})
        );
        let titles = report["requirements"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["title"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            titles,
            [
                "Unlinked need",
                "Covered need",
                "Partly covered need",
                "Changed need",
                "Untested need"
            ]
        );

        let none = row(&report, &unlinked);
        assert_eq!(none["coverage"], "none");
        assert_eq!(none["reason"], "No evidence is linked.");
        assert_eq!(none["evidence"], json!([]));
        assert_eq!(none["review"], "approved");
        assert_eq!(none["priority"], "must");
        assert_eq!(none["statement"], "Unlinked need");
        assert!(none["target"].is_null());

        let full = row(&report, &covered);
        assert_eq!(full["coverage"], "covered");
        assert_eq!(full["reason"], "1 test and 1 calculation are current.");
        assert_eq!(
            full["evidence"],
            json!([
                {
                    "artifactId": load_test, "type": "test", "title": "Load test",
                    "relation": "validates", "state": "current", "evidenceKind": "measured",
                    "result": "Carried 0.3 kg for 5 m without tipping", "verdict": "pass",
                    "linkReviewed": true,
                },
                {
                    "artifactId": budget, "type": "calculation", "title": "Mass budget",
                    "relation": "depends_on", "state": "current", "evidenceKind": "calculated",
                    "result": "0.4124 kg", "verdict": "unknown", "computed": true,
                    "linkReviewed": true,
                },
            ])
        );

        let some = row(&report, &partial);
        assert_eq!(some["coverage"], "partial");
        assert_eq!(
            some["reason"],
            "1 test is current; 1 calculation is a draft."
        );
        assert_eq!(some["evidence"][1]["state"], "draft");
        assert_eq!(some["evidence"][1]["relation"], "derived_from");
        assert_eq!(some["evidence"][1]["result"], "1.8 kg");

        let stale = row(&report, &moved);
        assert_eq!(stale["statement"], "Drive 200 m on one charge");
        assert_eq!(stale["coverage"], "stale");
        assert_eq!(
            stale["reason"],
            "Evidence is linked but none is current: 1 test is out of date."
        );
        assert_eq!(stale["evidence"][0]["state"], "stale");
        // What was recorded stays visible; the state says it is out of date.
        assert_eq!(stale["evidence"][0]["verdict"], "pass");

        let planned = row(&report, &untested);
        assert_eq!(planned["coverage"], "stale");
        assert_eq!(
            planned["reason"],
            "Evidence is linked but none is current: 1 test has no result."
        );
        assert_eq!(
            planned["evidence"][0],
            json!({
                "artifactId": planned["evidence"][0]["artifactId"], "type": "test", "title": "Drop test",
                "relation": "validates", "state": "no_result", "evidenceKind": null,
                "result": null, "verdict": "unknown", "linkReviewed": true,
            })
        );
    }

    /// A result written into a calculation is not evidence that anything
    /// was computed, whoever approved it: it is shown as written, with no
    /// result and no "calculated" kind, and covers nothing.
    #[test]
    fn a_calculation_result_nothing_computed_covers_nothing() {
        let mut project = TestProject::new();
        let (need, need_at) = project.approved(
            "requirement",
            "Payload capacity",
            requirement("Carry 0.3 kg"),
            json!([]),
        );
        let typed = |inputs: Value, value: f64| {
            json!({"expression": "m1 + m2", "inputs": inputs,
                "result": {"quantity": {"value": value, "unit": "kg"}}})
        };
        let known = json!([
            {"name": "m1", "quantity": {"value": 0.2, "unit": "kg"}},
            {"name": "m2", "quantity": {"value": 0.3, "unit": "kg"}}
        ]);
        let unknown = json!([
            {"name": "m1", "quantity": {"value": 0.2, "unit": "kg"}},
            {"name": "m2", "quantity": {"unknown": true, "reason": "not weighed"}}
        ]);
        let (guessed, guessed_at) = project.draft(
            agent("s1"),
            "calculation",
            "Rover mass budget",
            typed(unknown, 0.412),
            link(&need, &need_at, "validates"),
        );
        // No default is written into what the agent sent.
        let read = project.agent(
            "s1",
            "artifact.read",
            json!({"artifactId": guessed, "detail": "full"}),
        );
        assert!(read["revision"]["payload"].get("evidenceKind").is_none());
        let (wrong, wrong_at) = project.draft(
            agent("s1"),
            "calculation",
            "Payload sum",
            typed(known.clone(), 0.6),
            link(&need, &need_at, "validates"),
        );
        let status = project.agent("s1", "work.status", json!({}));
        let detail = |id: &str| {
            status["outstanding"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["artifactId"] == id)
                .unwrap()
                .clone()
        };
        assert_eq!(detail(&guessed)["kind"], "calculation_not_run");
        assert_eq!(
            detail(&guessed)["detail"],
            "Draft r1 records a result, but input m2 has no value, so nothing computed it."
        );
        assert_eq!(
            detail(&wrong)["detail"],
            "Draft r1 records a result that calculation_run did not compute from its inputs."
        );
        assert_eq!(status["ready"], false);
        project.accept(&guessed, &guessed_at);
        project.accept(&wrong, &wrong_at);

        let report = project.agent("s1", "project.coverage", json!({}));
        let unproven = row(&report, &need);
        assert_eq!(unproven["coverage"], "stale", "{unproven}");
        assert_eq!(
            unproven["reason"],
            "Evidence is linked but none is current: 2 calculations have no result."
        );
        assert_eq!(
            unproven["evidence"][0],
            json!({
                "artifactId": guessed, "type": "calculation", "title": "Rover mass budget",
                "relation": "validates", "state": "no_result", "evidenceKind": null,
                "result": null, "verdict": "unknown", "linkReviewed": true,
                "computed": false, "recordedResult": "0.412 kg",
            })
        );

        // Typed or not, a number the engine computes from the recorded
        // inputs is a calculated result.
        let (right, right_at) = project.draft(
            agent("s1"),
            "calculation",
            "Checked sum",
            typed(known, 0.5),
            link(&need, &need_at, "validates"),
        );
        project.accept(&right, &right_at);
        let report = project.agent("s1", "project.coverage", json!({}));
        let proven = row(&report, &need);
        assert_eq!(proven["coverage"], "partial");
        let checked = &proven["evidence"][2];
        assert_eq!(checked["state"], "current");
        assert_eq!(checked["evidenceKind"], "calculated");
        assert_eq!(checked["result"], "0.5 kg");
        assert_eq!(checked["computed"], true);
    }

    /// A link an agent draws takes effect without review, so it cannot make
    /// a requirement covered; a person's link or an approved input can.
    #[test]
    fn a_link_an_agent_drew_covers_nothing_until_a_person_stands_behind_it() {
        let mut project = TestProject::new();
        let (need, _) = project.approved(
            "requirement",
            "Payload capacity",
            requirement("Carry 0.3 kg"),
            json!([]),
        );
        let (concept, _) = project.approved(
            "concept",
            "Tracked chassis",
            json!({"description": "Use tracks"}),
            json!([]),
        );
        let edge = json!({"edges": [{"upstreamArtifactId": need, "downstreamArtifactId": concept, "relationship": "validates"}]});
        let drawn = project.agent("s1", "graph.propose_edges", edge.clone());
        assert_eq!(drawn["edges"][0]["createdBy"], "agent");
        let report = project.agent("s1", "project.coverage", json!({}));
        let linked = row(&report, &need);
        assert_eq!(linked["coverage"], "stale", "{linked}");
        assert_eq!(
            linked["reason"],
            "Evidence is linked but none is current: 1 concept is linked by an agent and not reviewed."
        );
        assert_eq!(linked["evidence"][0]["state"], "draft");
        assert_eq!(linked["evidence"][0]["linkReviewed"], false);
        assert_eq!(report["totals"]["covered"], 0);

        project.user("graph.propose_edges", edge);
        let report = project.user("project.coverage", json!({}));
        let reviewed = row(&report, &need);
        assert_eq!(reviewed["coverage"], "covered");
        assert_eq!(reviewed["evidence"][0]["state"], "current");
        assert_eq!(reviewed["evidence"][0]["linkReviewed"], true);
    }

    #[test]
    fn a_verdict_exists_only_where_a_test_result_recorded_one() {
        let mut project = TestProject::new();
        let mut payload = requirement("Total mass stays under 0.3 kg");
        payload["target"] = json!({"value": 0.3, "unit": "kg", "min": 0.0, "max": 0.3});
        let (mass, mass_at) = project.approved("requirement", "Mass limit", payload, json!([]));
        let (other, other_at) =
            project.approved("requirement", "Other need", requirement("Other"), json!([]));

        // 0.412 kg against a 0.3 kg limit: the numbers disagree, and that is
        // for a person or a test to judge, not for this report.
        project.approved(
            "calculation",
            "Mass budget",
            calculation(0.412),
            link(&mass, &mass_at, "validates"),
        );
        let mut weighed = observed("failed", "412");
        weighed["units"] = json!("g");
        let mut elsewhere = observed("passed", "Unrelated pass");
        elsewhere["requirementRef"] = json!({"artifactId": other, "revisionId": other_at});
        project.approved(
            "test",
            "Weigh-in",
            test_of(json!([
                observed("passed", "First weigh-in"),
                elsewhere,
                weighed
            ])),
            link(&mass, &mass_at, "validates"),
        );
        project.approved(
            "test",
            "Bench check",
            test_of(json!([observed(
                "inconclusive",
                "Scale drifted during the reading"
            )])),
            link(&mass, &mass_at, "validates"),
        );

        let report = project.user("project.coverage", json!({}));
        let limit = row(&report, &mass);
        assert_eq!(
            limit["target"],
            json!({"value": 0.3, "unit": "kg", "min": 0.0, "max": 0.3})
        );
        let evidence = limit["evidence"].as_array().unwrap();
        assert_eq!(evidence[0]["type"], "calculation");
        assert_eq!(evidence[0]["result"], "0.412 kg");
        assert_eq!(evidence[0]["verdict"], "unknown");
        // The newest result that speaks for this requirement decides.
        assert_eq!(evidence[1]["title"], "Weigh-in");
        assert_eq!(evidence[1]["result"], "412 g");
        assert_eq!(evidence[1]["verdict"], "fail");
        assert_eq!(evidence[2]["result"], "Scale drifted during the reading");
        assert_eq!(evidence[2]["verdict"], "unknown");
        assert_eq!(evidence[2]["state"], "current");
        assert_eq!(limit["coverage"], "covered");

        // The result that named the other requirement links the test to it.
        let named = row(&report, &other);
        assert_eq!(named["evidence"][0]["title"], "Weigh-in");
        assert_eq!(named["evidence"][0]["relation"], "validates");
        assert_eq!(named["evidence"][0]["result"], "Unrelated pass");
        assert_eq!(named["evidence"][0]["verdict"], "pass");
    }

    #[test]
    fn draft_requirements_report_their_statement_target_and_review_state() {
        let mut project = TestProject::new();
        let mut known = requirement("Carry a 300 g camera");
        known["target"] = json!({"value": 300, "unit": "g"});
        let (drafted, drafted_at) =
            project.draft(agent("s1"), "requirement", "Payload", known, json!([]));
        let mut open = requirement("Survive a drop");
        open["target"] = json!({"unknown": true, "reason": "drop height not agreed"});
        open["priority"] = json!("could");
        let (unknown, _) = project.draft(agent("s1"), "requirement", "Drop", open, json!([]));
        project.agent(
            "s1",
            "proposal.submit",
            json!({
                "changes": [{"artifactId": drafted, "newRevisionId": drafted_at, "baseRevisionId": null, "kind": "new_artifact"}],
                "reason": "Review the payload requirement",
            }),
        );

        let report = project.user("project.coverage", json!({}));
        let payload = row(&report, &drafted);
        assert_eq!(payload["statement"], "Carry a 300 g camera");
        assert_eq!(payload["target"], json!({"value": 300, "unit": "g"}));
        assert_eq!(payload["review"], "in_review");
        let drop = row(&report, &unknown);
        assert_eq!(drop["review"], "draft");
        assert_eq!(
            drop["target"],
            json!({"unknown": true, "reason": "drop height not agreed"})
        );
        assert_eq!(drop["priority"], "could");
        assert_eq!(report["totals"]["none"], 2);
    }

    #[test]
    fn links_come_from_inputs_results_and_edges_and_only_evidence_counts() {
        let mut project = TestProject::new();
        let (need, need_at) = project.approved(
            "requirement",
            "Payload",
            requirement("Carry 300 g"),
            json!([]),
        );

        // Not evidence: a derived requirement, a note, an archived test.
        project.approved(
            "requirement",
            "Tray size",
            requirement("Tray holds the camera"),
            link(&need, &need_at, "derived_from"),
        );
        project.approved(
            "note",
            "Thoughts",
            json!({"markdown": "About the payload"}),
            link(&need, &need_at, "depends_on"),
        );
        let (retired, _) = project.approved(
            "test",
            "Retired test",
            test_of(json!([observed("passed", "Old pass")])),
            link(&need, &need_at, "validates"),
        );
        project.user(
            "artifact.archive",
            json!({"artifactId": retired, "archived": true}),
        );
        assert_eq!(
            row(&project.user("project.coverage", json!({})), &need)["coverage"],
            "none"
        );

        // A part that depends on the requirement is linked, with no result.
        let (tray, _) = project.approved(
            "mechanical",
            "Camera tray",
            json!({"material": "PETG"}),
            link(&need, &need_at, "depends_on"),
        );
        let report = project.user("project.coverage", json!({}));
        let covered = row(&report, &need);
        assert_eq!(covered["coverage"], "covered");
        assert_eq!(
            covered["reason"],
            "1 part is current. No current test or calculation result is recorded."
        );
        assert_eq!(
            covered["evidence"],
            json!([{
                "artifactId": tray, "type": "mechanical", "title": "Camera tray",
                "relation": "depends_on", "state": "current", "evidenceKind": null,
                "result": null, "verdict": "unknown", "linkReviewed": true,
            }])
        );

        // An edge added by hand, and an approved test whose draft adds a result
        // naming the requirement.
        let (budget, _) =
            project.approved("calculation", "Mass budget", calculation(0.25), json!([]));
        project.user(
            "graph.propose_edges",
            json!({"edges": [{"upstreamArtifactId": need, "downstreamArtifactId": budget, "relationship": "validates"}]}),
        );
        let (bench, bench_at) =
            project.approved("test", "Bench test", test_of(json!([])), json!([]));
        let mut named = observed("passed", "Carried 300 g");
        named["requirementRef"] = json!({"artifactId": need, "revisionId": need_at});
        project.redraft(
            agent("s1"),
            &bench,
            json!({"baseRevisionId": bench_at, "payload": test_of(json!([named]))}),
        );
        let report = project.user("project.coverage", json!({}));
        let linked = row(&report, &need);
        let by_title = |title: &str| {
            linked["evidence"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["title"] == title)
                .unwrap()
        };
        assert_eq!(by_title("Mass budget")["relation"], "validates");
        assert_eq!(by_title("Mass budget")["state"], "current");
        assert_eq!(by_title("Mass budget")["result"], "0.25 kg");
        // The result exists only in a draft of the test, so it is draft evidence.
        assert_eq!(by_title("Bench test")["state"], "draft");
        assert_eq!(by_title("Bench test")["verdict"], "pass");
        assert_eq!(linked["coverage"], "partial");
        assert_eq!(
            linked["reason"],
            "1 part and 1 calculation are current; 1 test is a draft."
        );
    }
}
