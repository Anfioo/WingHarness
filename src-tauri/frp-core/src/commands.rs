//! The 25 Tauri commands of the FRP console.
//!
//! Every function here is a thin forwarder: argument decoding, then straight to
//! its lane module. The command names and argument names below are frozen and
//! must not change.

pub(crate) mod config;
pub(crate) mod logs;
pub(crate) mod process;
pub(crate) mod profiles;
pub(crate) mod runtime;
pub(crate) mod tunnels;

use crate::error::FrpResult;
use crate::models::{
    BatchResult, ConfigImportPreview, ConfigImportResult, ConfigImportSource, ConfigPreview,
    ConfigVerifyResult, ConnectionSnapshot, DiscoveredRuntime, FrpProfile, FrpProfileInput,
    FrpProfilesView, LogEntry, RuntimePolicy, RuntimeProbe, RuntimeRecord, RuntimeView, Tunnel,
    TunnelInput, TunnelView,
};
use crate::state::FrpState;

// Profiles.

#[tauri::command]
pub async fn frp_profiles_list(state: tauri::State<'_, FrpState>) -> FrpResult<FrpProfilesView> {
    profiles::list(&state).await
}

#[tauri::command]
pub async fn frp_profile_create(
    state: tauri::State<'_, FrpState>,
    input: FrpProfileInput,
) -> FrpResult<FrpProfile> {
    profiles::create(&state, input).await
}

#[tauri::command]
pub async fn frp_profile_update(
    state: tauri::State<'_, FrpState>,
    id: String,
    input: FrpProfileInput,
) -> FrpResult<FrpProfile> {
    profiles::update(&state, &id, input).await
}

/// Stops the profile's process first, then cascades to tunnels, config and logs.
#[tauri::command]
pub async fn frp_profile_delete(
    state: tauri::State<'_, FrpState>,
    id: String,
) -> FrpResult<()> {
    profiles::delete(&state, &id).await
}

#[tauri::command]
pub async fn frp_profile_reorder(
    state: tauri::State<'_, FrpState>,
    ids: Vec<String>,
) -> FrpResult<()> {
    profiles::reorder(&state, ids).await
}

// Tunnels.

#[tauri::command]
pub async fn frp_tunnels_list(
    state: tauri::State<'_, FrpState>,
    profile_id: Option<String>,
) -> FrpResult<Vec<TunnelView>> {
    tunnels::list(&state, profile_id.as_deref()).await
}

#[tauri::command]
pub async fn frp_tunnel_create(
    state: tauri::State<'_, FrpState>,
    input: TunnelInput,
) -> FrpResult<Tunnel> {
    tunnels::create(&state, input).await
}

#[tauri::command]
pub async fn frp_tunnel_update(
    state: tauri::State<'_, FrpState>,
    id: String,
    input: TunnelInput,
) -> FrpResult<Tunnel> {
    tunnels::update(&state, &id, input).await
}

#[tauri::command]
pub async fn frp_tunnel_delete(
    state: tauri::State<'_, FrpState>,
    id: String,
) -> FrpResult<()> {
    tunnels::delete(&state, &id).await
}

// Runtimes.

#[tauri::command]
pub async fn frp_runtimes_list(state: tauri::State<'_, FrpState>) -> FrpResult<Vec<RuntimeView>> {
    runtime::list(&state).await
}

#[tauri::command]
pub async fn frp_runtime_probe(
    state: tauri::State<'_, FrpState>,
    path: String,
) -> FrpResult<RuntimeProbe> {
    runtime::probe(&state, path).await
}

#[tauri::command]
pub async fn frp_runtime_import(
    state: tauri::State<'_, FrpState>,
    path: String,
) -> FrpResult<RuntimeRecord> {
    runtime::import(&state, path).await
}

#[tauri::command]
pub async fn frp_runtime_delete(
    state: tauri::State<'_, FrpState>,
    id: String,
) -> FrpResult<()> {
    runtime::delete(&state, id).await
}

#[tauri::command]
pub async fn frp_runtimes_discover(
    state: tauri::State<'_, FrpState>,
    deep: bool,
) -> FrpResult<Vec<DiscoveredRuntime>> {
    runtime::discover(&state, deep).await
}

// Processes.

#[tauri::command]
pub async fn frp_start(
    state: tauri::State<'_, FrpState>,
    profile_id: String,
) -> FrpResult<ConnectionSnapshot> {
    process::start(state, profile_id).await
}

#[tauri::command]
pub async fn frp_stop(
    state: tauri::State<'_, FrpState>,
    profile_id: String,
) -> FrpResult<ConnectionSnapshot> {
    process::stop(state, profile_id).await
}

#[tauri::command]
pub async fn frp_restart(
    state: tauri::State<'_, FrpState>,
    profile_id: String,
) -> FrpResult<ConnectionSnapshot> {
    process::restart(state, profile_id).await
}

#[tauri::command]
pub async fn frp_start_all(state: tauri::State<'_, FrpState>) -> FrpResult<BatchResult> {
    process::start_all(state).await
}

#[tauri::command]
pub async fn frp_stop_all(state: tauri::State<'_, FrpState>) -> FrpResult<BatchResult> {
    process::stop_all(state).await
}

#[tauri::command]
pub async fn frp_connections_list(
    state: tauri::State<'_, FrpState>,
) -> FrpResult<Vec<ConnectionSnapshot>> {
    process::connections_list(state).await
}

/// Forces an immediate health probe on every running process and returns how
/// many were probed.
#[tauri::command]
pub async fn frp_nudge_health(state: tauri::State<'_, FrpState>) -> FrpResult<u32> {
    process::nudge_health(state).await
}

// Config.

#[tauri::command]
pub async fn frp_config_preview(
    state: tauri::State<'_, FrpState>,
    profile_id: String,
) -> FrpResult<ConfigPreview> {
    config::preview(&state, &profile_id).await
}

#[tauri::command]
pub async fn frp_config_verify(
    state: tauri::State<'_, FrpState>,
    profile_id: String,
) -> FrpResult<ConfigVerifyResult> {
    config::verify(&state, &profile_id).await
}

/// Parse a source without writing anything.
#[tauri::command]
pub async fn frp_config_import_preview(
    source: ConfigImportSource,
) -> FrpResult<ConfigImportPreview> {
    config::import_preview(source).await
}

/// Import a source as one new profile with its tunnels; never merges.
#[tauri::command]
pub async fn frp_config_import(
    state: tauri::State<'_, FrpState>,
    source: ConfigImportSource,
    name: Option<String>,
    apply_token: Option<bool>,
    runtime_policy: Option<RuntimePolicy>,
    runtime_id: Option<String>,
) -> FrpResult<ConfigImportResult> {
    config::import(
        &state,
        source,
        name,
        apply_token.unwrap_or(true),
        runtime_policy.unwrap_or_default(),
        runtime_id,
    )
    .await
}

// Logs.

#[tauri::command]
pub async fn frp_logs_recent(
    state: tauri::State<'_, FrpState>,
    profile_id: Option<String>,
    limit: Option<u32>,
) -> FrpResult<Vec<LogEntry>> {
    logs::recent(state, profile_id, limit).await
}

#[tauri::command]
pub async fn frp_logs_clear(
    state: tauri::State<'_, FrpState>,
    profile_id: Option<String>,
) -> FrpResult<()> {
    logs::clear(state, profile_id).await
}
