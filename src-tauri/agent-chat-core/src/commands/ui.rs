//! Persisted UI state (`ui.json`): open tabs, per-engine prefs, grants.

use crate::error::AgentChatError;
use crate::models::AgentUiState;

#[tauri::command]
pub async fn agent_ui_get() -> Result<AgentUiState, AgentChatError> {
    tauri::async_runtime::spawn_blocking(crate::store::load)
        .await
        .map_err(|error| AgentChatError::internal(format!("UI state read failed: {error}")))?
}

#[tauri::command]
pub async fn agent_ui_set(state: AgentUiState) -> Result<(), AgentChatError> {
    tauri::async_runtime::spawn_blocking(move || crate::store::save(&state))
        .await
        .map_err(|error| AgentChatError::internal(format!("UI state write failed: {error}")))?
}
