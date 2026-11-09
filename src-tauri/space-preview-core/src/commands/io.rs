//! File inspection and ranged reads.
//!
//! B1 implements these. `sp_inspect_file` is the only entry that admits a path
//! into the allowlist; the two reads only accept paths it admitted.

use tauri::State;

use crate::error::{SpacePreviewError, SpacePreviewResult};
use crate::models::PreviewFileInfo;
use crate::state::PreviewState;

#[tauri::command]
pub fn sp_inspect_file(
    state: State<'_, PreviewState>,
    path: String,
) -> SpacePreviewResult<PreviewFileInfo> {
    let _ = (&state, path);
    Err(SpacePreviewError::internal("not implemented"))
}

#[tauri::command]
pub fn sp_read_prefix(
    state: State<'_, PreviewState>,
    path: String,
    limit: usize,
) -> SpacePreviewResult<tauri::ipc::Response> {
    let _ = (&state, path, limit);
    Err(SpacePreviewError::internal("not implemented"))
}

#[tauri::command]
pub fn sp_read_range(
    state: State<'_, PreviewState>,
    path: String,
    offset: usize,
    limit: usize,
) -> SpacePreviewResult<tauri::ipc::Response> {
    let _ = (&state, path, offset, limit);
    Err(SpacePreviewError::internal("not implemented"))
}
