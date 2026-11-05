//! Runtime command bodies: argument checks, workspace access and the registry
//! lookup that keeps a runtime an active process is using from being deleted.
//!
//! Probing spawns a process and can take seconds, so it never happens while the
//! workspace write lock is held.

use std::path::Path;

use crate::error::{FrpError, FrpResult};
use crate::models::{DiscoveredRuntime, RuntimeProbe, RuntimeRecord, RuntimeView};
use crate::state::FrpState;
use crate::{runtime_discover, runtime_probe, runtimes, store};

fn require_id(id: &str) -> FrpResult<&str> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err(FrpError::invalid_input("id", "A runtime id is required."));
    }
    Ok(trimmed)
}

fn require_path(path: &str) -> FrpResult<&str> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(FrpError::invalid_input("path", "An frpc path is required."));
    }
    Ok(trimmed)
}

async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> FrpResult<T> + Send + 'static,
) -> FrpResult<T> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| FrpError::internal(format!("The FRP runtime task failed: {error}")))?
}

pub(crate) async fn list(state: &FrpState) -> FrpResult<Vec<RuntimeView>> {
    let workspace = store::current(state)?;
    Ok(runtimes::list(&workspace, |runtime_id| {
        state.process.is_runtime_in_use(runtime_id)
    }))
}

/// Probe a path without writing a record; the import dialog uses this.
pub(crate) async fn probe(_state: &FrpState, path: String) -> FrpResult<RuntimeProbe> {
    let path = require_path(&path)?.to_string();
    blocking(move || Ok(runtime_probe::probe(&path))).await
}

/// Import a path, or re-probe and update the record already pointing at it.
pub(crate) async fn import(state: &FrpState, path: String) -> FrpResult<RuntimeRecord> {
    let path = require_path(&path)?.to_string();

    let target = path.clone();
    let probe = blocking(move || Ok(runtime_probe::probe(&target))).await?;

    store::update(state, |workspace| {
        runtimes::import(workspace, Path::new(&path), &probe)
    })
}

pub(crate) async fn delete(state: &FrpState, id: String) -> FrpResult<()> {
    let id = require_id(&id)?;
    store::update(state, |workspace| {
        runtimes::delete(workspace, id, |runtime_id| {
            state.process.is_runtime_in_use(runtime_id)
        })
    })
}

pub(crate) async fn discover(state: &FrpState, deep: bool) -> FrpResult<Vec<DiscoveredRuntime>> {
    let installed = store::current(state)?.runtimes;
    blocking(move || Ok(runtime_discover::discover(&installed, deep))).await
}
