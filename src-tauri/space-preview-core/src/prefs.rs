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
    let path = paths::preferences_file();
    let bytes = match fs::read(&path) {
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
            backup_corrupt_file(&path);
            Ok(PreviewPreferences::default())
        }
    }
}

/// Store the whole preferences object, returning what was written.
pub fn save(preferences: PreviewPreferences) -> SpacePreviewResult<PreviewPreferences> {
    let path = paths::preferences_file();
    let preferences = normalize(preferences);
    let bytes = serde_json::to_vec_pretty(&preferences).map_err(|error| {
        SpacePreviewError::internal(format!(
            "The preview preferences could not be serialized: {error}"
        ))
    })?;
    write_atomic(&path, &bytes)?;
    Ok(preferences)
}

/// The schema version is ours, not the caller's.
fn normalize(mut preferences: PreviewPreferences) -> PreviewPreferences {
    preferences.version = 1;
    preferences
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
