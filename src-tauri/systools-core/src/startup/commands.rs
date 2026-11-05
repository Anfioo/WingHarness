//! Tauri command bodies for the startup items lane.
//!
//! Scans and change execution move to the blocking pool so the WebView stays
//! responsive. Native diagnostics stay in logs; only stable error codes cross
//! the process boundary.

use crate::error::{SystoolsError, SystoolsResult};
use crate::shared::error::{CoreError, CoreErrorCode};
use crate::startup::models::{
    StartupCatalog, StartupChangePlan, StartupChangeResult, StartupChangeSelection,
};
use crate::startup::platform::{StartupScanProgress, StartupSourceScanProgress};
use crate::startup::service;

/// One event per finished native source, emitted while the scan is still running.
const STARTUP_SCAN_PROGRESS_EVENT: &str = "systools:startup-scan-progress";

/// Forwards each finished source to the WebView so the page can show progress
/// instead of an indefinite spinner.
struct EmittingScanProgress {
    app: tauri::AppHandle,
}

impl StartupScanProgress for EmittingScanProgress {
    fn source_finished(&self, progress: StartupSourceScanProgress) {
        crate::events::emit(&self.app, STARTUP_SCAN_PROGRESS_EVENT, progress);
    }
}

/// Maps a domain failure onto the stable command error shape.
fn core_error(operation: &'static str, error: CoreError) -> SystoolsError {
    log::warn!(
        "systools_startup_command_failed operation={operation} code={:?} diagnostic={}",
        error.code(),
        error.diagnostic()
    );
    match error.code() {
        CoreErrorCode::OperationBusy => SystoolsError::busy(operation),
        CoreErrorCode::OperationCancelled => SystoolsError::cancelled(),
        CoreErrorCode::InvalidInput => SystoolsError::invalid_input(operation),
        CoreErrorCode::PermissionDenied => SystoolsError::permission_denied(operation),
        CoreErrorCode::Persistence => SystoolsError::persistence(operation),
        CoreErrorCode::Platform | CoreErrorCode::OperationFailed => {
            SystoolsError::operation_failed(operation)
        }
    }
}

fn join_failed(operation: &'static str) -> SystoolsError {
    log::warn!("systools_startup_command_join_failed operation={operation}");
    SystoolsError::task_join_failed(operation)
}

pub async fn scan(app: &tauri::AppHandle) -> SystoolsResult<StartupCatalog> {
    let progress = EmittingScanProgress { app: app.clone() };
    tauri::async_runtime::spawn_blocking(move || {
        service::service().scan_with_progress(&progress)
    })
    .await
    .map_err(|_| join_failed("systools_startup_scan"))?
    .map_err(|error| core_error("systools_startup_scan", error))
}

pub fn cancel_scan() -> SystoolsResult<()> {
    service::service()
        .cancel_scan()
        .map_err(|error| core_error("systools_startup_cancel_scan", error))
}

pub async fn prepare_change(
    selection: StartupChangeSelection,
) -> SystoolsResult<StartupChangePlan> {
    tauri::async_runtime::spawn_blocking(move || service::service().prepare_change(selection))
        .await
        .map_err(|_| join_failed("systools_startup_prepare_change"))?
        .map_err(|error| core_error("systools_startup_prepare_change", error))
}

pub async fn execute_change(
    plan_id: String,
    authorization_prompt: String,
) -> SystoolsResult<StartupChangeResult> {
    tauri::async_runtime::spawn_blocking(move || {
        service::service().execute_change(&plan_id, &authorization_prompt)
    })
    .await
    .map_err(|_| join_failed("systools_startup_execute_change"))?
    .map_err(|error| core_error("systools_startup_execute_change", error))
}

pub fn cancel_change() -> SystoolsResult<()> {
    service::service()
        .cancel_change()
        .map_err(|error| core_error("systools_startup_cancel_change", error))
}
