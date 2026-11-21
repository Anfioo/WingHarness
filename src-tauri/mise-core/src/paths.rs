// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{MiseError, MiseResult};

/// The mise data directory (`<data dir>/mise`), resolved once at startup by the
/// root crate.
pub static CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// The app's data directory itself. The runtime probe looks for the app's own
/// Scoop shims below it, so it is published alongside [`CONFIG_DIR`].
pub static HOST_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Resolve the mise data directory.
pub fn dir() -> MiseResult<&'static PathBuf> {
    CONFIG_DIR
        .get()
        .ok_or_else(|| MiseError::internal("The mise data directory is unavailable."))
}

/// The app's data directory, once the root crate has published it.
pub fn host_data_dir() -> Option<&'static PathBuf> {
    HOST_DATA_DIR.get()
}

/// The mise data directory, created on first use.
pub fn ensure_dir() -> MiseResult<PathBuf> {
    let directory = dir()?.clone();
    std::fs::create_dir_all(&directory).map_err(|error| {
        log::warn!(
            "mise_config_dir_create_failed path={} error={error}",
            directory.display()
        );
        MiseError::io("The mise data directory could not be created.")
    })?;
    Ok(directory)
}

/// `<dir>/history.json` — the action history.
pub fn history_path() -> MiseResult<PathBuf> {
    Ok(dir()?.join("history.json"))
}

/// `<dir>/scan_dirs.json` — the custom project scan roots.
pub fn scan_dirs_path() -> MiseResult<PathBuf> {
    Ok(dir()?.join("scan_dirs.json"))
}

/// `USERPROFILE` -> `HOME` -> `HOMEDRIVE` + `HOMEPATH`.
pub fn home_dir() -> Option<PathBuf> {
    for key in ["USERPROFILE", "HOME"] {
        if let Some(value) = non_empty_env(key) {
            return Some(PathBuf::from(value));
        }
    }

    let drive = non_empty_env("HOMEDRIVE")?;
    let path = non_empty_env("HOMEPATH")?;
    Some(PathBuf::from(format!("{drive}{path}")))
}

/// `MISE_GLOBAL_CONFIG_FILE` -> `<home>/.config/mise/config.toml`.
pub fn global_config_path() -> Option<PathBuf> {
    global_config_path_for(home_dir().as_deref())
}

/// The same rule with an explicit home, used by tests.
pub fn global_config_path_for(home: Option<&Path>) -> Option<PathBuf> {
    if let Some(path) = config_file_override() {
        return Some(path);
    }
    home.map(|home| home.join(".config").join("mise").join("config.toml"))
}

/// Stage `<path>.tmp`, flush it to disk, then rename it over `path`.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> MiseResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            log::warn!(
                "mise_write_parent_create_failed path={} error={error}",
                parent.display()
            );
            MiseError::io("The destination directory could not be created.")
        })?;
    }

    let temporary = temporary_path(path);
    {
        let mut file = std::fs::File::create(&temporary).map_err(|error| {
            log::warn!(
                "mise_write_temp_failed path={} error={error}",
                temporary.display()
            );
            MiseError::io("The temporary file could not be created.")
        })?;
        file.write_all(bytes).map_err(|error| {
            log::warn!(
                "mise_write_temp_failed path={} error={error}",
                temporary.display()
            );
            MiseError::io("The temporary file could not be written.")
        })?;
        file.sync_all().map_err(|error| {
            log::warn!(
                "mise_write_sync_failed path={} error={error}",
                temporary.display()
            );
            MiseError::io("The temporary file could not be flushed.")
        })?;
    }

    std::fs::rename(&temporary, path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        log::warn!(
            "mise_write_rename_failed path={} error={error}",
            path.display()
        );
        MiseError::io("The temporary file could not replace the destination.")
    })
}

/// Copy an existing file to `<path>.bak-<unix seconds>`; returns the backup path.
pub fn backup_existing(path: &Path) -> MiseResult<Option<PathBuf>> {
    if !path.exists() {
        return Ok(None);
    }

    let backup = backup_path(path);
    std::fs::copy(path, &backup).map_err(|error| {
        log::warn!(
            "mise_backup_failed path={} backup={} error={error}",
            path.display(),
            backup.display()
        );
        MiseError::io("The existing file could not be backed up.")
    })?;
    Ok(Some(backup))
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn config_file_override() -> Option<PathBuf> {
    non_empty_env("MISE_GLOBAL_CONFIG_FILE").map(PathBuf::from)
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().map(|name| name.to_os_string()).unwrap_or_default();
    name.push(".tmp");
    path.with_file_name(name)
}

fn backup_path(path: &Path) -> PathBuf {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let mut name = path.file_name().map(|name| name.to_os_string()).unwrap_or_default();
    name.push(format!(".bak-{seconds}"));
    path.with_file_name(name)
}
