//! Document commands: open, save, metadata, assets and binary writes.
//!
//! Each one only adapts the wire arguments and forwards to its lane module.

use crate::error::MdEditorResult;
use crate::models::{Eol, MdAssetResult, MdEncoding, MdFileMeta, MdReadResult, MdSaveResult};

/// Read a document, reporting the encoding and EOL it was stored with.
#[tauri::command]
pub async fn md_editor_open_file(path: String) -> MdEditorResult<MdReadResult> {
    crate::text::read_text(&path)
}

/// Write a document back in its original encoding, refusing to overwrite a file
/// that changed on disk after `expected_mtime_ms`.
#[tauri::command]
pub async fn md_editor_save_file(
    path: String,
    content: String,
    encoding: MdEncoding,
    eol: Eol,
    expected_mtime_ms: Option<u64>,
) -> MdEditorResult<MdSaveResult> {
    crate::text::write_text(&path, &content, encoding, eol, expected_mtime_ms)
}

/// Existence and timestamps only; used to flag recently opened files that were
/// moved or deleted.
#[tauri::command]
pub async fn md_editor_file_meta(path: String) -> MdEditorResult<MdFileMeta> {
    crate::text::file_meta(&path)
}

/// Inline a local image as a data URL for the preview and the exports.
#[tauri::command]
pub async fn md_editor_read_asset(path: String) -> MdEditorResult<MdAssetResult> {
    crate::binary::read_asset(&path)
}

/// Write base64 bytes (HTML export, long-image PNG) to `path`.
#[tauri::command]
pub async fn md_editor_save_binary(path: String, base64: String) -> MdEditorResult<()> {
    crate::binary::save_binary(&path, &base64)
}
