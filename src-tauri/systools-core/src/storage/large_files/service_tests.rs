//! End-to-end coverage for the large-file service and its result session.
//!
//! Fixtures live in unique temporary directories. Candidate placement is driven
//! by `LARGE_FILE_CANDIDATE_FLOOR_BYTES`, so every documented behaviour is
//! exercised through the same traversal a real scan uses.

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

use crate::{
    shared::{CoreErrorCode, CoreErrorReason, TraversalProgress},
    storage::large_files::{
        models::{
            LargeFileEntry, LargeFileScanMode, LargeFilesResult, LARGE_FILE_CANDIDATE_FLOOR_BYTES,
        },
        service::LargeFileService,
        session::{
            filter_result, publish_result_session, resolve_delete_candidates, resolve_open_target,
        },
    },
};

fn unique_fixture_root() -> PathBuf {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let sequence = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    std::env::temp_dir().join(format!(
        "systools-large-file-service-{}-{}-{}",
        std::process::id(),
        nanos,
        sequence
    ))
}

struct LargeFileFixture {
    root: PathBuf,
}

impl LargeFileFixture {
    fn new() -> Self {
        let root = unique_fixture_root();
        fs::create_dir_all(&root).expect("the large-file service fixture should be created");
        Self { root }
    }

    fn file(&self) -> PathBuf {
        self.root.join("candidate.bin")
    }

    fn write_dense_candidate(&self, path: &Path) {
        self.write_dense_candidate_bytes(path, LARGE_FILE_CANDIDATE_FLOOR_BYTES + 1024);
    }

    fn write_dense_candidate_bytes(&self, path: &Path, bytes: u64) {
        fs::write(path, vec![3_u8; bytes as usize])
            .expect("the dense large-file candidate should be written");
    }
}

impl Drop for LargeFileFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn synthetic_entry(name: &str, bytes: u64) -> LargeFileEntry {
    LargeFileEntry {
        name: name.to_string(),
        path: format!("/fixture/{name}"),
        parent_path: "/fixture".to_string(),
        bytes,
        logical_bytes: bytes,
        modified_at_ms: Some(7),
    }
}

fn publish_synthetic(entries: Vec<LargeFileEntry>) -> LargeFilesResult {
    publish_result_session(LargeFilesResult::from_retained_entries(
        vec!["/fixture".to_string()],
        1,
        LargeFileScanMode::Complete,
        1,
        0,
        entries,
    ))
    .expect("the synthetic large-file result should be published")
}

#[test]
fn multiple_roots_share_one_session_and_preserve_filter_and_delete_boundaries() {
    let _operation_lock = crate::shared::operation::test_operation_lock();
    let fixture = LargeFileFixture::new();
    let first = fixture.root.join("first");
    let second = fixture.root.join("second");
    let nested = first.join("nested");
    let excluded = second.join("excluded");
    fs::create_dir_all(&nested).expect("the nested scan root should be created");
    fs::create_dir_all(&excluded).expect("the excluded folder should be created");
    fixture.write_dense_candidate(&nested.join("one.bin"));
    fixture.write_dense_candidate(&second.join("two.bin"));
    fixture.write_dense_candidate(&excluded.join("hidden.bin"));
    let roots = vec![
        first.to_string_lossy().into_owned(),
        second.to_string_lossy().into_owned(),
        nested.to_string_lossy().into_owned(),
        first.to_string_lossy().into_owned(),
    ];
    let exclusions = vec![excluded.to_string_lossy().into_owned()];
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = Arc::clone(&events);
    let result = LargeFileService::find_with_progress(
        roots.clone(),
        1,
        LargeFileScanMode::Complete,
        exclusions.clone(),
        move |event: TraversalProgress| {
            captured.lock().unwrap().push(event);
        },
    )
    .expect("multiple roots should publish one result session");

    assert_eq!(result.roots.len(), 3, "duplicate roots collapse");
    assert_eq!(result.total_count, 2);
    assert!(result
        .entries
        .iter()
        .all(|entry| entry.name != "hidden.bin"));
    assert_eq!(
        result.total_bytes,
        result.entries.iter().map(|entry| entry.bytes).sum::<u64>()
    );
    assert!(result
        .entries
        .windows(2)
        .all(|entries| entries[0].bytes >= entries[1].bytes));

    let paths = result
        .entries
        .iter()
        .map(|entry| entry.path.clone())
        .collect::<Vec<_>>();
    let selection = resolve_delete_candidates(result.scan_id, paths.clone())
        .expect("scanned files resolve for deletion");
    assert_eq!(selection.candidates.len(), 2);
    assert!(resolve_delete_candidates(
        result.scan_id,
        vec![excluded.join("hidden.bin").to_string_lossy().into_owned()]
    )
    .is_err());
    for path in &paths {
        assert!(LargeFileService::resolve_open_target(result.scan_id, path.clone()).is_ok());
    }

    let filtered = LargeFileService::filter(result.scan_id, u64::MAX)
        .expect("the active scan supports an in-memory threshold filter");
    assert!(filtered.entries.is_empty());
    assert_eq!(filtered.roots, result.roots);
    let restored = LargeFileService::filter(filtered.scan_id, 1)
        .expect("lowering the threshold restores retained candidates");
    assert_eq!(restored.total_count, 2);

    let events = events.lock().unwrap();
    let last = events.last().expect("a scan should report progress");
    assert_eq!(last.completed_steps, 3);
    assert_eq!(last.total_steps, 3);
    assert!(last.items_scanned >= 2);
    assert!(events
        .iter()
        .all(|event| event.operation_id == last.operation_id));
    drop(events);

    let cancelled = LargeFileService::find_with_progress(
        roots,
        1,
        LargeFileScanMode::Complete,
        exclusions,
        |event: TraversalProgress| {
            if event.completed_steps == 1 {
                LargeFileService::cancel();
            }
        },
    )
    .expect_err("cancelling after the first root must not publish partial results");
    assert_eq!(cancelled.code(), CoreErrorCode::OperationCancelled);
}

#[test]
fn scan_modes_are_reported_and_an_empty_scope_stays_empty() {
    let _operation_lock = crate::shared::operation::test_operation_lock();
    let fixture = LargeFileFixture::new();
    let root = fixture.root.to_string_lossy().into_owned();

    let complete = LargeFileService::find_with_progress(
        vec![root.clone()],
        1,
        LargeFileScanMode::Complete,
        vec![],
        |_event: TraversalProgress| {},
    )
    .expect("a complete scan of an empty folder succeeds");
    assert_eq!(complete.scan_mode, LargeFileScanMode::Complete);
    assert_eq!(complete.total_count, 0);
    assert!(complete.entries.is_empty());

    // Quick scans rely on the native candidate stream. Until the Windows
    // adapter hook is registered on the `Platform` impl, a quick scan must fail
    // with the explicit quick-scan reason instead of silently degrading to a
    // complete walk that claims to be a quick scan.
    #[cfg(windows)]
    match LargeFileService::find_with_progress(
        vec![root],
        1,
        LargeFileScanMode::Quick,
        vec![],
        |_event: TraversalProgress| {},
    ) {
        Ok(quick) => {
            assert_eq!(quick.scan_mode, LargeFileScanMode::Quick);
            assert_eq!(quick.total_count, 0);
            assert!(quick.entries.is_empty());
        }
        Err(error) => assert_eq!(
            error.reason(),
            Some(CoreErrorReason::QuickScanUnavailable),
            "a missing native candidate source must be reported, not hidden"
        ),
    }
}

#[test]
fn empty_scopes_never_expand_to_the_system_volume() {
    let _operation_lock = crate::shared::operation::test_operation_lock();
    let error = LargeFileService::find_with_progress(
        vec![],
        1,
        LargeFileScanMode::Complete,
        vec![],
        |_event: TraversalProgress| {},
    )
    .expect_err("an empty root list must be rejected");
    assert_eq!(error.code(), CoreErrorCode::InvalidInput);
}

#[test]
fn changed_large_file_can_be_deleted_without_rescanning() {
    let _operation_lock = crate::shared::operation::test_operation_lock();
    let fixture = LargeFileFixture::new();
    let path = fixture.file();
    let initial_bytes = LARGE_FILE_CANDIDATE_FLOOR_BYTES.saturating_add(1024 * 1024);
    fixture.write_dense_candidate_bytes(&path, initial_bytes);

    let initial = LargeFileService::find_with_progress(
        vec![fixture.root.to_string_lossy().into_owned()],
        1,
        LargeFileScanMode::Complete,
        vec![],
        |_event: TraversalProgress| {},
    )
    .expect("the large-file service should scan the isolated fixture");
    assert_eq!(initial.entries.len(), 1);
    let allocated_bytes = initial.entries[0].bytes;
    let selected_path = initial.entries[0].path.clone();

    let filtered = LargeFileService::filter(initial.scan_id, allocated_bytes + 1)
        .expect("the active scan should support an in-memory threshold filter");
    assert!(filtered.entries.is_empty());
    let restored = LargeFileService::filter(filtered.scan_id, LARGE_FILE_CANDIDATE_FLOOR_BYTES)
        .expect("lowering the threshold should restore the retained candidate");
    assert_eq!(restored.entries.len(), 1);
    assert_eq!(restored.scan_mode, LargeFileScanMode::Complete);

    // Delete candidates carry the session's own logical size and timestamp, not
    // values supplied by the WebView.
    let selection = resolve_delete_candidates(initial.scan_id, vec![selected_path.clone()])
        .expect("the published candidate should resolve for deletion");
    assert_eq!(selection.candidates[0].expected_bytes, initial_bytes);
    assert!(selection.candidates[0].expected_modified_at_ms.is_some());
    assert_eq!(selection.expected_allocated_bytes, allocated_bytes);
    assert_eq!(
        LargeFileService::resolve_open_target(initial.scan_id, selected_path.clone())
            .expect("the published large file should resolve"),
        selected_path
    );

    // Explicit selection authorizes the current regular file even after it changed.
    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("the large-file candidate should reopen")
        .write_all(&[9])
        .expect("the large-file candidate should change after the scan");
    let deleted = LargeFileService::delete_files_permanently(
        initial.scan_id,
        vec![selected_path.clone()],
    )
    .expect("explicit selection should delete the current regular file");
    assert_eq!(deleted.removed_paths, vec![selected_path.clone()]);
    assert!(deleted.failed.is_empty());
    assert!(!path.exists());
    assert!(
        LargeFileService::resolve_open_target(initial.scan_id, selected_path).is_err(),
        "a deleted file must disappear from the authoritative result session"
    );
}

#[test]
fn missing_large_file_is_reconciled_without_counting_released_space() {
    let _operation_lock = crate::shared::operation::test_operation_lock();
    let fixture = LargeFileFixture::new();
    let path = fixture.file();
    fixture.write_dense_candidate(&path);

    let scan = LargeFileService::find_with_progress(
        vec![fixture.root.to_string_lossy().into_owned()],
        1,
        LargeFileScanMode::Complete,
        vec![],
        |_event: TraversalProgress| {},
    )
    .expect("the isolated fixture should scan");
    let selected = scan.entries[0].path.clone();
    fs::remove_file(&path).expect("the candidate should be removed before deletion");

    let result = LargeFileService::delete_files_permanently(scan.scan_id, vec![selected.clone()])
        .expect("an already absent candidate is reconciled instead of failing the batch");
    assert!(result.removed_paths.is_empty());
    assert!(result.failed.is_empty());
    assert_eq!(result.already_absent_paths, std::slice::from_ref(&selected));
    assert_eq!(result.released_bytes, 0);
    assert!(LargeFileService::resolve_open_target(scan.scan_id, selected).is_err());
}

#[test]
fn filter_applies_a_threshold_within_the_active_session() {
    let _operation_lock = crate::shared::operation::test_operation_lock();
    let scan = publish_synthetic(vec![
        synthetic_entry("large.bin", LARGE_FILE_CANDIDATE_FLOOR_BYTES * 2),
        synthetic_entry("small.bin", LARGE_FILE_CANDIDATE_FLOOR_BYTES),
    ]);
    assert_eq!(scan.total_count, 2);
    assert_eq!(scan.entries[0].name, "large.bin");

    let everything = LargeFileService::filter(scan.scan_id, 1).expect("the session should filter");
    assert_eq!(everything.total_count, 2);
    assert_eq!(everything.entries.len(), 2);

    let only_largest =
        LargeFileService::filter(scan.scan_id, LARGE_FILE_CANDIDATE_FLOOR_BYTES + 1)
            .expect("the session should filter");
    assert_eq!(only_largest.total_count, 1);
    assert_eq!(only_largest.entries[0].name, "large.bin");

    let nothing = LargeFileService::filter(scan.scan_id, u64::MAX).expect("the session should filter");
    assert!(nothing.entries.is_empty());
    assert_eq!(nothing.total_count, 0);
    assert_eq!(nothing.roots, scan.roots);

    // Each filtered view is itself a session, so the WebView can keep sliding
    // the threshold in either direction.
    let restored = LargeFileService::filter(nothing.scan_id, 1).expect("the filtered view persists");
    assert_eq!(restored.total_count, 2);

    assert!(LargeFileService::filter(u64::MAX, 1).is_err(), "unknown scans expire");
}

#[test]
fn result_limit_truncates_only_after_global_ordering() {
    let _operation_lock = crate::shared::operation::test_operation_lock();
    let mut entries = (0..2_000)
        .map(|index| {
            synthetic_entry(
                &format!("{index:04}.bin"),
                LARGE_FILE_CANDIDATE_FLOOR_BYTES,
            )
        })
        .collect::<Vec<_>>();
    entries.push(synthetic_entry(
        "largest.bin",
        LARGE_FILE_CANDIDATE_FLOOR_BYTES * 3,
    ));
    let scan = publish_synthetic(entries);

    assert_eq!(scan.total_count, 2_001);
    assert_eq!(scan.returned_count, 2_000);
    assert_eq!(scan.entries.len(), 2_000);
    assert!(scan.truncated);
    assert_eq!(scan.entries[0].name, "largest.bin");
    assert!(scan
        .entries
        .windows(2)
        .all(|pair| pair[0].bytes > pair[1].bytes
            || (pair[0].bytes == pair[1].bytes && pair[0].path < pair[1].path)));
}

#[test]
fn session_registry_evicts_the_oldest_scan_after_the_limit() {
    let _operation_lock = crate::shared::operation::test_operation_lock();
    let scan_ids = (0..9)
        .map(|index| {
            publish_synthetic(vec![synthetic_entry(
                &format!("scan-{index}.bin"),
                LARGE_FILE_CANDIDATE_FLOOR_BYTES,
            )])
            .scan_id
        })
        .collect::<Vec<_>>();

    assert!(
        filter_result(scan_ids[0], 1).is_err(),
        "the first scan must be evicted by the eighth newer one"
    );
    for scan_id in &scan_ids[1..] {
        assert!(
            filter_result(*scan_id, 1).is_ok(),
            "the most recent scans must stay addressable"
        );
    }
}

#[test]
fn delete_and_open_paths_are_bound_to_the_active_scan() {
    let _operation_lock = crate::shared::operation::test_operation_lock();
    // Published directly instead of through `from_retained_entries` because the
    // projection clamps the visible floor to `LARGE_FILE_CANDIDATE_FLOOR_BYTES`;
    // this fixture is concerned with session membership, not scan projection.
    let entry = LargeFileEntry {
        name: "sample.bin".to_string(),
        path: "/fixture/sample.bin".to_string(),
        parent_path: "/fixture".to_string(),
        bytes: 4,
        logical_bytes: 12,
        modified_at_ms: Some(7),
    };
    let scan = publish_result_session(LargeFilesResult {
        scan_id: 0,
        roots: vec!["/fixture".to_string()],
        retained_entries: vec![entry.clone()],
        scanned_at_ms: 1,
        scan_mode: LargeFileScanMode::Complete,
        minimum_bytes: 1,
        total_bytes: 4,
        total_count: 1,
        returned_count: 1,
        truncated: false,
        skipped_count: 0,
        entries: vec![entry],
    })
    .expect("the synthetic large-file result should be published");

    assert!(resolve_delete_candidates(scan.scan_id, Vec::new()).is_err());
    assert!(resolve_delete_candidates(
        scan.scan_id,
        vec![
            "/fixture/sample.bin".to_string(),
            "/fixture/sample.bin".to_string()
        ]
    )
    .is_err());
    assert!(
        resolve_delete_candidates(
            scan.scan_id,
            vec!["/fixture/not-scanned.bin".to_string()]
        )
        .is_err(),
        "a fabricated path must not cross the permanent-delete boundary"
    );

    let selection = resolve_delete_candidates(
        scan.scan_id,
        vec!["/fixture/sample.bin".to_string()],
    )
    .expect("the published file should resolve");
    assert_eq!(selection.candidates[0].expected_bytes, 12);
    assert_eq!(selection.candidates[0].expected_modified_at_ms, Some(7));
    assert_eq!(selection.expected_allocated_bytes, 4);

    assert_eq!(
        resolve_open_target(scan.scan_id, "/fixture/sample.bin")
            .expect("the published file should resolve"),
        "/fixture/sample.bin"
    );
    assert!(resolve_open_target(scan.scan_id, "/fixture/not-scanned.bin").is_err());
}
