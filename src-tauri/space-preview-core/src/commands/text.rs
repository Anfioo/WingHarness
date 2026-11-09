//! Text write-back.
//!
//! Thin forwarder: the encoding and the etag check live in `crate::text`.

use std::path::Path;

use tauri::State;

use crate::error::SpacePreviewResult;
use crate::models::WriteResult;
use crate::state::PreviewState;

#[tauri::command]
pub fn sp_write_text(
    state: State<'_, PreviewState>,
    path: String,
    text: String,
    encoding: String,
    etag: Option<String>,
) -> SpacePreviewResult<WriteResult> {
    crate::text::write_text(Path::new(&path), &text, &encoding, etag.as_deref(), &state)
}
