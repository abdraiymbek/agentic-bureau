//! One router for user-origin commands. The Tauri shell and the headless
//! loopback server both own a [`Host`] and differ only in the three traits
//! they implement: where events go ([`EventSink`]), what the desktop can do
//! with a path or a link ([`Shell`]), and how pages are read
//! ([`ResearchSurface`]).

mod research;

pub use research::ResearchSurface;

use crate::{guide_read, wait_proposal, BridgeServer, PtyHost, TerminalEvent};
use omenflow_contracts::{parse_input, registry, ContractError, ResponseEnvelope};
use omenflow_core::{dispatch_shared_with_events, stop_engines, CoreApp, Origin};
use research::Research;
use serde_json::{json, Value};
use std::any::Any;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

/// Where a host keeps its state and finds the `omenflow` helper that agent
/// CLIs call back through.
#[derive(Clone, Debug)]
pub struct HostPaths {
    pub app_data_dir: PathBuf,
    pub cli_path: PathBuf,
}

/// Everything a host pushes to its interface without being asked.
#[derive(Clone, Debug)]
pub enum HostEvent {
    /// A project event row. Carries `projectId` whenever the host knows it.
    Project(Value),
    /// `{ projectId, sessionId, chunk, seq }` from a running agent terminal.
    TerminalData(Value),
    /// `{ projectId, session }` when a terminal session changes state.
    TerminalState(Value),
    /// One agent call record, as the ledger wrote it.
    AgentCall(Value),
    /// `{ projectId, seq }` when a project's conversation record changes: a turn starts or
    /// settles, streamed text arrives, or a card is opened or presented. Never the record
    /// itself; `chat.read` stays the source of truth.
    Chat(Value),
}

impl HostEvent {
    /// The desktop channel the renderer subscribes to.
    pub fn channel(&self) -> &'static str {
        match self {
            Self::Project(_) => "omenflow:event",
            Self::TerminalData(_) => "omenflow:terminal:data",
            Self::TerminalState(_) => "omenflow:terminal:state",
            Self::AgentCall(_) => "omenflow:agent:call",
            Self::Chat(_) => "omenflow:chat",
        }
    }

    /// The server-sent event name used by the headless host.
    pub fn name(&self) -> &'static str {
        match self {
            Self::Project(_) => "event",
            Self::TerminalData(_) => "terminal-data",
            Self::TerminalState(_) => "terminal-state",
            Self::AgentCall(_) => "agent-call",
            Self::Chat(_) => "chat",
        }
    }

    pub fn payload(&self) -> &Value {
        match self {
            Self::Project(value)
            | Self::TerminalData(value)
            | Self::TerminalState(value)
            | Self::AgentCall(value)
            | Self::Chat(value) => value,
        }
    }
}

pub trait EventSink: Send + Sync + 'static {
    /// Deliver one event. Called from command, bridge and terminal threads;
    /// it must not block on the caller.
    fn emit(&self, event: HostEvent);
}

pub trait Shell: Send + Sync + 'static {
    /// Show a file or folder in the system file manager.
    fn reveal_path(&self, path: &Path) -> Result<(), ContractError>;
    /// Open an `http`, `https` or `mailto` address in the system default application.
    fn open_external(&self, url: &str) -> Result<(), ContractError>;
}

/// The core and the sink its events go to. Every user-origin core call in the
/// host passes through [`CoreGate::call`]: OpenSCAD work runs with the
/// workspace lock released, and the events a call recorded are delivered
/// once each, carrying `projectId`, as soon as the step that recorded them
/// lets go of the lock.
pub(crate) struct CoreGate {
    core: Arc<Mutex<CoreApp>>,
    events: Arc<dyn EventSink>,
}

impl CoreGate {
    /// A panic elsewhere must not leave the workspace unusable: the lock is
    /// recovered instead of answering every later command with an error.
    fn lock(&self) -> MutexGuard<'_, CoreApp> {
        self.core.lock().unwrap_or_else(|poisoned| {
            self.core.clear_poison();
            poisoned.into_inner()
        })
    }

    pub(crate) fn call(
        &self,
        op: &str,
        payload: Value,
        origin: Origin,
        project_id: Option<&str>,
        idempotency_key: Option<&str>,
    ) -> Result<Value, ContractError> {
        dispatch_shared_with_events(
            &self.core,
            op,
            payload,
            origin,
            project_id,
            idempotency_key,
            &mut |event| self.events.emit(HostEvent::Project(event)),
        )
    }
}

/// Resolve only local record IDs. Never trust a model-supplied path or revision from another artifact.
fn resolve_card(gate: &CoreGate, project: &str, mut part: Value) -> Result<Value, ContractError> {
    if part.to_string().len() > 24 * 1024 {
        return Err(ContractError::validation("Inline card exceeds 24 KiB"));
    }
    match part["kind"].as_str() {
        Some("artifact") => {
            let mut input = json!({"artifactId":part["artifactId"], "detail":"full"});
            if let Some(id) = part.get("revisionId") {
                input["revisionId"] = id.clone();
            }
            let view = gate.call("artifact.read", input, Origin::User, Some(project), None)?;
            let id = if part.get("revisionId").is_some() {
                view["revision"]["id"].as_str()
            } else {
                view["view"]["head"]["id"]
                    .as_str()
                    .or(view["revision"]["id"].as_str())
            }
            .ok_or_else(|| ContractError::validation("This artifact has no recorded revision"))?;
            if part
                .get("revisionId")
                .is_some_and(|wanted| wanted.as_str() != Some(id))
                || view["revision"]["artifactId"] != part["artifactId"]
            {
                return Err(ContractError::validation(
                    "The requested revision does not belong to this artifact",
                ));
            }
            part["revisionId"] = json!(id);
            part["title"] = view["view"]["artifact"]["title"].clone();
        }
        Some("review") => {
            let proposal = gate.call(
                "proposal.read",
                json!({"proposalId":part["proposalId"]}),
                Origin::User,
                Some(project),
                None,
            )?;
            part["title"] = proposal["proposal"]["reason"].clone();
        }
        Some("form") => {
            let fields = part["fields"].as_array().unwrap();
            let mut names = std::collections::HashSet::new();
            for f in fields {
                if !names.insert(f["name"].as_str())
                    || (f["value"].is_null()
                        && f["reason"].as_str().is_none_or(|s| s.trim().is_empty()))
                {
                    return Err(ContractError::validation(
                        "Form fields need unique names, and unknown values need a reason",
                    ));
                }
            }
        }
        _ => {}
    }
    Ok(part)
}

pub struct Host {
    gate: Arc<CoreGate>,
    bridge: Arc<BridgeServer>,
    pty: PtyHost,
    chat: crate::chat::ChatHost,
    /// Held from the check to the start of an agent, so a terminal session and a conversation
    /// run never both start in one project.
    agent_start: Mutex<()>,
    shell: Arc<dyn Shell>,
    research: Arc<Research>,
}

impl Host {
    /// Open the application state in `paths.app_data_dir`, start the agent
    /// bridge beside it and wire every event source to `events`.
    pub fn start(
        paths: HostPaths,
        events: Arc<dyn EventSink>,
        shell: Arc<dyn Shell>,
        surface: Arc<dyn ResearchSurface>,
    ) -> Result<Self, ContractError> {
        // Children (agent CLIs, the helper) start in a project's folder: a
        // path handed to them must not be relative to this process.
        let unresolved = |path: &PathBuf, error: std::io::Error| {
            ContractError::new(
                "INTERNAL",
                format!("Could not resolve {}: {error}", path.display()),
            )
        };
        let paths = HostPaths {
            app_data_dir: crate::absolute_dir(&paths.app_data_dir)
                .map_err(|error| unresolved(&paths.app_data_dir, error))?,
            cli_path: std::path::absolute(&paths.cli_path)
                .map_err(|error| unresolved(&paths.cli_path, error))?,
        };
        let mut core = CoreApp::new(&paths.app_data_dir)?;
        let background = Arc::clone(&events);
        core.set_event_hook(Arc::new(move |event| {
            background.emit(HostEvent::Project(event))
        }));
        let core = Arc::new(Mutex::new(core));
        let gate = Arc::new(CoreGate {
            core: Arc::clone(&core),
            events: Arc::clone(&events),
        });
        let research = Arc::new(Research::new(surface, Arc::clone(&gate)));
        let chat_state = Arc::new(Mutex::new(crate::chat::State::new(Arc::clone(&events))));
        let agent_chat = Arc::clone(&chat_state);
        let agent_gate = Arc::clone(&gate);
        let agent_events = Arc::clone(&events);
        let agent_research = Arc::clone(&research);
        let bridge = BridgeServer::start_with_host(
            Arc::clone(&core),
            &paths.app_data_dir,
            Arc::new(move |event| agent_events.emit(HostEvent::Project(event))),
            Some(Arc::new(move |op, payload, origin, project_id, key| {
                if matches!(
                    op.as_str(),
                    "chat.present" | "ui.open_artifact" | "ui.request_review"
                ) {
                    let root = agent_gate.lock().project_root(&project_id)?;
                    let session = origin.session_id().unwrap_or_default();
                    // An agent terminal's requests move the workspace as before; only a
                    // conversation run's become cards in the turn it owns.
                    if op != "chat.present"
                        && !crate::chat::owns_running_turn(&agent_chat, &root, session)
                    {
                        return agent_gate.call(&op, payload, origin, Some(&project_id), key.as_deref());
                    }
                    let part = match op.as_str() {
                        "ui.open_artifact" => {
                            json!({"kind":"artifact", "artifactId":payload["artifactId"]})
                        }
                        "ui.request_review" => {
                            json!({"kind":"review", "proposalId":payload["proposalId"]})
                        }
                        _ => payload["part"].clone(),
                    };
                    let part = resolve_card(&agent_gate, &project_id, part)?;
                    if crate::chat::present(&agent_chat, &project_id, &root, session, part)? {
                        return Ok(json!({"ok":true, "presentation":"owning conversation turn"}));
                    }
                    if op == "chat.present" {
                        return Err(ContractError::validation(
                            "This session has no running conversation turn",
                        ));
                    }
                    return agent_gate.call(&op, payload, origin, Some(&project_id), key.as_deref());
                }
                agent_research.dispatch(&op, payload, origin, &project_id, key.as_deref())
            })),
        )
        .map_err(|error| {
            ContractError::new(
                "INTERNAL",
                format!(
                    "Could not start the agent bridge in {}: {error}",
                    paths.app_data_dir.display()
                ),
            )
            .with_repair(
                "Check that no other Omen Flow host is running with this data folder, that the folder can be written to, and that its path is short: the bridge listens on a socket inside it, and socket paths are limited to about 100 characters.",
            )
        })?;
        let calls = Arc::clone(&events);
        bridge.set_on_call(Arc::new(move |record| {
            calls.emit(HostEvent::AgentCall(record))
        }));
        let bridge = Arc::new(bridge);
        let terminal_events = Arc::clone(&events);
        let pty = PtyHost::new(
            core,
            Arc::clone(&bridge),
            paths.cli_path,
            Arc::new(move |event| {
                terminal_events.emit(match event {
                    TerminalEvent::Data(data) => HostEvent::TerminalData(data),
                    TerminalEvent::State(state) => HostEvent::TerminalState(state),
                })
            }),
        );
        Ok(Self {
            gate,
            bridge: Arc::clone(&bridge),
            pty,
            chat: crate::chat::ChatHost::new(Arc::clone(&bridge), chat_state),
            agent_start: Mutex::new(()),
            shell,
            research,
        })
    }

    /// Run one user-origin command. Always answers: a panic inside the
    /// command becomes an `INTERNAL` envelope and the workspace stays usable.
    pub fn command(
        &self,
        op: &str,
        payload: Value,
        project_id: Option<&str>,
        idempotency_key: Option<&str>,
    ) -> ResponseEnvelope {
        let request_id = uuid::Uuid::new_v4().to_string();
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            self.route(op, payload, project_id, idempotency_key)
        }));
        match outcome {
            Ok(Ok(value)) => ResponseEnvelope::success(request_id, value),
            Ok(Err(error)) => ResponseEnvelope::failure(request_id, error),
            Err(panic) => {
                self.gate.core.clear_poison();
                ResponseEnvelope::failure(request_id, panic_error(op, panic.as_ref()))
            }
        }
    }

    fn route(
        &self,
        op: &str,
        payload: Value,
        project_id: Option<&str>,
        idempotency_key: Option<&str>,
    ) -> Result<Value, ContractError> {
        let definition = registry()
            .operation(op)
            .ok_or_else(|| ContractError::validation(format!("Unknown operation: {op}")))?;
        let mut payload = parse_input(definition, payload)?;
        if op == "chat.present" {
            return Err(ContractError::validation(
                "chat.present requires an owning agent session; use chat.open to open a card",
            ));
        }
        if op == "chat.open" {
            payload["part"] =
                resolve_card(&self.gate, required(project_id)?, payload["part"].clone())?;
        }
        if research::handles(op) {
            return self.research.dispatch(
                op,
                payload,
                Origin::User,
                required(project_id)?,
                idempotency_key,
            );
        }
        if op == "tool.call" {
            return self.tool_call(&payload, project_id, idempotency_key);
        }
        // One agent works in a project at a time: an agent terminal or a conversation run.
        let _starting = matches!(op, "terminal.start" | "terminal.restart" | "chat.send")
            .then(|| self.agent_start.lock().unwrap_or_else(|e| e.into_inner()));
        if matches!(op, "terminal.start" | "terminal.restart") {
            let id = required(project_id)?;
            let root = self.gate.lock().project_root(id)?;
            if self.chat.running_in(&root) {
                return Err(ContractError::new(
                    "BUSY",
                    "A conversation response is running in this project",
                )
                .with_repair(
                    "Stop the response in the Conversation pane, or wait until it finishes.",
                ));
            }
        }
        if let Some(result) = self.host_operation(op, &payload, project_id) {
            return result;
        }
        if op.starts_with("chat.") {
            let id = required(project_id)?;
            let (root, read_only) = {
                let core = self.gate.lock();
                let root = core.project_root(id)?;
                let writable = core.assert_project_writable(id);
                let read_only = writable.is_err();
                if op != "chat.read" {
                    writable?;
                }
                (root, read_only)
            };
            return self.chat.command(op, id, &root, &payload, read_only, || {
                if self.pty.running(id) {
                    return Err(ContractError::new(
                        "BUSY",
                        "A terminal session is running in this project",
                    )
                    .with_repair("Stop the terminal session, or ask from the Terminal pane."));
                }
                if let Some(input) = payload.get("input") {
                    if let Some(artifact) = input["artifactId"].as_str() {
                        let view = self.gate.call("artifact.read", json!({"artifactId":artifact, "detail":"full"}), Origin::User, Some(id), None)?;
                        let head = view["view"]["head"]["id"].as_str().or(view["revision"]["id"].as_str());
                        if head != input["revisionId"].as_str() { return Err(ContractError::validation("The attached revision is stale. Open the newer card, then prepare and send again.")); }
                    }
                }
                self.pty.prepare_headless(id, &payload)
            });
        }
        if op == "project.close" {
            if let Some(id) = project_id {
                self.chat
                    .stop_project(&self.gate.lock().project_root(id)?)?;
                self.pty.close(id)?;
            }
        }
        let result = self
            .gate
            .call(op, payload, Origin::User, project_id, idempotency_key)?;
        if op == "artifact.reveal" {
            if let Some(path) = result["path"].as_str() {
                self.shell.reveal_path(Path::new(path))?;
            }
        }
        Ok(result)
    }

    /// Operations the host answers itself; `None` sends the operation to the
    /// core. Agent connections, terminal sessions and waiting on a proposal
    /// live here because they must not hold the workspace lock.
    fn host_operation(
        &self,
        op: &str,
        payload: &Value,
        project_id: Option<&str>,
    ) -> Option<Result<Value, ContractError>> {
        let project = || required(project_id);
        Some(match op {
            "connection.list" => self.pty.connection_list(),
            "connection.configure" => self.pty.connection_configure(payload),
            "connection.test" => project().and_then(|id| self.pty.connection_test(id, payload)),
            "terminal.start" => project().and_then(|id| self.pty.start(id, payload)),
            "terminal.write" => {
                project().and_then(|id| self.pty.write(id, payload["data"].as_str().unwrap_or("")))
            }
            "terminal.resize" => project().and_then(|id| {
                self.pty.resize(
                    id,
                    payload["cols"].as_u64().unwrap_or(80) as u16,
                    payload["rows"].as_u64().unwrap_or(24) as u16,
                )
            }),
            "terminal.interrupt" => project().and_then(|id| self.pty.interrupt(id)),
            "terminal.stop" => project().and_then(|id| self.pty.stop(id)),
            "terminal.restart" => project().and_then(|id| self.pty.restart(id)),
            "terminal.state" => project().map(|id| self.pty.state(id)),
            "proposal.wait" => project().and_then(|id| wait_proposal(&self.gate.core, id, payload)),
            "guide.read" => guide_read(payload),
            "agent.activity" => project().and_then(|id| self.bridge.agent_activity(id, payload)),
            _ => return None,
        })
    }

    /// `tool.call` from the interface: the same reach as an agent's, so only
    /// agent-allowed operations, named in either form. The target runs as
    /// the person's own command.
    fn tool_call(
        &self,
        payload: &Value,
        project_id: Option<&str>,
        idempotency_key: Option<&str>,
    ) -> Result<Value, ContractError> {
        let name = payload["tool"].as_str().unwrap_or_default();
        let target = registry()
            .resolve(name)
            .ok_or_else(|| registry().unknown_operation(name))?;
        if target.name == "tool.call" {
            return Err(ContractError::validation("tool_call cannot call itself")
                .with_repair("Put the tool you want to run in tool, and its arguments in input."));
        }
        if !target.agent_allowed {
            return Err(ContractError::capability_denied(
                &target.tool_name,
                format!("Run {} directly instead.", target.name),
            ));
        }
        let input = payload.get("input").cloned().unwrap_or_else(|| json!({}));
        self.route(&target.name, input, project_id, idempotency_key)
    }

    /// Prepare a non-interactive agent run on an open project with the same
    /// wiring a terminal session gets; the caller spawns the CLI. `input`
    /// takes the launch fields of `terminal.start` (`adapterId`, `model`,
    /// `profile`, `executablePath`, `args`). See
    /// [`PtyHost::prepare_headless`] for how to run the plan.
    pub fn prepare_agent_run(
        &self,
        project_id: &str,
        input: Value,
    ) -> Result<Value, ContractError> {
        let definition = registry().operation("terminal.start").ok_or_else(|| {
            ContractError::new("INTERNAL", "terminal.start is not in the registry")
        })?;
        let input = parse_input(definition, input)?;
        self.pty.prepare_headless(project_id, &input)
    }

    /// Show or hide the research surface for the person.
    pub fn toggle_research(&self) -> Result<Value, ContractError> {
        self.research.toggle()
    }

    /// Hand a link to the system. Only web and mail addresses leave the app.
    pub fn open_external(&self, url: &str) -> Result<(), ContractError> {
        let scheme = url.split_once(':').map(|(scheme, _)| scheme);
        if !scheme.is_some_and(|scheme| {
            ["http", "https", "mailto"]
                .iter()
                .any(|allowed| scheme.eq_ignore_ascii_case(allowed))
        }) {
            return Err(ContractError::validation(format!(
                "Only http, https and mailto links can be opened outside Omen Flow: {url}"
            )));
        }
        self.shell.open_external(url)
    }

    /// Forward one agent call record to the interface.
    pub fn record_agent_call(&self, record: Value) {
        self.gate.events.emit(HostEvent::AgentCall(record));
    }

    /// True while any project has a running agent terminal session.
    pub fn agent_running(&self) -> bool {
        if self.chat.running() {
            return true;
        }
        let open = self
            .gate
            .lock()
            .dispatch("project.list_open", json!({}), Origin::System, None);
        let Ok(open) = open else {
            return false;
        };
        open["projects"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|project| project["id"].as_str())
            .any(|id| self.pty.running(id))
    }

    /// Stop every agent terminal and revoke its bridge grant, and stop any
    /// OpenSCAD process still running. Call before the process exits; a
    /// dropped host does not get the chance.
    pub fn shutdown(&self) {
        self.chat.shutdown();
        self.pty.shutdown();
        stop_engines();
    }

    pub fn core(&self) -> &Arc<Mutex<CoreApp>> {
        &self.gate.core
    }

    pub fn pty(&self) -> &PtyHost {
        &self.pty
    }

    pub fn bridge(&self) -> &Arc<BridgeServer> {
        &self.bridge
    }
}

fn required(project_id: Option<&str>) -> Result<&str, ContractError> {
    project_id.ok_or_else(|| ContractError::validation("Project id is required"))
}

fn panic_error(op: &str, panic: &(dyn Any + Send)) -> ContractError {
    let cause = panic
        .downcast_ref::<&str>()
        .map(|text| (*text).to_owned())
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "no message".to_owned());
    ContractError::new("INTERNAL", format!("{op} stopped unexpectedly: {cause}"))
        .with_repair("Try again. If it fails the same way, restart Omen Flow and report the operation name and this message.")
        .with_details(json!({ "op": op, "panic": cause }))
}

#[cfg(test)]
mod tests;
