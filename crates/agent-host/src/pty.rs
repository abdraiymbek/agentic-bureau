//! Agent sessions in a pseudo-terminal: one per project. A session is
//! prepared by `session::plan_launch`, spawned here, streamed to the
//! interface as UTF-8 text, and stopped with a terminate-then-kill sequence
//! that leaves nothing of the agent's process group running.

use crate::adapters::{self, adapter, AdapterConfig, AdapterSpec, SearchPath, ADAPTERS};
use crate::profile::{resolve_profile, ResolvedProfile};
use crate::session::{self, plan_launch, LaunchMode, LaunchPlan, LaunchRequest};
use crate::{guide, now, BridgeServer, Grant, SessionActivity};
use omenflow_contracts::ContractError;
use omenflow_core::{CoreApp, Origin};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

/// Terminal text kept for restoring a view.
const SCROLLBACK_CAP: usize = 256 * 1024;
/// Text allowed beyond the cap before the front is trimmed, so trimming
/// moves the buffer once per this much output rather than on every read.
const SCROLLBACK_SLACK: usize = 64 * 1024;
/// How far past the cap a trim looks for a line start or an escape sequence.
const TRIM_WINDOW: usize = 4096;
const DEFAULT_SIZE: (u16, u16) = (80, 24);
/// How long a session gets to exit after it is asked to, before it is killed.
const STOP_GRACE: Duration = Duration::from_secs(2);
/// How long a killed session gets to be reaped.
const KILL_WAIT: Duration = Duration::from_secs(2);
/// Shortest time between two state events caused only by call counters.
const PULSE_INTERVAL: Duration = Duration::from_millis(750);
/// Longest time a connection test waits for the helper.
const HELPER_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug)]
pub enum TerminalEvent {
    Data(Value),
    State(Value),
}

type Notify = Arc<dyn Fn(TerminalEvent) + Send + Sync>;
type Sessions = Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>;

struct Session {
    info: Value,
    scrollback: String,
    cursor: u64,
    master: Box<dyn MasterPty + Send>,
    /// Behind its own lock: a write that blocks on a full terminal buffer
    /// must not stall the reader or a stop.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Only owned until the child is reaped. Never signal a remembered PID
    /// from an ended session: the OS may already have reused its group ID.
    process_group: Option<u32>,
    last_start: Value,
    plan: LaunchPlan,
    /// Set when a stop was requested, so the exit is not reported as a
    /// failure of the CLI.
    stopping: bool,
    last_pulse: Instant,
    pulse_pending: bool,
}

/// A launch planned by [`PtyHost::prepare`]: the grant is issued, nothing is
/// written or spawned.
struct Prepared {
    adapter_id: String,
    session_id: String,
    executable: PathBuf,
    model: Option<String>,
    resolved: ResolvedProfile,
    root: PathBuf,
    plan: LaunchPlan,
}

pub struct PtyHost {
    core: Arc<Mutex<CoreApp>>,
    bridge: Arc<BridgeServer>,
    cli_path: PathBuf,
    sessions: Sessions,
    /// The size each project's terminal was last given, kept even while no
    /// session runs so the next one starts at the size the view already has.
    sizes: Mutex<HashMap<String, (u16, u16)>>,
    lifecycle: Mutex<()>,
    notify: Notify,
}

impl PtyHost {
    pub fn new(
        core: Arc<Mutex<CoreApp>>,
        bridge: Arc<BridgeServer>,
        cli_path: PathBuf,
        notify: Arc<dyn Fn(TerminalEvent) + Send + Sync>,
    ) -> Self {
        adapters::warm();
        let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
        let watched = Arc::clone(&sessions);
        let watcher = Arc::clone(&notify);
        // The bridge owns this closure; a strong reference back would keep
        // the bridge alive for ever.
        let weak = Arc::downgrade(&bridge);
        bridge.watch_sessions(Arc::new(move |project_id, session_id| {
            pulse(&watched, &weak, &watcher, project_id, session_id);
        }));
        Self {
            core,
            bridge,
            cli_path,
            sessions,
            sizes: Mutex::new(HashMap::new()),
            lifecycle: Mutex::new(()),
            notify,
        }
    }

    pub fn start(&self, project_id: &str, input: &Value) -> Result<Value, ContractError> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| failure("Session lifecycle unavailable"))?;
        self.start_session(project_id, input, None)
    }

    /// Start a session. `resume` is the conversation an earlier session of
    /// the same adapter left behind, for a CLI that can continue it.
    fn start_session(
        &self,
        project_id: &str,
        input: &Value,
        resume: Option<&str>,
    ) -> Result<Value, ContractError> {
        let mode = resume.map_or(LaunchMode::Interactive, |conversation_id| {
            LaunchMode::Resume { conversation_id }
        });
        let Prepared {
            adapter_id,
            session_id,
            executable,
            model,
            resolved,
            root,
            plan,
        } = self.prepare(project_id, input, mode)?;
        let (cols, rows) = self.size_for(project_id, input);
        // From here on a failure must take the grant and the files with it.
        let abandon = |plan: &LaunchPlan, error: ContractError| {
            self.bridge.revoke(&session_id);
            plan.remove_files();
            error
        };
        plan.write_files()
            .and_then(|()| guide::sync_agents_md(&root, plan.agents_md))
            .map_err(|error| abandon(&plan, failure(error)))?;

        // Everything that can fail before the CLI runs has succeeded; only
        // now does the session being replaced go away.
        self.stop_inner(project_id)
            .map_err(|error| abandon(&plan, error))?;
        let mut command = CommandBuilder::new(&plan.executable);
        command.cwd(&plan.cwd);
        let mut removed = Vec::new();
        let mut set = Vec::new();
        plan.apply_environment(
            std::env::vars(),
            |key, value| set.push((key.to_owned(), value.to_owned())),
            |key| removed.push(key.to_owned()),
        );
        for key in removed {
            command.env_remove(key);
        }
        for (key, value) in set {
            command.env(key, value);
        }
        command.args(&plan.args);
        let pair = native_pty_system()
            .openpty(PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| abandon(&plan, failure(error)))?;
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| abandon(&plan, failure(error)))?;
        let pid = child.process_id();
        let reader = pair.master.try_clone_reader().map_err(|error| {
            let _ = child.kill();
            abandon(&plan, failure(error))
        })?;
        let writer = pair.master.take_writer().map_err(|error| {
            let _ = child.kill();
            abandon(&plan, failure(error))
        })?;
        let killer = child.clone_killer();
        let info = json!({
            "id": session_id,
            "adapterId": adapter_id,
            "executablePath": executable,
            "state": "running",
            "pid": pid,
            "exitCode": null,
            "cols": cols,
            "rows": rows,
            "startedAt": now(),
            "endedAt": null,
            "waitingForReview": false,
            "lastError": null,
            "model": model,
            "profile": resolved.profile,
            "profileSource": resolved.source.as_str(),
            "toolCount": guide::tool_count(resolved.profile),
            "calls": 0,
            "errors": 0,
        });
        let session = Arc::new(Mutex::new(Session {
            info: info.clone(),
            scrollback: String::new(),
            cursor: 0,
            master: pair.master,
            writer: Arc::new(Mutex::new(writer)),
            killer,
            process_group: pid,
            last_start: input.clone(),
            plan,
            stopping: false,
            last_pulse: Instant::now(),
            pulse_pending: false,
        }));
        self.sessions
            .lock()
            .map_err(|_| failure("Sessions unavailable"))?
            .insert(project_id.to_owned(), Arc::clone(&session));
        self.persist(project_id, &info);
        (self.notify)(TerminalEvent::State(
            json!({"projectId": project_id, "session": info}),
        ));
        let notify = Arc::clone(&self.notify);
        let session_for_read = Arc::clone(&session);
        let project_for_read = project_id.to_owned();
        thread::spawn(move || read_loop(reader, session_for_read, project_for_read, notify));
        // Weak: a child that outlives the host must not keep the bridge open.
        let bridge = Arc::downgrade(&self.bridge);
        let core = Arc::clone(&self.core);
        let notify = Arc::clone(&self.notify);
        let project_for_exit = project_id.to_owned();
        let sessions = Arc::clone(&self.sessions);
        thread::spawn(move || {
            // Keep the leader's PID reserved while its remaining workers
            // are stopped. Reaping it first would allow the group ID to be
            // reused before this thread or a concurrent stop signals it.
            #[cfg(unix)]
            finish_process_group(&session, pid);
            let status = child.wait();
            #[cfg(not(unix))]
            {
                lock_session(&session).process_group = None;
            }
            let activity = bridge
                .upgrade()
                .map_or_else(SessionActivity::default, |bridge| {
                    let activity = bridge.session_activity(&session_id);
                    bridge.revoke(&session_id);
                    activity
                });
            {
                let mut state = lock_session(&session);
                state.plan.remove_files();
                state.info["state"] = json!("exited");
                // portable-pty reports code 1 for a process ended by a signal
                // (a stop, a crash); that process exited with no code at all.
                state.info["exitCode"] = json!(status
                    .as_ref()
                    .ok()
                    .filter(|s| s.signal().is_none())
                    .map(|s| s.exit_code()));
                if state.info["endedAt"].is_null() {
                    state.info["endedAt"] = json!(now());
                }
                if !state.stopping {
                    state.info["lastError"] = json!(exit_error(&status));
                }
                apply_activity(&mut state.info, activity);
                state.info["waitingForReview"] = json!(false);
                let info = state.info.clone();
                drop(state);
                if let Ok(core) = core.lock() {
                    let _ = core.upsert_session(&project_for_exit, &info);
                }
                // An old child's exit must not overwrite the replacement session in the UI.
                if let Ok(current) = sessions.lock() {
                    if current
                        .get(&project_for_exit)
                        .is_some_and(|active| Arc::ptr_eq(active, &session))
                    {
                        notify(TerminalEvent::State(
                            json!({"projectId": project_for_exit, "session": info}),
                        ));
                    }
                }
            }
        });
        Ok(info)
    }

    /// Everything a launch needs before anything is written or spawned: the
    /// adapter and its configuration (what `input` says over what is
    /// stored), the executable, the session's profile, its grant on the
    /// bridge, and the plan. A failure issues no grant.
    fn prepare(
        &self,
        project_id: &str,
        input: &Value,
        mode: LaunchMode<'_>,
    ) -> Result<Prepared, ContractError> {
        let adapter_id = input["adapterId"]
            .as_str()
            .ok_or_else(|| ContractError::validation("Missing adapterId"))?;
        let spec = known_adapter(adapter_id)?;
        if mode == LaunchMode::Headless && spec.headless.is_none() {
            return Err(session::no_headless_mode(spec));
        }
        let (root, name, config) = {
            let mut core = self
                .core
                .lock()
                .map_err(|_| failure("Application state unavailable"))?;
            core.assert_project_writable(project_id)?;
            let root = core.project_root(project_id)?;
            let open = core.dispatch("project.list_open", json!({}), Origin::System, None)?;
            let name = open["projects"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|project| project["id"] == project_id)
                .and_then(|project| project["name"].as_str())
                .unwrap_or("Untitled project")
                .to_owned();
            let config = AdapterConfig::from_value(&core.adapter_config(adapter_id));
            (root, name, config.for_start(input))
        };
        if !self.cli_path.is_file() {
            return Err(ContractError::new(
                "TOOL_MISSING",
                format!(
                    "Omen Flow bridge helper missing: {}",
                    self.cli_path.display()
                ),
            )
            .with_repair("Reinstall Omen Flow; without the helper an agent has no tools."));
        }
        let search = SearchPath::system();
        let executable = search
            .locate(spec, &config)
            .ok_or_else(|| missing_executable(spec, &config))?;
        let resolved = resolve_profile(
            config.profile,
            config.model.as_deref(),
            &config.args,
            spec.default_profile,
        );
        let session_id = Uuid::new_v4().to_string();
        self.bridge.attach_project(project_id, &root);
        let token = self.bridge.issue_grant(Grant {
            project_id: project_id.to_owned(),
            session_id: session_id.clone(),
            profile: resolved.profile,
            adapter_id: adapter_id.to_owned(),
            model: config.model.clone(),
        });
        let helper_dir = self.cli_path.parent().unwrap_or(Path::new("/usr/bin"));
        let plan = plan_launch(&LaunchRequest {
            adapter: spec,
            config: &config,
            executable: &executable,
            helper: &self.cli_path,
            project_id,
            project_name: &name,
            project_root: &root,
            session_id: &session_id,
            socket_path: self.bridge.socket_path(),
            token: &token,
            profile: resolved.profile,
            path: &search.child_path(helper_dir),
            mode,
        })
        .inspect_err(|_| self.bridge.revoke(&session_id))?;
        Ok(Prepared {
            adapter_id: adapter_id.to_owned(),
            session_id,
            executable,
            model: config.model,
            resolved,
            root,
            plan,
        })
    }

    /// Prepare a non-interactive run of an adapter's CLI on one project,
    /// wired exactly as a terminal session is (grant with profile and model,
    /// MCP configuration, guidance), for a caller that spawns the CLI itself
    /// with pipes: write `files` (owner-only), apply `env` over the
    /// inherited environment after removing variables that start with
    /// `scrubbedPrefix` and adding `envDefaults` that are missing, run
    /// `executable` with `args` in `cwd`, write the prompt to its standard
    /// input and close it. Afterwards remove the files and revoke the
    /// session. Only adapters with a headless mode can be prepared.
    pub fn prepare_headless(
        &self,
        project_id: &str,
        input: &Value,
    ) -> Result<Value, ContractError> {
        let Prepared {
            adapter_id,
            session_id,
            executable,
            model,
            resolved,
            root,
            plan,
        } = self.prepare(project_id, input, LaunchMode::Headless)?;
        guide::sync_agents_md(&root, plan.agents_md).map_err(|error| {
            self.bridge.revoke(&session_id);
            failure(error)
        })?;
        let pairs = |entries: &[(String, String)]| {
            Value::Object(
                entries
                    .iter()
                    .map(|(key, value)| (key.clone(), json!(value)))
                    .collect(),
            )
        };
        Ok(json!({
            "projectId": project_id,
            "sessionId": session_id,
            "adapterId": adapter_id,
            "model": model,
            "profile": resolved.profile,
            "profileSource": resolved.source.as_str(),
            "toolCount": guide::tool_count(resolved.profile),
            "executable": executable,
            "args": plan.args,
            "cwd": plan.cwd,
            "env": pairs(&plan.env),
            "envDefaults": pairs(&plan.env_defaults),
            "scrubbedPrefix": session::SCRUBBED_PREFIX,
            "files": plan.files.iter().map(|file| json!({"path": file.path, "contents": file.contents})).collect::<Vec<_>>(),
            "stdin": "prompt",
            "agentsMd": plan.agents_md,
        }))
    }

    /// The size for a new session: what `terminal.start` asks for, else the
    /// size the project's terminal was last resized to, else 80 by 24.
    fn size_for(&self, project_id: &str, input: &Value) -> (u16, u16) {
        let asked = |key: &str| {
            input[key]
                .as_u64()
                .filter(|value| (1..=1000).contains(value))
                .map(|value| value as u16)
        };
        let remembered = self
            .sizes
            .lock()
            .ok()
            .and_then(|sizes| sizes.get(project_id).copied())
            .unwrap_or(DEFAULT_SIZE);
        let size = (
            asked("cols").unwrap_or(remembered.0),
            asked("rows").unwrap_or(remembered.1),
        );
        if let Ok(mut sizes) = self.sizes.lock() {
            sizes.insert(project_id.to_owned(), size);
        }
        size
    }

    pub fn connection_list(&self) -> Result<Value, ContractError> {
        let configs = {
            let core = self
                .core
                .lock()
                .map_err(|_| failure("Application state unavailable"))?;
            ADAPTERS
                .iter()
                .map(|spec| AdapterConfig::from_value(&core.adapter_config(spec.id)))
                .collect::<Vec<_>>()
        };
        // Never hold the workspace lock while probing an external
        // executable; probe them side by side so one slow CLI costs one
        // timeout, not six.
        let search = SearchPath::system();
        let adapters = thread::scope(|scope| {
            let probes = ADAPTERS
                .iter()
                .zip(&configs)
                .map(|(spec, config)| {
                    let search = &search;
                    scope.spawn(move || spec.status(config, &search.probe(spec, config)))
                })
                .collect::<Vec<_>>();
            probes
                .into_iter()
                .map(|probe| probe.join().map_err(|_| failure("Adapter probe failed")))
                .collect::<Result<Vec<_>, _>>()
        })?;
        Ok(json!({"adapters": adapters}))
    }

    pub fn connection_configure(&self, input: &Value) -> Result<Value, ContractError> {
        let id = input["adapterId"]
            .as_str()
            .ok_or_else(|| ContractError::validation("Missing adapterId"))?;
        if adapter(id).is_none() {
            return Err(unknown_adapter("NOT_FOUND", id));
        }
        if let Some(profile) = input["profile"].as_str() {
            profile.parse::<crate::ProfileSetting>()?;
        }
        self.core
            .lock()
            .map_err(|_| failure("Application state unavailable"))?
            .configure_adapter(id, input)?;
        Ok(json!({"ok":true}))
    }

    /// Check an adapter end to end as far as that is possible without
    /// starting the agent: the CLI answers its version probe, the bundled
    /// helper exists, and the helper reaches this app's bridge both ways an
    /// agent would use it. Each step is reported.
    pub fn connection_test(&self, project_id: &str, input: &Value) -> Result<Value, ContractError> {
        let id = input["adapterId"]
            .as_str()
            .ok_or_else(|| ContractError::validation("Missing adapterId"))?;
        let spec = adapter(id).ok_or_else(|| unknown_adapter("NOT_FOUND", id))?;
        let config = AdapterConfig::from_value(
            &self
                .core
                .lock()
                .map_err(|_| failure("Application state unavailable"))?
                .adapter_config(id),
        );
        let tested_at = now();
        let steps = self.test_steps(project_id, spec, &config);
        let failed = steps.iter().find(|step| step["ok"] == false);
        let outcome = match failed {
            Some(step) => json!({"ok": false, "error": step["detail"], "steps": steps}),
            None => json!({
                "ok": true,
                "detail": format!(
                    "{} answered and the bridge round trip succeeded. The CLI's own MCP start-up is exercised when a session starts.",
                    spec.label
                ),
                "steps": steps,
            }),
        };
        self.core.lock().map_err(|_| failure("Application state unavailable"))?.configure_adapter(id, &json!({"lastTestAt":tested_at,"lastTestOk":outcome["ok"],"lastError":outcome["error"]}))?;
        Ok(outcome)
    }

    fn test_steps(
        &self,
        project_id: &str,
        spec: &AdapterSpec,
        config: &AdapterConfig,
    ) -> Vec<Value> {
        let step =
            |id: &str, ok: bool, detail: String| json!({"step": id, "ok": ok, "detail": detail});
        let mut steps = Vec::new();
        let probe = SearchPath::system().probe(spec, config);
        let Some(executable) = &probe.executable else {
            steps.push(step(
                "executable",
                false,
                missing_executable(spec, config).message,
            ));
            return steps;
        };
        steps.push(step("executable", true, executable.display().to_string()));
        match &probe.version {
            Some(version) => steps.push(step("version", true, version.clone())),
            // A custom CLI is not required to answer a version probe.
            None if spec.executables.is_empty() => steps.push(step(
                "version",
                true,
                "No answer to the version probe; a custom CLI does not need one.".to_owned(),
            )),
            None => {
                steps.push(step(
                    "version",
                    false,
                    format!(
                        "{} did not answer `{}` within 2 seconds",
                        executable.display(),
                        spec.version_args.join(" ")
                    ),
                ));
                return steps;
            }
        }
        if !self.cli_path.is_file() {
            steps.push(step(
                "helper",
                false,
                format!(
                    "Omen Flow bridge helper missing: {}",
                    self.cli_path.display()
                ),
            ));
            return steps;
        }
        steps.push(step("helper", true, self.cli_path.display().to_string()));

        let resolved = resolve_profile(
            config.profile,
            config.model.as_deref(),
            &config.args,
            spec.default_profile,
        );
        let session_id = Uuid::new_v4().to_string();
        let token = self.bridge.issue_grant(Grant {
            project_id: project_id.to_owned(),
            session_id: session_id.clone(),
            profile: resolved.profile,
            // Recorded like any session, and named so the history does not
            // present a test as work done with the adapter.
            adapter_id: format!("connection-test:{}", spec.id),
            model: config.model.clone(),
        });
        let env = [
            ("OMENFLOW_BRIDGE_SOCK", self.bridge.socket_path()),
            ("OMENFLOW_BRIDGE_TOKEN", token.as_str()),
            ("OMENFLOW_PROJECT_ID", project_id),
            ("OMENFLOW_SESSION_ID", session_id.as_str()),
        ];
        // The helper runs where a session's CLI runs: in the project folder.
        let root = match self.core.lock() {
            Ok(core) => core.project_root(project_id).ok(),
            Err(_) => None,
        };
        let Some(root) = root else {
            steps.push(step("bridge", false, "The project is not open".to_owned()));
            self.bridge.revoke(&session_id);
            return steps;
        };
        let call =
            helper_call(&self.cli_path, &root, "project_summary", &env).and_then(|summary| {
                summary["project"]["name"]
                    .as_str()
                    .map(|name| format!("omenflow call reached project \"{name}\""))
                    .ok_or_else(|| "The helper did not return a project summary".to_owned())
            });
        let reached = call.is_ok();
        steps.push(step("bridge", reached, call.unwrap_or_else(|error| error)));
        if reached {
            let listed = helper_mcp_tool_count(&self.cli_path, &root, &env).map(|tools| {
                format!(
                    "omenflow mcp listed {tools} tools for the {} profile",
                    resolved.profile
                )
            });
            steps.push(step(
                "mcp",
                listed.is_ok(),
                listed.unwrap_or_else(|error| error),
            ));
        }
        self.bridge.revoke(&session_id);
        steps
    }

    pub fn write(&self, project_id: &str, data: &str) -> Result<Value, ContractError> {
        let session = self
            .session(project_id)
            .ok_or_else(|| ContractError::new("NOT_FOUND", "No running agent session"))?;
        let writer = {
            let session = session.lock().map_err(|_| failure("Session unavailable"))?;
            if session.info["state"] != "running" {
                return Err(ContractError::new("NOT_FOUND", "Agent session has ended"));
            }
            Arc::clone(&session.writer)
        };
        writer
            .lock()
            .map_err(|_| failure("Session unavailable"))?
            .write_all(data.as_bytes())
            .map_err(failure)?;
        Ok(json!({"ok":true}))
    }

    pub fn resize(&self, project_id: &str, cols: u16, rows: u16) -> Result<Value, ContractError> {
        let (cols, rows) = (cols.max(1), rows.max(1));
        // Remembered even with no session, so a resize that arrives before
        // the session exists still decides the size it starts with.
        if let Ok(mut sizes) = self.sizes.lock() {
            sizes.insert(project_id.to_owned(), (cols, rows));
        }
        if let Some(session) = self.session(project_id) {
            let mut state = session.lock().map_err(|_| failure("Session unavailable"))?;
            state
                .master
                .resize(PtySize {
                    cols,
                    rows,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(failure)?;
            state.info["cols"] = json!(cols);
            state.info["rows"] = json!(rows);
        }
        Ok(json!({"ok":true}))
    }

    pub fn interrupt(&self, project_id: &str) -> Result<Value, ContractError> {
        self.write(project_id, "\u{3}")
    }

    pub fn stop(&self, project_id: &str) -> Result<Value, ContractError> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| failure("Session lifecycle unavailable"))?;
        self.stop_inner(project_id)
    }

    pub fn close(&self, project_id: &str) -> Result<Value, ContractError> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| failure("Session lifecycle unavailable"))?;
        self.stop_inner(project_id)?;
        self.sessions
            .lock()
            .map_err(|_| failure("Sessions unavailable"))?
            .remove(project_id);
        Ok(json!({"ok": true}))
    }

    pub fn shutdown(&self) {
        let ids = self
            .sessions
            .lock()
            .map(|s| s.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for id in ids {
            let _ = self.close(&id);
        }
    }

    fn stop_inner(&self, project_id: &str) -> Result<Value, ContractError> {
        if let Some(session) = self.session(project_id) {
            let (session_id, running) = {
                let mut state = lock_session(&session);
                state.stopping = true;
                (
                    state.info["id"].as_str().map(str::to_owned),
                    state.info["state"] == "running",
                )
            };
            if let Some(id) = &session_id {
                self.bridge.revoke(id);
            }
            if running {
                terminate(&session, STOP_GRACE);
            }
            let mut state = lock_session(&session);
            state.plan.remove_files();
            if state.info["state"] == "running" {
                // The process is gone or beyond reach; its exit status may
                // still arrive and fill in the exit code.
                state.info["state"] = json!("exited");
                state.info["endedAt"] = json!(now());
            }
            state.info["waitingForReview"] = json!(false);
            let info = state.info.clone();
            drop(state);
            if running {
                self.persist(project_id, &info);
                (self.notify)(TerminalEvent::State(
                    json!({"projectId":project_id,"session":info}),
                ));
            }
        }
        Ok(json!({"ok":true}))
    }

    /// Start again with what the last session was started with. When the CLI
    /// can resume a conversation by id and the last session actually talked
    /// to Omen Flow, the conversation continues; otherwise it starts fresh.
    pub fn restart(&self, project_id: &str) -> Result<Value, ContractError> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| failure("Session lifecycle unavailable"))?;
        let (input, conversation) = {
            let session = self
                .session(project_id)
                .ok_or_else(|| ContractError::validation("No session to restart"))?;
            let state = session.lock().map_err(|_| failure("Session unavailable"))?;
            // The ledger, not the last state event, says whether the agent
            // ever reached Omen Flow, and so whether a conversation exists.
            let resumable = state.info["id"]
                .as_str()
                .is_some_and(|id| self.bridge.session_activity(id).calls > 0);
            (
                state.last_start.clone(),
                state.plan.conversation_id.clone().filter(|_| resumable),
            )
        };
        self.start_session(project_id, &input, conversation.as_deref())
    }

    /// True while this project's agent terminal session is running.
    pub fn running(&self, project_id: &str) -> bool {
        self.session(project_id)
            .is_some_and(|session| session.lock().is_ok_and(|s| s.info["state"] == "running"))
    }

    pub fn state(&self, project_id: &str) -> Value {
        let Some(session) = self.session(project_id) else {
            return json!({"session":null});
        };
        let Ok(mut state) = session.lock() else {
            return json!({"session":null});
        };
        if state.info["state"] == "running" {
            if let Some(id) = state.info["id"].as_str().map(str::to_owned) {
                apply_activity(&mut state.info, self.bridge.session_activity(&id));
            }
        }
        let mut info = state.info.clone();
        info["scrollback"] = json!(state.scrollback);
        info["scrollbackCursor"] = json!(state.cursor);
        json!({"session":info})
    }

    fn session(&self, project_id: &str) -> Option<Arc<Mutex<Session>>> {
        self.sessions.lock().ok()?.get(project_id).cloned()
    }

    fn persist(&self, project_id: &str, info: &Value) {
        if let Ok(core) = self.core.lock() {
            let _ = core.upsert_session(project_id, info);
        }
    }
}

impl Drop for PtyHost {
    fn drop(&mut self) {
        let sessions = self
            .sessions
            .lock()
            .map(|sessions| sessions.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for session in sessions {
            let running = {
                let mut state = lock_session(&session);
                state.stopping = true;
                if let Some(id) = state.info["id"].as_str() {
                    self.bridge.revoke(id);
                }
                state.plan.remove_files();
                state.info["state"] == "running"
            };
            if running {
                terminate(&session, STOP_GRACE);
            }
        }
    }
}

fn known_adapter(id: &str) -> Result<&'static AdapterSpec, ContractError> {
    adapter(id).ok_or_else(|| unknown_adapter("VALIDATION", id))
}

fn unknown_adapter(code: &str, id: &str) -> ContractError {
    let known = ADAPTERS.iter().map(|spec| spec.id).collect::<Vec<_>>();
    ContractError::new(code, format!("Unknown adapter: {id}"))
        .with_repair(format!("Use one of: {}.", known.join(", ")))
        .with_details(json!({"adapters": known}))
}

fn missing_executable(spec: &AdapterSpec, config: &AdapterConfig) -> ContractError {
    let message = match (&config.executable_path, spec.executables.first()) {
        (Some(path), _) => format!("Executable not found: {path}"),
        (None, Some(name)) => format!("{name} not found on PATH"),
        (None, None) => "No executable path is set".to_owned(),
    };
    ContractError::new("TOOL_MISSING", message)
        .with_repair(format!(
            "{} Then start the session again.",
            spec.install_hint
        ))
        .with_details(json!({"adapterId": spec.id}))
}

fn apply_activity(info: &mut Value, activity: SessionActivity) {
    info["calls"] = json!(activity.calls);
    info["errors"] = json!(activity.errors);
    info["waitingForReview"] = json!(activity.waiting_for_review);
}

/// What to say about a CLI that ended on its own without success.
fn exit_error(status: &std::io::Result<portable_pty::ExitStatus>) -> Option<String> {
    match status {
        Ok(status) if status.success() => None,
        Ok(status) => Some(match status.signal() {
            Some(signal) => format!("The agent CLI was ended by signal {signal}"),
            None => format!("The agent CLI exited with code {}", status.exit_code()),
        }),
        Err(error) => Some(format!(
            "The agent CLI's exit could not be observed: {error}"
        )),
    }
}

/// Bring a session's counters and review state up to date after the bridge
/// reported activity, and tell the interface. A change of review state is
/// sent at once; counter changes are sent at most once per interval, and
/// the last one is never dropped.
fn pulse(
    sessions: &Sessions,
    bridge: &Weak<BridgeServer>,
    notify: &Notify,
    project_id: &str,
    session_id: &str,
) {
    let Some(session) = sessions
        .lock()
        .ok()
        .and_then(|sessions| sessions.get(project_id).cloned())
    else {
        return;
    };
    let Some(live) = bridge.upgrade() else {
        return;
    };
    let Ok(mut state) = session.lock() else {
        return;
    };
    if state.info["id"] != session_id || state.info["state"] != "running" {
        return;
    }
    let activity = live.session_activity(session_id);
    let review_changed = state.info["waitingForReview"] != activity.waiting_for_review;
    apply_activity(&mut state.info, activity);
    let since = state.last_pulse.elapsed();
    if review_changed || since >= PULSE_INTERVAL {
        state.last_pulse = Instant::now();
        let info = state.info.clone();
        drop(state);
        notify(TerminalEvent::State(
            json!({"projectId": project_id, "session": info}),
        ));
    } else if !state.pulse_pending {
        state.pulse_pending = true;
        drop(state);
        let (session, bridge, notify) = (Arc::clone(&session), bridge.clone(), Arc::clone(notify));
        let (project_id, session_id) = (project_id.to_owned(), session_id.to_owned());
        thread::spawn(move || {
            thread::sleep(PULSE_INTERVAL - since);
            let (Some(live), Ok(mut state)) = (bridge.upgrade(), session.lock()) else {
                return;
            };
            state.pulse_pending = false;
            if state.info["state"] != "running" {
                return;
            }
            apply_activity(&mut state.info, live.session_activity(&session_id));
            state.last_pulse = Instant::now();
            let info = state.info.clone();
            drop(state);
            notify(TerminalEvent::State(
                json!({"projectId": project_id, "session": info}),
            ));
        });
    }
}

/// A session's state, also after a thread panicked while holding it: what
/// the panic interrupted is only the scrollback or the counters, and a
/// session that cannot be locked could never be stopped or closed again.
fn lock_session(session: &Mutex<Session>) -> MutexGuard<'_, Session> {
    session.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Ask a session's process group to end, wait `grace` for it, then kill
/// what is left of the group. The exit itself is observed by the thread that
/// waits on the child, which marks the session exited; this waits for that
/// mark. The waiter drains the rest of the group before reaping the leader,
/// including workers that outlive the CLI when it exits on its own.
fn terminate(session: &Arc<Mutex<Session>>, grace: Duration) {
    let deadline = Instant::now() + grace;
    let wait_for = |done: &dyn Fn() -> bool, deadline: Instant| loop {
        if done() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(15));
    };
    let exited = || lock_session(session).info["state"] != "running";
    {
        let state = lock_session(session);
        let Some(pid) = state.process_group else {
            return;
        };
        signal_group(u64::from(pid), false);
    }
    // The waiter drains the group before reaping the leader and publishing
    // its exit. A cooperative leader therefore still ends at once.
    if wait_for(&exited, deadline) {
        return;
    }
    {
        let mut state = lock_session(session);
        if let Some(pid) = state.process_group {
            signal_group(u64::from(pid), true);
            let _ = state.killer.kill();
        }
    }
    wait_for(&exited, Instant::now() + KILL_WAIT);
}

/// Observe the leader's exit without reaping it, then end anything still in
/// its group. The unreaped leader reserves the PID even if every worker has
/// already gone. Clearing ownership under the same lock used by `terminate`
/// ensures no stop, close or drop can signal that ID after `child.wait()`.
#[cfg(unix)]
fn finish_process_group(session: &Arc<Mutex<Session>>, pid: Option<u32>) {
    let Some(pid) = pid else { return };
    let observed = loop {
        let mut status = std::mem::MaybeUninit::<libc::siginfo_t>::uninit();
        // SAFETY: waitid initialises status, which is not read here. WNOWAIT
        // deliberately leaves this thread's child for portable-pty to reap.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                status.as_mut_ptr(),
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        if result == 0 {
            break true;
        }
        if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            // If observing the child failed, there is no safe basis for
            // signalling its numeric group ID. Let wait report the error.
            break false;
        }
    };
    let mut state = lock_session(session);
    if state.process_group.take() == Some(pid) && observed {
        // The CLI has finished; its orphaned workers must not keep running
        // against a project or keep the PTY reader alive after that session.
        signal_group(u64::from(pid), true);
    }
}

/// Signal everything the agent started. portable-pty starts the child with
/// `setsid()`, so its pid is the id of its process group.
fn signal_group(pid: u64, force: bool) {
    #[cfg(unix)]
    // SAFETY: `kill` takes plain integers and reports failure through its
    // return value; a group that no longer exists is not an error here.
    unsafe {
        libc::kill(
            -(pid as i32),
            if force { libc::SIGKILL } else { libc::SIGTERM },
        );
    }
    #[cfg(windows)]
    {
        let mut command = std::process::Command::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/T"]);
        if force {
            command.arg("/F");
        }
        let _ = command.status();
    }
}

/// Decodes a byte stream as UTF-8 without splitting characters: a sequence
/// cut by a read boundary is held back until the rest arrives. Bytes that
/// are not UTF-8 at all become U+FFFD, once each.
#[derive(Default)]
struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut text = String::with_capacity(self.pending.len());
        let mut rest = self.pending.as_slice();
        loop {
            match std::str::from_utf8(rest) {
                Ok(valid) => {
                    text.push_str(valid);
                    rest = &[];
                    break;
                }
                Err(error) => {
                    let (valid, after) = rest.split_at(error.valid_up_to());
                    text.push_str(&String::from_utf8_lossy(valid));
                    match error.error_len() {
                        Some(invalid) => {
                            text.push(char::REPLACEMENT_CHARACTER);
                            rest = &after[invalid..];
                        }
                        // The start of a character whose end has not come.
                        None => {
                            rest = after;
                            break;
                        }
                    }
                }
            }
        }
        self.pending = rest.to_vec();
        text
    }

    /// What is left when the stream ends: an unfinished character, if any.
    fn finish(&mut self) -> String {
        let rest = std::mem::take(&mut self.pending);
        String::from_utf8_lossy(&rest).into_owned()
    }
}

/// Keep the scrollback near its cap by dropping its oldest text, cutting
/// where a replay can begin cleanly.
fn trim_scrollback(scrollback: &mut String) {
    if scrollback.len() <= SCROLLBACK_CAP + SCROLLBACK_SLACK {
        return;
    }
    let cut = safe_cut(scrollback, scrollback.len() - SCROLLBACK_CAP);
    scrollback.drain(..cut);
}

/// The first position at or after `from` where terminal output can be
/// replayed from: not inside a character or an escape sequence, and at the
/// start of a line when one begins nearby. A full-screen program may print
/// no line breaks; then the next escape sequence is a clean start.
fn safe_cut(text: &str, from: usize) -> usize {
    let bytes = text.as_bytes();
    let mut cut = from.min(bytes.len());
    while !text.is_char_boundary(cut) {
        cut += 1;
    }
    cut = escape_end(bytes, cut).unwrap_or(cut);
    while !text.is_char_boundary(cut) {
        cut += 1;
    }
    let mut window = (cut + TRIM_WINDOW).min(bytes.len());
    while !text.is_char_boundary(window) {
        window -= 1;
    }
    let near = &text[cut..window];
    if let Some(newline) = near.find('\n') {
        cut + newline + 1
    } else if let Some(escape) = near.find('\u{1b}') {
        cut + escape
    } else {
        cut
    }
}

/// If `at` falls inside an escape sequence, the position just after it.
fn escape_end(bytes: &[u8], at: usize) -> Option<usize> {
    let start = bytes[at.saturating_sub(64)..at]
        .iter()
        .rposition(|byte| *byte == 0x1b)
        .map(|offset| at.saturating_sub(64) + offset)?;
    let end = match bytes.get(start + 1)? {
        // Control sequence: parameters and intermediates, then one final byte.
        b'[' => {
            let body = bytes[start + 2..]
                .iter()
                .position(|byte| (0x40..=0x7e).contains(byte))?;
            start + 2 + body + 1
        }
        // Operating system command: ends with BEL or ESC \.
        b']' => {
            let body = &bytes[start + 2..];
            let bell = body
                .iter()
                .position(|byte| *byte == 0x07)
                .map(|end| end + 1);
            let terminator = body
                .windows(2)
                .position(|pair| pair == b"\x1b\\")
                .map(|end| end + 2);
            start + 2 + [bell, terminator].into_iter().flatten().min()?
        }
        // Two-byte escape: ESC and one ASCII byte. ESC before anything else
        // (a character that is not ASCII, say) stands alone.
        next if next.is_ascii() => start + 2,
        _ => start + 1,
    };
    (end > at).then_some(end)
}

fn read_loop(
    mut reader: Box<dyn Read + Send>,
    session: Arc<Mutex<Session>>,
    project_id: String,
    notify: Notify,
) {
    let mut decoder = Utf8Stream::default();
    let mut buffer = [0_u8; 8192];
    let deliver = |chunk: String| {
        if chunk.is_empty() {
            return true;
        }
        let Ok(mut state) = session.lock() else {
            return false;
        };
        state.cursor += 1;
        state.scrollback.push_str(&chunk);
        trim_scrollback(&mut state.scrollback);
        let (session_id, seq) = (state.info["id"].clone(), state.cursor);
        drop(state);
        notify(TerminalEvent::Data(
            json!({"projectId":project_id,"sessionId":session_id,"chunk":chunk,"seq":seq}),
        ));
        true
    };
    while let Ok(count) = reader.read(&mut buffer) {
        if count == 0 || !deliver(decoder.push(&buffer[..count])) {
            break;
        }
    }
    deliver(decoder.finish());
}

/// The bundled helper, running with a session's credentials. Its output is
/// read line by line on other threads, so a helper that hangs can be given
/// up on and killed.
struct HelperRun {
    child: std::process::Child,
    input: Option<std::process::ChildStdin>,
    lines: std::sync::mpsc::Receiver<String>,
    errors: std::sync::mpsc::Receiver<String>,
    deadline: Instant,
}

impl HelperRun {
    fn start(
        helper: &Path,
        cwd: &Path,
        args: &[&str],
        env: &[(&str, &str)],
        input: &str,
    ) -> Result<Self, String> {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};
        let mut child = Command::new(helper)
            .current_dir(cwd)
            .args(args)
            .envs(env.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Could not start the helper: {error}"))?;
        let (line_sender, lines) = std::sync::mpsc::channel();
        if let Some(stdout) = child.stdout.take() {
            thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if line_sender.send(line).is_err() {
                        break;
                    }
                }
            });
        }
        let (error_sender, errors) = std::sync::mpsc::channel();
        if let Some(stderr) = child.stderr.take() {
            thread::spawn(move || {
                let mut text = String::new();
                let _ = stderr.take(64 * 1024).read_to_string(&mut text);
                let _ = error_sender.send(text);
            });
        }
        let mut run = Self {
            input: child.stdin.take(),
            child,
            lines,
            errors,
            deadline: Instant::now() + HELPER_TIMEOUT,
        };
        if let Some(stdin) = run.input.as_mut() {
            // A helper that refused the handshake has already gone; its
            // error output says why.
            let _ = stdin.write_all(input.as_bytes());
        }
        Ok(run)
    }

    /// The next output line, or `None` once the output ended or time ran out.
    fn next_line(&mut self) -> Option<String> {
        self.lines
            .recv_timeout(self.deadline.saturating_duration_since(Instant::now()))
            .ok()
    }

    /// Close the helper's input and wait for it to exit; kill it if it does
    /// not. Returns whether it exited successfully, and what it reported.
    fn finish(mut self) -> (bool, String) {
        self.input = None;
        let success = loop {
            match self.child.try_wait() {
                Ok(Some(status)) => break status.success(),
                Ok(None) if Instant::now() < self.deadline => {
                    thread::sleep(Duration::from_millis(10));
                }
                _ => {
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    break false;
                }
            }
        };
        let reported = self
            .errors
            .recv_timeout(Duration::from_secs(1))
            .unwrap_or_default();
        (success, reported.trim().to_owned())
    }
}

/// What the helper reported when it failed: the message of its JSON error
/// when it printed one, else its raw text.
fn helper_failure(reported: &str) -> String {
    let message = reported.lines().rev().find_map(|line| {
        let error: Value = serde_json::from_str(line).ok()?;
        error["error"]["message"].as_str().map(str::to_owned)
    });
    match (message, reported) {
        (Some(message), _) => message,
        (None, "") => "The helper failed without saying why".to_owned(),
        (None, text) => text.to_owned(),
    }
}

/// `omenflow call <tool>`: one request, one result on standard output.
fn helper_call(
    helper: &Path,
    cwd: &Path,
    tool: &str,
    env: &[(&str, &str)],
) -> Result<Value, String> {
    let mut run = HelperRun::start(helper, cwd, &["call", tool, "--input", "-"], env, "{}\n")?;
    run.input = None;
    let mut output = String::new();
    while let Some(line) = run.next_line() {
        output.push_str(&line);
        output.push('\n');
    }
    match run.finish() {
        (true, _) => serde_json::from_str(output.trim())
            .map_err(|_| "The helper did not print a JSON result".to_owned()),
        (false, reported) => Err(helper_failure(&reported)),
    }
}

/// `omenflow mcp`: initialise and list the tools, as an agent CLI would.
/// The helper stops when its input closes, so the input stays open until
/// the listing has arrived.
fn helper_mcp_tool_count(helper: &Path, cwd: &Path, env: &[(&str, &str)]) -> Result<usize, String> {
    let requests = concat!(
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"omenflow-connection-test","version":"1"}}}"#,
        "\n",
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        "\n",
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
        "\n"
    );
    let mut run = HelperRun::start(helper, cwd, &["mcp"], env, requests)?;
    let mut listed = None;
    while let Some(line) = run.next_line() {
        let reply: Value = serde_json::from_str(&line).unwrap_or_default();
        if let Some(tools) = reply["result"]["tools"].as_array() {
            listed = Some(tools.len());
            break;
        }
    }
    let (_, reported) = run.finish();
    listed.ok_or_else(|| match reported.as_str() {
        "" => "The helper did not answer tools/list over MCP".to_owned(),
        text => helper_failure(text),
    })
}

fn failure(error: impl std::fmt::Display) -> ContractError {
    ContractError::new("INTERNAL", error.to_string())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::test_support::{McpClient, Workspace};
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::mpsc::Receiver;

    /// Generous: thirteen builds may share this machine.
    const WAIT: Duration = Duration::from_secs(20);

    struct Terminal {
        host: PtyHost,
        events: Receiver<TerminalEvent>,
        output: String,
        states: Vec<Value>,
        workspace: Workspace,
    }

    impl Terminal {
        fn new(name: &str) -> Self {
            Self::with_helper(name, PathBuf::from("/bin/echo"))
        }

        fn with_helper(name: &str, helper: PathBuf) -> Self {
            let workspace = Workspace::new(name);
            let (sender, events) = std::sync::mpsc::channel();
            let host = PtyHost::new(
                Arc::clone(&workspace.core),
                Arc::clone(&workspace.bridge),
                helper,
                Arc::new(move |event| {
                    let _ = sender.send(event);
                }),
            );
            Self {
                host,
                events,
                output: String::new(),
                states: Vec::new(),
                workspace,
            }
        }

        fn project(&self) -> &str {
            &self.workspace.project_id
        }

        fn configure(&self, adapter_id: &str, config: Value) {
            self.workspace
                .core
                .lock()
                .unwrap()
                .configure_adapter(adapter_id, &config)
                .unwrap();
        }

        /// A stand-in CLI: an executable shell script in the temp folder.
        fn script(&self, name: &str, body: &str) -> String {
            let path = self.workspace.temp.path().join(name);
            fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            path.to_string_lossy().into_owned()
        }

        /// Start the custom adapter running a shell command.
        fn shell(&self, command: &str, extra: Value) -> Value {
            self.configure("custom", json!({"executablePath": "/bin/sh"}));
            let mut input = json!({"adapterId": "custom", "args": ["-c", command]});
            for (key, value) in extra.as_object().unwrap() {
                input[key] = value.clone();
            }
            self.host.start(self.project(), &input).unwrap()
        }

        /// Take events until `done` holds for the output and states so far.
        fn pump(&mut self, mut done: impl FnMut(&str, &[Value]) -> bool) -> bool {
            let deadline = Instant::now() + WAIT;
            loop {
                if done(&self.output, &self.states) {
                    return true;
                }
                match self
                    .events
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                {
                    Ok(TerminalEvent::Data(data)) => {
                        self.output.push_str(data["chunk"].as_str().unwrap());
                    }
                    Ok(TerminalEvent::State(state)) => self.states.push(state),
                    Err(_) => return false,
                }
            }
        }

        fn wait_output(&mut self, needle: &str) {
            assert!(
                self.pump(|output, _| output.contains(needle)),
                "no {needle:?} in terminal output: {:?}",
                self.output
            );
        }

        fn wait_state(&mut self, wanted: impl Fn(&Value) -> bool) -> Value {
            let found = self.pump(|_, states| states.iter().any(|state| wanted(&state["session"])));
            assert!(found, "no such state among {:?}", self.states);
            self.states
                .iter()
                .rev()
                .find(|state| wanted(&state["session"]))
                .unwrap()["session"]
                .clone()
        }

        fn session(&self) -> Value {
            self.host.state(self.project())["session"].clone()
        }

        fn work_file(&self, session: &Value, name: &str) -> PathBuf {
            crate::work_dir(&self.workspace.root(), session["id"].as_str().unwrap()).join(name)
        }
    }

    fn alive(pid: u64) -> bool {
        // SAFETY: signal 0 only asks whether the process exists.
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    #[test]
    fn a_character_split_across_reads_is_never_broken() {
        let text = "naïve ─┼─ 測試 🚀 done";
        let bytes = text.as_bytes();
        for split in 0..=bytes.len() {
            let mut stream = Utf8Stream::default();
            let mut decoded = stream.push(&bytes[..split]);
            decoded.push_str(&stream.push(&bytes[split..]));
            decoded.push_str(&stream.finish());
            assert_eq!(decoded, text, "split at byte {split}");
        }
        // One byte at a time, as a slow terminal delivers it.
        let mut stream = Utf8Stream::default();
        let decoded = bytes
            .iter()
            .map(|byte| stream.push(&[*byte]))
            .collect::<String>();
        assert_eq!(decoded, text);
        assert!(!decoded.contains(char::REPLACEMENT_CHARACTER));
        assert_eq!(stream.finish(), "");
    }

    #[test]
    fn bytes_that_are_not_utf8_are_replaced_once_and_the_stream_goes_on() {
        let mut stream = Utf8Stream::default();
        assert_eq!(
            stream.push(b"ok \xff\xfe then "),
            "ok \u{fffd}\u{fffd} then "
        );
        // A lead byte followed by something that cannot continue it.
        assert_eq!(stream.push(b"\xe6A"), "\u{fffd}A");
        // An unfinished character at the very end is flushed, not lost.
        assert_eq!(stream.push(b"end \xe6\xb8"), "end ");
        assert_eq!(stream.finish(), "\u{fffd}");
        assert_eq!(stream.finish(), "");
    }

    #[test]
    fn scrollback_is_cut_at_a_line_start_or_an_escape_sequence() {
        let lines = "0123456789 αβγ\n".repeat(40);
        for from in 0..lines.len() - 40 {
            let cut = safe_cut(&lines, from);
            assert!(cut >= from && lines.is_char_boundary(cut));
            assert!(
                cut == 0 || lines.as_bytes()[cut - 1] == b'\n',
                "cut {cut} from {from}"
            );
        }
        // A full-screen redraw has no line breaks: start at an escape.
        let redraw = "\u{1b}[2J\u{1b}[1;1Hframe one\u{1b}[38;5;196mred\u{1b}[0m tail";
        for from in 0..redraw.len() {
            let cut = safe_cut(redraw, from);
            let rest = &redraw[cut..];
            assert!(
                rest.is_empty() || rest.starts_with('\u{1b}') || !rest.contains('\u{1b}'),
                "from {from} the replay would start inside {rest:?}"
            );
            // Never inside the parameters of a control sequence.
            assert!(
                !rest.starts_with(|c: char| c.is_ascii_digit() || c == ';' || c == '['),
                "{rest:?}"
            );
        }
        // An operating-system command (a window title) is skipped whole.
        let title = "\u{1b}]0;Omen Flow\u{7}after";
        assert_eq!(&title[safe_cut(title, 5)..], "after");
        let st = "\u{1b}]8;;https://example.com\u{1b}\\link";
        assert_eq!(&st[safe_cut(st, 9)..], "link");

        // ESC before a character that is not ASCII is no sequence: the cut
        // never lands inside the character.
        let lone = format!("{}\u{1b}é{}", "x".repeat(100), "y".repeat(100));
        for from in 95..110 {
            let cut = safe_cut(&lone, from);
            assert!(lone.is_char_boundary(cut), "cut {cut} from {from}");
        }
        // The trim of a full scrollback starts right after such an ESC.
        let mut scrollback = format!(
            "{}\u{1b}é{}",
            "x".repeat(SCROLLBACK_SLACK),
            "y".repeat(SCROLLBACK_CAP - 2)
        );
        trim_scrollback(&mut scrollback);
        assert!(scrollback.starts_with('é'), "{:?}", &scrollback[..8]);

        let mut scrollback = "x".repeat(SCROLLBACK_CAP + SCROLLBACK_SLACK);
        trim_scrollback(&mut scrollback);
        assert_eq!(
            scrollback.len(),
            SCROLLBACK_CAP + SCROLLBACK_SLACK,
            "within the slack nothing moves"
        );
        scrollback.push_str("\nlast line\n");
        trim_scrollback(&mut scrollback);
        assert!(scrollback.len() <= SCROLLBACK_CAP);
        assert!(scrollback.ends_with("\nlast line\n"));
    }

    #[test]
    fn a_session_streams_output_and_reports_what_it_was_started_with() {
        let mut terminal = Terminal::new("PTY");
        terminal.configure("custom", json!({"executablePath": "/bin/cat"}));
        let project = terminal.project().to_owned();
        let session = terminal
            .host
            .start(&project, &json!({"adapterId": "custom"}))
            .unwrap();
        assert_eq!(session["state"], "running");
        assert_eq!(session["adapterId"], "custom");
        assert_eq!(session["executablePath"], "/bin/cat");
        assert_eq!(
            (&session["cols"], &session["rows"]),
            (&json!(80), &json!(24))
        );
        assert_eq!(session["model"], Value::Null);
        assert_eq!(session["profile"], "compact");
        assert_eq!(session["profileSource"], "adapter-default");
        assert_eq!(session["toolCount"], 13);
        assert_eq!(
            (&session["calls"], &session["errors"]),
            (&json!(0), &json!(0))
        );
        assert_eq!(session["waitingForReview"], false);
        assert_eq!(session["lastError"], Value::Null);

        terminal
            .host
            .write(&project, "PTY ─ roundtrip ✓\n")
            .unwrap();
        terminal.wait_output("PTY ─ roundtrip ✓");
        assert!(terminal.session()["scrollback"]
            .as_str()
            .unwrap()
            .contains("PTY ─ roundtrip ✓"));
        terminal.host.stop(&project).unwrap();
        let stopped = terminal.session();
        assert_eq!(stopped["state"], "exited");
        assert_eq!(
            stopped["lastError"],
            Value::Null,
            "a requested stop is not a failure"
        );
        assert!(stopped["endedAt"].is_string());
        assert!(terminal.host.write(&project, "lost input").is_err());

        let restarted = terminal
            .host
            .start(&project, &json!({"adapterId": "custom"}))
            .unwrap();
        assert_ne!(session["id"], restarted["id"]);
        terminal.wait_state(|state| state["id"] == restarted["id"]);
        // Give the stopped child's exit time to arrive, then take every
        // event that did.
        thread::sleep(Duration::from_millis(300));
        while let Ok(event) = terminal.events.try_recv() {
            if let TerminalEvent::State(state) = event {
                terminal.states.push(state);
            }
        }
        let replacement = terminal
            .states
            .iter()
            .position(|state| state["session"]["id"] == restarted["id"])
            .unwrap();
        assert!(
            terminal.states[replacement..]
                .iter()
                .all(|state| state["session"]["id"] == restarted["id"]),
            "the old child's exit must not overwrite the new session"
        );
        terminal.host.close(&project).unwrap();
        assert!(terminal.session().is_null());
        assert!(terminal.host.write(&project, "lost input").is_err());
    }

    #[test]
    fn a_session_starts_at_the_size_the_view_already_has() {
        let mut terminal = Terminal::new("Size");
        let asked = terminal.shell("stty size; sleep 30", json!({"cols": 132, "rows": 43}));
        assert_eq!((&asked["cols"], &asked["rows"]), (&json!(132), &json!(43)));
        terminal.wait_output("43 132");

        // A resize that arrives while no session runs decides the next one.
        let project = terminal.project().to_owned();
        terminal.host.close(&project).unwrap();
        terminal.output.clear();
        terminal.host.resize(&project, 100, 30).unwrap();
        let remembered = terminal.shell("stty size; sleep 30", json!({}));
        assert_eq!(
            (&remembered["cols"], &remembered["rows"]),
            (&json!(100), &json!(30))
        );
        terminal.wait_output("30 100");

        // And a live resize reaches the running program.
        terminal.host.resize(&project, 90, 20).unwrap();
        assert_eq!(terminal.session()["cols"], 90);
        terminal.host.close(&project).unwrap();
        terminal.output.clear();
        let nonsense = terminal.shell("stty size; sleep 30", json!({"cols": 0, "rows": 100000}));
        assert_eq!(
            (&nonsense["cols"], &nonsense["rows"]),
            (&json!(90), &json!(20))
        );
        terminal.wait_output("20 90");
    }

    #[test]
    fn stop_ends_everything_the_agent_started() {
        let mut terminal = Terminal::new("Group");
        let marker = terminal.workspace.temp.path().join("child-survived");
        terminal.configure(
            "custom",
            json!({"executablePath": "/bin/sh", "env": {"MARKER_FILE": marker}}),
        );
        let project = terminal.project().to_owned();
        terminal
            .host
            .start(
                &project,
                &json!({"adapterId": "custom", "args": ["-c", "(sleep 1; touch \"$MARKER_FILE\") & echo \"READY $MARKER_FILE\"; wait"]}),
            )
            .unwrap();
        // The marker path reached the child, so its absence later means the
        // background process was stopped, not that it never knew the path.
        terminal.wait_output(&format!("READY {}", marker.display()));
        let started = Instant::now();
        terminal.host.shutdown();
        assert!(
            started.elapsed() < STOP_GRACE,
            "a cooperative session ends at once"
        );
        assert!(terminal.session().is_null());
        thread::sleep(Duration::from_millis(1500));
        assert!(
            !marker.exists(),
            "a process the agent started survived the stop"
        );
    }

    #[test]
    fn stop_kills_a_session_that_ignores_the_request() {
        let mut terminal = Terminal::new("Stubborn");
        let session = terminal.shell(
            "trap '' TERM HUP; echo READY; while :; do sleep 0.1; done",
            json!({}),
        );
        let pid = session["pid"].as_u64().unwrap();
        terminal.wait_output("READY");
        assert!(alive(pid));
        let project = terminal.project().to_owned();
        let started = Instant::now();
        terminal.host.stop(&project).unwrap();
        let took = started.elapsed();
        assert!(
            took >= STOP_GRACE,
            "the session was given its grace period: {took:?}"
        );
        assert!(
            took < STOP_GRACE + KILL_WAIT + Duration::from_secs(5),
            "{took:?}"
        );
        assert!(!alive(pid), "the session outlived the stop");
        let stopped = terminal.session();
        assert_eq!(stopped["state"], "exited");
        assert_eq!(stopped["lastError"], Value::Null);
    }

    /// A process of the agent's group that ignores the request to end is
    /// killed with the group, even when the CLI itself ended at once.
    #[test]
    fn stop_kills_what_is_left_of_the_group_after_the_cli_ends() {
        let mut terminal = Terminal::new("Leftover");
        terminal.shell(
            "sh -c 'trap \"\" TERM HUP; echo IGNORING; exec sleep 333' & echo \"READY $!\"; wait",
            json!({}),
        );
        terminal.wait_output("READY ");
        // The request to end comes only once the process ignores it.
        terminal.wait_output("IGNORING");
        let pid = terminal
            .output
            .split("READY ")
            .nth(1)
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|pid| pid.parse::<u64>().ok())
            .expect("the background pid");
        assert!(alive(pid));
        let project = terminal.project().to_owned();
        terminal.host.stop(&project).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive(pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(
            !alive(pid),
            "a process of the session's group survived the stop"
        );
        assert_eq!(terminal.session()["state"], "exited");
    }

    #[test]
    fn a_natural_exit_drains_workers_before_stop_restart_or_close() {
        for action in ["stop", "restart", "close"] {
            let mut terminal = Terminal::new(&format!("Natural exit {action}"));
            let pid_file = terminal.workspace.temp.path().join("worker.pid");
            terminal.configure(
                "custom",
                json!({"executablePath": "/bin/sh", "env": {"WORKER_PID": pid_file}}),
            );
            let project = terminal.project().to_owned();
            let first = terminal
                .host
                .start(
                    &project,
                    &json!({"adapterId": "custom", "args": ["-c", concat!(
                        "sh -c 'trap \"\" HUP TERM; echo $$ > \"$WORKER_PID\"; exec sleep 333' & ",
                        "while [ ! -s \"$WORKER_PID\" ]; do sleep 0.01; done; ",
                        "echo READY; exit 0"
                    )]}),
                )
                .unwrap();
            terminal.wait_output("READY");
            let pid = fs::read_to_string(&pid_file)
                .unwrap()
                .trim()
                .parse::<u64>()
                .unwrap();
            terminal.wait_state(|state| state["id"] == first["id"] && state["state"] == "exited");
            let session = terminal.host.session(&project).unwrap();
            assert!(
                lock_session(&session).process_group.is_none(),
                "an ended session must release its numeric group before another lifecycle operation"
            );
            match action {
                "stop" => {
                    terminal.host.stop(&project).unwrap();
                }
                "restart" => {
                    // The replacement must not be signalled by cleanup of
                    // the old session, and its own worker must end too.
                    fs::remove_file(&pid_file).unwrap();
                    let replacement = terminal.host.restart(&project).unwrap();
                    assert_ne!(replacement["id"], first["id"]);
                    terminal.wait_state(|state| {
                        state["id"] == replacement["id"] && state["state"] == "exited"
                    });
                    let next_pid = fs::read_to_string(&pid_file)
                        .unwrap()
                        .trim()
                        .parse::<u64>()
                        .unwrap();
                    let deadline = Instant::now() + Duration::from_secs(5);
                    while alive(next_pid) && Instant::now() < deadline {
                        thread::sleep(Duration::from_millis(20));
                    }
                    assert!(!alive(next_pid), "the replacement left a worker behind");
                }
                "close" => {
                    terminal.host.close(&project).unwrap();
                    assert!(terminal.session().is_null());
                }
                _ => unreachable!(),
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            while alive(pid) && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(20));
            }
            assert!(
                !alive(pid),
                "a naturally ended CLI left a worker after {action}"
            );
        }
    }

    #[test]
    fn a_stopped_session_records_no_exit_code_it_never_had() {
        let mut terminal = Terminal::new("Stopped");
        let session = terminal.shell("echo READY; sleep 30", json!({}));
        terminal.wait_output("READY");
        let project = terminal.project().to_owned();
        terminal.host.stop(&project).unwrap();
        // The stop waits for the exit to be observed, so the status is final.
        let stopped = terminal.session();
        assert_eq!(stopped["id"], session["id"]);
        assert_eq!(stopped["state"], "exited");
        assert_eq!(stopped["exitCode"], Value::Null, "{stopped}");
        assert_eq!(stopped["lastError"], Value::Null);
    }

    #[test]
    fn a_cli_that_fails_says_so_in_last_error() {
        let mut terminal = Terminal::new("Failure");
        let session = terminal.shell("echo 'unknown option --frobnicate'; exit 3", json!({}));
        let ended =
            terminal.wait_state(|state| state["id"] == session["id"] && state["state"] == "exited");
        assert_eq!(ended["exitCode"], 3);
        assert_eq!(ended["lastError"], "The agent CLI exited with code 3");
        assert!(ended["endedAt"].is_string());
        assert_eq!(
            terminal.session()["lastError"],
            "The agent CLI exited with code 3"
        );
        terminal.wait_output("unknown option --frobnicate");

        let clean = terminal.shell("exit 0", json!({}));
        let ended =
            terminal.wait_state(|state| state["id"] == clean["id"] && state["state"] == "exited");
        assert_eq!(ended["exitCode"], 0);
        assert_eq!(ended["lastError"], Value::Null);
    }

    #[test]
    fn calls_and_review_state_reach_the_session_live() {
        let mut terminal = Terminal::new("Live session");
        let session = terminal.shell(
            "echo \"TOKEN=$OMENFLOW_BRIDGE_TOKEN.\"; sleep 60",
            json!({}),
        );
        terminal.wait_output(".");
        let token = terminal
            .output
            .split("TOKEN=")
            .nth(1)
            .and_then(|rest| rest.split('.').next())
            .unwrap()
            .to_owned();
        assert_eq!(token.len(), 48);
        let mut agent = McpClient::connect(&terminal.workspace.bridge, &token, "mcp");
        assert_eq!(agent.session_id, session["id"].as_str().unwrap());
        // The session's own profile decides what its agent is shown.
        let tools = agent.request("tools/list", json!({}));
        assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 13);

        agent.call("project_summary", json!({}));
        agent.call("artifact_read", json!({}));
        // Reading the state is always current, whatever events have arrived.
        let now = terminal.session();
        assert_eq!((&now["calls"], &now["errors"]), (&json!(2), &json!(1)));
        let pushed = terminal.wait_state(|state| state["calls"] == 2);
        assert_eq!(pushed["errors"], 1);
        assert_eq!(pushed["id"], session["id"]);

        let draft = terminal.workspace.user(
            "artifact.create_draft",
            json!({"type": "note", "title": "For review", "payload": {"markdown": "text"}}),
        );
        let proposal = terminal.workspace.user(
            "proposal.submit",
            json!({"changes": [{"artifactId": draft["artifact"]["id"], "baseRevisionId": null, "newRevisionId": draft["revision"]["id"], "kind": "new_artifact"}], "reason": "review"}),
        );
        let proposal_id = proposal["id"].as_str().unwrap().to_owned();
        let waiting_for = proposal_id.clone();
        let waiter = thread::spawn(move || {
            agent.call("tool_call", json!({"tool": "proposal_wait", "input": {"proposalId": waiting_for, "timeoutMs": 15_000}}))
        });
        let waiting = terminal.wait_state(|state| state["waitingForReview"] == true);
        assert_eq!(waiting["state"], "running");
        assert_eq!(terminal.session()["waitingForReview"], true);
        terminal.workspace.user(
            "proposal.approve",
            json!({"proposalId": proposal_id, "rationale": "ok"}),
        );
        let reply = waiter.join().unwrap();
        assert_eq!(reply.body["state"], "accepted");
        terminal.wait_state(|state| state["waitingForReview"] == false && state["calls"] == 3);
        assert_eq!(terminal.session()["waitingForReview"], false);

        // The ledger knows the session by its adapter and profile.
        let activity = terminal
            .workspace
            .bridge
            .agent_activity(terminal.project(), &json!({}))
            .unwrap();
        assert_eq!(activity["sessions"][0]["adapterId"], "custom");
        assert_eq!(activity["sessions"][0]["profile"], "compact");
        assert_eq!(activity["sessions"][0]["calls"], 3);
        let project = terminal.project().to_owned();
        terminal.host.stop(&project).unwrap();
        let ended = terminal.session();
        assert_eq!((&ended["calls"], &ended["errors"]), (&json!(3), &json!(1)));
        let activity = terminal
            .workspace
            .bridge
            .agent_activity(&project, &json!({}))
            .unwrap();
        assert!(activity["sessions"][0]["endedAt"].is_string());
    }

    #[test]
    fn session_files_hold_the_token_privately_and_vanish_with_the_session() {
        let mut terminal = Terminal::new("Claude files");
        let claude = terminal.script("claude", "echo \"ARGS $*.\"; sleep 60");
        terminal.configure("claude-code", json!({"executablePath": claude}));
        let project = terminal.project().to_owned();
        let session = terminal
            .host
            .start(
                &project,
                &json!({"adapterId": "claude-code", "model": "haiku"}),
            )
            .unwrap();
        assert_eq!(session["model"], "haiku");
        assert_eq!(session["profile"], "compact");
        assert_eq!(session["profileSource"], "model");
        assert_eq!(session["toolCount"], 13);
        let id = session["id"].as_str().unwrap();
        let mcp = terminal.work_file(&session, "mcp.json");
        let guide_file = terminal.work_file(&session, "guide.md");
        terminal.wait_output(".");
        let args = terminal.output.clone();
        for expected in [
            format!("--mcp-config {}", mcp.display()),
            "--allowedTools mcp__omenflow".to_owned(),
            format!("--append-system-prompt-file {}", guide_file.display()),
            "--model haiku".to_owned(),
            format!("--session-id {id}"),
        ] {
            assert!(args.contains(&expected), "no {expected:?} in {args:?}");
        }
        for file in [&mcp, &guide_file] {
            let mode = fs::metadata(file).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "{}", file.display());
        }
        let config: Value = serde_json::from_slice(&fs::read(&mcp).unwrap()).unwrap();
        let server = &config["mcpServers"]["omenflow"];
        assert_eq!(server["command"], "/bin/echo");
        assert_eq!(
            (&server["timeout"], &server["alwaysLoad"]),
            (&json!(600_000), &json!(true))
        );
        let token = server["env"]["OMENFLOW_BRIDGE_TOKEN"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(server["env"]["OMENFLOW_SESSION_ID"], id);
        assert!(fs::read_to_string(&guide_file)
            .unwrap()
            .starts_with("# Omen Flow session\n\nProject: Claude files\n"));
        assert!(!terminal.workspace.root().join("AGENTS.md").exists());
        assert!(!terminal.work_file(&session, "bootstrap.md").exists());
        // The token works while the session runs.
        McpClient::connect(&terminal.workspace.bridge, &token, "call");

        terminal.host.stop(&project).unwrap();
        assert!(
            !mcp.exists() && !guide_file.exists(),
            "session files outlived the session"
        );
        let (_, refused) = McpClient::hello(&terminal.workspace.bridge, &token, "call");
        assert_eq!(refused["error"]["code"], "CONNECTION_DENIED");

        // A CLI that exits on its own leaves nothing behind either.
        let quick = terminal.script("claude-quick", "exit 0");
        let session = terminal
            .host
            .start(
                &project,
                &json!({"adapterId": "claude-code", "executablePath": quick}),
            )
            .unwrap();
        terminal.wait_state(|state| state["id"] == session["id"] && state["state"] == "exited");
        assert!(!terminal.work_file(&session, "mcp.json").exists());
    }

    #[test]
    fn agents_md_carries_the_block_only_for_a_cli_with_no_other_channel() {
        let terminal = Terminal::new("Agents file");
        let project = terminal.project().to_owned();
        let agents = terminal.workspace.root().join("AGENTS.md");
        let legacy = include_str!("testdata/legacy-agents-guide.md");
        fs::write(
            &agents,
            format!("# Mine\n\nUse metric fasteners.\n\n{legacy}"),
        )
        .unwrap();

        // Claude Code has its own channels: the old guide goes, nothing is added.
        let claude = terminal.script("claude", "sleep 60");
        terminal.configure("claude-code", json!({"executablePath": claude}));
        terminal
            .host
            .start(&project, &json!({"adapterId": "claude-code"}))
            .unwrap();
        assert_eq!(
            fs::read_to_string(&agents).unwrap(),
            "# Mine\n\nUse metric fasteners.\n"
        );

        // A custom CLI has none: the bounded block is added below the person's text.
        terminal.configure("custom", json!({"executablePath": "/bin/cat"}));
        terminal
            .host
            .start(&project, &json!({"adapterId": "custom"}))
            .unwrap();
        let with_block = fs::read_to_string(&agents).unwrap();
        assert_eq!(
            with_block,
            format!(
                "# Mine\n\nUse metric fasteners.\n\n{}\n",
                guide::agents_block()
            )
        );
        terminal
            .host
            .start(&project, &json!({"adapterId": "custom"}))
            .unwrap();
        assert_eq!(
            fs::read_to_string(&agents).unwrap(),
            with_block,
            "the block is written once"
        );

        // The person can switch it off for that adapter.
        terminal.configure("custom", json!({"env": {"OMENFLOW_AGENTS_MD": "off"}}));
        terminal
            .host
            .start(&project, &json!({"adapterId": "custom"}))
            .unwrap();
        assert_eq!(
            fs::read_to_string(&agents).unwrap(),
            "# Mine\n\nUse metric fasteners.\n"
        );
    }

    #[test]
    fn start_again_continues_a_conversation_that_took_place() {
        let mut terminal = Terminal::new("Resume");
        let claude = terminal.script("claude", "echo \"ARGS $*.\"; sleep 60");
        terminal.configure("claude-code", json!({"executablePath": claude}));
        let project = terminal.project().to_owned();
        let first = terminal
            .host
            .start(
                &project,
                &json!({"adapterId": "claude-code", "model": "sonnet"}),
            )
            .unwrap();
        let first_id = first["id"].as_str().unwrap().to_owned();
        terminal.wait_output(&format!("--session-id {first_id}."));

        // Nothing was said in that session: starting again starts fresh.
        terminal.output.clear();
        let second = terminal.host.restart(&project).unwrap();
        let second_id = second["id"].as_str().unwrap().to_owned();
        assert_ne!(second_id, first_id);
        assert_eq!(second["model"], "sonnet", "the same start input is used");
        terminal.wait_output(&format!("--session-id {second_id}."));
        assert!(!terminal.output.contains("--resume"));

        // The agent talked to Omen Flow: the conversation is resumed by id.
        let config: Value =
            serde_json::from_slice(&fs::read(terminal.work_file(&second, "mcp.json")).unwrap())
                .unwrap();
        let token = config["mcpServers"]["omenflow"]["env"]["OMENFLOW_BRIDGE_TOKEN"]
            .as_str()
            .unwrap()
            .to_owned();
        McpClient::connect(&terminal.workspace.bridge, &token, "mcp")
            .call("project_summary", json!({}));
        terminal.output.clear();
        let third = terminal.host.restart(&project).unwrap();
        terminal.wait_output(&format!("--resume {second_id}."));
        assert!(!terminal.output.contains("--session-id"));
        assert_ne!(third["id"], second["id"], "the Omen Flow session is new");
        assert!(terminal.work_file(&third, "mcp.json").exists());

        // The resumed session did nothing: the next start is fresh again.
        terminal.output.clear();
        let fourth = terminal.host.restart(&project).unwrap();
        terminal.wait_output(&format!("--session-id {}.", fourth["id"].as_str().unwrap()));
        assert!(!terminal.output.contains("--resume"));

        let none = Terminal::new("No session");
        let error = none.host.restart(none.project()).unwrap_err();
        assert_eq!(error.message, "No session to restart");
    }

    #[test]
    fn a_start_that_cannot_succeed_leaves_the_running_session_alone() {
        let mut terminal = Terminal::new("Failed start");
        terminal.configure("custom", json!({"executablePath": "/bin/cat"}));
        let project = terminal.project().to_owned();
        let running = terminal
            .host
            .start(&project, &json!({"adapterId": "custom"}))
            .unwrap();

        let missing = terminal
            .host
            .start(
                &project,
                &json!({"adapterId": "custom", "executablePath": "/nowhere/agent"}),
            )
            .unwrap_err();
        assert_eq!(missing.code, "TOOL_MISSING");
        assert_eq!(missing.message, "Executable not found: /nowhere/agent");
        assert!(missing
            .repair
            .unwrap()
            .ends_with("Then start the session again."));
        let unknown = terminal
            .host
            .start(&project, &json!({"adapterId": "cursor"}))
            .unwrap_err();
        assert_eq!(unknown.code, "VALIDATION");
        assert_eq!(unknown.message, "Unknown adapter: cursor");
        assert_eq!(
            unknown.repair.as_deref(),
            Some("Use one of: codex, claude-code, opencode, gemini, qwen, custom.")
        );
        let not_installed = terminal
            .host
            .start(
                &project,
                &json!({"adapterId": "qwen", "executablePath": ""}),
            )
            .map(|_| ())
            .or_else(|error| {
                if error.code == "TOOL_MISSING" {
                    Ok(())
                } else {
                    Err(error)
                }
            });
        assert!(not_installed.is_ok());

        let still = terminal.session();
        assert_eq!(still["id"], running["id"]);
        assert_eq!(still["state"], "running");
        terminal.host.write(&project, "still here\n").unwrap();
        terminal.wait_output("still here");
        // No grant or file of the failed attempts is left behind.
        let work = terminal.workspace.root().join(".omenflow/work");
        let folders = fs::read_dir(&work)
            .map(|entries| entries.count())
            .unwrap_or(0);
        assert!(folders <= 1, "{folders} session folders");

        // Without the helper an agent would have no tools: refuse to start.
        let helperless = Terminal::with_helper("No helper", PathBuf::from("/nowhere/omenflow"));
        helperless.configure("custom", json!({"executablePath": "/bin/cat"}));
        let error = helperless
            .host
            .start(helperless.project(), &json!({"adapterId": "custom"}))
            .unwrap_err();
        assert_eq!(error.code, "TOOL_MISSING");
        assert_eq!(
            error.message,
            "Omen Flow bridge helper missing: /nowhere/omenflow"
        );
    }

    #[test]
    fn connection_list_reports_every_adapter_with_its_v1_fields() {
        let terminal = Terminal::new("Connections");
        let codex = terminal.script("codex", "echo 'codex-cli 0.156.1'");
        terminal.configure("codex", json!({"executablePath": codex}));
        terminal.configure("gemini", json!({"executablePath": "/nowhere/gemini"}));
        terminal.configure(
            "custom",
            json!({"args": ["--profile", "bench"], "env": {"AGENT_TOKEN": "not-listed"}}),
        );
        let listed = terminal.host.connection_list().unwrap();
        let adapters = listed["adapters"].as_array().unwrap();
        let ids = adapters
            .iter()
            .map(|adapter| adapter["adapterId"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            [
                "codex",
                "claude-code",
                "opencode",
                "gemini",
                "qwen",
                "custom"
            ]
        );
        for adapter in adapters {
            for field in [
                "label",
                "available",
                "executablePath",
                "version",
                "testedVersionRange",
                "recognizedVersion",
                "capabilities",
                "lastTestAt",
                "lastTestOk",
                "lastError",
                "installHint",
                "model",
                "profile",
                "args",
                "resolvedProfile",
                "models",
                "verified",
                "docsUrl",
                "guideChannels",
            ] {
                assert!(
                    adapter.get(field).is_some(),
                    "{} lacks {field}",
                    adapter["adapterId"]
                );
            }
        }
        assert_eq!(adapters[0]["available"], true);
        assert_eq!(adapters[0]["version"], "codex-cli 0.156.1");
        assert_eq!(adapters[0]["recognizedVersion"], true);
        assert_eq!(adapters[0]["verified"], true);
        assert_eq!(adapters[3]["available"], false);
        assert_eq!(adapters[3]["lastError"], "Not found: /nowhere/gemini");
        assert_eq!(adapters[3]["verified"], false);
        assert_eq!(adapters[5]["lastError"], "No executable path is set");
        // A custom CLI's saved arguments are listed for Settings; its saved
        // environment is not.
        assert_eq!(adapters[5]["args"], json!(["--profile", "bench"]));
        assert!(!listed.to_string().contains("not-listed"));

        let unknown = terminal
            .host
            .connection_configure(&json!({"adapterId": "cursor"}))
            .unwrap_err();
        assert_eq!(unknown.code, "NOT_FOUND");
        let bad_profile = terminal
            .host
            .connection_configure(&json!({"adapterId": "codex", "profile": "huge"}))
            .unwrap_err();
        assert_eq!(bad_profile.code, "VALIDATION");
        terminal
            .host
            .connection_configure(&json!({"adapterId": "codex", "args": ["--no-daemon"]}))
            .unwrap();
    }

    /// A helper that answers like the real one, to test the reporting of
    /// each step. The real helper against the real bridge is covered by
    /// `the_built_helper_reaches_the_bridge_both_ways`.
    const STAND_IN_HELPER: &str = r#"case "$1" in
  call) cat > /dev/null; echo '{"project":{"name":"Stand-in"}}' ;;
  mcp) while read -r line; do
         case "$line" in *tools/list*) echo '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"a"},{"name":"b"}]}}' ;; esac
       done ;;
  *) exit 3 ;;
esac"#;

    #[test]
    fn a_connection_test_runs_the_cli_and_reports_each_step() {
        let terminal = Terminal::new("Connection test");
        let helper = terminal.script("omenflow", STAND_IN_HELPER);
        let terminal = Terminal {
            host: PtyHost::new(
                Arc::clone(&terminal.workspace.core),
                Arc::clone(&terminal.workspace.bridge),
                PathBuf::from(&helper),
                Arc::new(|_| {}),
            ),
            ..terminal
        };
        let project = terminal.project().to_owned();
        let codex = terminal.script("codex", "echo 'codex-cli 0.156.1'");
        terminal.configure("codex", json!({"executablePath": codex}));
        let passed = terminal
            .host
            .connection_test(&project, &json!({"adapterId": "codex"}))
            .unwrap();
        assert_eq!(passed["ok"], true, "{passed}");
        assert_eq!(
            passed["steps"],
            json!([
                {"step": "executable", "ok": true, "detail": codex},
                {"step": "version", "ok": true, "detail": "codex-cli 0.156.1"},
                {"step": "helper", "ok": true, "detail": helper},
                {"step": "bridge", "ok": true, "detail": "omenflow call reached project \"Stand-in\""},
                {"step": "mcp", "ok": true, "detail": "omenflow mcp listed 2 tools for the standard profile"}
            ])
        );
        assert!(passed["detail"]
            .as_str()
            .unwrap()
            .starts_with("Codex CLI answered"));
        let stored = terminal
            .workspace
            .core
            .lock()
            .unwrap()
            .adapter_config("codex");
        assert_eq!(stored["lastTestOk"], true);
        assert!(stored["lastTestAt"].is_string());
        assert_eq!(stored["lastError"], Value::Null);

        // A CLI that does not answer its version probe is not "working".
        let broken = terminal.script("codex-broken", "exit 1");
        terminal.configure("codex", json!({"executablePath": broken}));
        let failed = terminal
            .host
            .connection_test(&project, &json!({"adapterId": "codex"}))
            .unwrap();
        assert_eq!(failed["ok"], false);
        assert_eq!(failed["steps"].as_array().unwrap().len(), 2);
        assert_eq!(failed["steps"][1]["step"], "version");
        assert!(failed["error"]
            .as_str()
            .unwrap()
            .contains("did not answer `--version`"));
        let stored = terminal
            .workspace
            .core
            .lock()
            .unwrap()
            .adapter_config("codex");
        assert_eq!(stored["lastTestOk"], false);
        assert_eq!(stored["lastError"], failed["error"]);

        terminal.configure("codex", json!({"executablePath": "/nowhere/codex"}));
        let missing = terminal
            .host
            .connection_test(&project, &json!({"adapterId": "codex"}))
            .unwrap();
        assert_eq!(
            missing["steps"],
            json!([{"step": "executable", "ok": false, "detail": "Executable not found: /nowhere/codex"}])
        );

        // A custom CLI need not answer a version probe.
        terminal.configure("custom", json!({"executablePath": "/bin/cat"}));
        let custom = terminal
            .host
            .connection_test(&project, &json!({"adapterId": "custom"}))
            .unwrap();
        assert_eq!(custom["ok"], true, "{custom}");
        assert_eq!(
            custom["steps"][4]["detail"],
            "omenflow mcp listed 2 tools for the compact profile"
        );
        let unknown = terminal
            .host
            .connection_test(&project, &json!({"adapterId": "cursor"}))
            .unwrap_err();
        assert_eq!(unknown.code, "NOT_FOUND");
    }

    #[test]
    fn a_helper_that_does_not_reach_the_bridge_fails_the_test() {
        // `/bin/echo` exits successfully and prints its arguments, which is
        // not a project summary: success of the process is not enough.
        let terminal = Terminal::new("Bad helper");
        let codex = terminal.script("codex", "echo 'codex-cli 0.156.1'");
        terminal.configure("codex", json!({"executablePath": codex}));
        let result = terminal
            .host
            .connection_test(terminal.project(), &json!({"adapterId": "codex"}))
            .unwrap();
        assert_eq!(result["ok"], false);
        assert_eq!(
            result["steps"][3],
            json!({"step": "bridge", "ok": false, "detail": "The helper did not print a JSON result"})
        );
        assert_eq!(
            result["steps"].as_array().unwrap().len(),
            4,
            "MCP is not tried after that"
        );

        let hanging = terminal.script("hanging-helper", "sleep 60");
        let slow = Terminal::with_helper("Hanging helper", PathBuf::from(hanging));
        let codex = slow.script("codex", "echo 'codex-cli 0.156.1'");
        slow.configure("codex", json!({"executablePath": codex}));
        let started = Instant::now();
        let result = slow
            .host
            .connection_test(slow.project(), &json!({"adapterId": "codex"}))
            .unwrap();
        assert_eq!(result["steps"][3]["ok"], false);
        assert!(started.elapsed() < HELPER_TIMEOUT + Duration::from_secs(10));
    }

    /// The test runs the helper where a session runs it, in the project
    /// folder, so a path that works only from the host's folder fails here
    /// as it would in a session.
    #[test]
    fn the_connection_test_runs_the_helper_in_the_project_folder() {
        let terminal = Terminal::new("Where");
        let reporter = terminal.script(
            "where-helper",
            "[ \"$1\" = mcp ] && exit 1; cat > /dev/null; printf '{\"project\":{\"name\":\"%s\"}}\\n' \"$(pwd -P)\"",
        );
        let located = Terminal::with_helper("Where helper", PathBuf::from(reporter));
        let codex = located.script("codex", "echo 'codex-cli 0.156.1'");
        located.configure("codex", json!({"executablePath": codex}));
        let result = located
            .host
            .connection_test(located.project(), &json!({"adapterId": "codex"}))
            .unwrap();
        let root = fs::canonicalize(located.workspace.root()).unwrap();
        assert_eq!(
            result["steps"][3]["detail"],
            format!("omenflow call reached project \"{}\"", root.display()),
            "{result}"
        );
    }

    /// Needs `pnpm build:bridge` first, so it is not part of the default run:
    /// the workspace build does not produce the helper.
    #[test]
    #[ignore = "needs the built omenflow helper (pnpm build:bridge)"]
    fn the_built_helper_reaches_the_bridge_both_ways() {
        let helper = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../native/omenflow-bridge/target/release/omenflow");
        assert!(
            helper.is_file(),
            "build the helper first: {}",
            helper.display()
        );
        let terminal = Terminal::with_helper("Real helper", helper);
        let codex = terminal.script("codex", "echo 'codex-cli 0.156.1'");
        terminal.configure("codex", json!({"executablePath": codex}));
        let result = terminal
            .host
            .connection_test(terminal.project(), &json!({"adapterId": "codex"}))
            .unwrap();
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(
            result["steps"][3]["detail"],
            "omenflow call reached project \"Real helper\""
        );
        assert_eq!(
            result["steps"][4]["detail"],
            format!(
                "omenflow mcp listed {} tools for the standard profile",
                omenflow_contracts::registry()
                    .tools_for(omenflow_contracts::Profile::Standard)
                    .count()
            )
        );
        // The call is in the ledger, as an agent's would be, under a
        // session that says it was a test.
        let calls = terminal.workspace.recorded();
        assert_eq!(calls.len(), 1);
        let activity = terminal
            .workspace
            .bridge
            .agent_activity(terminal.project(), &json!({}))
            .unwrap();
        assert_eq!(
            activity["sessions"][0]["adapterId"],
            "connection-test:codex"
        );
        assert!(activity["sessions"][0]["endedAt"].is_string());
        assert_eq!(
            (&calls[0]["tool"], &calls[0]["via"]),
            (&json!("project_summary"), &json!("call"))
        );
    }
}
