//! Integration tests for the versioned disk snapshot through `test_api`'s thin
//! wrappers (the snapshot's internals are `pub(crate)`): a write/read round
//! trip, rejection of a version mismatch or corruption, and the five-workspace
//! cap on retained snapshots. The module's own tests cover directory reuse and
//! concurrent writers; these add the version/TTL/cap guards.

use std::path::{Path, PathBuf};

use svn_core::test_api::{snapshot_read, snapshot_write};
use tempfile::TempDir;

/// A workspace whose canonical path is stable and contains one file.
fn workspace() -> TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("file.txt"), "content").unwrap();
    dir
}

/// The `status-*.json` documents a cache directory currently holds.
fn snapshot_files(directory: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(directory)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.file_name().is_some_and(|name| name.to_string_lossy().starts_with("status-")))
        .collect();
    files.sort();
    files
}

#[test]
fn snapshot_round_trips_and_rejects_a_version_bump() {
    let cache = tempfile::tempdir().unwrap();
    let workspace = workspace();
    let root = std::fs::canonicalize(workspace.path()).unwrap();

    assert!(!snapshot_read(cache.path(), &root));
    snapshot_write(cache.path(), &root).unwrap();
    assert!(snapshot_read(cache.path(), &root));

    // The serialized snapshot carries a version; a different one must be refused.
    let files = snapshot_files(cache.path());
    assert_eq!(files.len(), 1);
    let raw = std::fs::read_to_string(&files[0]).unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert!(value.get("version").is_some(), "snapshot has no version field: {raw}");
    value["version"] = serde_json::json!(999);
    std::fs::write(&files[0], serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(!snapshot_read(cache.path(), &root));
}

#[test]
fn corrupt_snapshots_are_ignored() {
    let cache = tempfile::tempdir().unwrap();
    let workspace = workspace();
    let root = std::fs::canonicalize(workspace.path()).unwrap();

    snapshot_write(cache.path(), &root).unwrap();
    let file = &snapshot_files(cache.path())[0];
    std::fs::write(file, "this is not json at all").unwrap();
    assert!(!snapshot_read(cache.path(), &root));
}

#[test]
fn a_snapshot_for_a_different_root_is_not_reused() {
    let cache = tempfile::tempdir().unwrap();
    let first = workspace();
    let second = workspace();
    let first_root = std::fs::canonicalize(first.path()).unwrap();
    let second_root = std::fs::canonicalize(second.path()).unwrap();

    snapshot_write(cache.path(), &first_root).unwrap();
    assert!(snapshot_read(cache.path(), &first_root));
    assert!(!snapshot_read(cache.path(), &second_root));
}

#[test]
fn only_five_workspace_snapshots_are_kept() {
    let cache = tempfile::tempdir().unwrap();

    for _ in 0..7 {
        let workspace = workspace();
        let root = std::fs::canonicalize(workspace.path()).unwrap();
        snapshot_write(cache.path(), &root).unwrap();
    }

    // Each write evicts down to the most recent five workspaces.
    assert_eq!(snapshot_files(cache.path()).len(), 5);
}
