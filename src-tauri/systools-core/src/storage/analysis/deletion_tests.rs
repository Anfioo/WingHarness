use super::*;
#[cfg(windows)]
use crate::{
    filesystem::permanent_delete::prepare_path_for_permanent_delete, shared::CoreErrorReason,
};
use std::fs;

#[test]
fn confirmed_analysis_directory_deletes_when_scan_metadata_is_stale() {
    let sandbox = tempfile::tempdir().expect("create the analysis deletion fixture");
    let path = sandbox.path().join("confirmed-analysis-directory");
    fs::create_dir_all(&path).expect("create the confirmed analysis fixture");
    fs::write(path.join("payload.bin"), b"payload changed after analysis")
        .expect("write the changed analysis fixture");
    fs::write(path.join("new-after-analysis.bin"), b"new").expect("write the new analysis fixture");
    let candidate = AnalysisEntryCandidate {
        scan_mode: Default::default(),
        has_shared_allocation: false,
        exclusions: Default::default(),
        root: sandbox.path().to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        expected_logical_bytes: b"payload".len() as u64,
        expected_displayed_bytes: 4_096,
        expected_file_count: 1,
        is_directory: true,
    };

    let outcome = delete_candidate(candidate)
        .expect("explicit confirmation should authorize the current directory contents");

    // The result updates the displayed scan snapshot, so it keeps the
    // original aggregate rather than claiming an unmeasured live value.
    assert_eq!(outcome.result.released_bytes, 4_096);
    assert_eq!(outcome.removed_usage.logical_bytes, b"payload".len() as u64);
    assert_eq!(outcome.removed_usage.allocated_bytes, 4_096);
    assert_eq!(outcome.result.removed_file_count, 1);
    assert!(!path.exists());
}

#[test]
#[cfg(windows)]
fn windows_managed_files_are_rejected_before_accessing_the_volume() {
    for path in [
        r"Z:\hiberfil.sys",
        r"C:\PAGEFILE.SYS",
        r"D:\folder\..\swapfile.sys",
        r"\\?\C:\DumpStack.log.tmp",
        r"Z:\pagefile.sys.",
        r"Z:\PAGEFILE.SYS ",
        r"\\.\Z:\pagefile.sys",
        r"Z:\pagefile.sys::$DATA",
        r"\\?\Z:\hiberfil.sys:stream",
    ] {
        let error = prepare_path_for_permanent_delete(Path::new(path))
            .err()
            .expect("system files must be blocked before opening them");
        assert_eq!(error.reason(), Some(CoreErrorReason::SystemManagedFile));
        assert_eq!(error.stage(), "protect_system_file");
        assert_eq!(error.native_code(), None);
        assert!(!error.is_partial());
        let error = delete_candidate(AnalysisEntryCandidate {
            scan_mode: crate::storage::analysis::AnalysisScanMode::Standard,
            has_shared_allocation: false,
            exclusions: Default::default(),
            root: r"Z:\nonexistent-analysis-root".into(),
            path: path.into(),
            expected_logical_bytes: 1,
            expected_displayed_bytes: 1,
            expected_file_count: 1,
            is_directory: false,
        })
        .err()
        .expect("analysis must reject a system file before resolving the scan root");
        assert_eq!(error.reason(), Some(CoreErrorReason::SystemManagedFile));
    }
}

#[test]
fn native_analysis_deletion_hints_protect_reserved_directories_without_accessing_them() {
    #[cfg(windows)]
    let protected = [
        r"C:\Windows",
        r"D:\System Volume Information",
        r"E:\$Recycle.Bin",
        r"C:\Program Files",
    ];
    for path in protected {
        assert!(
            deletion_protection(Path::new(path)).is_some(),
            "{path} must be protected"
        );
    }
    let fixture = tempfile::tempdir().unwrap();
    assert!(deletion_protection(fixture.path()).is_none());
}
