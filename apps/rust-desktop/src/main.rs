use omenflow_contracts::{ContractError, ResponseEnvelope};
use omenflow_core::{CoreApp, Origin};
use serde_json::Value;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

#[tauri::command]
fn omenflow_command(
    app: tauri::AppHandle,
    state: State<'_, Mutex<CoreApp>>,
    op: String,
    payload: Value,
    project_id: Option<String>,
    idempotency_key: Option<String>,
) -> ResponseEnvelope {
    let request_id = uuid::Uuid::new_v4().to_string();
    let mut core = match state.lock() {
        Ok(core) => core,
        Err(_) => {
            return ResponseEnvelope::failure(
                request_id,
                ContractError::new("INTERNAL", "Application state is unavailable"),
            )
        }
    };
    if idempotency_key.is_some() {
        return ResponseEnvelope::failure(
            request_id,
            ContractError::new("INTERNAL", "Idempotent replay has not been ported"),
        );
    }
    let before = project_id
        .as_deref()
        .and_then(|id| core.latest_event_seq(id).ok());
    let result = core.dispatch(&op, payload, Origin::User, project_id.as_deref());
    if let (Some(id), Some(before)) = (project_id.as_deref(), before) {
        if let Ok(events) = core.events_since(id, before) {
            for event in events {
                let _ = app.emit("omenflow:event", event);
            }
        }
    }
    match result {
        Ok(value) => ResponseEnvelope::success(request_id, value),
        Err(error) => ResponseEnvelope::failure(request_id, error),
    }
}

#[tauri::command]
fn toggle_research() -> Result<Value, String> {
    Err("Research browser is not ported yet".into())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let path = app.path().app_data_dir()?;
            let core = CoreApp::new(path).map_err(|error| std::io::Error::other(error.message))?;
            app.manage(Mutex::new(core));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![omenflow_command, toggle_research])
        .run(tauri::generate_context!())
        .expect("Omen Flow Rust desktop shell failed");
}
