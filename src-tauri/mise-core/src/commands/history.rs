// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

use crate::error::MiseResult;
use crate::history;
use crate::models::MiseHistoryEntry;

/// The history file keeps at most this many entries.
const HISTORY_LIMIT: usize = 100;

#[tauri::command]
pub async fn mise_history_list() -> MiseResult<Vec<MiseHistoryEntry>> {
    history::list(HISTORY_LIMIT)
}

#[tauri::command]
pub async fn mise_history_record_canceled(command: String) -> MiseResult<MiseHistoryEntry> {
    history::record_canceled(&command)
}
