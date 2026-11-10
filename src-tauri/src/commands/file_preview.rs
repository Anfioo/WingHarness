//! The preview page's two commands.
//!
//! The reading itself lives in `file-preview-core`; this layer adds the one
//! thing that crate should not know about — the app's config. The threshold is
//! re-read on every call, so a change in the settings window applies to the
//! next file opened, without a restart.

use file_preview_core::PreviewMeta;

use crate::config;

fn cap() -> u64 {
    config::load().file_preview.bytes_cap()
}

/// What the page knows about a file before reading it.
#[tauri::command]
pub fn preview_metadata(root: String, path: String) -> Result<PreviewMeta, String> {
    file_preview_core::metadata_at(&root, &path, cap())
}

/// A file's bytes, as raw IPC rather than a JSON array of numbers.
#[tauri::command]
pub fn preview_bytes(root: String, path: String) -> Result<tauri::ipc::Response, String> {
    file_preview_core::read_bytes(&root, &path, cap())
}
