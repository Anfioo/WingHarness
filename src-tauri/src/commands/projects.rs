//! The picker's commands: the recent-project list and which one is active.
//!
//! The work itself lives in [`crate::projects`]; these are the Tauri boundary.
//! Every command takes or returns the whole document so the picker and the
//! in-page selectors never have to re-read it after a change.

use crate::projects::{self, ProjectEntry, Projects};

/// The recent list, most recently opened first.
#[tauri::command]
pub fn project_recent_list() -> Vec<ProjectEntry> {
    projects::load().recent
}

/// The project last worked on, or `None` when nothing has been opened yet.
#[tauri::command]
pub fn project_active() -> Option<String> {
    projects::active()
}

/// Records an open: prepends the path and makes it active.
#[tauri::command]
pub fn project_remember(root: String) -> Result<Projects, String> {
    projects::remember(&root)
}

/// Drops a project from the recent list.
#[tauri::command]
pub fn project_forget(root: String) -> Result<Projects, String> {
    projects::forget(&root)
}

/// Switches the active project without touching the list order.
#[tauri::command]
pub fn project_set_active(root: String) -> Result<Projects, String> {
    projects::set_active(&root)
}
