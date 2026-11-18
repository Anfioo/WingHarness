//! The task manager page's thin command surface.
//!
//! Every command is registered in four places: `invoke.rs`, `build.rs`,
//! `capabilities/default.json` and the generated permission files. A0 exposes
//! all thirteen names and returns `not-implemented` for the ones the parallel
//! backend tracks have not ported yet; settings and service status already
//! return usable defaults so the page can render.

use argus_core::actions::{Priority, TreeKillReport};
use argus_core::collector::Snapshot;
use argus_core::details::ProcessDetails;
use argus_core::models::ArgusSettings;
use argus_core::ArgusError;
use argus_service::ServiceStatus;
use tauri::ipc::Channel;
use tauri::State;

use crate::argus::{service, store, ArgusState};

#[tauri::command]
pub fn argus_snapshot_start(
    state: State<'_, ArgusState>,
    channel: Channel<Snapshot>,
    interval_ms: u64,
) -> Result<(), ArgusError> {
    state.sampler.start(channel, interval_ms)
}

#[tauri::command]
pub fn argus_snapshot_stop(state: State<'_, ArgusState>) -> Result<(), ArgusError> {
    state.sampler.stop();
    Ok(())
}

#[tauri::command]
pub fn argus_set_interval(interval_ms: u64) -> Result<ArgusSettings, ArgusError> {
    store::set(ArgusSettings::with_interval_ms(interval_ms))
}

#[tauri::command]
pub fn argus_refresh() -> Result<(), ArgusError> {
    Ok(())
}

#[tauri::command]
pub fn argus_settings_get() -> Result<ArgusSettings, ArgusError> {
    store::get()
}

#[tauri::command]
pub fn argus_settings_set(settings: ArgusSettings) -> Result<ArgusSettings, ArgusError> {
    store::set(settings)
}

#[tauri::command]
pub fn argus_process_details(pid: u32) -> Result<ProcessDetails, ArgusError> {
    let _ = pid;
    Err(ArgusError::not_implemented())
}

#[tauri::command]
pub fn argus_kill_process(
    pid: u32,
    create_time: i64,
    force: bool,
) -> Result<(), ArgusError> {
    let _ = (pid, create_time, force);
    Err(ArgusError::not_implemented())
}

#[tauri::command]
pub fn argus_kill_process_tree(pid: u32, create_time: i64) -> Result<TreeKillReport, ArgusError> {
    let _ = (pid, create_time);
    Err(ArgusError::not_implemented())
}

#[tauri::command]
pub fn argus_set_priority(
    pid: u32,
    create_time: i64,
    priority: Priority,
) -> Result<Priority, ArgusError> {
    let _ = (pid, create_time, priority);
    Err(ArgusError::not_implemented())
}

#[tauri::command]
pub fn argus_set_efficiency(
    pid: u32,
    create_time: i64,
    on: bool,
) -> Result<(), ArgusError> {
    let _ = (pid, create_time, on);
    Err(ArgusError::not_implemented())
}

#[tauri::command]
pub fn argus_service_status() -> Result<ServiceStatus, ArgusError> {
    service::status()
}

#[tauri::command]
pub fn argus_service_manage(action: String) -> Result<ServiceStatus, ArgusError> {
    service::manage(&action)
}
