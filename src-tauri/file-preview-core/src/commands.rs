//! What the preview page asks the backend for.
//!
//! These are plain functions, not Tauri commands: the cap is a setting the app
//! owns, so the thin command layer in the app crate reads the config and passes
//! it in. Keeping the crate free of that dependency is what lets it be tested
//! on its own.

use crate::{confine, meta, project_root, PreviewMeta};

/// What the page knows about a file before reading it.
pub fn metadata_at(root: &str, path: &str, max_bytes: u64) -> Result<PreviewMeta, String> {
    meta::metadata_at(&project_root(root)?, path, max_bytes)
}

/// A file's bytes, as raw IPC rather than a JSON array of numbers.
///
/// The cap is enforced here as well as advertised in [`PreviewMeta::over_cap`],
/// so the configured threshold is honoured by the read itself.
pub fn read_bytes(root: &str, path: &str, max_bytes: u64) -> Result<tauri::ipc::Response, String> {
    let target = confine::resolve(&project_root(root)?, path)?;
    let metadata =
        std::fs::metadata(&target).map_err(|error| format!("读取 {path} 失败：{error}"))?;
    if metadata.is_dir() {
        return Err(format!("{path} 是目录。"));
    }
    if metadata.len() > max_bytes {
        return Err(format!(
            "文件过大（上限 {} MiB），无法预览。",
            max_bytes / 1024 / 1024
        ));
    }
    let bytes = std::fs::read(&target).map_err(|error| format!("读取 {path} 失败：{error}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}
