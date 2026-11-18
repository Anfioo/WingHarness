//! The task manager's data directory.
//!
//! The root crate resolves it once at startup from `config::dir()` and stores
//! it in [`CONFIG_DIR`], so every other module reads the same directory and the
//! whole feature can move with the configurable data directory.

use std::path::PathBuf;
use std::sync::OnceLock;

use crate::error::{ArgusError, ArgusResult};

/// The task manager data directory (`<data dir>/argus`), set once in setup.
pub static CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Resolve the data directory.
pub fn dir() -> ArgusResult<&'static PathBuf> {
    CONFIG_DIR.get().ok_or_else(|| {
        ArgusError::internal("The task manager data directory is unavailable.")
    })
}

/// The data directory itself, created on first use.
pub fn ensure_dir() -> ArgusResult<PathBuf> {
    let directory = dir()?.clone();
    std::fs::create_dir_all(&directory).map_err(|error| {
        log::warn!(
            "argus_config_dir_create_failed path={} error={error}",
            directory.display()
        );
        ArgusError::internal("The task manager data directory could not be created.")
    })?;
    Ok(directory)
}

/// `<dir>/settings.json` — the persisted page settings.
pub fn settings_path() -> ArgusResult<PathBuf> {
    Ok(ensure_dir()?.join("settings.json"))
}
