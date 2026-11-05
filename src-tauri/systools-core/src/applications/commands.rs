//! Tauri command bodies for the application inventory, uninstall, and leftover
//! lanes.
//!
//! Long-running work moves to the blocking pool so the WebView stays
//! responsive. Cancellation is cooperative: the caller stores a token, every
//! cancellable stage polls it, and the cancel commands flip it.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use crate::applications::contracts::Cancellation;
use crate::applications::leftovers::service as leftover_service;
use crate::applications::models::{
    ApplicationIcon, ApplicationLeftoverPlanItem, ApplicationLeftoverResult,
    ApplicationLeftoverScanResult, ApplicationUninstallBatchPlan,
    ApplicationUninstallBatchPreparation, ApplicationUninstallBatchResult,
    ApplicationUninstallBatchSelection, ApplicationUninstallCloseRequest,
    ApplicationUninstallCloseResponse, ApplicationUninstallIdentity,
    ApplicationUninstallScanResult,
};
use crate::applications::service_state;
use crate::applications::uninstall::service as uninstall_service;
use crate::error::{SystoolsError, SystoolsErrorCode, SystoolsResult};
use crate::platform::contracts::{PlatformError, PlatformErrorCode};
use crate::shared::operation::OperationCancellationToken;

static LEFTOVER_SCAN: OnceLock<Mutex<Option<Cancellation>>> = OnceLock::new();

fn leftover_scan_slot() -> &'static Mutex<Option<Cancellation>> {
    LEFTOVER_SCAN.get_or_init(|| Mutex::new(None))
}

fn join_failed(operation: &'static str) -> SystoolsError {
    log::warn!("systools_command_join_failed operation={operation}");
    SystoolsError::task_join_failed(operation)
}

fn platform_error(operation: &'static str, error: PlatformError) -> SystoolsError {
    log::warn!(
        "systools_platform_error operation={operation} code={:?} diagnostic={}",
        error.code(),
        error.diagnostic()
    );
    match error.code() {
        PlatformErrorCode::AccessDenied => SystoolsError::permission_denied(operation),
        PlatformErrorCode::UserCancelled => SystoolsError::cancelled(),
        PlatformErrorCode::InvalidData | PlatformErrorCode::InvalidPath => {
            SystoolsError::invalid_input(operation)
        }
        PlatformErrorCode::Unsupported => {
            SystoolsError::new(SystoolsErrorCode::OperationFailed, Some(operation), false)
        }
        PlatformErrorCode::ItemChanged
        | PlatformErrorCode::Io
        | PlatformErrorCode::OperationFailed => SystoolsError::operation_failed(operation),
    }
}

fn icon_cache_root() -> SystoolsResult<PathBuf> {
    let directory = crate::paths::dir()?.join("icons");
    std::fs::create_dir_all(&directory).map_err(|error| {
        log::warn!(
            "systools_icon_cache_dir_create_failed path={} error={error}",
            directory.display()
        );
        SystoolsError::persistence("systools_application_icons")
    })?;
    Ok(directory)
}

pub async fn scan(app: &tauri::AppHandle) -> SystoolsResult<ApplicationUninstallScanResult> {
    let cancellation = service_state::begin_scan();
    let app = app.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let report = |progress| {
            crate::events::emit(&app, crate::events::UNINSTALL_PROGRESS, progress);
        };
        uninstall_service::scan(&cancellation, &report)
    })
    .await;
    service_state::finish_scan();
    joined.map_err(|_| join_failed("systools_uninstall_scan"))?
}

pub fn cancel_scan() -> SystoolsResult<()> {
    service_state::cancel_scan();
    OperationCancellationToken::application_scan().cancel();
    Ok(())
}

pub async fn describe_identity(
    application_id: String,
    catalog_revision: String,
) -> SystoolsResult<ApplicationUninstallIdentity> {
    tauri::async_runtime::spawn_blocking(move || {
        uninstall_service::describe_identity(&application_id, &catalog_revision)
    })
    .await
    .map_err(|_| join_failed("systools_uninstall_describe_identity"))?
}

pub async fn close_applications(
    request: ApplicationUninstallCloseRequest,
    catalog_revision: String,
) -> SystoolsResult<ApplicationUninstallCloseResponse> {
    tauri::async_runtime::spawn_blocking(move || {
        uninstall_service::close_applications(request, &catalog_revision)
    })
    .await
    .map_err(|_| join_failed("systools_uninstall_close_applications"))?
}

pub async fn prepare_batch(
    selections: Vec<ApplicationUninstallBatchSelection>,
    catalog_revision: String,
) -> SystoolsResult<ApplicationUninstallBatchPreparation> {
    tauri::async_runtime::spawn_blocking(move || {
        uninstall_service::prepare_batch(selections, &catalog_revision)
    })
    .await
    .map_err(|_| join_failed("systools_uninstall_prepare_batch"))?
}

pub async fn execute_batch(
    app: &tauri::AppHandle,
    plan: ApplicationUninstallBatchPlan,
    dry_run: bool,
    authorization_prompt: String,
) -> SystoolsResult<ApplicationUninstallBatchResult> {
    let app = app.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        uninstall_service::execute_batch(&app, plan, dry_run, &authorization_prompt)
    })
    .await;
    service_state::finish_execution();
    joined.map_err(|_| join_failed("systools_uninstall_execute_batch"))?
}

pub fn cancel_execution() -> SystoolsResult<()> {
    service_state::cancel_execution();
    OperationCancellationToken::applications().cancel();
    Ok(())
}

pub async fn remove_record(application_id: String) -> SystoolsResult<()> {
    tauri::async_runtime::spawn_blocking(move || uninstall_service::remove_record(&application_id))
        .await
        .map_err(|_| join_failed("systools_uninstall_remove_record"))?
}

pub async fn open_windows_apps() -> SystoolsResult<()> {
    tauri::async_runtime::spawn_blocking(
        crate::platform::windows::application_restart::open_windows_apps_settings,
    )
    .await
    .map_err(|_| join_failed("systools_uninstall_open_windows_apps"))?
    .map_err(|error| platform_error("systools_uninstall_open_windows_apps", error))
}

pub async fn scan_leftovers(
    app: &tauri::AppHandle,
) -> SystoolsResult<ApplicationLeftoverScanResult> {
    let cancellation = Cancellation::new();
    match leftover_scan_slot().lock() {
        Ok(mut slot) => *slot = Some(cancellation.clone()),
        Err(_) => log::warn!("systools_leftover_scan_slot_poisoned"),
    }
    let app = app.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let report = |progress| {
            crate::events::emit(&app, crate::events::LEFTOVERS_PROGRESS, progress);
        };
        leftover_service::scan(&cancellation, &report)
    })
    .await;
    if let Ok(mut slot) = leftover_scan_slot().lock() {
        *slot = None;
    }
    joined.map_err(|_| join_failed("systools_leftovers_scan"))?
}

pub async fn execute_leftovers(
    reviewed_items: Vec<ApplicationLeftoverPlanItem>,
    dry_run: bool,
    operation_id: String,
) -> SystoolsResult<ApplicationLeftoverResult> {
    tauri::async_runtime::spawn_blocking(move || {
        leftover_service::execute(reviewed_items, dry_run, &operation_id)
    })
    .await
    .map_err(|_| join_failed("systools_leftovers_execute"))?
}

pub fn cancel_leftovers() -> SystoolsResult<()> {
    if let Ok(slot) = leftover_scan_slot().lock() {
        if let Some(cancellation) = slot.as_ref() {
            cancellation.cancel();
        }
    }
    leftover_service::cancel();
    OperationCancellationToken::application_leftover_cleanup().cancel();
    Ok(())
}

pub async fn load_icons(
    _app: &tauri::AppHandle,
    paths: Vec<String>,
) -> SystoolsResult<Vec<ApplicationIcon>> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let cache_root = icon_cache_root()?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::platform::file_icon::load_application_icons(&paths, &cache_root)
    })
    .await
    .map_err(|_| join_failed("systools_application_icons"))
}
