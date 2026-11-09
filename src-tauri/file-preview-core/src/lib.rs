//! The file preview backend: the raw bytes of one project's files.
//!
//! The viewers themselves are entirely frontend — pdf.js, exceljs, mammoth and
//! the rest parse in the webview. This crate does the one thing they cannot:
//! hand back a file's bytes, confined to the root the caller named.
//!
//! There is no single root here, and no provider for one: each call takes the
//! root of the preview or project window that is asking, so two projects never
//! reach each other's files.
//!
//! The size cap is a parameter rather than a constant: the app's settings own
//! it, and the thin command layer in `src/commands/file_preview.rs` reads it
//! from the config on every call.

mod commands;
mod confine;
mod meta;
mod mime;

use std::path::PathBuf;

pub use commands::{metadata_at, read_bytes};
pub use meta::PreviewMeta;

/// The root the caller named, checked to be an existing directory.
pub(crate) fn project_root(root: &str) -> Result<PathBuf, String> {
    let root = root.trim();
    if root.is_empty() {
        return Err("No project root was given.".to_string());
    }
    let path = PathBuf::from(root);
    if !path.is_absolute() {
        return Err(format!("Project root is not an absolute path: {root}"));
    }
    if !path.is_dir() {
        return Err(format!("Project root is not an existing directory: {root}"));
    }
    Ok(path)
}
