//! Rolling log files: one file per UTC day under `logs/<profileId>/`, split when
//! it grows past the configured size, pruned by age and count.
//!
//! Writing is best effort. A failed append is recorded with `log::warn` and
//! never affects the running process.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{DateTime, TimeZone, Utc};

use crate::models::{FrpPrefs, LogEntry, LogLevel, LogStream};

const FILE_PREFIX: &str = "frpc.";
const FILE_SUFFIX: &str = ".log";

/// Append one line to the profile's active log file.
pub fn append_line(entry: &LogEntry, prefs: &FrpPrefs) {
    let Ok(directory) = crate::paths::log_dir(&entry.profile_id) else {
        log::warn!("frp_log_dir_unavailable profile={}", entry.profile_id);
        return;
    };
    if let Err(error) = append_in(&directory, entry, prefs) {
        log::warn!(
            "frp_log_append_failed profile={} error={error}",
            entry.profile_id
        );
    }
}

/// Delete rolled files beyond the retention window or the per-profile count.
/// Returns the number of bytes reclaimed.
pub fn prune(profile_id: Option<&str>, prefs: &FrpPrefs) -> u64 {
    match profile_id {
        Some(profile_id) => {
            let Ok(directory) = crate::paths::log_dir(profile_id) else {
                return 0;
            };
            prune_dir(&directory, prefs)
        }
        None => {
            let Ok(root) = crate::paths::logs_dir() else {
                return 0;
            };
            let Ok(entries) = fs::read_dir(&root) else {
                return 0;
            };
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.is_dir())
                .map(|directory| prune_dir(&directory, prefs))
                .sum()
        }
    }
}

fn append_in(directory: &Path, entry: &LogEntry, prefs: &FrpPrefs) -> std::io::Result<()> {
    fs::create_dir_all(directory)?;
    let active = active_log_path(directory, entry.timestamp);

    if rotate_if_needed(directory, &active, prefs) {
        prune_dir(directory, prefs);
    }

    let mut file = OpenOptions::new().create(true).append(true).open(&active)?;
    file.write_all(format_line(entry).as_bytes())?;
    file.flush()
}

fn active_log_path(directory: &Path, timestamp_ms: i64) -> PathBuf {
    directory.join(format!("{FILE_PREFIX}{}{FILE_SUFFIX}", day_key(timestamp_ms)))
}

/// Rename the active file to `frpc.<day>.part.<stamp>.log` once it reaches the
/// size limit, and start a fresh one.
fn rotate_if_needed(directory: &Path, active: &Path, prefs: &FrpPrefs) -> bool {
    let Ok(metadata) = fs::metadata(active) else {
        return false;
    };
    let max_bytes = u64::from(prefs.log_max_file_size_mb.max(1)) * 1024 * 1024;
    if metadata.len() < max_bytes {
        return false;
    }

    let now = Utc::now();
    let rotated = directory.join(format!(
        "{FILE_PREFIX}{}.part.{}{FILE_SUFFIX}",
        now.format("%Y%m%d"),
        now.format("%Y%m%d%H%M%S"),
    ));
    let _ = fs::rename(active, rotated);
    let _ = File::create(active);
    true
}

fn prune_dir(directory: &Path, prefs: &FrpPrefs) -> u64 {
    let Ok(entries) = fs::read_dir(directory) else {
        return 0;
    };
    let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !is_log_file(&path) {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            Some((path, metadata.len(), metadata.modified().ok()?))
        })
        .collect();

    files.sort_by(|left, right| right.2.cmp(&left.2).then_with(|| right.0.cmp(&left.0)));

    let keep = prefs.log_max_files_per_profile.max(1) as usize;
    let retention = chrono::Duration::days(i64::from(prefs.log_retention_days.max(1)));
    let cutoff = Utc::now() - retention;

    let mut removed = 0u64;
    for (index, (path, size, modified)) in files.into_iter().enumerate() {
        let too_old = DateTime::<Utc>::from(modified) < cutoff;
        if index >= keep || too_old {
            if fs::remove_file(&path).is_ok() {
                removed = removed.saturating_add(size);
            }
        }
    }
    removed
}

fn is_log_file(path: &Path) -> bool {
    path.is_file()
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(FILE_PREFIX) && name.ends_with(FILE_SUFFIX))
}

fn day_key(timestamp_ms: i64) -> String {
    Utc.timestamp_millis_opt(timestamp_ms)
        .single()
        .unwrap_or_else(Utc::now)
        .format("%Y%m%d")
        .to_string()
}

fn format_line(entry: &LogEntry) -> String {
    let stamp = Utc
        .timestamp_millis_opt(entry.timestamp)
        .single()
        .unwrap_or_else(Utc::now)
        .format("%Y-%m-%d %H:%M:%S%.3f");
    format!(
        "{stamp} [{}] [{}] {}\n",
        stream_label(entry.stream),
        level_label(entry.level),
        entry.message
    )
}

fn stream_label(stream: LogStream) -> &'static str {
    match stream {
        LogStream::Stdout => "stdout",
        LogStream::Stderr => "stderr",
    }
}

fn level_label(level: LogLevel) -> &'static str {
    match level {
        LogLevel::Trace => "trace",
        LogLevel::Debug => "debug",
        LogLevel::Info => "info",
        LogLevel::Warn => "warn",
        LogLevel::Error => "error",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_dir(tag: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "frp-core-logs-{tag}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn prefs(max_size_mb: u32, max_files: u32, retention_days: u32) -> FrpPrefs {
        FrpPrefs {
            log_max_file_size_mb: max_size_mb,
            log_max_files_per_profile: max_files,
            log_retention_days: retention_days,
            ..FrpPrefs::default()
        }
    }

    fn entry(profile_id: &str, timestamp: i64, message: &str) -> LogEntry {
        LogEntry {
            profile_id: profile_id.to_string(),
            stream: LogStream::Stdout,
            level: LogLevel::Info,
            message: message.to_string(),
            timestamp,
        }
    }

    fn file_names(directory: &Path) -> Vec<String> {
        fs::read_dir(directory)
            .expect("read log dir")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn writes_a_line_into_the_daily_file() {
        let directory = temp_dir("append");
        append_in(&directory, &entry("p1", 1_762_300_000_000, "hello"), &prefs(20, 5, 7))
            .expect("append");

        let files = file_names(&directory);
        assert_eq!(files.len(), 1, "{files:?}");
        assert!(files[0].starts_with("frpc.") && files[0].ends_with(".log"));

        let content = fs::read_to_string(directory.join(&files[0])).expect("read log");
        assert!(content.contains("[stdout] [info] hello"), "{content}");
    }

    #[test]
    fn rotates_when_the_active_file_reaches_the_limit() {
        let directory = temp_dir("rotate");
        let timestamp = 1_762_300_000_000;
        let active = active_log_path(&directory, timestamp);
        fs::write(&active, vec![b'x'; 1024 * 1024 + 16]).expect("seed big file");

        append_in(&directory, &entry("p1", timestamp, "after rotate"), &prefs(1, 5, 7))
            .expect("append");

        let files = file_names(&directory);
        assert!(
            files.iter().any(|name| name.contains(".part.")),
            "rotated copy missing: {files:?}"
        );
        let current = fs::read_to_string(&active).expect("read active");
        assert!(current.contains("after rotate"), "{current}");
    }

    #[test]
    fn prunes_down_to_the_file_limit() {
        let directory = temp_dir("prune");
        for index in 0..5 {
            fs::write(
                directory.join(format!("frpc.2026010{index}.log")),
                b"log line",
            )
            .expect("seed log");
        }
        let removed = prune_dir(&directory, &prefs(20, 2, 30));
        assert!(removed > 0);
        assert_eq!(file_names(&directory).len(), 2);
    }

    #[test]
    fn ignores_files_that_are_not_frp_logs() {
        let directory = temp_dir("ignore");
        fs::write(directory.join("notes.txt"), b"keep me").expect("seed");
        fs::write(directory.join("frpc.20260101.log"), b"log").expect("seed");

        prune_dir(&directory, &prefs(20, 1, 30));
        let files = file_names(&directory);
        assert!(files.contains(&"notes.txt".to_string()), "{files:?}");
    }

    #[test]
    fn day_key_uses_utc() {
        assert_eq!(day_key(0), "19700101");
    }
}
