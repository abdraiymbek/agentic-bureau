//! The loopback server driven over real sockets on an ephemeral port.

mod common;

use bureau_agent_host::{Routing, RoutingLookup};
use bureau_headless::{Config, Server, Stopper};
use common::{Call, Response};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::thread::JoinHandle;

struct Running {
    port: u16,
    token: String,
    stopper: Stopper,
    serving: Option<JoinHandle<()>>,
    /// Declared last so the directory outlives the server using it.
    temp: tempfile::TempDir,
}

impl Running {
    /// A host that sees no model routing, whatever the developer's own variables and Claude
    /// settings say.
    fn start() -> Self {
        Self::start_routed(|_, _, _| Routing::default())
    }

    fn start_routed(routing: RoutingLookup) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let server = Server::bind(Config {
            app_data_dir: temp.path().join("app"),
            cli_path: PathBuf::from("/bin/echo"),
            port: 0,
            token: None,
        })
        .unwrap();
        server.set_routing(routing);
        let (port, token, stopper) = (server.port(), server.token().to_owned(), server.stopper());
        let serving = std::thread::spawn(move || server.serve().unwrap());
        Self {
            port,
            token,
            stopper,
            serving: Some(serving),
            temp,
        }
    }

    fn send(&self, call: Call<'_>) -> Response {
        call.token(&self.token).send(self.port)
    }

    /// Run a command and return its envelope.
    fn command(&self, op: &str, payload: Value, project_id: Option<&str>) -> Value {
        let response = self.send(Call::post(
            "/api/command",
            json!({ "op": op, "payload": payload, "projectId": project_id }),
        ));
        assert_eq!(response.status, 200, "{op}: {}", response.body);
        response.body
    }

    fn ok(&self, op: &str, payload: Value, project_id: Option<&str>) -> Value {
        let envelope = self.command(op, payload, project_id);
        assert_eq!(envelope["ok"], true, "{op}: {envelope}");
        envelope["result"].clone()
    }

    fn create_project(&self, name: &str) -> String {
        let created = self.ok(
            "project.create",
            json!({ "path": self.temp.path().join(name), "name": name, "intent": "test" }),
            None,
        );
        created["projectId"].as_str().unwrap().to_owned()
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.stopper.stop();
        if let Some(serving) = self.serving.take() {
            let _ = serving.join();
        }
    }
}

#[test]
fn commands_run_against_the_real_core_and_answer_with_the_desktop_envelope() {
    let host = Running::start();
    let health = host.send(Call::get("/api/health"));
    assert_eq!(health.status, 200);
    assert_eq!(health.body["service"], "bureau-host");
    assert_eq!(health.body["protocolVersion"], 1);
    assert!(health.body["socketPath"]
        .as_str()
        .unwrap()
        .ends_with("bridge.sock"));

    let project_id = host.create_project("Headless");
    let draft = host.command(
        "artifact.create_draft",
        json!({
            "type": "requirement", "title": "Payload capacity",
            "payload": {
                "statement": "Carry the sensor pack.",
                "acceptanceCriterion": "Climbs the ramp with the pack fitted.",
                "target": { "value": 0.3, "unit": "kg" }
            }
        }),
        Some(&project_id),
    );
    assert_eq!(draft["ok"], true, "{draft}");
    assert!(uuid_like(draft["requestId"].as_str().unwrap()));
    assert!(draft.get("error").is_none());
    assert_eq!(
        draft["result"]["revision"]["payload"]["target"],
        json!({ "value": 0.3, "unit": "kg" })
    );

    let listed = host.ok("artifact.list", json!({}), Some(&project_id));
    let artifacts = listed["artifacts"].as_array().unwrap();
    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0]["artifact"]["title"], "Payload capacity");
    assert_eq!(artifacts[0]["draftCount"], 1);

    let unknown = host.command("artifact.conjure", json!({}), Some(&project_id));
    assert_eq!(unknown["ok"], false);
    assert_eq!(unknown["error"]["code"], "VALIDATION");
    assert!(unknown.get("result").is_none());

    let invalid = host.command("artifact.read", json!({}), Some(&project_id));
    assert_eq!(
        invalid["error"]["details"]["issues"][0]["path"],
        "artifactId"
    );
    assert!(invalid["error"]["repair"].is_string());
}

#[test]
fn an_idempotency_key_replays_instead_of_repeating() {
    let host = Running::start();
    let project_id = host.create_project("Replay");
    let call = || {
        let response = host.send(Call::post(
            "/api/command",
            json!({
                "op": "artifact.create_draft",
                "payload": { "type": "note", "title": "Once", "payload": { "markdown": "One record." } },
                "projectId": project_id,
                "idempotencyKey": "same-key"
            }),
        ));
        response.body["result"]["artifact"]["id"].clone()
    };
    let first = call();
    assert!(first.is_string());
    assert_eq!(first, call());
    let listed = host.ok("artifact.list", json!({}), Some(&project_id));
    assert_eq!(listed["artifacts"].as_array().unwrap().len(), 1);
}

#[test]
fn project_events_arrive_as_server_sent_events_and_resume_after_a_reconnect() {
    let host = Running::start();
    let project_id = host.create_project("Events");
    let path = format!("/api/events?token={}", host.token);
    let mut events = Call::get(&path).stream(host.port).ok().unwrap();
    let draft = host.ok(
        "artifact.create_draft",
        json!({ "type": "note", "title": "First", "payload": { "markdown": "one" } }),
        Some(&project_id),
    );
    let committed = events
        .find(|event| event.name == "event" && event.data["type"] == "revision.committed")
        .expect("the draft's event is streamed");
    assert_eq!(committed.data["projectId"], project_id.as_str());
    assert_eq!(
        committed.data["data"]["revisionId"],
        draft["revision"]["id"]
    );
    assert_eq!(committed.data["origin"], "user");
    let last_seen = committed.id.expect("events carry an id");
    drop(events);

    host.ok(
        "artifact.create_draft",
        json!({ "type": "note", "title": "While away", "payload": { "markdown": "two" } }),
        Some(&project_id),
    );
    let mut resumed = Call::get("/api/events")
        .token(&host.token)
        .header("Last-Event-ID", &last_seen)
        .stream(host.port)
        .ok()
        .unwrap();
    let missed = resumed
        .find(|event| event.data["type"] == "revision.committed")
        .expect("the event recorded while disconnected is replayed");
    assert_ne!(missed.data["seq"], committed.data["seq"]);
    assert_eq!(missed.data["projectId"], project_id.as_str());

    let mut stale = Call::get("/api/events")
        .token(&host.token)
        .header("Last-Event-ID", "00000000-7")
        .stream(host.port)
        .ok()
        .unwrap();
    assert_eq!(stale.next().unwrap().name, "resync");
}

#[cfg(unix)]
#[test]
fn a_real_terminal_streams_data_and_state() {
    let host = Running::start();
    let project_id = host.create_project("Terminal");
    host.ok(
        "connection.configure",
        json!({ "adapterId": "custom", "executablePath": "/bin/cat" }),
        None,
    );
    let mut events = Call::get("/api/events")
        .token(&host.token)
        .stream(host.port)
        .ok()
        .unwrap();
    let session = host.ok(
        "terminal.start",
        json!({ "adapterId": "custom" }),
        Some(&project_id),
    );
    assert_eq!(session["state"], "running");
    let started = events
        .find(|event| event.name == "terminal-state")
        .expect("the session start is streamed");
    assert_eq!(started.data["projectId"], project_id.as_str());
    assert_eq!(started.data["session"]["id"], session["id"]);

    host.ok(
        "terminal.write",
        json!({ "data": "over the wire\n" }),
        Some(&project_id),
    );
    let output = events
        .find(|event| {
            event.name == "terminal-data"
                && event.data["chunk"]
                    .as_str()
                    .is_some_and(|chunk| chunk.contains("over the wire"))
        })
        .expect("terminal output is streamed");
    assert_eq!(output.data["sessionId"], session["id"]);
    assert!(output.data["seq"].as_u64().unwrap() >= 1);

    host.ok("terminal.stop", json!({}), Some(&project_id));
    let stopped = events
        .find(|event| event.name == "terminal-state" && event.data["session"]["state"] == "exited")
        .expect("the stop is streamed");
    assert_eq!(stopped.data["session"]["id"], session["id"]);
    let state = host.ok("terminal.state", json!({}), Some(&project_id));
    assert!(state["session"]["scrollback"]
        .as_str()
        .unwrap()
        .contains("over the wire"));
}

#[test]
fn requests_without_the_right_token_are_refused() {
    let host = Running::start();
    let command = || Call::post("/api/command", json!({ "op": "app.recent_projects" }));
    for response in [
        command().send(host.port),
        command().token("not-the-token-at-all").send(host.port),
        command()
            .header("Authorization", &format!("Basic {}", host.token))
            .send(host.port),
        Call::post(
            &format!("/api/command?token={}", host.token),
            json!({ "op": "app.recent_projects" }),
        )
        .send(host.port),
        Call::get("/api/health").send(host.port),
        Call::post("/api/shutdown", json!({})).send(host.port),
        Call::post("/api/agent/session", json!({ "projectId": "x" })).send(host.port),
        Call::get("/api/unknown").send(host.port),
    ] {
        assert_eq!(response.status, 401, "{}", response.head);
        assert_eq!(response.body["error"]["code"], "CONNECTION_DENIED");
        assert!(response.head.contains("WWW-Authenticate: Bearer"));
    }
    for path in ["/api/events", "/api/events?token=wrong-token-value"] {
        let refused = Call::get(path).stream(host.port).err().unwrap();
        assert_eq!(refused.status, 401, "{path}");
    }
    assert_eq!(command().token(&host.token).send(host.port).status, 200);
}

#[test]
fn a_web_page_cannot_drive_the_host_even_with_the_token() {
    let host = Running::start();
    let command =
        || Call::post("/api/command", json!({ "op": "app.recent_projects" })).token(&host.token);
    let own_origin = format!("http://127.0.0.1:{}", host.port);
    let refused = [
        command().header("Origin", "https://evil.example"),
        command().header("Origin", &own_origin),
        command().header("Origin", "null"),
        command().header("Sec-Fetch-Site", "cross-site"),
        command().header("Sec-Fetch-Site", "same-site"),
        command().header("Sec-Fetch-Site", "same-origin"),
        command().host("evil.example"),
        command().host(&format!("evil.example:{}", host.port)),
        command().host(&format!("127.0.0.1:{}", host.port.wrapping_add(1))),
        command().host("127.0.0.1"),
        command().host(&format!("127.0.0.1.evil.example:{}", host.port)),
    ];
    for call in refused {
        let response = call.send(host.port);
        assert_eq!(response.status, 403, "{}", response.head);
        assert_eq!(response.body["error"]["code"], "CONNECTION_DENIED");
    }
    let preflight = Call {
        method: "OPTIONS",
        ..Call::get("/api/command")
    }
    .header("Origin", "https://evil.example")
    .header("Access-Control-Request-Method", "POST")
    .send(host.port);
    assert_eq!(preflight.status, 403);
    let stream = Call::get(&format!("/api/events?token={}", host.token))
        .header("Origin", "https://evil.example")
        .stream(host.port)
        .err()
        .unwrap();
    assert_eq!(stream.status, 403);

    for accepted in [
        command().host(&format!("localhost:{}", host.port)),
        command().header("Sec-Fetch-Site", "none"),
    ] {
        let response = accepted.send(host.port);
        assert_eq!(response.status, 200, "{}", response.head);
        assert!(
            !response
                .head
                .to_ascii_lowercase()
                .contains("access-control"),
            "no response grants cross-origin access"
        );
    }
}

#[test]
fn malformed_and_oversized_requests_are_refused_with_a_reason() {
    let host = Running::start();
    let raw = |body: &str, content_type: &str| {
        Call {
            body: Some(body.to_owned()),
            ..Call::post("/api/command", json!({}))
        }
        .header("Content-Type", content_type)
        .token(&host.token)
        .send(host.port)
    };
    let not_json = raw("{op:", "application/json");
    assert_eq!(not_json.status, 400);
    assert_eq!(not_json.body["error"]["code"], "VALIDATION");
    assert_eq!(raw("[]", "application/json").status, 400);
    assert_eq!(raw("{}", "application/json").status, 400, "op is required");
    assert_eq!(
        raw(
            r#"{"op":"app.recent_projects","projectId":7}"#,
            "application/json"
        )
        .status,
        400
    );
    assert_eq!(
        raw(r#"{"op":"app.recent_projects"}"#, "text/plain").status,
        415
    );
    assert_eq!(
        raw(
            r#"{"op":"app.recent_projects"}"#,
            "application/json; charset=utf-8"
        )
        .status,
        200
    );

    let too_large = Call {
        body: None,
        ..Call::post("/api/command", json!({}))
    }
    .header("Content-Length", "16777217")
    .token(&host.token)
    .send(host.port);
    assert_eq!(too_large.status, 413);
    assert_eq!(
        too_large.body["error"]["message"],
        "Request body is too large"
    );

    assert_eq!(host.send(Call::get("/api/nowhere")).status, 404);
    assert_eq!(host.send(Call::get("/api/command")).status, 405);
    assert_eq!(host.send(Call::post("/api/health", json!({}))).status, 405);
}

#[test]
fn research_answers_with_a_typed_unavailable_error() {
    let host = Running::start();
    let project_id = host.create_project("Research");
    for (op, payload) in [
        (
            "research.read_page",
            json!({ "url": "https://example.com/" }),
        ),
        ("research.search", json!({ "query": "M3 screw" })),
        ("browser.read", json!({})),
        ("browser.screenshot", json!({})),
    ] {
        let envelope = host.command(op, payload, Some(&project_id));
        assert_eq!(envelope["ok"], false, "{op}");
        let error = &envelope["error"];
        assert_eq!(error["code"], "TOOL_MISSING", "{op}");
        assert_eq!(
            error["message"],
            "Research browsing is unavailable in the headless host"
        );
        assert_eq!(error["details"]["host"], "headless");
        assert!(error["repair"].as_str().unwrap().contains("desktop app"));
    }
    let reveal = host.command(
        "artifact.reveal",
        json!({ "artifactId": "00000000-0000-4000-8000-000000000001" }),
        Some(&project_id),
    );
    assert_eq!(reveal["error"]["code"], "NOT_FOUND");
}

#[cfg(unix)]
#[test]
fn an_issued_agent_session_reaches_the_core_through_the_bridge() {
    use bureau_contracts::{read_frame, write_frame};
    use std::os::unix::net::UnixStream;

    let host = Running::start();
    let project_id = host.create_project("Agent");
    let issued = host.send(Call::post(
        "/api/agent/session",
        json!({ "projectId": project_id }),
    ));
    assert_eq!(issued.body["ok"], true, "{}", issued.body);
    let session = &issued.body["result"];
    let session_id = session["sessionId"].as_str().unwrap();
    assert_eq!(session["env"]["BUREAU_SESSION_ID"], session_id);
    assert_eq!(session["env"]["BUREAU_PROJECT_ID"], project_id.as_str());
    assert_eq!(session["env"]["BUREAU_BRIDGE_TOKEN"], session["token"]);
    assert_eq!(session["env"]["BUREAU_BRIDGE_SOCK"], session["socketPath"]);

    let mut bridge = UnixStream::connect(session["socketPath"].as_str().unwrap()).unwrap();
    write_frame(
        &mut bridge,
        &json!({ "type": "hello", "protocolVersion": 1, "mode": "call", "token": session["token"] }),
    )
    .unwrap();
    let welcome = read_frame(&mut bridge).unwrap().unwrap();
    assert_eq!(welcome["type"], "welcome");
    assert_eq!(welcome["sessionId"], session_id);
    let mut call = |op: &str, payload: Value| {
        write_frame(
            &mut bridge,
            &json!({ "requestId": op, "op": op, "payload": payload }),
        )
        .unwrap();
        read_frame(&mut bridge).unwrap().unwrap()
    };

    let drafted = call(
        "artifact.create_draft",
        json!({ "type": "note", "title": "Agent note", "payload": { "markdown": "drafted by the agent" } }),
    );
    assert_eq!(drafted["ok"], true, "{drafted}");
    assert_eq!(drafted["result"]["revision"]["origin"], "agent");
    assert_eq!(
        call("proposal.approve", json!({}))["error"]["code"],
        "CAPABILITY_DENIED"
    );
    assert_eq!(
        call(
            "research.read_page",
            json!({ "url": "https://example.com/" })
        )["error"]["code"],
        "TOOL_MISSING"
    );

    let seen_by_user = host.ok("artifact.list", json!({}), Some(&project_id));
    assert_eq!(
        seen_by_user["artifacts"][0]["artifact"]["title"],
        "Agent note"
    );

    let revoked = host.send(Call::post(
        "/api/agent/revoke",
        json!({ "sessionId": session_id }),
    ));
    assert_eq!(revoked.body["ok"], true);
    assert_eq!(
        call("project.summary", json!({}))["error"]["code"],
        "CONNECTION_DENIED"
    );

    let unknown_project = host.send(Call::post(
        "/api/agent/session",
        json!({ "projectId": "00000000-0000-4000-8000-000000000099" }),
    ));
    assert_eq!(unknown_project.body["ok"], false);
    assert_eq!(unknown_project.body["error"]["code"], "NOT_FOUND");
    let bad_session = host.send(Call::post(
        "/api/agent/session",
        json!({ "projectId": project_id, "sessionId": "not-a-uuid" }),
    ));
    assert_eq!(bad_session.status, 400);
}

#[cfg(unix)]
#[test]
fn the_shutdown_route_ends_streams_and_terminates_agent_processes() {
    let mut host = Running::start();
    let project_id = host.create_project("Shutdown");
    host.ok(
        "connection.configure",
        json!({ "adapterId": "custom", "executablePath": "/bin/sh" }),
        None,
    );
    let marker = host.temp.path().join("child-survived");
    let mut events = Call::get("/api/events")
        .token(&host.token)
        .stream(host.port)
        .ok()
        .unwrap();
    host.ok(
        "terminal.start",
        json!({
            "adapterId": "custom",
            "args": ["-c", "(sleep 2; touch \"$MARKER\") & echo READY; wait"],
            "env": { "MARKER": marker }
        }),
        Some(&project_id),
    );
    events
        .find(|event| {
            event.name == "terminal-data"
                && event.data["chunk"]
                    .as_str()
                    .is_some_and(|chunk| chunk.contains("READY"))
        })
        .expect("the agent process started its child");

    let stopped = host.send(Call::post("/api/shutdown", json!({})));
    assert_eq!(stopped.status, 200);
    host.serving.take().unwrap().join().unwrap();
    while events.next().is_some() {}
    assert!(
        std::net::TcpStream::connect(("127.0.0.1", host.port)).is_err(),
        "the port is released"
    );
    std::thread::sleep(std::time::Duration::from_millis(2500));
    assert!(!marker.exists(), "the agent's child outlived the host");
}

/// An evaluation harness asks for a headless run and spawns the CLI itself.
/// A stand-in CLI records what it was given; the credentials it received
/// then reach the core through the bridge with the session's profile.
#[cfg(unix)]
#[test]
fn a_headless_agent_run_is_prepared_with_the_desktop_wiring() {
    use bureau_contracts::{read_frame, write_frame};
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixStream;
    use std::process::{Command, Stdio};

    let host = Running::start();
    let project_id = host.create_project("Evaluation");
    let record = host.temp.path().join("stand-in-run.txt");
    let stand_in = host.temp.path().join("claude");
    std::fs::write(
        &stand_in,
        format!(
            "#!/bin/sh\nfor arg in \"$@\"; do echo \"arg $arg\"; done > '{r}'\necho \"token $BUREAU_BRIDGE_TOKEN\" >> '{r}'\necho \"session $BUREAU_SESSION_ID\" >> '{r}'\necho \"other ${{BUREAU_OTHER:-unset}}\" >> '{r}'\nsed 's/^/stdin /' >> '{r}'\n",
            r = record.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&stand_in, std::fs::Permissions::from_mode(0o755)).unwrap();

    let prepared = host.send(Call::post(
        "/api/agent/launch",
        json!({ "projectId": project_id, "adapterId": "claude-code", "model": "haiku",
                "executablePath": stand_in }),
    ));
    assert_eq!(prepared.body["ok"], true, "{}", prepared.body);
    let plan = &prepared.body["result"];
    let session_id = plan["sessionId"].as_str().unwrap().to_owned();
    assert_eq!(plan["executable"], json!(stand_in));
    assert_eq!(plan["adapterId"], "claude-code");
    // The alias is launched as its full id, which the CLI would otherwise resolve to an older
    // model.
    let launched = "claude-haiku-5-5";
    assert_eq!(plan["model"], launched);
    assert_eq!(
        (&plan["conversationId"], &plan["resumed"]),
        (&json!(session_id), &json!(false))
    );
    assert_eq!(
        plan["profile"], "compact",
        "a small model gets the compact surface"
    );
    assert_eq!(plan["profileSource"], "model");
    assert_eq!(plan["stdin"], "prompt");
    let args = plan["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|arg| arg.as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(args[0], "-p", "{args:?}");
    let after = |flag: &str| {
        args.iter()
            .position(|arg| arg == flag)
            .map(|index| args[index + 1].clone())
            .unwrap_or_else(|| panic!("{flag} missing from {args:?}"))
    };
    assert_eq!(after("--model"), launched);
    assert_eq!(after("--session-id"), session_id);
    assert_eq!(after("--output-format"), "stream-json");
    let files = plan["files"].as_array().unwrap();
    let file = |path: &str| {
        files
            .iter()
            .find(|file| file["path"] == path)
            .unwrap_or_else(|| panic!("{path} is not among the files to write"))["contents"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let mcp: Value = serde_json::from_str(&file(&after("--mcp-config"))).unwrap();
    let server = &mcp["mcpServers"]["bureau"];
    assert_eq!(
        server["command"], "/bin/echo",
        "the helper this host was given"
    );
    assert_eq!(server["args"], json!(["mcp"]));
    assert_eq!(server["env"]["BUREAU_SESSION_ID"], session_id.as_str());
    let guidance = file(&after("--append-system-prompt-file"));
    assert!(guidance.contains("work_status"), "{guidance}");
    assert_eq!(plan["env"]["BUREAU_SESSION_ID"], session_id.as_str());
    assert_eq!(
        plan["env"]["BUREAU_BRIDGE_TOKEN"],
        server["env"]["BUREAU_BRIDGE_TOKEN"]
    );
    assert_eq!(plan["scrubbedPrefix"], "BUREAU_");

    // Run the plan the way it says: files first, the environment applied
    // over an inherited one, the prompt on standard input.
    for file in files {
        std::fs::write(
            file["path"].as_str().unwrap(),
            file["contents"].as_str().unwrap(),
        )
        .unwrap();
    }
    let mut command = Command::new(plan["executable"].as_str().unwrap());
    command
        .args(&args)
        .current_dir(plan["cwd"].as_str().unwrap())
        .env_clear()
        .stdin(Stdio::piped());
    let inherited = [
        ("PATH", "/usr/bin:/bin"),
        ("BUREAU_OTHER", "from another session"),
    ];
    let scrubbed = plan["scrubbedPrefix"].as_str().unwrap();
    for (key, value) in inherited {
        if !key.starts_with(scrubbed) {
            command.env(key, value);
        }
    }
    for (key, value) in plan["envDefaults"].as_object().unwrap() {
        if !inherited.iter().any(|(inherited, _)| inherited == key) {
            command.env(key, value.as_str().unwrap());
        }
    }
    for (key, value) in plan["env"].as_object().unwrap() {
        command.env(key, value.as_str().unwrap());
    }
    let mut child = command.spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"Check the tray\n")
        .unwrap();
    assert!(child.wait().unwrap().success());
    let ran = std::fs::read_to_string(&record).unwrap();
    let recorded_args = ran
        .lines()
        .filter_map(|line| line.strip_prefix("arg "))
        .collect::<Vec<_>>();
    assert_eq!(recorded_args, args);
    assert!(ran.contains(&format!("session {session_id}")));
    assert!(ran.contains("other unset"));
    assert!(ran.contains("stdin Check the tray"));
    let token = ran
        .lines()
        .find_map(|line| line.strip_prefix("token "))
        .unwrap()
        .to_owned();

    // The credentials the CLI received are a live grant with the planned profile.
    let mut bridge = UnixStream::connect(
        host.send(Call::get("/api/health")).body["socketPath"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    write_frame(
        &mut bridge,
        &json!({ "type": "hello", "protocolVersion": 1, "mode": "call", "token": token }),
    )
    .unwrap();
    let welcome = read_frame(&mut bridge).unwrap().unwrap();
    assert_eq!(welcome["type"], "welcome");
    assert_eq!(welcome["sessionId"], session_id.as_str());
    assert_eq!(welcome["profile"], "compact");
    write_frame(
        &mut bridge,
        &json!({ "requestId": "1", "op": "work_status", "payload": {} }),
    )
    .unwrap();
    let status = read_frame(&mut bridge).unwrap().unwrap();
    assert_eq!(status["ok"], true, "{status}");
    assert_eq!(status["result"]["scope"], "session");
    let activity = host.ok(
        "agent.activity",
        json!({ "sessionId": session_id }),
        Some(&project_id),
    );
    assert_eq!(activity["calls"][0]["tool"], "work_status");
    let session = &activity["sessions"][0];
    assert_eq!(session["adapterId"], "claude-code");
    assert_eq!(session["model"], launched);
    assert_eq!(session["profile"], "compact");

    let revoked = host.send(Call::post(
        "/api/agent/revoke",
        json!({ "sessionId": session_id }),
    ));
    assert_eq!(revoked.body["ok"], true);
    write_frame(
        &mut bridge,
        &json!({ "requestId": "2", "op": "work_status", "payload": {} }),
    )
    .unwrap();
    assert_eq!(
        read_frame(&mut bridge).unwrap().unwrap()["error"]["code"],
        "CONNECTION_DENIED"
    );

    // Only CLIs with a headless mode can be prepared, and a refusal leaves no session behind.
    let custom = host.send(Call::post(
        "/api/agent/launch",
        json!({ "projectId": project_id, "adapterId": "custom", "executablePath": stand_in }),
    ));
    assert_eq!(
        custom.body["error"]["code"], "VALIDATION",
        "{}",
        custom.body
    );
    assert_eq!(
        custom.body["error"]["message"],
        "Custom CLI has no headless mode in this build"
    );
    let sessions = host.ok("agent.activity", json!({}), Some(&project_id))["sessions"].clone();
    assert_eq!(sessions.as_array().unwrap().len(), 1);
    let closed = host.send(Call::post(
        "/api/agent/launch",
        json!({ "projectId": "00000000-0000-4000-8000-000000000099", "adapterId": "codex" }),
    ));
    assert_eq!(closed.body["error"]["code"], "NOT_FOUND");
    let missing = host.send(Call::post(
        "/api/agent/launch",
        json!({ "adapterId": "codex" }),
    ));
    assert_eq!(missing.status, 400);
}

/// A person who routes Claude models themselves keeps the alias: here the project's own Claude
/// settings switch to another provider, so `haiku` is passed as written.
#[cfg(unix)]
#[test]
fn a_headless_run_passes_a_routed_alias_as_written() {
    let host = Running::start_routed(|spec, _, root| {
        if root.is_some_and(|root| root.ends_with("Routed")) {
            Routing::read(
                spec,
                vec![("CLAUDE_CODE_USE_BEDROCK".to_owned(), "1".to_owned())],
                &[],
            )
        } else {
            Routing::default()
        }
    });
    let launch = |project_id: &str| {
        let prepared = host.send(Call::post(
            "/api/agent/launch",
            json!({ "projectId": project_id, "adapterId": "claude-code", "model": "haiku",
                    "executablePath": "/bin/sh" }),
        ));
        assert_eq!(prepared.body["ok"], true, "{}", prepared.body);
        let plan = prepared.body["result"].clone();
        let args = plan["args"].as_array().unwrap().clone();
        let at = args.iter().position(|arg| arg == "--model").unwrap();
        assert_eq!(args[at + 1], plan["model"]);
        host.send(Call::post(
            "/api/agent/revoke",
            json!({ "sessionId": plan["sessionId"] }),
        ));
        plan["model"].as_str().unwrap().to_owned()
    };
    assert_eq!(launch(&host.create_project("Routed")), "haiku");
    assert_eq!(launch(&host.create_project("Direct")), "claude-haiku-5-5");
}

fn uuid_like(text: &str) -> bool {
    text.len() == 36 && text.bytes().filter(|byte| *byte == b'-').count() == 4
}
