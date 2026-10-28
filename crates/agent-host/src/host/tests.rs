use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Recorder(Mutex<Vec<HostEvent>>);

impl EventSink for Recorder {
    fn emit(&self, event: HostEvent) {
        self.0.lock().unwrap().push(event);
    }
}

impl Recorder {
    fn named(&self, name: &str) -> Vec<Value> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.name() == name)
            .map(|event| event.payload().clone())
            .collect()
    }

    fn wait_for(&self, name: &str, matches: impl Fn(&Value) -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if self.named(name).iter().any(&matches) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }
}

#[derive(Default)]
struct RecordingShell {
    revealed: Mutex<Vec<PathBuf>>,
    opened: Mutex<Vec<String>>,
    refuse: AtomicBool,
}

impl Shell for RecordingShell {
    fn reveal_path(&self, path: &Path) -> Result<(), ContractError> {
        if self.refuse.load(Ordering::SeqCst) {
            return Err(ContractError::new("INTERNAL", "File manager unavailable"));
        }
        self.revealed.lock().unwrap().push(path.to_owned());
        Ok(())
    }

    fn open_external(&self, url: &str) -> Result<(), ContractError> {
        self.opened.lock().unwrap().push(url.to_owned());
        Ok(())
    }
}

/// A page reader that serves one fixed document and records what it was asked.
#[derive(Default)]
struct ScriptedSurface {
    loaded: Mutex<Vec<String>>,
    panic_on_load: AtomicBool,
    visible: AtomicBool,
}

impl ScriptedSurface {
    fn page(url: &str) -> Value {
        json!({
            "url": url,
            "title": "DRV8835 carrier",
            "text": "Dual motor driver carrier. Operating voltage 2 V to 11 V.",
            "links": [], "images": [], "metadata": [], "structuredData": []
        })
    }
}

impl ResearchSurface for ScriptedSurface {
    fn load(&self, url: &str) -> Result<Value, ContractError> {
        if self.panic_on_load.load(Ordering::SeqCst) {
            panic!("page reader crashed");
        }
        self.loaded.lock().unwrap().push(url.to_owned());
        Ok(Self::page(url))
    }

    fn read(&self) -> Result<Value, ContractError> {
        let loaded = self.loaded.lock().unwrap();
        let url = loaded
            .last()
            .ok_or_else(|| ContractError::validation("No research page loaded"))?;
        Ok(Self::page(url))
    }

    fn link(&self, selector: &str) -> Result<Option<String>, ContractError> {
        Ok((selector == "a.datasheet").then(|| "https://example.com/datasheet".to_owned()))
    }

    fn screenshot(&self) -> Result<Value, ContractError> {
        Ok(json!({ "pngBase64": "" }))
    }

    fn toggle(&self) -> Result<Value, ContractError> {
        let visible = !self.visible.fetch_xor(true, Ordering::SeqCst);
        Ok(json!({ "visible": visible }))
    }
}

struct Fixture {
    host: Host,
    events: Arc<Recorder>,
    shell: Arc<RecordingShell>,
    surface: Arc<ScriptedSurface>,
    project_id: String,
    /// Declared last so it is removed last: the bridge needs its socket file
    /// to shut down.
    _temp: tempfile::TempDir,
}

fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let events = Arc::new(Recorder::default());
    let shell = Arc::new(RecordingShell::default());
    let surface = Arc::new(ScriptedSurface::default());
    let host = Host::start(
        HostPaths {
            app_data_dir: temp.path().join("app"),
            cli_path: PathBuf::from("/bin/echo"),
        },
        Arc::clone(&events) as Arc<dyn EventSink>,
        Arc::clone(&shell) as Arc<dyn Shell>,
        Arc::clone(&surface) as Arc<dyn ResearchSurface>,
    )
    .unwrap();
    let created = host.command(
        "project.create",
        json!({ "path": temp.path().join("project"), "name": "Host", "intent": "test" }),
        None,
        None,
    );
    assert!(created.ok, "{:?}", created.error);
    let project_id = created.result.unwrap()["projectId"]
        .as_str()
        .unwrap()
        .to_owned();
    Fixture {
        host,
        events,
        shell,
        surface,
        project_id,
        _temp: temp,
    }
}

fn ok(envelope: ResponseEnvelope) -> Value {
    assert!(envelope.ok, "{:?}", envelope.error);
    envelope.result.unwrap()
}

fn code(envelope: ResponseEnvelope) -> String {
    assert!(!envelope.ok, "{:?}", envelope.result);
    envelope.error.unwrap().code
}

#[test]
fn core_commands_answer_and_their_events_carry_the_project() {
    let f = fixture();
    let draft = ok(f.host.command(
        "artifact.create_draft",
        json!({ "type": "note", "title": "Bench notes", "payload": { "markdown": "Measured 4.9 V at the rail." } }),
        Some(&f.project_id),
        None,
    ));
    assert_eq!(draft["revision"]["reviewState"], "draft");
    let committed = f.events.named("event");
    let event = committed
        .iter()
        .find(|event| event["type"] == "revision.committed")
        .expect("the draft's event reaches the sink");
    assert_eq!(event["projectId"], f.project_id.as_str());
    assert_eq!(event["origin"], "user");
    let seqs = committed
        .iter()
        .map(|event| event["seq"].as_i64().unwrap())
        .collect::<Vec<_>>();
    let mut unique = seqs.clone();
    unique.dedup();
    assert_eq!(seqs, unique, "each event is delivered once");

    let listed = ok(f
        .host
        .command("artifact.list", json!({}), Some(&f.project_id), None));
    assert_eq!(listed["artifacts"].as_array().unwrap().len(), 1);
}

#[test]
fn unknown_operations_and_missing_projects_are_validation_errors() {
    let f = fixture();
    let unknown = f.host.command("artifact.conjure", json!({}), None, None);
    let error = unknown.error.unwrap();
    assert_eq!(error.code, "VALIDATION");
    assert_eq!(error.message, "Unknown operation: artifact.conjure");
    for op in ["terminal.state", "connection.test", "proposal.wait"] {
        let payload = match op {
            "connection.test" => json!({ "adapterId": "custom" }),
            "proposal.wait" => json!({ "proposalId": "00000000-0000-4000-8000-000000000001" }),
            _ => json!({}),
        };
        let error = f.host.command(op, payload, None, None).error.unwrap();
        assert_eq!(
            (error.code.as_str(), error.message.as_str()),
            ("VALIDATION", "Project id is required"),
            "{op}"
        );
    }
    let invalid = f
        .host
        .command("artifact.read", json!({}), Some(&f.project_id), None);
    let error = invalid.error.unwrap();
    assert_eq!(error.code, "VALIDATION");
    assert_eq!(error.issues()[0].path, "artifactId");
}

#[test]
fn idempotency_keys_reach_the_core() {
    let f = fixture();
    let input =
        json!({ "type": "note", "title": "Once", "payload": { "markdown": "One record." } });
    let first = ok(f.host.command(
        "artifact.create_draft",
        input.clone(),
        Some(&f.project_id),
        Some("retry-1"),
    ));
    let replay = ok(f.host.command(
        "artifact.create_draft",
        input,
        Some(&f.project_id),
        Some("retry-1"),
    ));
    assert_eq!(first["artifact"]["id"], replay["artifact"]["id"]);
    let listed = ok(f
        .host
        .command("artifact.list", json!({}), Some(&f.project_id), None));
    assert_eq!(listed["artifacts"].as_array().unwrap().len(), 1);
}

#[test]
fn connection_operations_are_answered_by_the_host() {
    let f = fixture();
    ok(f.host.command(
        "connection.configure",
        json!({ "adapterId": "custom", "executablePath": "/bin/cat" }),
        None,
        None,
    ));
    let listed = ok(f.host.command("connection.list", json!({}), None, None));
    let custom = listed["adapters"]
        .as_array()
        .unwrap()
        .iter()
        .find(|adapter| adapter["adapterId"] == "custom")
        .unwrap();
    assert_eq!(custom["executablePath"], "/bin/cat");
    assert_eq!(custom["available"], true);
}

#[cfg(unix)]
#[test]
fn closing_a_project_stops_its_terminal_first() {
    let f = fixture();
    ok(f.host.command(
        "connection.configure",
        json!({ "adapterId": "custom", "executablePath": "/bin/cat" }),
        None,
        None,
    ));
    assert!(!f.host.agent_running());
    let session = ok(f.host.command(
        "terminal.start",
        json!({ "adapterId": "custom" }),
        Some(&f.project_id),
        None,
    ));
    assert_eq!(session["state"], "running");
    assert!(f.host.agent_running());
    ok(f.host.command(
        "terminal.write",
        json!({ "data": "host echo\n" }),
        Some(&f.project_id),
        None,
    ));
    assert!(
        f.events.wait_for("terminal-data", |data| {
            data["projectId"] == f.project_id.as_str()
                && data["chunk"]
                    .as_str()
                    .is_some_and(|chunk| chunk.contains("host echo"))
        }),
        "terminal output reaches the sink"
    );
    ok(f.host
        .command("project.close", json!({}), Some(&f.project_id), None));
    assert!(f.events.wait_for("terminal-state", |state| {
        state["session"]["id"] == session["id"] && state["session"]["state"] == "exited"
    }));
    assert!(!f.host.agent_running());
    assert!(f.host.pty().state(&f.project_id)["session"].is_null());
    assert_eq!(
        code(
            f.host
                .command("artifact.list", json!({}), Some(&f.project_id), None)
        ),
        "NOT_FOUND",
        "the core closed the project after the terminal"
    );
}

#[cfg(unix)]
#[test]
fn shutdown_stops_every_running_session() {
    let f = fixture();
    ok(f.host.command(
        "connection.configure",
        json!({ "adapterId": "custom", "executablePath": "/bin/cat" }),
        None,
        None,
    ));
    ok(f.host.command(
        "terminal.start",
        json!({ "adapterId": "custom" }),
        Some(&f.project_id),
        None,
    ));
    assert!(f.host.agent_running());
    f.host.shutdown();
    assert!(!f.host.agent_running());
    assert_eq!(
        code(f.host.command(
            "terminal.write",
            json!({ "data": "late" }),
            Some(&f.project_id),
            None
        )),
        "NOT_FOUND"
    );
}

#[test]
fn reveal_hands_the_materialised_path_to_the_shell() {
    let f = fixture();
    let draft = ok(f.host.command(
        "artifact.create_draft",
        json!({
            "type": "software", "title": "Firmware", "payload": { "language": "python" },
            "files": [{ "path": "software/main.py", "contentBase64": "cHJpbnQoMSk=" }]
        }),
        Some(&f.project_id),
        None,
    ));
    let artifact_id = draft["artifact"]["id"].as_str().unwrap();
    ok(f.host.command(
        "artifact.accept_draft",
        json!({ "artifactId": artifact_id, "draftRevisionId": draft["revision"]["id"] }),
        Some(&f.project_id),
        None,
    ));
    let revealed = ok(f.host.command(
        "artifact.reveal",
        json!({ "artifactId": artifact_id }),
        Some(&f.project_id),
        None,
    ));
    let path = PathBuf::from(revealed["path"].as_str().unwrap());
    assert!(path.ends_with("software/main.py"));
    assert_eq!(*f.shell.revealed.lock().unwrap(), vec![path]);

    f.shell.refuse.store(true, Ordering::SeqCst);
    let refused = f.host.command(
        "artifact.reveal",
        json!({ "artifactId": artifact_id }),
        Some(&f.project_id),
        None,
    );
    assert_eq!(refused.error.unwrap().message, "File manager unavailable");
}

#[test]
fn a_panic_answers_with_an_internal_error_and_the_workspace_keeps_working() {
    let f = fixture();
    f.surface.panic_on_load.store(true, Ordering::SeqCst);
    let crashed = f.host.command(
        "research.read_page",
        json!({ "url": "https://example.com/" }),
        Some(&f.project_id),
        None,
    );
    let error = crashed.error.unwrap();
    assert_eq!(error.code, "INTERNAL");
    assert_eq!(
        error.message,
        "research.read_page stopped unexpectedly: page reader crashed"
    );
    assert!(error.repair.is_some());
    f.surface.panic_on_load.store(false, Ordering::SeqCst);
    ok(f.host.command(
        "research.read_page",
        json!({ "url": "https://example.com/" }),
        Some(&f.project_id),
        None,
    ));

    let core = Arc::clone(f.host.core());
    let poisoner = std::thread::spawn(move || {
        let _held = core.lock().unwrap();
        panic!("a command panicked while holding the workspace");
    });
    assert!(poisoner.join().is_err());
    assert!(f.host.core().is_poisoned());
    ok(f.host
        .command("artifact.list", json!({}), Some(&f.project_id), None));
    assert!(!f.host.core().is_poisoned());
}

#[test]
fn research_operations_use_the_surface_and_capture_into_the_project() {
    let f = fixture();
    let missing_project = f.host.command(
        "research.read_page",
        json!({ "url": "https://example.com/" }),
        None,
        None,
    );
    assert_eq!(
        missing_project.error.unwrap().message,
        "Project id is required"
    );

    let found = ok(f.host.command(
        "research.search",
        json!({ "query": "DRV8835 carrier", "engine": "bing" }),
        Some(&f.project_id),
        None,
    ));
    assert_eq!(
        found["url"],
        "https://www.bing.com/search?q=DRV8835+carrier"
    );

    let page = ok(f.host.command(
        "research.read_page",
        json!({ "url": "https://example.com/drv8835" }),
        Some(&f.project_id),
        None,
    ));
    assert_eq!(page["title"], "DRV8835 carrier");

    ok(f.host.command(
        "browser.follow_link",
        json!({ "selector": "a.datasheet" }),
        Some(&f.project_id),
        None,
    ));
    assert_eq!(
        f.surface.loaded.lock().unwrap().last().unwrap(),
        "https://example.com/datasheet"
    );
    assert_eq!(
        f.host
            .command(
                "browser.follow_link",
                json!({ "selector": "a.missing" }),
                Some(&f.project_id),
                None
            )
            .error
            .unwrap()
            .message,
        "selector not found"
    );

    let captured = ok(f
        .host
        .command("browser.capture", json!({}), Some(&f.project_id), None));
    assert_eq!(captured["artifact"]["type"], "source");
    assert_eq!(captured["artifact"]["title"], "DRV8835 carrier");
    assert_eq!(
        captured["revision"]["payload"]["url"],
        "https://example.com/datasheet"
    );
    assert!(f.events.named("event").iter().any(|event| {
        event["type"] == "revision.committed" && event["projectId"] == f.project_id.as_str()
    }));

    let agent = f
        .host
        .research
        .dispatch(
            "browser.capture",
            json!({ "title": "Agent capture" }),
            Origin::Agent {
                session_id: "00000000-0000-4000-8000-0000000000a1".into(),
            },
            &f.project_id,
            None,
        )
        .unwrap();
    assert_eq!(agent["revision"]["origin"], "agent");

    assert_eq!(f.host.toggle_research().unwrap()["visible"], true);
    assert_eq!(f.host.toggle_research().unwrap()["visible"], false);
}

#[test]
fn only_web_and_mail_links_leave_the_app() {
    let f = fixture();
    f.host.open_external("https://example.com/part").unwrap();
    f.host.open_external("MAILTO:lab@example.com").unwrap();
    for url in [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "bureau://x",
        "example.com",
    ] {
        assert_eq!(
            f.host.open_external(url).unwrap_err().code,
            "VALIDATION",
            "{url}"
        );
    }
    assert_eq!(
        *f.shell.opened.lock().unwrap(),
        vec!["https://example.com/part", "MAILTO:lab@example.com"]
    );
}

#[test]
fn agent_call_records_are_forwarded_on_their_own_channel() {
    let f = fixture();
    let record = json!({ "seq": 1, "tool": "cad_check", "op": "cad.check", "ok": true });
    f.host.record_agent_call(record.clone());
    assert_eq!(f.events.named("agent-call"), vec![record]);
    let event = HostEvent::AgentCall(json!({}));
    assert_eq!(event.channel(), "bureau:agent:call");
    assert_eq!(
        [
            HostEvent::Project(json!({})).channel(),
            HostEvent::TerminalData(json!({})).channel(),
            HostEvent::TerminalState(json!({})).channel(),
        ],
        [
            "bureau:event",
            "bureau:terminal:data",
            "bureau:terminal:state"
        ]
    );
}

#[test]
fn the_host_answers_guide_activity_and_tool_call_for_the_person() {
    let f = fixture();
    let start = ok(f.host.command("guide.read", json!({}), None, None));
    assert_eq!(start["topic"], "start");
    assert!(start["text"]
        .as_str()
        .unwrap()
        .contains("then call work_status"));
    let topics = start["topics"].as_array().unwrap();
    assert_eq!(topics.len(), 10);
    let verify = ok(f
        .host
        .command("guide.read", json!({ "topic": "cad-verify" }), None, None));
    assert_eq!(verify["topic"], "cad-verify");
    let unknown = f
        .host
        .command("guide.read", json!({ "topic": "soldering" }), None, None)
        .error
        .unwrap();
    assert_eq!(unknown.code, "NOT_FOUND");

    assert_eq!(
        f.host
            .command("agent.activity", json!({}), None, None)
            .error
            .unwrap()
            .message,
        "Project id is required"
    );
    let empty = ok(f
        .host
        .command("agent.activity", json!({}), Some(&f.project_id), None));
    assert_eq!(empty, json!({ "calls": [], "sessions": [] }));

    // tool.call reaches what an agent may call, in either name form, and
    // runs it as the person's own command.
    let draft = ok(f.host.command(
        "tool.call",
        json!({ "tool": "artifact_create_draft", "input": { "type": "note", "title": "Via tool call", "payload": { "markdown": "Recorded." } } }),
        Some(&f.project_id),
        None,
    ));
    assert_eq!(draft["revision"]["origin"], "user");
    let listed = ok(f.host.command(
        "tool.call",
        json!({ "tool": "artifact.list" }),
        Some(&f.project_id),
        None,
    ));
    assert_eq!(listed["artifacts"].as_array().unwrap().len(), 1);
    let denied = f
        .host
        .command(
            "tool.call",
            json!({ "tool": "proposal_approve", "input": {} }),
            Some(&f.project_id),
            None,
        )
        .error
        .unwrap();
    assert_eq!(denied.code, "CAPABILITY_DENIED");
    let missing = f
        .host
        .command(
            "tool.call",
            json!({ "tool": "artfact_list" }),
            Some(&f.project_id),
            None,
        )
        .error
        .unwrap();
    assert_eq!(missing.code, "NOT_FOUND");
    assert!(missing.repair.unwrap().contains("artifact_list"));
    let recursive = f
        .host
        .command(
            "tool.call",
            json!({ "tool": "tool_call" }),
            Some(&f.project_id),
            None,
        )
        .error
        .unwrap();
    assert_eq!(recursive.code, "VALIDATION");
}

#[cfg(unix)]
fn chat_agent(f: &Fixture, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = f._temp.path().join("structured-agent");
    std::fs::write(&path, format!("#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'codex-cli 0.100.0'; exit 0; fi\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    ok(f.host.command(
        "connection.configure",
        json!({"adapterId":"codex","executablePath":path}),
        None,
        None,
    ));
    path
}
#[cfg(unix)]
fn chat_send(f: &Fixture, conversation: &str, request: &str, text: &str) -> Value {
    ok(f.host.command(
        "chat.send",
        json!({"conversationId":conversation,"requestId":request,"text":text,"adapterId":"codex"}),
        Some(&f.project_id),
        None,
    ))
}
#[cfg(unix)]
fn chat_settled(f: &Fixture) -> Value {
    let until = Instant::now() + Duration::from_secs(8);
    loop {
        let value = ok(f
            .host
            .command("chat.read", json!({}), Some(&f.project_id), None));
        if value["conversations"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|c| c["turns"].as_array().unwrap())
            .all(|t| t["state"] != "running")
        {
            return value;
        }
        assert!(Instant::now() < until, "chat did not settle: {value}");
        std::thread::sleep(Duration::from_millis(20));
    }
}
#[test]
#[cfg(unix)]
fn chat_structured_runs_are_durable_deduplicated_and_project_scoped() {
    let f = fixture();
    let count = f._temp.path().join("executions");
    chat_agent(&f, &format!("cat >/dev/null\necho run >> '{}'\nprintf '%s\\n' '{{\"type\":\"item.completed\",\"item\":{{\"type\":\"agent_message\",\"text\":\"Width is 20 mm; load remains unknown.\"}}}}' '{{\"type\":\"turn.completed\"}}'", count.display()));
    let accepted = chat_send(&f, "conversation-one", "request-one", "Inspect dimensions");
    assert_eq!(accepted["conversations"][0]["turns"][0]["state"], "running");
    let settled = chat_settled(&f);
    assert_eq!(
        settled["conversations"][0]["turns"][0]["state"],
        "completed"
    );
    assert!(settled["conversations"][0]["turns"][0]["response"]
        .as_str()
        .unwrap()
        .contains("20 mm"));
    chat_send(&f, "conversation-one", "request-one", "Inspect dimensions");
    assert_eq!(std::fs::read_to_string(&count).unwrap().lines().count(), 1);
    let second = ok(f.host.command(
        "project.create",
        json!({"path":f._temp.path().join("second"),"name":"Other"}),
        None,
        None,
    ));
    let other = ok(f
        .host
        .command("chat.read", json!({}), second["projectId"].as_str(), None));
    assert!(other["conversations"].as_array().unwrap().is_empty());
    let project_id = f.project_id.clone();
    let root = f._temp.path().join("project");
    f.host.shutdown();
    let Fixture { host, _temp, .. } = f;
    drop(host);
    let restarted = Host::start(
        HostPaths {
            app_data_dir: _temp.path().join("app"),
            cli_path: PathBuf::from("/bin/echo"),
        },
        Arc::new(Recorder::default()),
        Arc::new(RecordingShell::default()),
        Arc::new(ScriptedSurface::default()),
    )
    .unwrap();
    ok(restarted.command("project.open", json!({"path":root}), None, None));
    let replay = ok(restarted.command("chat.send",json!({"conversationId":"conversation-one","requestId":"request-one","text":"Inspect dimensions","adapterId":"codex"}),Some(&project_id),None));
    assert_eq!(
        replay["conversations"][0]["turns"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(std::fs::read_to_string(&count).unwrap().lines().count(), 1);
    assert_eq!(code(restarted.command("chat.send",json!({"conversationId":"conversation-two","requestId":"request-one","text":"Changed","adapterId":"codex"}),Some(&project_id),None)),"VALIDATION");
    restarted.shutdown();
}
#[test]
#[cfg(unix)]
fn chat_cancel_settles_the_owned_process_group_and_preserves_partial_text() {
    let f = fixture();
    let pidfile = f._temp.path().join("child-pid");
    chat_agent(&f,&format!("cat >/dev/null\nprintf '%s\\n' '{{\"type\":\"item.completed\",\"item\":{{\"type\":\"agent_message\",\"text\":\"Draft started.\"}}}}'\n(sh -c 'trap \"\" TERM; while :; do sleep 1; done') &\necho $! > '{}'\nwait",pidfile.display()));
    chat_send(&f, "conversation", "request", "Start");
    // The shell creates the file before it writes the id: wait for the whole line.
    let until = Instant::now() + Duration::from_secs(5);
    let pid: i32 = loop {
        let written = std::fs::read_to_string(&pidfile).unwrap_or_default();
        if let (true, Ok(pid)) = (written.ends_with('\n'), written.trim().parse()) {
            break pid;
        }
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(20));
    };
    let cancelled = ok(f.host.command(
        "chat.cancel",
        json!({"conversationId":"conversation"}),
        Some(&f.project_id),
        None,
    ));
    assert_eq!(
        cancelled["conversations"][0]["turns"][0]["state"],
        "cancelled"
    );
    assert_eq!(
        cancelled["conversations"][0]["turns"][0]["response"],
        "Draft started."
    );
    assert!(
        cancelled["conversations"][0]["turns"][0]
            .get("gate")
            .is_none(),
        "a stopped response records no completion gate"
    );
    let until = Instant::now() + Duration::from_secs(3);
    loop {
        let alive = unsafe { libc::kill(pid, 0) == 0 };
        if !alive {
            break;
        }
        assert!(
            Instant::now() < until,
            "descendant {pid} still exists after cancellation"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!f.host.agent_running());
    f.host.shutdown();
}
#[test]
#[cfg(unix)]
fn chat_invalid_output_never_becomes_a_success_or_terminal_session() {
    let f = fixture();
    chat_agent(&f, "cat >/dev/null; printf 'not a JSON stream\\n'");
    chat_send(&f, "conversation", "request", "Start");
    let result = chat_settled(&f);
    assert_eq!(result["conversations"][0]["turns"][0]["state"], "failed");
    assert_eq!(result["conversations"][0]["turns"][0]["response"], "");
    let terminal = ok(f
        .host
        .command("terminal.state", json!({}), Some(&f.project_id), None));
    assert!(terminal["session"].is_null());
    let root = f._temp.path().join("project");
    let saved = std::fs::read_to_string(root.join(".bureau/chat/conversations.json")).unwrap();
    assert!(!saved.contains("BUREAU_BRIDGE_TOKEN"));
    f.host.shutdown();
}

#[test]
#[cfg(unix)]
fn chat_clean_leader_exit_settles_inherited_pipe_descendant_before_publishing_completion() {
    let f = fixture();
    let pidfile = f._temp.path().join("orphan-pid");
    chat_agent(&f, &format!("cat >/dev/null\nprintf '%s\\n' '{{\"type\":\"item.completed\",\"item\":{{\"type\":\"agent_message\",\"text\":\"Leader finished.\"}}}}' '{{\"type\":\"turn.completed\"}}'\n(sh -c 'trap \"\" TERM; while :; do sleep 1; done') &\necho $! > '{}'\nexit 0",pidfile.display()));
    let accepted = chat_send(&f, "conversation", "request", "Start");
    let session = accepted["conversations"][0]["turns"][0]["sessionId"]
        .as_str()
        .unwrap();
    let result = chat_settled(&f);
    assert_eq!(result["conversations"][0]["turns"][0]["state"], "completed");
    let pid: i32 = std::fs::read_to_string(pidfile)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let until = Instant::now() + Duration::from_secs(3);
    while unsafe { libc::kill(pid, 0) == 0 } {
        assert!(
            Instant::now() < until,
            "pipe-holding descendant survived clean leader exit"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let activity = ok(f.host.command(
        "agent.activity",
        json!({"sessionId":session}),
        Some(&f.project_id),
        None,
    ));
    assert!(activity["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["sessionId"] == session && s["endedAt"].is_string()));
    assert!(!f.host.agent_running());
    f.host.shutdown();
}

#[test]
#[cfg(unix)]
fn a_conversation_run_announces_each_change_to_its_record() {
    let f = fixture();
    let lines = [
        json!({"type":"item.updated","item":{"id":"m","type":"agent_message","text":"Width"}}),
        json!({"type":"item.started","item":{"id":"t","type":"command_execution","command":"ls"}}),
        json!({"type":"item.completed","item":{"id":"m","type":"agent_message","text":"Width is 20 mm."}}),
        json!({"type":"item.completed","item":{"id":"m","type":"agent_message","text":"Width is 20 mm."}}),
    ]
    .iter()
    .map(|line| format!("'{line}'"))
    .collect::<Vec<_>>()
    .join(" ");
    let finish = f._temp.path().join("finish");
    chat_agent(
        &f,
        &format!(
            "cat >/dev/null\nprintf '%s\\n' {lines}\nwhile [ ! -e '{}' ]; do sleep 0.05; done\nprintf '%s\\n' '{}'",
            finish.display(),
            json!({"type":"turn.completed"})
        ),
    );
    let accepted = chat_send(&f, "conversation", "request", "Inspect dimensions");
    let session = accepted["conversations"][0]["turns"][0]["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let reply = agent_call(
        &f,
        &session,
        "chat.present",
        json!({"part": {"kind": "chart", "title": "Load", "xLabel": "Time", "xUnit": "s", "yLabel": "Load", "yUnit": "N", "source": "Estimate", "provenance": "illustrative", "points": [{"x": 0, "y": 1}, {"x": 1, "y": 2}]}}),
    );
    assert_eq!(reply["ok"], true, "{reply}");
    std::fs::write(&finish, "").unwrap();
    let settled = chat_settled(&f);
    let turn = &settled["conversations"][0]["turns"][0];
    assert_eq!(turn["state"], "completed");
    assert_eq!(turn["response"], "Width is 20 mm.");
    assert_eq!(turn["parts"].as_array().unwrap().len(), 1);
    // The gate is part of the one settling save: nothing was touched, one call was made.
    assert_eq!(turn["gate"]["ready"], true);
    assert_eq!(
        (&turn["gate"]["calls"], &turn["gate"]["inScope"]),
        (&json!(1), &json!(0))
    );
    assert!(turn["gate"].get("auto").is_none());

    let changes = f.events.named("chat");
    for change in &changes {
        assert_eq!(
            *change,
            json!({"projectId": f.project_id, "seq": change["seq"]}),
            "a change names the project and its sequence, never the record"
        );
    }
    let seqs = changes
        .iter()
        .map(|change| change["seq"].as_u64().unwrap())
        .collect::<Vec<_>>();
    assert!(seqs.windows(2).all(|pair| pair[0] < pair[1]), "{seqs:?}");
    assert_eq!(
        changes.len(),
        5,
        "acceptance, two text changes, the presented card and the settled turn; the tool line and the repeated item change nothing: {changes:?}"
    );
    assert_eq!(HostEvent::Chat(json!({})).channel(), "bureau:chat");
    f.host.shutdown();
}

/// Every turn of the first conversation, once none runs.
#[cfg(unix)]
fn settled_turns(f: &Fixture) -> Vec<Value> {
    chat_settled(f)["conversations"][0]["turns"]
        .as_array()
        .unwrap()
        .clone()
}

/// A Codex stand-in that counts its runs, keeps each prompt as `prompt-<n>`, and holds its
/// first run until `finish` exists, so a test can act as that run's session meanwhile.
#[cfg(unix)]
fn counting_agent(f: &Fixture, last: &str) -> (PathBuf, PathBuf) {
    let dir = f._temp.path().to_owned();
    let finish = dir.join("finish");
    let message = json!({"type": "item.completed", "item": {"id": "m", "type": "agent_message", "text": "Worked on it."}});
    chat_agent(
        f,
        &format!(
            "n=$(($(cat '{count}' 2>/dev/null || echo 0) + 1)); echo $n > '{count}'\ncat > '{dir}/prompt-'$n\nif [ $n = 1 ]; then while [ ! -e '{finish}' ]; do sleep 0.05; done; fi\nprintf '%s\\n' '{message}' '{last}'",
            count = dir.join("executions").display(),
            dir = dir.display(),
            finish = finish.display(),
        ),
    );
    (dir, finish)
}

#[cfg(unix)]
fn executions(dir: &Path) -> usize {
    std::fs::read_to_string(dir.join("executions"))
        .map(|count| count.trim().parse().unwrap())
        .unwrap_or(0)
}

#[cfg(unix)]
fn session_of(accepted: &Value) -> String {
    accepted["conversations"][0]["turns"][0]["sessionId"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[cfg(unix)]
fn auto_continue(f: &Fixture) {
    ok(f.host.command(
        "settings.set",
        json!({"key": "conversation.autoContinue", "value": true}),
        None,
        None,
    ));
}

#[test]
#[cfg(unix)]
fn a_completed_turn_records_the_gate_of_its_session() {
    let f = fixture();
    let (_, finish) = counting_agent(&f, &json!({"type": "turn.completed"}).to_string());
    let accepted = chat_send(&f, "conversation", "r1", "Add the steering servo");
    let session = session_of(&accepted);
    let reply = agent_call(
        &f,
        &session,
        "artifact.create_draft",
        json!({"type": "component", "title": "Steering servo", "payload": {"partNumber": "MG996R"}}),
    );
    assert_eq!(reply["ok"], true, "{reply}");
    std::fs::write(&finish, "").unwrap();
    let turns = settled_turns(&f);
    assert_eq!(turns.len(), 1);
    let gate = &turns[0]["gate"];
    assert_eq!(turns[0]["state"], "completed");
    assert_eq!(gate["ready"], false);
    assert_eq!(
        gate["summary"],
        "1 component has no source. 1 component has no seller offer."
    );
    assert_eq!(gate["blockers"], 2);
    let items = gate["outstanding"].as_array().unwrap();
    assert_eq!(
        items
            .iter()
            .map(|item| (&item["kind"], &item["tool"]))
            .collect::<Vec<_>>(),
        [
            (&json!("component_unsourced"), &json!("source_capture")),
            (&json!("component_no_offer"), &json!("component_add_offer"))
        ]
    );
    assert_eq!(gate["sessionIds"], json!([session]));
    assert_eq!(
        (&gate["calls"], &gate["inScope"], &gate["jobsRunning"]),
        (&json!(1), &json!(1), &json!(0))
    );
    assert_eq!(
        gate["auto"],
        json!({"state": "off"}),
        "off unless Settings asks"
    );

    // A response that touched nothing and called nothing is ready, and says so honestly.
    chat_send(&f, "conversation", "r2", "What is the stall torque?");
    let turns = settled_turns(&f);
    assert_eq!(turns.len(), 2);
    let gate = &turns[1]["gate"];
    assert_eq!(gate["ready"], true);
    assert_eq!((&gate["calls"], &gate["inScope"]), (&json!(0), &json!(0)));
    assert!(gate.get("auto").is_none());
    f.host.shutdown();
}

#[test]
#[cfg(unix)]
fn unfinished_work_is_continued_once_when_the_setting_is_on() {
    let f = fixture();
    auto_continue(&f);
    let (dir, finish) = counting_agent(&f, &json!({"type": "turn.completed"}).to_string());
    let accepted = chat_send(&f, "conversation", "r1", "Write the test notes");
    let first_session = session_of(&accepted);
    let reply = agent_call(
        &f,
        &first_session,
        "artifact.create_draft",
        json!({"type": "note", "title": "Test notes", "payload": {"markdown": ""}}),
    );
    assert_eq!(reply["ok"], true, "{reply}");
    std::fs::write(&finish, "").unwrap();
    let turns = settled_turns(&f);
    assert_eq!(turns.len(), 2, "{turns:?}");
    let (first, second) = (&turns[0], &turns[1]);
    assert_eq!(
        first["gate"]["auto"],
        json!({"state": "started", "requestId": "r1-auto"})
    );
    assert_eq!(second["requestId"], "r1-auto");
    assert_eq!(second["text"], crate::chat::CONTINUE_TEXT);
    assert_eq!(
        second["continues"],
        json!({"requestId": "r1", "automatic": true})
    );
    assert_eq!(second["state"], "completed");
    // The continuation's gate covers both sessions; it never continues itself.
    let second_session = second["sessionId"].as_str().unwrap();
    assert_eq!(
        second["gate"]["sessionIds"],
        json!([first_session, second_session])
    );
    assert_eq!(second["gate"]["ready"], false);
    assert_eq!(
        second["gate"]["auto"],
        json!({"state": "skipped", "reason": "already_continued"})
    );
    let prompt = std::fs::read_to_string(dir.join("prompt-2")).unwrap();
    assert!(prompt.contains("User: Write the test notes\n"), "{prompt}");
    assert!(prompt.contains("Bureau ran work_status after the previous reply (recorded by the host, not by the agent): 1 draft is empty."));
    let notes = reply["result"]["artifact"]["id"].as_str().unwrap();
    assert!(prompt.contains(&format!(
        "- Test notes (empty_payload, artifactId {notes}): Draft r1 has no content yet. Next: artifact_update_draft."
    )));
    assert!(prompt.contains("In this run, work_status and the workStatus digest on check replies cover the previous replies' work as well as yours"));
    assert!(prompt.contains(&format!(
        "Bureau (automatic continuation): {}\n",
        crate::chat::CONTINUE_TEXT
    )));
    assert_eq!(executions(&dir), 2);
    f.host.shutdown();
}

/// A Codex stand-in that keeps each run's bridge token as `token-<n>` and holds run `n` until
/// `finish-<n>` exists, so a test can call as each run's own session, through its own grant.
#[cfg(unix)]
fn holding_agent(f: &Fixture) -> PathBuf {
    let dir = f._temp.path().to_owned();
    let message = json!({"type": "item.completed", "item": {"id": "m", "type": "agent_message", "text": "Worked on it."}});
    chat_agent(
        f,
        &format!(
            "n=$(($(cat '{count}' 2>/dev/null || echo 0) + 1)); echo $n > '{count}'\ncat >/dev/null\nprintf '%s' \"$BUREAU_BRIDGE_TOKEN\" > '{dir}/token.tmp' && mv '{dir}/token.tmp' '{dir}/token-'$n\nwhile [ ! -e '{dir}/finish-'$n ]; do sleep 0.05; done\nprintf '%s\\n' '{message}' '{completed}'",
            count = dir.join("executions").display(),
            dir = dir.display(),
            completed = json!({"type": "turn.completed"}),
        ),
    );
    dir
}

/// The token run `n` of [`holding_agent`] was started with.
#[cfg(unix)]
fn run_token(dir: &Path, n: usize) -> String {
    let path = dir.join(format!("token-{n}"));
    let until = Instant::now() + Duration::from_secs(10);
    while !path.exists() {
        assert!(Instant::now() < until, "run {n} never started");
        std::thread::sleep(Duration::from_millis(20));
    }
    std::fs::read_to_string(path).unwrap()
}

/// A continuation's own work_status covers the turns it continues, as the gate on its turn
/// does: it is not ready while their work is unfinished, and ready once the continuation has
/// done it. Any other session's answer, and the project scope, are unchanged.
#[test]
#[cfg(unix)]
fn a_continuations_own_work_status_covers_the_turns_it_continues() {
    let f = fixture();
    let dir = holding_agent(&f);
    let first = session_of(&chat_send(&f, "conversation", "r1", "Write the test notes"));
    let earlier = run_token(&dir, 1);
    let drafted = call_with_token(
        &f,
        &earlier,
        "artifact.create_draft",
        json!({"type": "note", "title": "Test notes", "payload": {"markdown": ""}}),
    );
    assert_eq!(drafted["ok"], true, "{drafted}");
    std::fs::write(dir.join("finish-1"), "").unwrap();
    let turns = settled_turns(&f);
    assert_eq!(turns[0]["gate"]["ready"], false, "{turns:?}");
    let item = &turns[0]["gate"]["outstanding"][0];
    assert_eq!(item["kind"], "empty_payload");
    let notes = item["artifactId"].as_str().unwrap().to_owned();

    // The person presses Continue.
    ok(f.host.command(
        "chat.send",
        json!({"conversationId": "conversation", "requestId": "r2", "text": crate::chat::CONTINUE_TEXT,
               "adapterId": "codex", "continues": {"requestId": "r1"}}),
        Some(&f.project_id),
        None,
    ));
    let token = run_token(&dir, 2);
    let status = call_with_token(&f, &token, "work.status", json!({}));
    assert_eq!(status["ok"], true, "{status}");
    let status = &status["result"];
    let second = status["sessionId"].as_str().unwrap().to_owned();
    assert_ne!(second, first);
    assert_eq!(status["scope"], "session");
    assert_eq!(status["ready"], false, "{status}");
    assert_eq!(status["sessionIds"], json!([first, second]));
    assert_eq!(status["summary"], "1 draft is empty.");
    let blocker = &status["outstanding"][0];
    assert_eq!(blocker["artifactId"], notes.as_str());
    assert_eq!(blocker["next"]["args"]["artifactId"], notes.as_str());
    assert!(status.get("inScope").is_none() && status.get("jobsRunning").is_none());
    // A session that continues nothing still answers for itself alone.
    let unrelated = agent_call(&f, "unrelated-session", "work.status", json!({}));
    assert_eq!(unrelated["result"]["ready"], true, "{unrelated}");
    assert!(unrelated["result"].get("sessionIds").is_none());
    // The project scope is the core's, whoever asks.
    let project = call_with_token(&f, &token, "work.status", json!({"scope": "project"}));
    assert_eq!(project["result"]["scope"], "project", "{project}");
    assert_eq!(project["result"]["ready"], false);

    // The continuation finishes the earlier turn's work: now it is ready.
    let filled = call_with_token(
        &f,
        &token,
        "artifact.update_draft",
        json!({"artifactId": notes, "payload": {"markdown": "Measured 4.9 V at the rail."}}),
    );
    assert_eq!(filled["ok"], true, "{filled}");
    let status = call_with_token(&f, &token, "work.status", json!({}));
    assert_eq!(status["result"]["ready"], true, "{status}");
    std::fs::write(dir.join("finish-2"), "").unwrap();
    let turns = settled_turns(&f);
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[1]["sessionId"], second.as_str());
    assert_eq!(turns[1]["gate"]["sessionIds"], json!([first, second]));
    assert_eq!(turns[1]["gate"]["ready"], true, "{turns:?}");
    f.host.shutdown();
}

#[test]
#[cfg(unix)]
fn sourcing_is_never_continued_automatically() {
    let f = fixture();
    auto_continue(&f);
    let (dir, finish) = counting_agent(&f, &json!({"type": "turn.completed"}).to_string());
    let session = session_of(&chat_send(&f, "conversation", "r1", "Add the servo"));
    agent_call(
        &f,
        &session,
        "artifact.create_draft",
        json!({"type": "component", "title": "Steering servo", "payload": {"partNumber": "MG996R"}}),
    );
    std::fs::write(&finish, "").unwrap();
    let turns = settled_turns(&f);
    assert_eq!(turns.len(), 1);
    assert_eq!(
        turns[0]["gate"]["auto"],
        json!({"state": "skipped", "reason": "needs_person"}),
        "a source and an offer need facts from outside the project"
    );
    assert_eq!(executions(&dir), 1);
    f.host.shutdown();
}

#[test]
#[cfg(unix)]
fn a_continuation_that_cannot_start_leaves_the_offer() {
    let f = fixture();
    auto_continue(&f);
    let (dir, finish) = counting_agent(&f, &json!({"type": "turn.completed"}).to_string());
    let session = session_of(&chat_send(&f, "conversation", "r1", "Write the notes"));
    agent_call(
        &f,
        &session,
        "artifact.create_draft",
        json!({"type": "note", "title": "Notes", "payload": {"markdown": ""}}),
    );
    let missing = f._temp.path().join("missing-codex");
    ok(f.host.command(
        "connection.configure",
        json!({"adapterId": "codex", "executablePath": missing}),
        None,
        None,
    ));
    std::fs::write(&finish, "").unwrap();
    let turns = settled_turns(&f);
    assert_eq!(turns.len(), 1);
    let auto = &turns[0]["gate"]["auto"];
    assert_eq!(auto["state"], "skipped");
    assert_eq!(auto["reason"], "agent_unavailable");
    assert!(
        auto["detail"].as_str().unwrap().contains("not found"),
        "{auto}"
    );
    assert_eq!(executions(&dir), 1);
    assert!(!f.host.agent_running());
    f.host.shutdown();
}

#[test]
#[cfg(unix)]
fn a_failed_turn_records_its_gate_and_is_never_continued() {
    let f = fixture();
    auto_continue(&f);
    let failed = json!({"type": "turn.failed", "error": {"message": "Reached the turn limit"}});
    let (dir, finish) = counting_agent(&f, &failed.to_string());
    let session = session_of(&chat_send(&f, "conversation", "r1", "Write the notes"));
    agent_call(
        &f,
        &session,
        "artifact.create_draft",
        json!({"type": "note", "title": "Notes", "payload": {"markdown": ""}}),
    );
    std::fs::write(&finish, "").unwrap();
    let turns = settled_turns(&f);
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0]["state"], "failed");
    assert_eq!(turns[0]["error"], "Reached the turn limit");
    assert_eq!(turns[0]["gate"]["ready"], false);
    assert!(turns[0]["gate"].get("auto").is_none());
    assert_eq!(executions(&dir), 1);
    f.host.shutdown();
}

#[test]
#[cfg(unix)]
fn a_user_continue_must_name_the_latest_turn_and_cannot_claim_to_be_automatic() {
    let f = fixture();
    chat_agent(
        &f,
        &format!(
            "cat >/dev/null\nprintf '%s\\n' '{}'",
            json!({"type": "turn.completed"})
        ),
    );
    let send = |request: &str, continues: Value| {
        f.host.command(
            "chat.send",
            json!({"conversationId": "conversation", "requestId": request, "text": "Continue", "adapterId": "codex", "continues": continues}),
            Some(&f.project_id),
            None,
        )
    };
    chat_send(&f, "conversation", "r1", "First");
    settled_turns(&f);
    chat_send(&f, "conversation", "r2", "Second");
    settled_turns(&f);
    for stale in ["r1", "unknown"] {
        let refused = send("r3", json!({"requestId": stale})).error.unwrap();
        assert_eq!(refused.code, "VALIDATION");
        assert_eq!(
            refused.message,
            "Only the latest turn of a conversation can be continued"
        );
    }
    // The transport drops what it does not know: only the host sends an automatic request.
    ok(send("r3", json!({"requestId": "r2", "automatic": true})));
    let turns = settled_turns(&f);
    assert_eq!(turns.len(), 3);
    assert_eq!(
        turns[2]["continues"],
        json!({"requestId": "r2", "automatic": false})
    );
    ok(send("r3", json!({"requestId": "r2"})));
    assert_eq!(
        code(f.host.command(
            "chat.send",
            json!({"conversationId": "conversation", "requestId": "r3", "text": "Continue", "adapterId": "codex"}),
            Some(&f.project_id),
            None,
        )),
        "VALIDATION",
        "a replay must carry what was accepted"
    );
    assert_eq!(settled_turns(&f).len(), 3);
    f.host.shutdown();
}

/// A Claude Code stand-in that answers its version probe as 2.1.287, keeps each run's
/// arguments and prompt, reports the session it was given or resumed and the model it was
/// passed, and holds its first run until `finish` exists. A run asked to resume `gone` says
/// there is no such conversation, as the CLI does.
#[cfg(unix)]
fn claude_agent(f: &Fixture, gone: &str) -> (PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let dir = f._temp.path().to_owned();
    let finish = dir.join("finish");
    let path = dir.join("claude-agent");
    let result =
        json!({"type": "result", "subtype": "success", "is_error": false, "result": "Done."});
    std::fs::write(
        &path,
        format!(
            r#"#!/bin/sh
if [ "$1" = "--version" ]; then echo '2.1.287 (Claude Code)'; exit 0; fi
n=$(($(cat '{count}' 2>/dev/null || echo 0) + 1)); echo $n > '{count}'
printf '%s\n' "$@" > '{dir}/argv-'$n
cat > '{dir}/prompt-'$n
id=''; model='fixture-model'; previous=''
for argument in "$@"; do
  case "$previous" in --session-id|--resume) id="$argument" ;; --model) model="$argument" ;; esac
  previous="$argument"
done
case " $* " in *" --resume {gone} "*) echo "No conversation found with session ID: {gone}" >&2; exit 1 ;; esac
if [ $n = 1 ]; then while [ ! -e '{finish}' ]; do sleep 0.05; done; fi
printf '{{"type":"system","subtype":"init","session_id":"%s","model":"%s","mcp_servers":[{{"name":"bureau","status":"connected"}}]}}\n' "$id" "$model"
printf '%s\n' '{result}'
"#,
            count = dir.join("executions").display(),
            dir = dir.display(),
            finish = finish.display(),
        ),
    )
    .unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    ok(f.host.command(
        "connection.configure",
        json!({"adapterId": "claude-code", "executablePath": path, "model": "claude-haiku-5-5"}),
        None,
        None,
    ));
    (dir, finish)
}

#[cfg(unix)]
fn after(argv: &str, flag: &str) -> Option<String> {
    let lines = argv.lines().collect::<Vec<_>>();
    lines
        .iter()
        .position(|line| *line == flag)
        .map(|at| lines[at + 1].to_owned())
}

#[cfg(unix)]
fn claude_send(f: &Fixture, request: &str, text: &str, continues: Option<&str>) -> Value {
    let mut send = json!({"conversationId": "conversation", "requestId": request, "text": text, "adapterId": "claude-code"});
    if let Some(continued) = continues {
        send["continues"] = json!({"requestId": continued});
    }
    ok(f.host.command("chat.send", send, Some(&f.project_id), None))
}

#[test]
#[cfg(unix)]
fn a_claude_code_continuation_resumes_the_cli_conversation() {
    let f = fixture();
    let (dir, finish) = claude_agent(&f, "never");
    let session = session_of(&claude_send(&f, "r1", "Write the bracket notes", None));
    agent_call(
        &f,
        &session,
        "artifact.create_draft",
        json!({"type": "note", "title": "Notes", "payload": {"markdown": ""}}),
    );
    std::fs::write(&finish, "").unwrap();
    let turns = settled_turns(&f);
    assert_eq!(turns[0]["state"], "completed", "{turns:?}");
    assert_eq!(turns[0]["cliConversationId"], session.as_str());
    assert_eq!(turns[0]["model"], "claude-haiku-5-5");
    assert_eq!(turns[0]["resolvedModel"], "claude-haiku-5-5");
    let first = std::fs::read_to_string(dir.join("argv-1")).unwrap();
    assert_eq!(
        after(&first, "--session-id").as_deref(),
        Some(session.as_str())
    );

    claude_send(&f, "r2", crate::chat::CONTINUE_TEXT, Some("r1"));
    let turns = settled_turns(&f);
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[1]["state"], "completed", "{turns:?}");
    let argv = std::fs::read_to_string(dir.join("argv-2")).unwrap();
    assert_eq!(after(&argv, "--resume").as_deref(), Some(session.as_str()));
    assert!(!argv.lines().any(|line| line == "--session-id"), "{argv}");
    assert_eq!(after(&argv, "--model").as_deref(), Some("claude-haiku-5-5"));
    let prompt = std::fs::read_to_string(dir.join("prompt-2")).unwrap();
    assert!(prompt.starts_with("Bureau resumed this conversation with a new tool session."));
    assert!(
        !prompt.contains("User: Write the bracket notes"),
        "{prompt}"
    );
    assert!(prompt.contains("Next: artifact_update_draft."));
    assert!(prompt.ends_with(&format!(
        "User (continue): {}\n",
        crate::chat::CONTINUE_TEXT
    )));
    // A new Bureau session in the same CLI conversation.
    assert_ne!(turns[1]["sessionId"], session.as_str());
    assert_eq!(turns[1]["cliConversationId"], session.as_str());
    assert_eq!(
        turns[1]["gate"]["sessionIds"],
        json!([session, turns[1]["sessionId"]])
    );
    f.host.shutdown();
}

#[test]
#[cfg(unix)]
fn a_resumed_conversation_that_is_gone_is_replayed_once() {
    let f = fixture();
    let (dir, finish) = claude_agent(&f, "");
    std::fs::write(&finish, "").unwrap();
    let session = session_of(&claude_send(&f, "r1", "Write the bracket notes", None));
    settled_turns(&f);
    // The stand-in refuses to resume this one session: its conversation is gone.
    claude_agent(&f, &session);
    claude_send(&f, "r2", crate::chat::CONTINUE_TEXT, Some("r1"));
    let turns = settled_turns(&f);
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[1]["state"], "completed", "{turns:?}");
    assert_eq!(executions(&dir), 3);
    let resumed = std::fs::read_to_string(dir.join("argv-2")).unwrap();
    assert_eq!(
        after(&resumed, "--resume").as_deref(),
        Some(session.as_str())
    );
    let replayed = std::fs::read_to_string(dir.join("argv-3")).unwrap();
    assert!(after(&replayed, "--resume").is_none());
    let fresh = after(&replayed, "--session-id").unwrap();
    assert_eq!(turns[1]["sessionId"], fresh.as_str());
    assert_eq!(turns[1]["cliConversationId"], fresh.as_str());
    let prompt = std::fs::read_to_string(dir.join("prompt-3")).unwrap();
    assert!(
        prompt.contains("User: Write the bracket notes\n"),
        "{prompt}"
    );
    assert!(prompt.contains(&format!(
        "User (continue): {}\n",
        crate::chat::CONTINUE_TEXT
    )));
    f.host.shutdown();
}

/// Closing a project while a send is being accepted must not deadlock: closing stops the
/// run, which takes the conversation state, while acceptance holds it and reads the core.
#[test]
#[cfg(unix)]
fn a_send_racing_project_close_never_deadlocks() {
    let f = fixture();
    chat_agent(&f, "cat >/dev/null\nwhile :; do sleep 1; done");
    let root = f._temp.path().join("project");
    let Fixture {
        host,
        project_id,
        _temp,
        ..
    } = f;
    let host = Arc::new(host);
    for round in 0..6 {
        let (done, finished) = std::sync::mpsc::channel();
        for op in ["chat.send", "project.close"] {
            let (host, done, project_id) = (Arc::clone(&host), done.clone(), project_id.clone());
            std::thread::spawn(move || {
                let payload = if op == "chat.send" {
                    json!({"conversationId": "race", "requestId": format!("race-{round}"), "text": "Go", "adapterId": "codex"})
                } else {
                    json!({})
                };
                host.command(op, payload, Some(&project_id), None);
                let _ = done.send(op);
            });
        }
        for _ in 0..2 {
            finished
                .recv_timeout(Duration::from_secs(10))
                .unwrap_or_else(|_| panic!("round {round}: a command did not return within 10 s"));
        }
        ok(host.command("project.open", json!({"path": root}), None, None));
        ok(host.command(
            "chat.cancel",
            json!({"conversationId": "race"}),
            Some(&project_id),
            None,
        ));
    }
    host.shutdown();
    // The bridge's socket lives in the folder: the host goes first.
    let until = Instant::now() + Duration::from_secs(5);
    while Arc::strong_count(&host) > 1 && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(10));
    }
    drop(host);
    drop(_temp);
}

/// One call from an agent session on the bridge, as the `bureau` helper makes it.
#[cfg(unix)]
fn agent_call(f: &Fixture, session: &str, op: &str, payload: Value) -> Value {
    let token = f.host.bridge().issue_token(&f.project_id, session);
    call_with_token(f, &token, op, payload)
}

/// One call on the bridge with a token a session was given.
#[cfg(unix)]
fn call_with_token(f: &Fixture, token: &str, op: &str, payload: Value) -> Value {
    use bureau_contracts::{read_frame, write_frame};
    let mut stream =
        std::os::unix::net::UnixStream::connect(f.host.bridge().socket_path()).unwrap();
    write_frame(
        &mut stream,
        &json!({"type": "hello", "protocolVersion": 1, "mode": "call", "token": token}),
    )
    .unwrap();
    assert_eq!(read_frame(&mut stream).unwrap().unwrap()["type"], "welcome");
    write_frame(
        &mut stream,
        &json!({"requestId": op, "op": op, "payload": payload}),
    )
    .unwrap();
    read_frame(&mut stream).unwrap().unwrap()
}

#[test]
#[cfg(unix)]
fn one_agent_works_in_a_project_at_a_time() {
    let f = fixture();
    chat_agent(
        &f,
        "cat >/dev/null\nprintf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Working.\"}}'\nwhile :; do sleep 1; done",
    );
    ok(f.host.command(
        "connection.configure",
        json!({ "adapterId": "custom", "executablePath": "/bin/cat" }),
        None,
        None,
    ));
    chat_send(&f, "conversation", "request-one", "Start");
    let refused = f
        .host
        .command(
            "terminal.start",
            json!({ "adapterId": "custom" }),
            Some(&f.project_id),
            None,
        )
        .error
        .unwrap();
    assert_eq!(refused.code, "BUSY", "{}", refused.message);
    assert!(f.host.pty().state(&f.project_id)["session"].is_null());

    ok(f.host.command(
        "chat.cancel",
        json!({"conversationId":"conversation"}),
        Some(&f.project_id),
        None,
    ));
    let session = ok(f.host.command(
        "terminal.start",
        json!({ "adapterId": "custom" }),
        Some(&f.project_id),
        None,
    ));
    assert_eq!(session["state"], "running");
    let busy = f
        .host
        .command(
            "chat.send",
            json!({"conversationId":"conversation","requestId":"request-two","text":"Again","adapterId":"codex"}),
            Some(&f.project_id),
            None,
        )
        .error
        .unwrap();
    assert_eq!(busy.code, "BUSY", "{}", busy.message);
    let record = ok(f
        .host
        .command("chat.read", json!({}), Some(&f.project_id), None));
    assert_eq!(
        record["conversations"][0]["turns"]
            .as_array()
            .unwrap()
            .len(),
        1,
        "a refused send records nothing"
    );

    ok(f.host
        .command("terminal.stop", json!({}), Some(&f.project_id), None));
    assert!(f.events.wait_for("terminal-state", |state| {
        state["session"]["id"] == session["id"] && state["session"]["state"] == "exited"
    }));
    chat_send(&f, "conversation", "request-two", "Again");
    f.host.shutdown();
}

#[test]
#[cfg(unix)]
fn an_agent_terminals_ui_requests_still_move_the_workspace() {
    let f = fixture();
    let missing = uuid::Uuid::new_v4().to_string();
    let reply = agent_call(
        &f,
        "terminal-session",
        "ui.request_review",
        json!({ "proposalId": missing }),
    );
    assert_eq!(reply["ok"], true, "{reply}");
    assert!(f.events.wait_for("event", |event| {
        event["type"] == "ui.request_review" && event["data"]["proposalId"] == missing.as_str()
    }));
    let reply = agent_call(
        &f,
        "terminal-session",
        "chat.present",
        json!({"part": {"kind": "chart", "title": "Load", "xLabel": "Time", "xUnit": "s", "yLabel": "Load", "yUnit": "N", "source": "Estimate", "provenance": "illustrative", "points": [{"x": 0, "y": 1}, {"x": 1, "y": 2}]}}),
    );
    assert_eq!(reply["ok"], false, "{reply}");
}
