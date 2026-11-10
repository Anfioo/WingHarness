//! File inspection and ranged reads.
//!
//! Thin forwarders: decode the wire arguments and hand the work to `crate::io`.

use std::path::Path;

use tauri::{Manager, State};

use crate::error::{SpacePreviewError, SpacePreviewResult};
use crate::models::{DirectoryPage, PreviewFileInfo};
use crate::state::PreviewState;

#[tauri::command]
pub fn sp_inspect_file(
    state: State<'_, PreviewState>,
    path: String,
) -> SpacePreviewResult<PreviewFileInfo> {
    crate::io::inspect(Path::new(&path), &state)
}

/// One page of an inspected directory, with every entry admitted for later
/// reads.
#[tauri::command]
pub async fn sp_list_directory(
    state: State<'_, PreviewState>,
    app: tauri::AppHandle,
    path: String,
    offset: usize,
) -> SpacePreviewResult<DirectoryPage> {
    // Refuse an unadmitted path before anything blocks on the filesystem.
    let directory = state.check(Path::new(&path))?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<PreviewState>();
        crate::directory::list(&directory, offset, &state)
    })
    .await
    .map_err(|error| {
        SpacePreviewError::internal(format!("The directory task did not finish: {error}"))
    })?
}

#[tauri::command]
pub fn sp_read_prefix(
    state: State<'_, PreviewState>,
    path: String,
    limit: usize,
) -> SpacePreviewResult<tauri::ipc::Response> {
    let bytes = crate::io::read_prefix(Path::new(&path), limit, &state)?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn sp_read_range(
    state: State<'_, PreviewState>,
    path: String,
    offset: usize,
    limit: usize,
) -> SpacePreviewResult<tauri::ipc::Response> {
    let bytes = crate::io::read_range(Path::new(&path), offset, limit, &state)?;
    Ok(tauri::ipc::Response::new(bytes))
}
