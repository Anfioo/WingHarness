// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

//! Action history at `<data dir>/mise/history.json`.
//!
//! The document is `{ "version": 1, "entries": [...] }`, newest first and
//! capped at [MAX_ENTRIES]. One entry's output is capped at 16 KiB per stream
//! and carries the first three non-empty lines as a snippet for the list view.
//! Writes go through [`crate::paths::atomic_write`], and an unreadable document
//! is moved aside as `history.json.bak-<unix seconds>` so the page starts clean.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{MiseError, MiseResult};
use crate::models::{MiseHealthLevel, MiseHistoryEntry, MiseHistoryStatus};
use crate::paths;

const HISTORY_FILE: &str = "history.json";
const HISTORY_VERSION: u32 = 1;
const MAX_ENTRIES: usize = 100;
const OUTPUT_LIMIT_BYTES: usize = 16 * 1024;
const SNIPPET_LINES: usize = 3;

static ENTRY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Serialises the read-modify-write, so two appends cannot drop each other's
/// entry. The lock covers file IO only; no child process runs under it.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// The on-disk document. `version` is written for future migrations and ignored
/// on read; only version 1 exists today.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryDocument {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default, deserialize_with = "entries_or_empty")]
    entries: Vec<MiseHistoryEntry>,
}

fn default_version() -> u32 {
    HISTORY_VERSION
}

/// A hand-edited or truncated `entries` value must not hide the rest of the
/// document; it degrades to an empty list instead.
fn entries_or_empty<'de, D>(deserializer: D) -> Result<Vec<MiseHistoryEntry>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

/// The newest `limit` entries, newest first. A missing file is an empty list.
pub fn list(limit: usize) -> MiseResult<Vec<MiseHistoryEntry>> {
    list_at(paths::dir()?, limit)
}

/// Append one finished action, trimming the file to the newest entries.
pub fn append(entry: MiseHistoryEntry) -> MiseResult<()> {
    let directory = paths::ensure_dir()?;
    append_at(&directory, entry)
}

/// Record an action the user cancelled before it produced a result.
pub fn record_canceled(command: &str) -> MiseResult<MiseHistoryEntry> {
    let entry = new_entry(
        command,
        "Canceled from the confirmation dialog.",
        MiseHealthLevel::Info,
        MiseHistoryStatus::Canceled,
    );
    append(entry.clone())?;
    Ok(entry)
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

fn list_at(directory: &Path, limit: usize) -> MiseResult<Vec<MiseHistoryEntry>> {
    let mut entries = read_entries(directory)?;
    entries.truncate(limit);
    Ok(entries)
}

fn append_at(directory: &Path, entry: MiseHistoryEntry) -> MiseResult<()> {
    let _guard = WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let mut entries = read_entries(directory)?;
    entries.insert(0, sanitize_entry(entry));
    entries.truncate(MAX_ENTRIES);

    let document = HistoryDocument {
        version: HISTORY_VERSION,
        entries,
    };
    let bytes = serde_json::to_vec_pretty(&document).map_err(|error| {
        log::warn!("mise_history_encode_failed error={error}");
        MiseError::internal("The mise history could not be encoded.")
    })?;

    paths::atomic_write(&directory.join(HISTORY_FILE), &bytes)
        .map_err(|_| MiseError::io("The mise history could not be written."))
}

fn read_entries(directory: &Path) -> MiseResult<Vec<MiseHistoryEntry>> {
    let path = directory.join(HISTORY_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            log::warn!(
                "mise_history_read_failed path={} error={error}",
                path.display()
            );
            return Err(MiseError::io("The mise history could not be read."));
        }
    };

    match serde_json::from_slice::<HistoryDocument>(&bytes) {
        Ok(document) => Ok(document.entries),
        Err(error) => {
            log::warn!(
                "mise_history_parse_failed path={} error={error}",
                path.display()
            );
            backup(&path);
            Ok(Vec::new())
        }
    }
}

/// Move a document that cannot be parsed out of the way, keeping its bytes for
/// support instead of deleting the user's data.
fn backup(path: &Path) {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default();
    let target = path.with_file_name(format!("{HISTORY_FILE}.bak-{stamp}"));
    if let Err(error) = std::fs::rename(path, &target) {
        log::warn!(
            "mise_history_backup_failed from={} to={} error={error}",
            path.display(),
            target.display()
        );
    }
}

/// Cap the two streams and fill the snippets the caller left empty.
fn sanitize_entry(mut entry: MiseHistoryEntry) -> MiseHistoryEntry {
    entry.stdout = entry.stdout.map(truncate_output);
    entry.stderr = entry.stderr.map(truncate_output);

    if entry.stdout_snippet.is_none() {
        entry.stdout_snippet = entry.stdout.as_deref().and_then(output_snippet);
    }
    if entry.stderr_snippet.is_none() {
        entry.stderr_snippet = entry.stderr.as_deref().and_then(output_snippet);
    }

    entry
}

/// Cut at [OUTPUT_LIMIT_BYTES] without splitting a character.
fn truncate_output(value: String) -> String {
    if value.len() <= OUTPUT_LIMIT_BYTES {
        return value;
    }

    let mut end = OUTPUT_LIMIT_BYTES;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

/// The first [SNIPPET_LINES] lines of the trimmed output, or nothing when the
/// output is blank.
fn output_snippet(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    Some(
        trimmed
            .lines()
            .take(SNIPPET_LINES)
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SCRATCH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(label: &str) -> Self {
            let sequence = SCRATCH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or_default();
            let path =
                std::env::temp_dir().join(format!("mise-history-test-{label}-{stamp}-{sequence}"));
            std::fs::create_dir_all(&path).expect("failed to create scratch directory");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn file_names(&self) -> Vec<String> {
            let mut names: Vec<String> = std::fs::read_dir(&self.0)
                .expect("failed to read scratch directory")
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn entry(command: &str) -> MiseHistoryEntry {
        new_entry(
            command,
            "Completed from the Environment page.",
            MiseHealthLevel::Healthy,
            MiseHistoryStatus::Success,
        )
    }

    #[test]
    fn a_missing_file_is_an_empty_list() {
        let scratch = Scratch::new("missing");
        assert!(list_at(scratch.path(), 100).unwrap().is_empty());
        assert!(!scratch.path().join(HISTORY_FILE).exists());
    }

    #[test]
    fn append_then_list_round_trips_the_entry() {
        let scratch = Scratch::new("round-trip");
        let mut first = entry("mise install node@22.11.0");
        first.stdout = Some("installed".to_string());
        first.exit_code = Some(0);
        first.duration_ms = Some(8421);
        append_at(scratch.path(), first.clone()).unwrap();

        let entries = list_at(scratch.path(), 100).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, first.id);
        assert_eq!(entries[0].command, first.command);
        assert_eq!(entries[0].stdout.as_deref(), Some("installed"));
        assert_eq!(entries[0].exit_code, Some(0));
        assert_eq!(entries[0].duration_ms, Some(8421));
    }

    #[test]
    fn the_newest_entry_comes_first() {
        let scratch = Scratch::new("order");
        append_at(scratch.path(), entry("mise install node")).unwrap();
        append_at(scratch.path(), entry("mise use --global node")).unwrap();

        let entries = list_at(scratch.path(), 100).unwrap();
        assert_eq!(entries[0].command, "mise use --global node");
        assert_eq!(entries[1].command, "mise install node");
    }

    #[test]
    fn the_list_is_truncated_to_the_requested_limit() {
        let scratch = Scratch::new("limit");
        for index in 0..5 {
            append_at(scratch.path(), entry(&format!("mise install {index}"))).unwrap();
        }

        let entries = list_at(scratch.path(), 2).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].command, "mise install 4");
    }

    #[test]
    fn more_than_one_hundred_entries_are_trimmed() {
        let scratch = Scratch::new("cap");
        for index in 0..105 {
            append_at(scratch.path(), entry(&format!("mise install {index}"))).unwrap();
        }

        let entries = list_at(scratch.path(), 1000).unwrap();
        assert_eq!(entries.len(), MAX_ENTRIES);
        assert_eq!(entries[0].command, "mise install 104");
        assert_eq!(
            entries[MAX_ENTRIES - 1].command,
            format!("mise install {}", 105 - MAX_ENTRIES)
        );
    }

    #[test]
    fn long_output_is_capped_at_sixteen_kibibytes() {
        let scratch = Scratch::new("truncate");
        let mut long = entry("mise install");
        long.stdout = Some("a".repeat(OUTPUT_LIMIT_BYTES + 1024));
        append_at(scratch.path(), long).unwrap();

        let entries = list_at(scratch.path(), 1).unwrap();
        let stdout = entries[0].stdout.as_deref().unwrap();
        assert_eq!(stdout.len(), OUTPUT_LIMIT_BYTES);
    }

    #[test]
    fn truncation_does_not_split_a_character() {
        let scratch = Scratch::new("truncate-char");
        let mut long = entry("mise install");
        // Place a three-byte character across the limit.
        let mut stdout = "a".repeat(OUTPUT_LIMIT_BYTES - 1);
        stdout.push('版');
        stdout.push_str(&"b".repeat(64));
        long.stdout = Some(stdout);
        append_at(scratch.path(), long).unwrap();

        let entries = list_at(scratch.path(), 1).unwrap();
        let stdout = entries[0].stdout.as_deref().unwrap();
        assert_eq!(stdout.len(), OUTPUT_LIMIT_BYTES - 1);
        assert!(stdout.is_char_boundary(stdout.len()));
    }

    #[test]
    fn snippets_take_the_first_three_lines_of_the_trimmed_output() {
        let mut value = entry("mise doctor");
        value.stdout = Some("\nfirst\nsecond\n\nthird\nfourth\n".to_string());
        let sanitized = sanitize_entry(value);
        assert_eq!(sanitized.stdout_snippet.as_deref(), Some("first\nsecond\n"));
    }

    #[test]
    fn an_explicit_snippet_is_not_overwritten() {
        let mut value = entry("mise doctor");
        value.stdout = Some("first\nsecond".to_string());
        value.stdout_snippet = Some("chosen by the caller".to_string());
        let sanitized = sanitize_entry(value);
        assert_eq!(
            sanitized.stdout_snippet.as_deref(),
            Some("chosen by the caller")
        );
    }

    #[test]
    fn blank_output_has_no_snippet() {
        let mut value = entry("mise doctor");
        value.stdout = Some("   \n".to_string());
        let sanitized = sanitize_entry(value);
        assert_eq!(sanitized.stdout_snippet, None);
    }

    #[test]
    fn a_corrupt_file_is_moved_aside_and_the_list_is_empty() {
        let scratch = Scratch::new("corrupt");
        std::fs::write(scratch.path().join(HISTORY_FILE), b"{not json").unwrap();

        assert!(list_at(scratch.path(), 100).unwrap().is_empty());
        assert!(!scratch.path().join(HISTORY_FILE).exists());
        let backups = scratch
            .file_names()
            .into_iter()
            .filter(|name| name.starts_with("history.json.bak-"))
            .count();
        assert_eq!(backups, 1);
    }

    #[test]
    fn an_unusable_entries_value_degrades_to_an_empty_list() {
        let scratch = Scratch::new("bad-entries");
        std::fs::write(
            scratch.path().join(HISTORY_FILE),
            br#"{"version": 1, "entries": "not a list"}"#,
        )
        .unwrap();

        assert!(list_at(scratch.path(), 100).unwrap().is_empty());
    }

    #[test]
    fn a_document_without_entries_is_an_empty_list() {
        let scratch = Scratch::new("no-entries");
        std::fs::write(scratch.path().join(HISTORY_FILE), br#"{"version": 1}"#).unwrap();

        assert!(list_at(scratch.path(), 100).unwrap().is_empty());
    }

    #[test]
    fn a_write_leaves_no_temporary_file() {
        let scratch = Scratch::new("no-temp");
        append_at(scratch.path(), entry("mise install node")).unwrap();

        assert_eq!(scratch.file_names(), vec!["history.json".to_string()]);
    }
}
