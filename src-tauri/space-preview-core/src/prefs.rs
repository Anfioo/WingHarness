//! `preview.json`: the persisted preferences.
//!
//! Reads never fail: a missing file is a first run, and a corrupt one is moved
//! aside as `preview.json.bak-<unix seconds>` so the next save cannot destroy
//! it silently. Writes replace the file atomically.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{SpacePreviewError, SpacePreviewResult};
use crate::models::PreviewPreferences;
use crate::paths;

/// Read the preferences, falling back to the defaults.
pub fn load() -> SpacePreviewResult<PreviewPreferences> {
    load_from(&paths::preferences_file())
}

/// Store the whole preferences object, returning what was written.
pub fn save(preferences: PreviewPreferences) -> SpacePreviewResult<PreviewPreferences> {
    save_to(&paths::preferences_file(), preferences)
}

// The file is a parameter, not read from `paths`, so the behaviour here can be
// tested without the process-global data directory.
fn load_from(path: &Path) -> SpacePreviewResult<PreviewPreferences> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PreviewPreferences::default());
        }
        Err(error) => {
            return Err(SpacePreviewError::internal(format!(
                "The preview preferences could not be read: {} ({error})",
                path.display()
            )));
        }
    };

    match serde_json::from_slice::<PreviewPreferences>(&bytes) {
        Ok(preferences) => Ok(normalize(preferences)),
        Err(error) => {
            log::warn!(
                "space_preview_preferences_parse_failed path={} error={error}",
                path.display()
            );
            backup_corrupt_file(path);
            Ok(PreviewPreferences::default())
        }
    }
}

fn save_to(path: &Path, preferences: PreviewPreferences) -> SpacePreviewResult<PreviewPreferences> {
    let preferences = normalize(preferences);
    let bytes = serde_json::to_vec_pretty(&preferences).map_err(|error| {
        SpacePreviewError::internal(format!(
            "The preview preferences could not be serialized: {error}"
        ))
    })?;
    write_atomic(path, &bytes)?;
    Ok(preferences)
}

/// The schema version is ours, not the caller's.
fn normalize(mut preferences: PreviewPreferences) -> PreviewPreferences {
    let defaults = PreviewPreferences::default();
    preferences.version = 1;
    preferences.reading_width = in_range(preferences.reading_width, 360, 2400, defaults.reading_width);
    preferences.font_size = in_range(preferences.font_size, 10, 40, defaults.font_size);
    preferences.text_preview_threshold_kb = in_range(
        preferences.text_preview_threshold_kb,
        1,
        65536,
        defaults.text_preview_threshold_kb,
    );
    preferences.max_preview_mib =
        in_range(preferences.max_preview_mib, 16, 2048, defaults.max_preview_mib);
    preferences.max_archive_entry_mib = in_range(
        preferences.max_archive_entry_mib,
        16,
        1024,
        defaults.max_archive_entry_mib,
    );
    preferences.default_encoding =
        one_of(preferences.default_encoding, ENCODINGS, &defaults.default_encoding);
    preferences.font = one_of(preferences.font, FONTS, &defaults.font);
    preferences.html = one_of(preferences.html, HTML_VIEWS, &defaults.html);
    preferences.preview_key = one_of(preferences.preview_key, PREVIEW_KEYS, &defaults.preview_key);
    preferences
}

const ENCODINGS: &[&str] = &[
    "auto",
    "utf-8",
    "utf-16le",
    "utf-16be",
    "gb18030",
    "big5",
    "windows-1252",
    "shift_jis",
];
const FONTS: &[&str] = &["auto", "sans", "serif", "mono"];
const HTML_VIEWS: &[&str] = &["source", "web"];
const PREVIEW_KEYS: &[&str] = &["space", "winSpace"];

fn in_range(value: u32, minimum: u32, maximum: u32, fallback: u32) -> u32 {
    if (minimum..=maximum).contains(&value) {
        value
    } else {
        fallback
    }
}

fn one_of(value: String, allowed: &[&str], fallback: &str) -> String {
    if allowed.contains(&value.as_str()) {
        value
    } else {
        fallback.to_owned()
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> SpacePreviewResult<()> {
    let directory = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(directory).map_err(|error| {
        SpacePreviewError::internal(format!(
            "The preview directory could not be created: {} ({error})",
            directory.display()
        ))
    })?;

    let name = path
        .file_name()
        .ok_or_else(|| SpacePreviewError::invalid_input("The path has no file name."))?;
    let temp = path.with_file_name(format!("{}.tmp", name.to_string_lossy()));

    let written = write_and_rename(&temp, path, bytes);
    if let Err(error) = written {
        let _ = fs::remove_file(&temp);
        return Err(SpacePreviewError::internal(format!(
            "The preview preferences could not be written: {} ({error})",
            path.display()
        )));
    }
    Ok(())
}

fn write_and_rename(temp: &Path, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = fs::File::create(temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(temp, path)
}

fn backup_corrupt_file(path: &Path) {
    let backup = backup_path(path);
    if let Err(error) = fs::rename(path, &backup) {
        log::warn!(
            "space_preview_preferences_backup_failed path={} error={error}",
            path.display()
        );
    }
}

fn backup_path(path: &Path) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default();
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    path.with_file_name(format!("{name}.bak-{stamp}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn temp_dir(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "space-preview-prefs-{label}-{}-{stamp}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn backup_files(directory: &Path) -> Vec<PathBuf> {
        fs::read_dir(directory)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().contains(".bak-"))
            })
            .collect()
    }

    #[test]
    fn a_missing_file_reads_as_the_defaults() {
        let directory = temp_dir("missing");
        let path = directory.join("preview.json");

        let preferences = load_from(&path).unwrap();

        assert!(preferences.space_enabled);
        assert_eq!(preferences.reading_width, 900);
        assert_eq!(preferences.font_size, 15);
        assert_eq!(preferences.default_encoding, "auto");
        assert_eq!(preferences.text_preview_threshold_kb, 500);
        assert_eq!(preferences.font, "auto");
        assert!(preferences.wrap);
        assert_eq!(preferences.html, "source");
        assert_eq!(preferences.max_preview_mib, 512);
        assert_eq!(preferences.max_archive_entry_mib, 256);
        assert!(!preferences.tabs);
        assert_eq!(preferences.preview_key, "space");
        assert!(!path.exists());
    }

    #[test]
    fn save_and_load_round_trip_every_field() {
        let directory = temp_dir("round-trip");
        let path = directory.join("nested").join("preview.json");
        let saved = PreviewPreferences {
            space_enabled: false,
            reading_width: 1080,
            font_size: 18,
            default_encoding: "gb18030".to_owned(),
            text_preview_threshold_kb: 2048,
            font: "serif".to_owned(),
            wrap: false,
            html: "web".to_owned(),
            max_preview_mib: 128,
            max_archive_entry_mib: 64,
            tabs: true,
            preview_key: "winSpace".to_owned(),
            ..PreviewPreferences::default()
        };

        assert_eq!(save_to(&path, saved.clone()).unwrap(), saved);
        assert_eq!(load_from(&path).unwrap(), saved);
    }

    #[test]
    fn the_wire_names_carry_the_capital_b_the_frontend_reads() {
        let json = serde_json::to_string(&PreviewPreferences::default()).unwrap();

        assert!(json.contains("\"maxPreviewMiB\":512"), "{json}");
        assert!(json.contains("\"maxArchiveEntryMiB\":256"), "{json}");
    }

    #[test]
    fn the_schema_version_is_ours_not_the_file_s() {
        let directory = temp_dir("version");
        let path = directory.join("preview.json");
        let saved = PreviewPreferences {
            version: 42,
            ..PreviewPreferences::default()
        };

        assert_eq!(save_to(&path, saved).unwrap().version, 1);

        fs::write(&path, br#"{"version":42,"spaceEnabled":true,"readingWidth":900,"fontSize":15,"defaultEncoding":"auto"}"#).unwrap();
        let loaded = load_from(&path).unwrap();
        assert_eq!(loaded.version, 1);
        assert_eq!(loaded.text_preview_threshold_kb, 500);
    }

    #[test]
    fn fields_missing_from_an_older_file_take_their_defaults() {
        let directory = temp_dir("older-file");
        let path = directory.join("preview.json");
        fs::write(
            &path,
            br#"{"version":1,"spaceEnabled":false,"readingWidth":720,"fontSize":17,"defaultEncoding":"gb18030","textPreviewThresholdKb":1024}"#,
        )
        .unwrap();

        let loaded = load_from(&path).unwrap();

        assert!(!loaded.space_enabled);
        assert_eq!(loaded.reading_width, 720);
        assert_eq!(loaded.font, "auto");
        assert!(loaded.wrap);
        assert_eq!(loaded.html, "source");
        assert_eq!(loaded.max_preview_mib, 512);
        assert_eq!(loaded.max_archive_entry_mib, 256);
        assert!(!loaded.tabs);
        assert_eq!(loaded.preview_key, "space");
        assert!(backup_files(&directory).is_empty());
    }

    #[test]
    fn out_of_range_values_fall_back_to_the_defaults() {
        let directory = temp_dir("normalize");
        let path = directory.join("preview.json");
        fs::write(
            &path,
            br#"{
                "version": 1,
                "spaceEnabled": true,
                "readingWidth": 9999,
                "fontSize": 2,
                "defaultEncoding": "utf-7",
                "textPreviewThresholdKb": 0,
                "font": "comic",
                "wrap": false,
                "html": "print",
                "maxPreviewMiB": 8,
                "maxArchiveEntryMiB": 4096,
                "tabs": true,
                "previewKey": "altSpace"
            }"#,
        )
        .unwrap();

        let loaded = load_from(&path).unwrap();

        assert_eq!(loaded.reading_width, 900);
        assert_eq!(loaded.font_size, 15);
        assert_eq!(loaded.default_encoding, "auto");
        assert_eq!(loaded.text_preview_threshold_kb, 500);
        assert_eq!(loaded.font, "auto");
        assert!(!loaded.wrap, "a valid boolean is kept");
        assert_eq!(loaded.html, "source");
        assert_eq!(loaded.max_preview_mib, 512);
        assert_eq!(loaded.max_archive_entry_mib, 256);
        assert!(loaded.tabs);
        assert_eq!(loaded.preview_key, "space");
    }

    #[test]
    fn a_corrupt_file_is_backed_up_and_the_defaults_returned() {
        let directory = temp_dir("corrupt");
        let path = directory.join("preview.json");
        fs::write(&path, b"{ not json").unwrap();

        let preferences = load_from(&path).unwrap();

        assert_eq!(preferences, PreviewPreferences::default());
        assert!(!path.exists(), "the corrupt file must not stay in place");
        let backups = backup_files(&directory);
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read(&backups[0]).unwrap(), b"{ not json");
    }

    #[test]
    fn a_save_leaves_no_temporary_file_behind() {
        let directory = temp_dir("temp-file");
        let path = directory.join("preview.json");

        save_to(&path, PreviewPreferences::default()).unwrap();

        let names: Vec<String> = fs::read_dir(&directory)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["preview.json".to_owned()]);
    }

    #[test]
    fn a_second_save_replaces_the_first() {
        let directory = temp_dir("replace");
        let path = directory.join("preview.json");
        let mut preferences = PreviewPreferences::default();
        save_to(&path, preferences.clone()).unwrap();
        preferences.font_size = 22;

        save_to(&path, preferences.clone()).unwrap();

        assert_eq!(load_from(&path).unwrap().font_size, 22);
        assert!(backup_files(&directory).is_empty());
    }
}
