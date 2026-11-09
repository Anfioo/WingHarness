//! The space agent's command surface.
//!
//! Every function here is a thin forwarder to [`crate::agent`]; nothing is
//! decided at this layer beyond argument validation, so the shell behaviour has
//! exactly one implementation.

use tauri::{Emitter, Manager};

use crate::error::{SpacePreviewError, SpacePreviewResult};
use crate::models::{AgentStatus, InitialPaths};

/// Broadcast to the pages and the tray menu after the switch changes.
const AGENT_STATUS_EVENT: &str = "sp:agent-status";

#[tauri::command]
pub fn sp_agent_status() -> SpacePreviewResult<AgentStatus> {
    Ok(crate::agent::status())
}

/// Turn the Space handler on or off. The tray menu and the settings page both
/// call this, and both read the result back through `sp:agent-status`.
#[tauri::command]
pub fn sp_agent_set_enabled(
    enabled: bool,
    app: tauri::AppHandle,
) -> SpacePreviewResult<AgentStatus> {
    crate::agent::set_enabled(enabled);
    let status = crate::agent::status();
    if let Err(error) = app.emit(
        AGENT_STATUS_EVENT,
        serde_json::json!({ "enabled": status.enabled, "running": status.running }),
    ) {
        log::warn!("space_preview_agent_status_emit_failed error={error}");
    }
    Ok(status)
}

/// Hide the preview window. Calling it when the window is already hidden is not
/// an error: the window is a singleton the agent may have put away already.
#[tauri::command]
pub fn sp_hide_preview(app: tauri::AppHandle) -> SpacePreviewResult<()> {
    crate::agent::hide_preview(&app).map_err(|error| {
        SpacePreviewError::internal(format!("The preview window could not be hidden: {error}"))
    })
}

/// Move the file manager selection by one item and return the newly selected
/// path, or `None` when the move is refused or the selection is at its end.
///
/// The Shell COM and UI Automation calls block, so they run off the main thread.
#[tauri::command]
pub async fn sp_navigate_file_selection(
    current: Option<String>,
    direction: i32,
    app: tauri::AppHandle,
) -> SpacePreviewResult<Option<String>> {
    if !matches!(direction, -1 | 1) {
        return Err(SpacePreviewError::invalid_input(
            "The navigation direction must be 1 (next) or -1 (previous).",
        ));
    }
    tauri::async_runtime::spawn_blocking(move || crate::agent::navigate(app, current, direction))
        .await
        .map_err(|error| {
            SpacePreviewError::internal(format!("The navigation task did not finish: {error}"))
        })?
}

/// Stop following the file manager; an in-flight move is discarded.
#[tauri::command]
pub fn sp_cancel_file_navigation() -> SpacePreviewResult<()> {
    crate::agent::cancel_navigation();
    Ok(())
}

/// The selection a fresh preview window should open with. No file associations
/// are registered yet, so there is nothing to hand over.
#[tauri::command]
pub fn sp_initial_paths() -> SpacePreviewResult<InitialPaths> {
    Ok(crate::agent::initial_paths())
}

/// Show the preview window with these paths: the toolbar button, the tray's
/// "open file…" item and a window drop all end here.
#[tauri::command]
pub fn sp_open_preview(
    app: tauri::AppHandle,
    paths: Vec<String>,
    text: bool,
) -> SpacePreviewResult<()> {
    if app.get_webview_window(crate::agent::PREVIEW_WINDOW).is_none() {
        return Err(SpacePreviewError::not_found(
            "The preview window is not available.",
        ));
    }
    crate::agent::show_preview_files(&app, paths, text, false);
    Ok(())
}
