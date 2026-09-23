use crate::BridgeServer;
use chrono::{SecondsFormat, Utc};
use omenflow_contracts::ContractError;
use omenflow_core::{CoreApp, Origin};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use uuid::Uuid;

const SCROLLBACK_CAP: usize = 256 * 1024;

#[derive(Clone, Debug)]
pub enum TerminalEvent {
    Data(Value),
    State(Value),
}

struct Session {
    info: Value,
    scrollback: String,
    cursor: u64,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    last_start: Value,
}

pub struct PtyHost {
    core: Arc<Mutex<CoreApp>>,
    bridge: Arc<BridgeServer>,
    cli_path: PathBuf,
    sessions: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
    notify: Arc<dyn Fn(TerminalEvent) + Send + Sync>,
}

impl PtyHost {
    pub fn new(
        core: Arc<Mutex<CoreApp>>,
        bridge: Arc<BridgeServer>,
        cli_path: PathBuf,
        notify: Arc<dyn Fn(TerminalEvent) + Send + Sync>,
    ) -> Self {
        Self {
            core,
            bridge,
            cli_path,
            sessions: Mutex::new(HashMap::new()),
            notify,
        }
    }

    pub fn start(&self, project_id: &str, input: &Value) -> Result<Value, ContractError> {
        self.stop(project_id)?;
        let adapter_id = input["adapterId"]
            .as_str()
            .ok_or_else(|| ContractError::validation("Missing adapterId"))?;
        let (root, config, summary) = {
            let mut core = self
                .core
                .lock()
                .map_err(|_| failure("Application state unavailable"))?;
            let root = core.project_root(project_id)?;
            let config = core.adapter_config(adapter_id);
            let summary = core.dispatch(
                "project.summary",
                json!({"budget": 8_000}),
                Origin::System,
                Some(project_id),
            )?;
            (root, config, summary)
        };
        let session_id = Uuid::new_v4().to_string();
        let opts = merge_config(config, input);
        let path = executable_for(adapter_id, &opts)?;
        let work = root.join(".omenflow/work").join(&session_id);
        fs::create_dir_all(&work).map_err(failure)?;
        let bootstrap = work.join("bootstrap.md");
        fs::write(&bootstrap, format!("# Omen Flow session\n\nProject: {}\n\nThis is an engineering workspace. Draft revisions require human review and approval. The baseline is never agent-editable. Use Omen Flow tools and keep quantities, units, unknowns, evidence and revision IDs explicit.\n\n## Project context\n\n```json\n{}\n```\n", root.display(), serde_json::to_string_pretty(&summary).unwrap_or_default())).map_err(failure)?;
        let token = self.bridge.issue_token(project_id, &session_id);
        let mut command = CommandBuilder::new(&path);
        command.cwd(&root);
        for (key, _) in std::env::vars().filter(|(key, _)| key.starts_with("OMENFLOW_")) {
            command.env_remove(key);
        }
        let mut args = opts["args"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        let bridge_env = [
            ("OMENFLOW_BRIDGE_SOCK", self.bridge.socket_path().to_owned()),
            ("OMENFLOW_BRIDGE_TOKEN", token.clone()),
            ("OMENFLOW_PROJECT_ID", project_id.to_owned()),
            ("OMENFLOW_SESSION_ID", session_id.clone()),
        ];
        let cli_dir = self.cli_path.parent().unwrap_or(Path::new("/usr/bin"));
        let old_path = std::env::var("PATH").unwrap_or_default();
        command.env(
            "PATH",
            format!(
                "{}:{old_path}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
                cli_dir.display()
            ),
        );
        command.env("TERM", "xterm-256color");
        command.env("OMENFLOW_BOOTSTRAP", &bootstrap);
        if let Some(vars) = opts["env"].as_object() {
            for (key, value) in vars {
                if let Some(value) = value.as_str() {
                    if !key.starts_with("OMENFLOW_BRIDGE_")
                        && !matches!(key.as_str(), "OMENFLOW_PROJECT_ID" | "OMENFLOW_SESSION_ID")
                    {
                        command.env(key, value);
                    }
                }
            }
        }
        for (key, value) in &bridge_env {
            command.env(key, value);
        }
        match adapter_id {
            "codex" => {
                args.splice(0..0, [
                    "-c", "mcp_servers.omenflow.command=\"omenflow\"",
                    "-c", "mcp_servers.omenflow.args=[\"mcp\"]",
                    "-c", "mcp_servers.omenflow.env_vars=[\"OMENFLOW_BRIDGE_SOCK\",\"OMENFLOW_BRIDGE_TOKEN\",\"OMENFLOW_PROJECT_ID\",\"OMENFLOW_SESSION_ID\"]",
                    "-c", "mcp_servers.omenflow.default_tools_approval_mode=\"approve\"",
                    "-c", "sandbox_mode=\"workspace-write\"",
                    "-c", "sandbox_workspace_write.network_access=true",
                ].into_iter().map(str::to_owned));
            }
            "claude-code" => {
                let mcp = work.join("mcp.json");
                fs::write(&mcp, serde_json::to_vec_pretty(&json!({"mcpServers":{"omenflow":{"command":"omenflow","args":["mcp"],"env":bridge_env.iter().map(|(k,v)|(k.to_string(),json!(v))).collect::<serde_json::Map<String,Value>>()}}})).map_err(failure)?).map_err(|error| { self.bridge.revoke(&session_id); failure(error) })?;
                args.splice(
                    0..0,
                    ["--mcp-config".into(), mcp.to_string_lossy().to_string()],
                );
            }
            "custom" => {}
            _ => {
                return Err(ContractError::validation(format!(
                    "Unknown adapter: {adapter_id}"
                )))
            }
        }
        command.args(args);
        let pair = native_pty_system()
            .openpty(PtySize::default())
            .map_err(|error| {
                self.bridge.revoke(&session_id);
                failure(error)
            })?;
        let mut child = pair.slave.spawn_command(command).map_err(|error| {
            self.bridge.revoke(&session_id);
            failure(error)
        })?;
        let pid = child.process_id();
        let reader = pair.master.try_clone_reader().map_err(|error| {
            let _ = child.kill();
            self.bridge.revoke(&session_id);
            failure(error)
        })?;
        let writer = pair.master.take_writer().map_err(|error| {
            let _ = child.kill();
            self.bridge.revoke(&session_id);
            failure(error)
        })?;
        let killer = child.clone_killer();
        let info = json!({"id":session_id,"adapterId":adapter_id,"executablePath":path,"state":"running","pid":pid,"exitCode":null,"cols":80,"rows":24,"startedAt":now(),"endedAt":null,"waitingForReview":false,"lastError":null});
        let session = Arc::new(Mutex::new(Session {
            info: info.clone(),
            scrollback: String::new(),
            cursor: 0,
            master: pair.master,
            writer,
            killer,
            last_start: input.clone(),
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
        let bridge = Arc::clone(&self.bridge);
        let core = Arc::clone(&self.core);
        let notify = Arc::clone(&self.notify);
        let project_for_exit = project_id.to_owned();
        thread::spawn(move || {
            let status = child.wait();
            bridge.revoke(&session_id);
            if let Ok(mut state) = session.lock() {
                state.info["state"] = json!("exited");
                state.info["exitCode"] = json!(status.ok().map(|s| s.exit_code()));
                state.info["endedAt"] = json!(now());
                let info = state.info.clone();
                drop(state);
                if let Ok(core) = core.lock() {
                    let _ = core.upsert_session(&project_for_exit, &info);
                }
                notify(TerminalEvent::State(
                    json!({"projectId": project_for_exit, "session": info}),
                ));
            }
        });
        Ok(info)
    }

    pub fn connection_list(&self) -> Result<Value, ContractError> {
        let core = self
            .core
            .lock()
            .map_err(|_| failure("Application state unavailable"))?;
        let mut adapters = Vec::new();
        for (id, label, executable, mcp, cli, resume, ranges, hint) in [
            (
                "codex",
                "Codex CLI",
                "codex",
                true,
                true,
                false,
                "0.4 | 0.5 | 0.6 | 0.15",
                "Install Codex CLI or set an executable path.",
            ),
            (
                "claude-code",
                "Claude Code",
                "claude",
                true,
                true,
                true,
                "1. | 2.",
                "Install Claude Code or set an executable path.",
            ),
            (
                "custom",
                "Custom CLI",
                "",
                false,
                true,
                false,
                "",
                "Set an executable path via connection.configure.",
            ),
        ] {
            let config = core.adapter_config(id);
            let configured = config["executablePath"].as_str().filter(|s| !s.is_empty());
            let found = configured
                .map(PathBuf::from)
                .or_else(|| find_executable(executable));
            let available = found.as_ref().is_some_and(|path| path.is_file());
            let version = found.as_ref().filter(|_| available).and_then(|path| {
                let out = std::process::Command::new(path)
                    .arg("--version")
                    .output()
                    .ok()?;
                if !out.status.success() {
                    return None;
                }
                Some(
                    String::from_utf8_lossy(if out.stdout.is_empty() {
                        &out.stderr
                    } else {
                        &out.stdout
                    })
                    .trim()
                    .to_owned(),
                )
            });
            adapters.push(json!({
                "adapterId":id,"label":label,"available":available,
                "executablePath":found,"version":version,"testedVersionRange":if ranges.is_empty(){None}else{Some(ranges)},
                "recognizedVersion": if id == "custom" {available} else {version.as_ref().is_some_and(|v| ranges.split(" | ").any(|r| v.contains(r)))},
                "capabilities":{"mcp":mcp,"cli":cli,"resume":resume},
                "lastTestAt":config["lastTestAt"],"lastTestOk":config["lastTestOk"],
                "lastError": if available { Value::Null } else {json!(if let Some(path)=configured { format!("Not found: {path}") } else { format!("{executable} not found on PATH") })},
                "installHint":hint
            }));
        }
        Ok(json!({"adapters":adapters}))
    }

    pub fn connection_configure(&self, input: &Value) -> Result<Value, ContractError> {
        let id = input["adapterId"]
            .as_str()
            .ok_or_else(|| ContractError::validation("Missing adapterId"))?;
        if !matches!(id, "codex" | "claude-code" | "custom") {
            return Err(ContractError::new(
                "NOT_FOUND",
                format!("Unknown adapter: {id}"),
            ));
        }
        self.core
            .lock()
            .map_err(|_| failure("Application state unavailable"))?
            .configure_adapter(id, input)?;
        Ok(json!({"ok":true}))
    }

    pub fn connection_test(&self, project_id: &str, input: &Value) -> Result<Value, ContractError> {
        use std::process::{Command, Stdio};
        let id = input["adapterId"]
            .as_str()
            .ok_or_else(|| ContractError::validation("Missing adapterId"))?;
        let list = self.connection_list()?;
        let status = list["adapters"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["adapterId"] == id)
            .ok_or_else(|| ContractError::new("NOT_FOUND", format!("Unknown adapter: {id}")))?;
        let tested_at = now();
        let outcome = if !status["available"].as_bool().unwrap_or(false) {
            json!({"ok":false,"error":status["lastError"]})
        } else if !self.cli_path.is_file() {
            json!({"ok":false,"error":format!("Omen Flow bridge helper missing: {}", self.cli_path.display())})
        } else {
            let session_id = Uuid::new_v4().to_string();
            let token = self.bridge.issue_token(project_id, &session_id);
            let child = Command::new(&self.cli_path)
                .args(["call", "project.summary", "--input", "-"])
                .env("OMENFLOW_BRIDGE_SOCK", self.bridge.socket_path())
                .env("OMENFLOW_BRIDGE_TOKEN", &token)
                .env("OMENFLOW_PROJECT_ID", project_id)
                .env("OMENFLOW_SESSION_ID", &session_id)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn();
            let result = match child {
                Ok(mut child) => {
                    if let Some(mut stdin) = child.stdin.take() {
                        let _ = stdin.write_all(b"{}\n");
                    }
                    match child.wait_with_output() {
                        Ok(output) if output.status.success() => {
                            json!({"ok":true,"detail":format!("bridge ok · {}", status["label"].as_str().unwrap_or(id))})
                        }
                        Ok(output) => {
                            json!({"ok":false,"error":String::from_utf8_lossy(&output.stderr).trim()})
                        }
                        Err(error) => json!({"ok":false,"error":error.to_string()}),
                    }
                }
                Err(error) => json!({"ok":false,"error":error.to_string()}),
            };
            self.bridge.revoke(&session_id);
            result
        };
        self.core.lock().map_err(|_| failure("Application state unavailable"))?.configure_adapter(id, &json!({"lastTestAt":tested_at,"lastTestOk":outcome["ok"],"lastError":outcome["error"]}))?;
        Ok(outcome)
    }

    pub fn write(&self, project_id: &str, data: &str) -> Result<Value, ContractError> {
        if let Some(session) = self.session(project_id) {
            session
                .lock()
                .map_err(|_| failure("Session unavailable"))?
                .writer
                .write_all(data.as_bytes())
                .map_err(failure)?;
        }
        Ok(json!({"ok":true}))
    }

    pub fn resize(&self, project_id: &str, cols: u16, rows: u16) -> Result<Value, ContractError> {
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
        if let Some(session) = self.session(project_id) {
            let mut state = session.lock().map_err(|_| failure("Session unavailable"))?;
            if let Some(id) = state.info["id"].as_str() {
                self.bridge.revoke(id);
            }
            if state.info["state"] == "running" {
                state.killer.kill().map_err(failure)?;
                state.info["state"] = json!("exited");
                state.info["endedAt"] = json!(now());
            }
            let info = state.info.clone();
            drop(state);
            self.persist(project_id, &info);
            (self.notify)(TerminalEvent::State(
                json!({"projectId":project_id,"session":info}),
            ));
        }
        Ok(json!({"ok":true}))
    }

    pub fn restart(&self, project_id: &str) -> Result<Value, ContractError> {
        let input = self
            .session(project_id)
            .ok_or_else(|| ContractError::validation("No session to restart"))?
            .lock()
            .map_err(|_| failure("Session unavailable"))?
            .last_start
            .clone();
        self.start(project_id, &input)
    }

    pub fn state(&self, project_id: &str) -> Value {
        let Some(session) = self.session(project_id) else {
            return json!({"session":null});
        };
        let Ok(state) = session.lock() else {
            return json!({"session":null});
        };
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
        if let Ok(sessions) = self.sessions.lock() {
            for session in sessions.values() {
                if let Ok(mut state) = session.lock() {
                    if let Some(id) = state.info["id"].as_str() {
                        self.bridge.revoke(id);
                    }
                    if state.info["state"] == "running" {
                        let _ = state.killer.kill();
                    }
                }
            }
        }
    }
}

fn read_loop(
    mut reader: Box<dyn Read + Send>,
    session: Arc<Mutex<Session>>,
    project_id: String,
    notify: Arc<dyn Fn(TerminalEvent) + Send + Sync>,
) {
    let mut buffer = [0_u8; 8192];
    while let Ok(count) = reader.read(&mut buffer) {
        if count == 0 {
            break;
        }
        let chunk = String::from_utf8_lossy(&buffer[..count]).into_owned();
        let (session_id, seq) = if let Ok(mut state) = session.lock() {
            state.cursor += 1;
            state.scrollback.push_str(&chunk);
            if state.scrollback.len() > SCROLLBACK_CAP {
                let mut trim = state.scrollback.len() - SCROLLBACK_CAP;
                while !state.scrollback.is_char_boundary(trim) {
                    trim += 1;
                }
                state.scrollback.drain(..trim);
            }
            (state.info["id"].clone(), state.cursor)
        } else {
            break;
        };
        notify(TerminalEvent::Data(
            json!({"projectId":project_id,"sessionId":session_id,"chunk":chunk,"seq":seq}),
        ));
    }
}

fn merge_config(mut config: Value, input: &Value) -> Value {
    if !config.is_object() {
        config = json!({});
    }
    for key in ["executablePath", "args"] {
        if let Some(value) = input.get(key) {
            config[key] = value.clone();
        }
    }
    config
}

fn executable_for(adapter_id: &str, config: &Value) -> Result<PathBuf, ContractError> {
    let name = match adapter_id {
        "codex" => "codex",
        "claude-code" => "claude",
        "custom" => "",
        _ => {
            return Err(ContractError::validation(format!(
                "Unknown adapter: {adapter_id}"
            )))
        }
    };
    let configured = config["executablePath"].as_str().filter(|s| !s.is_empty());
    let path = configured
        .map(PathBuf::from)
        .or_else(|| find_executable(name))
        .ok_or_else(|| {
            ContractError::new("TOOL_MISSING", format!("{adapter_id} executable not found"))
        })?;
    if !path.is_file() {
        return Err(ContractError::new(
            "TOOL_MISSING",
            format!("Executable not found: {}", path.display()),
        ));
    }
    Ok(path)
}

fn find_executable(name: &str) -> Option<PathBuf> {
    if name.is_empty() {
        return None;
    }
    let path = std::env::var("PATH").unwrap_or_default();
    let dirs = std::env::split_paths(&path).chain([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
    ]);
    dirs.map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn failure(error: impl std::fmt::Display) -> ContractError {
    ContractError::new("INTERNAL", error.to_string())
}
