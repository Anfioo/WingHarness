//! Large-file scan orchestration and explicit deletion.
//!
//! Discovery reuses the shared storage traversal kernel: mode selection, mount
//! and link policy, exclusion pruning, and progress accounting all live there.
//! This service adds the result session so the WebView can re-threshold a
//! completed scan, and it authorizes every permanent delete against that
//! session snapshot.

use std::{path::Path, time::Instant};

use crate::{
    filesystem::{
        metadata::diagnostic_path, permanent_delete::delete_selected_file_permanently,
        PermanentDeleteBatchResult, ScanExclusionOptions,
    },
    shared::{
        operation::{CoordinatedOperationKind, OperationGuard},
        CoreResult, ProgressSink,
    },
    storage::{
        index::cache,
        large_files::models::{LargeFileScanMode, LargeFilesResult},
        traversal::StorageTraversal,
    },
};

use super::session::{
    filter_result, publish_result_session, resolve_delete_candidates, resolve_open_target,
    synchronize_removed_paths,
};

pub struct LargeFileService;

/// Caps native diagnostics per batch so one hostile directory cannot flood the log.
const MAX_DELETE_FAILURE_LOGS: usize = 8;

impl LargeFileService {
    pub fn find_with_progress(
        roots: Vec<String>,
        minimum_bytes: u64,
        scan_mode: LargeFileScanMode,
        excluded_paths: impl Into<ScanExclusionOptions>,
        callback: impl ProgressSink,
    ) -> CoreResult<LargeFilesResult> {
        let excluded_paths = excluded_paths.into();
        let result = StorageTraversal::find_large_files_with_progress(
            roots,
            minimum_bytes,
            scan_mode,
            excluded_paths,
            move |progress| callback.report(progress),
        )?;
        Ok(publish_result_session(result)?)
    }

    pub fn filter(scan_id: u64, minimum_bytes: u64) -> CoreResult<LargeFilesResult> {
        let started = Instant::now();
        let result = filter_result(scan_id, minimum_bytes)?;
        let result = publish_result_session(result)?;
        log::info!(
            "large_file_filter_finished source_scan_id={} scan_id={} mode={} minimum_bytes={} total_count={} returned_count={} elapsed_ms={}",
            scan_id,
            result.scan_id,
            result.scan_mode.as_str(),
            result.minimum_bytes,
            result.total_count,
            result.returned_count,
            started.elapsed().as_millis()
        );
        Ok(result)
    }

    pub fn cancel() {
        StorageTraversal::cancel_large_files();
    }

    pub fn resolve_open_target(scan_id: u64, selected_path: String) -> CoreResult<String> {
        Ok(resolve_open_target(scan_id, &selected_path)?)
    }

    pub fn delete_files_permanently(
        scan_id: u64,
        selected_paths: Vec<String>,
    ) -> CoreResult<PermanentDeleteBatchResult> {
        let selection = resolve_delete_candidates(scan_id, selected_paths)?;
        let expected_bytes = selection.expected_allocated_bytes;
        let candidates = selection.candidates;
        let operation = OperationGuard::start(CoordinatedOperationKind::PermanentDelete)?;
        let started = Instant::now();
        let requested_count = candidates.len();
        let path_sample = candidates
            .iter()
            .take(3)
            .map(|candidate| diagnostic_path(Path::new(&candidate.path)))
            .collect::<Vec<_>>();
        let mut result = PermanentDeleteBatchResult {
            released_bytes_is_estimate: false,
            already_absent_paths: Vec::new(),
            removed_paths: Vec::new(),
            failed: Vec::new(),
            released_bytes: 0,
        };
        for candidate in candidates {
            match delete_selected_file_permanently(Path::new(&candidate.path)) {
                Ok((target, usage)) => {
                    result.released_bytes =
                        result.released_bytes.saturating_add(usage.allocated_bytes);
                    result.removed_paths.push(candidate.path);
                    cache::remove_entry(&target, usage, 1, false);
                }
                Err(error) if error.is_not_found() => {
                    if result.already_absent_paths.len() < MAX_DELETE_FAILURE_LOGS {
                        log::info!(
                            "permanent_delete_candidate_skipped domain=large_files operation_id={} scan_id={} path={} stage={} native_code={:?} outcome=already_absent",
                            operation.id(),
                            scan_id,
                            diagnostic_path(Path::new(&candidate.path)),
                            error.stage(),
                            error.native_code()
                        );
                    }
                    result.already_absent_paths.push(candidate.path);
                }
                Err(error) => {
                    if result.failed.len() < MAX_DELETE_FAILURE_LOGS {
                        log::warn!(
                            "permanent_delete_candidate_failed domain=large_files operation_id={} scan_id={} path={} stage={} reason={} native_code={:?} partial={} remaining_location=original outcome={} error={}",
                            operation.id(),
                            scan_id,
                            diagnostic_path(Path::new(&candidate.path)),
                            error.stage(),
                            error.reason().map_or("unspecified", |reason| reason.as_str()),
                            error.native_code(),
                            error.is_partial(),
                            if error.is_partial() {
                                "partially_removed"
                            } else {
                                "retained"
                            },
                            crate::platform::contracts::diagnostics::text(&error)
                        );
                    }
                    result.failed.push(error.into_failure(candidate.path));
                }
            }
        }
        #[cfg(windows)]
        crate::filesystem::permanent_delete_diagnostics::log_failed_volume_samples(
            "large_files",
            operation.id(),
            scan_id,
            &result.failed,
        );
        let reconciled_paths = result
            .removed_paths
            .iter()
            .chain(&result.already_absent_paths)
            .cloned()
            .collect::<Vec<_>>();
        synchronize_removed_paths(scan_id, &reconciled_paths)?;
        if !result.already_absent_paths.is_empty() {
            // A vanished file invalidates index rows for other modules too.
            if let Err(error) = cache::clear_all() {
                log::warn!(
                    "permanent_delete_cache_invalidation_failed domain=large_files operation_id={} error={}",
                    operation.id(),
                    crate::platform::contracts::diagnostics::text(&error)
                );
            }
        }
        log::info!(
            "permanent_delete_batch_finished operation_id={} scan_id={} requested_count={} path_sample={:?} selected_allocated_bytes={} removed_count={} already_absent_count={} failed_count={} suppressed_failure_count={} released_allocated_bytes={} elapsed_ms={}",
            operation.id(),
            scan_id,
            requested_count,
            path_sample,
            expected_bytes,
            result.removed_paths.len(),
            result.already_absent_paths.len(),
            result.failed.len(),
            result.failed.len().saturating_sub(MAX_DELETE_FAILURE_LOGS),
            result.released_bytes,
            started.elapsed().as_millis()
        );
        operation.complete();
        Ok(result)
    }
}
