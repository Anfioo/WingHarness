use std::path::PathBuf;
use std::sync::OnceLock;

use crate::error::{SystoolsError, SystoolsResult};

/// The systools data directory (`<data dir>/.systools`), resolved once at
/// startup by the root crate.
///
/// Everything this feature persists lives under this single directory so the
/// whole feature can be moved to another machine in one step.
pub static CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Resolve the data directory.
pub fn dir() -> SystoolsResult<&'static PathBuf> {
    CONFIG_DIR
        .get()
        .ok_or_else(|| SystoolsError::persistence("systools data directory is unavailable"))
}

/// Resolve the cache directory inside the data directory, creating it on first
/// use.
pub fn cache_dir() -> SystoolsResult<PathBuf> {
    let directory = dir()?.join("cache");
    std::fs::create_dir_all(&directory).map_err(|error| {
        log::warn!(
            "systools_cache_dir_create_failed path={} error={error}",
            directory.display()
        );
        SystoolsError::persistence("cache directory")
    })?;
    Ok(directory)
}

/// Resolve the persisted user preferences file.
pub fn prefs_path() -> SystoolsResult<PathBuf> {
    Ok(dir()?.join("prefs.json"))
}
