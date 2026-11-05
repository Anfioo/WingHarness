//! Integration tests for the working-copy file helpers reachable without a real
//! `svn`: the `.gitignore` reader and the unversioned-file stash (`restore` and
//! `delete` touch the filesystem directly; only `read` needs SVN, so it is not
//! exercised here).

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use svn_core::models::StashUnversionedEntry;
use svn_core::{gitignore, unversioned};

#[test]
fn gitignore_read_returns_contents_and_mtime_or_none() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().to_str().unwrap();

    assert!(gitignore::read(workspace).unwrap().is_none());

    std::fs::write(dir.path().join(".gitignore"), "*.log\n!keep.log\n").unwrap();
    let data = gitignore::read(workspace).unwrap().unwrap();
    assert_eq!(data.content, "*.log\n!keep.log\n");
    assert!(data.mtime > 0);
}

#[test]
fn unversioned_restore_and_delete_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().to_str().unwrap();
    let entries = vec![
        StashUnversionedEntry {
            path: "dir".to_string(),
            kind: "directory".to_string(),
            content_base64: None,
        },
        StashUnversionedEntry {
            path: "dir/file.txt".to_string(),
            kind: "file".to_string(),
            content_base64: Some(BASE64.encode(b"hello")),
        },
    ];

    // A dry run validates the whole plan without writing anything.
    unversioned::restore(workspace, &entries, true).unwrap();
    assert!(!dir.path().join("dir").exists());

    unversioned::restore(workspace, &entries, false).unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.path().join("dir/file.txt")).unwrap(),
        "hello"
    );

    // Restoring over an existing path is refused.
    assert!(unversioned::restore(workspace, &entries, false).is_err());

    // Deleting removes the restored tree; deleting it again reports the miss.
    let result = unversioned::delete(workspace, &["dir".to_string()]).unwrap();
    assert!(result.success);
    assert!(!dir.path().join("dir").exists());
    assert!(unversioned::delete(workspace, &["dir".to_string()]).is_err());
}

#[test]
fn unversioned_restore_rejects_entries_that_escape_the_working_copy() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().to_str().unwrap();

    let escaping = vec![StashUnversionedEntry {
        path: "../outside.txt".to_string(),
        kind: "file".to_string(),
        content_base64: Some(BASE64.encode(b"nope")),
    }];
    assert!(unversioned::restore(workspace, &escaping, true).is_err());
    assert!(unversioned::restore(workspace, &escaping, false).is_err());
}