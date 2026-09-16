use simple_directory_engine::error::SimpleDirectoryError;
use simple_directory_engine::state::AppState;
use simple_directory_ipc::agent_instructions as core;

#[derive(serde::Deserialize)]
pub struct AgentInstructionsRequest {
    vault_id: String,
}

#[tauri::command]
pub async fn agent_instructions_status(
    state: tauri::State<'_, AppState>,
    req: AgentInstructionsRequest,
) -> Result<core::AgentInstructionsStatus, SimpleDirectoryError> {
    core::status(state.inner(), &req.vault_id).await
}

#[tauri::command]
pub async fn agent_instructions_accept(
    state: tauri::State<'_, AppState>,
    req: AgentInstructionsRequest,
) -> Result<core::AgentInstructionsAccepted, SimpleDirectoryError> {
    core::accept(state.inner(), &req.vault_id).await
}

#[tauri::command]
pub async fn agent_instructions_decline(
    state: tauri::State<'_, AppState>,
    req: AgentInstructionsRequest,
) -> Result<(), SimpleDirectoryError> {
    core::decline(state.inner(), &req.vault_id).await
}
