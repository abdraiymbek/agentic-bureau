//! `stark` — production bridge helper shipped inside the STARK app bundle.
//!
//! Agent CLIs (Codex, Claude Code, custom) inherit per-session credentials in
//! their environment and call this binary to reach the running STARK app:
//!
//!   stark call <op> --input <file|'-'> [--idempotency-key k]
//!   stark mcp
//!
//! Wire protocol (see packages/contracts/src/protocol.ts):
//!   transport: unix socket / windows named pipe (env STARK_BRIDGE_SOCK)
//!   frames:    4-byte little-endian length + JSON body, max 8 MiB
//!   1. client → {type:"hello", token, protocolVersion:1, mode:"call"|"mcp"}
//!   2. server → {type:"welcome", ...} | {type:"error", error:{code,message}}
//!   3a. call: → {requestId, op, payload, idempotencyKey?}
//!             ← {requestId, ok, result|error}
//!   3b. mcp:  one JSON-RPC message per frame, both directions.
//!
//! Exit codes: 0 ok · 2 bridge/app error (JSON on stderr) · 3 usage.

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
    if body.len() as u32 > MAX_FRAME_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
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
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut body = vec![0u8; len as usize];
    r.read_exact(&mut body)?;
    serde_json::from_slice(&body).map(Some).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/* ------------------------------ args/env ------------------------------- */

struct Args {
    mode: String,      // "call" | "mcp"
    op: Option<String>,
    input: Option<String>,
    idempotency_key: Option<String>,
}

fn parse_args(argv: &[String]) -> Result<Args, String> {
    let mut out = Args { mode: String::new(), op: None, input: None, idempotency_key: None };
    let mut it = argv.iter();
    match it.next().map(|s| s.as_str()) {
        Some("mcp") => {
            out.mode = "mcp".into();
            return Ok(out);
        }
        Some("call") => out.mode = "call".into(),
        _ => return Err("usage: stark call <op> --input <file|-> [--idempotency-key k] | stark mcp".into()),
    }
    while let Some(a) = it.next() {
        match a.as_str() {
            "--input" => out.input = it.next().cloned(),
            "--idempotency-key" => out.idempotency_key = it.next().cloned(),
            s if !s.starts_with('-') && out.op.is_none() => out.op = Some(s.to_string()),
            s => return Err(format!("unexpected argument: {s}")),
        }
    }
    if out.op.is_none() {
        return Err("missing <op>".into());
    }
    if out.input.is_none() {
        return Err("missing --input <file|->".into());
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

    let socket_path = env::var("STARK_BRIDGE_SOCK").unwrap_or_default();
    let token = env::var("STARK_BRIDGE_TOKEN").unwrap_or_default();
    if socket_path.is_empty() || token.is_empty() {
        return fail(
            "APP_NOT_RUNNING",
            "STARK_BRIDGE_SOCK/STARK_BRIDGE_TOKEN not set — not inside a STARK session?",
        );
    }

    let mut stream = match connect(&socket_path) {
        Ok(s) => s,
        Err(e) => return fail("APP_NOT_RUNNING", &format!("Cannot connect to STARK bridge at {socket_path}: {e}")),
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
        let code = welcome.pointer("/error/code").and_then(Value::as_str).unwrap_or("CONNECTION_DENIED");
        let msg = welcome.pointer("/error/message").and_then(Value::as_str).unwrap_or("Handshake rejected");
        return fail(code, msg);
    }

    if args.mode == "mcp" {
        return mcp_pump(stream);
    }

    // --- mode "call" ---
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
    let payload: Value = if raw.trim().is_empty() {
        json!({})
    } else {
        match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return fail("VALIDATION", &format!("--input is not valid JSON: {e}")),
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
                println!("{}", serde_json::to_string_pretty(&result).unwrap_or_default());
                ExitCode::SUCCESS
            } else {
                eprint_json(&json!({"ok": false, "error": resp.get("error").cloned().unwrap_or(Value::Null)}));
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

    let code = AtomicU64::new(0);
    let writer_thread = thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(trimmed) {
                Ok(v) => {
                    if write_frame(&mut writer, &v).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    eprint_json(&json!({"ok": false, "error": {"code": "VALIDATION",
                        "message": format!("Bad JSON-RPC line: {e}")}}));
                }
            }
        }
        // stdin closed → half-close the socket so the server sees EOF.
        let _ = writer.shutdown(std::net::Shutdown::Write);
    });

    loop {
        match read_frame(&mut reader) {
            Ok(Some(v)) => {
                let mut out = io::stdout().lock();
                let _ = out.write_all(serde_json::to_string(&v).unwrap_or_default().as_bytes());
                let _ = out.write_all(b"\n");
                let _ = out.flush();
            }
            Ok(None) => break,              // socket closed
            Err(_) => {
                code.store(2, Ordering::Relaxed);
                break;
            }
        }
    }
    let _ = writer_thread.join();
    ExitCode::from(code.load(Ordering::Relaxed) as u8)
}

fn main() -> ExitCode {
    run()
}
