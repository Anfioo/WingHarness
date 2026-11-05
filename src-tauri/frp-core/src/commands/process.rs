//! Process command bodies.
//!
//! A command never holds the workspace lock while it generates a config, runs
//! `frpc verify` or waits for a child: it clones the workspace, prepares a
//! [`LaunchSpec`] on the blocking pool, then hands the spec to the registry and
//! caches the (possibly re-revisioned) workspace again.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::State;

use crate::error::{FrpError, FrpResult};
use crate::models::{BatchFailure, BatchResult, ConnectionSnapshot, Workspace};
use crate::process::{LaunchSpec, ProcessRegistry};
use crate::state::FrpState;

const TASK_CANCELLED: &str = "The FRP process task was cancelled.";

pub async fn start(
    state: State<'_, FrpState>,
    profile_id: String,
) -> FrpResult<ConnectionSnapshot> {
    let (launch, workspace) = prepare(&state, profile_id).await?;
    let registry = registry(&state);
    registry.set_log_prefs(workspace.prefs);
    let joined = tauri::async_runtime::spawn_blocking(move || registry.start(launch)).await;
    joined.map_err(|_| FrpError::internal(TASK_CANCELLED))?
}

pub async fn stop(
    state: State<'_, FrpState>,
    profile_id: String,
) -> FrpResult<ConnectionSnapshot> {
    let registry = registry(&state);
    let joined = tauri::async_runtime::spawn_blocking(move || registry.stop(&profile_id)).await;
    joined.map_err(|_| FrpError::internal(TASK_CANCELLED))?
}

pub async fn restart(
    state: State<'_, FrpState>,
    profile_id: String,
) -> FrpResult<ConnectionSnapshot> {
    let (launch, workspace) = prepare(&state, profile_id).await?;
    let registry = registry(&state);
    registry.set_log_prefs(workspace.prefs);
    let joined = tauri::async_runtime::spawn_blocking(move || registry.restart(launch)).await;
    joined.map_err(|_| FrpError::internal(TASK_CANCELLED))?
}

pub async fn start_all(state: State<'_, FrpState>) -> FrpResult<BatchResult> {
    let registry = registry(&state);
    let cached = state.cached_workspace();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let mut workspace = match cached {
            Some(workspace) => workspace,
            None => crate::store::load()?,
        };
        registry.set_log_prefs(workspace.prefs.clone());

        let mut profiles = workspace.profiles.clone();
        profiles.sort_by(|left, right| {
            left.sort_order
                .cmp(&right.sort_order)
                .then_with(|| left.created_at.cmp(&right.created_at))
        });

        let mut result = BatchResult {
            succeeded: Vec::new(),
            failed: Vec::new(),
        };
        for profile in profiles {
            match prepare_launch(workspace.clone(), &profile.id) {
                Ok((launch, updated)) => {
                    workspace = updated;
                    match registry.start(launch) {
                        Ok(_) => result.succeeded.push(profile.id),
                        Err(error) => result.failed.push(BatchFailure {
                            profile_id: profile.id,
                            error,
                        }),
                    }
                }
                Err(error) => result.failed.push(BatchFailure {
                    profile_id: profile.id,
                    error,
                }),
            }
        }
        Ok((result, workspace))
    })
    .await;

    let (result, workspace) = joined.map_err(|_| FrpError::internal(TASK_CANCELLED))??;
    state.cache_workspace(workspace);
    Ok(result)
}

pub async fn stop_all(state: State<'_, FrpState>) -> FrpResult<BatchResult> {
    let registry = registry(&state);
    let joined = tauri::async_runtime::spawn_blocking(move || registry.stop_all()).await;
    joined.map_err(|_| FrpError::internal(TASK_CANCELLED))?
}

pub async fn connections_list(state: State<'_, FrpState>) -> FrpResult<Vec<ConnectionSnapshot>> {
    Ok(state.process.snapshots())
}

pub async fn nudge_health(state: State<'_, FrpState>) -> FrpResult<u32> {
    Ok(state.process.nudge_health() as u32)
}

fn registry(state: &State<'_, FrpState>) -> Arc<ProcessRegistry> {
    Arc::clone(&state.process)
}

/// Clone the workspace, prepare a launch spec off the async thread, and cache
/// the workspace again because `frpc verify` may have bumped a config revision.
async fn prepare(state: &FrpState, profile_id: String) -> FrpResult<(LaunchSpec, Workspace)> {
    let cached = state.cached_workspace();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let workspace = match cached {
            Some(workspace) => workspace,
            None => crate::store::load()?,
        };
        prepare_launch(workspace, &profile_id)
    })
    .await;

    let (launch, workspace) = joined.map_err(|_| FrpError::internal(TASK_CANCELLED))??;
    state.cache_workspace(workspace.clone());
    Ok((launch, workspace))
}

/// Resolve one profile into everything the registry needs.
///
/// Runs without any lock held: `frpc verify` spawns a process and may take up to
/// its own timeout.
fn prepare_launch(workspace: Workspace, profile_id: &str) -> FrpResult<(LaunchSpec, Workspace)> {
    let Some(profile) = workspace
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .cloned()
    else {
        return Err(FrpError::not_found("profile", profile_id));
    };

    let runtime = crate::runtimes::resolve_for_profile(&profile, &workspace)?;
    let runtime_path = PathBuf::from(&runtime.path);
    if !runtime_path.is_file() {
        return Err(FrpError::runtime_missing(format!(
            "The frpc binary is missing at {}.",
            runtime.path
        )));
    }

    let work_dir = crate::paths::ensure_profile_dir(profile_id)?;
    let config_path = crate::paths::config_path(profile_id)?;

    let mut workspace = workspace;
    let outcome = crate::config::verify_and_save(&workspace, profile_id)?;
    if outcome.config_changed {
        if let Some(entry) = workspace
            .profiles
            .iter_mut()
            .find(|entry| entry.id == profile_id)
        {
            entry.config_revision = entry.config_revision.saturating_add(1);
        }
        if let Err(error) = crate::store::save(&workspace) {
            log::warn!("frp_config_revision_save_failed profile={profile_id} error={error}");
        }
    }
    crate::log_files::prune(Some(profile_id), &workspace.prefs);

    let config_revision = workspace
        .profiles
        .iter()
        .find(|candidate| candidate.id == profile_id)
        .map(|candidate| candidate.config_revision)
        .unwrap_or(profile.config_revision);

    let launch = LaunchSpec {
        profile_id: profile.id,
        runtime_id: runtime.id,
        runtime_version: runtime.version,
        runtime_path,
        config_path,
        work_dir,
        reconnect_enabled: profile.reconnect_enabled,
        server_endpoint: format!("{}:{}", profile.server_addr, profile.server_port),
        config_revision,
    };
    Ok((launch, workspace))
}
