//! JSON persistence for the editor's own state files.
//!
//! Reads never fail: a missing file is a first run, and a corrupt one is moved
//! aside so the user can inspect it instead of losing it silently. Writes
//! replace the file atomically, so a crash mid-save cannot truncate it.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::{MdEditorError, MdEditorResult};

static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Load a JSON file, falling back to `T::default()`.
///
/// A file that fails to parse is renamed to `<name>.bak-<unix seconds>` first,
/// so the next save does not destroy whatever the user had.
pub fn load_json<T: Default + DeserializeOwned>(path: &Path) -> T {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!(
                    "md_editor_store_read_failed path={} error={error}",
                    path.display()
                );
            }
            return T::default();
        }
    };

    match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(error) => {
            log::warn!(
                "md_editor_store_parse_failed path={} error={error}",
                path.display()
            );
            backup_corrupt_file(path);
            T::default()
        }
    }
}

/// Serialize `value` and replace `path` atomically.
pub fn save_json<T: Serialize>(path: &Path, value: &T) -> MdEditorResult<()> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| {
        MdEditorError::internal(format!("The editor state could not be serialized: {error}"))
    })?;
    write_atomic(path, &bytes)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> MdEditorResult<()> {
    let directory = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(directory).map_err(|error| {
        MdEditorError::io(format!(
            "The directory could not be created: {} ({error})",
            directory.display()
        ))
    })?;

    let name = path
        .file_name()
        .ok_or_else(|| MdEditorError::invalid_input("path", "The path has no file name."))?;
    let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp = directory.join(format!(
        ".{}.{}.{}.tmp",
        name.to_string_lossy(),
        std::process::id(),
        sequence
    ));

    let written = write_and_rename(&temp, path, bytes);
    if let Err(error) = written {
        let _ = fs::remove_file(&temp);
        return Err(MdEditorError::io(format!(
            "Failed to write {}: {error}",
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
            "md_editor_store_backup_failed path={} error={error}",
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
