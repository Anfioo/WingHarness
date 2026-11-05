//! Tauri command bodies for the large-file lane.
//!
//! Scans, deletes, and session lookups run on the blocking pool so the WebView
//! stays responsive. Native diagnostics stay in logs; only stable error codes
//! cross the process boundary.

use crate::error::{SystoolsError, SystoolsResult};
use crate::filesystem::ScanExclusionOptions;
use crate::models::ScanNameExclusion;
use crate::shared::error::{CoreError, CoreErrorCode};
use crate::storage::large_files::models::{
    LargeFileScanMode, LargeFilesResult, PermanentDeleteBatchResult,
};
use crate::storage::large_files::LargeFileService;

/// Maps a domain failure onto the stable command error shape.
fn core_error(operation: &'static str, error: CoreError) -> SystoolsError {
    log::warn!(
        "systools_large_files_command_failed operation={operation} code={:?} diagnostic={}",
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
    log::warn!("systools_large_files_command_join_failed operation={operation}");
    SystoolsError::task_join_failed(operation)
}

pub async fn scan(
    app: &tauri::AppHandle,
    roots: Vec<String>,
    minimum_bytes: u64,
    scan_mode: LargeFileScanMode,
    excluded_paths: Vec<String>,
    excluded_names: Option<Vec<ScanNameExclusion>>,
) -> SystoolsResult<LargeFilesResult> {
    const OPERATION: &str = "systools_large_files_scan";
    let exclusions = ScanExclusionOptions {
        paths: excluded_paths,
        names: excluded_names.unwrap_or_default(),
    };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        LargeFileService::find_with_progress(
            roots,
            minimum_bytes,
            scan_mode,
            exclusions,
            move |progress| {
                crate::events::emit(&app, crate::events::LARGE_FILES_PROGRESS, progress);
            },
        )
    })
    .await
    .map_err(|_| join_failed(OPERATION))?
    .map_err(|error| core_error(OPERATION, error))
}

pub async fn filter(scan_id: u64, minimum_bytes: u64) -> SystoolsResult<LargeFilesResult> {
    const OPERATION: &str = "systools_large_files_filter";
    tauri::async_runtime::spawn_blocking(move || {
        LargeFileService::filter(scan_id, minimum_bytes)
    })
    .await
    .map_err(|_| join_failed(OPERATION))?
    .map_err(|error| core_error(OPERATION, error))
}

pub fn cancel() -> SystoolsResult<()> {
    LargeFileService::cancel();
    Ok(())
}

pub async fn delete(
    scan_id: u64,
    selected_paths: Vec<String>,
) -> SystoolsResult<PermanentDeleteBatchResult> {
    const OPERATION: &str = "systools_large_files_delete";
    tauri::async_runtime::spawn_blocking(move || {
        LargeFileService::delete_files_permanently(scan_id, selected_paths)
    })
    .await
    .map_err(|_| join_failed(OPERATION))?
    .map_err(|error| core_error(OPERATION, error))
}

/// Reveals one scanned file after the session confirms it belongs to the scan.
///
/// The filesystem lane owns the shared open command; this helper only proves the
/// request came from a published scan instead of an arbitrary WebView path.
/// `systools_open_large_file_entry` still routes through the filesystem lane, so
/// the delegation is pending and this entry point is kept for it.
#[allow(dead_code)]
pub(crate) async fn open_entry(scan_id: u64, selected_path: String) -> SystoolsResult<()> {
    const OPERATION: &str = "systools_open_large_file_entry";
    let target = tauri::async_runtime::spawn_blocking(move || {
        let target = LargeFileService::resolve_open_target(scan_id, selected_path)?;
        match std::fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.is_file() => Ok(target),
            Ok(_) => Err(CoreError::operation_failed(
                "the selected large file is no longer a regular file",
            )),
            Err(error) => Err(CoreError::operation_failed(format!(
                "the selected large file is unavailable: {error}"
            ))),
        }
    })
    .await
    .map_err(|_| join_failed(OPERATION))?
    .map_err(|error| core_error(OPERATION, error))?;
    crate::filesystem::commands::reveal_in_file_manager(target).await
}
