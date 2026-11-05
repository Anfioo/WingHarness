use std::{collections::BTreeMap, fs, path::Path};

use super::*;
use crate::filesystem::metadata::display_path;

fn analyze(root: &Path) -> AnalysisResult {
    AnalysisService::analyze_with_progress(Some(root.to_string_lossy().into_owned()), true, |_| {})
        .unwrap()
}

fn projection(result: &AnalysisResult) -> BTreeMap<String, (u64, u64, u64)> {
    fn visit(
        nodes: &[super::super::AnalysisDirectoryNode],
        rows: &mut BTreeMap<String, (u64, u64, u64)>,
    ) {
        for node in nodes {
            rows.insert(
                node.path.clone(),
                (node.bytes, node.file_count, node.total_entry_count),
            );
            for file in &node.files {
                rows.insert(file.path.clone(), (file.bytes, file.file_count, 0));
            }
            visit(&node.children, rows);
        }
    }
    let mut rows = BTreeMap::new();
    visit(&result.directory_hierarchy, &mut rows);
    rows
}

/// Hard-link fixtures need an NTFS volume; skip the scenario when the
/// platform refuses to create the link.
fn hard_links_available() -> bool {
    let probe = match tempfile::tempdir() {
        Ok(probe) => probe,
        Err(_) => return false,
    };
    if fs::write(probe.path().join("probe"), b"x").is_err() {
        return false;
    }
    fs::hard_link(probe.path().join("probe"), probe.path().join("probe-alias")).is_ok()
}

#[test]
fn every_linked_folder_deletion_order_matches_an_independent_scan_with_and_without_index() {
    let _operation_lock = crate::shared::operation::test_operation_lock();
    if !hard_links_available() {
        return;
    }
    let mut scenarios = 0;
    for evict_index in [false, true] {
        for a in 0..4 {
            for b in 0..4 {
                for c in 0..4 {
                    for d in 0..4 {
                        let order = [a, b, c, d];
                        if order
                            .iter()
                            .copied()
                            .collect::<std::collections::BTreeSet<_>>()
                            .len()
                            != 4
                        {
                            continue;
                        }
                        cache::clear_all().unwrap();
                        let fixture = tempfile::tempdir().unwrap();
                        let root = fs::canonicalize(fixture.path()).unwrap();
                        let folders = ["a owner", "b \u{4e2d}\u{6587}", "c", "d"];
                        for name in folders {
                            fs::create_dir_all(root.join(name).join("deep/nested")).unwrap();
                        }
                        for (group, members) in [vec![0, 1, 2, 3], vec![0, 2], vec![1, 3]]
                            .iter()
                            .enumerate()
                        {
                            let owner = root
                                .join(folders[members[0]])
                                .join(format!("deep/nested/group{group}.bin"));
                            fs::write(&owner, vec![group as u8; (group + 1) * 8192]).unwrap();
                            for member in members.iter().skip(1) {
                                fs::hard_link(
                                    &owner,
                                    root.join(folders[*member])
                                        .join(format!("deep/nested/group{group}.bin")),
                                )
                                .unwrap();
                            }
                        }
                        // Empty files and directories must not be confused with uncharged aliases.
                        fs::write(root.join("d/ordinary.bin"), vec![3; 4096]).unwrap();
                        fs::write(root.join("c/empty.bin"), []).unwrap();
                        fs::create_dir(root.join("b \u{4e2d}\u{6587}/empty")).unwrap();
                        let initial = analyze(&root);
                        for index in order {
                            if evict_index {
                                cache::clear_all().unwrap();
                            }
                            // Destructive actions use the published path, not an OS canonicalization alias.
                            let selected_path = initial
                                .entries
                                .iter()
                                .find(|entry| entry.name == folders[index])
                                .expect("every fixture folder must be published")
                                .path
                                .clone();
                            let response = AnalysisService::delete_entry_permanently(
                                initial.scan_id,
                                selected_path.clone(),
                            )
                            .unwrap_or_else(|error| {
                                panic!(
                                    "order={order:?}, evicted={evict_index}, selected={selected_path:?}, error={error}"
                                )
                            });
                            assert!(
                                !response.requires_rescan,
                                "order={order:?}, evicted={evict_index}"
                            );
                            assert!(!response.invalidated_scan_ids.contains(&initial.scan_id));
                            let updated = response
                                .updated_results
                                .iter()
                                .find(|result| result.scan_id == initial.scan_id)
                                .unwrap();
                            // Diagnostics returns an independent result without replacing session authority.
                            let (fresh, _) = AnalysisService::analyze_with_diagnostics(
                                Some(root.to_string_lossy().into_owned()),
                                true,
                                |_| {},
                            )
                            .unwrap();
                            assert_eq!(
                                updated.total_bytes, fresh.total_bytes,
                                "order={order:?}, evicted={evict_index}"
                            );
                            assert_eq!(updated.total_entry_count, fresh.total_entry_count);
                            let rows = |result: &AnalysisResult| {
                                result
                                    .entries
                                    .iter()
                                    .map(|row| {
                                        (
                                            row.path.clone(),
                                            (row.bytes, row.file_count, row.is_directory),
                                        )
                                    })
                                    .collect::<BTreeMap<_, _>>()
                            };
                            assert_eq!(rows(updated), rows(&fresh));
                            assert_eq!(
                                projection(updated),
                                projection(&fresh),
                                "order={order:?}, evicted={evict_index}"
                            );
                        }
                        scenarios += 1;
                    }
                }
            }
        }
    }
    assert_eq!(scenarios, 48);
}

#[test]
#[ignore = "manual isolated deletion latency measurement"]
fn manual_analysis_deletion_latency() {
    let _operation_lock = crate::shared::operation::test_operation_lock();
    for count in [20, 200, 2000] {
        let mut samples = Vec::new();
        for _ in 0..11 {
            cache::clear_all().unwrap();
            let fixture = tempfile::tempdir().unwrap();
            let root = fs::canonicalize(fixture.path()).unwrap();
            let directory = root.join("delete-target");
            fs::create_dir(&directory).unwrap();
            for index in 0..count {
                fs::write(directory.join(format!("payload-{index:05}.bin")), [1; 64]).unwrap();
            }
            let scanned = analyze(&root);
            let started = Instant::now();
            let removed = AnalysisService::delete_entry_permanently(
                scanned.scan_id,
                scanned.entries[0].path.clone(),
            )
            .unwrap();
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
            assert!(!removed.requires_rescan);
            assert!(!directory.exists());
            assert_eq!(removed.removed_file_count, count);
        }
        samples.sort_by(f64::total_cmp);
        println!("analysis_delete_benchmark files={count} iterations={} p50_ms={:.3} p95_ms={:.3} max_ms={:.3}", samples.len(), samples[5], samples[10], samples[10]);
    }
}

#[cfg(windows)]
#[test]
fn analysis_locked_failure_before_any_unlink_preserves_session() {
    use std::os::windows::fs::OpenOptionsExt;
    let _operation_lock = crate::shared::operation::test_operation_lock();
    cache::clear_all().unwrap();
    let fixture = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(fixture.path()).unwrap();
    let directory = root.join("locked-target");
    fs::create_dir(&directory).unwrap();
    let payload = directory.join("locked.bin");
    fs::write(&payload, [1; 64]).unwrap();
    let initial = analyze(&root);
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&payload)
        .unwrap();
    let failed =
        AnalysisService::delete_entry_permanently(initial.scan_id, initial.entries[0].path.clone());
    drop(locked);
    let error = failed.expect_err("locked files must stop deletion");
    assert_eq!(
        error.mutation_state(),
        crate::shared::error::PlatformMutationState::NotAttempted
    );
    assert!(matches!(
        error.reason(),
        Some(
            crate::shared::CoreErrorReason::ResourceBusy
                | crate::shared::CoreErrorReason::AccessDeniedOrBusy
        )
    ));
    assert!(
        AnalysisService::resolve_open_target(initial.scan_id, initial.entries[0].path.clone())
            .is_ok()
    );
    assert!(payload.exists());
    let cached = crate::storage::analysis::index_projection::analysis_result(&root)
        .unwrap()
        .unwrap();
    assert_eq!(cached.total_bytes, initial.total_bytes);

    cache::clear_all().unwrap();
}

#[cfg(windows)]
#[test]
fn analysis_locked_only_descendant_preserves_session_and_cache() {
    use std::os::windows::fs::OpenOptionsExt;
    let _operation_lock = crate::shared::operation::test_operation_lock();
    cache::clear_all().unwrap();
    let fixture = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(fixture.path()).unwrap();
    let directory = root.join("locked-target");
    fs::create_dir(&directory).unwrap();
    let payload = directory.join("locked.bin");
    fs::write(&payload, [1; 64]).unwrap();
    let initial = analyze(&root);
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&payload)
        .unwrap();
    let failed =
        AnalysisService::delete_entry_permanently(initial.scan_id, initial.entries[0].path.clone());
    drop(locked);
    let error = failed.expect_err("an open descendant must prevent removing the directory");
    assert_eq!(
        error.mutation_state(),
        crate::shared::error::PlatformMutationState::NotAttempted
    );
    assert!(payload.exists());
    assert!(
        AnalysisService::resolve_open_target(initial.scan_id, initial.entries[0].path.clone())
            .is_ok()
    );
    assert_eq!(
        crate::storage::analysis::index_projection::analysis_result(&root)
            .unwrap()
            .unwrap()
            .total_bytes,
        initial.total_bytes
    );
    cache::clear_all().unwrap();
}

#[test]
fn batch_deletes_files_and_folders_and_reconciles_hard_link_allocations() {
    let _operation_lock = crate::shared::operation::test_operation_lock();
    if !hard_links_available() {
        return;
    }
    cache::clear_all().unwrap();
    let fixture = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(fixture.path()).unwrap();
    fs::create_dir(root.join("folder")).unwrap();
    fs::write(root.join("file.bin"), vec![1; 8192]).unwrap();
    fs::hard_link(root.join("file.bin"), root.join("folder/alias.bin")).unwrap();
    fs::write(root.join("folder/extra.bin"), vec![2; 4096]).unwrap();
    fs::write(root.join("keep.bin"), vec![3; 4096]).unwrap();
    let initial = analyze(&root);
    let selected = ["file.bin", "folder"].map(|name| display_path(&root.join(name)));
    let batch =
        AnalysisService::delete_entries_permanently(initial.scan_id, selected.to_vec()).unwrap();
    assert_eq!(batch.removed_paths, selected);
    assert!(batch.failed.is_empty());
    assert!(batch.not_attempted_paths.is_empty());
    assert!(!batch.requires_rescan);
    let updated = batch
        .updated_results
        .iter()
        .find(|result| result.scan_id == initial.scan_id)
        .unwrap();
    let fresh = analyze(&root);
    assert_eq!(updated.total_bytes, fresh.total_bytes);
    assert_eq!(projection(updated), projection(&fresh));
    assert_eq!(
        batch.released_bytes,
        initial.total_bytes - fresh.total_bytes
    );
    assert!(root.join("keep.bin").exists());
    let wire = serde_json::to_value(&batch).unwrap();
    assert_eq!(wire["schemaVersion"], 1);
    assert!(wire["notAttemptedPaths"].is_array());
}

#[test]
fn batch_rejects_invalid_selections_before_deleting_any_item() {
    let _operation_lock = crate::shared::operation::test_operation_lock();
    cache::clear_all().unwrap();
    let fixture = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(fixture.path()).unwrap();
    fs::create_dir(root.join("folder")).unwrap();
    fs::write(root.join("folder/nested.bin"), vec![1; 4096]).unwrap();
    let file = root.join("file.bin");
    fs::write(&file, vec![2; 4096]).unwrap();
    let initial = analyze(&root);
    let file_path = display_path(&file);
    for selection in [
        vec![],
        vec![file_path.clone(), file_path.clone()],
        vec![file_path.clone(), root.to_string_lossy().into_owned()],
        vec![
            file_path.clone(),
            root.join("folder/nested.bin")
                .to_string_lossy()
                .into_owned(),
        ],
        vec![file_path.clone(); super::super::ANALYSIS_VISIBLE_ENTRY_LIMIT + 1],
    ] {
        let error =
            AnalysisService::delete_entries_permanently(initial.scan_id, selection).unwrap_err();
        assert_eq!(error.code(), crate::shared::CoreErrorCode::InvalidInput);
        assert!(
            file.exists(),
            "invalid batch input must not delete earlier valid selections"
        );
    }
}

#[test]
fn batch_retains_changed_items_and_continues_after_a_failure_before_mutation() {
    let _operation_lock = crate::shared::operation::test_operation_lock();
    cache::clear_all().unwrap();
    let fixture = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(fixture.path()).unwrap();
    fs::create_dir(root.join("changed")).unwrap();
    fs::write(root.join("changed/payload.bin"), vec![1; 4096]).unwrap();
    fs::write(root.join("valid.bin"), vec![2; 4096]).unwrap();
    let initial = analyze(&root);
    fs::remove_dir_all(root.join("changed")).unwrap();
    fs::write(root.join("changed"), b"replacement").unwrap();
    let selected = ["changed", "valid.bin"].map(|name| display_path(&root.join(name)));
    let batch =
        AnalysisService::delete_entries_permanently(initial.scan_id, selected.to_vec()).unwrap();
    assert_eq!(batch.failed.len(), 1);
    assert_eq!(batch.failed[0].path, selected[0]);
    assert_eq!(batch.removed_paths, [selected[1].clone()]);
    assert!(batch.not_attempted_paths.is_empty());
    assert!(!batch.requires_rescan);
    assert_eq!(fs::read(root.join("changed")).unwrap(), b"replacement");
}
