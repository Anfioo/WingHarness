//! Bounded in-process registry of completed large-file scans.
//!
//! Threshold changes and explicit deletions resolve against this authoritative
//! snapshot rather than trusting values that arrive from the WebView.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, MutexGuard, OnceLock,
    },
};

use super::models::LargeFilesResult;
use crate::filesystem::PermanentDeleteCandidate;

static NEXT_LARGE_FILE_SCAN_ID: AtomicU64 = AtomicU64::new(1);
static LARGE_FILE_RESULT_SESSIONS: OnceLock<Mutex<VecDeque<LargeFilesResult>>> = OnceLock::new();
/// Retains enough scans for threshold toggling and multi-window use without
/// letting result snapshots accumulate for the lifetime of the process.
pub(super) const LARGE_FILE_RESULT_SESSION_LIMIT: usize = 8;

pub(super) struct ResolvedLargeFileDeleteSelection {
    pub(super) candidates: Vec<PermanentDeleteCandidate>,
    pub(super) expected_allocated_bytes: u64,
}

fn sessions() -> &'static Mutex<VecDeque<LargeFilesResult>> {
    LARGE_FILE_RESULT_SESSIONS.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn lock_sessions() -> Result<MutexGuard<'static, VecDeque<LargeFilesResult>>, String> {
    sessions()
        .lock()
        .map_err(|_| "the large-file result session is unavailable".to_string())
}

pub(super) fn publish_result_session(
    mut result: LargeFilesResult,
) -> Result<LargeFilesResult, String> {
    result.scan_id = NEXT_LARGE_FILE_SCAN_ID.fetch_add(1, Ordering::Relaxed);
    let mut sessions = lock_sessions()?;
    sessions.push_front(result.clone());
    sessions.truncate(LARGE_FILE_RESULT_SESSION_LIMIT);
    Ok(result)
}

pub(super) fn filter_result(scan_id: u64, minimum_bytes: u64) -> Result<LargeFilesResult, String> {
    let sessions = lock_sessions()?;
    let result = sessions
        .iter()
        .find(|result| result.scan_id == scan_id)
        .ok_or_else(|| "the large-file result session expired; scan again".to_string())?;
    Ok(result.filtered(minimum_bytes))
}

/// Restores immutable file snapshots from the authoritative scan result.
///
/// Paths identify visible rows, but every size and timestamp used for safety validation comes from
/// the Core-owned session rather than the WebView request.
pub(super) fn resolve_delete_candidates(
    scan_id: u64,
    selected_paths: Vec<String>,
) -> Result<ResolvedLargeFileDeleteSelection, String> {
    if selected_paths.is_empty() {
        return Err("at least one large file must be selected".to_string());
    }
    let mut unique_paths = HashSet::with_capacity(selected_paths.len());
    if selected_paths
        .iter()
        .any(|path| !unique_paths.insert(path.as_str()))
    {
        return Err("a large file was selected more than once".to_string());
    }

    let sessions = lock_sessions()?;
    let result = sessions
        .iter()
        .find(|result| result.scan_id == scan_id)
        .ok_or_else(|| "the large-file result session expired; scan again".to_string())?;
    let entries = result
        .entries
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect::<HashMap<_, _>>();
    let selected_entries = selected_paths
        .into_iter()
        .map(|path| {
            let entry = entries
                .get(path.as_str())
                .ok_or_else(|| "a selected file is not part of the current scan".to_string())?;
            Ok(*entry)
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(ResolvedLargeFileDeleteSelection {
        expected_allocated_bytes: selected_entries.iter().map(|entry| entry.bytes).sum(),
        candidates: selected_entries
            .into_iter()
            .map(|entry| PermanentDeleteCandidate {
                path: entry.path.clone(),
                expected_bytes: entry.logical_bytes,
                expected_modified_at_ms: entry.modified_at_ms,
            })
            .collect(),
    })
}

pub(super) fn resolve_open_target(scan_id: u64, selected_path: &str) -> Result<String, String> {
    let sessions = lock_sessions()?;
    let result = sessions
        .iter()
        .find(|result| result.scan_id == scan_id)
        .ok_or_else(|| "the large-file result session expired; scan again".to_string())?;
    result
        .entries
        .iter()
        .find(|entry| entry.path == selected_path)
        .map(|entry| entry.path.clone())
        .ok_or_else(|| "the selected file is not part of the current large-file scan".to_string())
}

pub(super) fn synchronize_removed_paths(
    scan_id: u64,
    removed_paths: &[String],
) -> Result<(), String> {
    let removed_paths = removed_paths.iter().collect::<HashSet<_>>();
    let mut sessions = lock_sessions()?;
    let result = sessions
        .iter_mut()
        .find(|result| result.scan_id == scan_id)
        .ok_or_else(|| "the large-file result session expired; scan again".to_string())?;
    let displayed_removed_bytes = result
        .entries
        .iter()
        .filter(|entry| removed_paths.contains(&entry.path))
        .map(|entry| entry.bytes)
        .sum::<u64>();
    result
        .entries
        .retain(|entry| !removed_paths.contains(&entry.path));
    result
        .retained_entries
        .retain(|entry| !removed_paths.contains(&entry.path));
    result.total_bytes = result.total_bytes.saturating_sub(displayed_removed_bytes);
    result.total_count = result
        .total_count
        .saturating_sub(removed_paths.len() as u64);
    result.returned_count = u64::try_from(result.entries.len()).unwrap_or(u64::MAX);
    result.truncated = result.returned_count < result.total_count;
    Ok(())
}
