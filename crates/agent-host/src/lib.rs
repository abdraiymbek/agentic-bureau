//! Local, capability-scoped v1 bridge for the shipped `omenflow` Rust CLI.
//! Each connection is authenticated before it may dispatch an operation or
//! expose MCP tools. Revocation is checked again on every request.
//!
//! Every agent call, over MCP or `omenflow call`, goes through one function,
//! `dispatch_agent`: it resolves the name, enforces the capability, repairs
//! and validates the input, runs the operation, shapes the result for the
//! session's capability profile and records the call in the ledger.

mod adapters;
mod chat;
mod guide;
mod ledger;
mod mcp;
mod present;
mod profile;
mod pty;
mod session;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod weak_client_tests;

pub use adapters::{
    adapter, AdapterConfig, AdapterSpec, GuideChannel, McpInjection, ModelAlias, ModelAliases,
    Probe, Routing, RoutingLookup, SearchPath, Version, ADAPTERS,
};
pub use guide::read as guide_read;
pub use ledger::{AgentCallRecord, AgentSessionSummary, Via};
pub use omenflow_core::child_env;
pub use profile::{
    profile_for_model, resolve_profile, ProfileSetting, ProfileSource, ResolvedProfile,
};
pub use pty::{PtyHost, TerminalEvent};
pub use session::{plan_launch, work_dir, LaunchMode, LaunchPlan, LaunchRequest, PlannedFile};

use chrono::{SecondsFormat, Utc};
#[cfg(windows)]
use interprocess::local_socket::GenericNamespaced;
use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions, Stream};
use ledger::{CallOutcome, Ledger};
use omenflow_contracts::{
    parse_agent_input, read_frame, registry, write_frame, AgentInput, ContractError, Operation,
    Profile, ResponseEnvelope,
};
use omenflow_core::{dispatch_shared_with_events, CoreApp, Origin};
use rand::random;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use std::time::Instant;

/// What a session token stands for: one project, one session, and the
/// capability profile the session was launched with. The profile is fixed
/// for the life of the session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grant {
    pub project_id: String,
    pub session_id: String,
    pub profile: Profile,
    pub adapter_id: String,
    pub model: Option<String>,
}

impl Grant {
    /// A grant for a caller that is not one of the hosted CLIs, such as a
    /// connection test: the standard profile and no model.
    pub fn new(project_id: &str, session_id: &str) -> Self {
        Self {
            project_id: project_id.to_owned(),
            session_id: session_id.to_owned(),
            profile: Profile::default(),
            adapter_id: DIRECT_ADAPTER.to_owned(),
            model: None,
        }
    }
}

/// Adapter id recorded for a grant issued without a hosted CLI.
pub const DIRECT_ADAPTER: &str = "direct";

type HostDispatch = Arc<
    dyn Fn(String, Value, Origin, String, Option<String>) -> Result<Value, ContractError>
        + Send
        + Sync,
>;

type CallHook = Arc<dyn Fn(Value) + Send + Sync>;
type SessionWatch = Arc<dyn Fn(&str, &str) + Send + Sync>;

struct Shared {
    core: Arc<Mutex<CoreApp>>,
    grants: Mutex<HashMap<String, Grant>>,
    stopped: AtomicBool,
    on_event: Arc<dyn Fn(Value) + Send + Sync>,
    host_dispatch: Option<HostDispatch>,
    ledger: Ledger,
    on_call: RwLock<Option<CallHook>>,
    session_watch: RwLock<Option<SessionWatch>>,
    /// Sessions with a `proposal.wait` in flight, and how many.
    waiting: Mutex<HashMap<String, usize>>,
}

/// What a session has done so far, as the ledger and the bridge see it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SessionActivity {
    pub calls: u64,
    pub errors: u64,
    /// True while the session waits for the human to resolve a proposal.
    pub waiting_for_review: bool,
}

pub struct BridgeServer {
    path: String,
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl BridgeServer {
    pub fn start(core: Arc<Mutex<CoreApp>>, app_data_dir: &Path) -> io::Result<Self> {
        Self::start_with_events(core, app_data_dir, Arc::new(|_| {}))
    }

    pub fn start_with_events(
        core: Arc<Mutex<CoreApp>>,
        app_data_dir: &Path,
        on_event: Arc<dyn Fn(Value) + Send + Sync>,
    ) -> io::Result<Self> {
        Self::start_with_host(core, app_data_dir, on_event, None)
    }

    pub fn start_with_host(
        core: Arc<Mutex<CoreApp>>,
        app_data_dir: &Path,
        on_event: Arc<dyn Fn(Value) + Send + Sync>,
        host_dispatch: Option<HostDispatch>,
    ) -> io::Result<Self> {
        let path = socket_path(&absolute_dir(app_data_dir)?);
        #[cfg(unix)]
        {
            let socket = Path::new(&path);
            fs::create_dir_all(socket.parent().expect("bridge parent"))?;
            fs::set_permissions(socket.parent().unwrap(), fs::Permissions::from_mode(0o700))?;
            // ListenerOptions can replace a corpse socket after a crash.
        }
        let name = socket_name(&path)?;
        let listener = ListenerOptions::new()
            .name(name)
            .try_overwrite(true)
            .create_sync()?;
        #[cfg(unix)]
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
        let shared = Arc::new(Shared {
            core,
            grants: Mutex::new(HashMap::new()),
            stopped: AtomicBool::new(false),
            on_event,
            host_dispatch,
            ledger: Ledger::default(),
            on_call: RwLock::new(None),
            session_watch: RwLock::new(None),
            waiting: Mutex::new(HashMap::new()),
        });
        let inner = Arc::clone(&shared);
        let thread = thread::spawn(move || {
            for incoming in listener.incoming() {
                if inner.stopped.load(Ordering::SeqCst) {
                    break;
                }
                if let Ok(stream) = incoming {
                    let inner = Arc::clone(&inner);
                    thread::spawn(move || handle_connection(stream, inner));
                }
            }
        });
        Ok(Self {
            path,
            shared,
            thread: Some(thread),
        })
    }

    pub fn socket_path(&self) -> &str {
        &self.path
    }

    /// Issue a token for a caller that is not a hosted CLI. Sessions started
    /// for a CLI use `issue_grant`, which carries their profile.
    pub fn issue_token(&self, project_id: &str, session_id: &str) -> String {
        self.issue_grant(Grant::new(project_id, session_id))
    }

    /// Issue the token for a session. Any earlier grant of the same session
    /// is revoked first.
    pub fn issue_grant(&self, grant: Grant) -> String {
        self.revoke(&grant.session_id);
        let bytes: [u8; 24] = random();
        let token: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        self.shared.ledger.begin_session(
            &grant.project_id,
            &grant.session_id,
            &grant.adapter_id,
            grant.model.as_deref(),
            grant.profile,
        );
        self.shared
            .grants
            .lock()
            .expect("grants lock")
            .insert(token.clone(), grant);
        token
    }

    pub fn revoke(&self, session_id: &str) {
        self.shared
            .grants
            .lock()
            .expect("grants lock")
            .retain(|_, grant| grant.session_id != session_id);
        self.shared.ledger.end_session(session_id);
    }

    /// Receive every agent call as it is recorded: one `AgentCallRecord` per
    /// call, for the host channel `omenflow:agent:call`. Replaces any hook
    /// set before. The hook runs on the connection's thread after the
    /// application lock is released; it must not block.
    pub fn set_on_call(&self, hook: Arc<dyn Fn(Value) + Send + Sync>) {
        *self
            .shared
            .on_call
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(hook);
    }

    /// The `agent.activity` result for a project. `input` is the operation's
    /// input: `limit` (default 100, at most 500), `sessionId`, `beforeSeq`.
    /// Call it without holding the application lock.
    pub fn agent_activity(&self, project_id: &str, input: &Value) -> Result<Value, ContractError> {
        attach_ledger(&self.shared, project_id);
        let limit = match input.get("limit") {
            None | Some(Value::Null) => ledger::DEFAULT_ACTIVITY_LIMIT,
            Some(limit) => limit
                .as_u64()
                .filter(|limit| (1..=ledger::MAX_ACTIVITY_LIMIT as u64).contains(limit))
                .ok_or_else(|| {
                    ContractError::validation(format!(
                        "limit must be a whole number from 1 to {}",
                        ledger::MAX_ACTIVITY_LIMIT
                    ))
                })? as usize,
        };
        Ok(self.shared.ledger.activity(
            project_id,
            limit,
            input["sessionId"].as_str(),
            input["beforeSeq"].as_u64(),
        ))
    }

    /// Calls, failed calls and review state of one session, live.
    pub fn session_activity(&self, session_id: &str) -> SessionActivity {
        let (calls, errors) = self.shared.ledger.counters(session_id);
        let waiting_for_review = self
            .shared
            .waiting
            .lock()
            .is_ok_and(|waiting| waiting.contains_key(session_id));
        SessionActivity {
            calls,
            errors,
            waiting_for_review,
        }
    }

    /// Tell the ledger where a project lives before its session starts, so
    /// earlier history is loaded and records reach the project's sidecar.
    pub(crate) fn attach_project(&self, project_id: &str, root: &Path) {
        self.shared.ledger.attach_project(project_id, root);
    }

    /// Be told `(project_id, session_id)` whenever a session's activity
    /// changes: a call was recorded, or a wait for review began or ended.
    pub(crate) fn watch_sessions(&self, watch: SessionWatch) {
        *self
            .shared
            .session_watch
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(watch);
    }
}

impl Drop for BridgeServer {
    fn drop(&mut self) {
        self.shared.stopped.store(true, Ordering::SeqCst);
        self.shared.grants.lock().expect("grants lock").clear();
        // Wake a blocking accept, then join before unlinking the endpoint.
        // If the endpoint is already gone the accept cannot be woken; the
        // thread is then left to end with the process rather than joined.
        let woken = socket_name(&self.path).is_ok_and(|name| Stream::connect(name).is_ok());
        if let (true, Some(thread)) = (woken, self.thread.take()) {
            let _ = thread.join();
        }
        #[cfg(unix)]
        let _ = fs::remove_file(&self.path);
    }
}

/// A folder handed to agent sessions, which run in their project's folder:
/// as given when it is absolute, otherwise created and resolved against this
/// process's working directory, so no child reads it from somewhere else.
pub(crate) fn absolute_dir(dir: &Path) -> io::Result<PathBuf> {
    if dir.is_absolute() {
        return Ok(dir.to_owned());
    }
    fs::create_dir_all(dir)?;
    fs::canonicalize(dir)
}

fn socket_path(app_data_dir: &Path) -> String {
    #[cfg(unix)]
    {
        app_data_dir
            .join("run/bridge.sock")
            .to_string_lossy()
            .into()
    }
    #[cfg(windows)]
    {
        let user = std::env::var("USERNAME").unwrap_or_else(|_| "user".into());
        pipe_name(&user, app_data_dir)
    }
}

/// The bridge pipe of one data folder. Named pipes share one namespace per
/// machine, so the name carries the user and a digest of the folder: hosts
/// with different data folders (an isolated run beside the installed app,
/// test hosts running in parallel) each get their own, as each gets its own
/// socket on Unix.
#[cfg(any(windows, test))]
fn pipe_name(user: &str, app_data_dir: &Path) -> String {
    // FNV-1a: stable across builds; this is a name, not a secret. Windows
    // paths do not tell case apart, so neither does the digest.
    let mut digest: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in app_data_dir.to_string_lossy().to_lowercase().bytes() {
        digest ^= u64::from(byte);
        digest = digest.wrapping_mul(0x0100_0000_01b3);
    }
    format!(r"\\.\pipe\omenflow-{user}-{digest:016x}")
}

fn socket_name(path: &str) -> io::Result<interprocess::local_socket::Name<'_>> {
    #[cfg(unix)]
    {
        path.to_fs_name::<GenericFilePath>()
    }
    #[cfg(windows)]
    {
        path.strip_prefix(r"\\.\pipe\")
            .unwrap_or(path)
            .to_ns_name::<GenericNamespaced>()
    }
}

pub(crate) fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn handle_connection(mut stream: Stream, shared: Arc<Shared>) {
    let _ = stream.set_recv_timeout(Some(Duration::from_secs(10)));
    let hello = match read_frame(&mut stream) {
        Ok(Some(value)) => value,
        _ => return,
    };
    if hello["type"] != "hello"
        || hello["token"].as_str().is_none_or(str::is_empty)
        || !matches!(hello["mode"].as_str(), Some("call" | "mcp"))
    {
        let _ = write_frame(
            &mut stream,
            &json!({"type": "error", "error": {"code": "VALIDATION", "message": "First frame must be a bridge hello"}}),
        );
        return;
    }
    if hello["protocolVersion"] != registry().protocol_version {
        let _ = write_frame(
            &mut stream,
            &json!({"type": "error", "error": {"code": "PROTOCOL_MISMATCH", "message": format!("Protocol version {} != {}", hello["protocolVersion"], registry().protocol_version)}}),
        );
        return;
    }
    let token = hello["token"].as_str().unwrap().to_owned();
    let Some(grant) = current_grant(&shared, &token) else {
        let _ = write_frame(
            &mut stream,
            &json!({"type": "error", "error": {"code": "CONNECTION_DENIED", "message": "Unknown or revoked bridge token"}}),
        );
        return;
    };
    let agent_ops = registry()
        .agent_operations()
        .map(|operation| operation.name.as_str())
        .collect::<Vec<_>>();
    if write_frame(&mut stream, &json!({"type": "welcome", "protocolVersion": registry().protocol_version, "projectId": grant.project_id, "sessionId": grant.session_id, "profile": grant.profile, "agentOps": agent_ops})).is_err() {
        return;
    }
    let _ = stream.set_recv_timeout(None);
    if hello["mode"] == "mcp" {
        mcp::serve(&mut stream, &shared, &token);
    } else {
        serve_calls(&mut stream, &shared, &token);
    }
}

fn current_grant(shared: &Shared, token: &str) -> Option<Grant> {
    if shared.stopped.load(Ordering::SeqCst) {
        return None;
    }
    shared.grants.lock().ok()?.get(token).cloned()
}

/// One call from an agent, as it arrived.
struct AgentCall<'a> {
    /// Tool or operation name as the agent wrote it.
    name: &'a str,
    payload: Value,
    idempotency_key: Option<&'a str>,
    via: Via,
}

/// What a finished call hands back to its transport.
struct AgentReply {
    /// The result shaped for the session's profile, with any `notes`; or the
    /// error, with the notes of repairs already applied in its details.
    result: Result<Value, ContractError>,
    profile: Profile,
}

/// What `run_agent_call` learns about a call on the way, kept for the
/// ledger whether the call succeeds or not.
struct CallTrace {
    op: String,
    mutating: bool,
    /// The arguments of the operation that ran; scanned for artifact ids and
    /// then dropped. Never stored.
    input: Value,
    notes: Vec<String>,
}

/// The single funnel for agent calls. A call that reaches it with a valid
/// grant is always recorded.
fn dispatch_agent(
    shared: &Shared,
    token: &str,
    call: AgentCall<'_>,
) -> Result<AgentReply, ContractError> {
    let grant = current_grant(shared, token).ok_or_else(|| {
        ContractError::new("CONNECTION_DENIED", "Agent session grant was revoked")
    })?;
    attach_ledger(shared, &grant.project_id);
    let started = Instant::now();
    let mut trace = CallTrace {
        op: call.name.to_owned(),
        mutating: false,
        input: Value::Null,
        notes: Vec::new(),
    };
    let via = call.via;
    let tool = call.name.to_owned();
    let mut result = run_agent_call(shared, &grant, call, &mut trace);
    let artifact_ids = ledger::artifact_ids(&trace.input, result.as_ref().ok());
    let record = shared.ledger.record(CallOutcome {
        project_id: grant.project_id.clone(),
        session_id: grant.session_id.clone(),
        tool,
        op: trace.op,
        via,
        ok: result.is_ok(),
        code: result.as_ref().err().map(|error| error.code.clone()),
        message: result.as_ref().err().map(ledger::stored_message),
        duration_ms: started.elapsed().as_millis() as u64,
        mutating: trace.mutating,
        artifact_ids,
        notes: trace.notes.clone(),
    });
    publish(shared, &record);
    result = match result {
        Ok(value) => Ok(present::with_notes(value, &trace.notes)),
        Err(mut error) => {
            if !trace.notes.is_empty() {
                let mut details = error
                    .details
                    .take()
                    .map_or_else(|| json!({}), |boxed| *boxed);
                details["notes"] = json!(trace.notes);
                error = error.with_details(details);
            }
            Err(error)
        }
    };
    Ok(AgentReply {
        result,
        profile: grant.profile,
    })
}

fn publish(shared: &Shared, record: &AgentCallRecord) {
    let on_call = shared.on_call.read().ok().and_then(|hook| hook.clone());
    if let (Some(hook), Ok(value)) = (on_call, serde_json::to_value(record)) {
        hook(value);
    }
    notify_session(shared, &record.project_id, &record.session_id);
}

fn notify_session(shared: &Shared, project_id: &str, session_id: &str) {
    let watch = shared
        .session_watch
        .read()
        .ok()
        .and_then(|watch| watch.clone());
    if let Some(watch) = watch {
        watch(project_id, session_id);
    }
}

/// Load a project's earlier ledger the first time it is needed. The folder
/// comes from the application state, so this must run without its lock held.
/// Point the ledger at the folder the project is open from now: a project
/// closed, moved and opened again keeps its id, and its history goes with it.
fn attach_ledger(shared: &Shared, project_id: &str) {
    let root = shared
        .core
        .lock()
        .ok()
        .and_then(|core| core.project_root(project_id).ok());
    if let Some(root) = root {
        shared.ledger.attach_project(project_id, &root);
    }
}

fn run_agent_call(
    shared: &Shared,
    grant: &Grant,
    call: AgentCall<'_>,
    trace: &mut CallTrace,
) -> Result<Value, ContractError> {
    let mut op = resolve_for_agent(call.name, call.via == Via::Mcp, trace)?;
    let mut payload = call.payload;
    if op.name == "tool.call" {
        // The wrapper's own input is validated first; the target's input is
        // an open object that the target's schema validates below.
        let outer = parse_agent(op, payload, trace)?;
        let target = outer["tool"].as_str().unwrap_or_default();
        op = resolve_for_agent(target, true, trace)?;
        if op.name == "tool.call" {
            return Err(ContractError::validation("tool_call cannot call itself")
                .with_repair("Put the tool you want to run in tool, and its arguments in input.")
                .with_details(json!({
                    "tool": "tool_call",
                    "example": registry().operation("tool.call").and_then(|op| op.example.clone()),
                })));
        }
        payload = outer.get("input").cloned().unwrap_or_else(|| json!({}));
    }
    trace.op = op.name.clone();
    trace.mutating = op.mutating;

    // `idempotencyKey` is accepted on every call although no listing shows
    // it. Operations that declare it validate it themselves; for the others
    // it only travels beside the input.
    let mut idempotency_key = call.idempotency_key.map(str::to_owned);
    if let Some(fields) = payload.as_object_mut() {
        let declared = op.input_schema["properties"]
            .get(present::IDEMPOTENCY_KEY)
            .is_some();
        let sent = if declared {
            fields.get(present::IDEMPOTENCY_KEY).cloned()
        } else {
            fields.remove(present::IDEMPOTENCY_KEY)
        };
        if let Some(Value::String(key)) = sent {
            idempotency_key.get_or_insert(key);
        }
    }
    trace.input = payload.clone();
    let mut input = parse_agent(op, payload, trace)?;
    present::prefer_brief_detail(op, grant.profile, &mut input);

    let hosted = op.name.starts_with("research.")
        || op.name.starts_with("browser.")
        || matches!(
            op.name.as_str(),
            "chat.present" | "ui.open_artifact" | "ui.request_review"
        );
    let result = match (op.name.as_str(), &shared.host_dispatch) {
        ("guide.read", _) => guide::read(&input),
        ("proposal.wait", _) => wait_for_review(shared, grant, &input),
        (_, Some(host_dispatch)) if hosted => host_dispatch(
            op.name.clone(),
            input.clone(),
            Origin::Agent {
                session_id: grant.session_id.clone(),
            },
            grant.project_id.clone(),
            idempotency_key,
        ),
        _ => dispatch_core(shared, grant, op, input.clone(), idempotency_key.as_deref()),
    }?;
    Ok(present::shape_result(op, grant.profile, &input, result))
}

/// Find the operation an agent named and check it may call it. A name in a
/// form the tool list does not use is accepted and reported.
fn resolve_for_agent(
    name: &str,
    expect_tool_name: bool,
    trace: &mut CallTrace,
) -> Result<&'static Operation, ContractError> {
    let op = registry()
        .resolve(name)
        .ok_or_else(|| registry().unknown_operation(name))?;
    if !op.agent_allowed {
        return Err(ContractError::capability_denied(
            &op.tool_name,
            human_only_alternative(op),
        ));
    }
    if name != op.tool_name && (expect_tool_name || name != op.name) {
        trace
            .notes
            .push(format!("read tool name \"{name}\" as {}", op.tool_name));
    }
    Ok(op)
}

/// What an agent should do instead of an operation reserved for the human.
fn human_only_alternative(op: &Operation) -> &'static str {
    match op.name.as_str() {
        "proposal.approve" | "proposal.reject" | "proposal.request_changes" => {
            "Only the human resolves a proposal. Submit your drafts with proposal_submit, then wait with proposal_wait or stop and say the review is pending."
        }
        "artifact.apply_edit" | "artifact.accept_draft" | "artifact.revert" | "artifact.archive"
        | "artifact.set_subsystem" => {
            "Save a draft with artifact_update_draft and ask for review with proposal_submit; the human applies it."
        }
        "bom.update_line" | "bom.remove_line" => "Propose the change with bom_propose_edit.",
        _ => "Call tool_describe with no arguments to list the tools you can call.",
    }
}

/// Validate agent input, keeping the repairs applied whether or not the
/// input is valid in the end.
fn parse_agent(
    op: &Operation,
    payload: Value,
    trace: &mut CallTrace,
) -> Result<Value, ContractError> {
    match parse_agent_input(op, payload) {
        Ok(AgentInput { value, notes }) => {
            trace.notes.extend(notes);
            Ok(value)
        }
        Err(error) => {
            let applied = error
                .details
                .as_deref()
                .and_then(|details| details["notes"].as_array());
            trace.notes.extend(
                applied
                    .into_iter()
                    .flatten()
                    .filter_map(|note| note.as_str().map(str::to_owned)),
            );
            Err(error)
        }
    }
}

/// Run an operation in the core and forward the events it recorded, each
/// once and as soon as the step that recorded it releases the workspace
/// lock. OpenSCAD work runs with the lock released, so the person's reads
/// and edits are served while an agent's render is in progress.
fn dispatch_core(
    shared: &Shared,
    grant: &Grant,
    op: &Operation,
    input: Value,
    idempotency_key: Option<&str>,
) -> Result<Value, ContractError> {
    dispatch_shared_with_events(
        &shared.core,
        &op.name,
        input,
        Origin::Agent {
            session_id: grant.session_id.clone(),
        },
        Some(&grant.project_id),
        idempotency_key,
        &mut |event| (shared.on_event)(event),
    )
}

/// Margin kept between the longest wait and the CLI's own tool-call limit.
const WAIT_MARGIN: Duration = Duration::from_secs(30);

/// `proposal.wait` for an agent: bounded below the CLI's tool-call limit, so
/// the CLI never abandons a wait that is still running, and visible to the
/// terminal host as "waiting for your review" while it lasts.
fn wait_for_review(shared: &Shared, grant: &Grant, input: &Value) -> Result<Value, ContractError> {
    let proposal_id = input["proposalId"]
        .as_str()
        .ok_or_else(|| ContractError::validation("Missing proposalId"))?;
    let limit = adapter(&grant.adapter_id)
        .map_or(Duration::from_secs(330), |spec| spec.tool_timeout)
        .saturating_sub(WAIT_MARGIN);
    let timeout = Duration::from_millis(input["timeoutMs"].as_u64().unwrap_or(60_000)).min(limit);
    let _waiting = WaitingForReview::begin(shared, grant);
    let mut snapshot = wait_until_resolved(&shared.core, &grant.project_id, proposal_id, timeout)?;
    if snapshot["timedOut"] == true {
        snapshot["next"] = json!({
            "tool": "proposal_wait",
            "why": "The human has not decided yet. Wait again only if you were asked to continue after review; otherwise stop and say the review is pending.",
            "args": {"proposalId": proposal_id},
        });
    }
    Ok(snapshot)
}

/// Marks a session as waiting for review for as long as it lives.
struct WaitingForReview<'a> {
    shared: &'a Shared,
    grant: &'a Grant,
}

impl<'a> WaitingForReview<'a> {
    fn begin(shared: &'a Shared, grant: &'a Grant) -> Self {
        if let Ok(mut waiting) = shared.waiting.lock() {
            *waiting.entry(grant.session_id.clone()).or_default() += 1;
        }
        notify_session(shared, &grant.project_id, &grant.session_id);
        Self { shared, grant }
    }
}

impl Drop for WaitingForReview<'_> {
    fn drop(&mut self) {
        if let Ok(mut waiting) = self.shared.waiting.lock() {
            let session = &self.grant.session_id;
            match waiting.get_mut(session) {
                Some(count) if *count > 1 => *count -= 1,
                _ => {
                    waiting.remove(session);
                }
            }
        }
        notify_session(self.shared, &self.grant.project_id, &self.grant.session_id);
    }
}

pub fn wait_proposal(
    core: &Arc<Mutex<CoreApp>>,
    project_id: &str,
    payload: &Value,
) -> Result<Value, ContractError> {
    let definition = registry()
        .operation("proposal.wait")
        .expect("proposal.wait contract");
    let input = omenflow_contracts::parse_input(definition, payload.clone())?;
    let proposal_id = input["proposalId"]
        .as_str()
        .ok_or_else(|| ContractError::validation("Missing proposalId"))?;
    let timeout = Duration::from_millis(input["timeoutMs"].as_u64().unwrap_or(60_000));
    wait_until_resolved(core, project_id, proposal_id, timeout)
}

/// Poll a proposal until it leaves `pending` or `timeout` passes, holding
/// the application lock only for each look. The result says which happened
/// in `timedOut`.
fn wait_until_resolved(
    core: &Arc<Mutex<CoreApp>>,
    project_id: &str,
    proposal_id: &str,
    timeout: Duration,
) -> Result<Value, ContractError> {
    let started = Instant::now();
    loop {
        let mut snapshot = core
            .lock()
            .map_err(|_| ContractError::new("INTERNAL", "Application state is unavailable"))?
            .proposal_wait_snapshot(project_id, proposal_id)?;
        let pending = snapshot["state"] == "pending";
        if !pending || started.elapsed() >= timeout {
            snapshot["timedOut"] = json!(pending);
            return Ok(snapshot);
        }
        thread::sleep(Duration::from_millis(50).min(timeout.saturating_sub(started.elapsed())));
    }
}

fn serve_calls(stream: &mut Stream, shared: &Shared, token: &str) {
    while let Ok(Some(request)) = read_frame(stream) {
        let request_id = request["requestId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .unwrap_or("unknown")
            .to_owned();
        let response = if let Some(op) = request["op"].as_str() {
            let call = AgentCall {
                name: op,
                payload: request.get("payload").cloned().unwrap_or(json!({})),
                idempotency_key: request["idempotencyKey"].as_str(),
                via: Via::Call,
            };
            match dispatch_agent(shared, token, call).and_then(|reply| reply.result) {
                Ok(result) => ResponseEnvelope::success(request_id, result),
                Err(error) => ResponseEnvelope::failure(request_id, error),
            }
        } else {
            ResponseEnvelope::failure(
                request_id,
                ContractError::validation("Malformed request envelope"),
            )
        };
        if write_frame(stream, &response).is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A data folder given relative to the host's working directory still
    /// yields an endpoint a session started in its project folder reaches.
    #[cfg(unix)]
    #[test]
    fn a_relative_data_folder_gives_an_absolute_endpoint() {
        // Unit tests run in the crate folder; the workspace target folder is
        // a place the test may write to. Socket paths are short, so is this.
        let name = uuid::Uuid::new_v4().simple().to_string();
        let relative = Path::new("../../target").join(format!("rel-{}", &name[..8]));
        let resolved = absolute_dir(&relative).unwrap();
        assert!(resolved.is_absolute());
        assert_eq!(resolved, fs::canonicalize(&relative).unwrap());
        let socket = socket_path(&resolved);
        assert!(Path::new(&socket).is_absolute(), "{socket}");
        assert!(socket.ends_with("/run/bridge.sock"));
        let core = Arc::new(Mutex::new(CoreApp::new(resolved.join("core")).unwrap()));
        let bridge = BridgeServer::start(core, &relative).unwrap();
        assert_eq!(bridge.socket_path(), socket);
        // Reached from anywhere, as a session in another folder reaches it.
        assert!(Stream::connect(socket_name(bridge.socket_path()).unwrap()).is_ok());
        drop(bridge);
        fs::remove_dir_all(&resolved).unwrap();
        // An absolute folder is used exactly as given.
        let given = Path::new("/tmp/omen-absolute");
        assert_eq!(absolute_dir(given).unwrap(), given);
    }

    /// Each data folder has its own pipe on Windows, so a second host does
    /// not collide with the first; the same folder always names the same one.
    #[test]
    fn each_data_folder_names_its_own_pipe() {
        let installed = pipe_name("ada", Path::new(r"C:\Users\ada\AppData\Roaming\Omen Flow"));
        let isolated = pipe_name("ada", Path::new(r"C:\Users\ada\AppData\Local\Temp\omf-1"));
        assert_ne!(installed, isolated);
        assert_eq!(
            installed,
            pipe_name("ada", Path::new(r"c:\users\ada\appdata\roaming\omen flow"))
        );
        assert_ne!(
            installed,
            pipe_name("bob", Path::new(r"C:\Users\ada\AppData\Roaming\Omen Flow"))
        );
        assert!(
            installed.starts_with(r"\\.\pipe\omenflow-ada-"),
            "{installed}"
        );
        assert!(installed.len() < 256);
    }

    #[test]
    fn bridge_call_round_trip_and_revocation() {
        let temp = tempfile::tempdir().unwrap();
        let mut core = CoreApp::new(temp.path().join("app")).unwrap();
        let project = core
            .dispatch(
                "project.create",
                json!({"path": temp.path().join("project"), "name": "Bridge", "intent": "test"}),
                Origin::User,
                None,
            )
            .unwrap();
        let project_id = project["projectId"].as_str().unwrap();
        let core = Arc::new(Mutex::new(core));
        let bridge = BridgeServer::start(core, &temp.path().join("app")).unwrap();
        let session_id = uuid::Uuid::new_v4().to_string();
        let token = bridge.issue_token(project_id, &session_id);
        let mut stream = Stream::connect(socket_name(bridge.socket_path()).unwrap()).unwrap();
        write_frame(
            &mut stream,
            &json!({"type":"hello", "protocolVersion":1,"mode":"call","token":token}),
        )
        .unwrap();
        let welcome = read_frame(&mut stream).unwrap().unwrap();
        assert_eq!(welcome["type"], "welcome");
        assert_eq!(welcome["profile"], "standard");
        write_frame(
            &mut stream,
            &json!({"requestId":"one","op":"project.summary","payload":{}}),
        )
        .unwrap();
        let response = read_frame(&mut stream).unwrap().unwrap();
        assert_eq!(response["result"]["project"]["name"], "Bridge");
        write_frame(
            &mut stream,
            &json!({"requestId":"two","op":"proposal.approve","payload":{}}),
        )
        .unwrap();
        let denied = read_frame(&mut stream).unwrap().unwrap();
        assert_eq!(denied["error"]["code"], "CAPABILITY_DENIED");
        assert!(denied["error"]["repair"]
            .as_str()
            .unwrap()
            .contains("proposal_submit"));
        bridge.revoke(&session_id);
        write_frame(
            &mut stream,
            &json!({"requestId":"three","op":"project.summary","payload":{}}),
        )
        .unwrap();
        assert_eq!(
            read_frame(&mut stream).unwrap().unwrap()["error"]["code"],
            "CONNECTION_DENIED"
        );
        // The two calls made under the grant are on record; the one made
        // after revocation belongs to no session and is not.
        let activity = bridge.agent_activity(project_id, &json!({})).unwrap();
        let calls = activity["calls"].as_array().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0]["tool"], "project.summary");
        assert_eq!(calls[0]["via"], "call");
        assert_eq!(calls[1]["code"], "CAPABILITY_DENIED");
        assert_eq!(activity["sessions"][0]["adapterId"], DIRECT_ADAPTER);
        assert!(activity["sessions"][0]["endedAt"].is_string());
    }

    #[test]
    fn mcp_tools_are_scoped_and_call_through_the_same_bridge() {
        let temp = tempfile::tempdir().unwrap();
        let mut core = CoreApp::new(temp.path().join("app")).unwrap();
        let project = core
            .dispatch(
                "project.create",
                json!({"path": temp.path().join("project"), "name": "MCP", "intent": "test"}),
                Origin::User,
                None,
            )
            .unwrap();
        let project_id = project["projectId"].as_str().unwrap();
        let bridge =
            BridgeServer::start(Arc::new(Mutex::new(core)), &temp.path().join("app")).unwrap();
        let token = bridge.issue_token(project_id, &uuid::Uuid::new_v4().to_string());
        let mut stream = Stream::connect(socket_name(bridge.socket_path()).unwrap()).unwrap();
        write_frame(
            &mut stream,
            &json!({"type":"hello", "protocolVersion":1,"mode":"mcp","token":token}),
        )
        .unwrap();
        assert_eq!(read_frame(&mut stream).unwrap().unwrap()["type"], "welcome");
        write_frame(&mut stream, &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}})).unwrap();
        assert_eq!(
            read_frame(&mut stream).unwrap().unwrap()["result"]["serverInfo"]["name"],
            "omenflow"
        );
        write_frame(
            &mut stream,
            &json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
        )
        .unwrap();
        let tools = read_frame(&mut stream).unwrap().unwrap()["result"]["tools"]
            .as_array()
            .unwrap()
            .clone();
        assert!(tools.iter().any(|tool| tool["name"] == "project_summary"));
        assert!(!tools.iter().any(|tool| tool["name"] == "proposal_approve"));
        write_frame(&mut stream, &json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"project_summary","arguments":{}}})).unwrap();
        let reply = read_frame(&mut stream).unwrap().unwrap();
        assert_eq!(reply["result"]["isError"], false);
        assert!(reply["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("MCP"));
    }

    #[test]
    fn proposal_wait_releases_core_lock_for_human_resolution() {
        let temp = tempfile::tempdir().unwrap();
        let mut core = CoreApp::new(temp.path().join("app")).unwrap();
        let project = core
            .dispatch(
                "project.create",
                json!({"path":temp.path().join("project"),"name":"Wait","intent":"test"}),
                Origin::User,
                None,
            )
            .unwrap();
        let project_id = project["projectId"].as_str().unwrap().to_owned();
        let draft=core.dispatch("artifact.create_draft",json!({"type":"requirement","title":"Test","payload":{"statement":"Observe","acceptanceCriterion":"Record"}}),Origin::User,Some(&project_id)).unwrap();
        let proposal=core.dispatch("proposal.submit",json!({"changes":[{"artifactId":draft["artifact"]["id"],"baseRevisionId":null,"newRevisionId":draft["revision"]["id"],"kind":"new_artifact"}],"reason":"review"}),Origin::User,Some(&project_id)).unwrap();
        let proposal_id = proposal["id"].as_str().unwrap().to_owned();
        let core = Arc::new(Mutex::new(core));
        let resolver = Arc::clone(&core);
        let id = project_id.clone();
        let proposal_id_for_thread = proposal_id.clone();
        let thread = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            resolver
                .lock()
                .unwrap()
                .dispatch(
                    "proposal.approve",
                    json!({"proposalId":proposal_id_for_thread,"rationale":"reviewed"}),
                    Origin::User,
                    Some(&id),
                )
                .unwrap();
        });
        let result = wait_proposal(
            &core,
            &project_id,
            &json!({"proposalId":proposal_id,"timeoutMs":2_000}),
        )
        .unwrap();
        thread.join().unwrap();
        assert_eq!(result["state"], "accepted");
    }
}

mod host;
pub use host::{EventSink, Host, HostEvent, HostPaths, ResearchSurface, Shell};
