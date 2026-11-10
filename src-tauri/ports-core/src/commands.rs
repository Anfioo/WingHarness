// Ported from Porter (https://github.com/t21dev/porter-app), MIT License.
// See ../UPSTREAM.md for the porting record.

use crate::error::{PortsError, PortsResult};
use crate::models::{PortDetail, PortEntry, PortsSettings, MAX_PINNED_PORTS};
use crate::{elevate, process, scan, store};

/// Run blocking file or system IO off the async workers.
async fn run_blocking<T, F>(work: F) -> PortsResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> PortsResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| {
            PortsError::internal(format!("The ports task could not be completed: {error}."))
        })?
}

#[tauri::command]
pub async fn ports_settings_get() -> PortsResult<PortsSettings> {
    run_blocking(store::load).await
}

#[tauri::command]
pub async fn ports_settings_set(settings: PortsSettings) -> PortsResult<PortsSettings> {
    run_blocking(move || store::save(settings)).await
}

#[tauri::command]
pub async fn ports_list() -> PortsResult<Vec<PortEntry>> {
    run_blocking(scan::list_listening_ports).await
}

#[tauri::command]
pub async fn ports_pinned_scan(ports: Vec<u16>) -> PortsResult<Vec<PortEntry>> {
    if ports.len() > MAX_PINNED_PORTS {
        return Err(PortsError::invalid_input(
            "ports",
            "At most 50 pinned ports are allowed.",
        ));
    }
    if ports.contains(&0) {
        return Err(PortsError::invalid_input(
            "ports",
            "Port numbers must be between 1 and 65535.",
        ));
    }
    run_blocking(move || scan::scan_ports(&ports)).await
}

#[tauri::command]
pub async fn ports_detail(port: u16) -> PortsResult<Option<PortDetail>> {
    run_blocking(move || scan::port_detail(port)).await
}

#[tauri::command]
pub async fn ports_kill(pid: u32) -> PortsResult<()> {
    run_blocking(move || process::kill(pid)).await
}

#[tauri::command]
pub async fn ports_kill_elevated(pid: u32) -> PortsResult<()> {
    run_blocking(move || elevate::kill_elevated(pid)).await
}
