//! Tauri command bodies for the system-settings lane.
//!
//! Scanning, planning, and execution all touch the operating system, so they
//! move to the blocking pool. Core diagnostics stay in logs; the UI receives
//! only stable error codes it can localize.

use crate::error::{SystoolsError, SystoolsResult};
use crate::shared::{CoreError, CoreErrorCode};
use crate::system_settings::models::{
    SystemSettingsCatalog, SystemSettingsChangePlan, SystemSettingsChangeResult,
    SystemSettingsChangeSelection,
};
use crate::system_settings::service::{service, SystemSettingsService};

const SCAN_OPERATION: &str = "systools_system_settings_scan";
const PREPARE_CHANGE_OPERATION: &str = "systools_system_settings_prepare_change";
const EXECUTE_CHANGE_OPERATION: &str = "systools_system_settings_execute_change";

fn join_failed(operation: &'static str) -> SystoolsError {
    log::warn!("systools_command_join_failed operation={operation}");
    SystoolsError::task_join_failed(operation)
}

fn command_error(operation: &'static str, error: CoreError) -> SystoolsError {
    log::warn!(
        "systools_system_settings_command_failed operation={operation} code={:?} diagnostic={}",
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

pub async fn scan() -> SystoolsResult<SystemSettingsCatalog> {
    let joined = tauri::async_runtime::spawn_blocking(|| service().scan()).await;
    joined
        .map_err(|_| join_failed(SCAN_OPERATION))?
        .map_err(|error| command_error(SCAN_OPERATION, error))
}

pub fn cancel_scan() -> SystoolsResult<()> {
    SystemSettingsService::cancel_scan();
    Ok(())
}

pub async fn prepare_change(
    selection: SystemSettingsChangeSelection,
) -> SystoolsResult<SystemSettingsChangePlan> {
    let joined = tauri::async_runtime::spawn_blocking(move || service().prepare_change(selection))
        .await;
    joined
        .map_err(|_| join_failed(PREPARE_CHANGE_OPERATION))?
        .map_err(|error| command_error(PREPARE_CHANGE_OPERATION, error))
}

pub async fn execute_change(plan_id: String) -> SystoolsResult<SystemSettingsChangeResult> {
    let joined =
        tauri::async_runtime::spawn_blocking(move || service().execute_change(plan_id)).await;
    joined
        .map_err(|_| join_failed(EXECUTE_CHANGE_OPERATION))?
        .map_err(|error| command_error(EXECUTE_CHANGE_OPERATION, error))
}
