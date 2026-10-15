#![cfg(unix)]

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

fn write_frame(socket: &mut UnixStream, value: Value) {
    let bytes = serde_json::to_vec(&value).unwrap();
    socket
        .write_all(&(bytes.len() as u32).to_le_bytes())
        .unwrap();
    socket.write_all(&bytes).unwrap();
}

fn read_frame(socket: &mut UnixStream) -> Value {
    let mut header = [0; 4];
    socket.read_exact(&mut header).unwrap();
    let mut body = vec![0; u32::from_le_bytes(header) as usize];
    socket.read_exact(&mut body).unwrap();
    serde_json::from_slice(&body).unwrap()
}

fn connect(mode: &str) -> (Child, UnixStream, std::path::PathBuf) {
    let args: &[&str] = if mode == "call" {
        &["call", "artifact.list", "--input", "-"]
    } else {
        &[mode]
    };
    connect_args(mode, args)
}

fn connect_args(mode: &str, args: &[&str]) -> (Child, UnixStream, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "omen-rust-{}-{:?}",
        std::process::id(),
        std::thread::current().id(),
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let socket_path = dir.join("bridge.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_omenflow"));
    command.args(args);
    let child = command
        .env("OMENFLOW_BRIDGE_SOCK", &socket_path)
        .env("OMENFLOW_BRIDGE_TOKEN", "test-token")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let (mut socket, _) = listener.accept().unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let hello = read_frame(&mut socket);
    assert_eq!(hello["mode"], mode);
    assert_eq!(hello["token"], "test-token");
    write_frame(
        &mut socket,
        json!({ "type": "welcome", "protocolVersion": 1 }),
    );
    (child, socket, dir)
}

fn wait_exit(child: &mut Child) -> ExitStatus {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("bridge helper did not exit after EOF");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn assert_exit(child: &mut Child) {
    assert!(wait_exit(child).success());
}

fn stdout(child: &mut Child) -> String {
    let mut output = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut output)
        .unwrap();
    output
}

fn stderr(child: &mut Child) -> String {
    let mut output = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut output)
        .unwrap();
    output
}

/// Run one call: accept the request, answer it with `response`, and return
/// the request, the exit status and what the helper printed.
fn exchange(args: &[&str], response: Value) -> (Value, ExitStatus, String, String) {
    let (mut child, mut socket, dir) = connect_args("call", args);
    let request = read_frame(&mut socket);
    let mut reply = response;
    reply["requestId"] = request["requestId"].clone();
    write_frame(&mut socket, reply);
    let status = wait_exit(&mut child);
    let printed = (stdout(&mut child), stderr(&mut child));
    std::fs::remove_dir_all(dir).unwrap();
    (request, status, printed.0, printed.1)
}

/// Run the helper with no bridge at all.
fn run_alone(args: &[&str]) -> (ExitStatus, String, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_omenflow"))
        .args(args)
        .env_remove("OMENFLOW_BRIDGE_SOCK")
        .env_remove("OMENFLOW_BRIDGE_TOKEN")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    (
        output.status,
        String::from_utf8(output.stdout).unwrap(),
        String::from_utf8(output.stderr).unwrap(),
    )
}

#[test]
fn mcp_exits_when_bridge_closes_with_stdin_still_open() {
    let (mut child, socket, dir) = connect("mcp");
    drop(socket);
    assert_exit(&mut child);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn mcp_exits_when_stdin_closes_with_bridge_still_open() {
    let (mut child, _socket, dir) = connect("mcp");
    drop(child.stdin.take());
    assert_exit(&mut child);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn mcp_pumps_messages_both_ways_and_survives_a_bad_line() {
    let (mut child, mut socket, dir) = connect("mcp");
    let mut input = child.stdin.take().unwrap();
    input
        .write_all(b"not json\n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n")
        .unwrap();
    assert_eq!(
        read_frame(&mut socket),
        json!({"jsonrpc": "2.0", "id": 1, "method": "ping"})
    );
    write_frame(
        &mut socket,
        json!({"jsonrpc": "2.0", "id": 1, "result": {}}),
    );
    // A notification from the app is forwarded as it is.
    write_frame(
        &mut socket,
        json!({"jsonrpc": "2.0", "method": "notifications/progress", "params": {"progress": 1}}),
    );
    drop(socket);
    assert_exit(&mut child);
    drop(input);
    assert_eq!(
        stdout(&mut child),
        "{\"id\":1,\"jsonrpc\":\"2.0\",\"result\":{}}\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{\"progress\":1}}\n"
    );
    assert!(stderr(&mut child).contains("Bad JSON-RPC line: not json"));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn call_help_maps_to_tool_describe() {
    let (request, status, output, _) = exchange(
        &["call", "cad.check", "--help"],
        json!({"ok": true, "result": {"op": "cad.check", "inputSchema": {}}}),
    );
    // --help sends a tool.describe request and never reads the stdin payload.
    assert_eq!(request["op"], "tool.describe");
    assert_eq!(request["payload"], json!({"op": "cad.check"}));
    assert!(status.success());
    assert_eq!(
        serde_json::from_str::<Value>(&output).unwrap(),
        json!({"op": "cad.check", "inputSchema": {}})
    );
}

#[test]
fn call_round_trip_returns_the_result() {
    let (mut child, mut socket, dir) = connect("call");
    child.stdin.take().unwrap().write_all(b"{}").unwrap();
    let request = read_frame(&mut socket);
    assert_eq!(request["op"], "artifact.list");
    assert_eq!(request["payload"], json!({}));
    write_frame(
        &mut socket,
        json!({"requestId": request["requestId"], "ok": true, "result": {"artifacts": []}}),
    );
    assert_exit(&mut child);
    assert_eq!(stdout(&mut child), "{\"artifacts\":[]}\n");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn call_takes_a_tool_name_and_needs_no_input_for_a_tool_without_arguments() {
    // The name goes to the app as typed; the app resolves either form.
    let (request, status, output, _) = exchange(
        &["call", "project_summary"],
        json!({"ok": true, "result": {"project": {"name": "Rover"}}}),
    );
    assert_eq!(request["op"], "project_summary");
    assert_eq!(request["payload"], json!({}));
    assert!(request.get("idempotencyKey").is_none());
    assert!(status.success());
    assert_eq!(output, "{\"project\":{\"name\":\"Rover\"}}\n");
}

#[test]
fn call_accepts_inline_json_an_idempotency_key_and_pretty_output() {
    let (request, status, output, _) = exchange(
        &[
            "call",
            "artifact_read",
            "--input",
            "{\"artifactId\": \"a1\"}",
            "--idempotency-key",
            "k-1",
            "--pretty",
        ],
        json!({"ok": true, "result": {"view": {"artifact": {"id": "a1"}}}}),
    );
    assert_eq!(request["op"], "artifact_read");
    assert_eq!(request["payload"], json!({"artifactId": "a1"}));
    assert_eq!(request["idempotencyKey"], "k-1");
    assert!(status.success());
    assert!(output.contains("\n  \"view\": {"), "{output}");
}

#[test]
fn call_reads_input_from_a_file() {
    let file = std::env::temp_dir().join(format!("omen-input-{}.json", std::process::id()));
    std::fs::write(&file, "{\"type\": \"note\"}").unwrap();
    let (request, status, _, _) = exchange(
        &["call", "artifact.list", "--input", file.to_str().unwrap()],
        json!({"ok": true, "result": {"artifacts": []}}),
    );
    std::fs::remove_file(&file).unwrap();
    assert_eq!(request["payload"], json!({"type": "note"}));
    assert!(status.success());
}

#[test]
fn a_failed_call_prints_the_whole_error_with_its_repair_and_exits_2() {
    let error = json!({
        "code": "VALIDATION",
        "message": "Invalid input: artifactId: required, expected string (uuid)",
        "repair": "Add each missing required field. Then call artifact_read again. details.example is a minimal valid input.",
        "details": {
            "tool": "artifact_read",
            "issues": [{"path": "artifactId", "kind": "required", "message": "required, expected string (uuid)"}],
            "example": {"artifactId": "00000000-0000-4000-8000-000000000001"}
        }
    });
    let (_, status, output, errors) = exchange(
        &["call", "artifact_read"],
        json!({"ok": false, "error": error}),
    );
    assert_eq!(status.code(), Some(2));
    assert_eq!(output, "");
    assert_eq!(errors.lines().count(), 1, "one line a model can parse");
    assert_eq!(
        serde_json::from_str::<Value>(&errors).unwrap(),
        json!({"ok": false, "error": error})
    );
}

#[test]
fn guide_prints_the_playbook_and_its_topics() {
    let playbook = json!({
        "topic": "cad", "title": "Model a part in OpenSCAD",
        "text": "# Model a part in OpenSCAD\n\n1. Write the source.\n2. Verify it, then call work_status.",
        "topics": [
            {"id": "start", "title": "Start a session", "when": "First, in every session."},
            {"id": "cad", "title": "Model a part in OpenSCAD", "when": "Before changing a part."}
        ]
    });
    let (request, status, output, _) =
        exchange(&["guide", "cad"], json!({"ok": true, "result": playbook}));
    assert_eq!(request["op"], "guide.read");
    assert_eq!(request["payload"], json!({"topic": "cad"}));
    assert!(status.success());
    assert_eq!(
        output,
        "# Model a part in OpenSCAD\n\n1. Write the source.\n2. Verify it, then call work_status.\n\nTopics (omenflow guide <topic>):\n  start — First, in every session.\n  cad — Before changing a part.\n"
    );

    let (request, _, _, _) = exchange(&["guide"], json!({"ok": true, "result": {"text": "x"}}));
    assert_eq!(
        request["payload"],
        json!({}),
        "no topic asks for the start guide"
    );
}

#[test]
fn status_asks_the_completion_gate() {
    let gate = json!({"ready": false, "scope": "session", "summary": "1 part is not verified.", "outstanding": [], "waitingOnHuman": []});
    let (request, status, output, _) = exchange(&["status"], json!({"ok": true, "result": gate}));
    assert_eq!(request["op"], "work.status");
    assert_eq!(request["payload"], json!({}));
    assert!(status.success());
    assert_eq!(serde_json::from_str::<Value>(&output).unwrap(), gate);
    assert_eq!(output.lines().count(), 1);

    let (request, _, _, _) = exchange(
        &["status", "--scope", "project"],
        json!({"ok": true, "result": gate}),
    );
    assert_eq!(request["payload"], json!({"scope": "project"}));
}

#[test]
fn help_needs_no_session_and_usage_errors_exit_3() {
    for flag in ["help", "--help", "-h"] {
        let (status, output, errors) = run_alone(&[flag]);
        assert!(status.success(), "{flag}");
        assert!(output.starts_with("usage:\n  omenflow mcp"), "{output}");
        assert!(output.contains("omenflow guide [topic]"));
        assert!(output.contains("omenflow status"));
        assert_eq!(errors, "");
    }
    for args in [
        &[][..],
        &["frobnicate"],
        &["call"],
        &["call", "cad_check", "--bogus"],
        &["call", "cad_check", "--input"],
        &["call", "cad_check", "--input", "{not json"],
        &["status", "--scope"],
        &["status", "now"],
    ] {
        let (status, output, errors) = run_alone(args);
        assert_eq!(status.code(), Some(3), "{args:?}");
        assert_eq!(output, "");
        let error: Value = serde_json::from_str(errors.trim()).unwrap();
        assert_eq!(error["error"]["code"], "VALIDATION", "{args:?}");
    }
    let (_, _, errors) = run_alone(&[]);
    assert!(errors.contains("omenflow call <tool>"), "{errors}");
}

#[test]
fn outside_a_session_the_helper_says_so() {
    let (status, _, errors) = run_alone(&["call", "project_summary"]);
    assert_eq!(status.code(), Some(2));
    let error: Value = serde_json::from_str(errors.trim()).unwrap();
    assert_eq!(error["error"]["code"], "APP_NOT_RUNNING");
    let (status, _, _) = run_alone(&["status"]);
    assert_eq!(status.code(), Some(2));
}
