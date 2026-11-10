//! HTML relative resources.
//!
//! Thin forwarder: the directory confinement lives in `crate::html`.

use std::path::Path;

use tauri::State;

use crate::error::SpacePreviewResult;
use crate::state::PreviewState;

/// Read the resource `path` references from the document at `base`.
#[tauri::command]
pub fn sp_read_html_resource(
    state: State<'_, PreviewState>,
    path: String,
    base: String,
) -> SpacePreviewResult<tauri::ipc::Response> {
    let bytes = crate::html::read_html_resource(Path::new(&path), Path::new(&base), &state)?;
    Ok(tauri::ipc::Response::new(bytes))
}
