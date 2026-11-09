//! The space agent's command surface.
//!
//! B2 implements these: status, the enable switch, hiding the preview window,
//! moving through a multi-file selection, the initial selection and the manual
//! "open these paths" entry point.

use crate::error::{SpacePreviewError, SpacePreviewResult};
use crate::models::{AgentStatus, InitialPaths};

#[tauri::command]
pub fn sp_agent_status() -> SpacePreviewResult<AgentStatus> {
    Err(SpacePreviewError::internal("not implemented"))
}

#[tauri::command]
pub fn sp_agent_set_enabled(enabled: bool) -> SpacePreviewResult<AgentStatus> {
    let _ = enabled;
    Err(SpacePreviewError::internal("not implemented"))
}

/// Closing the preview window is a no-op until the window shell exists; it is
/// safe to call at any time.
#[tauri::command]
pub fn sp_hide_preview() -> SpacePreviewResult<()> {
    Ok(())
}

#[tauri::command]
pub fn sp_navigate_file_selection(
    current: Option<String>,
    direction: i32,
) -> SpacePreviewResult<Option<String>> {
    let _ = (current, direction);
    Err(SpacePreviewError::internal("not implemented"))
}

/// Cancelling a pending selection move is a no-op until the agent exists.
#[tauri::command]
pub fn sp_cancel_file_navigation() -> SpacePreviewResult<()> {
    Ok(())
}

#[tauri::command]
pub fn sp_initial_paths() -> SpacePreviewResult<InitialPaths> {
    Err(SpacePreviewError::internal("not implemented"))
}

/// Opening the preview window is a no-op until B2 lands; callers may call it
/// without treating the absence of a window as an error.
#[tauri::command]
pub fn sp_open_preview(paths: Vec<String>, text: bool) -> SpacePreviewResult<()> {
    let _ = (paths, text);
    Ok(())
}
