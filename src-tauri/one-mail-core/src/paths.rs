// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{OneMailError, OneMailResult};

/// Set once during `setup` to `<data dir>/one-mail`. Every file the mail engine
/// persists — `onemail.db` and `settings.json` — lives below it, so the whole
/// feature moves with the data directory.
pub static CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn dir() -> OneMailResult<&'static PathBuf> {
    CONFIG_DIR
        .get()
        .ok_or_else(|| OneMailError::internal("The mail data directory is unavailable."))
}

pub fn ensure_dir() -> OneMailResult<PathBuf> {
    let directory = dir()?.clone();
    fs::create_dir_all(&directory).map_err(|error| {
        log::warn!(
            "one_mail_config_dir_create_failed path={} error={error}",
            directory.display()
        );
        OneMailError::internal("The mail data directory could not be created.")
    })?;
    Ok(directory)
}

pub fn db_path() -> OneMailResult<PathBuf> {
    Ok(dir()?.join("onemail.db"))
}

pub fn settings_path() -> OneMailResult<PathBuf> {
    Ok(dir()?.join("settings.json"))
}

/// Write through a temporary file, flush it to disk and rename it into place,
/// so a crash mid-write cannot leave a truncated JSON document behind.
///
/// The temporary keeps the full file name (`settings.json.tmp`, not
/// `settings.tmp`): the data directory is user-visible, and two documents that
/// share a stem must never collide on their staging file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> OneMailResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| OneMailError::internal("The target path has no parent directory."))?;
    fs::create_dir_all(parent)
        .map_err(|error| OneMailError::internal(format!("Could not create a directory: {error}")))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| OneMailError::internal("The target path has no file name."))?;
    let temporary = path.with_file_name(format!("{name}.tmp"));
    let mut file = fs::File::create(&temporary)
        .map_err(|error| OneMailError::internal(format!("Could not create a temporary file: {error}")))?;
    file.write_all(bytes)
        .map_err(|error| OneMailError::internal(format!("Could not write a temporary file: {error}")))?;
    file.sync_all()
        .map_err(|error| OneMailError::internal(format!("Could not flush a temporary file: {error}")))?;
    drop(file);
    fs::rename(&temporary, path).map_err(|error| {
        OneMailError::internal(format!("Could not replace a file atomically: {error}"))
    })
}

/// Keep a corrupt document next to the original instead of deleting it, so a
/// user can still recover hand-edited settings.
pub fn backup_corrupt(path: &Path) {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let backup = path.with_file_name(format!("{name}.bak-{seconds}"));
    if let Err(error) = fs::rename(path, &backup) {
        log::warn!("Could not back up a corrupt mail document: {error}");
    }
}
