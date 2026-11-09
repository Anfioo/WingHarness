//! PowerPoint detection and conversion to PDF.
//!
//! B3 implements these: probe whether a local PowerPoint can be driven over
//! COM, and render a PPTX/PPT/PPS/POT file through it into the presentation
//! cache.

use tauri::State;

use crate::error::{SpacePreviewError, SpacePreviewResult};
use crate::models::PreviewFileInfo;
use crate::state::PreviewState;

#[tauri::command]
pub fn sp_probe_presentation() -> SpacePreviewResult<bool> {
    Err(SpacePreviewError::internal("not implemented"))
}

#[tauri::command]
pub fn sp_render_presentation(
    state: State<'_, PreviewState>,
    path: String,
) -> SpacePreviewResult<PreviewFileInfo> {
    let _ = (&state, path);
    Err(SpacePreviewError::internal("not implemented"))
}
