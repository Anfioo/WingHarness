//! Chat commands: inventory, send, interrupt, liveness and question answers.

use tauri::State;

use crate::error::AgentChatError;
use crate::models::{AgentEngineInfo, AgentSendInput, AgentSendResult};
use crate::AgentChatState;

#[tauri::command]
pub async fn agent_list_engines() -> Result<Vec<AgentEngineInfo>, AgentChatError> {
    Ok(crate::engine::engine_infos())
}

#[tauri::command]
pub async fn agent_send(
    state: State<'_, AgentChatState>,
    input: AgentSendInput,
) -> Result<AgentSendResult, AgentChatError> {
    crate::engine::send(&state, input).await
}

#[tauri::command]
pub fn agent_interrupt(state: State<'_, AgentChatState>, run_id: String) -> bool {
    crate::engine::interrupt(&state, &run_id)
}

#[tauri::command]
pub fn agent_live_runs(state: State<'_, AgentChatState>, run_ids: Vec<String>) -> Vec<String> {
    crate::engine::live_runs(&state, &run_ids)
}

#[tauri::command]
pub async fn agent_answer(
    state: State<'_, AgentChatState>,
    run_id: String,
    request_id: String,
    answers: Option<serde_json::Value>,
) -> Result<(), AgentChatError> {
    crate::engine::answer(&state, &run_id, &request_id, answers).await
}
