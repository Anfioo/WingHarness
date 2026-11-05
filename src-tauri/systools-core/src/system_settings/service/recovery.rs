//! Durable recovery ledger for system-settings changes.
//!
//! The document is written before the first native mutation and records only
//! typed setting identifiers and exact values. It never stores a registry path,
//! a service name, or a command line, so the file stays meaningful across
//! releases and cannot be replayed as an arbitrary native instruction.

use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::{
    shared::{CoreError, CoreResult},
    system_settings::platform::{PlatformSystemSettingSnapshot, PlatformSystemSettingValue},
};

pub(super) const MAX_RECOVERY_ITEMS: usize = 1024;
pub(super) const RECOVERY_SCHEMA_VERSION: u32 = 2;
const MIN_SUPPORTED_RECOVERY_SCHEMA_VERSION: u32 = 1;
const RECOVERY_MAX_BYTES: u64 = 1024 * 1024;
const RECOVERY_MAX_TEXT_BYTES: usize = 1024;
const SETTING_ID_PREFIX: &str = "windows.";
pub(super) const RECOVERY_FILE_NAME: &str = "system-settings-recovery.json";
pub(super) const INVALID_RECOVERY_FILE_NAME: &str = "system-settings-recovery.invalid.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RecoveryDocument {
    pub(super) schema_version: u32,
    pub(super) recovery_id: String,
    pub(super) created_at_ms: u64,
    pub(super) items: Vec<RecoveryItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RecoveryItem {
    pub(super) setting_id: String,
    pub(super) original_value: PlatformSystemSettingValue,
    pub(super) optimized_value: PlatformSystemSettingValue,
}

/// Resolves the ledger inside the single systools data directory.
fn recovery_path() -> CoreResult<PathBuf> {
    crate::paths::dir()
        .map(|directory| directory.join(RECOVERY_FILE_NAME))
        .map_err(|_| CoreError::persistence("systools data directory is unavailable"))
}

pub(super) fn recovery_exists() -> bool {
    recovery_path().is_ok_and(|path| path.is_file())
}

pub(super) fn save_recovery(
    recovery_id: &str,
    items: Vec<RecoveryItem>,
    operation_id: u64,
) -> CoreResult<()> {
    save_recovery_at(&recovery_path()?, recovery_id, items, operation_id)
}

pub(super) fn load_recovery() -> CoreResult<Option<RecoveryDocument>> {
    load_recovery_at(&recovery_path()?)
}

pub(super) fn remove_recovery() -> CoreResult<()> {
    remove_recovery_at(&recovery_path()?)
}

/// Writes the ledger to an explicit path so tests can round-trip it through a
/// temporary directory without touching the live one.
pub(super) fn save_recovery_at(
    path: &Path,
    recovery_id: &str,
    items: Vec<RecoveryItem>,
    operation_id: u64,
) -> CoreResult<()> {
    if items.len() > MAX_RECOVERY_ITEMS {
        log::error!(
            "system_settings_recovery_save_rejected operation_id={} item_count={} max_item_count={}",
            operation_id,
            items.len(),
            MAX_RECOVERY_ITEMS
        );
        return Err(CoreError::persistence(
            "system settings recovery record exceeds its item limit",
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| CoreError::persistence("recovery path has no parent"))?;
    fs::create_dir_all(parent).map_err(|error| {
        CoreError::persistence(format!("failed to create recovery directory: {error}"))
    })?;
    let document = RecoveryDocument {
        schema_version: RECOVERY_SCHEMA_VERSION,
        recovery_id: recovery_id.to_string(),
        created_at_ms: super::unix_time_ms(),
        items,
    };
    let content = serde_json::to_vec_pretty(&document).map_err(|error| {
        CoreError::persistence(format!("failed to serialize recovery record: {error}"))
    })?;
    write_atomic(path, &content)?;
    log::info!(
        "system_settings_recovery_saved operation_id={} schema_version={} item_count={}",
        operation_id,
        RECOVERY_SCHEMA_VERSION,
        document.items.len()
    );
    Ok(())
}

fn write_atomic(path: &Path, content: &[u8]) -> CoreResult<()> {
    let temporary = path.with_extension("json.tmp");
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&temporary)
        .map_err(|error| {
            CoreError::persistence(format!(
                "failed to create system settings recovery temporary file: {error}"
            ))
        })?;
    file.write_all(content)
        .and_then(|_| file.sync_all())
        .map_err(|error| {
            CoreError::persistence(format!(
                "failed to write system settings recovery temporary file: {error}"
            ))
        })?;
    replace_file(&temporary, path).map_err(|error| {
        CoreError::persistence(format!("failed to save system settings recovery: {error}"))
    })
}

/// Replaces the target atomically.
///
/// `fs::rename` on Windows refuses to overwrite, so the durable document is
/// staged and then moved with `MoveFileExW` using replace-existing and
/// write-through semantics. Other platforms fall back to the standard rename.
#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let succeeded = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if succeeded == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(source, target)
}

/// Loads and validates the ledger from an explicit path.
pub(super) fn load_recovery_at(path: &Path) -> CoreResult<Option<RecoveryDocument>> {
    if !path.exists() {
        return Ok(None);
    }
    let metadata = fs::metadata(path).map_err(|error| {
        CoreError::persistence(format!("failed to inspect recovery record: {error}"))
    })?;
    if metadata.len() > RECOVERY_MAX_BYTES {
        log::warn!(
            "system_settings_recovery_quarantined reason=oversized byte_count={}",
            metadata.len()
        );
        quarantine_invalid_recovery(path)?;
        return Ok(None);
    }
    let content = fs::read(path).map_err(|error| {
        CoreError::persistence(format!("failed to read recovery record: {error}"))
    })?;
    let document = match serde_json::from_slice::<RecoveryDocument>(&content) {
        Ok(document) => document,
        Err(error) => {
            log::warn!(
                "system_settings_recovery_quarantined reason=invalid_format error={}",
                error
            );
            quarantine_invalid_recovery(path)?;
            return Ok(None);
        }
    };
    let unique_ids = document
        .items
        .iter()
        .map(|item| item.setting_id.as_str())
        .collect::<BTreeSet<_>>();
    let invalid_item = document.items.iter().any(|item| {
        !valid_setting_id(&item.setting_id)
            || recovery_value_is_too_large(&item.original_value)
            || recovery_value_is_too_large(&item.optimized_value)
    });
    if !(MIN_SUPPORTED_RECOVERY_SCHEMA_VERSION..=RECOVERY_SCHEMA_VERSION)
        .contains(&document.schema_version)
        || document.items.len() > MAX_RECOVERY_ITEMS
        || unique_ids.len() != document.items.len()
        || invalid_item
    {
        log::warn!(
            "system_settings_recovery_quarantined reason=unsupported_schema schema_version={} item_count={}",
            document.schema_version,
            document.items.len()
        );
        quarantine_invalid_recovery(path)?;
        return Ok(None);
    }
    Ok(Some(document))
}

/// Setting identifiers come from the compiled catalog, so the ledger rejects
/// anything that is not a plain catalog identifier.
fn valid_setting_id(setting_id: &str) -> bool {
    !setting_id.is_empty()
        && setting_id.len() <= 128
        && setting_id.starts_with(SETTING_ID_PREFIX)
        && setting_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

fn recovery_value_is_too_large(value: &PlatformSystemSettingValue) -> bool {
    match value {
        PlatformSystemSettingValue::Text(value)
        | PlatformSystemSettingValue::Snapshot(PlatformSystemSettingSnapshot::Text(value)) => {
            value.len() > RECOVERY_MAX_TEXT_BYTES
        }
        PlatformSystemSettingValue::Snapshot(PlatformSystemSettingSnapshot::IntegerMap(values)) => {
            values.len() > MAX_RECOVERY_ITEMS
                || values.iter().any(|(key, value)| {
                    key.is_empty()
                        || key.len() > 256
                        || value.is_some_and(|value| !(0..=i64::from(u32::MAX)).contains(&value))
                })
        }
        _ => false,
    }
}

pub(super) fn quarantine_invalid_recovery(path: &Path) -> CoreResult<()> {
    let quarantine = path.with_file_name(INVALID_RECOVERY_FILE_NAME);
    replace_file(path, &quarantine).map_err(|error| {
        CoreError::persistence(format!(
            "failed to quarantine unsupported system settings recovery: {error}"
        ))
    })
}

pub(super) fn remove_recovery_at(path: &Path) -> CoreResult<()> {
    if path.exists() {
        fs::remove_file(path).map_err(|error| {
            CoreError::persistence(format!("failed to remove recovery record: {error}"))
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(setting_id: &str, original: i64, optimized: i64) -> RecoveryItem {
        RecoveryItem {
            setting_id: setting_id.to_string(),
            original_value: PlatformSystemSettingValue::Integer(original),
            optimized_value: PlatformSystemSettingValue::Integer(optimized),
        }
    }

    #[test]
    fn recovery_round_trips_through_a_temporary_directory() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(RECOVERY_FILE_NAME);
        save_recovery_at(
            &path,
            "plan-1",
            vec![
                item("windows.explorer.animations", 0, 1),
                item("windows.system.telemetry", 1, 0),
            ],
            7,
        )
        .unwrap();

        let document = load_recovery_at(&path).unwrap().expect("document should load");
        assert_eq!(document.schema_version, RECOVERY_SCHEMA_VERSION);
        assert_eq!(document.recovery_id, "plan-1");
        assert_eq!(document.items.len(), 2);
        assert_eq!(
            document.items[0].original_value,
            PlatformSystemSettingValue::Integer(0)
        );

        remove_recovery_at(&path).unwrap();
        assert!(load_recovery_at(&path).unwrap().is_none());
    }

    #[test]
    fn recovery_rejects_identifiers_outside_the_catalog_namespace() {
        assert!(valid_setting_id("windows.explorer.animations"));
        assert!(!valid_setting_id("HKLM\\Software\\Microsoft"));
        assert!(!valid_setting_id("windows.explorer.animations\\..\\evil"));
        assert!(!valid_setting_id(""));
        assert!(!valid_setting_id("macos.finder.show-path-bar"));
    }

    #[test]
    fn corrupt_recovery_is_quarantined_and_treated_as_absent() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(RECOVERY_FILE_NAME);
        fs::write(&path, b"{not json").unwrap();

        assert!(load_recovery_at(&path).unwrap().is_none());
        assert!(!path.exists());
        assert!(directory.path().join(INVALID_RECOVERY_FILE_NAME).is_file());
    }

    #[test]
    fn oversized_values_are_rejected_on_load() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(RECOVERY_FILE_NAME);
        let document = RecoveryDocument {
            schema_version: RECOVERY_SCHEMA_VERSION,
            recovery_id: "plan-2".to_string(),
            created_at_ms: 1,
            items: vec![RecoveryItem {
                setting_id: "windows.explorer.animations".to_string(),
                original_value: PlatformSystemSettingValue::Text("x".repeat(RECOVERY_MAX_TEXT_BYTES + 1)),
                optimized_value: PlatformSystemSettingValue::Integer(1),
            }],
        };
        fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();

        assert!(load_recovery_at(&path).unwrap().is_none());
        assert!(!path.exists());
    }
}
