// Ported from Porter (https://github.com/t21dev/porter-app), MIT License.
// See ../UPSTREAM.md for the porting record.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::error::{PortsError, PortsResult};

/// The ports data directory (`<data dir>/ports`), resolved once at startup by
/// the root crate.
pub static CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Resolve the data directory.
pub fn dir() -> PortsResult<&'static PathBuf> {
    CONFIG_DIR
        .get()
        .ok_or_else(|| PortsError::internal("The ports data directory is unavailable."))
}

/// The data directory itself, created on first use.
pub fn ensure_dir() -> PortsResult<PathBuf> {
    let directory = dir()?.clone();
    create(&directory)?;
    Ok(directory)
}

/// `<dir>/settings.json` — the pinned ports and the "pinned only" flag.
pub fn settings_path() -> PortsResult<PathBuf> {
    Ok(dir()?.join("settings.json"))
}

fn create(directory: &Path) -> PortsResult<()> {
    std::fs::create_dir_all(directory).map_err(|error| {
        log::warn!(
            "ports_config_dir_create_failed path={} error={error}",
            directory.display()
        );
        PortsError::internal("The ports data directory could not be created.")
    })
}
