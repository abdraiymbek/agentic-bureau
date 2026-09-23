//! `omenflow` — production bridge helper shipped inside the Omen Flow app bundle.
//!
//! Agent CLIs (Codex, Claude Code, custom) inherit per-session credentials in
//! their environment and call this binary to reach the running Omen Flow app:
//!
//!   omenflow call <op> --input <file|'-'> [--idempotency-key k]
//!   omenflow mcp
//!
//! Wire protocol (see packages/contracts/src/protocol.ts):
//! ```text
//!   transport: unix socket / windows named pipe (env OMENFLOW_BRIDGE_SOCK)
//!   frames:    4-byte little-endian length + JSON body, max 8 MiB
//!   1. client → {type:"hello", token, protocolVersion:1, mode:"call"|"mcp"}
//!   2. server → {type:"welcome", ...} | {type:"error", error:{code,message}}
//!   3a. call: → {requestId, op, payload, idempotencyKey?}
//!             ← {requestId, ok, result|error}
//!   3b. mcp:  one JSON-RPC message per frame, both directions.
//! ```
//!
//! Exit codes: 0 ok · 2 bridge/app error (JSON on stderr) · 3 usage.

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

struct Args {
    mode: String, // "call" | "mcp"
    op: Option<String>,
    input: Option<String>,
    idempotency_key: Option<String>,
    /// `omenflow call <op> --help`: describe this op instead of calling it.
    help_for: Option<String>,
}

fn parse_args(argv: &[String]) -> Result<Args, String> {
    let mut out = Args {
        mode: String::new(),
        op: None,
        input: None,
        idempotency_key: None,
        help_for: None,
    };
    let mut it = argv.iter();
    match it.next().map(|s| s.as_str()) {
        Some("mcp") => {
            out.mode = "mcp".into();
            return Ok(out);
        }
        Some("call") => out.mode = "call".into(),
        _ => {
            return Err(
                "usage: omenflow call <op> --input <file|-> [--idempotency-key k] | omenflow call <op> --help | omenflow mcp"
                    .into(),
            )
        }
    }
    let mut help = false;
    while let Some(a) = it.next() {
        match a.as_str() {
            "--input" => out.input = it.next().cloned(),
            "--idempotency-key" => out.idempotency_key = it.next().cloned(),
            "--help" | "-h" => help = true,
            s if !s.starts_with('-') && out.op.is_none() => out.op = Some(s.to_string()),
            s => return Err(format!("unexpected argument: {s}")),
        }
    }
    if out.op.is_none() {
        return Err("missing <op>".into());
    }
    if help {
        // `omenflow call <op> --help` → tool.describe <op>: purpose + input JSON schema.
        out.help_for = out.op.take();
        out.op = Some("tool.describe".into());
        return Ok(out);
    }
    if out.input.is_none() {
        return Err("missing --input <file|-> (or --help for the schema)".into());
    }
    Ok(out)
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
    let args = match parse_args(&env::args().skip(1).collect::<Vec<_>>()) {
        Ok(a) => a,
        Err(e) => {
            eprint_json(&json!({"ok": false, "error": {"code": "VALIDATION", "message": e}}));
            return ExitCode::from(3);
        }
    };

    let socket_path = env::var("OMENFLOW_BRIDGE_SOCK").unwrap_or_default();
    let token = env::var("OMENFLOW_BRIDGE_TOKEN").unwrap_or_default();
    if socket_path.is_empty() || token.is_empty() {
        return fail(
            "APP_NOT_RUNNING",
            "OMENFLOW_BRIDGE_SOCK/OMENFLOW_BRIDGE_TOKEN not set — not inside an Omen Flow session?",
        );
    }

    let mut stream = match connect(&socket_path) {
        Ok(s) => s,
        Err(e) => {
            return fail(
                "APP_NOT_RUNNING",
                &format!("Cannot connect to Omen Flow bridge at {socket_path}: {e}"),
            )
        }
    };

    // --- handshake ---
    let hello = json!({
        "type": "hello",
        "token": token,
        "protocolVersion": PROTOCOL_VERSION,
        "mode": args.mode,
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

    if args.mode == "mcp" {
        return mcp_pump(stream);
    }

    // --- mode "call" ---
    let payload: Value = if let Some(target) = args.help_for.as_deref() {
        json!({ "op": target })
    } else {
        let raw = match args.input.as_deref() {
            Some("-") => {
                let mut s = String::new();
                match io::stdin().read_to_string(&mut s) {
                    Ok(_) => s,
                    Err(e) => return fail("VALIDATION", &format!("Cannot read stdin: {e}")),
                }
            }
            Some(p) => match fs::read_to_string(p) {
                Ok(s) => s,
                Err(e) => return fail("VALIDATION", &format!("Cannot read --input {p}: {e}")),
            },
            None => String::new(),
        };
        if raw.trim().is_empty() {
            json!({})
        } else {
            match serde_json::from_str(&raw) {
                Ok(v) => v,
                Err(e) => return fail("VALIDATION", &format!("--input is not valid JSON: {e}")),
            }
        }
    };

    let mut req = json!({
        "requestId": request_id(),
        "op": args.op.unwrap(),
        "payload": payload,
    });
    if let Some(k) = args.idempotency_key {
        req["idempotencyKey"] = json!(k);
    }
    if write_frame(&mut stream, &req).is_err() {
        return fail("APP_NOT_RUNNING", "Bridge write failed");
    }
    match read_frame(&mut stream) {
        Ok(Some(resp)) => {
            if resp.get("ok").and_then(Value::as_bool) == Some(true) {
                let result = resp.get("result").cloned().unwrap_or(Value::Null);
                println!(
                    "{}",
                    serde_json::to_string_pretty(&result).unwrap_or_default()
                );
                ExitCode::SUCCESS
            } else {
                eprint_json(
                    &json!({"ok": false, "error": resp.get("error").cloned().unwrap_or(Value::Null)}),
                );
                ExitCode::from(2)
            }
        }
        _ => fail("APP_NOT_RUNNING", "Bridge closed before responding"),
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
