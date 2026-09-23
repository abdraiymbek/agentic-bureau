//! Local, capability-scoped v1 bridge for the shipped `omenflow` Rust CLI.
//! Each connection is authenticated before it may dispatch an operation or
//! expose MCP tools. Revocation is checked again on every request.

mod mcp;
mod pty;
pub use pty::{PtyHost, TerminalEvent};

#[cfg(windows)]
use interprocess::local_socket::GenericNamespaced;
use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions, Stream};
use omenflow_contracts::{read_frame, registry, write_frame, ContractError, ResponseEnvelope};
use omenflow_core::{CoreApp, Origin};
use rand::random;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use std::time::Instant;

#[derive(Clone)]
struct Grant {
    project_id: String,
    session_id: String,
}

type HostDispatch = Arc<
    dyn Fn(String, Value, Origin, String, Option<String>) -> Result<Value, ContractError>
        + Send
        + Sync,
>;

struct Shared {
    core: Arc<Mutex<CoreApp>>,
    grants: Mutex<HashMap<String, Grant>>,
    stopped: AtomicBool,
    on_event: Arc<dyn Fn(Value) + Send + Sync>,
    host_dispatch: Option<HostDispatch>,
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
        let path = socket_path(app_data_dir);
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

    pub fn issue_token(&self, project_id: &str, session_id: &str) -> String {
        self.revoke(session_id);
        let bytes: [u8; 24] = random();
        let token: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        self.shared.grants.lock().expect("grants lock").insert(
            token.clone(),
            Grant {
                project_id: project_id.to_owned(),
                session_id: session_id.to_owned(),
            },
        );
        token
    }

    pub fn revoke(&self, session_id: &str) {
        self.shared
            .grants
            .lock()
            .expect("grants lock")
            .retain(|_, grant| grant.session_id != session_id);
    }
}

impl Drop for BridgeServer {
    fn drop(&mut self) {
        self.shared.stopped.store(true, Ordering::SeqCst);
        self.shared.grants.lock().expect("grants lock").clear();
        // Wake a blocking accept, then join before unlinking the endpoint.
        if let Ok(name) = socket_name(&self.path) {
            let _ = Stream::connect(name);
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        #[cfg(unix)]
        let _ = fs::remove_file(&self.path);
    }
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
        format!(r"\\.\pipe\omenflow-{user}-bridge")
    }
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
    if write_frame(&mut stream, &json!({"type": "welcome", "protocolVersion": registry().protocol_version, "projectId": grant.project_id, "sessionId": grant.session_id, "agentOps": agent_ops})).is_err() {
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

fn dispatch_agent(
    shared: &Shared,
    token: &str,
    op: &str,
    payload: Value,
    idempotency_key: Option<&str>,
) -> Result<Value, ContractError> {
    let grant = current_grant(shared, token).ok_or_else(|| {
        ContractError::new("CONNECTION_DENIED", "Agent session grant was revoked")
    })?;
    if !registry()
        .operation(op)
        .is_some_and(|definition| definition.agent_allowed)
    {
        return Err(ContractError::new(
            "CAPABILITY_DENIED",
            format!("Op not granted to this session: {op}"),
        ));
    }
    if op == "proposal.wait" {
        return wait_proposal(&shared.core, &grant.project_id, &payload);
    }
    if let Some(host_dispatch) = shared
        .host_dispatch
        .as_ref()
        .filter(|_| op.starts_with("research.") || op.starts_with("browser."))
    {
        return host_dispatch(
            op.to_owned(),
            payload,
            Origin::Agent {
                session_id: grant.session_id,
            },
            grant.project_id,
            idempotency_key.map(str::to_owned),
        );
    }
    let mut core = shared
        .core
        .lock()
        .map_err(|_| ContractError::new("INTERNAL", "Application state is unavailable"))?;
    let before = core.latest_event_seq(&grant.project_id).ok();
    let result = core.dispatch_idempotent(
        op,
        payload,
        Origin::Agent {
            session_id: grant.session_id,
        },
        Some(&grant.project_id),
        idempotency_key,
    );
    if let Some(before) = before {
        if let Ok(events) = core.events_since(&grant.project_id, before) {
            for event in events {
                (shared.on_event)(event);
            }
        }
    }
    result
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
    let started = Instant::now();
    loop {
        let snapshot = core
            .lock()
            .map_err(|_| ContractError::new("INTERNAL", "Application state is unavailable"))?
            .proposal_wait_snapshot(project_id, proposal_id)?;
        if snapshot["state"] != "pending" || started.elapsed() >= timeout {
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
            match dispatch_agent(
                shared,
                token,
                op,
                request.get("payload").cloned().unwrap_or(json!({})),
                request["idempotencyKey"].as_str(),
            ) {
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
    use std::path::PathBuf;

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
        assert_eq!(
            read_frame(&mut stream).unwrap().unwrap()["error"]["code"],
            "CAPABILITY_DENIED"
        );
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
    }

    #[cfg(unix)]
    #[test]
    fn pty_custom_process_streams_output_and_stops() {
        let temp = tempfile::tempdir().unwrap();
        let mut core = CoreApp::new(temp.path().join("app")).unwrap();
        let project = core
            .dispatch(
                "project.create",
                json!({"path": temp.path().join("project"), "name": "PTY", "intent": "test"}),
                Origin::User,
                None,
            )
            .unwrap();
        let project_id = project["projectId"].as_str().unwrap().to_owned();
        core.configure_adapter("custom", &json!({"executablePath":"/bin/cat"}))
            .unwrap();
        let core = Arc::new(Mutex::new(core));
        let bridge =
            Arc::new(BridgeServer::start(Arc::clone(&core), &temp.path().join("app")).unwrap());
        let (sender, receiver) = std::sync::mpsc::channel();
        let notify = Arc::new(move |event| {
            let _ = sender.send(event);
        });
        let host = PtyHost::new(core, bridge, PathBuf::from("/bin/echo"), notify);
        let session = host
            .start(&project_id, &json!({"adapterId":"custom"}))
            .unwrap();
        assert_eq!(session["state"], "running");
        host.write(&project_id, "PTY roundtrip\n").unwrap();
        let mut saw_output = false;
        for _ in 0..10 {
            if let Ok(TerminalEvent::Data(data)) = receiver.recv_timeout(Duration::from_millis(500))
            {
                if data["chunk"]
                    .as_str()
                    .unwrap_or("")
                    .contains("PTY roundtrip")
                {
                    saw_output = true;
                    break;
                }
            }
        }
        assert!(saw_output, "PTY did not stream typed input");
        assert!(host.state(&project_id)["session"]["scrollback"]
            .as_str()
            .unwrap()
            .contains("PTY roundtrip"));
        host.stop(&project_id).unwrap();
        assert_eq!(host.state(&project_id)["session"]["state"], "exited");
    }

    #[cfg(unix)]
    #[test]
    fn pty_stop_terminates_child_process_group() {
        let temp = tempfile::tempdir().unwrap();
        let mut core = CoreApp::new(temp.path().join("app")).unwrap();
        let project = core
            .dispatch(
                "project.create",
                json!({"path":temp.path().join("project"),"name":"PTY children","intent":"test"}),
                Origin::User,
                None,
            )
            .unwrap();
        let project_id = project["projectId"].as_str().unwrap().to_owned();
        core.configure_adapter("custom", &json!({"executablePath":"/bin/sh"}))
            .unwrap();
        let core = Arc::new(Mutex::new(core));
        let bridge =
            Arc::new(BridgeServer::start(Arc::clone(&core), &temp.path().join("app")).unwrap());
        let (sender, receiver) = std::sync::mpsc::channel();
        let host = PtyHost::new(
            core,
            bridge,
            PathBuf::from("/bin/echo"),
            Arc::new(move |event| {
                let _ = sender.send(event);
            }),
        );
        let marker = temp.path().join("child-survived");
        host.start(&project_id, &json!({"adapterId":"custom","args":["-c","(sleep 1; touch \"$OMENFLOW_TEST_MARKER\") & echo READY; wait"],"env":{"OMENFLOW_TEST_MARKER":marker}})).unwrap();
        let mut ready = false;
        for _ in 0..10 {
            if let Ok(TerminalEvent::Data(data)) = receiver.recv_timeout(Duration::from_millis(200))
            {
                if data["chunk"].as_str().unwrap_or("").contains("READY") {
                    ready = true;
                    break;
                }
            }
        }
        assert!(ready, "shell did not launch its background child");
        host.stop(&project_id).unwrap();
        thread::sleep(Duration::from_millis(1200));
        assert!(!marker.exists(), "agent subprocess survived terminal.stop");
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
