// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

use crate::error::{MiseError, MiseResult};
use crate::history;
use crate::models::MiseHistoryEntry;

/// The history file keeps at most this many entries.
const HISTORY_LIMIT: usize = 100;

async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> MiseResult<T> + Send + 'static,
) -> MiseResult<T> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| MiseError::internal(format!("The mise history task failed: {error}")))?
}

#[tauri::command]
pub async fn mise_history_list() -> MiseResult<Vec<MiseHistoryEntry>> {
    blocking(|| history::list(HISTORY_LIMIT)).await
}

#[tauri::command]
pub async fn mise_history_record_canceled(command: String) -> MiseResult<MiseHistoryEntry> {
    blocking(move || history::record_canceled(&command)).await
}
