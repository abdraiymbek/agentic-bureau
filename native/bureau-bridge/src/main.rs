//! `bureau` — production bridge helper shipped inside the Bureau app bundle.
//!
//! Agent CLIs (Codex, Claude Code, custom) inherit per-session credentials in
//! their environment and call this binary to reach the running Bureau app:
//!
//!   bureau mcp
//!   bureau call <tool> [--input <file|-|json>] [--idempotency-key k] [--pretty]
//!   bureau call <tool> --help
//!   bureau guide [topic]
//!   bureau status [--scope session|project]
//!
//! `<tool>` is a tool name (`cad_check`) or an operation name (`cad.check`);
//! the app resolves either.
//!
//! Wire protocol (see packages/contracts/src/protocol.ts):
//! ```text
//!   transport: unix socket / windows named pipe (env BUREAU_BRIDGE_SOCK)
//!   frames:    4-byte little-endian length + JSON body, max 8 MiB
//!   1. client → {type:"hello", token, protocolVersion:1, mode:"call"|"mcp"}
//!   2. server → {type:"welcome", ...} | {type:"error", error:{code,message}}
//!   3a. call: → {requestId, op, payload, idempotencyKey?}
//!             ← {requestId, ok, result|error}
//!   3b. mcp:  one JSON-RPC message per frame, both directions.
//! ```
//!
//! Exit codes: 0 ok · 2 bridge/app error (JSON on stderr, with the app's
//! `repair` sentence when it gave one) · 3 usage.

use interprocess::TryClone;
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::process::ExitCode;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

const PROTOCOL_VERSION: u64 = 1;
const MAX_FRAME_BYTES: u32 = 8 * 1024 * 1024;

fn eprint_json(v: &Value) {
    eprintln!("{}", serde_json::to_string(v).unwrap_or_default());
}

fn fail(code: &str, message: &str) -> ExitCode {
    eprint_json(&json!({"ok": false, "error": {"code": code, "message": message}}));
    ExitCode::from(2)
}

/* ------------------------------ transport ------------------------------ */

use interprocess::local_socket::{
    prelude::*, GenericFilePath, GenericNamespaced, Stream as LocalStream,
};

/// Connect to the bridge. `path` is a unix socket path or a Windows
/// `\\.\pipe\name` named pipe.
fn connect(path: &str) -> io::Result<LocalStream> {
    // Windows named pipe paths (`\\.\pipe\name`) map to interprocess
    // namespaced names; everything else is a filesystem socket path.
    let pipe = path
        .strip_prefix(r"\\.\pipe\")
        .or_else(|| path.strip_prefix(r"//./pipe/"));
    if let Some(name) = pipe {
        LocalStream::connect(name.to_ns_name::<GenericNamespaced>()?)
    } else {
        LocalStream::connect(path.to_fs_name::<GenericFilePath>()?)
    }
}

fn write_frame(w: &mut impl Write, v: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(v)?;
    if body.len() > MAX_FRAME_BYTES as usize {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    w.write_all(&(body.len() as u32).to_le_bytes())?;
    w.write_all(&body)?;
    w.flush()
}

fn read_frame(r: &mut impl Read) -> io::Result<Option<Value>> {
    let mut header = [0u8; 4];
    match r.read_exact(&mut header) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(header);
    if len > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    let mut body = vec![0u8; len as usize];
    r.read_exact(&mut body)?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/* ------------------------------ args/env ------------------------------- */

const USAGE: &str = "usage:
  bureau mcp                         serve the Bureau tools over MCP (stdio)
  bureau call <tool> [--input <file|-|json>] [--idempotency-key k] [--pretty]
                                       call a tool; the result is JSON on stdout
  bureau call <tool> --help          print a tool's arguments and an example
  bureau call tool_describe          list every tool
  bureau guide [topic]               print a short playbook (start, cad, components, finish, …)
  bureau status [--scope session|project]
                                       what is unfinished, and the next call for each item
<tool> is a tool name (cad_check) or an operation name (cad.check).";

/// What the command line asks for.
#[derive(Debug, PartialEq)]
enum Command {
    Mcp,
    Help,
    /// One request to the app.
    Call {
        op: String,
        input: Input,
        idempotency_key: Option<String>,
        output: Output,
    },
}

/// Where a call's input comes from.
#[derive(Debug, PartialEq)]
enum Input {
    /// Given on the command line or built by the helper.
    Inline(Value),
    /// A file to read, or `-` for standard input.
    Source(String),
}

/// How a call's result is printed.
#[derive(Debug, PartialEq)]
enum Output {
    Json {
        pretty: bool,
    },
    /// A playbook: its text, then the list of topics.
    Guide,
}

fn parse_args(argv: &[String]) -> Result<Command, String> {
    let mut rest = argv.iter().map(String::as_str);
    match rest.next() {
        Some("mcp") => Ok(Command::Mcp),
        Some("help" | "--help" | "-h") => Ok(Command::Help),
        Some("call") => parse_call(rest),
        Some("guide") => {
            let topic = rest.next().filter(|topic| !topic.starts_with('-'));
            Ok(Command::Call {
                op: "guide.read".into(),
                input: Input::Inline(
                    topic.map_or_else(|| json!({}), |topic| json!({"topic": topic})),
                ),
                idempotency_key: None,
                output: Output::Guide,
            })
        }
        Some("status") => {
            let mut input = json!({});
            while let Some(arg) = rest.next() {
                match arg {
                    "--scope" => {
                        let scope = rest.next().ok_or("missing value for --scope")?;
                        input["scope"] = json!(scope);
                    }
                    other => return Err(format!("unexpected argument: {other}")),
                }
            }
            Ok(Command::Call {
                op: "work.status".into(),
                input: Input::Inline(input),
                idempotency_key: None,
                output: Output::Json { pretty: false },
            })
        }
        Some(other) => Err(format!("unknown command: {other}\n{USAGE}")),
        None => Err(USAGE.into()),
    }
}

fn parse_call<'a>(mut rest: impl Iterator<Item = &'a str>) -> Result<Command, String> {
    let mut op = None;
    let mut input = None;
    let mut idempotency_key = None;
    let mut help = false;
    let mut pretty = false;
    while let Some(arg) = rest.next() {
        match arg {
            "--input" => input = Some(rest.next().ok_or("missing value for --input")?),
            "--idempotency-key" => {
                idempotency_key = Some(
                    rest.next()
                        .ok_or("missing value for --idempotency-key")?
                        .to_owned(),
                )
            }
            "--help" | "-h" => help = true,
            "--pretty" => pretty = true,
            name if !name.starts_with('-') && op.is_none() => op = Some(name.to_owned()),
            other => return Err(format!("unexpected argument: {other}")),
        }
    }
    let op = op.ok_or("missing <tool>")?;
    let output = Output::Json { pretty };
    if help {
        // `bureau call <tool> --help` → tool.describe: purpose, input
        // schema and an example call.
        return Ok(Command::Call {
            op: "tool.describe".into(),
            input: Input::Inline(json!({ "op": op })),
            idempotency_key: None,
            output,
        });
    }
    let input = match input {
        // A tool that takes no arguments needs no --input.
        None => Input::Inline(json!({})),
        Some(text) if text.trim_start().starts_with('{') => Input::Inline(
            serde_json::from_str(text).map_err(|e| format!("--input is not valid JSON: {e}"))?,
        ),
        Some(source) => Input::Source(source.to_owned()),
    };
    Ok(Command::Call {
        op,
        input,
        idempotency_key,
        output,
    })
}

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);

fn request_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{:x}-{:x}-{:x}", nanos, std::process::id(), n)
}

/* -------------------------------- main --------------------------------- */

fn run() -> ExitCode {
    let command = match parse_args(&env::args().skip(1).collect::<Vec<_>>()) {
        Ok(Command::Help) => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Ok(command) => command,
        Err(e) => {
            eprint_json(&json!({"ok": false, "error": {"code": "VALIDATION", "message": e}}));
            return ExitCode::from(3);
        }
    };

    let socket_path = env::var("BUREAU_BRIDGE_SOCK").unwrap_or_default();
    let token = env::var("BUREAU_BRIDGE_TOKEN").unwrap_or_default();
    if socket_path.is_empty() || token.is_empty() {
        return fail(
            "APP_NOT_RUNNING",
            "BUREAU_BRIDGE_SOCK/BUREAU_BRIDGE_TOKEN not set — not inside a Bureau session?",
        );
    }

    let mut stream = match connect(&socket_path) {
        Ok(s) => s,
        Err(e) => {
            return fail(
                "APP_NOT_RUNNING",
                &format!("Cannot connect to Bureau bridge at {socket_path}: {e}"),
            )
        }
    };

    // --- handshake ---
    let hello = json!({
        "type": "hello",
        "token": token,
        "protocolVersion": PROTOCOL_VERSION,
        "mode": if command == Command::Mcp { "mcp" } else { "call" },
    });
    if write_frame(&mut stream, &hello).is_err() {
        return fail("APP_NOT_RUNNING", "Bridge write failed during handshake");
    }
    let welcome = match read_frame(&mut stream) {
        Ok(Some(v)) => v,
        _ => return fail("APP_NOT_RUNNING", "Bridge closed during handshake"),
    };
    if welcome.get("type").and_then(Value::as_str) != Some("welcome") {
        let code = welcome
            .pointer("/error/code")
            .and_then(Value::as_str)
            .unwrap_or("CONNECTION_DENIED");
        let msg = welcome
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("Handshake rejected");
        return fail(code, msg);
    }

    let Command::Call {
        op,
        input,
        idempotency_key,
        output,
    } = command
    else {
        return mcp_pump(stream);
    };

    // --- mode "call" ---
    let payload = match input {
        Input::Inline(value) => value,
        Input::Source(source) => {
            let raw = if source == "-" {
                let mut s = String::new();
                match io::stdin().read_to_string(&mut s) {
                    Ok(_) => s,
                    Err(e) => return fail("VALIDATION", &format!("Cannot read stdin: {e}")),
                }
            } else {
                match fs::read_to_string(&source) {
                    Ok(s) => s,
                    Err(e) => {
                        return fail("VALIDATION", &format!("Cannot read --input {source}: {e}"))
                    }
                }
            };
            if raw.trim().is_empty() {
                json!({})
            } else {
                match serde_json::from_str(&raw) {
                    Ok(v) => v,
                    Err(e) => {
                        return fail("VALIDATION", &format!("--input is not valid JSON: {e}"))
                    }
                }
            }
        }
    };

    let mut req = json!({
        "requestId": request_id(),
        "op": op,
        "payload": payload,
    });
    if let Some(k) = idempotency_key {
        req["idempotencyKey"] = json!(k);
    }
    if write_frame(&mut stream, &req).is_err() {
        return fail("APP_NOT_RUNNING", "Bridge write failed");
    }
    match read_frame(&mut stream) {
        Ok(Some(resp)) => {
            if resp.get("ok").and_then(Value::as_bool) == Some(true) {
                let result = resp.get("result").cloned().unwrap_or(Value::Null);
                println!("{}", render(&result, &output));
                ExitCode::SUCCESS
            } else {
                // The whole error, on one line: code, message, the repair
                // sentence and the details (issues, example) the app sent.
                eprint_json(
                    &json!({"ok": false, "error": resp.get("error").cloned().unwrap_or(Value::Null)}),
                );
                ExitCode::from(2)
            }
        }
        _ => fail("APP_NOT_RUNNING", "Bridge closed before responding"),
    }
}

/// A result as text for standard output. JSON is compact unless asked
/// otherwise: the reader is usually a model, and indentation costs tokens.
fn render(result: &Value, output: &Output) -> String {
    match output {
        Output::Json { pretty: true } => serde_json::to_string_pretty(result).unwrap_or_default(),
        Output::Json { pretty: false } => serde_json::to_string(result).unwrap_or_default(),
        Output::Guide => {
            let mut text = result["text"].as_str().unwrap_or_default().to_owned();
            let topics = result["topics"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default();
            if !topics.is_empty() {
                text.push_str("\n\nTopics (bureau guide <topic>):");
                for topic in topics {
                    text.push_str(&format!(
                        "\n  {} — {}",
                        topic["id"].as_str().unwrap_or_default(),
                        topic["when"].as_str().unwrap_or_default()
                    ));
                }
            }
            text
        }
    }
}

/// Bidirectional pump: newline-delimited JSON-RPC on stdin → bridge frames;
/// bridge frames → newline-delimited JSON-RPC on stdout. stderr is
/// diagnostics-only. Exits when the socket closes.
fn mcp_pump(stream: LocalStream) -> ExitCode {
    let mut reader = match stream.try_clone() {
        Ok(s) => BufReader::new(s),
        Err(e) => return fail("INTERNAL", &format!("Cannot clone socket: {e}")),
    };
    let mut writer = stream;

    // Either EOF ends the process. Joining a blocked stdin reader after the
    // bridge revokes a grant would leave this helper alive indefinitely.
    let (completed, outcome) = std::sync::mpsc::channel::<u8>();
    let input_completed = completed.clone();
    thread::spawn(move || {
        let stdin = io::stdin();
        // Read raw bytes per line so one malformed line reports VALIDATION and
        // the pump continues — a bad line must not kill the MCP session.
        for line in stdin.lock().split(b'\n') {
            let bytes = match line {
                Ok(b) => b,
                Err(_) => {
                    let _ = input_completed.send(2);
                    return;
                }
            };
            let text = String::from_utf8_lossy(&bytes);
            let trimmed = text.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(trimmed) {
                Ok(v) => {
                    if write_frame(&mut writer, &v).is_err() {
                        let _ = input_completed.send(2);
                        return;
                    }
                }
                Err(_) => {
                    let preview: String = trimmed.chars().take(200).collect();
                    eprint_json(&json!({"ok": false, "error": {"code": "VALIDATION",
                        "message": format!("Bad JSON-RPC line: {preview}")}}));
                }
            }
        }
        let _ = input_completed.send(0);
    });
    thread::spawn(move || {
        loop {
            match read_frame(&mut reader) {
                Ok(Some(v)) => {
                    let mut out = io::stdout().lock();
                    if out
                        .write_all(serde_json::to_string(&v).unwrap_or_default().as_bytes())
                        .and_then(|_| out.write_all(b"\n"))
                        .and_then(|_| out.flush())
                        .is_err()
                    {
                        let _ = completed.send(2);
                        return;
                    }
                }
                Ok(None) => break,
                Err(_) => {
                    let _ = completed.send(2);
                    return;
                }
            }
        }
        let _ = completed.send(0);
    });
    ExitCode::from(outcome.recv().unwrap_or(2))
}

fn main() -> ExitCode {
    run()
}
