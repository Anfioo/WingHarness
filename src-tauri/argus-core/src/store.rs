//! Persistence for `<data dir>/argus/settings.json`.
//!
//! Every write stages the document as `settings.json.tmp`, flushes it, and then
//! renames it over the target, so a crash cannot leave a half-written settings
//! file behind. A file that cannot be parsed is moved aside as
//! `settings.json.bak-<unix seconds>` and the caller gets the defaults, so the
//! page starts clean instead of overwriting whatever the user had.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{ArgusError, ArgusResult};
use crate::models::{ArgusSettings, DEFAULT_INTERVAL_MS};
use crate::paths;

const SETTINGS_FILE: &str = "settings.json";
const SETTINGS_VERSION: u32 = 1;

/// Serialises the staged write, so two saves cannot interleave in the same
/// `settings.json.tmp`.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// The on-disk document. `version` is written for future migrations and
/// ignored when reading: only version 1 exists today.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct StoredSettings {
    version: u32,
    interval_ms: u64,
}

impl Default for StoredSettings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            interval_ms: DEFAULT_INTERVAL_MS,
        }
    }
}

impl From<&ArgusSettings> for StoredSettings {
    fn from(settings: &ArgusSettings) -> Self {
        Self {
            version: SETTINGS_VERSION,
            interval_ms: settings.interval_ms,
        }
    }
}

impl From<StoredSettings> for ArgusSettings {
    fn from(stored: StoredSettings) -> Self {
        Self {
            interval_ms: stored.interval_ms,
        }
        .clamped()
    }
}

pub fn defaults() -> ArgusSettings {
    ArgusSettings::default()
}

/// Read the settings, falling back to the defaults when the file is missing or
/// unusable. A missing file is never written back.
pub fn load() -> ArgusResult<ArgusSettings> {
    load_at(paths::dir()?)
}

/// Validate and persist the whole settings document, returning the normalized
/// copy that was written.
pub fn save(settings: ArgusSettings) -> ArgusResult<ArgusSettings> {
    let directory = paths::ensure_dir()?;
    save_at(&directory, settings.clamped())
}

fn settings_file(directory: &Path) -> PathBuf {
    directory.join(SETTINGS_FILE)
}

fn temp_file(directory: &Path) -> PathBuf {
    directory.join(format!("{SETTINGS_FILE}.tmp"))
}

fn load_at(directory: &Path) -> ArgusResult<ArgusSettings> {
    let path = settings_file(directory);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(defaults()),
        Err(error) => {
            log::warn!(
                "argus_settings_read_failed path={} error={error}",
                path.display()
            );
            return Err(ArgusError::internal("The settings file could not be read."));
        }
    };
    match serde_json::from_str::<StoredSettings>(&raw) {
        Ok(stored) => Ok(stored.into()),
        Err(error) => {
            log::warn!(
                "argus_settings_parse_failed path={} error={error}",
                path.display()
            );
            backup_corrupt(directory, &path);
            Ok(defaults())
        }
    }
}

fn save_at(directory: &Path, settings: ArgusSettings) -> ArgusResult<ArgusSettings> {
    let _guard = WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    std::fs::create_dir_all(directory).map_err(|error| {
        log::warn!(
            "argus_settings_dir_create_failed path={} error={error}",
            directory.display()
        );
        ArgusError::internal("The task manager data directory could not be created.")
    })?;

    let document = StoredSettings::from(&settings);
    let data = serde_json::to_vec_pretty(&document)
        .map_err(|error| ArgusError::internal(format!("Could not encode settings: {error}")))?;
    let path = settings_file(directory);
    let temp = temp_file(directory);
    {
        let mut file = std::fs::File::create(&temp).map_err(|error| {
            log::warn!(
                "argus_settings_temp_create_failed path={} error={error}",
                temp.display()
            );
            ArgusError::internal("The settings file could not be written.")
        })?;
        file.write_all(&data)
            .and_then(|()| file.sync_all())
            .map_err(|error| {
                log::warn!(
                    "argus_settings_write_failed path={} error={error}",
                    temp.display()
                );
                ArgusError::internal("The settings file could not be written.")
            })?;
    }
    std::fs::rename(&temp, &path).map_err(|error| {
        log::warn!(
            "argus_settings_rename_failed from={} to={} error={error}",
            temp.display(),
            path.display()
        );
        ArgusError::internal("The settings file could not be saved.")
    })?;
    Ok(settings)
}

/// Move a file that failed to parse out of the way, so the next save starts
/// from a clean document. A failed backup is logged and otherwise ignored.
fn backup_corrupt(directory: &Path, path: &Path) {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let backup = directory.join(format!("{SETTINGS_FILE}.bak-{seconds}"));
    if let Err(error) = std::fs::rename(path, &backup) {
        log::warn!(
            "argus_settings_backup_failed from={} to={} error={error}",
            path.display(),
            backup.display()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("argus-store-{tag}-{nanos}"))
    }

    #[test]
    fn missing_file_returns_defaults() {
        let directory = temp_dir("missing");
        assert_eq!(load_at(&directory).unwrap(), ArgusSettings::default());
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn settings_round_trip_and_leave_no_temp_file() {
        let directory = temp_dir("roundtrip");
        let saved = save_at(&directory, ArgusSettings::with_interval_ms(1500)).unwrap();
        assert_eq!(saved.interval_ms, 1500);
        assert_eq!(load_at(&directory).unwrap().interval_ms, 1500);
        assert!(!temp_file(&directory).exists());
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn corrupt_file_is_backed_up_and_defaults_return() {
        let directory = temp_dir("corrupt");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(settings_file(&directory), b"{ not json").unwrap();
        assert_eq!(load_at(&directory).unwrap(), ArgusSettings::default());
        let backups: Vec<_> = std::fs::read_dir(&directory)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("settings.json.bak-")
            })
            .collect();
        assert_eq!(backups.len(), 1);
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn out_of_range_value_is_clamped_when_read() {
        let directory = temp_dir("clamp");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(settings_file(&directory), br#"{ "version": 1, "intervalMs": 99 }"#)
            .unwrap();
        assert_eq!(
            load_at(&directory).unwrap().interval_ms,
            crate::models::MIN_INTERVAL_MS
        );
        let _ = std::fs::remove_dir_all(&directory);
    }
}
