//! Saves text the frontend has already rendered.
//!
//! The destination is a path the user picked in a native save dialog, which is
//! why it is not confined to a root the way every other caller-supplied path is:
//! the user chose it, and the dialog is what makes that choice trusted.

use std::fs;

/// Writes `content` to `path`, replacing whatever the dialog pointed at.
#[tauri::command]
pub fn save_text_file(path: String, content: String) -> Result<(), String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("No destination was chosen.".to_string());
    }
    fs::write(path, content).map_err(|error| format!("could not write {path}: {error}"))
}
