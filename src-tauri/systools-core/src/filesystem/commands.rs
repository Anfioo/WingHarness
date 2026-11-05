//! Tauri command bodies for the shared filesystem lane.
//!
//! Volume enumeration and directory resolution touch the operating system, so
//! they run on the blocking pool. Native diagnostics stay in logs; the WebView
//! receives only stable error codes it can localize.

use std::path::Path;

use crate::error::{SystoolsError, SystoolsErrorCode, SystoolsResult};
use crate::filesystem::directory_selection::DirectorySelectionService;
use crate::filesystem::metadata::diagnostic_path;
use crate::platform::contracts::{current_platform, Platform, PlatformError, PlatformErrorCode};

pub use crate::filesystem::models::{
    DirectorySelectionOutcome, FileIconBatch, FileIconRequest, VolumeInfo,
};

/// Matches the reference adapter's batch ceiling so one request cannot pin the
/// blocking pool while resolving an unbounded directory list.
const MAX_DIRECTORY_ENTRIES_PER_REQUEST: usize = 64;

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

/// Lists mounted volumes in the stable presentation shape.
///
/// The ported core keeps no capacity cache, so every request reads live volume
/// capacity. The refresh hint therefore only marks an explicit user-initiated
/// reload in logs; `refresh == Some(true)` never selects a stale snapshot.
pub async fn volumes_list(refresh: Option<bool>) -> SystoolsResult<Vec<VolumeInfo>> {
    const OPERATION: &str = "systools_volumes_list";
    let force_refresh = refresh.unwrap_or(false);
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let volumes = current_platform()
            .volumes()?
            .into_iter()
            .map(VolumeInfo::from)
            .collect::<Vec<_>>();
        log::info!(
            "systools_volumes_listed refresh={} volume_count={} elapsed_ms={}",
            force_refresh,
            volumes.len(),
            started.elapsed().as_millis()
        );
        Ok::<_, PlatformError>(volumes)
    })
    .await;
    joined
        .map_err(|_| join_failed(OPERATION))?
        .map_err(|error| platform_error(OPERATION, error))
}

/// Reports capacity for the volume that hosts the operating system.
pub async fn system_disk() -> SystoolsResult<VolumeInfo> {
    const OPERATION: &str = "systools_system_disk";
    let joined = tauri::async_runtime::spawn_blocking(|| {
        let started = std::time::Instant::now();
        let disk = VolumeInfo::from(current_platform().system_volume()?);
        log::info!(
            "system_disk_capacity_read total_bytes={} available_bytes={} used_bytes={} elapsed_ms={}",
            disk.total_bytes,
            disk.available_bytes,
            disk.used_bytes,
            started.elapsed().as_millis()
        );
        Ok::<_, PlatformError>(disk)
    })
    .await;
    joined
        .map_err(|_| join_failed(OPERATION))?
        .map_err(|error| platform_error(OPERATION, error))
}

/// Resolves explicitly selected entry points to physical directories.
pub async fn filter_directory_paths(
    paths: Vec<String>,
) -> SystoolsResult<DirectorySelectionOutcome> {
    const OPERATION: &str = "systools_filter_directory_paths";
    if paths.len() > MAX_DIRECTORY_ENTRIES_PER_REQUEST {
        log::info!(
            "directory_entries_rejected reason=request_limit_exceeded requested_count={} maximum_count={MAX_DIRECTORY_ENTRIES_PER_REQUEST}",
            paths.len()
        );
        return Err(SystoolsError::invalid_input(OPERATION));
    }
    let joined =
        tauri::async_runtime::spawn_blocking(move || DirectorySelectionService::resolve(paths))
            .await;
    joined.map_err(|_| join_failed(OPERATION))
}

/// Highlights an entry in File Explorer after the platform confirms the target.
pub async fn reveal_in_file_manager(path: String) -> SystoolsResult<()> {
    const OPERATION: &str = "systools_reveal_in_file_manager";
    let joined = tauri::async_runtime::spawn_blocking(move || reveal_entry(OPERATION, &path)).await;
    joined.map_err(|_| join_failed(OPERATION))?
}

fn reveal_entry(operation: &'static str, path: &str) -> SystoolsResult<()> {
    let requested = Path::new(path);
    log::info!("file_manager_reveal_requested path={}", diagnostic_path(requested));
    let platform = current_platform();
    let canonical = platform
        .canonicalize_no_links(requested)
        .map_err(|error| platform_error(operation, error))?;
    let target = platform.display_path(&canonical);
    // `/select,` highlights the entry inside its folder, which also covers a
    // directory target without opening a second Explorer window.
    match std::process::Command::new("explorer")
        .arg(format!("/select,{target}"))
        .spawn()
    {
        Ok(_) => {
            log::info!("file_manager_reveal_finished path={target}");
            Ok(())
        }
        Err(error) => {
            log::warn!(
                "file_manager_reveal_failed path={target} error_kind={:?} error={}",
                error.kind(),
                error
            );
            Err(SystoolsError::operation_failed(operation))
        }
    }
}

pub async fn open_analysis_entry(_scan_id: u64, _selected_path: String) -> SystoolsResult<()> {
    crate::error::not_implemented("systools_open_analysis_entry")
}

pub async fn open_large_file_entry(_scan_id: u64, _selected_path: String) -> SystoolsResult<()> {
    crate::error::not_implemented("systools_open_large_file_entry")
}

pub async fn open_duplicate_entry(_scan_id: u64, _selected_path: String) -> SystoolsResult<()> {
    crate::error::not_implemented("systools_open_duplicate_entry")
}

pub async fn file_icons(
    _app: &tauri::AppHandle,
    _requests: Vec<FileIconRequest>,
) -> SystoolsResult<FileIconBatch> {
    crate::error::not_implemented("systools_file_icons")
}
