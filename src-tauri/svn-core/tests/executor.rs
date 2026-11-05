//! Integration tests for the `svn` executor surface reachable from outside the
//! crate. The argument constructor, the `--` separator and the child's `LC_ALL`
//! override are internal (covered by the module's own tests); what is reachable
//! here is the timeout budget, executable configuration, and — off Windows — the
//! non-ASCII path round trip. Anything that needs a real `svn` is `#[ignore]`, so
//! the default `cargo test -p svn-core` stays machine-independent.

use std::time::Duration;

use svn_core::error::SvnError;
use svn_core::executor::{configure_svn_executable, SVN_TIMEOUT};

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("failed to build tokio runtime")
}

#[test]
fn timeout_budget_is_two_minutes() {
    // `svn` talks to the network, so a hung server must not pin a refresh
    // forever; the engine bounds every call to two minutes.
    assert_eq!(SVN_TIMEOUT, Duration::from_secs(120));
}

#[test]
fn configuring_a_missing_executable_reports_svn_not_found() {
    // Probe a binary that cannot exist, so the spawn fails with `NotFound` and
    // the engine maps it to `SvnNotFound` instead of adopting it.
    let error = runtime()
        .block_on(configure_svn_executable(Some(
            "svn-core-missing-svn-binary-xyz-does-not-exist",
        )))
        .unwrap_err();
    assert!(matches!(error, SvnError::SvnNotFound), "got {error:?}");
}

#[test]
fn configuring_the_default_executable_reports_a_version_or_svn_missing() {
    // No prior configuration in this binary, so `None` probes the plain `svn`
    // name. A machine without `svn` is a supported state.
    match runtime().block_on(configure_svn_executable(None)) {
        Ok(version) => assert!(!version.trim().is_empty(), "empty version string"),
        Err(SvnError::SvnNotFound) => {}
        Err(error) => panic!("unexpected svn executor error: {error:?}"),
    }
}

/// The engine forces the child's `LC_ALL` to a UTF-8 locale, so a desktop launch
/// that inherited an ASCII locale still round-trips non-ASCII paths and messages.
/// Exercises that from outside the crate against a real local repository.
#[cfg(unix)]
#[test]
#[ignore = "requires a real svn and svnadmin on PATH"]
fn non_ascii_paths_round_trip_under_an_ascii_working_copy() {
    use svn_core::executor::execute_svn;

    for executable in ["svn", "svnadmin"] {
        if std::process::Command::new(executable)
            .arg("--version")
            .output()
            .is_err()
        {
            panic!("{executable} is required for this test");
        }
    }

    // A hostile parent locale must not survive into the child.
    std::env::set_var("LC_ALL", "C");

    let directory = tempfile::tempdir().unwrap();
    let repository = directory.path().join("repository");
    let created = std::process::Command::new("svnadmin")
        .arg("create")
        .arg(&repository)
        .output()
        .unwrap();
    assert!(created.status.success());
    let url = format!("file://{}", repository.to_str().unwrap());
    let wc = directory.path().join("工作副本");
    let wc_str = wc.to_str().unwrap();

    let runtime = runtime();
    runtime
        .block_on(execute_svn(&["checkout", &url, wc_str], None))
        .unwrap();
    std::fs::write(wc.join("文件.xlsx"), "中文内容").unwrap();
    runtime
        .block_on(execute_svn(&["add", "文件.xlsx"], Some(wc_str)))
        .unwrap();
    runtime
        .block_on(execute_svn(
            &["commit", "-m", "提交中文文件", "文件.xlsx"],
            Some(wc_str),
        ))
        .unwrap();
    let log = runtime
        .block_on(execute_svn(&["log", "--xml", "-v", &url], None))
        .unwrap();
    assert!(log.contains("提交中文文件"));
    assert!(log.contains("文件.xlsx"));
}