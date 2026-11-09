//! HTML relative resources.
//!
//! B3 implements this: only resources inside the HTML file's own directory and
//! its subdirectories may be read, so a crafted document cannot walk out with
//! `..`.

use tauri::State;

use crate::error::{SpacePreviewError, SpacePreviewResult};
use crate::state::PreviewState;

#[tauri::command]
pub fn sp_read_html_resource(
    state: State<'_, PreviewState>,
    path: String,
    base: String,
) -> SpacePreviewResult<tauri::ipc::Response> {
    let _ = (&state, path, base);
    Err(SpacePreviewError::internal("not implemented"))
}
