//! Text write-back.
//!
//! B1 implements this: the encoding is applied in the backend because the
//! browser's `TextEncoder` only writes UTF-8, and the `etag` guards against a
//! change on disk between the read and the write.

use tauri::State;

use crate::error::{SpacePreviewError, SpacePreviewResult};
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
    let _ = (&state, path, text, encoding, etag);
    Err(SpacePreviewError::internal("not implemented"))
}
