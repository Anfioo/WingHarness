// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `UPSTREAM.md` for the porting record.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::error::{MoinError, MoinResult};
use crate::models::now_ms;

/// Set once during `setup` to `<app data dir>/moin`. Every file the download
/// engine persists lives below it, so the whole feature moves with the data
/// directory.
pub static CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn dir() -> MoinResult<&'static PathBuf> {
    CONFIG_DIR
        .get()
        .ok_or_else(|| MoinError::internal("The moin data directory has not been initialised."))
}

pub fn ensure_dir() -> MoinResult<PathBuf> {
    let dir = dir()?.clone();
    fs::create_dir_all(&dir)
        .map_err(|error| MoinError::io(format!("Could not create the moin data directory: {error}")))?;
    Ok(dir)
}

pub fn db_path() -> MoinResult<PathBuf> {
    Ok(dir()?.join("downloads.db"))
}

pub fn settings_path() -> MoinResult<PathBuf> {
    Ok(dir()?.join("settings.json"))
}

pub fn categories_path() -> MoinResult<PathBuf> {
    Ok(dir()?.join("categories.json"))
}

pub fn aria2_dir() -> MoinResult<PathBuf> {
    Ok(dir()?.join("aria2"))
}

/// Write through a temporary file, flush it to disk and rename it into place,
/// so a crash mid-write cannot leave a truncated JSON document behind.
///
/// The temporary keeps the full file name (`settings.json.tmp`, not
/// `settings.tmp`): the data directory is user-visible, and two documents that
/// share a stem must never collide on their staging file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> MoinResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| MoinError::io("The target path has no parent directory."))?;
    fs::create_dir_all(parent)
        .map_err(|error| MoinError::io(format!("Could not create a directory: {error}")))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| MoinError::io("The target path has no file name."))?;
    let temporary = path.with_file_name(format!("{name}.tmp"));
    let mut file = fs::File::create(&temporary)
        .map_err(|error| MoinError::io(format!("Could not create a temporary file: {error}")))?;
    file.write_all(bytes)
        .map_err(|error| MoinError::io(format!("Could not write a temporary file: {error}")))?;
    file.sync_all()
        .map_err(|error| MoinError::io(format!("Could not flush a temporary file: {error}")))?;
    drop(file);
    fs::rename(&temporary, path)
        .map_err(|error| MoinError::io(format!("Could not replace a file atomically: {error}")))
}

/// Keep a corrupt document next to the original instead of deleting it, so a
/// user can still recover hand-edited settings or categories.
pub fn backup_corrupt(path: &Path) {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    let backup = path.with_file_name(format!("{name}.bak-{}", now_ms().div_euclid(1000)));
    if let Err(error) = fs::rename(path, &backup) {
        log::warn!("Could not back up a corrupt moin document: {error}");
    }
}
