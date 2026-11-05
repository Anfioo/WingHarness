//! Uninstall execution history persisted under the systools data directory.
//!
//! History is one JSON array capped at [`MAX_RECORDS`] entries. Writes go to a
//! process-unique temporary file in the same directory and then replace the
//! target atomically, so a crash mid-write cannot leave a truncated array.
//! History is advisory: a failed write must never turn a completed uninstall
//! into a failed command.

use std::path::Path;

use serde_json::Value;

/// File name inside the systools data directory.
const HISTORY_FILE: &str = "uninstall-history.json";
/// Maximum number of retained executions.
pub(crate) const MAX_RECORDS: usize = 200;

/// Appends one record to the persisted history array.
pub(crate) fn append(record: &Value) -> Result<(), String> {
    let directory = crate::paths::dir().map_err(|error| error.to_string())?;
    append_to(&directory.join(HISTORY_FILE), record)
}

/// Appends to an explicit path. Split out so the cap and atomic replacement
/// can be unit-tested without a configured data directory.
pub(crate) fn append_to(path: &Path, record: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("history directory create failed: {error}"))?;
    }
    let mut records = read_records(path);
    records.push(record.clone());
    if records.len() > MAX_RECORDS {
        let excess = records.len() - MAX_RECORDS;
        records.drain(0..excess);
    }
    let bytes = serde_json::to_vec(&records)
        .map_err(|error| format!("history serialization failed: {error}"))?;
    write_atomically(path, &bytes)
}

fn read_records(path: &Path) -> Vec<Value> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
            log::warn!(
                "systools_uninstall_history_unreadable path={} error={error}",
                path.display()
            );
            Vec::new()
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => {
            log::warn!(
                "systools_uninstall_history_read_failed path={} error={error}",
                path.display()
            );
            Vec::new()
        }
    }
}

fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| "history path has no file name".to_string())?;
    let temporary = path.with_file_name(format!("{file_name}.tmp-{}", std::process::id()));
    std::fs::write(&temporary, bytes)
        .map_err(|error| format!("history temporary write failed: {error}"))?;
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("history replace failed: {error}"));
    }
    Ok(())
}

/// Millisecond-precision UTC timestamp used by history records.
pub(crate) fn timestamp_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(index: usize) -> Value {
        serde_json::json!({ "id": format!("record-{index}") })
    }

    #[test]
    fn history_is_capped_at_two_hundred_records() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(HISTORY_FILE);
        for index in 0..(MAX_RECORDS + 5) {
            append_to(&path, &record(index)).unwrap();
        }
        let stored: Vec<Value> =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(stored.len(), MAX_RECORDS);
        assert_eq!(stored.first(), Some(&record(5)));
        assert_eq!(stored.last(), Some(&record(MAX_RECORDS + 4)));
        assert!(!directory
            .path()
            .join(format!("{HISTORY_FILE}.tmp-{}", std::process::id()))
            .exists());
    }

    #[test]
    fn a_corrupt_history_is_replaced_not_propagated() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(HISTORY_FILE);
        std::fs::write(&path, b"not json").unwrap();
        append_to(&path, &record(1)).unwrap();
        let stored: Vec<Value> =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(stored, vec![record(1)]);
    }

    #[test]
    fn timestamps_are_utc_rfc3339() {
        let timestamp = timestamp_rfc3339();
        assert!(timestamp.ends_with('Z'));
        assert!(timestamp.contains('T'));
    }
}
