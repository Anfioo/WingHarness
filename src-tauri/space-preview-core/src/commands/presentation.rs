//! PowerPoint detection and conversion to PDF.
//!
//! Thin forwarders: the detection, the cache and the PowerShell helper live in
//! `crate::presentation`. Conversion blocks for as long as PowerPoint takes, so
//! it runs off the main thread.

use std::path::Path;

use tauri::State;

use crate::error::{SpacePreviewError, SpacePreviewResult};
use crate::models::PreviewFileInfo;
use crate::state::PreviewState;

/// Whether the local PowerPoint can be driven over COM. Never an error: false
/// simply tells the viewer to use its own slide renderer.
#[tauri::command]
pub fn sp_probe_presentation() -> bool {
    crate::presentation::available()
}

/// Convert an inspected presentation to PDF and describe the cached PDF, which
/// this call also admits for the subsequent reads.
#[tauri::command]
pub async fn sp_render_presentation(
    state: State<'_, PreviewState>,
    path: String,
    _app: tauri::AppHandle,
) -> SpacePreviewResult<PreviewFileInfo> {
    let source = state.check(Path::new(&path))?;
    let cache_dir = crate::paths::presentation_dir();
    let output = tauri::async_runtime::spawn_blocking(move || {
        crate::presentation::render(&source, &cache_dir)
    })
    .await
    .map_err(|error| {
        SpacePreviewError::internal(format!(
            "The presentation conversion task did not finish: {error}"
        ))
    })??;
    crate::io::inspect(&output, &state)
}
