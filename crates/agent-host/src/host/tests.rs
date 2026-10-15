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
        "omenflow://x",
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
    assert_eq!(event.channel(), "omenflow:agent:call");
    assert_eq!(
        [
            HostEvent::Project(json!({})).channel(),
            HostEvent::TerminalData(json!({})).channel(),
            HostEvent::TerminalState(json!({})).channel(),
        ],
        [
            "omenflow:event",
            "omenflow:terminal:data",
            "omenflow:terminal:state"
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
