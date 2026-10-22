//! OpenSCAD parts: source, renders, measurements and verification. Source and
//! mesh bytes live in the same immutable object store as the original
//! application; working files remain materialized.
//!
//! Every operation that runs the engine or analyses a mesh is a pipeline of
//! three steps: plan (read inputs, open jobs), compute (engine and mesh work,
//! no project database) and commit (confirm the inputs are unchanged, write
//! rows, build the response). `dispatch_shared` holds the application lock
//! for the first and last step only; a direct dispatch runs all three in place.
use super::*;
use omenflow_storage::ObjectStore;
use std::collections::HashSet;

mod checks;
mod engine;
mod expect;
mod faceted;
mod jobs;
mod mesh;
mod params;
mod python;
mod render;
mod report;
mod section;
mod spec;
mod stage;
mod step;
mod verification;
mod view;

pub(super) use expect::request_form;
pub use report::brief;
pub(super) use spec::{check_features, next_expect, requirement_conflict};
pub(crate) use stage::{committing, planning, with_probes};
pub(super) use step::export;
pub use verification::readiness;
pub(super) use verification::{
    committed_expect, committed_scope, latest_verification, quoted, record_scope_acceptance,
    requirements, validate_scope_accept,
};
pub use view::pictures;
pub(crate) use view::{view_image, view_part};

const NEXT_SOURCE: &str = "Edit the source as needed and save it with cad_write_source({ artifactId, source }) — this creates a new draft revision on the same part; the baseline is untouched until a human approves.";

thread_local! {
    static CONFIGURED_EXECUTABLE: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
    static CONFIGURED_PYTHON: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

// Each app dispatch (including its render worker) uses its own saved tool path.
// Keep the override scoped so concurrent apps/tests cannot change one another's engine.
pub(super) fn with_executable<T>(path: Option<PathBuf>, work: impl FnOnce() -> T) -> T {
    struct Restore(Option<PathBuf>);
    impl Drop for Restore {
        fn drop(&mut self) {
            CONFIGURED_EXECUTABLE.with(|value| {
                value.replace(self.0.take());
            });
        }
    }
    let _restore = Restore(CONFIGURED_EXECUTABLE.with(|value| value.replace(path)));
    work()
}

pub(super) fn configured_executable() -> Option<PathBuf> {
    CONFIGURED_EXECUTABLE.with(|value| value.borrow().clone())
}

/// The saved Python for exact STEP export, scoped like the engine path.
pub(super) fn with_python<T>(path: Option<PathBuf>, work: impl FnOnce() -> T) -> T {
    struct Restore(Option<PathBuf>);
    impl Drop for Restore {
        fn drop(&mut self) {
            CONFIGURED_PYTHON.with(|value| {
                value.replace(self.0.take());
            });
        }
    }
    let _restore = Restore(CONFIGURED_PYTHON.with(|value| value.replace(path)));
    work()
}

pub(super) fn configured_python() -> Option<PathBuf> {
    CONFIGURED_PYTHON.with(|value| value.borrow().clone())
}

/// What compute may use: the object store, the engine setting and a
/// cancellation signal. Deliberately no project database.
pub(crate) struct Workspace<'a> {
    pub root: &'a Path,
    pub objects: ObjectStore,
    pub executable: Option<PathBuf>,
    pub cancelled: &'a dyn Fn() -> bool,
}

impl<'a> Workspace<'a> {
    pub fn new(
        root: &'a Path,
        executable: Option<PathBuf>,
        cancelled: &'a dyn Fn() -> bool,
    ) -> CoreResult<Self> {
        Ok(Self {
            root,
            objects: ObjectStore::new(root.join(".omenflow/objects"), false)
                .map_err(storage_error)?,
            executable,
            cancelled,
        })
    }
}

/// One slow CAD operation, planned. See the module documentation.
pub(crate) trait Pipeline: Send {
    fn op(&self) -> &'static str;
    /// Engine path configured when the operation was planned.
    fn executable(&self) -> Option<PathBuf>;
    /// Jobs opened for this work; cancelling any of them cancels the work.
    fn job_ids(&self) -> Vec<String>;
    /// A queued job starts running. Under the lock.
    fn begin(&mut self, _handle: &ProjectHandle, _origin: &Origin) -> CoreResult<()> {
        Ok(())
    }
    /// Engine and mesh work. The outcome, success or failure, is kept for commit.
    fn compute(&mut self, workspace: &Workspace<'_>);
    /// Confirm the inputs, write the result and close the jobs. Under the lock.
    fn commit(self: Box<Self>, handle: &ProjectHandle, origin: &Origin) -> CoreResult<Value>;
}

fn run_inline(
    handle: &ProjectHandle,
    origin: &Origin,
    mut pipeline: Box<dyn Pipeline>,
) -> CoreResult<Value> {
    let job_ids = pipeline.job_ids();
    let cancelled = || jobs::cancelled(&handle.db, &job_ids);
    match Workspace::new(&handle.root, pipeline.executable(), &cancelled) {
        Ok(workspace) => pipeline.compute(&workspace),
        Err(error) => {
            abandon(handle, &job_ids, &error, origin);
            return Err(error);
        }
    }
    pipeline.commit(handle, origin)
}

/// Close jobs whose work ended without a commit.
pub(crate) fn abandon(
    handle: &ProjectHandle,
    job_ids: &[String],
    error: &ContractError,
    origin: &Origin,
) {
    for job_id in job_ids {
        let _ = jobs::fail(handle, job_id, error, origin);
    }
}

pub(crate) fn jobs_cancelled(db: &rusqlite::Connection, job_ids: &[String]) -> bool {
    jobs::cancelled(db, job_ids)
}

/// Probe the engine without touching application state.
pub(crate) fn engine_probe(configured: Option<&Path>) -> CoreResult<Value> {
    engine::probe(configured)
}

/// Kill every engine process this application started. Call it when the
/// application shuts down: engines run in their own process groups.
pub fn stop_engines() {
    engine::stop_all();
}

pub(super) fn probe() -> CoreResult<Value> {
    match stage::staged_probe() {
        Some(probe) => Ok(probe),
        None => engine::probe(configured_executable().as_deref()),
    }
}

/// The STEP converter as `tool_doctor` reports it: a Python that imports OCP.
pub(super) fn python_probe() -> Value {
    stage::staged_python_probe().unwrap_or_else(|| python::probe(configured_python().as_deref()))
}

/// Probe the STEP converter without touching application state.
pub(crate) fn python_probe_for(configured: Option<&Path>) -> Value {
    python::probe(configured)
}

fn require_mechanical(handle: &ProjectHandle, id: &str) -> CoreResult<Value> {
    let artifact = require_artifact(handle, id)?;
    if artifact["type"] != "mechanical" {
        return Err(ContractError::validation(format!(
            "Artifact \"{}\" is a {}, not a mechanical part",
            artifact["title"].as_str().unwrap_or(""),
            artifact["type"]
        ))
        .with_repair("Pass the artifactId of a mechanical part; artifact_list with type \"mechanical\" lists them."));
    }
    Ok(artifact)
}

fn pick_revision(handle: &ProjectHandle, artifact: &Value, id: Option<&str>) -> CoreResult<Value> {
    let artifact_id = required_str(artifact, "id")?;
    let revision = if let Some(id) = id {
        require_revision(handle, id)?
    } else {
        handle.db.query_row("SELECT * FROM revision WHERE artifact_id=?1 AND review_state NOT IN ('rejected','superseded') ORDER BY seq DESC LIMIT 1", [artifact_id], revision_from_row)
            .optional().map_err(internal)?.ok_or_else(|| ContractError::validation("Mechanical artifact has no revision"))?
    };
    if revision["artifactId"] != artifact_id {
        return Err(ContractError::validation(
            "Revision does not belong to artifact",
        ));
    }
    Ok(revision)
}

fn scad_ref(revision: &Value) -> Option<&Value> {
    let path = revision["payload"]["scad"]["path"].as_str();
    revision["files"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|file| file["path"].as_str() == path)
        .or_else(|| {
            revision["files"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|file| file["path"].as_str().is_some_and(|p| p.ends_with(".scad")))
        })
        .or_else(|| revision["payload"].get("scad"))
}

fn source_of(handle: &ProjectHandle, revision: &Value) -> CoreResult<(String, String)> {
    let source_ref = scad_ref(revision)
        .ok_or_else(|| ContractError::new("NOT_FOUND", "This revision has no OpenSCAD source"))?;
    let path = required_str(source_ref, "path")?.to_owned();
    let bytes = if let Some(hash) = source_ref["sha256"].as_str() {
        handle
            .object_store()
            .map_err(storage_error)?
            .read(hash)
            .map_err(storage_error)?
    } else {
        fs::read(resolve_materialization_path(&handle.root, &path).map_err(storage_error)?)
            .map_err(internal)?
    };
    let source = String::from_utf8(bytes)
        .map_err(|_| ContractError::validation("OpenSCAD source is not UTF-8"))?;
    Ok((path, source))
}

/// Recorded parameters as plain values; a payload this build cannot read
/// contributes none rather than blocking the part.
fn recorded_params(revision: &Value) -> serde_json::Map<String, Value> {
    params::effective_params(&revision["payload"]["params"]).unwrap_or_default()
}

/// Does the revision carry the render of exactly its own source and parameters?
fn render_matches(revision: &Value) -> bool {
    let Some(source) = scad_ref(revision) else {
        return false;
    };
    let identity = &revision["payload"]["renderIdentity"];
    let stl = &revision["payload"]["stl"];
    identity["version"] == 1
        && source["sha256"].is_string()
        && identity["sourceHash"] == source["sha256"]
        && stl["sha256"].is_string()
        && identity["outputHash"] == stl["sha256"]
        && identity["modelUnit"] == revision["payload"]["modelUnit"]
        && params::effective_params(&identity["params"])
            .is_ok_and(|rendered| rendered == recorded_params(revision))
}

fn hash_text(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn file_hash(handle: &ProjectHandle, relative: &str) -> CoreResult<Option<String>> {
    let path = resolve_materialization_path(&handle.root, relative).map_err(storage_error)?;
    Ok(fs::read(path)
        .ok()
        .map(|bytes| omenflow_storage::sha256_hex(&bytes)))
}

/// Parameters as the part is actually rendered: the source values with the
/// recorded overrides applied.
fn effective_parameters(source: &str, overrides: &Value) -> Vec<Value> {
    let mut effective = source.to_owned();
    for (name, value) in overrides.as_object().into_iter().flatten() {
        if let Ok(updated) = params::set_param_source(&effective, name, value) {
            effective = updated;
        }
    }
    params::parameters(&effective)
        .iter()
        .map(params::param_json)
        .collect()
}

fn slug(title: &str) -> String {
    let mut out = String::new();
    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_end_matches('-').chars().take(60).collect()
}

/// Where a part's source is materialized. A revision keeps its parent's
/// path. A new part gets a path no other part uses: titles that differ only
/// by case or punctuation, or that have no Latin letters or digits at all,
/// are told apart by the part's own id.
fn source_path(
    handle: &ProjectHandle,
    title: &str,
    artifact_id: &str,
    parent: Option<&Value>,
) -> CoreResult<String> {
    if let Some(path) = parent
        .and_then(scad_ref)
        .and_then(|file| file["path"].as_str())
    {
        return Ok(path.to_owned());
    }
    let slug = slug(title);
    let suffix = &artifact_id[..artifact_id.len().min(8)];
    if slug.is_empty() {
        return Ok(format!("artifacts/mechanical/part-{suffix}.scad"));
    }
    let candidate = format!("artifacts/mechanical/{slug}.scad");
    let used: bool = handle
        .db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM revision r JOIN artifact a ON a.id=r.artifact_id
             WHERE a.type='mechanical' AND a.id!=?2 AND (lower(json_extract(r.payload,'$.scad.path'))=lower(?1)
             OR EXISTS(SELECT 1 FROM json_each(r.files) f WHERE lower(json_extract(f.value,'$.path'))=lower(?1))))",
            params![candidate, artifact_id],
            |row| row.get(0),
        )
        .map_err(internal)?;
    let on_disk = resolve_materialization_path(&handle.root, &candidate)
        .map_err(storage_error)?
        .exists();
    Ok(if used || on_disk {
        format!("artifacts/mechanical/{slug}-{suffix}.scad")
    } else {
        candidate
    })
}

/// The parameter manifest for a new revision. What a person recorded about
/// a parameter (its dimension, unit and description) survives a rewrite.
fn manifest_for(declared: &[params::ScadParam], parent: Option<&Value>) -> Value {
    let prior = |name: &str| {
        parent
            .and_then(|revision| revision["payload"]["paramManifest"].as_array())
            .into_iter()
            .flatten()
            .find(|entry| entry["name"] == name)
    };
    let mut seen = HashSet::new();
    Value::Array(
        declared
            .iter()
            .filter(|param| seen.insert(param.name.as_str()))
            .map(|param| {
                let before = prior(&param.name);
                let mut entry = json!({"name": param.name,
                    "dimension": before.and_then(|entry| entry["dimension"].as_str()).unwrap_or_else(|| params::inferred_dimension(param))});
                if let Some(unit) = before.and_then(|entry| entry["unit"].as_str()) {
                    entry["unit"] = json!(unit);
                }
                if let Some(description) = param
                    .comment
                    .as_deref()
                    .or_else(|| before.and_then(|entry| entry["description"].as_str()))
                {
                    entry["description"] = json!(description);
                }
                entry
            })
            .collect(),
    )
}

#[allow(clippy::too_many_arguments)]
fn commit_cad(
    handle: &ProjectHandle,
    artifact_id: &str,
    artifact: Option<&Value>,
    parent: Option<&Value>,
    title: &str,
    source_path: &str,
    source_hash: &str,
    render: &render::Rendered,
    job_id: &str,
    params_value: &Value,
    manifest: &Value,
    inputs: &Value,
    rationale: &str,
    subsystem: Option<&str>,
    origin: &Origin,
) -> CoreResult<(Value, Vec<String>)> {
    let source_ref = json!({"path":source_path,"sha256":source_hash,"role":"source"});
    let mut files = vec![source_ref.clone()];
    let mut body = json!({"scad":source_ref,"params":params_value,"paramManifest":manifest,"modelUnit":"mm","renderJobId":job_id});
    if let Some(existing) = parent {
        for key in ["material", "manufacturing"] {
            if let Some(v) = existing["payload"].get(key) {
                body[key] = v.clone();
            }
        }
    }
    if let (Some(identity), Some(mesh)) = (&render.identity, &render.mesh) {
        let stl_path = source_path
            .strip_suffix(".scad")
            .map(|p| format!("{p}.stl"))
            .unwrap_or(format!("{source_path}.stl"));
        let stl_ref = json!({"path":stl_path,"sha256":identity["outputHash"],"role":"output"});
        files.push(stl_ref.clone());
        body["stl"] = stl_ref;
        body["renderIdentity"] = identity.clone();
        body["bounds"] = json!({"min":mesh.bounds_min,"max":mesh.bounds_max});
    }
    let body = parse_artifact_payload("mechanical", body)?;
    let normalized = normalize_inputs(handle, artifact_id, inputs)?;
    graph::validate_revision_inputs(handle, artifact_id, &normalized)?;
    let digest = models::content_hash(
        &body,
        &files
            .iter()
            .filter_map(|f| f["sha256"].as_str().map(str::to_owned))
            .collect::<Vec<_>>(),
    );
    let revision_id = uuid::Uuid::new_v4().to_string();
    let timestamp = now();
    // A render worker commits on its own connection while the interface's
    // keeps writing. The write lock is taken up front (and waited for): a
    // deferred transaction that read first could not take it later once the
    // other connection had committed, and the call would fail as "database
    // is locked" without waiting.
    let tx =
        rusqlite::Transaction::new_unchecked(&handle.db, rusqlite::TransactionBehavior::Immediate)
            .map_err(internal)?;
    let seq: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(seq),0)+1 FROM revision WHERE artifact_id=?1",
            [&artifact_id],
            |row| row.get(0),
        )
        .map_err(internal)?;
    if artifact.is_none() {
        tx.execute("INSERT INTO artifact(id,type,title,subsystem,selected_revision_id,archived,created_at) VALUES(?1,'mechanical',?2,?3,NULL,0,?4)",params![artifact_id,title,subsystem,timestamp]).map_err(internal)?;
    }
    tx.execute("INSERT INTO revision(id,artifact_id,parent_id,seq,origin,origin_detail,created_at,payload,content_hash,files,inputs,rationale,review_state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'draft')",
        params![revision_id,artifact_id,parent.and_then(|p|p["id"].as_str()),seq,origin.kind(),origin.session_id(),timestamp,body.to_string(),digest,json!(files).to_string(),json!(normalized).to_string(),rationale]).map_err(internal)?;
    tx.execute(
        "DELETE FROM artifact_fts WHERE artifact_id=?1",
        [&artifact_id],
    )
    .map_err(internal)?;
    tx.execute(
        "INSERT INTO artifact_fts(artifact_id,revision_id,title,text) VALUES(?1,?2,?3,?4)",
        params![artifact_id, revision_id, title, body.to_string()],
    )
    .map_err(internal)?;
    tx_event(
        &tx,
        "revision.committed",
        origin.kind(),
        json!({"artifactId":artifact_id,"revisionId":revision_id,"reviewState":"draft"}),
    )?;
    tx.commit().map_err(internal)?;
    // The revision stands from here: a working file that cannot be written
    // is reported with the result, not as a failure of the call.
    let warnings = settle_files(handle, &files, parent);
    Ok((require_revision(handle, &revision_id)?, warnings))
}

fn render_job_finish(rendered: &render::Rendered) -> jobs::Finish {
    jobs::Finish {
        tool_version: Some(rendered.engine_version.clone()),
        command: Some(if rendered.cached {
            format!("render cache ({})", rendered.command)
        } else {
            rendered.command.clone()
        }),
        log: rendered.log.clone(),
        output_hashes: rendered
            .identity
            .as_ref()
            .map(|identity| json!({"stl": identity["outputHash"]}))
            .unwrap_or_else(|| json!({})),
        error: (!rendered.ok).then(|| {
            ContractError::new(
                if rendered.timed_out {
                    "TIMEOUT"
                } else {
                    "VALIDATION"
                },
                rendered.first_error(),
            )
        }),
        inputs: None,
    }
}

/// Close the job of a render that ran to an outcome.
fn close_render_job(
    handle: &ProjectHandle,
    job_id: &str,
    rendered: &render::Rendered,
    origin: &Origin,
) -> CoreResult<()> {
    if !job_id.is_empty() {
        jobs::finish(
            handle,
            job_id,
            if rendered.ok { "succeeded" } else { "failed" },
            render_job_finish(rendered),
            origin,
        )?;
    }
    Ok(())
}

fn render_failed(action: &str, rendered: &render::Rendered) -> ContractError {
    ContractError::new(
        if rendered.timed_out {
            "TIMEOUT"
        } else {
            "VALIDATION"
        },
        format!("Cannot {action}: {}", rendered.first_error()),
    )
    .with_repair(format!(
        "Fix the source with cad_write_source, then {action} again."
    ))
    .with_details(
        json!({"warnings": rendered.warnings, "errors": rendered.errors, "hints": rendered.hints}),
    )
}

fn input_changed(artifact: &Value, planned: &str, current: &str) -> ContractError {
    ContractError::new(
        "INPUT_CHANGED",
        format!(
            "\"{}\" changed while this call was running: revision {current} was saved after revision {planned} was read. Nothing was committed.",
            artifact["title"].as_str().unwrap_or("The part")
        ),
    )
    .with_repair("Read the current source with cad_read_source, then repeat the call against the current revision.")
    .with_details(json!({"artifactId": artifact["id"], "plannedRevisionId": planned, "currentRevisionId": current}))
}

fn internal_stage() -> ContractError {
    ContractError::new("INTERNAL", "CAD work was committed before it was computed")
}

struct WriteRequest<'a> {
    op: &'static str,
    artifact_id: Option<&'a str>,
    expected_revision_id: Option<&'a str>,
    title: Option<&'a str>,
    source: String,
    params: Value,
    subsystem: Option<&'a str>,
    rationale: String,
    inputs: Option<Value>,
    timeout_ms: u64,
    notes: Vec<String>,
    brief: bool,
}

/// How a re-render of an existing revision obtains its job.
enum RenderJob<'a> {
    Start,
    Queue,
    Existing(&'a str),
}

struct WritePlan {
    op: &'static str,
    artifact_id: String,
    artifact: Option<Value>,
    parent: Option<Value>,
    title: String,
    subsystem: Option<String>,
    source: String,
    injected_fn: bool,
    has_parameters: bool,
    params: Value,
    manifest: Value,
    inputs: Value,
    rationale: String,
    path: String,
    working_hash: Option<String>,
    source_hash: String,
    request: render::Request,
    job_id: String,
    queued: bool,
    /// A re-render of an existing revision: commits only a successful render
    /// and answers with the job.
    rerender: bool,
    notes: Vec<String>,
    brief: bool,
    executable: Option<PathBuf>,
}

struct WriteOutcome {
    rendered: render::Rendered,
    details: Option<report::Details>,
}

struct WritePipeline {
    plan: WritePlan,
    outcome: Option<CoreResult<WriteOutcome>>,
}

fn plan_write(
    handle: &ProjectHandle,
    request: WriteRequest<'_>,
    origin: &Origin,
) -> CoreResult<WritePipeline> {
    let (source, injected_fn) = params::with_default_facets(&request.source);
    params::assert_self_contained(&source)?;
    let declared = params::parameters(&source);
    let mut overrides = params::override_params(&request.params, &declared)?
        .as_object()
        .cloned()
        .unwrap_or_default();
    let artifact = request
        .artifact_id
        .map(|id| require_mechanical(handle, id))
        .transpose()?;
    let parent = artifact
        .as_ref()
        .map(|a| pick_revision(handle, a, None))
        .transpose()?;
    if let (Some(expected), Some(parent)) = (request.expected_revision_id, parent.as_ref()) {
        if parent["id"] != expected {
            return Err(ContractError::revision_conflict(
                "CAD input revision changed; read the current source before retrying.",
                parent["id"].as_str().unwrap_or(""),
            ));
        }
    }
    let mut notes = request.notes;
    let title = match &artifact {
        Some(artifact) => {
            let title = required_str(artifact, "title")?;
            if request.title.is_some_and(|given| given != title) {
                notes.push(format!(
                    "title was ignored: this call revises the existing part \"{title}\"."
                ));
            }
            title.to_owned()
        }
        None => request
            .title
            .ok_or_else(|| {
                ContractError::validation("title is required when creating a new part").with_repair(
                    "Pass title to create a part, or artifactId to revise an existing one.",
                )
            })?
            .to_owned(),
    };
    if let Some(parent) = &parent {
        let previous = source_of(handle, parent)
            .map(|(_, source)| source)
            .unwrap_or_default();
        for (name, value) in
            params::inherited_overrides(&source, &previous, &recorded_params(parent))
        {
            overrides.entry(name).or_insert(value);
        }
    }
    let overrides = Value::Object(overrides);
    let artifact_id = artifact
        .as_ref()
        .and_then(|a| a["id"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let inputs = request
        .inputs
        .or_else(|| parent.as_ref().map(|p| p["inputs"].clone()))
        .unwrap_or(json!([]));
    let normalized = normalize_inputs(handle, &artifact_id, &inputs)?;
    graph::validate_revision_inputs(handle, &artifact_id, &normalized)?;
    let path = source_path(handle, &title, &artifact_id, parent.as_ref())?;
    let working_hash = file_hash(handle, &path)?;
    let source_hash = handle
        .object_store()
        .map_err(storage_error)?
        .put(source.as_bytes())
        .map_err(storage_error)?;
    let job_id = jobs::start(
        handle,
        "cad_render",
        "openscad",
        &json!({"artifactId": artifact_id, "revisionId": parent.as_ref().map(|p| p["id"].clone()), "params": overrides}),
        &json!({"source": source_hash}),
        origin,
    )?;
    Ok(WritePipeline {
        plan: WritePlan {
            op: request.op,
            manifest: manifest_for(&declared, parent.as_ref()),
            rationale: if request.rationale.is_empty() {
                if parent.is_some() {
                    "source revised"
                } else {
                    "initial source"
                }
                .to_owned()
            } else {
                request.rationale
            },
            request: render::Request::new(&source, &overrides, request.timeout_ms),
            artifact_id,
            artifact,
            parent,
            title,
            subsystem: request.subsystem.map(str::to_owned),
            source,
            injected_fn,
            has_parameters: !declared.is_empty(),
            params: overrides,
            inputs,
            path,
            working_hash,
            source_hash,
            job_id,
            queued: false,
            rerender: false,
            notes,
            brief: request.brief,
            executable: configured_executable(),
        },
        outcome: None,
    })
}

/// Plan a render of an existing revision's own source, as the interface's
/// Render action asks for. Only the newest revision of a part can be
/// rendered, because the result is committed as its successor.
fn plan_rerender(
    handle: &ProjectHandle,
    input: &Value,
    origin: &Origin,
    job: RenderJob<'_>,
) -> CoreResult<WritePipeline> {
    let artifact = require_mechanical(handle, required_str(input, "artifactId")?)?;
    let revision = pick_revision(handle, &artifact, input["revisionId"].as_str())?;
    let head = pick_revision(handle, &artifact, None)?;
    if head["id"] != revision["id"] {
        return Err(ContractError::revision_conflict(
            "Only the newest revision of a part can be rendered; this one has a successor.",
            head["id"].as_str().unwrap_or(""),
        ));
    }
    let (path, source) = source_of(handle, &revision)?;
    params::assert_self_contained(&source)?;
    let declared = params::parameters(&source);
    let mut merged = recorded_params(&revision);
    merged.extend(params::effective_params(&input["params"])?);
    let overrides = params::override_params(&Value::Object(merged), &declared)?;
    let source_hash = required_str(
        scad_ref(&revision).ok_or_else(|| ContractError::validation("CAD source missing"))?,
        "sha256",
    )?
    .to_owned();
    let artifact_id = required_str(&artifact, "id")?.to_owned();
    let job_inputs =
        json!({"artifactId": artifact_id, "revisionId": revision["id"], "params": overrides});
    let job_hashes = json!({"source": source_hash});
    let (job_id, queued) = match job {
        RenderJob::Start => (
            jobs::start(
                handle,
                "cad_render",
                "openscad",
                &job_inputs,
                &job_hashes,
                origin,
            )?,
            false,
        ),
        RenderJob::Queue => (
            jobs::queue(
                handle,
                "cad_render",
                "openscad",
                &job_inputs,
                &job_hashes,
                origin,
            )?,
            true,
        ),
        RenderJob::Existing(id) => (id.to_owned(), true),
    };
    Ok(WritePipeline {
        plan: WritePlan {
            op: "cad.render",
            title: required_str(&artifact, "title")?.to_owned(),
            subsystem: artifact["subsystem"].as_str().map(str::to_owned),
            manifest: revision["payload"]["paramManifest"].clone(),
            inputs: revision["inputs"].clone(),
            rationale: "rendered source".to_owned(),
            working_hash: file_hash(handle, &path)?,
            request: render::Request::new(&source, &overrides, render::timeout_ms(input)),
            artifact_id,
            artifact: Some(artifact),
            parent: Some(revision),
            source,
            injected_fn: false,
            has_parameters: !declared.is_empty(),
            params: overrides,
            path,
            source_hash,
            job_id,
            queued,
            rerender: true,
            notes: vec![],
            brief: false,
            executable: configured_executable(),
        },
        outcome: None,
    })
}

impl WritePipeline {
    fn report(&self, revision: &Value, outcome: &WriteOutcome) -> Value {
        let plan = &self.plan;
        let rendered = &outcome.rendered;
        let mut notes = plan.notes.clone();
        if !rendered.warnings.is_empty() {
            notes.push(if rendered.ok {
                "OpenSCAD reported warnings (see render.warnings and render.hints) — an unknown variable usually means a typo; fix them before trusting the geometry."
            } else {
                "OpenSCAD warnings usually point at the cause (unknown variable = typo, empty object = nothing left after difference)."
            }.to_owned());
        }
        if plan.injected_fn {
            notes.push("Injected $fn = 64 as the first line so curved primitives render as circles instead of the default coarse polygon; line numbers in messages count from that line.".to_owned());
        }
        if rendered.source_inverted {
            notes.push("NOT VERIFIED: the source produces inside-out geometry. The stored mesh was turned outward for display, but the source winding must be fixed before verification. For polyhedron(), list each face clockwise when viewed from outside; reverse every face if the whole body is inverted.".to_owned());
        }
        let (action, text, step) = if rendered.ok {
            (
                "commit_assertions",
                "Compare these measurements with the request. Then call cad_check with expectations taken from the request (size, holes with position and diameter, bodies, solid and empty points) and fix any failure. Report done only when the check is ready.",
                json!({"tool": "cad_check", "why": "Measurements are not verification; assert the request's dimensions.", "args": {"artifactId": plan.artifact_id}}),
            )
        } else {
            notes.insert(0, "Render failed — fix the source and call cad_write_source again. The source was saved as a draft without a mesh.".to_owned());
            (
                "repair_geometry",
                "The render failed, so there is nothing to measure or verify. Read render.errors and render.hints, fix the source and save it again with cad_write_source.",
                json!({"tool": "cad_write_source", "why": "Fix the source errors and save again.", "args": {"artifactId": plan.artifact_id}}),
            )
        };
        let mut report = json!({"artifactId":plan.artifact_id,"revisionId":revision["id"],"title":plan.title,"sourcePath":plan.path,
            "render":rendered.summary(),
            "parameters":effective_parameters(&plan.source, &plan.params)});
        if let Some(details) = &outcome.details {
            notes.extend(details.notes.iter().cloned());
            report["geometry"] = details.geometry.clone();
            report["sections"] = json!(details.sections);
            report["probes"] = json!([]);
            if !details.not_evaluated.is_empty() {
                report["limits"] = json!({"triangles": details.geometry["triangles"], "maxTriangles": mesh::MAX_TRIANGLES, "notEvaluated": details.not_evaluated});
            }
        }
        report["notes"] = json!(notes);
        report["nextAction"] = json!(action);
        report["nextStep"] = step;
        report["next"] = json!(text);
        report
    }

    fn commit_outcome(
        &self,
        handle: &ProjectHandle,
        outcome: &WriteOutcome,
        origin: &Origin,
    ) -> CoreResult<Value> {
        let plan = &self.plan;
        let rendered = &outcome.rendered;
        if jobs::cancelled(&handle.db, std::slice::from_ref(&plan.job_id)) {
            return Err(ContractError::new("CANCELLED", "Render was cancelled"));
        }
        if let (Some(artifact), Some(parent)) = (&plan.artifact, &plan.parent) {
            let current =
                pick_revision(handle, &require_artifact(handle, &plan.artifact_id)?, None)?;
            if current["id"] != parent["id"] {
                return Err(input_changed(
                    artifact,
                    parent["id"].as_str().unwrap_or(""),
                    current["id"].as_str().unwrap_or(""),
                ));
            }
        }
        // A revision continues its parent's working file, which must still be
        // what was read. A new part chooses its path again below.
        if plan.parent.is_some() && file_hash(handle, &plan.path)? != plan.working_hash {
            return Err(ContractError::new(
                "REVISION_CONFLICT",
                "Source changed during render; reread before retrying",
            )
            .with_repair(format!("The working file {} was edited while it rendered. Read it again and save the version you want with cad_write_source.", plan.path))
            .with_details(json!({"sourcePath": plan.path, "jobId": plan.job_id})));
        }
        if plan.rerender && !rendered.ok {
            close_render_job(handle, &plan.job_id, rendered, origin)?;
            return Ok(json!({"job": jobs::read(handle, &plan.job_id)?}));
        }
        // Another part, or a file, may have taken the path while this one
        // rendered.
        let path = if plan.parent.is_some() {
            plan.path.clone()
        } else {
            source_path(handle, &plan.title, &plan.artifact_id, None)?
        };
        let (revision, warnings) = commit_cad(
            handle,
            &plan.artifact_id,
            plan.artifact.as_ref(),
            plan.parent.as_ref(),
            &plan.title,
            &path,
            &plan.source_hash,
            rendered,
            &plan.job_id,
            &plan.params,
            &plan.manifest,
            &plan.inputs,
            &plan.rationale,
            plan.subsystem.as_deref(),
            origin,
        )?;
        close_render_job(handle, &plan.job_id, rendered, origin)?;
        if plan.rerender {
            let mut queued = json!({"job": jobs::read(handle, &plan.job_id)?});
            if !warnings.is_empty() {
                queued["warnings"] = json!(warnings);
            }
            return Ok(queued);
        }
        let mut report = self.report(&revision, outcome);
        report["sourcePath"] = json!(path);
        if !warnings.is_empty() {
            report["warnings"] = json!(warnings);
        }
        Ok(if plan.brief {
            report::brief(plan.op, &report)
        } else {
            report
        })
    }
}

impl Pipeline for WritePipeline {
    fn op(&self) -> &'static str {
        self.plan.op
    }

    fn executable(&self) -> Option<PathBuf> {
        self.plan.executable.clone()
    }

    fn job_ids(&self) -> Vec<String> {
        vec![self.plan.job_id.clone()]
    }

    fn begin(&mut self, handle: &ProjectHandle, origin: &Origin) -> CoreResult<()> {
        if self.plan.queued {
            jobs::claim(handle, &self.plan.job_id, origin)?;
            self.plan.queued = false;
        }
        Ok(())
    }

    fn compute(&mut self, workspace: &Workspace<'_>) {
        let plan = &self.plan;
        self.outcome = Some((|| {
            let rendered = render::render(workspace, &plan.request, &plan.job_id)?;
            let details = match (&rendered.mesh, plan.rerender) {
                (Some(mesh), false) => Some(report::details(
                    mesh,
                    plan.has_parameters,
                    &[],
                    &[],
                    workspace.cancelled,
                )?),
                _ => None,
            };
            Ok(WriteOutcome { rendered, details })
        })());
    }

    fn commit(mut self: Box<Self>, handle: &ProjectHandle, origin: &Origin) -> CoreResult<Value> {
        let result = match self.outcome.take() {
            Some(Ok(outcome)) => self.commit_outcome(handle, &outcome, origin),
            Some(Err(error)) => Err(error),
            None => Err(internal_stage()),
        };
        if let Err(error) = &result {
            abandon(handle, &self.job_ids(), error, origin);
        }
        result
    }
}

fn wants_brief(input: &Value) -> bool {
    input["detail"] == "brief"
}

/// `expect` on a source write is checked by the agent host, which takes it
/// out before the write reaches the core. A caller that reaches the core with
/// it would get a write without the check it asked for, so it is refused
/// before anything is planned.
fn refuse_inline_expect(op: &str, input: &Value) -> CoreResult<()> {
    if input.get("expect").is_none_or(Value::is_null) {
        return Ok(());
    }
    let tool = op.replace('.', "_");
    Err(
        ContractError::validation(format!("{tool} checks expect only in an agent session"))
            .with_repair(format!(
                "Call {tool} without expect, then cad_check with that expect and autoCommit true."
            ))
            .with_details(json!({"op": op, "field": "expect"})),
    )
}

pub(super) fn write_source(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    stage::drive(handle, origin, "cad.write_source", || {
        refuse_inline_expect("cad.write_source", input)?;
        Ok(Box::new(plan_write(
            handle,
            WriteRequest {
                op: "cad.write_source",
                artifact_id: input["artifactId"].as_str(),
                expected_revision_id: input["expectedRevisionId"].as_str(),
                title: input["title"].as_str(),
                source: required_str(input, "source")?.to_owned(),
                params: input["params"].clone(),
                subsystem: input["subsystem"].as_str(),
                rationale: input["rationale"].as_str().unwrap_or("").to_owned(),
                inputs: None,
                timeout_ms: render::timeout_ms(input),
                notes: vec![],
                brief: wants_brief(input),
            },
            origin,
        )?))
    })
}

/// Where a snippet that was not found verbatim would match if whitespace
/// were ignored: the commonest reason a patch misses.
fn whitespace_match(source: &str, snippet: &str) -> Option<usize> {
    let squeeze = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
    let wanted = squeeze(snippet);
    if wanted.is_empty() {
        return None;
    }
    let lines = source.lines().collect::<Vec<_>>();
    let span = snippet.lines().count().max(1);
    (0..lines.len()).find(|start| {
        let end = (start + span).min(lines.len());
        squeeze(&lines[*start..end].join("\n")).contains(&wanted)
    })
}

pub(super) fn patch_source(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    stage::drive(handle, origin, "cad.patch_source", || {
        refuse_inline_expect("cad.patch_source", input)?;
        let artifact = require_mechanical(handle, required_str(input, "artifactId")?)?;
        let revision = pick_revision(handle, &artifact, None)?;
        let (_, source) = source_of(handle, &revision)?;
        let old = required_str(input, "oldString")?;
        let hits = source.matches(old).count();
        if hits != 1 {
            let error = if hits == 0 {
                let near = whitespace_match(&source, old);
                ContractError::validation("oldString was not found in the current source — read the source and copy the snippet exactly.")
                    .with_repair(match near {
                        Some(line) => format!("A match that differs only in whitespace starts at line {}: `{}`. Call cad_read_source and copy the snippet character for character.", line + 1, source.lines().nth(line).unwrap_or("").trim()),
                        None => "Call cad_read_source and copy the snippet character for character.".to_owned(),
                    })
            } else {
                ContractError::validation(format!("oldString occurs {hits} times; it must be unique so the patch cannot hit the wrong site."))
                    .with_repair("Include more of the surrounding text so the snippet occurs exactly once.")
            };
            return Err(error.with_details(json!({"occurrences": hits})));
        }
        let rationale = input["rationale"].as_str().filter(|text| !text.is_empty());
        Ok(Box::new(plan_write(
            handle,
            WriteRequest {
                op: "cad.patch_source",
                artifact_id: artifact["id"].as_str(),
                expected_revision_id: input["expectedRevisionId"]
                    .as_str()
                    .or(revision["id"].as_str()),
                title: None,
                source: source.replacen(old, required_str(input, "newString")?, 1),
                params: Value::Null,
                subsystem: None,
                rationale: rationale.unwrap_or("source patched").to_owned(),
                inputs: None,
                timeout_ms: render::timeout_ms(input),
                notes: vec![],
                brief: wants_brief(input),
            },
            origin,
        )?))
    })
}

pub(super) fn set_param(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    stage::drive(handle, origin, "cad.set_param", || {
        refuse_inline_expect("cad.set_param", input)?;
        let artifact = require_mechanical(handle, required_str(input, "artifactId")?)?;
        let revision = pick_revision(handle, &artifact, None)?;
        let (_, source) = source_of(handle, &revision)?;
        let name = required_str(input, "name")?;
        let updated = params::set_param_source(&source, name, &input["value"])?;
        let mut recorded = recorded_params(&revision);
        recorded.insert(name.to_owned(), input["value"].clone());
        let rationale = input["rationale"].as_str().filter(|text| !text.is_empty());
        Ok(Box::new(plan_write(
            handle,
            WriteRequest {
                op: "cad.set_param",
                artifact_id: artifact["id"].as_str(),
                expected_revision_id: input["expectedRevisionId"]
                    .as_str()
                    .or(revision["id"].as_str()),
                title: None,
                source: updated,
                params: Value::Object(recorded),
                subsystem: None,
                rationale: rationale
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("set {name}")),
                inputs: None,
                timeout_ms: render::timeout_ms(input),
                notes: vec![],
                brief: wants_brief(input),
            },
            origin,
        )?))
    })
}

fn vector(value: &Value) -> [f64; 3] {
    [0, 1, 2].map(|i| value[i].as_f64().unwrap_or(0.0))
}

/// OpenSCAD `rotate([x, y, z])`: about x, then y, then z, in degrees.
fn rotate_xyz(point: [f64; 3], degrees: [f64; 3]) -> [f64; 3] {
    let [ax, ay, az] = degrees.map(f64::to_radians);
    let [x, y, z] = point;
    let (y, z) = (y * ax.cos() - z * ax.sin(), y * ax.sin() + z * ax.cos());
    let (x, z) = (x * ay.cos() + z * ay.sin(), -x * ay.sin() + z * ay.cos());
    let (x, y) = (x * az.cos() - y * az.sin(), x * az.sin() + y * az.cos());
    [x, y, z]
}

fn placed_bounds(bounds: &Value, translate: [f64; 3], rotate: [f64; 3]) -> ([f64; 3], [f64; 3]) {
    let (low, high) = (vector(&bounds["min"]), vector(&bounds["max"]));
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for corner in 0..8 {
        let point = std::array::from_fn(|axis| {
            if corner >> axis & 1 == 0 {
                low[axis]
            } else {
                high[axis]
            }
        });
        let turned = rotate_xyz(point, rotate);
        for axis in 0..3 {
            min[axis] = min[axis].min(turned[axis] + translate[axis]);
            max[axis] = max[axis].max(turned[axis] + translate[axis]);
        }
    }
    (min, max)
}

pub(super) fn compose(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    stage::drive(handle, origin, "cad.compose", || {
        let mut blocks = vec![
            "// composed assembly — module-wrapped instances, transform only (no mates / STEP)"
                .to_owned(),
        ];
        let mut inputs = Vec::<Value>::new();
        let mut placed = Vec::<(usize, [f64; 3], [f64; 3])>::new();
        for (index, instance) in input["instances"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
        {
            let artifact = require_mechanical(handle, required_str(instance, "artifactId")?)?;
            let revision = pick_revision(handle, &artifact, instance["revisionId"].as_str())?;
            let (_, mut source) = source_of(handle, &revision)?;
            for (name, value) in recorded_params(&revision) {
                if let Ok(updated) = params::set_param_source(&source, &name, &value) {
                    source = updated;
                }
            }
            let list = |key: &str| {
                instance[key]
                    .as_array()
                    .cloned()
                    .unwrap_or_else(|| vec![json!(0), json!(0), json!(0)])
                    .iter()
                    .map(|value| params::number_value(value.as_f64().unwrap_or(0.0)).to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            let (translate, rotate) = (vector(&instance["translate"]), vector(&instance["rotate"]));
            let transform = if rotate == [0.0; 3] {
                format!("translate([{}]) _inst_{index}();", list("translate"))
            } else {
                format!(
                    "translate([{}]) rotate([{}]) _inst_{index}();",
                    list("translate"),
                    list("rotate")
                )
            };
            blocks.push(format!(
                "module _inst_{index}() {{\n{}\n}}\n{transform}",
                source.trim_end()
            ));
            if !inputs.iter().any(|item| {
                item["artifactId"] == artifact["id"] && item["revisionId"] == revision["id"]
            }) {
                inputs.push(json!({"artifactId":artifact["id"],"revisionId":revision["id"],"relationship":"depends_on","label":"composition snapshot"}));
            }
            if revision["payload"]["bounds"].is_object() {
                let (min, max) = placed_bounds(&revision["payload"]["bounds"], translate, rotate);
                placed.push((index, min, max));
            }
        }
        let mut overlapping = Vec::new();
        for (i, (first, min_a, max_a)) in placed.iter().enumerate() {
            for (second, min_b, max_b) in &placed[i + 1..] {
                if (0..3).all(|axis| {
                    min_a[axis] < max_b[axis] - 1e-3 && max_a[axis] > min_b[axis] + 1e-3
                }) {
                    overlapping.push(format!("#{first} and #{second}"));
                }
            }
        }
        let notes = if overlapping.is_empty() {
            vec![]
        } else {
            vec![format!("Instances {} overlap after transform — OpenSCAD unions overlapping top-level objects into one body. Separate them or accept the unioned solid.", overlapping.join(", "))]
        };
        let rationale = input["rationale"].as_str().filter(|text| !text.is_empty());
        Ok(Box::new(plan_write(
            handle,
            WriteRequest {
                op: "cad.compose",
                artifact_id: None,
                expected_revision_id: None,
                title: input["title"].as_str(),
                source: format!("{}\n", blocks.join("\n\n")),
                params: Value::Null,
                subsystem: None,
                rationale: rationale
                    .unwrap_or("composed from existing parts")
                    .to_owned(),
                inputs: Some(json!(inputs)),
                timeout_ms: render::timeout_ms(input),
                notes,
                brief: wants_brief(input),
            },
            origin,
        )?))
    })
}

/// Queue a render of a revision's source. The job is returned at once; a
/// worker renders it and commits the result as a new draft.
pub(super) fn queue_render(
    handle: &ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    let pipeline = plan_rerender(handle, input, origin, RenderJob::Queue)?;
    let queued = json!({"job": jobs::read(handle, &pipeline.plan.job_id)?});
    if stage::is_planning() {
        stage::hand_back(Box::new(pipeline));
    }
    Ok(queued)
}

/// True when the render just queued on this thread was handed to
/// `dispatch_shared`, which runs it itself: the caller must not start a
/// worker for it.
pub(super) fn queued_render_is_staged() -> bool {
    stage::is_planned()
}

pub(super) fn render(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    let pipeline = plan_rerender(handle, input, origin, RenderJob::Start)?;
    run_inline(handle, origin, Box::new(pipeline))
}

/// The worker half of a queued render started by a direct dispatch.
pub(super) fn finish_queued_render(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
    job_id: &str,
) -> CoreResult<Value> {
    let result = plan_rerender(handle, input, origin, RenderJob::Existing(job_id)).and_then(
        |mut pipeline| {
            pipeline.begin(handle, origin)?;
            run_inline(handle, origin, Box::new(pipeline))
        },
    );
    if let Err(error) = &result {
        jobs::fail(handle, job_id, error, origin)?;
    }
    result
}

pub(super) fn read_source(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    let artifact = require_mechanical(handle, required_str(input, "artifactId")?)?;
    let revision = pick_revision(handle, &artifact, input["revisionId"].as_str())?;
    let (path, source) = source_of(handle, &revision)?;
    let recorded = Value::Object(recorded_params(&revision));
    Ok(
        json!({"artifactId":artifact["id"],"revisionId":revision["id"],"title":artifact["title"],
        "revisionSeq":revision["seq"],"reviewState":revision["reviewState"],
        "isBaseline":artifact["selectedRevisionId"]==revision["id"],"sourcePath":path,
        "parameters":effective_parameters(&source, &recorded),"source":source,"recordedParams":recorded,
        "unit":revision["payload"]["modelUnit"].as_str().unwrap_or("mm"),"hasRender":render_matches(&revision),"next":NEXT_SOURCE}),
    )
}

/// Where the mesh of a revision comes from for a measurement.
enum MeshSource {
    /// The revision's own stored render, with the request that reproduces it
    /// should the stored bytes be unreadable.
    Stored {
        hash: String,
        identity: Value,
        fallback: render::Request,
    },
    Render {
        request: render::Request,
        job_id: String,
    },
}

impl MeshSource {
    /// Decide where the mesh comes from. No job is opened yet, so a later
    /// validation failure leaves nothing behind.
    fn plan(
        revision: &Value,
        source: &str,
        overrides: &Value,
        timeout_ms: u64,
    ) -> CoreResult<Self> {
        let mut effective = recorded_params(revision);
        let variant = overrides.as_object().is_some_and(|map| !map.is_empty());
        effective.extend(overrides.as_object().cloned().unwrap_or_default());
        let request = render::Request::new(source, &Value::Object(effective), timeout_ms);
        if !variant && render_matches(revision) {
            if let Some(hash) = revision["payload"]["stl"]["sha256"].as_str() {
                return Ok(Self::Stored {
                    hash: hash.to_owned(),
                    identity: revision["payload"]["renderIdentity"].clone(),
                    fallback: request,
                });
            }
        }
        params::assert_self_contained(source)?;
        Ok(Self::Render {
            request,
            job_id: String::new(),
        })
    }

    /// Open the render job, when this source needs the engine.
    fn open(
        &mut self,
        handle: &ProjectHandle,
        revision: &Value,
        origin: &Origin,
    ) -> CoreResult<()> {
        if let Self::Render { request, job_id } = self {
            *job_id = jobs::start(
                handle,
                "cad_render",
                "openscad",
                &json!({"artifactId": revision["artifactId"], "revisionId": revision["id"], "params": request.params}),
                &json!({"source": request.source_hash}),
                origin,
            )?;
        }
        Ok(())
    }

    fn job_id(&self) -> Option<&str> {
        match self {
            Self::Stored { .. } => None,
            Self::Render { job_id, .. } => Some(job_id),
        }
    }

    fn resolve(&self, workspace: &Workspace<'_>) -> CoreResult<render::Rendered> {
        match self {
            Self::Stored {
                hash,
                identity,
                fallback,
            } => match render::stored_mesh(workspace, hash) {
                Ok(mesh) => Ok(render::Rendered::stored(mesh, identity)),
                Err(_) => render::render(workspace, fallback, ""),
            },
            Self::Render { request, job_id } => render::render(workspace, request, job_id),
        }
    }

    fn close(
        &self,
        handle: &ProjectHandle,
        rendered: &render::Rendered,
        origin: &Origin,
    ) -> CoreResult<()> {
        match self.job_id() {
            Some(job_id) => close_render_job(handle, job_id, rendered, origin),
            None => Ok(()),
        }
    }
}

struct InspectPipeline {
    artifact: Value,
    revision: Value,
    source_path: String,
    parameters: Vec<Value>,
    has_parameters: bool,
    mesh: MeshSource,
    sections: Vec<Value>,
    probes: Vec<Value>,
    brief: bool,
    executable: Option<PathBuf>,
    outcome: Option<CoreResult<(render::Rendered, Option<report::Details>)>>,
}

impl Pipeline for InspectPipeline {
    fn op(&self) -> &'static str {
        "cad.inspect"
    }

    fn executable(&self) -> Option<PathBuf> {
        self.executable.clone()
    }

    fn job_ids(&self) -> Vec<String> {
        self.mesh.job_id().map(str::to_owned).into_iter().collect()
    }

    fn compute(&mut self, workspace: &Workspace<'_>) {
        self.outcome = Some((|| {
            let rendered = self.mesh.resolve(workspace)?;
            let details = match &rendered.mesh {
                Some(mesh) => Some(report::details(
                    mesh,
                    self.has_parameters,
                    &self.sections,
                    &self.probes,
                    workspace.cancelled,
                )?),
                None => None,
            };
            Ok((rendered, details))
        })());
    }

    fn commit(mut self: Box<Self>, handle: &ProjectHandle, origin: &Origin) -> CoreResult<Value> {
        let (rendered, details) = match self.outcome.take() {
            Some(Ok(outcome)) => outcome,
            Some(Err(error)) => {
                abandon(handle, &self.job_ids(), &error, origin);
                return Err(error);
            }
            None => return Err(internal_stage()),
        };
        self.mesh.close(handle, &rendered, origin)?;
        let Some(details) = details else {
            return Err(render_failed("inspect", &rendered));
        };
        let size = &details.geometry["bounds"]["size"];
        let formatted = |index: usize| format!("{} mm", size[index].as_f64().unwrap_or(0.0));
        let mut notes = details.notes;
        if rendered.source_inverted {
            notes.insert(0, "NOT VERIFIED: the source produces inside-out geometry; the mesh was turned outward for display only.".to_owned());
        }
        let mut report = json!({"artifactId":self.artifact["id"],"revisionId":self.revision["id"],"title":self.artifact["title"],
            "sourcePath":self.source_path,"render":rendered.summary(),
            "geometry":details.geometry,"sections":details.sections,"probes":details.probes,"parameters":self.parameters,"notes":notes,
            "nextAction":"commit_assertions",
            "nextStep":{"tool":"cad_check","why":"Inspecting is diagnostic; verification needs cad_check with assertions from the request.","args":{"artifactId":self.artifact["id"]}},
            "next":"Inspect is diagnostic only and does not bind request assertions. Use the sections and probes to confirm each requested feature; then call cad_check with expectations taken from the request.",
            "inspect":{"plausible":true,"triangles":details.geometry["triangles"]},"modelUnit":"mm",
            "dimensions":{"x":formatted(0),"y":formatted(1),"z":formatted(2)}});
        if !details.not_evaluated.is_empty() {
            report["limits"] = json!({"triangles": report["geometry"]["triangles"], "maxTriangles": mesh::MAX_TRIANGLES, "notEvaluated": details.not_evaluated});
        }
        Ok(if self.brief {
            report::brief("cad.inspect", &report)
        } else {
            report
        })
    }
}

pub(super) fn inspect(handle: &ProjectHandle, input: &Value, origin: &Origin) -> CoreResult<Value> {
    stage::drive(handle, origin, "cad.inspect", || {
        let artifact = require_mechanical(handle, required_str(input, "artifactId")?)?;
        let revision = pick_revision(handle, &artifact, input["revisionId"].as_str())?;
        let (source_path, source) = source_of(handle, &revision)?;
        let declared = params::parameters(&source);
        let overrides = params::override_params(&input["params"], &declared)?;
        let mut shown = recorded_params(&revision);
        shown.extend(overrides.as_object().cloned().unwrap_or_default());
        let list = |key: &str| input[key].as_array().cloned().unwrap_or_default();
        let mut mesh = MeshSource::plan(&revision, &source, &overrides, render::timeout_ms(input))?;
        mesh.open(handle, &revision, origin)?;
        Ok(Box::new(InspectPipeline {
            mesh,
            parameters: effective_parameters(&source, &Value::Object(shown)),
            has_parameters: !declared.is_empty(),
            artifact,
            revision,
            source_path,
            sections: list("sections"),
            probes: list("probes"),
            brief: wants_brief(input),
            executable: configured_executable(),
            outcome: None,
        }))
    })
}

/// The revision a modification is compared against: the baseline this
/// draft lineage started from, not the most recent rewritten draft, which
/// would let a repeated bad edit certify itself.
fn preservation_reference(
    handle: &ProjectHandle,
    artifact: &Value,
    revision: &Value,
) -> CoreResult<Option<Value>> {
    let mut parent_id = revision["parentId"].as_str().map(str::to_owned);
    let mut seen = HashSet::new();
    while let Some(id) = parent_id {
        if !seen.insert(id.clone()) {
            return Err(ContractError::validation(
                "Revision ancestry contains a cycle",
            ));
        }
        let ancestor = require_revision(handle, &id)?;
        if ancestor["id"] == artifact["selectedRevisionId"]
            || matches!(
                ancestor["reviewState"].as_str(),
                Some("approved" | "superseded")
            )
            || ancestor["parentId"].is_null()
        {
            return Ok(Some(ancestor));
        }
        parent_id = ancestor["parentId"].as_str().map(str::to_owned);
    }
    Ok(None)
}

fn ancestors(handle: &ProjectHandle, revision: &Value) -> CoreResult<HashSet<String>> {
    let mut seen = HashSet::new();
    let mut parent_id = revision["parentId"].as_str().map(str::to_owned);
    while let Some(id) = parent_id {
        if !seen.insert(id.clone()) {
            break;
        }
        parent_id = get_revision(handle, &id)?
            .and_then(|ancestor| ancestor["parentId"].as_str().map(str::to_owned));
    }
    Ok(seen)
}

struct CheckOutcome {
    rendered: render::Rendered,
    lines: Vec<Value>,
    preservation: Value,
    /// The reference render, when one was needed, so its job can be closed.
    reference: Option<render::Rendered>,
}

struct CheckPipeline {
    artifact: Value,
    revision: Value,
    /// The revision was picked as the newest one rather than named.
    implicit: bool,
    params: Value,
    variant: bool,
    normalized: expect::Normalized,
    /// Requirements linked to the part or named by the check.
    linked: Vec<spec::Linked>,
    /// Repairs and acceptances of the spec input, for the reply.
    notes: Vec<String>,
    requirement_ids: Value,
    mode: verification::Mode,
    context: checks::Context,
    mesh: MeshSource,
    /// `None`: no preservation asserted. `Some(None)`: asserted, but the part
    /// has no earlier revision to compare with.
    reference: Option<Option<(Value, MeshSource)>>,
    job_id: String,
    brief: bool,
    executable: Option<PathBuf>,
    outcome: Option<CoreResult<CheckOutcome>>,
}

impl CheckPipeline {
    fn measure(&self, workspace: &Workspace<'_>) -> CoreResult<CheckOutcome> {
        let rendered = self.mesh.resolve(workspace)?;
        let Some(mesh) = rendered.mesh.clone() else {
            return Ok(CheckOutcome {
                rendered,
                lines: vec![],
                preservation: Value::Null,
                reference: None,
            });
        };
        let expect = &self.normalized.expect;
        let mut lines = checks::run(&mesh, expect, self.context)?;
        let mut preservation = Value::Null;
        let mut reference_render = None;
        if let Some(reference) = &self.reference {
            let regions = expect["preserve"]["changeRegions"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let missing = |detail: String| json!({"name": "unrelated geometry preserved", "pass": false, "detail": detail});
            match reference {
                None => lines.push(missing("No prior baseline/reference revision exists; preservation cannot be established for a newly created part.".into())),
                Some((reference, source)) => {
                    if (workspace.cancelled)() {
                        return Err(ContractError::new("CANCELLED", "Check was cancelled"));
                    }
                    let resolved = source.resolve(workspace)?;
                    match (&resolved.mesh, &resolved.identity) {
                        (Some(reference_mesh), Some(identity)) => {
                            let mut line = checks::preservation(reference_mesh, &mesh, regions)?;
                            line["detail"] = json!(format!(
                                "Compared with baseline/reference revision {}: {}",
                                reference["id"].as_str().unwrap_or(""),
                                line["detail"].as_str().unwrap_or("")
                            ));
                            lines.push(line);
                            preservation = json!({"revisionId": reference["id"],
                                "inputFingerprint": identity["inputFingerprint"], "outputHash": identity["outputHash"]});
                        }
                        _ => lines.push(missing(format!(
                            "Reference revision {} cannot render: {}. Repair the reference explicitly; repeating the modified source does not create a preservation reference.",
                            reference["id"].as_str().unwrap_or(""),
                            resolved.first_error()
                        ))),
                    }
                    reference_render = Some(resolved);
                }
            }
        }
        if rendered.source_inverted {
            lines.push(json!({"name":"source winding","pass":false,"detail":"OpenSCAD source produces an inside-out mesh. Turning the stored mesh outward for display is not a source repair: reverse the polyhedron face order (clockwise seen from outside), save, and repeat the same assertions."}));
        }
        Ok(CheckOutcome {
            rendered,
            lines,
            preservation,
            reference: reference_render,
        })
    }

    fn commit_outcome(
        &self,
        handle: &ProjectHandle,
        outcome: &CheckOutcome,
        origin: &Origin,
    ) -> CoreResult<Value> {
        let artifact_id = required_str(&self.artifact, "id")?;
        self.mesh.close(handle, &outcome.rendered, origin)?;
        if let (Some(Some((_, source))), Some(reference)) = (&self.reference, &outcome.reference) {
            source.close(handle, reference, origin)?;
        }
        let (Some(mesh), Some(identity)) = (&outcome.rendered.mesh, &outcome.rendered.identity)
        else {
            return Err(render_failed("check", &outcome.rendered));
        };
        if jobs::cancelled(&handle.db, std::slice::from_ref(&self.job_id)) {
            return Err(ContractError::new("CANCELLED", "Check was cancelled"));
        }
        if self.implicit {
            let current = pick_revision(handle, &require_artifact(handle, artifact_id)?, None)?;
            if current["id"] != self.revision["id"] {
                return Err(input_changed(
                    &self.artifact,
                    self.revision["id"].as_str().unwrap_or(""),
                    current["id"].as_str().unwrap_or(""),
                ));
            }
        }
        let payload_identity = &self.revision["payload"]["renderIdentity"];
        let expect = &self.normalized.expect;
        let mut report = spec::assess(
            expect,
            &self.linked,
            &outcome.lines,
            spec::listed_by(origin),
        )?;
        let measured = verification::Measured {
            lines: outcome.lines.clone(),
            integrity: mesh.watertight
                && !mesh.inverted
                && !outcome.rendered.source_inverted
                && mesh.volume > 0.0,
            matching: render_matches(&self.revision)
                && payload_identity["inputFingerprint"] == identity["inputFingerprint"]
                && payload_identity["outputHash"] == identity["outputHash"],
            unasserted: report
                .as_ref()
                .and_then(|report| report["counts"]["blocking"].as_u64())
                .unwrap_or(0) as usize,
        };
        let mut judgement = verification::judge(
            &measured,
            expect,
            &self.params,
            self.mode,
            self.variant,
            &self.revision,
            &ancestors(handle, &self.revision)?,
            &verification::accepted_scope(handle, artifact_id)?,
            &verification::history(handle, artifact_id)?,
        );
        // What restores the committed scope is that scope as the linked
        // requirements state it now.
        judgement.committed = spec::restore(&judgement.priors, &self.linked);
        if let Some(report) = report
            .as_mut()
            .filter(|_| !judgement.scope_changes.is_empty())
        {
            let attribution = spec::attribute(
                handle,
                &judgement.priors,
                expect,
                &self.linked,
                &judgement.dropped,
            );
            if !attribution.replaced.is_empty() {
                report["replaced"] = json!(attribution.replaced);
                report["checkChanges"] = json!(attribution.own);
            }
        }
        let evidence = verification::evidence(
            &self.artifact,
            &self.revision,
            identity,
            expect,
            &measured.lines,
            &outcome.preservation,
            measured.integrity,
            &judgement,
            report.as_ref(),
        );
        let evidence_hash = handle
            .object_store()
            .map_err(storage_error)?
            .put(&serde_json::to_vec(&evidence).map_err(internal)?)
            .map_err(storage_error)?;
        let mut log = measured
            .lines
            .iter()
            .map(|line| {
                format!(
                    "{} {} — {}",
                    if line["pass"] == true { "PASS" } else { "FAIL" },
                    line["name"].as_str().unwrap_or("check"),
                    line["detail"].as_str().unwrap_or("")
                )
            })
            .collect::<Vec<_>>();
        if !judgement.dropped.is_empty() {
            log.push(format!(
                "WEAKENED: dropped previously failing assertions on unchanged geometry: {}",
                judgement.dropped.join("; ")
            ));
        }
        if !judgement.loosened.is_empty() {
            log.push(format!(
                "WEAKENED: loosened tolerance on assertions that previously failed: {}",
                judgement.loosened.join("; ")
            ));
        }
        let failing = measured.lines.len() - judgement.passed;
        let commit_order = verification::next_commit_order(handle, artifact_id)?;
        jobs::finish(
            handle,
            &self.job_id,
            if judgement.pass {
                "succeeded"
            } else {
                "failed"
            },
            jobs::Finish {
                tool_version: Some(verification::CHECKER.to_owned()),
                log: log.join("\n"),
                output_hashes: json!({"verification": evidence_hash}),
                error: (!judgement.pass).then(|| {
                    ContractError::validation(format!(
                        "{failing} of {} checks failed",
                        measured.lines.len()
                    ))
                }),
                inputs: Some({
                    let mut inputs = json!({"artifactId": artifact_id, "revisionId": self.revision["id"],
                    "params": self.params, "expect": expect, "preservation": outcome.preservation,
                    "exploratory": judgement.exploratory, "commitOrder": commit_order,
                    "results": measured.lines.iter().map(|line| json!({"name": line["name"], "pass": line["pass"], "tightness": line["tightness"]})).collect::<Vec<_>>()});
                    if !self.requirement_ids.is_null() {
                        inputs["requirementIds"] = self.requirement_ids.clone();
                    }
                    inputs
                }),
                command: None,
            },
            origin,
        )?;
        let response = verification::response(
            handle,
            &self.artifact,
            &self.revision,
            &evidence,
            &evidence_hash,
            &judgement,
            self.mode,
            self.variant,
            &self.normalized,
            self.normalized.ignored.clone(),
        )?;
        let response = if self.notes.is_empty() {
            response
        } else {
            let mut response = response;
            response["notes"] = json!(self.notes);
            response
        };
        Ok(if self.brief {
            report::brief("cad.check", &response)
        } else {
            response
        })
    }
}

impl Pipeline for CheckPipeline {
    fn op(&self) -> &'static str {
        "cad.check"
    }

    fn executable(&self) -> Option<PathBuf> {
        self.executable.clone()
    }

    fn job_ids(&self) -> Vec<String> {
        let mut ids = vec![self.job_id.clone()];
        ids.extend(self.mesh.job_id().map(str::to_owned));
        if let Some(Some((_, source))) = &self.reference {
            ids.extend(source.job_id().map(str::to_owned));
        }
        ids
    }

    fn compute(&mut self, workspace: &Workspace<'_>) {
        self.outcome = Some(self.measure(workspace));
    }

    fn commit(mut self: Box<Self>, handle: &ProjectHandle, origin: &Origin) -> CoreResult<Value> {
        let result = match self.outcome.take() {
            Some(Ok(outcome)) => self.commit_outcome(handle, &outcome, origin),
            Some(Err(error)) => Err(error),
            None => Err(internal_stage()),
        };
        if let Err(error) = &result {
            abandon(handle, &self.job_ids(), error, origin);
        }
        result
    }
}

pub(super) fn check(handle: &ProjectHandle, input: &Value, origin: &Origin) -> CoreResult<Value> {
    stage::drive(handle, origin, "cad.check", || {
        let artifact = require_mechanical(handle, required_str(input, "artifactId")?)?;
        let revision = pick_revision(handle, &artifact, input["revisionId"].as_str())?;
        let (_, source) = source_of(handle, &revision)?;
        let overrides = params::override_params(&input["params"], &params::parameters(&source))?;
        let variant = overrides.as_object().is_some_and(|map| !map.is_empty());
        // Items are checked strictly and linked requirements add theirs
        // before the expectation is canonical, hashed or measured.
        let (expect_input, mut notes) = spec::checked_items(&input["expect"])?;
        let (linked, accepted) = spec::for_check(handle, &revision, input, &expect_input, origin)?;
        notes.extend(accepted);
        let mut normalized = expect::normalize_with(&expect_input, &spec::derived(&linked))?;
        let mode = if input["exploratory"] == true {
            verification::Mode::Trial
        } else if input["autoCommit"] == true {
            verification::Mode::AutoCommit
        } else {
            verification::Mode::Commit
        };
        if input["exploratory"] == true && input["autoCommit"] == true {
            normalized.ignored.push(
                "autoCommit: exploratory true asks for a trial, so nothing was committed"
                    .to_owned(),
            );
        }
        let timeout_ms = render::timeout_ms(input);
        let mut reference = if normalized.expect["preserve"]["changeRegions"].is_array() {
            Some(
                preservation_reference(handle, &artifact, &revision)?
                    .map(|reference| {
                        let (_, reference_source) = source_of(handle, &reference)?;
                        let source = MeshSource::plan(
                            &reference,
                            &reference_source,
                            &Value::Null,
                            timeout_ms,
                        )?;
                        Ok::<_, ContractError>((reference, source))
                    })
                    .transpose()?,
            )
        } else {
            None
        };
        let mut mesh = MeshSource::plan(&revision, &source, &overrides, timeout_ms)?;
        if let Some(Some((reference, source))) = &mut reference {
            source.open(handle, reference, origin)?;
        }
        mesh.open(handle, &revision, origin)?;
        let job_id = jobs::start(
            handle,
            "cad_check",
            "omenflow-geometry",
            &json!({"artifactId": artifact["id"], "revisionId": revision["id"], "params": overrides,
                "expect": normalized.expect, "exploratory": mode == verification::Mode::Trial || variant}),
            &json!({"stl": revision["payload"]["stl"]["sha256"]}),
            origin,
        )?;
        Ok(Box::new(CheckPipeline {
            implicit: input["revisionId"].as_str().is_none(),
            context: checks::Context {
                curved_source: params::uses_curved_primitives(&source),
            },
            artifact,
            revision,
            params: overrides,
            variant,
            normalized,
            linked,
            notes,
            requirement_ids: input["requirementIds"].clone(),
            mode,
            mesh,
            reference,
            job_id,
            brief: wants_brief(input),
            executable: configured_executable(),
            outcome: None,
        }))
    })
}

struct ValidatePipeline {
    source: String,
    executable: Option<PathBuf>,
    outcome: Option<CoreResult<Value>>,
}

impl Pipeline for ValidatePipeline {
    fn op(&self) -> &'static str {
        "cad.validate_source"
    }

    fn executable(&self) -> Option<PathBuf> {
        self.executable.clone()
    }

    fn job_ids(&self) -> Vec<String> {
        vec![]
    }

    fn compute(&mut self, workspace: &Workspace<'_>) {
        self.outcome = Some((|| {
            let engine = engine::engine(workspace.executable.as_deref())?;
            let temp = tempfile::tempdir().map_err(internal)?;
            let scad = temp.path().join("source.scad");
            let csg = temp.path().join("output.csg");
            fs::write(&scad, &self.source).map_err(internal)?;
            let run = engine::run(
                &engine.exe,
                &[
                    "-o".into(),
                    csg.to_string_lossy().into(),
                    scad.to_string_lossy().into(),
                ],
                std::time::Duration::from_secs(30),
                temp.path(),
                workspace.cancelled,
            )?;
            let (warnings, mut errors) = engine::classify(&run.log);
            if run.timed_out {
                errors.push("Validation exceeded 30000 ms".into());
            }
            if errors.is_empty() && !run.ok {
                errors = run.log.lines().map(str::to_owned).collect();
            }
            Ok(json!({"ok": run.ok && errors.is_empty(), "errors": errors,
                "hints": engine::hints(&warnings, &errors, &self.source)}))
        })());
    }

    fn commit(mut self: Box<Self>, _handle: &ProjectHandle, _origin: &Origin) -> CoreResult<Value> {
        self.outcome.take().unwrap_or_else(|| Err(internal_stage()))
    }
}

pub(super) fn validate_source(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    stage::drive(handle, &Origin::System, "cad.validate_source", || {
        let artifact = require_mechanical(handle, required_str(input, "artifactId")?)?;
        let revision = pick_revision(handle, &artifact, input["revisionId"].as_str())?;
        let (_, source) = source_of(handle, &revision)?;
        params::assert_self_contained(&source)?;
        Ok(Box::new(ValidatePipeline {
            source,
            executable: configured_executable(),
            outcome: None,
        }))
    })
}

#[cfg(test)]
pub(crate) mod testing;
#[cfg(test)]
mod tests;
