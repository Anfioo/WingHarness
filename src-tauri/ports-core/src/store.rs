// Ported from Porter (https://github.com/t21dev/porter-app), MIT License.
// See ../UPSTREAM.md for the porting record.

//! Persistence for `<data dir>/ports/settings.json`.
//!
//! Every write stages the document as `settings.json.tmp`, flushes it, and then
//! renames it over the target, so a crash cannot leave a half-written settings
//! file behind. A file that cannot be read or parsed is moved aside as
//! `settings.json.bak-<unix seconds>` and the caller gets the defaults, so the
//! page starts clean instead of overwriting whatever the user had.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{PortsError, PortsResult};
use crate::models::{PortGrouping, PortsSettings, DEFAULT_PINNED_PORTS, MAX_PINNED_PORTS};
use crate::paths;

const SETTINGS_FILE: &str = "settings.json";
const SETTINGS_VERSION: u32 = 1;

/// Serialises the staged write, so two saves cannot interleave in the same
/// `settings.json.tmp`.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// The on-disk document. `version` is written for future migrations and ignored
/// when reading: only version 1 exists today.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct StoredSettings {
    version: u32,
    pinned_ports: Vec<u16>,
    pinned_only: bool,
    group_by: PortGrouping,
}

impl Default for StoredSettings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            pinned_ports: Vec::new(),
            pinned_only: false,
            group_by: PortGrouping::Port,
        }
    }
}

impl From<&PortsSettings> for StoredSettings {
    fn from(settings: &PortsSettings) -> Self {
        Self {
            version: SETTINGS_VERSION,
            pinned_ports: settings.pinned_ports.clone(),
            pinned_only: settings.pinned_only,
            group_by: settings.group_by,
        }
    }
}

impl From<StoredSettings> for PortsSettings {
    fn from(stored: StoredSettings) -> Self {
        Self {
            pinned_ports: stored.pinned_ports,
            pinned_only: stored.pinned_only,
            group_by: stored.group_by,
        }
    }
}

/// The settings a fresh install starts with: the five common development ports.
pub fn defaults() -> PortsSettings {
    PortsSettings {
        pinned_ports: DEFAULT_PINNED_PORTS.to_vec(),
        pinned_only: false,
        group_by: PortGrouping::Port,
    }
}

/// Read the settings, falling back to the defaults when the file is missing or
/// unusable. A missing file is never written back.
pub fn load() -> PortsResult<PortsSettings> {
    load_at(&paths::settings_path()?)
}

/// Validate and persist the whole settings document, returning the normalized
/// copy that was written.
pub fn save(settings: PortsSettings) -> PortsResult<PortsSettings> {
    let directory = paths::ensure_dir()?;
    save_at(&directory, settings)
}

fn settings_file(directory: &Path) -> PathBuf {
    directory.join(SETTINGS_FILE)
}

fn temp_file(directory: &Path) -> PathBuf {
    directory.join(format!("{SETTINGS_FILE}.tmp"))
}

/// Validate the settings without touching the disk. Zero and anything above
/// 65535 are rejected, the rest is deduplicated and sorted ascending, and more
/// than [MAX_PINNED_PORTS] entries are refused instead of truncated.
fn normalize(settings: PortsSettings) -> PortsResult<PortsSettings> {
    let ports: Vec<u32> = settings
        .pinned_ports
        .iter()
        .map(|&port| u32::from(port))
        .collect();
    Ok(PortsSettings {
        pinned_ports: normalize_ports(&ports)?,
        pinned_only: settings.pinned_only,
        group_by: settings.group_by,
    })
}

fn normalize_ports(ports: &[u32]) -> PortsResult<Vec<u16>> {
    if let Some(&port) = ports
        .iter()
        .find(|&&port| port == 0 || port > u32::from(u16::MAX))
    {
        return Err(PortsError::invalid_input(
            "pinnedPorts",
            format!("The pinned port {port} is outside the range 1..=65535."),
        ));
    }

    let mut sorted: Vec<u16> = ports.iter().map(|&port| port as u16).collect();
    sorted.sort_unstable();
    sorted.dedup();

    if sorted.len() > MAX_PINNED_PORTS {
        return Err(PortsError::invalid_input(
            "pinnedPorts",
            format!("At most {MAX_PINNED_PORTS} pinned ports are allowed."),
        )
        .with_detail(serde_json::json!({
            "field": "pinnedPorts",
            "max": MAX_PINNED_PORTS,
        })));
    }

    Ok(sorted)
}

fn load_at(directory: &Path) -> PortsResult<PortsSettings> {
    let path = settings_file(directory);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(defaults()),
        Err(error) => {
            log::warn!(
                "ports_store_read_failed path={} error={error}",
                path.display()
            );
            backup(&path);
            return Ok(defaults());
        }
    };

    let stored = match serde_json::from_slice::<StoredSettings>(&bytes) {
        Ok(stored) => stored,
        Err(error) => {
            log::warn!(
                "ports_store_parse_failed path={} error={error}",
                path.display()
            );
            backup(&path);
            return Ok(defaults());
        }
    };

    // A hand-edited file may hold values the app refuses to save; reset it to
    // the defaults rather than surfacing the validation error on every read.
    match normalize(stored.into()) {
        Ok(settings) => Ok(settings),
        Err(error) => {
            log::warn!(
                "ports_store_normalize_failed path={} error={error}",
                path.display()
            );
            backup(&path);
            Ok(defaults())
        }
    }
}

fn save_at(directory: &Path, settings: PortsSettings) -> PortsResult<PortsSettings> {
    let normalized = normalize(settings)?;
    let bytes = serde_json::to_vec_pretty(&StoredSettings::from(&normalized)).map_err(|error| {
        log::warn!("ports_store_encode_failed error={error}");
        PortsError::internal("The ports settings could not be written.")
    })?;

    write_at(directory, &bytes)?;
    Ok(normalized)
}

fn write_at(directory: &Path, bytes: &[u8]) -> PortsResult<()> {
    if let Err(error) = std::fs::create_dir_all(directory) {
        log::warn!(
            "ports_store_dir_create_failed path={} error={error}",
            directory.display()
        );
        return Err(PortsError::internal(
            "The ports data directory could not be created.",
        ));
    }

    let _guard = WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let temp = temp_file(directory);
    let written = (|| -> std::io::Result<()> {
        let mut handle = std::fs::File::create(&temp)?;
        handle.write_all(bytes)?;
        handle.sync_all()
    })();
    if let Err(error) = written {
        log::warn!(
            "ports_store_write_failed path={} error={error}",
            temp.display()
        );
        let _ = std::fs::remove_file(&temp);
        return Err(PortsError::internal(
            "The ports settings could not be written.",
        ));
    }

    if let Err(error) = std::fs::rename(&temp, settings_file(directory)) {
        // Windows refuses the rename while the target is open; the staging copy
        // must not survive the failure.
        log::warn!("ports_store_rename_failed error={error}");
        let _ = std::fs::remove_file(&temp);
        return Err(PortsError::internal(
            "The ports settings could not be written.",
        ));
    }

    Ok(())
}

/// Move a file that cannot be used out of the way, keeping its bytes for
/// support instead of deleting the user's data.
fn backup(path: &Path) {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default();
    let target = path.with_file_name(format!("{SETTINGS_FILE}.bak-{stamp}"));
    if let Err(error) = std::fs::rename(path, &target) {
        log::warn!(
            "ports_store_backup_failed from={} to={} error={error}",
            path.display(),
            target.display()
        );
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::error::PortsErrorCode;

    static SCRATCH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    /// A fresh directory per test: the public `load`/`save` resolve the data
    /// directory through a process-wide `OnceLock`, so the tests drive the
    /// path-taking internals instead and never race each other.
    fn scratch(label: &str) -> PathBuf {
        let sequence = SCRATCH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "ports-core-store-{}-{label}-{sequence}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).expect("scratch directory");
        directory
    }

    fn file_names(directory: &Path) -> Vec<String> {
        std::fs::read_dir(directory)
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect()
    }

    fn settings(pinned_ports: Vec<u16>, pinned_only: bool) -> PortsSettings {
        PortsSettings {
            pinned_ports,
            pinned_only,
            group_by: PortGrouping::Port,
        }
    }

    #[test]
    fn defaults_are_the_five_common_ports() {
        let settings = defaults();
        assert_eq!(settings.pinned_ports, DEFAULT_PINNED_PORTS.to_vec());
        assert!(!settings.pinned_only);
        assert_eq!(settings.group_by, PortGrouping::Port);
    }

    #[test]
    fn first_start_returns_defaults_without_writing() {
        let directory = scratch("first-start");
        assert_eq!(load_at(&directory).expect("load"), defaults());
        assert!(!settings_file(&directory).exists());
        assert!(file_names(&directory).is_empty());
    }

    #[test]
    fn saved_document_matches_the_documented_shape() {
        let directory = scratch("shape");
        save_at(&directory, settings(vec![8080, 3000], true)).expect("save");

        let bytes = std::fs::read(settings_file(&directory)).expect("read settings");
        let value: serde_json::Value = serde_json::from_slice(&bytes).expect("json");
        assert_eq!(value["version"], serde_json::json!(1));
        assert_eq!(value["pinnedPorts"], serde_json::json!([3000, 8080]));
        assert_eq!(value["pinnedOnly"], serde_json::json!(true));
        assert_eq!(value["groupBy"], serde_json::json!("port"));
    }

    #[test]
    fn the_grouping_round_trips_and_defaults_to_port() {
        let directory = scratch("grouping");
        let mut by_app = settings(vec![3000], false);
        by_app.group_by = PortGrouping::App;

        let saved = save_at(&directory, by_app).expect("save");
        assert_eq!(saved.group_by, PortGrouping::App);
        assert_eq!(load_at(&directory).expect("load").group_by, PortGrouping::App);

        // A file written before the field existed keeps working.
        std::fs::write(
            settings_file(&directory),
            br#"{"version":1,"pinnedPorts":[3000],"pinnedOnly":false}"#,
        )
        .expect("write settings");
        assert_eq!(
            load_at(&directory).expect("load").group_by,
            PortGrouping::Port
        );
    }

    #[test]
    fn save_then_load_round_trips_the_normalized_settings() {
        let directory = scratch("round-trip");
        let saved = save_at(&directory, settings(vec![8080, 3000], true)).expect("save");
        assert_eq!(saved.pinned_ports, vec![3000, 8080]);

        assert_eq!(load_at(&directory).expect("load"), saved);
    }

    #[test]
    fn normalize_deduplicates_and_sorts_ascending() {
        let normalized =
            normalize(settings(vec![8080, 3000, 3000, 5173], false)).expect("normalize");
        assert_eq!(normalized.pinned_ports, vec![3000, 5173, 8080]);
    }

    #[test]
    fn normalize_rejects_ports_outside_the_range() {
        let zero = normalize(settings(vec![0], false)).expect_err("zero must be rejected");
        assert_eq!(zero.code, PortsErrorCode::InvalidInput);

        let out_of_range = normalize_ports(&[70000]).expect_err("out of range must be rejected");
        assert_eq!(out_of_range.code, PortsErrorCode::InvalidInput);
        assert_eq!(
            out_of_range.detail.as_ref().unwrap()["field"],
            "pinnedPorts"
        );
    }

    #[test]
    fn invalid_input_leaves_the_file_untouched() {
        let directory = scratch("invalid");
        save_at(&directory, settings(vec![3000], false)).expect("save");
        let before = std::fs::read(settings_file(&directory)).expect("read settings");

        let error = save_at(&directory, settings(vec![0], false)).expect_err("zero is invalid");
        assert_eq!(error.code, PortsErrorCode::InvalidInput);
        assert_eq!(
            std::fs::read(settings_file(&directory)).expect("read settings"),
            before
        );
    }

    #[test]
    fn normalize_rejects_more_than_fifty_ports() {
        let ports: Vec<u16> = (1..=51).collect();
        let error = normalize(settings(ports, false)).expect_err("51 ports must be rejected");
        assert_eq!(error.code, PortsErrorCode::InvalidInput);
        assert_eq!(error.detail.as_ref().unwrap()["max"], serde_json::json!(50));
    }

    #[test]
    fn exactly_fifty_pins_are_the_limit_and_are_accepted() {
        let ports: Vec<u16> = (1..=50).collect();
        let normalized =
            normalize(settings(ports.clone(), true)).expect("50 pins are the limit, not over it");

        assert_eq!(normalized.pinned_ports, ports);
        assert!(normalized.pinned_only);
    }

    #[test]
    fn save_creates_a_missing_directory() {
        let base = scratch("create-directory");
        let nested = base.join("ports");
        assert!(!nested.exists());

        save_at(&nested, settings(vec![3000], false)).expect("save");

        assert!(settings_file(&nested).exists());
    }

    #[test]
    fn load_from_a_missing_directory_is_defaults() {
        let base = scratch("missing-directory");
        let missing = base.join("not-created");

        assert_eq!(load_at(&missing).expect("load"), defaults());
        assert!(!missing.exists(), "a missing directory must not be created");
    }

    #[test]
    fn a_document_with_no_fields_uses_the_defaults() {
        let directory = scratch("empty-document");
        std::fs::write(settings_file(&directory), b"{}").expect("write settings");

        assert_eq!(load_at(&directory).expect("load"), PortsSettings::default());
    }

    #[test]
    fn a_file_with_too_many_pins_falls_back_to_defaults() {
        let directory = scratch("too-many-pins");
        let ports: Vec<String> = (1..=51).map(|port| port.to_string()).collect();
        let document = format!(
            r#"{{"version":1,"pinnedPorts":[{}],"pinnedOnly":false}}"#,
            ports.join(",")
        );
        std::fs::write(settings_file(&directory), document).expect("write settings");

        assert_eq!(load_at(&directory).expect("load"), defaults());
        assert!(!settings_file(&directory).exists());
        assert_eq!(
            file_names(&directory)
                .into_iter()
                .filter(|name| name.starts_with("settings.json.bak-"))
                .count(),
            1,
            "the unusable file must be preserved"
        );
    }

    #[test]
    fn the_backup_name_carries_a_unix_timestamp() {
        let directory = scratch("backup-name");
        std::fs::write(settings_file(&directory), b"{ not json").expect("write broken file");

        load_at(&directory).expect("load");

        let backup = file_names(&directory)
            .into_iter()
            .find(|name| name.starts_with("settings.json.bak-"))
            .expect("a backup must exist");
        let stamp = backup.trim_start_matches("settings.json.bak-");
        assert!(
            !stamp.is_empty() && stamp.chars().all(|character| character.is_ascii_digit()),
            "unexpected backup name: {backup}"
        );
    }

    #[test]
    fn corrupt_file_is_backed_up_and_reset() {
        let directory = scratch("corrupt");
        std::fs::write(settings_file(&directory), b"{ not json").expect("write broken file");

        assert_eq!(load_at(&directory).expect("load"), defaults());
        assert!(!settings_file(&directory).exists());

        let backups: Vec<String> = file_names(&directory)
            .into_iter()
            .filter(|name| name.starts_with("settings.json.bak-"))
            .collect();
        assert_eq!(backups.len(), 1, "the broken file must be preserved");
    }

    #[test]
    fn file_with_out_of_range_ports_falls_back_to_defaults() {
        for (label, document) in [
            (
                "zero",
                r#"{"version":1,"pinnedPorts":[0],"pinnedOnly":false}"#,
            ),
            (
                "too-large",
                r#"{"version":1,"pinnedPorts":[70000],"pinnedOnly":false}"#,
            ),
        ] {
            let directory = scratch(label);
            std::fs::write(settings_file(&directory), document).expect("write settings");

            assert_eq!(load_at(&directory).expect("load"), defaults());
            assert!(!settings_file(&directory).exists());
            let backups: Vec<String> = file_names(&directory)
                .into_iter()
                .filter(|name| name.starts_with("settings.json.bak-"))
                .collect();
            assert_eq!(backups.len(), 1, "case {label}: the file must be preserved");
        }
    }

    #[test]
    fn load_normalizes_an_unsorted_file_without_backing_it_up() {
        let directory = scratch("normalize-on-read");
        std::fs::write(
            settings_file(&directory),
            br#"{"version":1,"pinnedPorts":[8080,3000,3000],"pinnedOnly":false}"#,
        )
        .expect("write settings");

        let loaded = load_at(&directory).expect("load");
        assert_eq!(loaded.pinned_ports, vec![3000, 8080]);
        assert!(!file_names(&directory)
            .iter()
            .any(|name| name.starts_with("settings.json.bak-")));
    }

    #[test]
    fn successful_save_leaves_no_temp_file() {
        let directory = scratch("no-temp");
        save_at(&directory, defaults()).expect("save");

        let leftovers: Vec<String> = file_names(&directory)
            .into_iter()
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "leftover temp files: {leftovers:?}");
        assert!(settings_file(&directory).exists());
    }
}
