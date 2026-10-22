//! The completion gate: what recorded work is still unfinished, for one agent
//! session or for the whole project. Every item is read from stored
//! revisions, checks, offers, proposals and stale markers. Nothing is taken
//! from what an agent says it did.
use super::*;
use reads::{clip, statement, HEAD_REVISION};
use std::collections::{HashMap, HashSet};

/// Items returned in one answer; blockers come first, so what is cut is advice.
const MAX_OUTSTANDING: usize = 100;
const DETAIL_CHARS: usize = 240;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum Kind {
    CadRenderFailed,
    CadCheckFailed,
    CadScopeChanged,
    CadUnverified,
    CadSpecUnasserted,
    ComponentUnsourced,
    ComponentNoOffer,
    WiringFindings,
    WiringUnvalidated,
    CalculationNotRun,
    EmptyPayload,
    ChangesRequested,
    StaleDependent,
    DraftUnproposed,
}

impl Kind {
    const ALL: [Kind; 14] = [
        Kind::CadRenderFailed,
        Kind::CadCheckFailed,
        Kind::CadScopeChanged,
        Kind::CadUnverified,
        Kind::CadSpecUnasserted,
        Kind::ComponentUnsourced,
        Kind::ComponentNoOffer,
        Kind::WiringFindings,
        Kind::WiringUnvalidated,
        Kind::CalculationNotRun,
        Kind::EmptyPayload,
        Kind::ChangesRequested,
        Kind::StaleDependent,
        Kind::DraftUnproposed,
    ];

    fn name(self) -> &'static str {
        match self {
            Kind::CadRenderFailed => "cad_render_failed",
            Kind::CadCheckFailed => "cad_check_failed",
            Kind::CadScopeChanged => "cad_scope_changed",
            Kind::CadUnverified => "cad_unverified",
            Kind::CadSpecUnasserted => "cad_spec_unasserted",
            Kind::ComponentUnsourced => "component_unsourced",
            Kind::ComponentNoOffer => "component_no_offer",
            Kind::WiringFindings => "wiring_findings",
            Kind::WiringUnvalidated => "wiring_unvalidated",
            Kind::CalculationNotRun => "calculation_not_run",
            Kind::EmptyPayload => "empty_payload",
            Kind::ChangesRequested => "changes_requested",
            Kind::StaleDependent => "stale_dependent",
            Kind::DraftUnproposed => "draft_unproposed",
        }
    }

    /// Whether the item makes a claim of completion false. Proposing is the
    /// human's call and staleness is a prompt to look, so both are advice.
    fn blocker(self) -> bool {
        !matches!(self, Kind::StaleDependent | Kind::DraftUnproposed)
    }

    fn clause(self, count: usize) -> String {
        let (one, many) = match self {
            Kind::CadRenderFailed => (
                "part has no rendered geometry",
                "parts have no rendered geometry",
            ),
            Kind::CadCheckFailed => ("part fails its check", "parts fail their checks"),
            Kind::CadScopeChanged => (
                "part dropped assertions it had committed",
                "parts dropped assertions they had committed",
            ),
            Kind::CadUnverified => ("part is not verified", "parts are not verified"),
            Kind::CadSpecUnasserted => (
                "part has items its committed check does not show",
                "parts have items their committed checks do not show",
            ),
            Kind::ComponentUnsourced => ("component has no source", "components have no source"),
            Kind::ComponentNoOffer => (
                "component has no seller offer",
                "components have no seller offer",
            ),
            Kind::WiringFindings => ("wiring draft has findings", "wiring drafts have findings"),
            Kind::WiringUnvalidated => (
                "wiring draft is not validated",
                "wiring drafts are not validated",
            ),
            Kind::CalculationNotRun => (
                "calculation has not been run",
                "calculations have not been run",
            ),
            Kind::EmptyPayload => ("draft is empty", "drafts are empty"),
            Kind::ChangesRequested => (
                "proposal was returned for changes",
                "proposals were returned for changes",
            ),
            Kind::StaleDependent => ("artifact is out of date", "artifacts are out of date"),
            Kind::DraftUnproposed => (
                "draft is not submitted for review",
                "drafts are not submitted for review",
            ),
        };
        format!("{count} {}", if count == 1 { one } else { many })
    }
}

struct Artifact {
    order: usize,
    kind: String,
    title: String,
    selected: Option<String>,
}

struct Item {
    kind: Kind,
    order: usize,
    value: Value,
}

/// What the gate found. `project.summary` embeds a digest of the same report.
pub(super) struct WorkReport {
    scope: &'static str,
    /// The last of the sessions the report covers.
    session_id: Option<String>,
    /// A session was asked for and no agent session exists.
    no_session: bool,
    items: Vec<Item>,
    waiting: Vec<Value>,
    verified_parts: usize,
    /// Artifacts in scope: what the sessions wrote, checked, changed through a
    /// job or proposed (`touched_by`).
    in_scope: usize,
}

impl WorkReport {
    pub(super) fn blockers(&self) -> usize {
        self.items.iter().filter(|item| item.kind.blocker()).count()
    }

    pub(super) fn advice(&self) -> usize {
        self.items.len() - self.blockers()
    }

    pub(super) fn ready(&self) -> bool {
        self.blockers() == 0
    }

    /// Outstanding items, blockers first, each `{kind, severity, …, next}`.
    pub(super) fn outstanding(&self) -> impl Iterator<Item = &Value> {
        self.items.iter().map(|item| &item.value)
    }

    pub(super) fn waiting_on_human(&self) -> &[Value] {
        &self.waiting
    }

    /// One or two sentences that can be shown or repeated as they are.
    pub(super) fn summary(&self) -> String {
        if self.no_session {
            return "No agent session has recorded work in this project.".to_owned();
        }
        let mut sentences = Vec::new();
        if self.verified_parts > 0 {
            sentences.push(format!(
                "{} {} verified",
                self.verified_parts,
                if self.verified_parts == 1 {
                    "part"
                } else {
                    "parts"
                }
            ));
        }
        for kind in Kind::ALL {
            let count = self.items.iter().filter(|item| item.kind == kind).count();
            if count > 0 {
                sentences.push(kind.clause(count));
            }
        }
        if !self.waiting.is_empty() {
            sentences.push(format!(
                "{} {} the human's decision",
                self.waiting.len(),
                if self.waiting.len() == 1 {
                    "proposal awaits"
                } else {
                    "proposals await"
                }
            ));
        }
        if self.items.is_empty() && self.waiting.is_empty() {
            sentences.push(format!("Nothing is unfinished in this {}", self.scope));
        }
        format!("{}.", sentences.join(". "))
    }

    fn to_json(&self) -> Value {
        let omitted = self.items.len().saturating_sub(MAX_OUTSTANDING);
        let mut result = json!({
            "ready": self.ready(),
            "scope": self.scope,
            "summary": self.summary(),
            "outstanding": self.outstanding().take(MAX_OUTSTANDING).collect::<Vec<_>>(),
            "waitingOnHuman": self.waiting,
            "counts": {
                "blockers": self.blockers(),
                "advice": self.advice(),
                "verifiedParts": self.verified_parts,
            },
        });
        if self.scope == "session" {
            result["sessionId"] = json!(self.session_id);
        }
        if omitted > 0 {
            result["truncated"] = json!(true);
            result["omitted"] = json!(omitted);
        }
        result
    }
}

pub(super) fn work_status(
    handle: &ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    let session = match (input["scope"].as_str(), origin.session_id()) {
        (Some("project"), _) | (None, None) => None,
        (_, Some(session_id)) => Some(Some(session_id.to_owned())),
        // The human asking about "the session" means the agent's latest one.
        (Some(_), None) => Some(latest_session(handle)?),
    };
    Ok(build(handle, session)?.to_json())
}

/// Everything unfinished in the project.
pub(super) fn project_work(handle: &ProjectHandle) -> CoreResult<WorkReport> {
    build(handle, None)
}

/// One report for several agent sessions as one scope: what any of them wrote, checked, changed
/// through a job or proposed. The agent host reads it when a conversation turn ends, for the
/// turn's session and those of the turns it continues. Read-only, and not an operation: besides
/// the `work.status` shape it says how many artifacts are in scope (`inScope`) and how many of
/// the sessions' jobs are still queued or running (`jobsRunning`).
pub(super) fn sessions_status(handle: &ProjectHandle, sessions: &[String]) -> CoreResult<Value> {
    let mut unique = Vec::<String>::new();
    for session in sessions {
        if !unique.contains(session) {
            unique.push(session.clone());
        }
    }
    let mut jobs_running = 0_i64;
    for session in &unique {
        jobs_running += statement(
            handle,
            "SELECT COUNT(*) FROM job WHERE session_id=?1 AND status IN ('queued','running')",
        )?
        .query_row([session], |row| row.get::<_, i64>(0))
        .map_err(internal)?;
    }
    let report = build_for(handle, Some(unique))?;
    let mut result = report.to_json();
    result["inScope"] = json!(report.in_scope);
    result["jobsRunning"] = json!(jobs_running);
    Ok(result)
}

fn latest_session(handle: &ProjectHandle) -> CoreResult<Option<String>> {
    let started = statement(
        handle,
        "SELECT id FROM session ORDER BY COALESCE(started_at,'') DESC, id LIMIT 1",
    )?
    .query_row([], |row| row.get::<_, String>(0))
    .optional()
    .map_err(internal)?;
    if started.is_some() {
        return Ok(started);
    }
    statement(
        handle,
        "SELECT origin_detail FROM revision WHERE origin='agent' AND origin_detail IS NOT NULL \
         ORDER BY created_at DESC, seq DESC LIMIT 1",
    )?
    .query_row([], |row| row.get::<_, String>(0))
    .optional()
    .map_err(internal)
}

/// Artifacts a session wrote a revision of, checked, or ran other work on
/// that changes them. A job that only reads a part does not count: an
/// export (`cad_export`), or a render for a view, an inspection or a check's
/// measurement (its inputs name the operation, `for`), which commits
/// nothing to the part. Asked only to export or look at someone else's
/// draft, the session has not taken that draft on.
fn touched_by(handle: &ProjectHandle, session_id: &str) -> CoreResult<HashSet<String>> {
    let mut touched = statement(
        handle,
        "SELECT DISTINCT artifact_id FROM revision WHERE origin_detail=?1",
    )?
    .query_map([session_id], |row| row.get::<_, String>(0))
    .map_err(internal)?
    .collect::<rusqlite::Result<HashSet<_>>>()
    .map_err(internal)?;
    let mut stmt = statement(handle, "SELECT kind, inputs FROM job WHERE session_id=?1")?;
    let rows = stmt
        .query_map([session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(internal)?;
    for row in rows {
        let (kind, inputs) = row.map_err(internal)?;
        let inputs: Value = serde_json::from_str(&inputs).unwrap_or(Value::Null);
        let reads_only = kind == "cad_export" || inputs["for"].is_string();
        if let Some(id) = inputs["artifactId"].as_str().filter(|_| !reads_only) {
            touched.insert(id.to_owned());
        }
    }
    Ok(touched)
}

/// `session`: `None` for the whole project, `Some(None)` when a session was
/// asked for and none exists.
fn build(handle: &ProjectHandle, session: Option<Option<String>>) -> CoreResult<WorkReport> {
    build_for(handle, session.map(|id| id.into_iter().collect()))
}

/// `sessions`: `None` for the whole project, `Some` of no session when one was asked for and
/// none exists, otherwise the sessions whose work is one scope.
fn build_for(handle: &ProjectHandle, sessions: Option<Vec<String>>) -> CoreResult<WorkReport> {
    let mut report = WorkReport {
        scope: if sessions.is_some() {
            "session"
        } else {
            "project"
        },
        session_id: sessions.as_ref().and_then(|ids| ids.last().cloned()),
        no_session: sessions.as_ref().is_some_and(Vec::is_empty),
        items: Vec::new(),
        waiting: Vec::new(),
        verified_parts: 0,
        in_scope: 0,
    };
    if report.no_session {
        return Ok(report);
    }
    let mut touched = match &sessions {
        Some(ids) => {
            let mut touched = HashSet::new();
            for id in ids {
                touched.extend(touched_by(handle, id)?);
            }
            Some(touched)
        }
        None => None,
    };
    let ours = |proposal: &Value| {
        sessions
            .as_ref()
            .is_none_or(|ids| ids.iter().any(|id| proposal["session"] == id.as_str()))
    };

    let mut artifacts = HashMap::<String, Artifact>::new();
    let mut stmt = statement(
        handle,
        "SELECT id, type, title, selected_revision_id FROM artifact WHERE archived=0 \
         ORDER BY created_at, id",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(internal)?;
    for (order, row) in rows.enumerate() {
        let (id, kind, title, selected) = row.map_err(internal)?;
        artifacts.insert(
            id,
            Artifact {
                order,
                kind,
                title,
                selected,
            },
        );
    }

    let proposals = statement(
        handle,
        "SELECT id, changes, reason, state, created_by_session, created_at, resolution_rationale \
         FROM proposal WHERE state IN ('pending','changes_requested') ORDER BY created_at, id",
    )?
    .query_map([], |row| {
        let changes: String = row.get(1)?;
        Ok(json!({
            "id": row.get::<_, String>(0)?,
            "changes": serde_json::from_str::<Value>(&changes).unwrap_or_else(|_| json!([])),
            "reason": row.get::<_, String>(2)?,
            "state": row.get::<_, String>(3)?,
            "session": row.get::<_, Option<String>>(4)?,
            "createdAt": row.get::<_, String>(5)?,
            "rationale": row.get::<_, Option<String>>(6)?,
        }))
    })
    .map_err(internal)?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(internal)?;
    let changed = |proposal: &Value| {
        proposal["changes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|change| change["artifactId"].as_str())
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    if let Some(touched) = touched.as_mut() {
        for proposal in proposals.iter().filter(|proposal| ours(proposal)) {
            touched.extend(changed(proposal));
        }
    }
    let in_scope = |id: &str| touched.as_ref().is_none_or(|touched| touched.contains(id));
    report.in_scope = artifacts.keys().filter(|id| in_scope(id)).count();

    // Proposals: waiting on the human, or sent back to the author.
    for proposal in &proposals {
        let ids = changed(proposal);
        let mine = ours(proposal);
        if proposal["state"] == "pending" {
            if mine {
                report.waiting.push(json!({
                    "proposalId": proposal["id"],
                    "reason": proposal["reason"],
                    "state": "pending",
                }));
            }
            continue;
        }
        if !mine && !ids.iter().any(|id| in_scope(id)) {
            continue;
        }
        // Answered once every artifact it named has a newer proposal waiting,
        // or a baseline that moved after the request.
        let open = proposal["changes"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|change| {
                let id = change["artifactId"].as_str().unwrap_or_default();
                let resubmitted = proposals.iter().any(|later| {
                    later["state"] == "pending"
                        && later["createdAt"].as_str() >= proposal["createdAt"].as_str()
                        && changed(later).iter().any(|other| other == id)
                });
                let rebased = artifacts.get(id).is_some_and(|artifact| {
                    artifact.selected.as_deref() != change["baseRevisionId"].as_str()
                });
                artifacts.contains_key(id) && !resubmitted && !rebased
            });
        let Some(change) = open else {
            continue;
        };
        let id = change["artifactId"].as_str().unwrap_or_default();
        let artifact = &artifacts[id];
        let note = proposal["rationale"]
            .as_str()
            .map(str::trim)
            .filter(|note| !note.is_empty());
        report.items.push(item(
            Kind::ChangesRequested,
            id,
            artifact,
            change["newRevisionId"].as_str(),
            match note {
                Some(note) => format!("The reviewer asked for changes: {note}"),
                None => "The reviewer asked for changes and left no note.".to_owned(),
            },
            Some((
                "proposal_read",
                "Read the request, revise the draft, then submit a new proposal".to_owned(),
                json!({"proposalId": proposal["id"]}),
            )),
        ));
    }

    let offers = statement(
        handle,
        "SELECT component_artifact_id, COUNT(*), \
         COALESCE(SUM(url IS NOT NULL OR source_id IS NOT NULL), 0) \
         FROM offer GROUP BY component_artifact_id",
    )?
    .query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            (row.get::<_, i64>(1)?, row.get::<_, i64>(2)?),
        ))
    })
    .map_err(internal)?
    .collect::<rusqlite::Result<HashMap<_, _>>>()
    .map_err(internal)?;

    // Work in progress: artifacts whose newest revision in play is not the
    // approved baseline.
    let heads = statement(
        handle,
        &format!(
            "SELECT r.* FROM artifact a JOIN revision r ON r.id={HEAD_REVISION} \
             WHERE a.archived=0 AND r.review_state IN ('draft','proposed') \
             ORDER BY a.created_at, a.id"
        ),
    )?
    .query_map([], revision_from_row)
    .map_err(internal)?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(internal)?;
    for revision in &heads {
        let id = revision["artifactId"].as_str().unwrap_or_default();
        let Some(artifact) = artifacts.get(id).filter(|_| in_scope(id)) else {
            continue;
        };
        let before = report.items.len();
        let draft = Draft {
            handle,
            id,
            artifact,
            revision,
        };
        match artifact.kind.as_str() {
            "subsystem" => {}
            "mechanical" => match draft.cad(&artifacts) {
                Some(found) => report.items.push(found),
                None => report.verified_parts += 1,
            },
            _ if draft.is_empty() => report.items.push(draft.item(
                Kind::EmptyPayload,
                format!("Draft {} has no content yet.", draft.label()),
                "artifact_update_draft",
                format!(
                    "Save the content; tool_describe with artifactType \"{}\" lists the fields",
                    artifact.kind
                ),
                json!({"artifactId": id}),
            )),
            "component" => report
                .items
                .extend(draft.component(&artifacts, offers.get(id))),
            "wiring" => report.items.extend(draft.wiring()),
            "calculation" => report.items.extend(draft.calculation()),
            _ => {}
        }
        if report.items.len() == before && revision["reviewState"] == "draft" {
            let kind = if artifact.selected.is_some() {
                "baseline_update"
            } else {
                "new_artifact"
            };
            report.items.push(draft.item(
                Kind::DraftUnproposed,
                format!("Draft {} is not submitted for review.", draft.label()),
                "proposal_submit",
                "Only when review was asked for: submit it with a reason".to_owned(),
                json!({"changes": [{
                    "artifactId": id,
                    "newRevisionId": revision["id"],
                    "baseRevisionId": artifact.selected,
                    "kind": kind,
                }]}),
            ));
        }
    }

    // Approved work whose inputs moved on; a missing input names the state.
    let mut stmt = statement(
        handle,
        "SELECT artifact_id, upstream_artifact_id, reason FROM stale \
         ORDER BY artifact_id, reason='missing_input' DESC, upstream_artifact_id",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(internal)?;
    let mut reported = HashSet::new();
    for row in rows {
        let (id, upstream, reason) = row.map_err(internal)?;
        let Some(artifact) = artifacts.get(&id) else {
            continue;
        };
        if !(in_scope(&id) || in_scope(&upstream)) || !reported.insert(id.clone()) {
            continue;
        }
        let cause = artifacts
            .get(&upstream)
            .map_or("an input", |upstream| upstream.title.as_str());
        report.items.push(item(
            Kind::StaleDependent,
            &id,
            artifact,
            artifact.selected.as_deref(),
            if reason == "missing_input" {
                format!("An input it was built on is missing: {cause}.")
            } else {
                format!("Out of date: {cause} changed after this was approved.")
            },
            Some((
                "artifact_read",
                "Check it against the changed input, then save an updated draft that lists its inputs again".to_owned(),
                json!({"artifactId": id}),
            )),
        ));
    }

    report
        .items
        .sort_by_key(|item| (!item.kind.blocker(), item.order, item.kind));
    Ok(report)
}

type Next = (&'static str, String, Value);

fn item(
    kind: Kind,
    id: &str,
    artifact: &Artifact,
    revision_id: Option<&str>,
    detail: String,
    next: Option<Next>,
) -> Item {
    Item {
        kind,
        order: artifact.order,
        value: json!({
            "kind": kind.name(),
            "severity": if kind.blocker() { "blocker" } else { "advice" },
            "artifactId": id,
            "revisionId": revision_id,
            "type": artifact.kind,
            "title": artifact.title,
            "detail": clip(&detail, DETAIL_CHARS),
            "next": next.map(|(tool, why, args)| json!({"tool": tool, "why": why, "args": args})),
        }),
    }
}

/// The newest revision in play of one artifact, not yet the baseline.
struct Draft<'a> {
    handle: &'a ProjectHandle,
    id: &'a str,
    artifact: &'a Artifact,
    revision: &'a Value,
}

impl Draft<'_> {
    /// `r3`: how revisions are named to people.
    fn label(&self) -> String {
        format!("r{}", self.revision["seq"])
    }

    fn item(
        &self,
        kind: Kind,
        detail: String,
        tool: &'static str,
        why: String,
        args: Value,
    ) -> Item {
        item(
            kind,
            self.id,
            self.artifact,
            self.revision["id"].as_str(),
            detail,
            Some((tool, why, args)),
        )
    }

    /// Nothing authored: no files, and every payload field blank or still at
    /// the default its type starts with.
    fn is_empty(&self) -> bool {
        if self.revision["files"]
            .as_array()
            .is_some_and(|files| !files.is_empty())
        {
            return false;
        }
        let schema = registry().artifact_payload_schemas.get(&self.artifact.kind);
        let default =
            |key: &str| schema.and_then(|schema| schema["properties"][key].get("default"));
        self.revision["payload"].as_object().is_none_or(|payload| {
            payload
                .iter()
                .all(|(key, value)| is_blank(value) || default(key) == Some(value))
        })
    }

    /// The outstanding item for a part, or `None` when the committed check
    /// for exactly this revision passed.
    fn cad(&self, artifacts: &HashMap<String, Artifact>) -> Option<Item> {
        let label = self.label();
        let payload = &self.revision["payload"];
        let rendered = payload["stl"]["sha256"].is_string()
            && payload["renderIdentity"]["outputHash"] == payload["stl"]["sha256"];
        if !rendered {
            return Some(self.item(
                Kind::CadRenderFailed,
                format!("Latest draft {label} has no rendered geometry."),
                "cad_write_source",
                "Fix the source so it renders, then run cad_check".to_owned(),
                json!({"artifactId": self.id}),
            ));
        }
        // Linked requirements that disagree leave nothing a check could
        // pass; only a person can reconcile them.
        if let Ok(Some(conflict)) = cad::requirement_conflict(self.handle, self.revision) {
            return Some(item(
                Kind::CadUnverified,
                self.id,
                self.artifact,
                self.revision["id"].as_str(),
                format!("No check of {label} can run: {conflict}. A person must reconcile them."),
                None,
            ));
        }
        let verification = match cad::latest_verification(self.handle, self.revision) {
            Ok(verification) => verification,
            Err(error) => {
                return Some(self.item(
                    Kind::CadUnverified,
                    format!(
                        "The verification record of {label} could not be read: {}",
                        error.message
                    ),
                    "cad_check",
                    format!("Commit verification for {label}"),
                    json!({"artifactId": self.id}),
                ));
            }
        };
        let evidence = &verification["evidence"];
        if let (Some("unverified"), Some(stale)) = (
            verification["status"].as_str(),
            verification["staleInputs"].as_array(),
        ) {
            return Some(self.checked_on_old_inputs(artifacts, stale));
        }
        match verification["status"].as_str() {
            // Passed, unless requirements were linked or changed since.
            Some("passed") => self.spec_item(&verification),
            Some("failed") => {
                let checks = evidence["checks"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                let failed = checks
                    .iter()
                    .filter(|check| check["pass"] != true)
                    .filter_map(|check| check["name"].as_str())
                    .collect::<Vec<_>>();
                let named = if failed.is_empty() {
                    "the mesh is not a closed, positive-volume solid".to_owned()
                } else {
                    format!(
                        "{} of {} assertions failed ({})",
                        failed.len(),
                        checks.len(),
                        failed.join(", ")
                    )
                };
                Some(self.item(
                    Kind::CadCheckFailed,
                    format!("The committed check of {label} failed: {named}."),
                    "cad_check",
                    "Fix the geometry with cad_write_source (or an expectation that misreads the request), then run cad_check with this committed expect".to_owned(),
                    self.check_again(),
                ))
            }
            Some("scope_changed") => {
                fn words(value: &Value) -> Vec<&str> {
                    value
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .collect()
                }
                let replaced = words(&evidence["spec"]["replaced"]);
                let own = if replaced.is_empty() {
                    words(&evidence["scopeChanges"])
                } else {
                    words(&evidence["spec"]["checkChanges"])
                };
                // Linked requirements now state committed assertions
                // differently: nothing is left for the agent to restore.
                if own.is_empty() && !replaced.is_empty() {
                    return Some(item(
                        Kind::CadScopeChanged,
                        self.id,
                        self.artifact,
                        self.revision["id"].as_str(),
                        format!(
                            "The committed check of {label} replaced committed assertions with what linked requirements now state: {}. A person must accept the new scope.",
                            replaced.join("; ")
                        ),
                        None,
                    ));
                }
                let requirements = if replaced.is_empty() {
                    String::new()
                } else {
                    format!(
                        " Linked requirements now state others differently ({}); a person accepts those.",
                        replaced.join("; ")
                    )
                };
                Some(self.item(
                    Kind::CadScopeChanged,
                    format!(
                        "The committed check of {label} drops or loosens assertions committed before: {}.{requirements}",
                        own.join(", ")
                    ),
                    "cad_check",
                    format!("Check {label} again with every assertion committed before"),
                    self.check_again(),
                ))
            }
            Some("partial")
                if verification["spec"]["counts"]["blocking"]
                    .as_u64()
                    .is_some_and(|blocking| blocking > 0) =>
            {
                self.spec_item(&verification)
            }
            Some("partial") => Some(self.item(
                Kind::CadUnverified,
                format!("The committed check of {label} asserts nothing from the request."),
                "cad_check",
                format!("Commit a check of {label} with the dimensions the request states"),
                json!({"artifactId": self.id}),
            )),
            _ => Some(self.item(
                Kind::CadUnverified,
                format!("Latest draft {label} has no committed check."),
                "cad_check",
                format!("Commit verification for {label}"),
                self.check_again(),
            )),
        }
    }

    /// Listed items the committed check has no assertion for, and linked
    /// requirements it does not show as they stand: one blocker that names
    /// them, with the expect that adds them. `None` when there are none.
    fn spec_item(&self, verification: &Value) -> Option<Item> {
        let spec = &verification["spec"];
        let rows = |key: &str| spec[key].as_array().map(Vec::as_slice).unwrap_or(&[]);
        let (missing, since) = (rows("missing"), rows("linkedSince"));
        let unasserted = spec["counts"]["unasserted"].as_u64().unwrap_or(0) as usize;
        if unasserted == 0 && since.is_empty() {
            return None;
        }
        let label = self.label();
        let mut detail = Vec::new();
        if unasserted > 0 {
            let total = spec["counts"]["items"].as_u64().unwrap_or(0);
            detail.push(format!(
                "The committed check of {label} has no assertion for {unasserted} of {total} listed {}: {}.",
                if total == 1 { "item" } else { "items" },
                cad::quoted(missing, unasserted)
            ));
        }
        let mut revised = false;
        for entry in since {
            let title = entry["title"].as_str().unwrap_or("");
            detail.push(match entry["change"].as_str() {
                Some("linked_after") => format!("Requirement \"{title}\" was linked to this part after the committed check of {label}, so the check does not show it."),
                Some("revised") => {
                    revised = true;
                    let target = entry["target"]
                        .as_str()
                        .map(|target| format!(" (it now states {target})"))
                        .unwrap_or_default();
                    format!("Requirement \"{title}\" changed after the committed check of {label}{target}, so the check does not show it as it stands.")
                }
                _ => format!("The committed check of {label} does not take requirement \"{title}\" into account."),
            });
        }
        // A changed requirement, or one that states a committed value
        // differently, changes committed values, which only a person
        // accepts; a plain commit records that scope for review.
        let mut args = json!({"artifactId": self.id});
        let scope = cad::committed_scope(self.handle, self.revision);
        let restated = scope.as_ref().is_ok_and(|(_, restated)| *restated);
        if restated && !revised {
            detail.push(
                "Its linked requirements now state committed values differently; the next check takes theirs, and a person accepts that scope."
                    .to_owned(),
            );
        }
        if !revised && !restated {
            args["autoCommit"] = json!(true);
        }
        let expect = scope.and_then(|(committed, _)| {
            cad::next_expect(self.handle, self.revision, &committed, spec)
        });
        // Without a readable record the part is still named; the agent
        // rebuilds the expect.
        if let Some(expect) = expect
            .ok()
            .filter(|expect| expect.as_object().is_some_and(|e| !e.is_empty()))
        {
            args["expect"] = expect;
        }
        let why = if unasserted > 0 {
            let first = cad::quoted(&missing[..1.min(missing.len())], unasserted);
            format!(
                "Give {first} the assertions that show {} (size, holes, bbox, sections with axis, at and outer d or size), keep every other item, then run cad_check; name any the geometry cannot show instead of asserting something else",
                if unasserted == 1 { "it" } else { "them" }
            )
        } else if revised {
            // A changed target is shown by the items that name it, which
            // the agent restates; nothing is added beside them.
            let restate = since
                .iter()
                .filter(|entry| entry["change"] == "revised" && entry["kind"] == "statement")
                .flat_map(|entry| {
                    args["expect"]["spec"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(move |item| item["requirementId"] == entry["requirementId"])
                        .filter_map(|item| item["item"].as_str())
                        .map(|text| format!("\"{text}\""))
                })
                .collect::<Vec<_>>();
            if restate.is_empty() {
                format!("Check {label} against the requirement as it stands; a changed committed value then waits on a person's acceptance")
            } else {
                format!("Restate {} against the requirement as it stands and run cad_check; a changed committed value then waits on a person's acceptance", restate.join(", "))
            }
        } else {
            "Run cad_check again so the linked requirements add their items to the check".to_owned()
        };
        Some(self.item(
            Kind::CadSpecUnasserted,
            detail.join(" "),
            "cad_check",
            why,
            args,
        ))
    }

    /// `cad_check` arguments that repeat the expectation every committed
    /// and accepted scope of this part requires, so it is not rebuilt by
    /// trial.
    fn check_again(&self) -> Value {
        let mut args = json!({"artifactId": self.id});
        let committed = cad::committed_expect(self.handle, self.revision);
        if let Some(committed) = committed.ok().filter(Value::is_object) {
            // As the linked requirements state it now, so repeating it does
            // not trip on a value a requirement changed.
            let expect = cad::next_expect(self.handle, self.revision, &committed, &Value::Null)
                .unwrap_or_else(|_| cad::request_form(&committed));
            if expect.as_object().is_some_and(|fields| !fields.is_empty()) {
                args["expect"] = expect;
            }
        }
        args
    }

    /// A check that passed, of a part built on inputs that are no longer
    /// their approved baseline. Checking it again cannot change that: either
    /// the part is rebuilt on the current inputs, or the human approves the
    /// revisions it was built on.
    fn checked_on_old_inputs(
        &self,
        artifacts: &HashMap<String, Artifact>,
        stale: &[Value],
    ) -> Item {
        let label = self.label();
        let title = |id: &str| {
            artifacts.get(id).map_or_else(
                || "an input that no longer exists".to_owned(),
                |a| a.title.clone(),
            )
        };
        // Pinned at a revision still in review: approving it settles this.
        let awaiting = |input: &Value| {
            input["revisionId"]
                .as_str()
                .and_then(|id| get_revision(self.handle, id).ok().flatten())
                .is_some_and(|revision| review::is_candidate(&revision))
        };
        let (waiting, moved): (Vec<&Value>, Vec<&Value>) =
            stale.iter().partition(|input| awaiting(input));
        let names = |inputs: &[&Value]| {
            inputs
                .iter()
                .filter_map(|input| input["artifactId"].as_str())
                .map(title)
                .collect::<Vec<_>>()
                .join(", ")
        };
        if moved.is_empty() {
            return item(
                Kind::CadUnverified,
                self.id,
                self.artifact,
                self.revision["id"].as_str(),
                format!(
                    "{label} passed its committed check, but it is built on revisions that are not approved yet: {}. It is verified once the human approves them.",
                    names(&waiting)
                ),
                None,
            );
        }
        // List the inputs again: an input that moved pins its current
        // baseline, one that is gone or archived is left out.
        let rebuilt = self.revision["inputs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|input| {
                let id = input["artifactId"].as_str()?;
                artifacts.get(id)?;
                let mut kept = json!({"artifactId": id, "relationship": input["relationship"]});
                if !moved.iter().any(|stale| stale["artifactId"] == id) {
                    kept["revisionId"] = input["revisionId"].clone();
                }
                if let Some(label) = input["label"].as_str() {
                    kept["label"] = json!(label);
                }
                Some(kept)
            })
            .collect::<Vec<_>>();
        self.item(
            Kind::CadUnverified,
            format!(
                "{label} passed its committed check against older revisions of its inputs: {}. Checking it again does not change that.",
                names(&moved)
            ),
            "artifact_update_draft",
            format!("Rebuild {label} on the current revisions of its inputs, then run cad_check on the new draft"),
            json!({"artifactId": self.id, "inputs": rebuilt}),
        )
    }

    fn component(
        &self,
        artifacts: &HashMap<String, Artifact>,
        offers: Option<&(i64, i64)>,
    ) -> Vec<Item> {
        let payload = &self.revision["payload"];
        if matches!(payload["status"].as_str(), Some("rejected" | "superseded")) {
            return Vec::new();
        }
        let (offer_count, offers_with_source) = offers.copied().unwrap_or((0, 0));
        // A citation counts only when it names a source this project holds.
        let is_source = |id: &Value| {
            id.as_str()
                .and_then(|id| artifacts.get(id))
                .is_some_and(|upstream| upstream.kind == "source")
        };
        let cites_source = |facts: &Value| {
            facts
                .as_object()
                .is_some_and(|facts| facts.values().any(|fact| is_source(&fact["sourceId"])))
        };
        let derived_from_source = self.revision["inputs"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|input| {
                input["relationship"] == "derived_from" && is_source(&input["artifactId"])
            });
        let label = self.label();
        let mut items = Vec::new();
        if !(derived_from_source
            || offers_with_source > 0
            || cites_source(&payload["properties"])
            || cites_source(&payload["attributes"]))
        {
            items.push(self.item(
                Kind::ComponentUnsourced,
                format!("Draft {label} cites no source for its data."),
                "source_capture",
                "Record the product page or datasheet, then link it as a derived_from input with artifact_update_draft".to_owned(),
                json!({}),
            ));
        }
        if offer_count == 0 {
            items.push(self.item(
                Kind::ComponentNoOffer,
                "No seller offer is recorded, so price and availability are unknown.".to_owned(),
                "component_add_offer",
                "Record a seller, its page address and the price".to_owned(),
                json!({"artifactId": self.id}),
            ));
        }
        items
    }

    fn wiring(&self) -> Option<Item> {
        let label = self.label();
        let args = json!({"artifactId": self.id, "revisionId": self.revision["id"]});
        let findings = match wiring::validate(self.handle, &args) {
            Ok(result) => result["findings"].as_array().cloned().unwrap_or_default(),
            Err(error) => {
                return Some(self.item(
                    Kind::WiringUnvalidated,
                    format!("Validation of {label} could not run: {}", error.message),
                    "wiring_validate",
                    "Run the wiring checks".to_owned(),
                    args,
                ));
            }
        };
        let of = |severity: &str| {
            findings
                .iter()
                .filter(|finding| finding["severity"] == severity)
                .collect::<Vec<_>>()
        };
        let first = |found: &[&Value]| found[0]["message"].as_str().unwrap_or_default().to_owned();
        let errors = of("error");
        if !errors.is_empty() {
            return Some(self.item(
                Kind::WiringFindings,
                format!(
                    "{} to fix in {label}: {}",
                    count(errors.len(), "finding", "findings"),
                    first(&errors)
                ),
                "wiring_validate",
                "Read every finding, then correct the connections".to_owned(),
                args,
            ));
        }
        let connections = self.revision["payload"]["connections"]
            .as_array()
            .map_or(0, Vec::len);
        if connections == 0 {
            return Some(self.item(
                Kind::WiringUnvalidated,
                format!("Draft {label} declares no connections, so nothing was checked."),
                "wiring_set_connections",
                "Declare the connections, then run wiring_validate".to_owned(),
                json!({"artifactId": self.id}),
            ));
        }
        let warnings = of("warning");
        if !warnings.is_empty() {
            return Some(self.item(
                Kind::WiringUnvalidated,
                format!(
                    "{} in {label} could not be checked: {}",
                    count(warnings.len(), "connection end", "connection ends"),
                    first(&warnings)
                ),
                "wiring_set_pins",
                "Declare each pin with its type and voltage range so the checks can run".to_owned(),
                json!({"artifactId": self.id}),
            ));
        }
        None
    }

    /// A calculation is run when the engine computes the result it records
    /// from the inputs it records; a result written into the payload is not.
    fn calculation(&self) -> Option<Item> {
        let payload = &self.revision["payload"];
        if calculation::computed(payload) {
            return None;
        }
        let result = &payload["result"];
        let has_result = result["quantity"]["value"].is_number()
            || result["text"]
                .as_str()
                .is_some_and(|text| !text.trim().is_empty());
        let mut args = json!({"artifactId": self.id});
        for key in ["templateId", "expression", "inputs"] {
            if !is_blank(&payload[key]) {
                args[key] = payload[key].clone();
            }
        }
        let unknown = payload["inputs"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|input| input["quantity"]["unknown"] == true)
            .and_then(|input| input["name"].as_str());
        let label = self.label();
        Some(self.item(
            Kind::CalculationNotRun,
            match (unknown, has_result) {
                (Some(name), false) => format!(
                    "Draft {label} records no result, and input {name} has no value yet."
                ),
                (None, false) => format!("Draft {label} records no result."),
                (Some(name), true) => format!(
                    "Draft {label} records a result, but input {name} has no value, so nothing computed it."
                ),
                (None, true) => format!(
                    "Draft {label} records a result that calculation_run did not compute from its inputs."
                ),
            },
            "calculation_run",
            "Run it so the result is computed and recorded with its unit".to_owned(),
            args,
        ))
    }
}

fn count(number: usize, one: &str, many: &str) -> String {
    format!("{number} {}", if number == 1 { one } else { many })
}

/// No content: null, whitespace, or a container holding only such values.
fn is_blank(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(text) => text.trim().is_empty(),
        Value::Array(items) => items.iter().all(is_blank),
        Value::Object(map) => map.values().all(is_blank),
        Value::Bool(_) | Value::Number(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cad::testing::engine_available;
    use crate::testkit::{agent, requirement, TestProject};

    /// `(kind, severity)` of every outstanding item about one artifact.
    fn about<'a>(status: &'a Value, artifact_id: &str) -> Vec<(&'a str, &'a str)> {
        status["outstanding"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["artifactId"] == artifact_id)
            .map(|item| {
                (
                    item["kind"].as_str().unwrap(),
                    item["severity"].as_str().unwrap(),
                )
            })
            .collect()
    }

    fn item<'a>(status: &'a Value, kind: &str) -> &'a Value {
        status["outstanding"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["kind"] == kind)
            .unwrap_or_else(|| panic!("no {kind} in {status}"))
    }

    #[test]
    fn every_kind_the_contract_names_has_a_name_here() {
        let names = Kind::ALL.map(Kind::name);
        let mut sorted = names.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        // 0.2.4 adds cad_spec_unasserted.
        assert_eq!(sorted.len(), 14);
        for kind in Kind::ALL {
            assert_eq!(
                kind.blocker(),
                !matches!(kind.name(), "draft_unproposed" | "stale_dependent"),
                "{}",
                kind.name()
            );
        }
        // Declaration order is report order.
        let mut ordered = Kind::ALL.to_vec();
        ordered.sort();
        assert!(ordered == Kind::ALL);
    }

    #[test]
    fn a_component_needs_a_source_and_a_seller_offer() {
        let mut project = TestProject::new();
        let (bare, bare_revision) = project.draft(
            agent("s1"),
            "component",
            "Steering servo",
            json!({"partNumber": "MG996R"}),
            json!([]),
        );
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(status["ready"], false);
        assert_eq!(status["scope"], "session");
        assert_eq!(
            about(&status, &bare),
            [
                ("component_unsourced", "blocker"),
                ("component_no_offer", "blocker")
            ]
        );
        assert_eq!(
            status["summary"],
            "1 component has no source. 1 component has no seller offer."
        );
        assert_eq!(
            status["counts"],
            json!({"blockers": 2, "advice": 0, "verifiedParts": 0})
        );
        let offer = item(&status, "component_no_offer");
        assert_eq!(offer["revisionId"], bare_revision.as_str());
        assert_eq!(offer["type"], "component");
        assert_eq!(offer["title"], "Steering servo");
        assert_eq!(
            offer["next"],
            json!({
                "tool": "component_add_offer",
                "why": "Record a seller, its page address and the price",
                "args": {"artifactId": bare},
            })
        );
        assert_eq!(
            item(&status, "component_unsourced")["next"]["tool"],
            "source_capture"
        );

        // An offer with a page address is both a source and an offer.
        let mut offer = offer["next"]["args"].clone();
        offer["seller"] = json!("Example Robotics");
        offer["url"] = json!("https://example.com/mg996r");
        project.agent("s1", "component.add_offer", offer);
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(status["ready"], true);
        assert_eq!(about(&status, &bare), [("draft_unproposed", "advice")]);

        // A captured source without an offer; an offer without an address.
        let source = project.agent(
            "s1",
            "source.capture",
            json!({"url": "https://example.com/datasheet.pdf", "title": "Datasheet"}),
        );
        let (cited, _) = project.draft(
            agent("s1"),
            "component",
            "Drive motor",
            json!({"partNumber": "N20"}),
            json!([{"artifactId": source["artifact"]["id"], "relationship": "derived_from"}]),
        );
        let (unsourced, _) = project.draft(
            agent("s1"),
            "component",
            "Battery",
            json!({"partNumber": "2S-1000"}),
            json!([]),
        );
        project.agent(
            "s1",
            "component.add_offer",
            json!({"artifactId": unsourced, "seller": "Market stall"}),
        );
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(about(&status, &cited), [("component_no_offer", "blocker")]);
        assert_eq!(
            about(&status, &unsourced),
            [("component_unsourced", "blocker")]
        );
        assert_eq!(status["ready"], false);
    }

    #[test]
    fn a_cited_source_counts_only_when_the_project_holds_it() {
        let mut project = TestProject::new();
        let mass = |source_id: &str| {
            json!({"partNumber": "MG996R", "properties": {"mass": {
                "quantity": {"value": 55, "unit": "g"}, "sourceId": source_id}}})
        };
        let (invented, _) = project.draft(
            agent("s1"),
            "component",
            "Steering servo",
            mass("11111111-1111-4111-8111-111111111111"),
            json!([]),
        );
        let (note, _) = project.draft(
            agent("s1"),
            "note",
            "Shop notes",
            json!({"markdown": "MG996R is 55 g"}),
            json!([]),
        );
        let (not_a_source, _) = project.draft(
            agent("s1"),
            "component",
            "Pan servo",
            mass(&note),
            json!([]),
        );
        let source = project.agent(
            "s1",
            "source.capture",
            json!({"url": "https://example.com/mg996r.pdf", "title": "MG996R datasheet"}),
        );
        let (cited, _) = project.draft(
            agent("s1"),
            "component",
            "Tilt servo",
            mass(source["artifact"]["id"].as_str().unwrap()),
            json!([]),
        );
        let status = project.agent("s1", "work.status", json!({}));
        for unsourced in [&invented, &not_a_source] {
            assert_eq!(
                about(&status, unsourced),
                [
                    ("component_unsourced", "blocker"),
                    ("component_no_offer", "blocker")
                ]
            );
        }
        assert_eq!(about(&status, &cited), [("component_no_offer", "blocker")]);
    }

    #[test]
    fn wiring_is_unvalidated_until_every_connection_can_be_checked() {
        let mut project = TestProject::new();
        let (board, board_revision) = project.approved(
            "component",
            "Controller",
            json!({"partNumber": "MCU-1"}),
            json!([]),
        );
        let (servo, servo_revision) = project.approved(
            "component",
            "Servo",
            json!({"partNumber": "MG996R"}),
            json!([]),
        );
        let connect = |from: &str, to: &str| {
            json!({
                "id": uuid::Uuid::new_v4().to_string(),
                "from": {"componentArtifactId": board, "componentRevisionId": board_revision, "pin": from},
                "to": {"componentArtifactId": servo, "componentRevisionId": servo_revision, "pin": to},
                "signalRole": "servo drive",
            })
        };
        let pin = |component: &str, name: &str, kind: &str| json!({"componentArtifactId": component, "pin": name, "type": kind});
        let (wiring, _) = project.draft(
            agent("s1"),
            "wiring",
            "Harness",
            json!({"pins": [pin(&board, "D9", "signal")]}),
            json!([]),
        );
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(about(&status, &wiring), [("wiring_unvalidated", "blocker")]);
        let found = item(&status, "wiring_unvalidated");
        assert_eq!(
            found["detail"],
            "Draft r1 declares no connections, so nothing was checked."
        );
        assert_eq!(found["next"]["tool"], "wiring_set_connections");

        // A connection to a pin nobody declared cannot be checked.
        project.agent(
            "s1",
            "wiring.set_connections",
            json!({"artifactId": wiring, "connections": [connect("D9", "SIG")]}),
        );
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(about(&status, &wiring), [("wiring_unvalidated", "blocker")]);
        let found = item(&status, "wiring_unvalidated");
        assert!(
            found["detail"]
                .as_str()
                .unwrap()
                .starts_with("1 connection end in r2 could not be checked: Unknown pin 'SIG'"),
            "{found}"
        );
        assert_eq!(found["next"]["tool"], "wiring_set_pins");

        project.agent(
            "s1",
            "wiring.set_pins",
            json!({"artifactId": wiring, "pins": [pin(&board, "D9", "signal"), pin(&servo, "SIG", "signal")]}),
        );
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(about(&status, &wiring), [("draft_unproposed", "advice")]);
        assert_eq!(status["ready"], true);

        // Power without a ground return is a finding.
        project.agent(
            "s1",
            "wiring.set_pins",
            json!({"artifactId": wiring, "pins": [pin(&board, "5V", "power"), pin(&servo, "VCC", "power")]}),
        );
        project.agent(
            "s1",
            "wiring.set_connections",
            json!({"artifactId": wiring, "connections": [connect("5V", "VCC")]}),
        );
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(about(&status, &wiring), [("wiring_findings", "blocker")]);
        let found = item(&status, "wiring_findings");
        assert!(
            found["detail"]
                .as_str()
                .unwrap()
                .starts_with("2 findings to fix in r5: Component "),
            "{found}"
        );
        assert_eq!(found["next"]["tool"], "wiring_validate");
        assert_eq!(found["next"]["args"]["artifactId"], wiring.as_str());
        assert_eq!(status["summary"], "1 wiring draft has findings.");
    }

    #[test]
    fn a_calculation_without_a_result_has_not_been_run() {
        let mut project = TestProject::new();
        let (budget, _) = project.draft(
            agent("s1"),
            "calculation",
            "Mass budget",
            json!({
                "expression": "chassis + battery",
                "inputs": [
                    {"name": "chassis", "quantity": {"value": 1.2, "unit": "kg"}},
                    {"name": "battery", "quantity": {"value": 400, "unit": "g"}}
                ]
            }),
            json!([]),
        );
        let (blocked, _) = project.draft(
            agent("s1"),
            "calculation",
            "Range",
            json!({
                "expression": "capacity / draw",
                "inputs": [{"name": "draw", "quantity": {"unknown": true, "reason": "not measured"}}]
            }),
            json!([]),
        );
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(
            about(&status, &budget),
            [("calculation_not_run", "blocker")]
        );
        assert_eq!(
            about(&status, &blocked),
            [("calculation_not_run", "blocker")]
        );
        assert_eq!(status["summary"], "2 calculations have not been run.");
        let items = status["outstanding"].as_array().unwrap();
        assert_eq!(items[0]["detail"], "Draft r1 records no result.");
        assert_eq!(
            items[1]["detail"],
            "Draft r1 records no result, and input draw has no value yet."
        );

        // The suggested call runs as given.
        let next = &items[0]["next"];
        assert_eq!(next["tool"], "calculation_run");
        assert_eq!(next["args"]["expression"], "chassis + battery");
        let ran = project.agent("s1", "calculation.run", next["args"].clone());
        assert_eq!(ran["artifactId"], budget.as_str());
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(about(&status, &budget), []);
        assert_eq!(
            status["waitingOnHuman"][0]["proposalId"],
            ran["proposal"]["id"]
        );
    }

    #[test]
    fn empty_drafts_block_and_finished_drafts_only_advise() {
        let mut project = TestProject::new();
        let (note, _) = project.draft(
            agent("s1"),
            "note",
            "Blank note",
            json!({"markdown": "  "}),
            json!([]),
        );
        let (wiring, _) = project.draft(agent("s1"), "wiring", "Harness", json!({}), json!([]));
        let (test, _) = project.draft(agent("s1"), "test", "Load test", json!({}), json!([]));
        let (need, need_revision) = project.draft(
            agent("s1"),
            "requirement",
            "Payload",
            requirement("Carry a 300 g camera"),
            json!([]),
        );
        let status = project.agent("s1", "work.status", json!({}));
        for empty in [&note, &wiring, &test] {
            assert_eq!(about(&status, empty), [("empty_payload", "blocker")]);
        }
        assert_eq!(
            status["summary"],
            "3 drafts are empty. 1 draft is not submitted for review."
        );
        let blank = item(&status, "empty_payload");
        assert_eq!(blank["detail"], "Draft r1 has no content yet.");
        assert_eq!(blank["next"]["tool"], "artifact_update_draft");
        assert_eq!(blank["next"]["args"], json!({"artifactId": note}));
        // Blockers are listed before advice.
        let kinds = status["outstanding"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["severity"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(kinds, ["blocker", "blocker", "blocker", "advice"]);

        let advice = item(&status, "draft_unproposed");
        assert_eq!(advice["artifactId"], need.as_str());
        assert_eq!(advice["detail"], "Draft r1 is not submitted for review.");
        assert_eq!(advice["next"]["tool"], "proposal_submit");
        assert_eq!(
            advice["next"]["args"]["changes"],
            json!([{
                "artifactId": need,
                "newRevisionId": need_revision,
                "baseRevisionId": null,
                "kind": "new_artifact",
            }])
        );

        // A file is content even when the payload fields are empty.
        let with_file = project.agent(
            "s1",
            "artifact.create_draft",
            json!({
                "type": "software",
                "title": "Firmware",
                "payload": {},
                "files": [{"path": "firmware/main.c", "contentBase64": "aW50IG1haW4oKTs="}]
            }),
        );
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(
            about(&status, with_file["artifact"]["id"].as_str().unwrap()),
            [("draft_unproposed", "advice")]
        );
    }

    #[test]
    fn returned_proposals_block_until_resubmitted() {
        let mut project = TestProject::new();
        let (plan, first) = project.draft(
            agent("s1"),
            "note",
            "Test plan",
            json!({"markdown": "v1"}),
            json!([]),
        );
        let mut submission = json!({
            "changes": [{"artifactId": plan, "newRevisionId": first, "baseRevisionId": null, "kind": "new_artifact"}],
            "reason": "Review the test plan",
        });
        let proposal = project.agent("s1", "proposal.submit", submission.clone());

        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(status["ready"], true);
        assert_eq!(status["outstanding"], json!([]));
        assert_eq!(
            status["waitingOnHuman"],
            json!([{"proposalId": proposal["id"], "reason": "Review the test plan", "state": "pending"}])
        );
        assert_eq!(status["summary"], "1 proposal awaits the human's decision.");

        project.user(
            "proposal.request_changes",
            json!({"proposalId": proposal["id"], "rationale": "State the test conditions"}),
        );
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(status["ready"], false);
        assert_eq!(status["waitingOnHuman"], json!([]));
        assert_eq!(about(&status, &plan), [("changes_requested", "blocker")]);
        let returned = item(&status, "changes_requested");
        assert_eq!(
            returned["detail"],
            "The reviewer asked for changes: State the test conditions"
        );
        assert_eq!(returned["revisionId"], first.as_str());
        assert_eq!(returned["next"]["tool"], "proposal_read");
        assert_eq!(
            returned["next"]["args"],
            json!({"proposalId": proposal["id"]})
        );
        assert_eq!(status["summary"], "1 proposal was returned for changes.");

        // A newer draft alone does not answer the reviewer; a new proposal does.
        let second = project.redraft(agent("s1"), &plan, json!({"payload": {"markdown": "v2"}}));
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(
            about(&status, &plan),
            [
                ("changes_requested", "blocker"),
                ("draft_unproposed", "advice")
            ]
        );
        submission["changes"][0]["newRevisionId"] = json!(second);
        let resubmitted = project.agent("s1", "proposal.submit", submission);
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(status["ready"], true);
        assert_eq!(status["outstanding"], json!([]));
        assert_eq!(status["waitingOnHuman"][0]["proposalId"], resubmitted["id"]);
    }

    #[test]
    fn approved_work_built_on_a_changed_input_is_advice() {
        let mut project = TestProject::new();
        let (need, need_revision) = project.approved(
            "requirement",
            "Payload",
            requirement("Carry a 300 g camera"),
            json!([]),
        );
        let (plan, plan_revision) = project.approved(
            "note",
            "Test plan",
            json!({"markdown": "Load the tray with 300 g"}),
            json!([{"artifactId": need, "revisionId": need_revision, "relationship": "depends_on"}]),
        );
        let heavier = project.redraft(
            agent("s1"),
            &need,
            json!({"baseRevisionId": need_revision, "payload": requirement("Carry a 500 g camera")}),
        );
        assert_eq!(project.agent("s1", "work.status", json!({}))["ready"], true);
        project.accept(&need, &heavier);

        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(status["ready"], true);
        assert_eq!(about(&status, &plan), [("stale_dependent", "advice")]);
        let stale = item(&status, "stale_dependent");
        assert_eq!(
            stale["detail"],
            "Out of date: Payload changed after this was approved."
        );
        assert_eq!(stale["revisionId"], plan_revision.as_str());
        assert_eq!(stale["next"]["tool"], "artifact_read");
        assert_eq!(stale["next"]["args"], json!({"artifactId": plan}));
        assert_eq!(status["summary"], "1 artifact is out of date.");

        // Another session touched neither the plan nor what changed.
        let other = project.agent("s2", "work.status", json!({}));
        assert_eq!(other["outstanding"], json!([]));
        assert_eq!(other["summary"], "Nothing is unfinished in this session.");
        let whole = project.user("work.status", json!({}));
        assert_eq!(about(&whole, &plan), [("stale_dependent", "advice")]);
    }

    /// Exporting a person's draft, or looking at it, is not working on it:
    /// those jobs only read the part. Checking it is.
    #[test]
    fn a_session_that_only_exports_or_views_a_part_has_not_taken_it_on() {
        if !engine_available() {
            return;
        }
        let mut project = TestProject::new();
        let written = project.user(
            "cad.write_source",
            json!({"title": "Human plate", "source": "w = 20;\ncube([w, 10, 2]);", "timeoutMs": 60_000}),
        );
        let plate = written["artifactId"].as_str().unwrap().to_owned();
        let nothing = |project: &mut TestProject| {
            let status = project.agent("s1", "work.status", json!({}));
            assert_eq!(
                status["summary"], "Nothing is unfinished in this session.",
                "{status}"
            );
            assert_eq!(
                sessions_status(project.handle(), &["s1".into()]).unwrap()["inScope"],
                0
            );
        };
        let exported = project.agent(
            "s1",
            "cad.export",
            json!({"artifactId": plate, "format": "step", "method": "faceted", "destPath": "exports/plate.step"}),
        );
        assert_eq!(exported["method"], "faceted", "{exported}");
        project.agent(
            "s1",
            "cad.export",
            json!({"artifactId": plate, "format": "stl", "destPath": "exports/plate.stl"}),
        );
        nothing(&mut project);
        // A variant is rendered under a job, for the view or the inspection.
        let viewed = project.agent(
            "s1",
            "cad.view",
            json!({"artifactId": plate, "params": {"w": 22}, "views": ["top"], "sections": []}),
        );
        assert_eq!(viewed["mesh"]["source"], "rendered", "{viewed}");
        project.agent(
            "s1",
            "cad.inspect",
            json!({"artifactId": plate, "params": {"w": 22}}),
        );
        nothing(&mut project);
        let jobs = project.agent("s1", "job.list", json!({"limit": 50}))["jobs"].clone();
        let kinds = jobs
            .as_array()
            .unwrap()
            .iter()
            .map(|job| (job["kind"].as_str().unwrap(), job["inputs"]["for"].as_str()))
            .collect::<HashSet<_>>();
        assert!(kinds.contains(&("cad_export", None)), "{jobs}");
        assert!(kinds.contains(&("cad_render", Some("cad.view"))), "{jobs}");
        assert!(
            kinds.contains(&("cad_render", Some("cad.inspect"))),
            "{jobs}"
        );
        // A check of the part takes it on.
        project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": plate, "exploratory": true, "expect": {"size": [20, 10, 2]}}),
        );
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(about(&status, &plate), [("cad_unverified", "blocker")]);
    }

    #[test]
    fn a_chain_of_sessions_is_one_scope() {
        let mut project = TestProject::new();
        let (servo, _) = project.draft(
            agent("s1"),
            "component",
            "Steering servo",
            json!({"partNumber": "MG996R"}),
            json!([]),
        );
        let chain = ["s1".to_owned(), "s2".to_owned()];
        let status = sessions_status(project.handle(), &chain).unwrap();
        assert_eq!(status["ready"], false);
        assert_eq!(status["scope"], "session");
        assert_eq!(status["sessionId"], "s2", "the latest session of the chain");
        assert!(
            status.get("sessionIds").is_none(),
            "the host records the chain it asked about"
        );
        assert_eq!(
            about(&status, &servo),
            [
                ("component_unsourced", "blocker"),
                ("component_no_offer", "blocker")
            ]
        );
        assert_eq!(
            (&status["inScope"], &status["jobsRunning"]),
            (&json!(1), &json!(0))
        );
        // The later session alone touched nothing, which is no comfort for the chain.
        let alone = project.agent("s2", "work.status", json!({}));
        assert_eq!(alone["ready"], true);
        assert_eq!(alone["summary"], "Nothing is unfinished in this session.");
        let repeated = sessions_status(project.handle(), &["s1".into(), "s1".into()]).unwrap();
        assert_eq!(repeated["outstanding"], status["outstanding"]);
        let none = sessions_status(project.handle(), &[]).unwrap();
        assert_eq!(none["ready"], true);
        assert_eq!(
            none["summary"],
            "No agent session has recorded work in this project."
        );
        assert_eq!(none["inScope"], 0);

        // The later session resolves what the earlier one left.
        let mut offer = item(&status, "component_no_offer")["next"]["args"].clone();
        offer["seller"] = json!("Example Robotics");
        offer["url"] = json!("https://example.com/mg996r");
        project.agent("s2", "component.add_offer", offer);
        let status = sessions_status(project.handle(), &chain).unwrap();
        assert_eq!(status["ready"], true, "{status}");
        assert_eq!(about(&status, &servo), [("draft_unproposed", "advice")]);

        // A proposal of the earlier session waits on the human for the whole chain.
        let (plan, revision) = project.draft(
            agent("s1"),
            "note",
            "Test plan",
            json!({"markdown": "v1"}),
            json!([]),
        );
        let proposal = project.agent(
            "s1",
            "proposal.submit",
            json!({
                "changes": [{"artifactId": plan, "newRevisionId": revision, "baseRevisionId": null, "kind": "new_artifact"}],
                "reason": "Review the test plan",
            }),
        );
        let status = sessions_status(project.handle(), &chain).unwrap();
        assert_eq!(
            status["waitingOnHuman"],
            json!([{"proposalId": proposal["id"], "reason": "Review the test plan", "state": "pending"}])
        );
        assert_eq!(status["inScope"], 2);
        assert!(
            project.agent("s2", "work.status", json!({}))["waitingOnHuman"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn scope_is_the_callers_session_for_an_agent_and_the_project_for_the_human() {
        let mut project = TestProject::new();
        let empty = project.user("work.status", json!({"scope": "session"}));
        assert_eq!(empty["ready"], true);
        assert_eq!(empty["scope"], "session");
        assert!(empty["sessionId"].is_null());
        assert_eq!(
            empty["summary"],
            "No agent session has recorded work in this project."
        );

        let (budget, _) = project.draft(
            agent("s1"),
            "calculation",
            "Mass budget",
            json!({"expression": "a + b"}),
            json!([]),
        );
        // With no session row, the session that last wrote a revision counts.
        let latest = project.user("work.status", json!({"scope": "session"}));
        assert_eq!(latest["sessionId"], "s1");
        assert_eq!(
            about(&latest, &budget),
            [("calculation_not_run", "blocker")]
        );

        let (note, _) = project.draft(
            agent("s2"),
            "note",
            "Notes",
            json!({"markdown": "Text"}),
            json!([]),
        );
        let (by_hand, _) = project.draft(
            Origin::User,
            "note",
            "Blank",
            json!({"markdown": ""}),
            json!([]),
        );

        let first = project.agent("s1", "work.status", json!({}));
        assert_eq!(first["scope"], "session");
        assert_eq!(first["sessionId"], "s1");
        assert_eq!(first["ready"], false);
        assert_eq!(about(&first, &budget), [("calculation_not_run", "blocker")]);
        assert_eq!(first["outstanding"].as_array().unwrap().len(), 1);

        let second = project.agent("s2", "work.status", json!({"scope": "session"}));
        assert_eq!(second["ready"], true);
        assert_eq!(about(&second, &note), [("draft_unproposed", "advice")]);
        assert_eq!(second["outstanding"].as_array().unwrap().len(), 1);

        for whole in [
            project.agent("s2", "work.status", json!({"scope": "project"})),
            project.user("work.status", json!({})),
        ] {
            assert_eq!(whole["scope"], "project");
            assert!(whole.get("sessionId").is_none());
            assert_eq!(whole["ready"], false);
            assert_eq!(about(&whole, &budget), [("calculation_not_run", "blocker")]);
            assert_eq!(about(&whole, &note), [("draft_unproposed", "advice")]);
            assert_eq!(about(&whole, &by_hand), [("empty_payload", "blocker")]);
        }

        // Once sessions are registered, the most recently started one counts.
        for (session, started) in [
            ("s2", "2026-03-01T10:00:00.000Z"),
            ("s1", "2026-03-02T10:00:00.000Z"),
        ] {
            project
                .app
                .upsert_session(
                    &project.id,
                    &json!({"id": session, "adapterId": "codex", "executablePath": "/bin/sh", "state": "exited", "startedAt": started}),
                )
                .unwrap();
        }
        let registered = project.user("work.status", json!({"scope": "session"}));
        assert_eq!(registered["sessionId"], "s1");
        assert_eq!(registered["outstanding"], first["outstanding"]);

        // Work on someone else's draft joins the session through its jobs.
        project.agent(
            "s2",
            "calculation.run",
            json!({
                "artifactId": budget,
                "expression": "a + b",
                "inputs": [
                    {"name": "a", "quantity": {"value": 1, "unit": "kg"}},
                    {"name": "b", "quantity": {"value": 2, "unit": "kg"}}
                ],
                "submitForReview": false
            }),
        );
        let second = project.agent("s2", "work.status", json!({}));
        assert_eq!(about(&second, &budget), [("draft_unproposed", "advice")]);
    }

    #[test]
    fn part_states_come_from_the_committed_check_of_the_latest_draft() {
        if !engine_available() {
            return;
        }
        let mut project = TestProject::new();
        let plate = "cube([20, 10, 2]);";
        let full = json!({
            "bbox": {"min": [0, 0, 0], "max": [20, 10, 2]},
            "volume": {"value": 400},
            "solid": [[10, 5, 1]],
            "empty": [[30, 5, 1]],
            "sections": [{"axis": "z", "at": 1, "outerCount": 1, "holeCount": 0, "outer": {"size": [20, 10]}}]
        });
        let write = |project: &mut TestProject, title: &str, source: &str| {
            let written = project.agent(
                "s1",
                "cad.write_source",
                json!({"title": title, "source": source, "timeoutMs": 60_000}),
            );
            written["artifactId"].as_str().unwrap().to_owned()
        };

        let broken = write(&mut project, "Broken bracket", "cube([20, 10, 2]");
        let unchecked = write(&mut project, "Unchecked plate", plate);
        let failing = write(&mut project, "Failing plate", plate);
        let generic = write(&mut project, "Generic plate", plate);
        let verified = write(&mut project, "Verified plate", plate);

        // A trial run is not a committed check.
        project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": unchecked, "exploratory": true, "expect": full}),
        );
        project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": failing, "expect": {"bbox": {"min": [0, 0, 0], "max": [25, 10, 2]}}}),
        );
        project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": generic, "expect": {}}),
        );
        let passed = project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": verified, "expect": full}),
        );
        assert_eq!(passed["verificationStatus"], "passed", "{passed}");

        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(status["ready"], false);
        assert_eq!(about(&status, &broken), [("cad_render_failed", "blocker")]);
        assert_eq!(about(&status, &unchecked), [("cad_unverified", "blocker")]);
        assert_eq!(about(&status, &failing), [("cad_check_failed", "blocker")]);
        assert_eq!(about(&status, &generic), [("cad_unverified", "blocker")]);
        assert_eq!(about(&status, &verified), [("draft_unproposed", "advice")]);
        assert_eq!(status["counts"]["verifiedParts"], 1);
        assert_eq!(
            status["summary"],
            "1 part verified. 1 part has no rendered geometry. 1 part fails its check. 2 parts are not verified. 1 draft is not submitted for review."
        );

        let by_artifact = |id: &str| {
            status["outstanding"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["artifactId"] == id)
                .unwrap()
        };
        let no_geometry = by_artifact(&broken);
        assert_eq!(no_geometry["type"], "mechanical");
        assert_eq!(
            no_geometry["detail"],
            "Latest draft r1 has no rendered geometry."
        );
        assert_eq!(no_geometry["next"]["tool"], "cad_write_source");
        assert_eq!(no_geometry["next"]["args"], json!({"artifactId": broken}));
        let no_check = by_artifact(&unchecked);
        assert_eq!(
            no_check["detail"],
            "Latest draft r1 has no committed check."
        );
        assert_eq!(
            no_check["next"],
            json!({"tool": "cad_check", "why": "Commit verification for r1", "args": {"artifactId": unchecked}})
        );
        let failed = by_artifact(&failing);
        assert!(
            failed["detail"]
                .as_str()
                .unwrap()
                .starts_with("The committed check of r1 failed: 1 of "),
            "{failed}"
        );
        // The failed assertions stay binding: the next check repeats them.
        assert_eq!(failed["next"]["tool"], "cad_check");
        let failing_check = project.agent("s1", "job.list", json!({"limit": 200}))["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|job| {
                job["kind"] == "cad_check" && job["inputs"]["artifactId"] == failing.as_str()
            })
            .unwrap()["inputs"]["expect"]
            .clone();
        assert_eq!(
            failed["next"]["args"],
            json!({"artifactId": failing, "expect": failing_check})
        );
        assert_eq!(
            by_artifact(&generic)["detail"],
            "The committed check of r1 asserts nothing from the request."
        );

        // Committing fewer assertions than before does not keep the part
        // verified; the reply names the committed expect to repeat.
        let narrowed = project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": verified, "expect": {"bbox": {"min": [0, 0, 0], "max": [20, 10, 2]}}}),
        );
        assert_eq!(narrowed["verificationStatus"], "scope_changed");
        assert_eq!(narrowed["committedExpect"], passed["normalizedExpect"]);
        assert_eq!(
            narrowed["nextStep"]["args"],
            json!({"artifactId": verified, "expect": passed["normalizedExpect"]})
        );
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(
            about(&status, &verified),
            [("cad_scope_changed", "blocker")]
        );
        let weakened = item(&status, "cad_scope_changed");
        assert!(
            weakened["detail"].as_str().unwrap().starts_with(
                "The committed check of r1 drops or loosens assertions committed before: "
            ),
            "{weakened}"
        );
        assert_eq!(weakened["next"]["tool"], "cad_check");
        assert_eq!(
            weakened["next"]["args"],
            json!({"artifactId": verified, "expect": passed["normalizedExpect"]})
        );
        assert_eq!(status["counts"]["verifiedParts"], 0);
        // Following the item restores the scope.
        let restored = project.agent("s1", "cad.check", weakened["next"]["args"].clone());
        assert_eq!(restored["verificationStatus"], "passed", "{restored}");

        // A new revision of a verified part starts unverified again.
        project.agent(
            "s1",
            "cad.write_source",
            json!({"artifactId": verified, "source": "cube([20, 10, 3]);", "timeoutMs": 60_000}),
        );
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(about(&status, &verified), [("cad_unverified", "blocker")]);
        assert_eq!(
            item(&status, "cad_unverified")["next"]["why"],
            "Commit verification for r1"
        );
        // It inherits the scope committed on the revision it continues.
        let inherited = status["outstanding"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["artifactId"] == verified.as_str())
            .unwrap();
        assert_eq!(
            inherited["next"]["args"]["expect"],
            passed["normalizedExpect"]
        );
    }

    /// A part checked against an input that has since moved on is not told
    /// it has no check, and checking it again is not what clears it.
    #[test]
    fn a_part_checked_against_old_inputs_is_rebuilt_not_rechecked() {
        if !engine_available() {
            return;
        }
        let mut project = TestProject::new();
        let (envelope, envelope_at) = project.approved(
            "requirement",
            "Envelope",
            requirement("Fit 20 mm"),
            json!([]),
        );
        let written = project.agent(
            "s1",
            "cad.write_source",
            json!({"title": "Plate", "source": "cube([20, 10, 2]);", "timeoutMs": 60_000}),
        );
        let plate = written["artifactId"].as_str().unwrap().to_owned();
        let linked = project.agent(
            "s1",
            "artifact.update_draft",
            json!({"artifactId": plate, "inputs": [{"artifactId": envelope, "relationship": "depends_on"}]}),
        );
        assert!(linked["revision"]["payload"]["renderIdentity"].is_object());
        let expect = json!({"size": [20, 10, 2], "bodies": 1});
        let checked = project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": plate, "expect": expect}),
        );
        assert_eq!(checked["verificationStatus"], "passed", "{checked}");
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(status["counts"]["verifiedParts"], 1);

        let wider = project.redraft(
            Origin::User,
            &envelope,
            json!({"baseRevisionId": envelope_at, "payload": requirement("Fit 25 mm")}),
        );
        project.accept(&envelope, &wider);
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(about(&status, &plate), [("cad_unverified", "blocker")]);
        let found = item(&status, "cad_unverified");
        assert_eq!(
            found["detail"],
            "r2 passed its committed check against older revisions of its inputs: Envelope. Checking it again does not change that."
        );
        assert_eq!(found["next"]["tool"], "artifact_update_draft");
        assert_eq!(
            found["next"]["args"],
            json!({"artifactId": plate, "inputs": [{"artifactId": envelope, "relationship": "depends_on"}]})
        );

        // Checking again leaves it as it is; rebuilding on the current
        // input and checking that revision verifies the part.
        project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": plate, "expect": expect}),
        );
        let again = project.agent("s1", "work.status", json!({}));
        assert_eq!(item(&again, "cad_unverified")["detail"], found["detail"]);
        let rebuilt = project.agent("s1", "artifact.update_draft", found["next"]["args"].clone());
        assert_eq!(
            rebuilt["revision"]["inputs"][0]["revisionId"],
            wider.as_str()
        );
        let rechecked = project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": plate, "expect": expect}),
        );
        assert_eq!(rechecked["verificationStatus"], "passed", "{rechecked}");
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(about(&status, &plate), [("draft_unproposed", "advice")]);
        assert_eq!(status["counts"]["verifiedParts"], 1);
    }

    fn plate_part(project: &mut TestProject) -> String {
        let written = project.agent(
            "s1",
            "cad.write_source",
            json!({"title": "Plate", "source": "cube([20, 10, 2]);", "timeoutMs": 60_000}),
        );
        written["artifactId"].as_str().unwrap().to_owned()
    }

    fn bay(target_mm: f64) -> Value {
        json!({"statement": "Fits the 20 mm bay", "acceptanceCriterion": "Shown by test",
            "priority": "could", "target": {"value": target_mm, "unit": "mm"}})
    }

    #[test]
    fn listed_items_without_an_assertion_block_until_a_check_gives_them_one() {
        if !engine_available() {
            return;
        }
        let mut project = TestProject::new();
        let plate = plate_part(&mut project);
        let checked = project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": plate, "autoCommit": true, "expect": {"bodies": 1, "spec": [
                {"item": "plate 20 x 10 x 2 mm", "size": [20, 10, 2]},
                {"item": "material at the centre"}]}}),
        );
        // Every assertion passes, so the check is committed and binds; the
        // item without one keeps it partial.
        assert_eq!(
            (&checked["verificationStatus"], &checked["committed"]),
            (&json!("partial"), &json!(true)),
            "{checked}"
        );
        assert_eq!(checked["spec"]["counts"]["blocking"], 1);
        let committed = json!({"shells": 1, "spec": [
            {"item": "plate 20 x 10 x 2 mm", "size": [20, 10, 2]},
            {"item": "material at the centre"}]});
        assert_eq!(
            checked["nextStep"]["args"],
            json!({"artifactId": plate, "autoCommit": true, "expect": committed})
        );

        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(about(&status, &plate), [("cad_spec_unasserted", "blocker")]);
        assert_eq!(status["ready"], false);
        assert_eq!(status["counts"]["verifiedParts"], 0);
        assert_eq!(
            status["summary"],
            "1 part has items its committed check does not show."
        );
        let found = item(&status, "cad_spec_unasserted");
        assert_eq!(
            found["detail"],
            "The committed check of r1 has no assertion for 1 of 2 listed items: \"material at the centre\"."
        );
        assert_eq!(found["next"]["tool"], "cad_check");
        assert_eq!(found["next"]["args"], checked["nextStep"]["args"]);

        // Following it with the assertion added verifies the part.
        let mut args = found["next"]["args"].clone();
        args["expect"]["spec"][1]["solid"] = json!([[10, 5, 1]]);
        let fixed = project.agent("s1", "cad.check", args);
        assert_eq!(fixed["verificationStatus"], "passed", "{fixed}");
        assert!(fixed["scopeChanges"].as_array().unwrap().is_empty());
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(about(&status, &plate), [("draft_unproposed", "advice")]);
        assert_eq!(status["counts"]["verifiedParts"], 1);
    }

    #[test]
    fn a_requirement_linked_after_the_check_reopens_the_draft_but_not_the_baseline() {
        if !engine_available() {
            return;
        }
        let mut project = TestProject::new();
        let plate = plate_part(&mut project);
        let passed = project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": plate, "autoCommit": true, "expect": {"bodies": 1, "spec": [
                {"item": "plate 20 x 10 x 2 mm", "size": [20, 10, 2]}]}}),
        );
        assert_eq!(passed["verificationStatus"], "passed", "{passed}");
        std::thread::sleep(std::time::Duration::from_millis(10));
        let (fits, _) = project.draft(
            agent("s1"),
            "requirement",
            "Fits the bay",
            bay(20.0),
            json!([]),
        );
        project.agent(
            "s1",
            "graph.propose_edges",
            json!({"edges": [{"upstreamArtifactId": fits, "downstreamArtifactId": plate, "relationship": "validates"}]}),
        );
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(about(&status, &plate), [("cad_spec_unasserted", "blocker")]);
        let found = item(&status, "cad_spec_unasserted");
        assert_eq!(
            found["detail"],
            "Requirement \"Fits the bay\" was linked to this part after the committed check of r1, so the check does not show it."
        );
        // The next check adds an item naming the requirement, without an
        // assertion: it shows where one is missing.
        assert_eq!(
            found["next"]["args"],
            json!({"artifactId": plate, "autoCommit": true, "expect": {"shells": 1, "spec": [
                {"item": "plate 20 x 10 x 2 mm", "size": [20, 10, 2]},
                {"item": "Fits the bay", "requirementId": fits}]}})
        );
        // The recorded status stays what was committed.
        let latest = {
            let handle = project.handle();
            let revision = get_revision(handle, passed["revisionId"].as_str().unwrap())
                .unwrap()
                .unwrap();
            cad::readiness(handle, &revision).unwrap()
        };
        assert_eq!(latest["status"], "passed");
        assert_eq!(latest["spec"]["linkedSince"][0]["change"], "linked_after");
        assert!(latest["summary"].as_str().unwrap().ends_with(
            "The committed check does not show requirement \"Fits the bay\" as it stands now."
        ));

        // Sent as it is, the placeholder blocks, once: it is the
        // requirement's row. With a dimension it shows the requirement.
        let bare = project.agent("s1", "cad.check", found["next"]["args"].clone());
        assert_eq!(bare["verificationStatus"], "partial", "{bare}");
        assert_eq!(bare["spec"]["counts"]["blocking"], 1);
        assert_eq!(bare["spec"]["counts"]["items"], 2);
        let mut args = found["next"]["args"].clone();
        args["expect"]["spec"][1]["size"] = json!([20, 10, 2]);
        let shown = project.agent("s1", "cad.check", args);
        assert_eq!(shown["verificationStatus"], "passed", "{shown}");
        assert_eq!(shown["spec"]["items"][1]["state"], "passed");
        assert_eq!(shown["spec"]["items"][1]["statement"], true);
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(about(&status, &plate), [("draft_unproposed", "advice")]);

        // An approved part keeps its recorded status when a requirement is
        // linked later: the build names it and does not refuse for it.
        let head = project.agent("s1", "cad.read_source", json!({"artifactId": plate}))
            ["revisionId"]
            .as_str()
            .unwrap()
            .to_owned();
        project.accept(&plate, &head);
        std::thread::sleep(std::time::Duration::from_millis(10));
        let (wider, _) = project.draft(
            Origin::User,
            "requirement",
            "Clears the lid",
            bay(2.0),
            json!([]),
        );
        project.user(
            "graph.propose_edges",
            json!({"edges": [{"upstreamArtifactId": wider, "downstreamArtifactId": plate, "relationship": "validates"}]}),
        );
        let preview = project.user("build.preview", json!({}));
        let part = preview["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["artifactId"] == plate.as_str())
            .unwrap();
        assert_eq!(part["verification"]["status"], "passed");
        assert!(part["issues"].as_array().unwrap().is_empty(), "{part}");
        assert_eq!(
            part["notices"],
            json!(["The committed check of Plate does not show requirement \"Clears the lid\" as it stands now."])
        );
        let status = project.user("work.status", json!({"scope": "project"}));
        assert!(about(&status, &plate).is_empty(), "{status}");
    }

    #[test]
    fn a_draft_requirement_as_an_input_still_waits_on_approval() {
        if !engine_available() {
            return;
        }
        let mut project = TestProject::new();
        let (fits, _) = project.draft(
            agent("s1"),
            "requirement",
            "Fits the bay",
            bay(20.0),
            json!([]),
        );
        let plate = plate_part(&mut project);
        project.agent(
            "s1",
            "artifact.update_draft",
            json!({"artifactId": plate, "inputs": [{"artifactId": fits, "relationship": "validates"}]}),
        );
        let checked = project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": plate, "autoCommit": true, "expect": {"spec": [
                {"item": "fits the bay", "requirementId": fits, "size": [20, 10, 2]}]}}),
        );
        assert_eq!(checked["spec"]["items"][0]["state"], "passed", "{checked}");
        assert_eq!(checked["spec"]["items"][0]["statement"], true);
        assert_eq!(checked["verificationStatus"], "unverified");
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(about(&status, &plate), [("cad_unverified", "blocker")]);
        assert!(item(&status, "cad_unverified")["next"].is_null());
    }

    #[test]
    fn a_requirement_that_changed_replaces_its_items_and_waits_on_a_person() {
        if !engine_available() {
            return;
        }
        let mut project = TestProject::new();
        let plate = plate_part(&mut project);
        let features = |expect: Value| {
            json!({"statement": "The plate fills the bay", "acceptanceCriterion": "Shown by test",
                "priority": "must", "features": [{"label": "Plate envelope", "expect": expect}]})
        };
        let (envelope, at) = project.approved(
            "requirement",
            "Plate envelope",
            features(json!({"size": [20, 10, 2]})),
            json!([]),
        );
        project.user(
            "graph.propose_edges",
            json!({"edges": [{"upstreamArtifactId": envelope, "downstreamArtifactId": plate, "relationship": "validates"}]}),
        );
        let derived = project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": plate, "autoCommit": true}),
        );
        assert_eq!(derived["verificationStatus"], "passed", "{derived}");
        assert_eq!(
            derived["derivedSpec"],
            json!(["added from requirement \"Plate envelope\": Plate envelope"])
        );
        assert_eq!(derived["spec"]["items"][0]["from"], "requirement");
        // The requirement's own assertion shows its feature, and an approved
        // requirement a person linked stands behind the check.
        assert_eq!(derived["spec"]["items"][0]["assertedBy"], "requirement");
        assert_eq!(
            evidence(&project, &derived)["coverage"]["requirementAuthority"],
            "requirements_and_declared"
        );

        // A person states the envelope as corners instead of a size.
        let revised = project.redraft(
            Origin::User,
            &envelope,
            json!({"baseRevisionId": at, "payload": features(json!({"bbox": {"min": [0, 0, 0], "max": [20, 10, 2]}}))}),
        );
        project.accept(&envelope, &revised);
        let status = project.agent("s1", "work.status", json!({}));
        let found = item(&status, "cad_spec_unasserted");
        assert_eq!(
            found["detail"],
            "Requirement \"Plate envelope\" changed after the committed check of r1, so the check does not show it as it stands."
        );
        // A plain commit records the changed scope for the person.
        assert!(found["next"]["args"]["autoCommit"].is_null());
        assert_eq!(
            found["next"]["args"]["expect"]["spec"][0]["bbox"],
            json!({"min": [0, 0, 0], "max": [20, 10, 2]})
        );
        let changed = project.agent("s1", "cad.check", found["next"]["args"].clone());
        assert_eq!(changed["verificationStatus"], "scope_changed", "{changed}");
        assert_eq!(
            changed["spec"]["replaced"],
            json!(["\"Plate envelope\" from requirement \"Plate envelope\""])
        );
        // Nothing is left for the agent to restore: the next action, the
        // next step and the gate all wait on a person.
        assert_eq!(changed["nextAction"], "accept_scope");
        assert_eq!(changed["work"]["nextAction"], "accept_scope");
        assert_eq!(changed["nextStep"]["tool"], "work_status");
        assert!(changed.get("committedExpect").is_none());
        let status = project.agent("s1", "work.status", json!({}));
        let waiting = item(&status, "cad_scope_changed");
        assert!(waiting["next"].is_null(), "{waiting}");
        assert!(waiting["detail"]
            .as_str()
            .unwrap()
            .ends_with("A person must accept the new scope."));
        let latest = {
            let handle = project.handle();
            let revision = get_revision(handle, changed["revisionId"].as_str().unwrap())
                .unwrap()
                .unwrap();
            cad::readiness(handle, &revision).unwrap()
        };
        assert_eq!(
            (&latest["status"], &latest["nextAction"]),
            (&json!("scope_changed"), &json!("accept_scope"))
        );
        // A trial of the same scope is committed first, so a person can
        // accept it.
        let mut trial = found["next"]["args"].clone();
        trial["exploratory"] = json!(true);
        let trial = project.agent("s1", "cad.check", trial);
        assert_eq!(
            (&trial["verificationStatus"], &trial["committed"]),
            (&json!("scope_changed"), &json!(false))
        );
        assert_eq!(trial["nextAction"], "commit_assertions");
        assert_eq!(trial["nextStep"]["tool"], "cad_check");
        assert!(trial["nextStep"]["args"]["exploratory"].is_null());
        assert!(trial["nextStep"]["args"]["autoCommit"].is_null());
        assert_eq!(
            trial["nextStep"]["args"]["expect"],
            changed["normalizedExpect"]
        );
    }

    /// A requirement titled with spaces alone gave its row and placeholder
    /// no words, and the check's own next step was then refused. A feature
    /// label of spaces alone is refused when it is written.
    #[test]
    fn a_blank_requirement_title_still_gives_a_next_step_that_runs() {
        if !engine_available() {
            return;
        }
        let mut project = TestProject::new();
        let plate = plate_part(&mut project);
        let (bay, _) = project.draft(
            Origin::User,
            "requirement",
            "  ",
            json!({"statement": "Fits the 20 mm bay", "acceptanceCriterion": "Shown by test",
                "priority": "must", "target": {"value": 20, "unit": "mm"}}),
            json!([]),
        );
        link(&mut project, &bay, &plate);
        let first = project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": plate, "autoCommit": true, "expect": {"bodies": 1}}),
        );
        assert_eq!(first["verificationStatus"], "partial", "{first}");
        assert_eq!(first["spec"]["items"][0]["item"], "Fits the 20 mm bay");
        assert_eq!(
            first["nextStep"]["args"]["expect"]["spec"],
            json!([{"item": "Fits the 20 mm bay", "requirementId": bay}])
        );
        let next = project.agent("s1", "cad.check", first["nextStep"]["args"].clone());
        assert_eq!(next["verificationStatus"], "partial", "{next}");
        let status = project.agent("s1", "work.status", json!({}));
        let found = item(&status, "cad_spec_unasserted");
        assert!(
            found["detail"]
                .as_str()
                .unwrap()
                .ends_with("requirement \"Fits the 20 mm bay\"."),
            "{found}"
        );
        project.agent("s1", "cad.check", found["next"]["args"].clone());

        let error = project
            .call(
                Origin::User,
                "artifact.create_draft",
                json!({"type": "requirement", "title": "Envelope", "payload": {
                    "statement": "s", "acceptanceCriterion": "a", "priority": "must",
                    "features": [{"label": "   ", "expect": {"size": [20, 10, 2]}}]}}),
            )
            .unwrap_err();
        assert_eq!(error.issues()[0].path, "payload.features[0].label");
    }

    /// A statement requirement leaves no item in the committed expect, so a
    /// check that named it only in requirementIds used to bind nothing for
    /// it: the next check could leave it out and pass.
    #[test]
    fn a_requirement_a_committed_check_named_stays_in_the_checks_that_follow() {
        if !engine_available() {
            return;
        }
        let mut project = TestProject::new();
        let plate = plate_part(&mut project);
        let (fits, _) = project.approved(
            "requirement",
            "Fits the bay",
            json!({"statement": "Fits the 20 mm bay", "acceptanceCriterion": "Shown by test",
                "priority": "must", "target": {"value": 20, "unit": "mm"}}),
            json!([]),
        );
        let expect =
            json!({"bodies": 1, "spec": [{"item": "plate 20 x 10 x 2", "size": [20, 10, 2]}]});
        let first = project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": plate, "autoCommit": true, "requirementIds": [fits], "expect": expect}),
        );
        assert_eq!(
            (&first["verificationStatus"], &first["committed"]),
            (&json!("partial"), &json!(true)),
            "{first}"
        );
        assert!(first.get("notes").is_none(), "{first}");
        // The next check leaves it out: it stays partial and says why.
        let second = project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": plate, "autoCommit": true, "expect": expect}),
        );
        assert_eq!(
            (
                &second["verificationStatus"],
                &second["committed"],
                &second["ready"]
            ),
            (&json!("partial"), &json!(true), &json!(false)),
            "{second}"
        );
        assert_eq!(second["spec"]["counts"]["blocking"], 1);
        assert_eq!(
            second["spec"]["items"][1],
            json!({"item": "Fits the bay", "requirementId": fits, "from": "requirement",
                "statement": true, "state": "unasserted", "checks": []})
        );
        assert_eq!(second["spec"]["requirements"][0]["via"], json!(["check"]));
        assert_eq!(second["spec"]["requirements"][0]["linkedBy"], "agent");
        assert_eq!(
            second["notes"],
            json!(["requirement \"Fits the bay\" stays in this check: a committed check of this part named it in requirementIds"])
        );
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(about(&status, &plate), [("cad_spec_unasserted", "blocker")]);
        assert_eq!(status["counts"]["verifiedParts"], 0);
        let found = item(&status, "cad_spec_unasserted");
        assert_eq!(
            found["next"]["args"]["expect"]["spec"][1],
            json!({"item": "Fits the bay", "requirementId": fits})
        );
        // A new revision inherits it too.
        project.agent(
            "s1",
            "cad.write_source",
            json!({"artifactId": plate, "source": "cube([20, 10, 2]);", "timeoutMs": 60_000}),
        );
        let inherited = project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": plate, "autoCommit": true, "expect": expect}),
        );
        assert_eq!(inherited["verificationStatus"], "partial", "{inherited}");
        assert_eq!(inherited["spec"]["counts"]["blocking"], 1);
        // Shown by an item that names it with a dimension, the part passes.
        let shown = project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": plate, "autoCommit": true, "expect": {"bodies": 1, "spec": [
                {"item": "plate 20 x 10 x 2", "size": [20, 10, 2]},
                {"item": "Fits the bay", "requirementId": fits, "size": [20, 10, 2]}]}}),
        );
        assert_eq!(shown["verificationStatus"], "passed", "{shown}");
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(about(&status, &plate), [("draft_unproposed", "advice")]);
    }

    /// The link of a requirement a committed check named is the person's
    /// when a person ran that check, in every check that keeps it.
    #[test]
    fn a_requirement_a_person_named_stays_linked_by_the_person() {
        if !engine_available() {
            return;
        }
        let mut project = TestProject::new();
        let plate = plate_part(&mut project);
        let (fits, _) = project.approved("requirement", "Fits the bay", bay(20.0), json!([]));
        let expect =
            json!({"bodies": 1, "spec": [{"item": "plate 20 x 10 x 2", "size": [20, 10, 2]}]});
        let first = project.user(
            "cad.check",
            json!({"artifactId": plate, "requirementIds": [fits], "expect": expect}),
        );
        assert_eq!(first["verificationStatus"], "partial", "{first}");
        assert_eq!(first["spec"]["requirements"][0]["linkedBy"], "person");
        let second = project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": plate, "autoCommit": true, "expect": expect}),
        );
        assert_eq!(second["verificationStatus"], "partial", "{second}");
        assert_eq!(
            (
                &second["spec"]["requirements"][0]["via"],
                &second["spec"]["requirements"][0]["linkedBy"]
            ),
            (&json!(["check"]), &json!("person")),
            "{second}"
        );
    }

    /// A requirement a committed check named is in every later check, so
    /// one linked since that states its assertion differently leaves no
    /// check to run, as two linked ones do: the gate says so and sends the
    /// agent nowhere.
    #[test]
    fn a_requirement_a_committed_check_named_that_a_linked_one_contradicts_waits_on_a_person() {
        if !engine_available() {
            return;
        }
        let mut project = TestProject::new();
        let plate = plate_part(&mut project);
        let (thin, _) = project.approved(
            "requirement",
            "Thin plate",
            envelope(json!({"size": [20, 10, 2]})),
            json!([]),
        );
        let first = project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": plate, "autoCommit": true, "requirementIds": [thin], "expect": {"bodies": 1}}),
        );
        assert_eq!(first["verificationStatus"], "passed", "{first}");
        let (thick, _) = project.approved(
            "requirement",
            "Thick plate",
            envelope(json!({"size": [20, 10, 3]})),
            json!([]),
        );
        link(&mut project, &thick, &plate);
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(about(&status, &plate), [("cad_unverified", "blocker")]);
        let blocked = item(&status, "cad_unverified");
        assert!(blocked["next"].is_null(), "{blocked}");
        assert_eq!(
            blocked["detail"],
            "No check of r1 can run: requirements \"Thick plate\" and \"Thin plate\" state different size for this part. A person must reconcile them."
        );
        let latest = {
            let handle = project.handle();
            let revision = get_revision(handle, first["revisionId"].as_str().unwrap())
                .unwrap()
                .unwrap();
            cad::readiness(handle, &revision).unwrap()
        };
        assert_eq!(
            latest["spec"]["conflict"],
            "requirements \"Thick plate\" and \"Thin plate\" state different size for this part"
        );
        let refused = project
            .call(
                agent("s1"),
                "cad.check",
                json!({"artifactId": plate, "autoCommit": true, "expect": {"bodies": 1}}),
            )
            .unwrap_err();
        assert!(
            refused
                .message
                .contains("requirements \"Thick plate\" and \"Thin plate\""),
            "{}",
            refused.message
        );
        assert!(refused
            .repair
            .unwrap()
            .starts_with("A person must reconcile the requirements"));
    }

    fn evidence(project: &TestProject, checked: &Value) -> Value {
        let hash = checked["evidenceHash"].as_str().unwrap();
        serde_json::from_slice(&project.handle().object_store().unwrap().read(hash).unwrap())
            .unwrap()
    }

    /// The outstanding item about one artifact.
    fn of(status: &Value, artifact_id: &str) -> Value {
        status["outstanding"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["artifactId"] == artifact_id)
            .cloned()
            .unwrap_or_else(|| panic!("nothing about {artifact_id} in {status}"))
    }

    fn link(project: &mut TestProject, requirement: &str, part: &str) {
        project.user(
            "graph.propose_edges",
            json!({"edges": [{"upstreamArtifactId": requirement, "downstreamArtifactId": part, "relationship": "validates"}]}),
        );
    }

    fn envelope(expect: Value) -> Value {
        json!({"statement": "The plate fills the bay", "acceptanceCriterion": "Shown by test",
            "priority": "must", "features": [{"label": "Plate envelope", "expect": expect}]})
    }

    #[test]
    fn a_changed_requirement_the_part_fails_waits_on_a_person_once_the_part_meets_it() {
        if !engine_available() {
            return;
        }
        let mut project = TestProject::new();
        let plate = plate_part(&mut project);
        let (requirement, at) = project.approved(
            "requirement",
            "Envelope",
            envelope(json!({"size": [20, 10, 2]})),
            json!([]),
        );
        link(&mut project, &requirement, &plate);
        let first = project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": plate, "autoCommit": true, "expect": {"bodies": 1}}),
        );
        assert_eq!(first["verificationStatus"], "passed", "{first}");
        // A person makes the plate thicker; the part does not meet it yet.
        let revised = project.redraft(
            Origin::User,
            &requirement,
            json!({"baseRevisionId": at, "payload": envelope(json!({"size": [20, 10, 3]}))}),
        );
        project.accept(&requirement, &revised);
        let status = project.agent("s1", "work.status", json!({}));
        let next = item(&status, "cad_spec_unasserted")["next"]["args"].clone();
        let failed = project.agent("s1", "cad.check", next);
        assert_eq!(
            (&failed["verificationStatus"], &failed["committed"]),
            (&json!("failed"), &json!(true)),
            "{failed}"
        );
        let status = project.agent("s1", "work.status", json!({}));
        let again = item(&status, "cad_check_failed")["next"]["args"].clone();
        assert_eq!(again["expect"]["spec"][0]["size"], json!([20, 10, 3]));
        // The geometry is fixed and checked again as the gate says: what
        // is left is the person's acceptance of the requirement's value.
        project.agent(
            "s1",
            "cad.write_source",
            json!({"artifactId": plate, "source": "cube([20, 10, 3]);", "timeoutMs": 60_000}),
        );
        let status = project.agent("s1", "work.status", json!({}));
        let fixed = project.agent(
            "s1",
            "cad.check",
            of(&status, &plate)["next"]["args"].clone(),
        );
        assert_eq!(fixed["verificationStatus"], "scope_changed", "{fixed}");
        assert_eq!(
            fixed["spec"]["replaced"],
            json!(["\"Plate envelope\" from requirement \"Envelope\""])
        );
        assert_eq!(fixed["spec"]["checkChanges"], json!([]));
        // Nothing for the agent to repeat.
        assert!(fixed.get("committedExpect").is_none(), "{fixed}");
        assert_eq!(fixed["nextStep"]["tool"], "work_status");
        let status = project.agent("s1", "work.status", json!({}));
        let waiting = item(&status, "cad_scope_changed");
        assert!(waiting["next"].is_null(), "{waiting}");
        assert!(waiting["detail"]
            .as_str()
            .unwrap()
            .ends_with("A person must accept the new scope."));
    }

    #[test]
    fn a_requirement_that_states_a_committed_value_differently_is_taken_and_reviewed() {
        if !engine_available() {
            return;
        }
        let mut project = TestProject::new();
        let plate = plate_part(&mut project);
        let listed =
            json!({"bodies": 1, "spec": [{"item": "plate 20 x 10 x 2", "size": [20, 10, 2]}]});
        let passed = project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": plate, "autoCommit": true, "expect": listed}),
        );
        assert_eq!(passed["verificationStatus"], "passed", "{passed}");
        std::thread::sleep(std::time::Duration::from_millis(10));
        // Within tolerance of the part, but not the value committed.
        let (close, _) = project.approved(
            "requirement",
            "Close fit",
            envelope(json!({"size": [20, 10, 2.05]})),
            json!([]),
        );
        link(&mut project, &close, &plate);
        // Sent as it was committed, the check names both places.
        let refused = project
            .call(
                agent("s1"),
                "cad.check",
                json!({"artifactId": plate, "autoCommit": true, "expect": listed}),
            )
            .unwrap_err();
        assert_eq!(refused.issues()[0].path, "expect.spec[0].size");
        assert_eq!(
            refused.issues()[0].message,
            "disagrees with the size requirement \"Close fit\" states for \"Plate envelope\""
        );
        // The gate's next restates the scope with the requirement's value,
        // committed for a person to accept rather than by autoCommit.
        let status = project.agent("s1", "work.status", json!({}));
        let found = item(&status, "cad_spec_unasserted");
        assert!(found["next"]["args"]["autoCommit"].is_null(), "{found}");
        assert!(found["detail"]
            .as_str()
            .unwrap()
            .contains("Its linked requirements now state committed values differently"));
        assert_eq!(
            found["next"]["args"]["expect"]["spec"],
            json!([{"item": "Plate envelope", "requirementId": close, "size": [20, 10, 2.05]}])
        );
        let restated = project.agent("s1", "cad.check", found["next"]["args"].clone());
        assert_eq!(
            restated["verificationStatus"], "scope_changed",
            "{restated}"
        );
        assert_eq!(
            restated["spec"]["replaced"],
            json!(["size of \"plate 20 x 10 x 2\" (requirement \"Close fit\" states it)"])
        );
        let status = project.agent("s1", "work.status", json!({}));
        assert!(item(&status, "cad_scope_changed")["next"].is_null());

        // Two requirements that disagree leave no check to run.
        let (snug, _) = project.approved(
            "requirement",
            "Snug fit",
            envelope(json!({"size": [20, 10, 1.95]})),
            json!([]),
        );
        link(&mut project, &snug, &plate);
        let status = project.agent("s1", "work.status", json!({}));
        assert_eq!(about(&status, &plate), [("cad_unverified", "blocker")]);
        let blocked = item(&status, "cad_unverified");
        assert!(blocked["next"].is_null(), "{blocked}");
        assert_eq!(
            blocked["detail"],
            "No check of r1 can run: requirements \"Close fit\" and \"Snug fit\" state different size for this part. A person must reconcile them."
        );
        let refused = project
            .call(
                agent("s1"),
                "cad.check",
                json!({"artifactId": plate, "exploratory": true}),
            )
            .unwrap_err();
        assert!(
            refused
                .message
                .contains("requirements \"Close fit\" and \"Snug fit\""),
            "{}",
            refused.message
        );
        assert!(refused
            .repair
            .unwrap()
            .starts_with("A person must reconcile the requirements"));
    }

    #[test]
    fn a_changed_statement_target_is_restated_not_doubled() {
        if !engine_available() {
            return;
        }
        let mut project = TestProject::new();
        let plate = plate_part(&mut project);
        let width = |mm: f64| {
            json!({"statement": "Fits the bay", "acceptanceCriterion": "Shown by test",
                "priority": "must", "target": {"value": mm, "unit": "mm"}})
        };
        let (bay, at) = project.approved("requirement", "Bay width", width(20.0), json!([]));
        link(&mut project, &bay, &plate);
        let item_20 = json!({"item": "fits 20 mm", "requirementId": bay, "size": [20, 10, 2]});
        let passed = project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": plate, "autoCommit": true, "expect": {"bodies": 1, "spec": [item_20]}}),
        );
        assert_eq!(passed["verificationStatus"], "passed", "{passed}");
        let revised = project.redraft(
            Origin::User,
            &bay,
            json!({"baseRevisionId": at, "payload": width(25.0)}),
        );
        project.accept(&bay, &revised);
        let status = project.agent("s1", "work.status", json!({}));
        let found = item(&status, "cad_spec_unasserted");
        assert_eq!(
            found["detail"],
            "Requirement \"Bay width\" changed after the committed check of r1 (it now states 25 mm), so the check does not show it as it stands."
        );
        // The item that shows it is named to restate; nothing is added
        // beside it.
        assert_eq!(found["next"]["args"]["expect"]["spec"], json!([item_20]));
        assert!(found["next"]["args"]["autoCommit"].is_null());
        assert!(
            found["next"]["why"]
                .as_str()
                .unwrap()
                .starts_with("Restate \"fits 20 mm\" against the requirement"),
            "{found}"
        );
        // The part is made to the new width and the item restated with it:
        // the person accepts the changed value.
        project.agent(
            "s1",
            "cad.write_source",
            json!({"artifactId": plate, "source": "cube([25, 10, 2]);", "timeoutMs": 60_000}),
        );
        let restated = project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": plate, "expect": {"bodies": 1, "spec": [
                {"item": "fits 25 mm", "requirementId": bay, "size": [25, 10, 2]}]}}),
        );
        assert_eq!(
            restated["verificationStatus"], "scope_changed",
            "{restated}"
        );
        assert_eq!(
            restated["spec"]["replaced"],
            json!(["\"fits 20 mm\" (requirement \"Bay width\" changed)"])
        );
        assert_eq!(restated["spec"]["checkChanges"], json!([]));
        let status = project.agent("s1", "work.status", json!({}));
        assert!(item(&status, "cad_scope_changed")["next"].is_null());
    }

    #[test]
    fn what_a_check_drops_itself_is_named_beside_a_changed_requirement() {
        if !engine_available() {
            return;
        }
        let mut project = TestProject::new();
        let plate = plate_part(&mut project);
        let (requirement, at) = project.approved(
            "requirement",
            "Envelope",
            envelope(json!({"size": [20, 10, 2]})),
            json!([]),
        );
        link(&mut project, &requirement, &plate);
        let first = project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": plate, "autoCommit": true, "expect": {"bodies": 1, "spec": [
                {"item": "centre is solid", "solid": [[10, 5, 1]]}]}}),
        );
        assert_eq!(first["verificationStatus"], "passed", "{first}");
        let corners = json!({"min": [0, 0, 0], "max": [20, 10, 2]});
        let revised = project.redraft(
            Origin::User,
            &requirement,
            json!({"baseRevisionId": at, "payload": envelope(json!({"bbox": corners}))}),
        );
        project.accept(&requirement, &revised);
        // The check leaves out its own item as the requirement changes.
        let dropped = project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": plate, "expect": {"bodies": 1}}),
        );
        assert_eq!(dropped["verificationStatus"], "scope_changed", "{dropped}");
        assert_eq!(
            dropped["spec"]["checkChanges"],
            json!(["solid", "spec item \"centre is solid\""])
        );
        let restore = json!({"shells": 1, "spec": [
            {"item": "centre is solid", "solid": [[10, 5, 1]]},
            {"item": "Plate envelope", "requirementId": requirement, "bbox": corners}]});
        assert_eq!(dropped["committedExpect"], restore);
        let status = project.agent("s1", "work.status", json!({}));
        let found = item(&status, "cad_scope_changed");
        assert_eq!(
            found["detail"],
            "The committed check of r1 drops or loosens assertions committed before: solid, spec item \"centre is solid\". Linked requirements now state others differently (\"Plate envelope\" from requirement \"Envelope\"); a person accepts those."
        );
        assert_eq!(
            found["next"]["args"],
            json!({"artifactId": plate, "expect": restore})
        );
        // Restoring its own item leaves only what the person accepts.
        let restored = project.agent("s1", "cad.check", found["next"]["args"].clone());
        assert_eq!(
            restored["verificationStatus"], "scope_changed",
            "{restored}"
        );
        assert_eq!(restored["spec"]["checkChanges"], json!([]));
        let status = project.agent("s1", "work.status", json!({}));
        assert!(item(&status, "cad_scope_changed")["next"].is_null());
    }

    #[test]
    fn assertions_listed_for_a_shared_requirement_are_not_the_requirement_s() {
        if !engine_available() {
            return;
        }
        let mut project = TestProject::new();
        let first = plate_part(&mut project);
        let second = plate_part(&mut project);
        let (requirement, _) = project.approved(
            "requirement",
            "Envelope",
            envelope(json!({"size": [20, 10, 2]})),
            json!([]),
        );
        link(&mut project, &requirement, &first);
        link(&mut project, &requirement, &second);
        // Linked to two parts, its assertion is not taken; the agent's own
        // stands for the feature, and says so.
        let checked = project.agent(
            "s1",
            "cad.check",
            json!({"artifactId": first, "autoCommit": true, "expect": {"bodies": 1, "spec": [
                {"item": "Plate envelope", "requirementId": requirement, "solid": [[10, 5, 1]]}]}}),
        );
        assert_eq!(checked["verificationStatus"], "passed", "{checked}");
        let row = &checked["spec"]["items"][0];
        assert_eq!(
            (&row["from"], &row["assertedBy"]),
            (&json!("requirement"), &json!("listed"))
        );
        assert_eq!(
            evidence(&project, &checked)["coverage"]["requirementAuthority"],
            "agent_or_user_declared"
        );
    }
}
