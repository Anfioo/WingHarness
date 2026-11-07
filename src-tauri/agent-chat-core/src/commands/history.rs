//! Native session history commands. Both do disk I/O, so both run on the
//! blocking pool instead of the WebView thread.

use std::path::Path;

use crate::error::AgentChatError;
use crate::models::{AgentSessionMeta, AgentSessionPage};

const DEFAULT_PAGE_LIMIT: u32 = 200;

#[tauri::command]
pub async fn agent_list_sessions(
    engine: Option<String>,
    workspace_path: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<AgentSessionMeta>, AgentChatError> {
    let limit = limit.unwrap_or(DEFAULT_PAGE_LIMIT) as usize;
    tauri::async_runtime::spawn_blocking(move || {
        crate::history::list_sessions(
            engine.as_deref(),
            workspace_path.as_deref().map(Path::new),
            limit,
        )
    })
    .await
    .map_err(|error| AgentChatError::internal(format!("Session scan failed: {error}")))?
}

#[tauri::command]
pub async fn agent_load_session(
    engine: String,
    session_id: String,
    workspace_path: String,
    limit: Option<u32>,
    before_seq: Option<i64>,
) -> Result<AgentSessionPage, AgentChatError> {
    let limit = limit.unwrap_or(DEFAULT_PAGE_LIMIT) as usize;
    tauri::async_runtime::spawn_blocking(move || {
        crate::history::load_session(
            &engine,
            &session_id,
            Path::new(&workspace_path),
            limit,
            before_seq,
        )
    })
    .await
    .map_err(|error| AgentChatError::internal(format!("Session read failed: {error}")))?
}
