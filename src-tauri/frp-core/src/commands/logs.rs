//! Log command bodies: read the in-memory ring buffer and clear it.

use tauri::State;

use crate::error::FrpResult;
use crate::models::LogEntry;
use crate::process::MAX_LOG_LINES;
use crate::state::FrpState;

const MAX_QUERY_LIMIT: u32 = 1000;

pub async fn recent(
    state: State<'_, FrpState>,
    profile_id: Option<String>,
    limit: Option<u32>,
) -> FrpResult<Vec<LogEntry>> {
    let limit = limit
        .unwrap_or(MAX_LOG_LINES as u32)
        .clamp(1, MAX_QUERY_LIMIT) as usize;
    Ok(state.process.recent_logs(profile_id.as_deref(), limit))
}

pub async fn clear(state: State<'_, FrpState>, profile_id: Option<String>) -> FrpResult<()> {
    state.process.clear_logs(profile_id.as_deref());
    Ok(())
}
