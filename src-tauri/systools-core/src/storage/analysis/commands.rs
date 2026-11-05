//! Tauri command bodies for the disk analysis lane.
//!
//! Scans, session lookups, exports, and permanent deletion run on the blocking
//! pool so the WebView stays responsive. Native diagnostics stay in logs; only
//! stable error codes cross the process boundary.

use crate::error::{SystoolsError, SystoolsResult};
use crate::filesystem::ScanExclusionOptions;
use crate::models::ScanNameExclusion;
use crate::shared::error::{CoreError, CoreErrorCode};
use crate::storage::analysis::models::{
    AnalysisDeleteBatchResult, AnalysisRemainderPage, AnalysisRemainderRequest, AnalysisResult,
    AnalysisScanMode,
};
use crate::storage::analysis::AnalysisService;

/// Maps a domain failure onto the stable command error shape.
fn core_error(operation: &'static str, error: CoreError) -> SystoolsError {
    log::warn!(
        "systools_analysis_command_failed operation={operation} code={:?} diagnostic={}",
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
    log::warn!("systools_analysis_command_join_failed operation={operation}");
    SystoolsError::task_join_failed(operation)
}

pub async fn scan(
    app: &tauri::AppHandle,
    path: Option<String>,
    refresh: bool,
    excluded_paths: Vec<String>,
    excluded_names: Option<Vec<ScanNameExclusion>>,
    scan_mode: Option<AnalysisScanMode>,
) -> SystoolsResult<AnalysisResult> {
    const OPERATION: &str = "systools_analysis_scan";
    let exclusions = ScanExclusionOptions {
        paths: excluded_paths,
        names: excluded_names.unwrap_or_default(),
    };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        AnalysisService::analyze_with_mode_progress(
            path,
            refresh,
            exclusions,
            scan_mode.unwrap_or_default(),
            move |progress| {
                crate::events::emit(&app, crate::events::ANALYSIS_PROGRESS, progress);
            },
        )
    })
    .await
    .map_err(|_| join_failed(OPERATION))?
    .map_err(|error| core_error(OPERATION, error))
}

pub fn cancel() -> SystoolsResult<()> {
    AnalysisService::cancel();
    Ok(())
}

pub async fn remainder_list(
    request: AnalysisRemainderRequest,
) -> SystoolsResult<AnalysisRemainderPage> {
    const OPERATION: &str = "systools_analysis_remainder_list";
    tauri::async_runtime::spawn_blocking(move || AnalysisService::list_remainder(request))
        .await
        .map_err(|_| join_failed(OPERATION))?
        .map_err(|error| core_error(OPERATION, error))
}

pub async fn remainder_release(snapshot_id: u64) -> SystoolsResult<()> {
    const OPERATION: &str = "systools_analysis_remainder_release";
    tauri::async_runtime::spawn_blocking(move || AnalysisService::release_remainder(snapshot_id))
        .await
        .map_err(|_| join_failed(OPERATION))?
        .map_err(|error| core_error(OPERATION, error))
}

/// Prepares the export from the retained scan session and writes it to the
/// destination the UI already picked.
///
/// Core never opens a native file picker; without a destination the request is
/// answered with `None` so the caller can prompt and retry.
pub async fn export(
    _window: tauri::Window,
    request: crate::reporting::AnalysisExportRequest,
    _dialog_title: String,
) -> SystoolsResult<Option<crate::reporting::AnalysisExportReceipt>> {
    const OPERATION: &str = "systools_analysis_export";
    log::info!(
        "systools_analysis_export_requested scan_id={} format={} destination={} dialog_title={}",
        request.scan_id,
        request.format.as_str(),
        crate::platform::contracts::diagnostics::text(
            request.path.as_deref().unwrap_or("<unsaved>")
        ),
        _dialog_title
    );
    let destination = request.path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let report = AnalysisService::prepare_export(request)?;
        match destination {
            Some(path) => report
                .save(std::path::Path::new(&path))
                .map(Some),
            None => Ok(None),
        }
    })
    .await
    .map_err(|_| join_failed(OPERATION))?
    .map_err(|error| core_error(OPERATION, error))
}

pub async fn delete_entries(
    scan_id: u64,
    selected_paths: Vec<String>,
) -> SystoolsResult<AnalysisDeleteBatchResult> {
    const OPERATION: &str = "systools_analysis_delete_entries";
    tauri::async_runtime::spawn_blocking(move || {
        AnalysisService::delete_entries_permanently(scan_id, selected_paths)
    })
    .await
    .map_err(|_| join_failed(OPERATION))?
    .map_err(|error| core_error(OPERATION, error))
}

/// Reveals one published analysis entry in the system file manager.
///
/// The session must prove the path came from a real scan before the filesystem
/// lane canonicalizes it and asks Explorer to select it. This body is not wired
/// to a registered command yet; `filesystem::commands::open_analysis_entry` is
/// still a stub owned by another lane.
#[allow(dead_code)]
pub async fn open_entry(scan_id: u64, selected_path: String) -> SystoolsResult<()> {
    const OPERATION: &str = "systools_open_analysis_entry";
    let target = tauri::async_runtime::spawn_blocking(move || {
        AnalysisService::resolve_open_target(scan_id, selected_path)
    })
    .await
    .map_err(|_| join_failed(OPERATION))?
    .map_err(|error| core_error(OPERATION, error))?;
    crate::filesystem::commands::reveal_in_file_manager(target).await
}
