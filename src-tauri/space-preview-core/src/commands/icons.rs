//! System file icons.
//!
//! Thin forwarder: the Shell calls live in `crate::icons`. Rendering an icon
//! initializes COM and draws through GDI, so it runs off the main thread.

use std::path::Path;

use crate::error::{SpacePreviewError, SpacePreviewResult};

/// A PNG for `path`, or for the generic icon of `name` when there is no path.
/// An empty body means the shell had no icon; the frontend then draws its own.
#[tauri::command]
pub async fn sp_file_icon(
    path: Option<String>,
    name: String,
    folder: bool,
) -> SpacePreviewResult<tauri::ipc::Response> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        crate::icons::read(path.as_deref().map(Path::new), &name, folder)
    })
    .await
    .map_err(|error| {
        SpacePreviewError::internal(format!("The icon task did not finish: {error}"))
    })??;
    Ok(tauri::ipc::Response::new(bytes))
}
