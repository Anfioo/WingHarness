//! System file icons.
//!
//! B3 implements this: ask the shell for the icon of a path (or of a name and
//! folder flag when the file does not exist) and hand back a PNG.

use crate::error::{SpacePreviewError, SpacePreviewResult};

#[tauri::command]
pub fn sp_file_icon(
    path: Option<String>,
    name: String,
    folder: bool,
) -> SpacePreviewResult<tauri::ipc::Response> {
    let _ = (path, name, folder);
    Err(SpacePreviewError::internal("not implemented"))
}
