use omenflow_agent_host::{wait_proposal, BridgeServer, PtyHost, TerminalEvent};
use omenflow_contracts::{parse_input, registry, ContractError, ResponseEnvelope};
use omenflow_core::{CoreApp, Origin};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

struct DesktopState {
    core: Arc<Mutex<CoreApp>>,
    pty: PtyHost,
}

#[tauri::command]
fn omenflow_command(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
    op: String,
    payload: Value,
    project_id: Option<String>,
    idempotency_key: Option<String>,
) -> ResponseEnvelope {
    let request_id = uuid::Uuid::new_v4().to_string();
    let definition = match registry().operation(&op) {
        Some(definition) => definition,
        None => {
            return ResponseEnvelope::failure(
                request_id,
                ContractError::validation(format!("Unknown operation: {op}")),
            )
        }
    };
    let payload = match parse_input(definition, payload) {
        Ok(value) => value,
        Err(error) => return ResponseEnvelope::failure(request_id, error),
    };
    let host_result = match op.as_str() {
        "connection.list" => Some(state.pty.connection_list()),
        "connection.configure" => Some(state.pty.connection_configure(&payload)),
        "connection.test" => Some(with_project(&project_id, |id| {
            state.pty.connection_test(id, &payload)
        })),
        "terminal.start" => Some(with_project(&project_id, |id| {
            state.pty.start(id, &payload)
        })),
        "terminal.write" => Some(with_project(&project_id, |id| {
            state.pty.write(id, payload["data"].as_str().unwrap_or(""))
        })),
        "terminal.resize" => Some(with_project(&project_id, |id| {
            state.pty.resize(
                id,
                payload["cols"].as_u64().unwrap_or(80) as u16,
                payload["rows"].as_u64().unwrap_or(24) as u16,
            )
        })),
        "terminal.interrupt" => Some(with_project(&project_id, |id| state.pty.interrupt(id))),
        "terminal.stop" => Some(with_project(&project_id, |id| state.pty.stop(id))),
        "terminal.restart" => Some(with_project(&project_id, |id| state.pty.restart(id))),
        "terminal.state" => Some(with_project(&project_id, |id| Ok(state.pty.state(id)))),
        "proposal.wait" => Some(with_project(&project_id, |id| {
            wait_proposal(&state.core, id, &payload)
        })),
        _ => None,
    };
    if let Some(result) = host_result {
        return envelope(request_id, result);
    }
    if op == "project.close" {
        if let Some(id) = project_id.as_deref() {
            let _ = state.pty.stop(id);
        }
    }
    let mut core = match state.core.lock() {
        Ok(core) => core,
        Err(_) => {
            return ResponseEnvelope::failure(
                request_id,
                ContractError::new("INTERNAL", "Application state is unavailable"),
            )
        }
    };
    let before = project_id
        .as_deref()
        .and_then(|id| core.latest_event_seq(id).ok());
    let result = core.dispatch_idempotent(
        &op,
        payload,
        Origin::User,
        project_id.as_deref(),
        idempotency_key.as_deref(),
    );
    if let (Some(id), Some(before)) = (project_id.as_deref(), before) {
        if let Ok(events) = core.events_since(id, before) {
            for event in events {
                let _ = app.emit("omenflow:event", event);
            }
        }
    }
    if op == "artifact.reveal" {
        if let Ok(value) = &result {
            if let Some(path) = value["path"].as_str() {
                if let Err(error) = app.opener().reveal_item_in_dir(path) {
                    return ResponseEnvelope::failure(
                        request_id,
                        ContractError::new("INTERNAL", error.to_string()),
                    );
                }
            }
        }
    }
    envelope(request_id, result)
}

fn with_project<T>(
    project_id: &Option<String>,
    f: impl FnOnce(&str) -> Result<T, ContractError>,
) -> Result<T, ContractError> {
    let id = project_id
        .as_deref()
        .ok_or_else(|| ContractError::validation("Project id is required"))?;
    f(id)
}

fn envelope(request_id: String, result: Result<Value, ContractError>) -> ResponseEnvelope {
    match result {
        Ok(value) => ResponseEnvelope::success(request_id, value),
        Err(error) => ResponseEnvelope::failure(request_id, error),
    }
}

#[tauri::command]
fn toggle_research() -> Result<Value, String> {
    Err("Research browser is not ported yet".into())
}

fn cli_path(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("omenflow");
        if bundled.is_file() {
            return bundled;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../native/omenflow-bridge/target/release/omenflow")
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let path = app.path().app_data_dir()?;
            let core = Arc::new(Mutex::new(
                CoreApp::new(&path).map_err(|error| std::io::Error::other(error.message))?,
            ));
            let event_handle = app.handle().clone();
            let bridge = Arc::new(BridgeServer::start_with_events(
                Arc::clone(&core),
                &path,
                Arc::new(move |event| {
                    let _ = event_handle.emit("omenflow:event", event);
                }),
            )?);
            let handle = app.handle().clone();
            let notify = Arc::new(move |event: TerminalEvent| match event {
                TerminalEvent::Data(data) => {
                    let _ = handle.emit("omenflow:terminal:data", data);
                }
                TerminalEvent::State(data) => {
                    let _ = handle.emit("omenflow:terminal:state", data);
                }
            });
            let pty = PtyHost::new(Arc::clone(&core), bridge, cli_path(app.handle()), notify);
            app.manage(DesktopState { core, pty });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![omenflow_command, toggle_research])
        .run(tauri::generate_context!())
        .expect("Omen Flow Rust desktop shell failed");
}
