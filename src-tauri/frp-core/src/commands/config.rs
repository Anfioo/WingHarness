//! Config commands: preview the redacted TOML, and verify it with `frpc`
//! before writing it.
//!
//! `frpc verify` may take seconds, so the workspace lock is never held across
//! it: the command snapshots the workspace, runs the verification off the
//! async runtime, and re-enters the store only to bump the revision.

use crate::error::{FrpError, FrpResult};
use crate::models::{
    ConfigImportPreview, ConfigImportResult, ConfigImportSource, ConfigPreview,
    ConfigVerifyResult, RuntimePolicy,
};
use crate::state::FrpState;
use crate::{config, store};

fn require_id(id: &str) -> FrpResult<&str> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err(FrpError::invalid_input("id", "A profile id is required."));
    }
    Ok(trimmed)
}

async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> FrpResult<T> + Send + 'static,
) -> FrpResult<T> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| FrpError::internal(format!("The FRP task failed: {error}")))?
}

pub(crate) async fn preview(state: &FrpState, profile_id: &str) -> FrpResult<ConfigPreview> {
    let profile_id = require_id(profile_id)?;
    let workspace = store::current(state)?;
    config::preview(&workspace, profile_id)
}

pub(crate) async fn verify(
    state: &FrpState,
    profile_id: &str,
) -> FrpResult<ConfigVerifyResult> {
    let profile_id = require_id(profile_id)?.to_string();

    let snapshot = store::current(state)?;
    let target = profile_id.clone();
    let outcome = blocking(move || config::verify_and_save(&snapshot, &target)).await?;

    if outcome.config_changed {
        store::update(state, |workspace| {
            if let Some(profile) = workspace
                .profiles
                .iter_mut()
                .find(|profile| profile.id == profile_id)
            {
                profile.config_revision += 1;
                profile.updated_at = store::unix_now();
            }
            Ok(())
        })?;
    }

    Ok(outcome.result)
}

/// Read and parse the source; nothing is written, so the preview is safe to
/// call on every keystroke or file pick.
pub(crate) async fn import_preview(
    source: ConfigImportSource,
) -> FrpResult<ConfigImportPreview> {
    let parsed = crate::config_import::load(&source)?;
    Ok(crate::config_import::preview(&parsed))
}

/// Build the profile and its tunnels in memory and persist them in one write.
///
/// `store::update` loads the disk copy, applies the closure and saves only when
/// it returned `Ok`, so a failing step never leaves a partial import behind.
pub(crate) async fn import(
    state: &FrpState,
    source: ConfigImportSource,
    name: Option<String>,
    apply_token: bool,
    runtime_policy: RuntimePolicy,
    runtime_id: Option<String>,
) -> FrpResult<ConfigImportResult> {
    let parsed = crate::config_import::load(&source)?;
    store::update(state, |workspace| {
        crate::config_import::import(
            workspace,
            &parsed,
            name.as_deref(),
            apply_token,
            runtime_policy,
            runtime_id.as_deref(),
        )
    })
}
