use std::path::PathBuf;
use std::sync::OnceLock;

use crate::error::{ServerError, ServerResult};

/// The server data directory (`<data dir>/server`), resolved once at startup by
/// the root crate.
///
/// Everything this feature persists — profiles, preferences, trusted host keys
/// — lives under this single directory, so the whole feature can be moved to
/// another machine in one step.
pub static CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Resolve the data directory.
pub fn dir() -> ServerResult<&'static PathBuf> {
    CONFIG_DIR.get().ok_or_else(|| {
        ServerError::internal("The server data directory is unavailable.")
    })
}

/// The directory itself, created on first use.
pub fn ensure_dir() -> ServerResult<PathBuf> {
    let directory = dir()?.clone();
    std::fs::create_dir_all(&directory).map_err(|error| {
        log::warn!(
            "server_config_dir_create_failed path={} error={error}",
            directory.display()
        );
        ServerError::internal("The server data directory could not be created.")
    })?;
    Ok(directory)
}

/// `servers.json` — profiles and preferences.
pub fn servers_path() -> ServerResult<PathBuf> {
    Ok(dir()?.join("servers.json"))
}

/// `known_hosts.json` — trusted host keys per profile.
pub fn known_hosts_path() -> ServerResult<PathBuf> {
    Ok(dir()?.join("known_hosts.json"))
}
