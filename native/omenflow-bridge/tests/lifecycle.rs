#![cfg(unix)]

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn write_frame(socket: &mut UnixStream, value: Value) {
    let bytes = serde_json::to_vec(&value).unwrap();
    socket
        .write_all(&(bytes.len() as u32).to_le_bytes())
        .unwrap();
    socket.write_all(&bytes).unwrap();
}

fn connect(mode: &str) -> (Child, UnixStream, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "omen-rust-{}-{:?}",
        std::process::id(),
        std::thread::current().id(),
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let socket_path = dir.join("bridge.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_omenflow"));
    command.arg(mode);
    if mode == "call" {
        command.args(["artifact.list", "--input", "-"]);
    }
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
    let mut header = [0; 4];
    socket.read_exact(&mut header).unwrap();
    let mut body = vec![0; u32::from_le_bytes(header) as usize];
    socket.read_exact(&mut body).unwrap();
    let hello: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(hello["mode"], mode);
    assert_eq!(hello["token"], "test-token");
    write_frame(
        &mut socket,
        json!({ "type": "welcome", "protocolVersion": 1 }),
    );
    (child, socket, dir)
}

fn assert_exit(child: &mut Child) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success());
            return;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("bridge helper did not exit after EOF");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
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
fn call_round_trip_returns_the_result() {
    let (mut child, mut socket, dir) = connect("call");
    child.stdin.take().unwrap().write_all(b"{}").unwrap();
    let mut header = [0; 4];
    socket.read_exact(&mut header).unwrap();
    let mut body = vec![0; u32::from_le_bytes(header) as usize];
    socket.read_exact(&mut body).unwrap();
    let request: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(request["op"], "artifact.list");
    write_frame(
        &mut socket,
        json!({"requestId": request["requestId"], "ok": true, "result": {"artifacts": []}}),
    );
    assert_exit(&mut child);
    let mut output = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut output)
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&output).unwrap(),
        json!({"artifacts": []})
    );
    std::fs::remove_dir_all(dir).unwrap();
}
