// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

use crate::actions;
use crate::error::MiseResult;
use crate::models::{MiseActionResult, MiseTool};
use crate::tools;
use crate::MiseState;

#[tauri::command]
pub async fn mise_tools_list() -> MiseResult<Vec<MiseTool>> {
    tools::list_tools().await
}

#[tauri::command]
pub async fn mise_tool_detail(
    state: tauri::State<'_, MiseState>,
    tool: String,
) -> MiseResult<MiseTool> {
    tools::tool_detail(state.inner(), &tool).await
}

#[tauri::command]
pub async fn mise_tool_detail_cancel(
    state: tauri::State<'_, MiseState>,
    tool: String,
) -> MiseResult<()> {
    tools::tool_detail_cancel(state.inner(), &tool).await
}

#[tauri::command]
pub async fn mise_action_run(
    app: tauri::AppHandle,
    state: tauri::State<'_, MiseState>,
    script: String,
    working_directory: Option<String>,
) -> MiseResult<MiseActionResult> {
    actions::run_script(&app, state.inner(), &script, working_directory.as_deref()).await
}
