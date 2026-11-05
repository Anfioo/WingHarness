use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::error::{FrpError, FrpResult};

/// The FRP data directory (`<data dir>/frp`), resolved once at startup by the
/// root crate.
///
/// Everything this feature persists lives under this single directory — the
/// workspace JSON, one generated config per profile, pid records and rolled
/// logs — so the whole feature can be moved to another machine in one step.
pub static CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Resolve the data directory.
pub fn dir() -> FrpResult<&'static PathBuf> {
    CONFIG_DIR
        .get()
        .ok_or_else(|| FrpError::internal("The FRP data directory is unavailable."))
}

/// The data directory itself, created on first use.
pub fn ensure_dir() -> FrpResult<PathBuf> {
    let directory = dir()?.clone();
    create(&directory)?;
    Ok(directory)
}

/// `frp.json` — profiles, tunnels, runtimes and preferences.
pub fn workspace_path() -> FrpResult<PathBuf> {
    Ok(dir()?.join("frp.json"))
}

/// `profiles/` — one directory per profile holding its generated config and pid
/// record.
pub fn profiles_dir() -> FrpResult<PathBuf> {
    Ok(dir()?.join("profiles"))
}

/// `logs/` — one directory per profile holding its rolled log files.
pub fn logs_dir() -> FrpResult<PathBuf> {
    Ok(dir()?.join("logs"))
}

/// `profiles/<profileId>/`.
pub fn profile_dir(profile_id: &str) -> FrpResult<PathBuf> {
    Ok(profiles_dir()?.join(segment(profile_id)?))
}

/// `profiles/<profileId>/frpc.toml` — the generated runtime config.
pub fn config_path(profile_id: &str) -> FrpResult<PathBuf> {
    Ok(profile_dir(profile_id)?.join("frpc.toml"))
}

/// `profiles/<profileId>/frpc.pid` — the live pid record used to reap orphans.
pub fn pid_path(profile_id: &str) -> FrpResult<PathBuf> {
    Ok(profile_dir(profile_id)?.join("frpc.pid"))
}

/// `logs/<profileId>/`.
pub fn log_dir(profile_id: &str) -> FrpResult<PathBuf> {
    Ok(logs_dir()?.join(segment(profile_id)?))
}

/// Create `profiles/<profileId>/`, returning it.
pub fn ensure_profile_dir(profile_id: &str) -> FrpResult<PathBuf> {
    let directory = profile_dir(profile_id)?;
    create(&directory)?;
    Ok(directory)
}

/// Create `logs/<profileId>/`, returning it.
pub fn ensure_log_dir(profile_id: &str) -> FrpResult<PathBuf> {
    let directory = log_dir(profile_id)?;
    create(&directory)?;
    Ok(directory)
}

/// Profile ids are generated UUIDs, but they also arrive from `frp.json` and
/// command arguments: refuse anything that could escape the data directory.
fn segment(profile_id: &str) -> FrpResult<&str> {
    let invalid = profile_id.is_empty()
        || profile_id == "."
        || profile_id == ".."
        || profile_id.contains(['/', '\\', ':', '\0']);
    if invalid {
        return Err(FrpError::invalid_input(
            "profileId",
            "The profile id is not a valid directory name.",
        ));
    }
    Ok(profile_id)
}

fn create(directory: &Path) -> FrpResult<()> {
    std::fs::create_dir_all(directory).map_err(|error| {
        log::warn!(
            "frp_config_dir_create_failed path={} error={error}",
            directory.display()
        );
        FrpError::internal("The FRP data directory could not be created.")
    })
}
