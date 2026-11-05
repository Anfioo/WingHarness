//! Tauri command bodies for the duplicate-file lane.
//!
//! Scans, deletes, and session lookups run on the blocking pool so the WebView
//! stays responsive. Native diagnostics stay in logs; only stable error codes
//! cross the process boundary.

use crate::error::{SystoolsError, SystoolsResult};
use crate::filesystem::ScanExclusionOptions;
use crate::models::ScanNameExclusion;
use crate::shared::error::{CoreError, CoreErrorCode};
use crate::storage::duplicates::models::{
    DuplicateFilesResult, DuplicateGroupPage, DuplicateScanLocation, PermanentDeleteBatchResult,
    PermanentDeleteCandidate,
};
use crate::storage::duplicates::DuplicateFileService;

/// Maps a domain failure onto the stable command error shape.
fn core_error(operation: &'static str, error: CoreError) -> SystoolsError {
    log::warn!(
        "systools_duplicates_command_failed operation={operation} code={:?} diagnostic={}",
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
    log::warn!("systools_duplicates_command_join_failed operation={operation}");
    SystoolsError::task_join_failed(operation)
}

pub async fn scan(
    app: &tauri::AppHandle,
    locations: Vec<DuplicateScanLocation>,
    minimum_bytes: u64,
    excluded_paths: Vec<String>,
    excluded_names: Option<Vec<ScanNameExclusion>>,
) -> SystoolsResult<DuplicateFilesResult> {
    const OPERATION: &str = "systools_duplicates_scan";
    let exclusions = ScanExclusionOptions {
        paths: excluded_paths,
        names: excluded_names.unwrap_or_default(),
    };
    let progress_app = app.clone();
    let group_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        DuplicateFileService::find_paged_with_locations_and_exclusions(
            locations,
            exclusions,
            minimum_bytes,
            move |progress| {
                crate::events::emit(
                    &progress_app,
                    crate::events::DUPLICATE_PROGRESS,
                    progress,
                );
            },
            move |batch| {
                crate::events::emit(&group_app, crate::events::DUPLICATE_GROUPS, batch);
            },
        )
    })
    .await
    .map_err(|_| join_failed(OPERATION))?
    .map_err(|error| core_error(OPERATION, error))
}

pub fn cancel() -> SystoolsResult<()> {
    DuplicateFileService::cancel();
    Ok(())
}

pub async fn page(scan_id: u64, offset: u64, limit: u64) -> SystoolsResult<DuplicateGroupPage> {
    const OPERATION: &str = "systools_duplicates_page";
    tauri::async_runtime::spawn_blocking(move || DuplicateFileService::page(scan_id, offset, limit))
        .await
        .map_err(|_| join_failed(OPERATION))?
        .map_err(|error| core_error(OPERATION, CoreError::from(error)))
}

pub async fn delete(
    scan_id: u64,
    candidates: Vec<PermanentDeleteCandidate>,
) -> SystoolsResult<PermanentDeleteBatchResult> {
    const OPERATION: &str = "systools_duplicates_delete";
    tauri::async_runtime::spawn_blocking(move || {
        DuplicateFileService::delete_files_permanently(scan_id, candidates)
    })
    .await
    .map_err(|_| join_failed(OPERATION))?
    .map_err(|error| core_error(OPERATION, error))
}

/// Reveals one scanned duplicate after the session confirms it belongs to the scan.
///
/// The filesystem lane owns the shared open command; this helper only proves the
/// request came from a published scan instead of an arbitrary WebView path.
/// `systools_open_duplicate_entry` still routes through the filesystem lane, so
/// the delegation is pending and this entry point is kept for it.
#[allow(dead_code)]
pub(crate) async fn open_entry(scan_id: u64, selected_path: String) -> SystoolsResult<()> {
    const OPERATION: &str = "systools_open_duplicate_entry";
    let target = tauri::async_runtime::spawn_blocking(move || {
        let target = DuplicateFileService::resolve_open_target(scan_id, selected_path)?;
        match std::fs::symlink_metadata(&target) {
            Ok(_) => Ok(target),
            Err(error) => Err(CoreError::operation_failed(format!(
                "the selected duplicate is unavailable: {error}"
            ))),
        }
    })
    .await
    .map_err(|_| join_failed(OPERATION))?
    .map_err(|error| core_error(OPERATION, error))?;
    crate::filesystem::commands::reveal_in_file_manager(target).await
}
