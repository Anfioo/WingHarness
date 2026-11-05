//! Bridge projection from completed scan records to large-file candidates.
//!
//! The shared traversal kernel still keeps its own copy of this projection while
//! the large-file lane lands. This module mirrors it behaviourally so traversal
//! can be repointed at `large_file_entries_from_snapshot` without changing scan
//! results: same candidate floor, same skip policy, same ordering.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use crate::{
    filesystem::metadata::display_path,
    platform::contracts::{current_platform, Platform, ScanPurpose},
    storage::index::cache::IndexedFile,
    storage::large_files::models::{LargeFileEntry, LARGE_FILE_CANDIDATE_FLOOR_BYTES},
};

#[allow(dead_code)]
pub(crate) fn large_file_entries_from_snapshot(
    root: &Path,
    files: &HashMap<PathBuf, IndexedFile>,
) -> Vec<LargeFileEntry> {
    let mut entries = files
        .iter()
        .filter(|(path, file)| {
            path.starts_with(root) && file.bytes >= LARGE_FILE_CANDIDATE_FLOOR_BYTES
        })
        .filter(|(path, _)| {
            current_platform()
                .should_skip(path, root, ScanPurpose::LargeFiles)
                .is_none()
        })
        .map(|(path, file)| large_file_entry(path, root, *file))
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        right
            .bytes
            .cmp(&left.bytes)
            .then_with(|| left.path.cmp(&right.path))
    });
    entries
}

fn large_file_entry(path: &Path, root: &Path, file: IndexedFile) -> LargeFileEntry {
    LargeFileEntry {
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: display_path(path),
        parent_path: display_path(path.parent().unwrap_or(root)),
        bytes: file.bytes,
        logical_bytes: file.logical_bytes,
        modified_at_ms: file.modified_at_ms,
    }
}
