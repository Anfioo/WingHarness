use super::*;
use crate::filesystem::metadata::display_path;
use std::{fs, path::Path};

fn analyze(root: &Path) -> AnalysisResult {
    AnalysisService::analyze_with_progress(Some(root.to_string_lossy().into_owned()), true, |_| {})
        .unwrap()
}

#[test]
fn batch_accepts_the_complete_visible_selection_limit() {
    let _operation_lock = crate::shared::operation::test_operation_lock();
    cache::clear_all().unwrap();
    let fixture = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(fixture.path()).unwrap();
    for index in 0..super::super::ANALYSIS_VISIBLE_ENTRY_LIMIT {
        fs::write(root.join(format!("item-{index:03}.bin")), [1; 64]).unwrap();
    }
    let initial = analyze(&root);
    let selected = initial
        .entries
        .iter()
        .map(|entry| entry.path.clone())
        .collect();
    let batch = AnalysisService::delete_entries_permanently(initial.scan_id, selected).unwrap();
    assert_eq!(
        batch.removed_paths.len(),
        super::super::ANALYSIS_VISIBLE_ENTRY_LIMIT
    );
    assert!(batch.failed.is_empty());
    assert!(batch.not_attempted_paths.is_empty());
    assert!(!batch.requires_rescan);
    assert_eq!(batch.released_bytes, initial.total_bytes);
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    let updated = batch
        .updated_results
        .iter()
        .find(|result| result.scan_id == initial.scan_id)
        .unwrap();
    assert_eq!(updated.total_bytes, 0);
    assert!(updated.entries.is_empty());
    cache::clear_all().unwrap();
}

#[test]
fn batch_preserves_path_and_name_exclusions_and_continues_with_valid_items() {
    let _operation_lock = crate::shared::operation::test_operation_lock();
    for by_name in [false, true] {
        cache::clear_all().unwrap();
        let fixture = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(fixture.path()).unwrap();
        let guarded = root.join("guarded");
        let retained = guarded.join("keep");
        fs::create_dir_all(&retained).unwrap();
        fs::write(retained.join("private.bin"), b"retained fixture").unwrap();
        fs::write(guarded.join("visible.bin"), b"visible fixture").unwrap();
        let valid = root.join("valid.bin");
        fs::write(&valid, b"deletable fixture").unwrap();
        let exclusions = ScanExclusionOptions {
            paths: if by_name {
                Vec::new()
            } else {
                vec![retained.to_string_lossy().into_owned()]
            },
            names: if by_name {
                vec![crate::platform::contracts::ScanNameExclusion {
                    name: "keep".into(),
                    kind: crate::platform::contracts::ExcludedNameKind::Folder,
                }]
            } else {
                Vec::new()
            },
        };
        let initial = AnalysisService::analyze_with_exclusions_progress(
            Some(root.to_string_lossy().into_owned()),
            true,
            exclusions,
            |_| {},
        )
        .unwrap();
        let selected = [&guarded, &valid].map(|path| display_path(path));
        let batch = AnalysisService::delete_entries_permanently(initial.scan_id, selected.to_vec())
            .unwrap();
        assert_eq!(batch.removed_paths, [selected[1].clone()]);
        assert_eq!(batch.failed.len(), 1);
        assert_eq!(batch.failed[0].path, selected[0]);
        assert!(!batch.requires_rescan);
        assert!(batch.not_attempted_paths.is_empty());
        assert_eq!(
            fs::read(retained.join("private.bin")).unwrap(),
            b"retained fixture"
        );
        assert!(guarded.join("visible.bin").exists());
        assert!(!valid.exists());
    }
    cache::clear_all().unwrap();
}

#[test]
fn batch_rejects_expired_authority_without_mutating_a_valid_path() {
    let _operation_lock = crate::shared::operation::test_operation_lock();
    cache::clear_all().unwrap();
    let fixture = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(fixture.path()).unwrap();
    let file = root.join("retain.bin");
    fs::write(&file, b"retained fixture").unwrap();
    let previous = analyze(&root);
    let current = analyze(&root);
    assert_ne!(previous.scan_id, current.scan_id);
    let result = AnalysisService::delete_entries_permanently(
        previous.scan_id,
        vec![previous.entries[0].path.clone()],
    );
    assert_eq!(
        result.unwrap_err().code(),
        crate::shared::CoreErrorCode::InvalidInput
    );
    assert_eq!(fs::read(file).unwrap(), b"retained fixture");
    cache::clear_all().unwrap();
}

#[test]
fn batch_deletes_unicode_and_long_paths_without_touching_siblings() {
    let _operation_lock = crate::shared::operation::test_operation_lock();
    cache::clear_all().unwrap();
    let fixture = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(fixture.path()).unwrap();
    let directory = root.join("\u{6d4b}\u{8bd5} folder 'quoted' \u{65e5}\u{672c}\u{8a9e}");
    let mut nested = directory.clone();
    for index in 0..12 {
        nested.push(format!("long-component-{index:02}-abcdefgh"));
    }
    // Long paths require opt-in configuration on some hosts; skip when the
    // fixture cannot be created rather than failing the suite.
    if fs::create_dir_all(&nested).is_err() {
        return;
    }
    fs::write(nested.join("\u{5185}\u{5bb9}.bin"), b"nested fixture").unwrap();
    let file = root.join("\u{e9} \u{7a7a}\u{683c} emoji \u{1f96d}.bin");
    fs::write(&file, b"unicode fixture").unwrap();
    let keep = root.join("keep.bin");
    fs::write(&keep, b"retained fixture").unwrap();
    let initial = analyze(&root);
    let selected = [&directory, &file].map(|path| display_path(path));
    let batch =
        AnalysisService::delete_entries_permanently(initial.scan_id, selected.to_vec()).unwrap();
    assert_eq!(batch.removed_paths, selected);
    assert!(batch.failed.is_empty());
    assert!(!batch.requires_rescan);
    assert_eq!(fs::read(keep).unwrap(), b"retained fixture");
    assert!(!directory.exists());
    assert!(!file.exists());
    cache::clear_all().unwrap();
}

#[cfg(windows)]
#[test]
fn windows_batch_retains_locked_items_continues_and_retries_after_unlock() {
    use std::os::windows::fs::OpenOptionsExt;
    let _operation_lock = crate::shared::operation::test_operation_lock();
    for locked_index in 0..3 {
        cache::clear_all().unwrap();
        let fixture = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(fixture.path()).unwrap();
        let paths = ["first.bin", "middle.bin", "last.bin"].map(|name| root.join(name));
        for path in &paths {
            fs::write(path, b"batch fixture").unwrap();
        }
        let initial = analyze(&root);
        let selected = paths.each_ref().map(|path| display_path(path));
        let locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&paths[locked_index])
            .unwrap();
        let batch = AnalysisService::delete_entries_permanently(initial.scan_id, selected.to_vec())
            .unwrap();
        drop(locked);
        assert_eq!(batch.failed.len(), 1);
        assert_eq!(batch.failed[0].path, selected[locked_index]);
        assert_eq!(
            batch.failed[0].reason,
            Some(crate::shared::CoreErrorReason::ResourceBusy)
        );
        assert_eq!(batch.removed_paths.len(), 2);
        assert!(!batch.requires_rescan);
        assert!(batch.not_attempted_paths.is_empty());
        assert_eq!(fs::read(&paths[locked_index]).unwrap(), b"batch fixture");
        let updated = batch
            .updated_results
            .iter()
            .find(|result| result.scan_id == initial.scan_id)
            .unwrap();
        assert_eq!(updated.entries.len(), 1);
        assert_eq!(updated.entries[0].path, selected[locked_index]);
        let retried = AnalysisService::delete_entries_permanently(
            initial.scan_id,
            vec![selected[locked_index].clone()],
        )
        .unwrap();
        assert_eq!(retried.removed_paths, [selected[locked_index].clone()]);
        assert!(retried.failed.is_empty());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    }
    cache::clear_all().unwrap();
}

#[cfg(windows)]
#[test]
fn windows_batch_deletes_read_only_descendants_when_explicitly_confirmed() {
    let _operation_lock = crate::shared::operation::test_operation_lock();
    cache::clear_all().unwrap();
    let fixture = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(fixture.path()).unwrap();
    let directory = root.join("partial");
    fs::create_dir(&directory).unwrap();
    for name in ["first.bin", "second.bin"] {
        fs::write(directory.join(name), [1; 4096]).unwrap();
    }
    let other_selected = root.join("other-selected.bin");
    fs::write(&other_selected, [2; 4096]).unwrap();
    let initial = analyze(&root);
    let children: Vec<_> = fs::read_dir(&directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    let original_permissions = fs::metadata(&children[1]).unwrap().permissions();
    let mut read_only = original_permissions.clone();
    read_only.set_readonly(true);
    fs::set_permissions(&children[1], read_only).unwrap();
    let selected = [&directory, &other_selected].map(|path| display_path(path));
    let batch = AnalysisService::delete_entries_permanently(initial.scan_id, selected.to_vec());
    if children[1].exists() {
        fs::set_permissions(&children[1], original_permissions).unwrap();
    }
    let batch = batch.unwrap();
    assert_eq!(batch.removed_paths, selected);
    assert!(batch.failed.is_empty());
    assert!(!batch.requires_rescan);
    assert!(batch.not_attempted_paths.is_empty());
    assert!(!directory.exists());
    assert!(!other_selected.exists());
    cache::clear_all().unwrap();
}

#[cfg(windows)]
#[test]
fn windows_batch_rejects_a_directory_replaced_with_a_junction() {
    let _operation_lock = crate::shared::operation::test_operation_lock();
    cache::clear_all().unwrap();
    let fixture = tempfile::tempdir().unwrap();
    let sandbox = fs::canonicalize(fixture.path()).unwrap();
    let root = sandbox.join("analysis-root");
    let external = sandbox.join("external");
    let replaced = root.join("replaced");
    fs::create_dir_all(&replaced).unwrap();
    fs::create_dir(&external).unwrap();
    fs::write(replaced.join("old.bin"), b"old fixture").unwrap();
    fs::write(external.join("retain.bin"), b"retained fixture").unwrap();
    let valid = root.join("valid.bin");
    fs::write(&valid, b"deletable fixture").unwrap();
    let initial = analyze(&root);
    fs::remove_dir_all(&replaced).unwrap();
    let output = std::process::Command::new("cmd")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(display_path(&replaced))
        .arg(display_path(&external))
        .output()
        .unwrap();
    // Junction creation can be unavailable in restricted environments.
    if !output.status.success() {
        return;
    }
    let selected = [&replaced, &valid].map(|path| display_path(path));
    let batch =
        AnalysisService::delete_entries_permanently(initial.scan_id, selected.to_vec()).unwrap();
    assert_eq!(batch.failed.len(), 1);
    assert_eq!(batch.failed[0].path, selected[0]);
    assert_eq!(batch.removed_paths, [selected[1].clone()]);
    assert!(!batch.requires_rescan);
    assert!(batch.not_attempted_paths.is_empty());
    assert_eq!(
        fs::read(external.join("retain.bin")).unwrap(),
        b"retained fixture"
    );
    assert!(replaced.exists());
    fs::remove_dir(&replaced).unwrap();
    cache::clear_all().unwrap();
}
