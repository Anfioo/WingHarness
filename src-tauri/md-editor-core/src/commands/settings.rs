//! Settings, recent files and session commands.
//!
//! Each one only adapts the wire arguments and forwards to its lane module.

use crate::error::MdEditorResult;
use crate::models::{MdEditorSettings, MdRecentList, MdSession};

#[tauri::command]
pub async fn md_editor_settings_get() -> MdEditorResult<MdEditorSettings> {
    crate::settings::get()
}

/// Replace the whole settings object; out-of-range values are clamped by the
/// store rather than rejected.
#[tauri::command]
pub async fn md_editor_settings_set(
    settings: MdEditorSettings,
) -> MdEditorResult<MdEditorSettings> {
    crate::settings::set(settings)
}

#[tauri::command]
pub async fn md_editor_recent_list() -> MdEditorResult<MdRecentList> {
    crate::recent::list()
}

/// Record a path as recently opened; deduplicated by path and capped at 30.
#[tauri::command]
pub async fn md_editor_recent_add(path: String) -> MdEditorResult<MdRecentList> {
    crate::recent::add(&path)
}

#[tauri::command]
pub async fn md_editor_recent_remove(path: String) -> MdEditorResult<MdRecentList> {
    crate::recent::remove(&path)
}

#[tauri::command]
pub async fn md_editor_session_get() -> MdEditorResult<MdSession> {
    crate::session::get()
}

/// Store the open tabs, cursors and view modes of the current run.
#[tauri::command]
pub async fn md_editor_session_set(session: MdSession) -> MdEditorResult<()> {
    crate::session::set(&session)
}
