// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

use crate::error::MiseResult;
use crate::models::MiseRuntimeInfo;
use crate::runtime;

#[tauri::command]
pub async fn mise_runtime_info() -> MiseResult<MiseRuntimeInfo> {
    runtime::probe_runtime().await
}
