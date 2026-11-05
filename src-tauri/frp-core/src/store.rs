//! Persistence for the FRP workspace (`frp.json`).
//!
//! Every write stages the document as `frp.json.tmp`, flushes it, and then
//! renames it over the target, so a crash can never leave a half-written
//! workspace behind. A file that cannot be parsed is moved aside as
//! `frp.json.bak-<unix seconds>` and the caller gets the defaults, so the
//! feature starts clean instead of silently overwriting whatever was there.
//!
//! The in-memory copy lives in `FrpState::workspace`; the helpers at the bottom
//! of this module are the only place allowed to touch it, which keeps the lock
//! held for a clone and nothing else.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use crate::error::{FrpError, FrpResult};
use crate::models::Workspace;
use crate::paths;
use crate::state::FrpState;

const WORKSPACE_FILE: &str = "frp.json";

/// Serialises the read-modify-write cycle of `frp.json`, so two commands
/// cannot lose each other's write.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Seconds since the Unix epoch; every timestamp in this feature uses it.
pub(crate) fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

/// `frp.json` in the feature data directory.
pub fn workspace_path() -> FrpResult<PathBuf> {
    paths::workspace_path()
}

/// The feature data directory, created on first use.
pub fn ensure_dir() -> FrpResult<PathBuf> {
    paths::ensure_dir()
}

/// Read the workspace, or the defaults when it does not exist yet.
pub fn load() -> FrpResult<Workspace> {
    load_at(paths::dir()?)
}

/// Write the whole workspace atomically.
pub fn save(workspace: &Workspace) -> FrpResult<()> {
    let root = ensure_dir()?;
    save_at(&root, workspace)
}

/// Take the write lock. Held only around short in-memory work plus one write.
pub fn lock_for_write() -> FrpResult<MutexGuard<'static, ()>> {
    WRITE_LOCK
        .lock()
        .map_err(|_| FrpError::internal("The FRP workspace store is unavailable."))
}

/// The cached workspace, loading and caching it on the first call.
pub fn current(state: &FrpState) -> FrpResult<Workspace> {
    if let Some(workspace) = state.cached_workspace() {
        return Ok(workspace);
    }
    let workspace = load()?;
    state.cache_workspace(workspace.clone());
    Ok(workspace)
}

/// Read, apply and persist one change, then refresh the cache.
///
/// The disk copy is the source of truth under the lock, so a change made by an
/// earlier command that did not populate the cache is never overwritten.
pub fn update<T>(
    state: &FrpState,
    apply: impl FnOnce(&mut Workspace) -> FrpResult<T>,
) -> FrpResult<T> {
    let _guard = lock_for_write()?;
    let mut workspace = load()?;
    let value = apply(&mut workspace)?;
    sort(&mut workspace);
    save(&workspace)?;
    state.cache_workspace(workspace);
    Ok(value)
}

/// Stable display order: profiles by `sortOrder` then `createdAt`, tunnels by
/// `createdAt` then name.
pub(crate) fn sort(workspace: &mut Workspace) {
    workspace.profiles.sort_by(|left, right| {
        left.sort_order
            .cmp(&right.sort_order)
            .then_with(|| left.created_at.cmp(&right.created_at))
    });
    workspace
        .tunnels
        .sort_by(|left, right| left.created_at.cmp(&right.created_at).then_with(|| left.name.cmp(&right.name)));
}

fn workspace_file(root: &Path) -> PathBuf {
    root.join(WORKSPACE_FILE)
}

fn temp_file(root: &Path) -> PathBuf {
    root.join(format!("{WORKSPACE_FILE}.tmp"))
}

fn load_at(root: &Path) -> FrpResult<Workspace> {
    let path = workspace_file(root);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Workspace::default())
        }
        Err(error) => {
            // Refuse to fall back to the defaults: the next save would replace
            // a file we merely failed to read.
            log::warn!(
                "frp_store_read_failed path={} error={error}",
                path.display()
            );
            return Err(FrpError::internal(
                "The FRP workspace could not be read.",
            ));
        }
    };

    match serde_json::from_slice::<Workspace>(&bytes) {
        Ok(mut workspace) => {
            sort(&mut workspace);
            Ok(workspace)
        }
        Err(error) => {
            log::warn!(
                "frp_store_parse_failed path={} error={error}",
                path.display()
            );
            backup(&path);
            Ok(Workspace::default())
        }
    }
}

fn save_at(root: &Path, workspace: &Workspace) -> FrpResult<()> {
    let bytes = serde_json::to_vec_pretty(workspace).map_err(|error| {
        log::warn!("frp_store_encode_failed error={error}");
        FrpError::internal("The FRP workspace could not be saved.")
    })?;

    if let Err(error) = std::fs::create_dir_all(root) {
        log::warn!(
            "frp_store_dir_create_failed path={} error={error}",
            root.display()
        );
        return Err(FrpError::internal(
            "The FRP data directory could not be created.",
        ));
    }

    let temp = temp_file(root);
    let written = (|| -> std::io::Result<()> {
        let mut handle = std::fs::File::create(&temp)?;
        handle.write_all(&bytes)?;
        handle.sync_all()
    })();
    if let Err(error) = written {
        log::warn!(
            "frp_store_write_failed path={} error={error}",
            temp.display()
        );
        let _ = std::fs::remove_file(&temp);
        return Err(FrpError::internal(
            "The FRP workspace could not be saved.",
        ));
    }

    if let Err(error) = std::fs::rename(&temp, workspace_file(root)) {
        // Windows refuses the rename while the target is open; the staging copy
        // must not survive the failure.
        log::warn!("frp_store_rename_failed error={error}");
        let _ = std::fs::remove_file(&temp);
        return Err(FrpError::internal(
            "The FRP workspace could not be saved.",
        ));
    }
    Ok(())
}

/// Move a file that cannot be parsed out of the way, keeping its bytes for
/// support instead of deleting the user's data.
fn backup(path: &Path) {
    let target = path.with_file_name(format!("{WORKSPACE_FILE}.bak-{}", unix_now()));
    if let Err(error) = std::fs::rename(path, &target) {
        log::warn!(
            "frp_store_backup_failed from={} to={} error={error}",
            path.display(),
            target.display()
        );
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::PathBuf;

    use crate::paths;

    /// One data directory per test binary, set once because `CONFIG_DIR` is a
    /// process-wide `OnceLock`. Each test works in its own subdirectory with a
    /// fresh uuid, so tests still run in parallel without touching each other.
    pub(crate) fn data_dir() -> PathBuf {
        paths::CONFIG_DIR
            .get_or_init(|| {
                let dir = std::env::temp_dir()
                    .join(format!("frp-core-tests-{}", std::process::id()));
                std::fs::create_dir_all(&dir).expect("scratch data directory");
                dir
            })
            .clone()
    }

    pub(crate) fn scratch(label: &str) -> PathBuf {
        let dir = data_dir().join(format!("{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("scratch directory");
        dir
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::scratch;
    use super::*;
    use crate::models::{FrpProfile, RuntimePolicy, Tunnel, TunnelOptions, TunnelType};

    fn profile(id: &str, sort_order: i64, created_at: i64) -> FrpProfile {
        FrpProfile {
            id: id.to_string(),
            name: format!("profile-{id}"),
            server_addr: "frps.example.com".to_string(),
            server_port: 7000,
            token: None,
            runtime_policy: RuntimePolicy::Recommended,
            runtime_id: None,
            reconnect_enabled: true,
            note: String::new(),
            config_revision: 0,
            sort_order,
            created_at,
            updated_at: created_at,
        }
    }

    fn tunnel(id: &str, profile_id: &str, name: &str, created_at: i64) -> Tunnel {
        Tunnel {
            id: id.to_string(),
            profile_id: profile_id.to_string(),
            name: name.to_string(),
            tunnel_type: TunnelType::Tcp,
            enabled: true,
            local_ip: "127.0.0.1".to_string(),
            local_port: 22,
            options: TunnelOptions::Port { remote_port: 6000 },
            created_at,
            updated_at: created_at,
        }
    }

    #[test]
    fn first_start_returns_defaults() {
        let root = scratch("defaults");
        let workspace = load_at(&root).expect("load");
        assert_eq!(workspace.version, 1);
        assert!(workspace.profiles.is_empty());
        assert!(workspace.tunnels.is_empty());
        assert!(workspace.runtimes.is_empty());
        assert_eq!(workspace.prefs.active_tab, "overview");
    }

    #[test]
    fn values_round_trip_and_leave_no_temp_file() {
        let root = scratch("round-trip");
        let mut workspace = Workspace::default();
        workspace.profiles.push(profile("p1", 0, 10));
        workspace.tunnels.push(tunnel("t1", "p1", "ssh", 10));

        save_at(&root, &workspace).expect("save");
        let loaded = load_at(&root).expect("load");
        assert_eq!(loaded, workspace);

        assert!(workspace_file(&root).exists());
        let leftovers: Vec<String> = std::fs::read_dir(&root)
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "leftover temp files: {leftovers:?}");
    }

    #[test]
    fn corrupted_file_is_backed_up_and_reset() {
        let root = scratch("corrupt");
        std::fs::write(workspace_file(&root), b"{ not json").expect("write broken file");

        let workspace = load_at(&root).expect("load");
        assert!(workspace.profiles.is_empty());
        assert!(!workspace_file(&root).exists());

        let backups: Vec<String> = std::fs::read_dir(&root)
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("frp.json.bak-"))
            .collect();
        assert_eq!(backups.len(), 1, "the broken file must be preserved");
    }

    #[test]
    fn load_sorts_profiles_and_tunnels_stably() {
        let root = scratch("sort");
        let mut workspace = Workspace::default();
        workspace.profiles.push(profile("second", 1, 5));
        workspace.profiles.push(profile("tie-b", 0, 20));
        workspace.profiles.push(profile("tie-a", 0, 10));
        workspace.tunnels.push(tunnel("t2", "tie-a", "beta", 10));
        workspace.tunnels.push(tunnel("t1", "tie-a", "alpha", 10));
        workspace.tunnels.push(tunnel("t3", "tie-a", "omega", 5));
        save_at(&root, &workspace).expect("save");

        let loaded = load_at(&root).expect("load");
        let ids: Vec<&str> = loaded
            .profiles
            .iter()
            .map(|profile| profile.id.as_str())
            .collect();
        assert_eq!(ids, vec!["tie-a", "tie-b", "second"]);
        let names: Vec<&str> = loaded
            .tunnels
            .iter()
            .map(|tunnel| tunnel.name.as_str())
            .collect();
        assert_eq!(names, vec!["omega", "alpha", "beta"]);
    }

    #[test]
    fn save_creates_a_missing_directory() {
        let root = scratch("mkdir").join("nested").join("frp");
        save_at(&root, &Workspace::default()).expect("save");
        assert!(workspace_file(&root).exists());
    }
}
