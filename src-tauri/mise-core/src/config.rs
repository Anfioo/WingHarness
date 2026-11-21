// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

use crate::error::{MiseError, MiseResult};
use crate::models::{MiseConfigEdit, MiseConfigSavePreview, MiseConfigSaveResult, MiseConfigWorkspace};

/// Read the global configuration and, when a project is selected, that
/// project's TOML document plus the structured sections the page edits.
pub async fn workspace(
    _project_path: Option<&str>,
    _project_config_path: Option<&str>,
    _project_name: Option<&str>,
) -> MiseResult<MiseConfigWorkspace> {
    Err(MiseError::not_implemented())
}

/// Compute the next document content and its unified diff without writing.
pub async fn preview_edit(_path: &str, _edit: &MiseConfigEdit) -> MiseResult<MiseConfigSavePreview> {
    Err(MiseError::not_implemented())
}

/// Back up the existing document, then replace it atomically.
pub async fn save(
    _app: &tauri::AppHandle,
    _path: &str,
    _next_content: &str,
) -> MiseResult<MiseConfigSaveResult> {
    Err(MiseError::not_implemented())
}
