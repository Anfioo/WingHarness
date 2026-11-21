// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{MiseError, MiseResult};
use crate::models::{MiseHealthLevel, MiseHistoryEntry, MiseHistoryStatus};

static ENTRY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// The newest `limit` entries, newest first. A missing file is an empty list.
pub fn list(_limit: usize) -> MiseResult<Vec<MiseHistoryEntry>> {
    Ok(Vec::new())
}

/// Append one finished action, trimming the file to the newest entries.
pub fn append(_entry: MiseHistoryEntry) -> MiseResult<()> {
    Err(MiseError::not_implemented())
}

/// Record an action the user cancelled before it produced a result.
pub fn record_canceled(_command: &str) -> MiseResult<MiseHistoryEntry> {
    Err(MiseError::not_implemented())
}

/// Build an entry with a fresh id and the current timestamp.
pub fn new_entry(
    command: &str,
    detail: &str,
    level: MiseHealthLevel,
    status: MiseHistoryStatus,
) -> MiseHistoryEntry {
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    let sequence = ENTRY_SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1;
    MiseHistoryEntry {
        id: format!("{timestamp_ms}-{sequence}"),
        timestamp_ms,
        command: command.to_string(),
        detail: detail.to_string(),
        level,
        status,
        exit_code: None,
        duration_ms: None,
        stdout: None,
        stderr: None,
        stdout_snippet: None,
        stderr_snippet: None,
    }
}
