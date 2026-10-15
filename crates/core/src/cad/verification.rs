//! Request-bound CAD evidence and the one definition of "verified".
//!
//! A check produces immutable evidence for one exact revision. Whether that
//! evidence makes the revision ready is decided here and nowhere else:
//! `cad.check` results, the recorded work state and every summary read the
//! same functions. The checker version is distinct from the TypeScript
//! implementation: old evidence stays readable, but a new checker cannot
//! silently claim equivalence to it.
use super::*;
use std::collections::{BTreeSet, HashSet};

pub(crate) const CHECKER: &str = "omenflow-rust-mesh-checks-v2";
const EARLIER_CHECKERS: [&str; 2] = ["omenflow-rust-mesh-checks-v1", "omenflow-mesh-checks-v4"];
const ACTIVE_WORK: &str = "work.active";

/// One finished `cad_check` job of an artifact, newest first in a history.
pub(crate) struct Record {
    pub inputs: Value,
    pub outputs: Value,
    pub log: String,
    /// When the check was committed. Checks compute with the core lock
    /// released, so the order they were planned in is not the order their
    /// results became part of the record.
    pub finished_at: String,
}

/// What a check measured, before it is judged against the project's history.
pub(crate) struct Measured {
    pub lines: Vec<Value>,
    pub integrity: bool,
    /// The mesh that was measured is the revision's own stored render.
    pub matching: bool,
}

/// How the request asked for the result to be recorded.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Mode {
    /// Bind the expectation whatever the outcome.
    Commit,
    /// Diagnostic only; never binds.
    Trial,
    /// Bind only when the result is `passed`; otherwise record a trial.
    AutoCommit,
}

pub(crate) struct Judgement {
    pub status: &'static str,
    pub exploratory: bool,
    pub pass: bool,
    pub passed: usize,
    pub scope_changes: Vec<String>,
    pub prior_hashes: Vec<String>,
    pub dropped: Vec<String>,
    pub loosened: Vec<String>,
    /// What a check has to repeat to keep every scope committed before this
    /// one (`committed_expect`), or null.
    pub committed: Value,
}

fn meta(handle: &ProjectHandle, key: &str) -> CoreResult<Value> {
    Ok(handle
        .db
        .query_row("SELECT value FROM meta WHERE key=?1", [key], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(internal)?
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(Value::Null))
}

fn set_meta(handle: &ProjectHandle, key: &str, value: &Value) -> CoreResult<()> {
    handle
        .db
        .execute(
            "INSERT INTO meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value.to_string()],
        )
        .map_err(internal)?;
    Ok(())
}

/// The assertion scope a human accepted for this artifact, or null.
pub(crate) fn accepted_scope(handle: &ProjectHandle, artifact_id: &str) -> CoreResult<Value> {
    meta(handle, &format!("cad.scope.accepted.{artifact_id}"))
}

/// Every finished check of one artifact, the most recently committed first.
/// Scope must not disappear when unrelated job history grows, so there is no
/// limit; the index keeps the lookup proportional to this artifact's own
/// checks.
pub(crate) fn history(handle: &ProjectHandle, artifact_id: &str) -> CoreResult<Vec<Record>> {
    // Additive and lazily created; a read-only snapshot simply goes without it.
    let _ = handle.db.execute(
        "CREATE INDEX IF NOT EXISTS idx_job_cad_check_artifact ON job(json_extract(inputs,'$.artifactId')) WHERE kind='cad_check'",
        [],
    );
    // `commitOrder` is numbered under the core lock as a check commits;
    // checks recorded before it existed follow, by when they finished.
    let mut statement = handle
        .db
        .prepare("SELECT inputs,output_hashes,log,COALESCE(finished_at,created_at) AS committed FROM job WHERE kind='cad_check' AND json_extract(inputs,'$.artifactId')=?1 AND status IN ('succeeded','failed') ORDER BY json_extract(inputs,'$.commitOrder') IS NULL, json_extract(inputs,'$.commitOrder') DESC, committed DESC, rowid DESC")
        .map_err(internal)?;
    let rows = statement
        .query_map([artifact_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(internal)?;
    rows.map(|row| {
        let (inputs, outputs, log, finished_at) = row.map_err(internal)?;
        Ok(Record {
            inputs: serde_json::from_str(&inputs).unwrap_or(Value::Null),
            outputs: serde_json::from_str(&outputs).unwrap_or(Value::Null),
            log,
            finished_at,
        })
    })
    .collect()
}

/// The place of a check about to commit in its artifact's history. Taken
/// under the core lock at commit, so two checks that computed at the same
/// time are ordered by when their results were recorded, not when they were
/// asked for or by a clock that cannot tell them apart.
pub(crate) fn next_commit_order(handle: &ProjectHandle, artifact_id: &str) -> CoreResult<i64> {
    handle
        .db
        .query_row(
            "SELECT COALESCE(MAX(json_extract(inputs,'$.commitOrder')),0)+1 FROM job WHERE kind='cad_check' AND json_extract(inputs,'$.artifactId')=?1",
            [artifact_id],
            |row| row.get(0),
        )
        .map_err(internal)
}

fn status_of(
    pass: bool,
    integrity: bool,
    matching: bool,
    scope_changed: bool,
    explicit: bool,
) -> &'static str {
    if !pass || !integrity {
        "failed"
    } else if !matching {
        "unverified"
    } else if scope_changed {
        "scope_changed"
    } else if !explicit {
        "partial"
    } else {
        "passed"
    }
}

/// The checks whose assertions bind `revision`, the most recently committed
/// first: committed checks with evidence of this revision, or of an ancestor
/// committed before this revision existed, back to the evidence a human
/// accepted. A diagnostic run against an older revision afterwards is not a
/// new requirement for the candidate. A check that ended before it measured
/// anything (a work limit, a render error, a timeout) recorded no evidence and
/// binds nothing.
fn binding<'a>(
    history: &'a [Record],
    revision: &Value,
    ancestors: &HashSet<String>,
    accepted: &Value,
) -> Vec<&'a Record> {
    let mut bound = Vec::new();
    for record in history {
        if accepted["evidenceHash"].is_string()
            && record.outputs["verification"] == accepted["evidenceHash"]
        {
            break;
        }
        if record.inputs["exploratory"] == true || !record.outputs["verification"].is_string() {
            continue;
        }
        let same_revision = record.inputs["revisionId"] == revision["id"];
        let inherited = record.inputs["revisionId"]
            .as_str()
            .is_some_and(|id| ancestors.contains(id))
            && revision["createdAt"]
                .as_str()
                .is_some_and(|created| record.finished_at.as_str() <= created);
        if same_revision || inherited {
            bound.push(record);
        }
    }
    bound
}

/// The one expectation that satisfies every bound scope: the accepted scope
/// or a bound check whose assertions cover all the others. When none covers
/// them all, a human has to accept a scope; the accepted one, else the most
/// recently committed, is named. Null when nothing binds.
fn covering_expect(accepted: &Value, bound: &[&Record]) -> Value {
    let accepted = accepted.get("expect").filter(|value| value.is_object());
    let candidates = bound
        .iter()
        .filter_map(|record| {
            record
                .inputs
                .get("expect")
                .filter(|value| value.is_object())
        })
        .chain(accepted)
        .collect::<Vec<_>>();
    let covering = candidates.iter().copied().find(|candidate| {
        candidates
            .iter()
            .all(|other| expect::scope_changes(other, candidate).is_empty())
    });
    covering
        .or(accepted)
        .or(candidates.first().copied())
        .cloned()
        .unwrap_or(Value::Null)
}

/// The normalised expectation a check of `revision` has to repeat to keep
/// every committed and accepted scope, or null when nothing binds it yet.
pub(crate) fn committed_expect(handle: &ProjectHandle, revision: &Value) -> CoreResult<Value> {
    let artifact_id = required_str(revision, "artifactId")?;
    let history = history(handle, artifact_id)?;
    let accepted = accepted_scope(handle, artifact_id)?;
    let bound = binding(&history, revision, &ancestors(handle, revision)?, &accepted);
    Ok(covering_expect(&accepted, &bound))
}

/// Judge a measurement against what this artifact has already committed to:
/// the accepted scope and every check that binds this revision.
#[allow(clippy::too_many_arguments)]
pub(crate) fn judge(
    measured: &Measured,
    expect: &Value,
    params: &Value,
    mode: Mode,
    variant: bool,
    revision: &Value,
    ancestors: &HashSet<String>,
    accepted: &Value,
    history: &[Record],
) -> Judgement {
    let passed = measured
        .lines
        .iter()
        .filter(|line| line["pass"] == true)
        .count();
    let pass = !measured.lines.is_empty() && passed == measured.lines.len();
    let mut changes = BTreeSet::<String>::new();
    let mut prior_hashes = Vec::<String>::new();
    if accepted["expect"].is_object() {
        prior_hashes.extend(accepted["specHash"].as_str().map(str::to_owned));
        changes.extend(expect::scope_changes(&accepted["expect"], expect));
    }
    let mut prior_failures = BTreeSet::<String>::new();
    let mut last_results: Option<&Value> = None;
    let bound = binding(history, revision, ancestors, accepted);
    for record in &bound {
        if let Some(previous) = record
            .inputs
            .get("expect")
            .filter(|value| value.is_object())
        {
            let hash = expect::spec_hash(previous);
            if !prior_hashes.contains(&hash) {
                prior_hashes.push(hash);
                changes.extend(expect::scope_changes(previous, expect));
            }
        }
        // Weakening guard: an assertion that failed on this same geometry and
        // is now simply absent, or passes only with a looser tolerance.
        if record.inputs["revisionId"] == revision["id"]
            && canonical_params(&record.inputs["params"]) == canonical_params(params)
        {
            prior_failures.extend(record.log.lines().filter_map(|line| {
                line.strip_prefix("FAIL ")
                    .and_then(|rest| rest.split_once(" — "))
                    .map(|(name, _)| name.to_owned())
            }));
            if last_results.is_none() && record.inputs["results"].is_array() {
                last_results = Some(&record.inputs["results"]);
            }
        }
    }
    let names = measured
        .lines
        .iter()
        .filter_map(|line| line["name"].as_str())
        .collect::<HashSet<_>>();
    let dropped = prior_failures
        .into_iter()
        .filter(|name| !names.contains(name.as_str()))
        .collect::<Vec<_>>();
    if !dropped.is_empty() {
        changes.insert("dropped previously failing assertions".into());
    }
    let loosened = last_results
        .and_then(Value::as_array)
        .map(|prior| checks::loosened(prior, &measured.lines))
        .unwrap_or_default();
    let status = status_of(
        pass,
        measured.integrity,
        measured.matching && !variant,
        !changes.is_empty(),
        expect::explicit(expect),
    );
    let exploratory = variant
        || match mode {
            Mode::Commit => false,
            Mode::Trial => true,
            Mode::AutoCommit => status != "passed",
        };
    Judgement {
        status,
        exploratory,
        pass,
        passed,
        scope_changes: changes.into_iter().collect(),
        prior_hashes,
        dropped,
        loosened,
        committed: covering_expect(accepted, &bound),
    }
}

fn canonical_params(params: &Value) -> Value {
    params::effective_params(params)
        .map(Value::Object)
        .unwrap_or_else(|_| json!({}))
}

/// The status a reader should act on: what the evidence recorded, adjusted
/// for what has happened since (inputs moved on, a human accepted this scope).
fn resolved_status(evidence: &Value, accepted: &Value, stale: bool) -> String {
    let recorded = evidence["status"].as_str().unwrap_or("unverified");
    let differs = accepted["expect"].is_object()
        && !expect::scope_changes(&accepted["expect"], &evidence["expect"]).is_empty();
    if recorded == "failed" {
        "failed"
    } else if stale {
        "unverified"
    } else if differs {
        "scope_changed"
    } else if recorded == "scope_changed"
        && evidence["pass"] == true
        && evidence["integrity"]["pass"] == true
        && expect::explicit(&evidence["expect"])
        && accepted["specHash"] == evidence["specHash"]
    {
        "passed"
    } else {
        recorded
    }
    .to_owned()
}

/// The single next action for a status, in the vocabulary the work record
/// has always used. A trial that did not pass is never told to commit.
pub(crate) fn next_action(status: &str, exploratory: bool, stale: bool) -> &'static str {
    match status {
        "failed" => "repair_geometry",
        "scope_changed" => "restore_assertions",
        "unverified" if stale => "resolve_inputs",
        "unverified" => "commit_matching_render",
        "partial" => "commit_assertions",
        "passed" if exploratory => "commit_assertions",
        "passed" => "request_review",
        _ => "none",
    }
}

/// Inputs of a revision that are no longer what the project stands on:
/// an upstream artifact that was archived, or whose approved revision is not
/// the one this revision was built from.
pub(crate) fn stale_inputs(handle: &ProjectHandle, revision: &Value) -> CoreResult<Vec<Value>> {
    let artifact_id = required_str(revision, "artifactId")?;
    let mut out = Vec::new();
    let mut statement = handle
        .db
        .prepare("SELECT upstream_artifact_id,reason FROM stale WHERE artifact_id=?1")
        .map_err(internal)?;
    let marked = statement
        .query_map([artifact_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(internal)?;
    for row in marked {
        let (upstream, reason) = row.map_err(internal)?;
        out.push(json!({"artifactId": upstream, "reason": reason}));
    }
    for input in revision["inputs"].as_array().into_iter().flatten() {
        let Some(id) = input["artifactId"].as_str() else {
            continue;
        };
        if out.iter().any(|item| item["artifactId"] == id) {
            continue;
        }
        let reason = match require_artifact(handle, id) {
            Err(_) => "the input artifact no longer exists",
            Ok(upstream) if upstream["archived"] == true => "the input artifact is archived",
            Ok(upstream) if upstream["selectedRevisionId"] != input["revisionId"] => {
                "the input revision is not the approved baseline of its artifact"
            }
            Ok(_) => continue,
        };
        out.push(json!({"artifactId": id, "revisionId": input["revisionId"], "reason": reason}));
    }
    Ok(out)
}

fn failed_lines(evidence: &Value) -> Vec<Value> {
    evidence["checks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|line| line["pass"] != true)
        .map(|line| json!({"name": line["name"], "detail": line["detail"]}))
        .collect()
}

/// Whether the revision carries a render of its own source: `ok`, `failed`
/// (the engine ran and reported errors), `missing` or `no_source`.
fn render_state(handle: &ProjectHandle, revision: &Value) -> (&'static str, Option<String>) {
    if render_matches(revision) {
        return ("ok", None);
    }
    if scad_ref(revision).is_none() {
        return ("no_source", None);
    }
    let failure = revision["payload"]["renderJobId"]
        .as_str()
        .and_then(|id| jobs::read(handle, id).ok())
        .filter(|job| job["status"] == "failed")
        .map(|job| {
            job["error"]["message"]
                .as_str()
                .unwrap_or("render failed")
                .to_owned()
        });
    match failure {
        Some(message) => ("failed", Some(message)),
        None => ("missing", None),
    }
}

/// Verification state of one revision, with its evidence when there is any.
///
/// `status` is `passed`, `partial`, `failed`, `scope_changed` or
/// `unverified`; `ready` is true only for `passed`. Exploratory checks and
/// checks of other revisions never count.
pub(crate) fn latest_verification(handle: &ProjectHandle, revision: &Value) -> CoreResult<Value> {
    let unverified = |next: &str, render: &str| json!({"status": "unverified", "ready": false, "nextAction": next, "render": render});
    if !render_matches(revision) {
        let (render, error) = render_state(handle, revision);
        let mut result = unverified("commit_matching_render", render);
        if let Some(error) = error {
            result["renderError"] = json!(error);
        }
        return Ok(result);
    }
    let artifact_id = required_str(revision, "artifactId")?;
    let identity = &revision["payload"]["renderIdentity"];
    let objects = handle.object_store().map_err(storage_error)?;
    for record in history(handle, artifact_id)? {
        let Some(hash) = record.outputs["verification"].as_str() else {
            continue;
        };
        if record.inputs["revisionId"] != revision["id"] {
            continue;
        }
        let Some(evidence) = objects
            .read(hash)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        else {
            continue;
        };
        let checker = evidence["checkerVersion"].as_str().unwrap_or("");
        if evidence["version"] != 1
            || evidence["exploratory"] == true
            || evidence["revisionId"] != revision["id"]
            || evidence["inputFingerprint"] != identity["inputFingerprint"]
            || evidence["outputHash"] != identity["outputHash"]
            || !(checker == CHECKER || EARLIER_CHECKERS.contains(&checker))
        {
            continue;
        }
        let stale = stale_inputs(handle, revision)?;
        let accepted = accepted_scope(handle, artifact_id)?;
        let status = resolved_status(&evidence, &accepted, !stale.is_empty());
        let mut result = json!({"status": status, "ready": status == "passed",
            "nextAction": next_action(&status, false, !stale.is_empty()),
            "render": "ok", "evidenceHash": hash, "evidence": evidence});
        if !stale.is_empty() {
            result["staleInputs"] = json!(stale);
        }
        return Ok(result);
    }
    Ok(unverified("commit_assertions", "ok"))
}

/// Readiness of one revision in a form small enough for a summary: the
/// status, whether it is ready, what to do next and what failed.
///
/// This is the function other modules call. It never runs the engine and
/// writes nothing; it reports the newest committed check of exactly this
/// revision, or `unverified` with the reason when there is none.
pub fn readiness(handle: &ProjectHandle, revision: &Value) -> CoreResult<Value> {
    let latest = latest_verification(handle, revision)?;
    let evidence = &latest["evidence"];
    let status = latest["status"].as_str().unwrap_or("unverified");
    let total = evidence["checks"].as_array().map(Vec::len);
    let failed = failed_lines(evidence);
    let summary = match (status, latest["render"].as_str()) {
        (_, Some("no_source")) => "No OpenSCAD source on this revision.".to_owned(),
        (_, Some("failed")) => format!(
            "The render failed: {}",
            latest["renderError"].as_str().unwrap_or("see the render job")
        ),
        (_, Some("missing")) => {
            "The source has no render that matches it; save it again to render it.".to_owned()
        }
        ("passed", _) => format!(
            "Verified: {} declared assertions pass for this revision.",
            total.unwrap_or(0)
        ),
        ("failed", _) => format!(
            "{} of {} assertions fail.",
            failed.len(),
            total.unwrap_or(0)
        ),
        ("scope_changed", _) => {
            "Checks pass, but committed assertions were removed or changed; a human must accept the new scope.".to_owned()
        }
        ("partial", _) => "Only generic mesh checks ran; nothing from the request was asserted.".to_owned(),
        _ if latest["staleInputs"].is_array() => {
            "Checks pass, but an input of this part is no longer the approved baseline.".to_owned()
        }
        _ => "No committed check for this revision.".to_owned(),
    };
    let mut result = json!({
        "artifactId": revision["artifactId"], "revisionId": revision["id"],
        "status": status, "ready": latest["ready"], "nextAction": latest["nextAction"],
        "render": latest["render"], "summary": summary,
        "failed": failed, "scopeChanges": evidence["scopeChanges"].as_array().cloned().unwrap_or_default(),
    });
    if let Some(total) = total {
        result["total"] = json!(total);
        result["passed"] = json!(total - result["failed"].as_array().map(Vec::len).unwrap_or(0));
    }
    for key in ["evidenceHash", "staleInputs", "renderError"] {
        if !latest[key].is_null() {
            result[key] = latest[key].clone();
        }
    }
    Ok(result)
}

pub(crate) fn validate_scope_accept(
    handle: &ProjectHandle,
    revision: &Value,
    evidence_hash: &str,
) -> CoreResult<Value> {
    let current = latest_verification(handle, revision)?;
    if current["evidenceHash"] != evidence_hash || !current["evidence"].is_object() {
        return Err(ContractError::new(
            "REVISION_CONFLICT",
            "Verification evidence changed or does not match this revision",
        )
        .with_repair("Refresh the review and accept the evidence that is shown."));
    }
    let evidence = &current["evidence"];
    if current["status"] == "unverified"
        || evidence["pass"] != true
        || evidence["integrity"]["pass"] != true
        || !expect::explicit(&evidence["expect"])
    {
        return Err(ContractError::validation(
            "Failed, stale or generic-only checks cannot establish verified scope",
        )
        .with_repair("Approve the part as unverified, or have it checked against dimensional assertions first."));
    }
    Ok(
        json!({"evidenceHash":evidence_hash,"specHash":evidence["specHash"],
        "expect":evidence["expect"],"revisionId":revision["id"],"scopeChanges":evidence["scopeChanges"]}),
    )
}

/// The revision's requirement, when it records one as an input.
fn request_revision(handle: &ProjectHandle, revision: &Value) -> Option<String> {
    revision["inputs"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|input| {
            input["artifactId"]
                .as_str()
                .and_then(|id| require_artifact(handle, id).ok())
                .is_some_and(|artifact| artifact["type"] == "requirement")
        })
        .and_then(|input| input["revisionId"].as_str().map(str::to_owned))
}

/// Update the active-work record after a check. The bound expectation is
/// the request's assertion scope: a trial, a generic-only check or a reduced
/// expectation never replaces it.
pub(crate) fn record_work(
    handle: &ProjectHandle,
    artifact: &Value,
    revision: &Value,
    expect: &Value,
    exploratory: bool,
    next_action: &str,
) -> CoreResult<Value> {
    let mut previous = meta(handle, ACTIVE_WORK)?;
    if previous["version"] != 1 {
        previous = Value::Null;
    }
    let same_artifact = previous["artifactId"] == artifact["id"];
    let newest: Option<String> = handle
        .db
        .query_row(
            "SELECT id FROM revision WHERE artifact_id=?1 ORDER BY seq DESC LIMIT 1",
            [required_str(artifact, "id")?],
            |row| row.get(0),
        )
        .optional()
        .map_err(internal)?;
    let current_candidate = newest.as_deref() == revision["id"].as_str()
        || previous["candidateRevisionId"] == revision["id"];
    let (mut bound, mut bound_hash) = if same_artifact {
        (previous["expect"].clone(), previous["specHash"].clone())
    } else {
        (Value::Null, Value::Null)
    };
    if !exploratory
        && expect::explicit(expect)
        && current_candidate
        && (!bound.is_object() || expect::scope_changes(&bound, expect).is_empty())
    {
        bound = expect.clone();
        bound_hash = json!(expect::spec_hash(expect));
    }
    let request = request_revision(handle, revision)
        .map(Value::String)
        .unwrap_or_else(|| {
            if same_artifact {
                previous["requestRevisionId"].clone()
            } else {
                Value::Null
            }
        });
    let work = json!({"version":1,"artifactId":artifact["id"],"baselineRevisionId":artifact["selectedRevisionId"],
        "candidateRevisionId":revision["id"],"requestRevisionId":request,
        "specHash":bound_hash,"expect":bound,"nextAction":next_action,"updatedAt":now()});
    set_meta(handle, ACTIVE_WORK, &work)?;
    Ok(
        json!({"artifactId":work["artifactId"],"candidateRevisionId":work["candidateRevisionId"],
        "specHash":work["specHash"],"nextAction":work["nextAction"]}),
    )
}

/// A reviewer accepted `scope` for a part: when the active-work record is
/// about that part, it now names the accepted revision and expectation and
/// says the work waits on review. The accepted scope itself is the durable
/// authority; the work record only guides the next step.
pub(crate) fn record_scope_acceptance(
    handle: &ProjectHandle,
    artifact_id: &str,
    scope: &Value,
) -> CoreResult<()> {
    let mut work = meta(handle, ACTIVE_WORK)?;
    if work["version"] != 1 || work["artifactId"] != artifact_id {
        return Ok(());
    }
    work["candidateRevisionId"] = scope["revisionId"].clone();
    work["specHash"] = scope["specHash"].clone();
    work["expect"] = scope["expect"].clone();
    work["nextAction"] = json!("request_review");
    work["updatedAt"] = json!(now());
    set_meta(handle, ACTIVE_WORK, &work)
}

/// The immutable evidence object for one check.
#[allow(clippy::too_many_arguments)]
pub(crate) fn evidence(
    artifact: &Value,
    revision: &Value,
    identity: &Value,
    expect: &Value,
    lines: &[Value],
    preservation: &Value,
    integrity: bool,
    judgement: &Judgement,
) -> Value {
    let not_evaluated = lines
        .iter()
        .filter(|line| {
            line["detail"]
                .as_str()
                .is_some_and(|d| d.starts_with("NOT EVALUATED"))
        })
        .map(|line| line["name"].clone())
        .collect::<Vec<_>>();
    json!({"version":1,"artifactId":artifact["id"],"revisionId":revision["id"],
        "inputFingerprint":identity["inputFingerprint"],"outputHash":identity["outputHash"],
        "specHash":expect::spec_hash(expect),"checkerVersion":CHECKER,"expect":expect,"checks":lines,"preservation":preservation,
        "integrity":{"pass":integrity,"detail":"Mandatory finite, nonempty, closed, positive-volume mesh with outward source winding. Self-intersections and physical safety are only assessed where explicitly declared."},
        "status":judgement.status,"pass":judgement.pass,"scopeChanges":judgement.scope_changes,"priorSpecHashes":judgement.prior_hashes,
        "exploratory":judgement.exploratory,"coverage":{"units":"mm","frame":"right-handed-z-up",
        "assertions":lines.iter().map(|line| line["name"].clone()).collect::<Vec<_>>(),
        "notEvaluated":not_evaluated,
        "requirementAuthority":"agent_or_user_declared",
        "limitations":["Checks cover only the declared assertions, not the completeness of the engineering request.",
            "Triangle mesh and sampled cross-section and preservation checks are approximate and can miss unsampled defects.",
            "Material, mass, strength, fit tolerances and manufacturability are not assessed.",
            "A changed assertion scope requires explicit human acceptance of this evidence; acceptance does not establish completeness of the request.",
            "cad_inspect and exploratory cad_check are diagnostics; they do not bind or replace the committed assertions."]}})
}

/// The response to `cad.check`, built from the stored evidence so that it
/// agrees with `latest_verification` for the same revision.
#[allow(clippy::too_many_arguments)]
pub(crate) fn response(
    handle: &ProjectHandle,
    artifact: &Value,
    revision: &Value,
    evidence: &Value,
    evidence_hash: &str,
    judgement: &Judgement,
    mode: Mode,
    variant: bool,
    normalized: &expect::Normalized,
    mut ignored: Vec<String>,
) -> CoreResult<Value> {
    let artifact_id = required_str(artifact, "id")?;
    let stale = stale_inputs(handle, revision)?;
    let accepted = accepted_scope(handle, artifact_id)?;
    let status = resolved_status(evidence, &accepted, !stale.is_empty());
    let exploratory = judgement.exploratory;
    let action = next_action(&status, exploratory, !stale.is_empty());
    let total = evidence["checks"].as_array().map(Vec::len).unwrap_or(0);
    let failing = total - judgement.passed;
    if variant && mode == Mode::AutoCommit {
        ignored.push("autoCommit: a parameter variant is never committed".to_owned());
    }
    let work = record_work(
        handle,
        artifact,
        revision,
        &evidence["expect"],
        exploratory,
        action,
    )?;
    let again = json!({"artifactId": artifact_id});
    // A changed scope is repaired by repeating what was committed, so the
    // answer names it instead of leaving the caller to rebuild it by trial.
    let committed = (status == "scope_changed" && judgement.committed.is_object())
        .then(|| judgement.committed.clone());
    let restore = match &committed {
        Some(expect) => json!({"artifactId": artifact_id, "expect": expect}),
        None => again.clone(),
    };
    let restore_text = if committed.is_some() {
        " committedExpect is the expect to repeat."
    } else {
        ""
    };
    let (text, step) = if variant {
        (
            "Parameter-variant diagnostic only; nothing was committed. Run cad_check without params to verify the recorded part.".to_owned(),
            json!({"tool": "cad_check", "why": "Check the recorded part, without params.", "args": again}),
        )
    } else {
        match (status.as_str(), exploratory) {
            ("failed", true) => (
                format!("Trial failed: {failing} of {total} assertions. Nothing was committed. Fix the source with cad_write_source if the part is wrong, or correct an assertion that misreads the request, then run the trial again. Do not commit a failing trial."),
                json!({"tool": "cad_write_source", "why": "Fix the failing geometry, or correct a mistaken assertion, then check again.", "args": again}),
            ),
            ("failed", false) => (
                format!("NOT VERIFIED: {failing} of {total} committed assertions fail. Fix the source with cad_write_source and repeat the same assertions; they stay binding. Do not claim verified completion."),
                json!({"tool": "cad_write_source", "why": "Fix the geometry the failing assertions describe, then check again.", "args": again}),
            ),
            ("scope_changed", true) => (
                format!("Trial passes, but it drops or changes committed assertions ({}). Nothing was committed. Restore them, or ask the human to accept the changed scope.{restore_text}", judgement.scope_changes.join(", ")),
                json!({"tool": "cad_check", "why": "Restore the committed assertions and check again.", "args": restore}),
            ),
            ("scope_changed", false) => (
                format!("NOT VERIFIED: assertion scope changed ({}). Restore the committed assertions or request explicit human scope acceptance. State this unresolved status in your final response; passing individual checks does not resolve it.{restore_text}", judgement.scope_changes.join(", ")),
                json!({"tool": "cad_check", "why": "Restore the committed assertions and check again.", "args": restore}),
            ),
            ("unverified", _) if !stale.is_empty() => (
                "NOT VERIFIED: the assertions pass, but this part depends on an input that is not the approved baseline of its artifact. It becomes current when those inputs are approved at the pinned revisions, or when it is rebuilt from the current ones.".to_owned(),
                json!({"tool": "work_status", "why": "See which inputs are waiting on review."}),
            ),
            ("unverified", _) => (
                "NOT VERIFIED: this revision has no stored render that matches its source. Save the source again with cad_write_source, then check the new revision.".to_owned(),
                json!({"tool": "cad_write_source", "why": "Save the source so the revision carries its render.", "args": again}),
            ),
            ("partial", _) => (
                "NOT VERIFIED: only generic mesh checks ran. Add assertions taken from the request (size, holes, bodies, solid and empty points) and check again.".to_owned(),
                json!({"tool": "cad_check", "why": "Assert the request's dimensions.", "args": again}),
            ),
            ("passed", true) => (
                "Trial passed; nothing is committed yet. Call cad_check again with the same expect and exploratory false (or autoCommit true) to commit verification.".to_owned(),
                json!({"tool": "cad_check", "why": "Commit the passing trial: same expect, exploratory false.", "args": {"artifactId": artifact_id, "exploratory": false}}),
            ),
            ("passed", false) => (
                "Verified: declared assertions and mandatory integrity pass for this exact revision. Summarize coverage and limitations; human approval remains separate.".to_owned(),
                json!({"tool": "work_status", "why": "Confirm nothing else is outstanding."}),
            ),
            _ => (
                format!("NOT VERIFIED: {status}. Do not claim verified completion."),
                json!({"tool": "work_status", "why": "See what is outstanding."}),
            ),
        }
    };
    let mut warnings = String::new();
    if !judgement.dropped.is_empty() {
        warnings.push_str(&format!(" WARNING — this run dropped {} assertion(s) that FAILED on this same geometry earlier ({}). Passing by removing checks is not verification: either the request does not require them (say so explicitly) or the geometry must be fixed.", judgement.dropped.len(), judgement.dropped.join("; ")));
    }
    if !judgement.loosened.is_empty() {
        warnings.push_str(&format!(" WARNING — {} assertion(s) pass only after the tolerance was loosened ({}). Tighten the geometry, or state why the looser bound is the real requirement.", judgement.loosened.len(), judgement.loosened.join("; ")));
    }
    let mut result = json!({"artifactId":artifact_id,"revisionId":revision["id"],"pass":judgement.pass,"passed":judgement.passed,"total":total,
        "ready":!exploratory&&status=="passed","verificationStatus":status,"committed":!exploratory,
        "evidenceHash":evidence_hash,"specHash":evidence["specHash"],
        "scopeChanges":judgement.scope_changes,"checks":evidence["checks"],"droppedFailingAssertions":judgement.dropped,"exploratory":exploratory,
        "work":work,"nextAction":action,"nextStep":step,"next":format!("{text}{warnings}"),
        "normalizedExpect":normalized.expect,"expectChanged":normalized.changed,"ignored":ignored});
    if !judgement.loosened.is_empty() {
        result["loosenedAssertions"] = json!(judgement.loosened);
    }
    if let Some(expect) = committed {
        result["committedExpect"] = expect;
    }
    if !stale.is_empty() {
        result["staleInputs"] = json!(stale);
    }
    let not_evaluated = &evidence["coverage"]["notEvaluated"];
    if not_evaluated
        .as_array()
        .is_some_and(|items| !items.is_empty())
    {
        result["notEvaluated"] = not_evaluated.clone();
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(results: &[(&str, bool)]) -> Vec<Value> {
        results
            .iter()
            .map(
                |(name, pass)| json!({"name": name, "pass": pass, "detail": "", "tightness": 10.0}),
            )
            .collect()
    }

    fn measured(results: &[(&str, bool)]) -> Measured {
        Measured {
            lines: lines(results),
            integrity: true,
            matching: true,
        }
    }

    fn revision() -> Value {
        json!({"id": "r2", "artifactId": "a1", "parentId": "r1", "createdAt": "2026-10-01T10:00:00.000Z"})
    }

    fn ancestors() -> HashSet<String> {
        HashSet::from(["r1".to_owned()])
    }

    fn record(revision_id: &str, expect: Value, exploratory: bool, finished_at: &str) -> Record {
        Record {
            inputs: json!({"artifactId": "a1", "revisionId": revision_id, "params": {}, "expect": expect, "exploratory": exploratory}),
            outputs: json!({"verification": format!("evidence-{revision_id}-{finished_at}")}),
            log: String::new(),
            finished_at: finished_at.to_owned(),
        }
    }

    fn run(measured: &Measured, expect: Value, mode: Mode, history: &[Record]) -> Judgement {
        judge(
            measured,
            &expect,
            &Value::Null,
            mode,
            false,
            &revision(),
            &ancestors(),
            &Value::Null,
            history,
        )
    }

    fn size() -> Value {
        json!({"size": [40, 30, 4]})
    }

    #[test]
    fn status_follows_one_fixed_order() {
        assert_eq!(status_of(false, true, true, false, true), "failed");
        assert_eq!(status_of(true, false, true, false, true), "failed");
        assert_eq!(status_of(true, true, false, true, false), "unverified");
        assert_eq!(status_of(true, true, true, true, false), "scope_changed");
        assert_eq!(status_of(true, true, true, false, false), "partial");
        assert_eq!(status_of(true, true, true, false, true), "passed");
    }

    #[test]
    fn a_first_committed_check_that_passes_is_passed_and_binds() {
        let judgement = run(
            &measured(&[("overall size", true), ("watertight", true)]),
            size(),
            Mode::Commit,
            &[],
        );
        assert_eq!(judgement.status, "passed");
        assert!(!judgement.exploratory && judgement.pass);
        assert_eq!(judgement.passed, 2);
        assert!(judgement.scope_changes.is_empty());
    }

    #[test]
    fn a_check_without_assertion_lines_or_without_request_assertions_cannot_pass() {
        let empty = run(&measured(&[]), size(), Mode::Commit, &[]);
        assert_eq!(empty.status, "failed");
        assert!(!empty.pass);
        let generic = run(
            &measured(&[("watertight", true)]),
            json!({}),
            Mode::Commit,
            &[],
        );
        assert_eq!(generic.status, "partial");
        let open = Measured {
            integrity: false,
            ..measured(&[("overall size", true)])
        };
        assert_eq!(run(&open, size(), Mode::Commit, &[]).status, "failed");
        let rerendered = Measured {
            matching: false,
            ..measured(&[("overall size", true)])
        };
        assert_eq!(
            run(&rerendered, size(), Mode::Commit, &[]).status,
            "unverified"
        );
    }

    #[test]
    fn a_trial_never_binds_and_a_committed_scope_cannot_be_reduced() {
        let trial = run(
            &measured(&[("overall size", true)]),
            size(),
            Mode::Trial,
            &[],
        );
        assert!(trial.exploratory);
        assert_eq!(trial.status, "passed");
        let committed = [record(
            "r2",
            json!({"size": [40, 30, 4], "shells": 1}),
            false,
            "2026-10-01T10:05:00.000Z",
        )];
        let reduced = run(
            &measured(&[("overall size", true)]),
            size(),
            Mode::Commit,
            &committed,
        );
        assert_eq!(reduced.status, "scope_changed");
        assert_eq!(reduced.scope_changes, vec!["shells"]);
        assert_eq!(reduced.prior_hashes.len(), 1);
        let trialled = [record(
            "r2",
            json!({"size": [40, 30, 4], "shells": 1}),
            true,
            "2026-10-01T10:05:00.000Z",
        )];
        assert_eq!(
            run(
                &measured(&[("overall size", true)]),
                size(),
                Mode::Commit,
                &trialled
            )
            .status,
            "passed"
        );
        let widened = run(
            &measured(&[
                ("overall size", true),
                ("single body", true),
                ("solid at (1, 1, 1)", true),
            ]),
            json!({"size": [40.0, 30.0, 4.0], "shells": 1, "solid": [[1, 1, 1]]}),
            Mode::Commit,
            &committed,
        );
        assert_eq!(widened.status, "passed");
    }

    #[test]
    fn scope_is_inherited_from_ancestors_only_as_it_stood_when_the_candidate_was_created() {
        let wider = json!({"size": [40, 30, 4], "shells": 1});
        let before = [record(
            "r1",
            wider.clone(),
            false,
            "2026-10-01T09:00:00.000Z",
        )];
        assert_eq!(
            run(
                &measured(&[("overall size", true)]),
                size(),
                Mode::Commit,
                &before
            )
            .status,
            "scope_changed"
        );
        let after = [record(
            "r1",
            wider.clone(),
            false,
            "2026-10-01T11:00:00.000Z",
        )];
        assert_eq!(
            run(
                &measured(&[("overall size", true)]),
                size(),
                Mode::Commit,
                &after
            )
            .status,
            "passed"
        );
        let sibling = [record("r9", wider, false, "2026-10-01T09:00:00.000Z")];
        assert_eq!(
            run(
                &measured(&[("overall size", true)]),
                size(),
                Mode::Commit,
                &sibling
            )
            .status,
            "passed"
        );
    }

    #[test]
    fn a_check_that_ended_before_measuring_binds_nothing() {
        // A work limit, a render error or a timeout closes the job as failed
        // with the inputs it was planned with and no evidence.
        let mut errored = record(
            "r2",
            json!({"size": [40, 30, 4], "shells": 1}),
            false,
            "2026-10-01T10:05:00.000Z",
        );
        errored.outputs = json!({});
        let next = run(
            &measured(&[("overall size", true)]),
            size(),
            Mode::AutoCommit,
            std::slice::from_ref(&errored),
        );
        assert_eq!((next.status, next.exploratory), ("passed", false));
        assert!(next.scope_changes.is_empty() && next.prior_hashes.is_empty());
    }

    #[test]
    fn an_accepted_scope_binds_and_ends_the_walk_through_older_checks() {
        let accepted = json!({"evidenceHash": "evidence-r1-2026-10-01T09:30:00.000Z", "specHash": "h", "expect": {"size": [40, 30, 4]}});
        let history = [
            record(
                "r1",
                json!({"size": [40, 30, 4]}),
                false,
                "2026-10-01T09:30:00.000Z",
            ),
            record(
                "r1",
                json!({"size": [40, 30, 4], "shells": 1, "volume": {"value": 4800}}),
                false,
                "2026-10-01T09:00:00.000Z",
            ),
        ];
        let judgement = judge(
            &measured(&[("overall size", true)]),
            &size(),
            &Value::Null,
            Mode::Commit,
            false,
            &revision(),
            &ancestors(),
            &accepted,
            &history,
        );
        assert_eq!(judgement.status, "passed");
        assert_eq!(judgement.prior_hashes, vec!["h"]);
        let contradicting = judge(
            &measured(&[("overall size", true)]),
            &json!({"size": [41, 30, 4]}),
            &Value::Null,
            Mode::Commit,
            false,
            &revision(),
            &ancestors(),
            &accepted,
            &history,
        );
        assert_eq!(contradicting.status, "scope_changed");
        assert_eq!(contradicting.scope_changes, vec!["size"]);
    }

    #[test]
    fn auto_commit_binds_exactly_when_a_committed_check_would_pass() {
        let passing = run(
            &measured(&[("overall size", true)]),
            size(),
            Mode::AutoCommit,
            &[],
        );
        assert_eq!((passing.status, passing.exploratory), ("passed", false));
        let committed = run(
            &measured(&[("overall size", true)]),
            size(),
            Mode::Commit,
            &[],
        );
        assert_eq!(
            (committed.status, committed.exploratory),
            (passing.status, passing.exploratory)
        );
        let failing = run(
            &measured(&[("overall size", false)]),
            size(),
            Mode::AutoCommit,
            &[],
        );
        assert_eq!((failing.status, failing.exploratory), ("failed", true));
        let generic = run(
            &measured(&[("watertight", true)]),
            json!({}),
            Mode::AutoCommit,
            &[],
        );
        assert_eq!((generic.status, generic.exploratory), ("partial", true));
        let bound = [record(
            "r2",
            json!({"size": [40, 30, 4], "shells": 1}),
            false,
            "2026-10-01T10:05:00.000Z",
        )];
        let contradicting = run(
            &measured(&[("overall size", true)]),
            size(),
            Mode::AutoCommit,
            &bound,
        );
        assert_eq!(
            (contradicting.status, contradicting.exploratory),
            ("scope_changed", true)
        );
        let variant = judge(
            &measured(&[("overall size", true)]),
            &size(),
            &json!({"w": 41}),
            Mode::AutoCommit,
            true,
            &revision(),
            &ancestors(),
            &Value::Null,
            &[],
        );
        assert_eq!((variant.status, variant.exploratory), ("unverified", true));
    }

    #[test]
    fn dropping_or_loosening_a_failed_assertion_on_the_same_geometry_is_reported() {
        let mut failed = record(
            "r2",
            json!({"size": [40, 30, 4], "shells": 1}),
            false,
            "2026-10-01T10:05:00.000Z",
        );
        failed.log =
            "PASS overall size — 40×30×4\nFAIL single body — 2 shell(s) — expected 1".into();
        failed.inputs["results"] =
            json!([{"name": "overall size", "pass": false, "tightness": 10.0}]);
        let dropped = run(
            &measured(&[("overall size", true)]),
            size(),
            Mode::Commit,
            std::slice::from_ref(&failed),
        );
        assert_eq!(dropped.dropped, vec!["single body"]);
        assert!(dropped
            .scope_changes
            .contains(&"dropped previously failing assertions".to_owned()));
        let mut loose = measured(&[("overall size", true), ("single body", true)]);
        loose.lines[0]["tightness"] = json!(2.0);
        let loosened = run(
            &loose,
            json!({"size": [40, 30, 4], "shells": 1, "tol": 0.5}),
            Mode::Commit,
            std::slice::from_ref(&failed),
        );
        assert_eq!(loosened.loosened, vec!["overall size"]);
        assert_eq!(loosened.status, "scope_changed");
        let other_params = judge(
            &measured(&[("overall size", true)]),
            &size(),
            &json!({"w": 41}),
            Mode::Trial,
            true,
            &revision(),
            &ancestors(),
            &Value::Null,
            std::slice::from_ref(&failed),
        );
        assert!(other_params.dropped.is_empty());
    }

    #[test]
    fn the_next_action_after_a_failed_trial_is_to_fix_never_to_commit() {
        assert_eq!(next_action("failed", true, false), "repair_geometry");
        assert_eq!(next_action("failed", false, false), "repair_geometry");
        assert_eq!(
            next_action("scope_changed", true, false),
            "restore_assertions"
        );
        assert_eq!(next_action("passed", true, false), "commit_assertions");
        assert_eq!(next_action("passed", false, false), "request_review");
        assert_eq!(next_action("partial", true, false), "commit_assertions");
        assert_eq!(
            next_action("unverified", false, false),
            "commit_matching_render"
        );
        assert_eq!(next_action("unverified", false, true), "resolve_inputs");
    }

    #[test]
    fn recorded_status_is_adjusted_for_stale_inputs_and_accepted_scope() {
        let evidence = |status: &str| json!({"status": status, "pass": true, "integrity": {"pass": true}, "expect": {"size": [40, 30, 4]}, "specHash": "h"});
        assert_eq!(
            resolved_status(&evidence("passed"), &Value::Null, false),
            "passed"
        );
        assert_eq!(
            resolved_status(&evidence("passed"), &Value::Null, true),
            "unverified"
        );
        assert_eq!(
            resolved_status(&evidence("failed"), &Value::Null, true),
            "failed"
        );
        let accepted = json!({"specHash": "h", "expect": {"size": [40, 30, 4]}});
        assert_eq!(
            resolved_status(&evidence("scope_changed"), &accepted, false),
            "passed"
        );
        assert_eq!(
            resolved_status(&evidence("scope_changed"), &Value::Null, false),
            "scope_changed"
        );
        let wider = json!({"specHash": "other", "expect": {"size": [40, 30, 4], "shells": 1}});
        assert_eq!(
            resolved_status(&evidence("passed"), &wider, false),
            "scope_changed"
        );
    }
}
