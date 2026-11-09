//! File inspection and ranged reads.
//!
//! Thin forwarders: decode the wire arguments and hand the work to `crate::io`.

use std::path::Path;

use tauri::State;

use crate::error::SpacePreviewResult;
use crate::models::PreviewFileInfo;
use crate::state::PreviewState;

#[tauri::command]
pub fn sp_inspect_file(
    state: State<'_, PreviewState>,
    path: String,
) -> SpacePreviewResult<PreviewFileInfo> {
    crate::io::inspect(Path::new(&path), &state)
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
