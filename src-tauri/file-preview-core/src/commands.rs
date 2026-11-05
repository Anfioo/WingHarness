//! The two commands the preview page calls.
//!
//! Commands cannot be defined at a crate root: the macro the attribute emits
//! lands in the same macro namespace the `#[macro_export]` re-import targets,
//! and the two definitions collide. A submodule is the standard fix.

use crate::{confine, meta, root, PreviewMeta, PREVIEW_MAX_BYTES};

/// What the page knows about a file before reading it.
#[tauri::command]
pub fn preview_metadata(path: String) -> Result<PreviewMeta, String> {
    meta::metadata_at(&root()?, &path)
}

/// A file's bytes, as raw IPC rather than a JSON array of numbers.
///
/// The cap is enforced here as well as advertised in [`PreviewMeta::over_cap`]
/// so a direct call cannot sidestep it.
#[tauri::command]
pub fn preview_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let target = confine::resolve(&root()?, &path)?;
    let metadata =
        std::fs::metadata(&target).map_err(|error| format!("读取 {path} 失败：{error}"))?;
    if metadata.is_dir() {
        return Err(format!("{path} 是目录。"));
    }
    if metadata.len() > PREVIEW_MAX_BYTES {
        return Err(format!(
            "文件过大（上限 {} MiB），无法预览。",
            PREVIEW_MAX_BYTES / 1024 / 1024
        ));
    }
    let bytes = std::fs::read(&target).map_err(|error| format!("读取 {path} 失败：{error}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}