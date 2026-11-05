//! Profile commands: argument checks and workspace access only.
//!
//! Validation, revision tracking and the delete cascade live in
//! [`crate::profiles`]; persistence lives in [`crate::store`].

use crate::error::{FrpError, FrpResult};
use crate::models::{FrpProfile, FrpProfileInput, FrpProfilesView};
use crate::profiles;
use crate::state::FrpState;
use crate::store;

fn require_id(id: &str) -> FrpResult<&str> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err(FrpError::invalid_input("id", "A profile id is required."));
    }
    Ok(trimmed)
}

pub(crate) async fn list(state: &FrpState) -> FrpResult<FrpProfilesView> {
    let workspace = store::current(state)?;
    Ok(FrpProfilesView {
        profiles: profiles::list(&workspace),
        prefs: workspace.prefs.clone(),
        log_dir: crate::paths::logs_dir()?.to_string_lossy().into_owned(),
    })
}

pub(crate) async fn create(state: &FrpState, input: FrpProfileInput) -> FrpResult<FrpProfile> {
    store::update(state, |workspace| profiles::create(workspace, &input))
}

pub(crate) async fn update(
    state: &FrpState,
    id: &str,
    input: FrpProfileInput,
) -> FrpResult<FrpProfile> {
    let id = require_id(id)?;
    store::update(state, |workspace| profiles::update(workspace, id, &input))
}

/// Stops the profile's process first, then cascades to tunnels, config and logs.
pub(crate) async fn delete(state: &FrpState, id: &str) -> FrpResult<()> {
    let id = require_id(id)?;

    // Stopping first keeps the cascade from deleting the config of a child that
    // is still running (and would keep respawning from a missing file).
    let registry = std::sync::Arc::clone(&state.process);
    let target = id.to_string();
    let joined = tauri::async_runtime::spawn_blocking(move || registry.stop(&target)).await;
    joined.map_err(|_| FrpError::internal("The FRP process task was cancelled."))??;

    store::update(state, |workspace| profiles::delete(workspace, id))
}

pub(crate) async fn reorder(state: &FrpState, ids: Vec<String>) -> FrpResult<()> {
    store::update(state, |workspace| profiles::reorder(workspace, &ids))
}
