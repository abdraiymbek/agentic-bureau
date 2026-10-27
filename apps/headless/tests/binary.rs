//! The built `bureau-host` executable: its announcement, its exit paths,
//! and that agent processes never outlive it.
#![cfg(unix)]

mod common;

use common::Call;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

struct Spawned {
    child: Child,
    stdin: Option<ChildStdin>,
    port: u16,
    token: String,
    socket_path: String,
}

fn spawn(app_data: &Path, extra: &[&str]) -> Spawned {
    let mut child = Command::new(env!("CARGO_BIN_EXE_bureau-host"))
        .arg("--app-data")
        .arg(app_data)
        .args(["--cli", "/bin/echo"])
        .args(extra)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let announced: Value = serde_json::from_str(&line).expect("one JSON line on stdout");
    assert_eq!(
        announced.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["port", "token", "socketPath"]
    );
    Spawned {
        stdin: child.stdin.take(),
        child,
        port: announced["port"].as_u64().unwrap() as u16,
        token: announced["token"].as_str().unwrap().to_owned(),
        socket_path: announced["socketPath"].as_str().unwrap().to_owned(),
    }
}

impl Spawned {
    fn ok(&self, op: &str, payload: Value, project_id: Option<&str>) -> Value {
        let response = Call::post(
            "/api/command",
            json!({ "op": op, "payload": payload, "projectId": project_id }),
        )
        .token(&self.token)
        .send(self.port);
        assert_eq!(response.body["ok"], true, "{op}: {}", response.body);
        response.body["result"].clone()
    }

    /// Start a shell whose background child would create `marker` two
    /// seconds from now, and wait until that child exists.
    fn start_agent_with_child(&self, project_dir: &Path, marker: &Path) {
        let created = self.ok(
            "project.create",
            json!({ "path": project_dir, "name": "Lifetime", "intent": "test" }),
            None,
        );
        let project_id = created["projectId"].as_str().unwrap();
        self.ok(
            "connection.configure",
            json!({ "adapterId": "custom", "executablePath": "/bin/sh" }),
            None,
        );
        let mut events = Call::get("/api/events")
            .token(&self.token)
            .stream(self.port)
            .ok()
            .unwrap();
        self.ok(
            "terminal.start",
            json!({
                "adapterId": "custom",
                "args": ["-c", "(sleep 2; touch \"$MARKER\") & echo READY; wait"],
                "env": { "MARKER": marker }
            }),
            Some(project_id),
        );
        events
            .find(|event| {
                event.name == "terminal-data"
                    && event.data["chunk"]
                        .as_str()
                        .is_some_and(|chunk| chunk.contains("READY"))
            })
            .expect("the agent process started its child");
    }

    fn exit_code_within(&mut self, limit: Duration) -> Option<i32> {
        let deadline = Instant::now() + limit;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status.code();
            }
            if Instant::now() >= deadline {
                let _ = self.child.kill();
                panic!("bureau-host was still running after {limit:?}");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

fn assert_child_never_ran(marker: &Path) {
    std::thread::sleep(Duration::from_millis(2500));
    assert!(!marker.exists(), "the agent's child outlived the host");
}

#[test]
fn it_announces_itself_and_stops_cleanly_on_sigterm() {
    let temp = tempfile::tempdir().unwrap();
    let mut host = spawn(&temp.path().join("app"), &["--port", "0"]);
    assert!(host.port > 0);
    assert_eq!(host.token.len(), 64, "a generated token is 256 bits of hex");
    assert!(Path::new(&host.socket_path).exists());
    let health = Call::get("/api/health").token(&host.token).send(host.port);
    assert_eq!(health.body["socketPath"], host.socket_path.as_str());

    let marker = temp.path().join("child-survived");
    host.start_agent_with_child(&temp.path().join("project"), &marker);
    unsafe { libc::kill(host.child.id() as i32, libc::SIGTERM) };
    assert_eq!(host.exit_code_within(Duration::from_secs(10)), Some(0));
    assert_child_never_ran(&marker);
}

#[test]
fn it_stops_when_its_parent_closes_stdin_if_asked_to() {
    let temp = tempfile::tempdir().unwrap();
    let mut host = spawn(
        &temp.path().join("app"),
        &[
            "--exit-on-stdin-close",
            "--token",
            "chosen-token-0123456789",
        ],
    );
    assert_eq!(host.token, "chosen-token-0123456789");
    let marker = temp.path().join("child-survived");
    host.start_agent_with_child(&temp.path().join("project"), &marker);
    drop(host.stdin.take());
    assert_eq!(host.exit_code_within(Duration::from_secs(10)), Some(0));
    assert_child_never_ran(&marker);
}

#[test]
fn a_closed_stdin_is_ignored_unless_asked() {
    let temp = tempfile::tempdir().unwrap();
    let mut host = spawn(&temp.path().join("app"), &[]);
    drop(host.stdin.take());
    std::thread::sleep(Duration::from_millis(300));
    let health = Call::get("/api/health").token(&host.token).send(host.port);
    assert_eq!(health.status, 200);
    let stopped = Call::post("/api/shutdown", json!({}))
        .token(&host.token)
        .send(host.port);
    assert_eq!(stopped.status, 200);
    assert_eq!(host.exit_code_within(Duration::from_secs(10)), Some(0));
}

#[test]
fn it_restarts_on_the_same_application_state() {
    let temp = tempfile::tempdir().unwrap();
    let project_dir = temp.path().join("project");
    let mut first = spawn(&temp.path().join("app"), &[]);
    let created = first.ok(
        "project.create",
        json!({ "path": project_dir, "name": "Persisted", "intent": "survives a restart" }),
        None,
    );
    let project_id = created["projectId"].as_str().unwrap().to_owned();
    first.ok(
        "artifact.create_draft",
        json!({ "type": "note", "title": "Kept", "payload": { "markdown": "still here" } }),
        Some(&project_id),
    );
    unsafe { libc::kill(first.child.id() as i32, libc::SIGINT) };
    assert_eq!(first.exit_code_within(Duration::from_secs(10)), Some(0));

    let mut second = spawn(&temp.path().join("app"), &[]);
    assert_eq!(second.socket_path, first.socket_path);
    let recent = second.ok("app.recent_projects", json!({}), None);
    assert_eq!(recent["projects"].as_array().unwrap().len(), 1);
    let reopened = second.ok("project.open", json!({ "path": project_dir }), None);
    assert_eq!(reopened["projectId"], project_id.as_str());
    let listed = second.ok("artifact.list", json!({}), Some(&project_id));
    assert_eq!(listed["artifacts"][0]["artifact"]["title"], "Kept");
    unsafe { libc::kill(second.child.id() as i32, libc::SIGTERM) };
    assert_eq!(second.exit_code_within(Duration::from_secs(10)), Some(0));
}

#[test]
fn bad_invocations_exit_with_usage() {
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_bureau-host"))
            .args(args)
            .output()
            .unwrap()
    };
    let missing = run(&[]);
    assert_eq!(missing.status.code(), Some(2));
    let stderr = String::from_utf8(missing.stderr).unwrap();
    assert!(stderr.starts_with("bureau-host: --app-data <dir> is required"));
    assert!(stderr.contains("usage: bureau-host --app-data <dir>"));
    assert!(missing.stdout.is_empty());

    let temp = tempfile::tempdir().unwrap();
    let app_data = temp.path().join("app");
    let weak_token = run(&["--app-data", app_data.to_str().unwrap(), "--token", "short"]);
    assert_eq!(weak_token.status.code(), Some(1));
    assert!(String::from_utf8(weak_token.stderr)
        .unwrap()
        .contains("at least 16 characters"));

    let help = run(&["--help"]);
    assert_eq!(help.status.code(), Some(0));
    assert!(String::from_utf8(help.stdout)
        .unwrap()
        .contains("--exit-on-stdin-close"));
}
