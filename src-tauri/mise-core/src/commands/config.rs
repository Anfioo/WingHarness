// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

use crate::config;
use crate::error::MiseResult;
use crate::models::{MiseConfigEdit, MiseConfigSavePreview, MiseConfigSaveResult, MiseConfigWorkspace};

#[tauri::command]
pub async fn mise_config_workspace(
    project_path: Option<String>,
    project_config_path: Option<String>,
    project_name: Option<String>,
) -> MiseResult<MiseConfigWorkspace> {
    config::workspace(
        project_path.as_deref(),
        project_config_path.as_deref(),
        project_name.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn mise_config_preview_edit(
    path: String,
    edit: MiseConfigEdit,
) -> MiseResult<MiseConfigSavePreview> {
    config::preview_edit(&path, &edit).await
}

#[tauri::command]
pub async fn mise_config_save(
    app: tauri::AppHandle,
    path: String,
    next_content: String,
) -> MiseResult<MiseConfigSaveResult> {
    config::save(&app, &path, &next_content).await
}
