//! Integration tests for the public `svn` operations. The argument-assembly unit
//! tests already cover the pure helpers; these add the input-validation paths
//! that run before `svn` is spawned, plus one end-to-end round trip against a
//! real local repository (gated `#[ignore]` so the default run stays
//! machine-independent; run it with `cargo test -p svn-core -- --ignored`).

use svn_core::error::SvnError;
use svn_core::test_api as core;

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("failed to build tokio runtime")
}

#[test]
fn apply_patch_rejects_an_empty_patch_before_spawning_svn() {
    let error = runtime()
        .block_on(core::apply_patch("some-workspace", "   \n", false))
        .unwrap_err();
    assert!(matches!(error, SvnError::InvalidArguments(_)), "got {error:?}");
}

#[test]
fn apply_patch_rejects_a_missing_workspace() {
    let missing = std::env::temp_dir().join("svn-core-no-such-workspace-directory");
    let _ = std::fs::remove_dir_all(&missing);
    let error = runtime()
        .block_on(core::apply_patch(missing.to_str().unwrap(), "Index: a\n", false))
        .unwrap_err();
    assert!(matches!(error, SvnError::CommandFailed(_)), "got {error:?}");
}

/// Drives checkout → add → commit → info/blame/diff/log → revert through the
/// public API against a `file://` repository created with `svnadmin`.
#[ignore = "requires a real svn and svnadmin on PATH"]
#[test]
fn operations_round_trip_against_a_local_repository() {
    for executable in ["svn", "svnadmin"] {
        if std::process::Command::new(executable)
            .arg("--version")
            .output()
            .is_err()
        {
            panic!("{executable} is required for this test");
        }
    }

    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let created = std::process::Command::new("svnadmin")
        .arg("create")
        .arg(&repo)
        .status()
        .unwrap();
    assert!(created.success());
    // A `file://` URL uses forward slashes even on Windows.
    let url = format!("file:///{}", repo.display().to_string().replace('\\', "/"));
    let wc = tmp.path().join("wc");
    let wc_str = wc.to_str().unwrap();

    runtime().block_on(async {
        core::checkout(&url, wc_str, None).await.unwrap();

        let info = core::info(wc_str).await.unwrap();
        assert_eq!(info.node_kind, "dir");
        assert_eq!(core::local_revision(wc_str).await.unwrap(), 0);

        std::fs::write(wc.join("hello.txt"), "hello\n").unwrap();
        core::add(wc_str, &["hello.txt".to_string()]).await.unwrap();
        let status = core::svn_status(wc_str).await.unwrap();
        assert!(
            status
                .iter()
                .any(|entry| entry.path == "hello.txt" && entry.status_code == "added"),
            "expected hello.txt to be added: {status:?}"
        );

        core::commit(wc_str, "add hello", None).await.unwrap();
        assert_eq!(core::local_revision(wc_str).await.unwrap(), 1);

        let blame = core::blame(wc_str, "hello.txt").await.unwrap();
        assert!(blame.iter().any(|line| line.line.trim() == "hello"));
        assert!(blame.iter().all(|line| line.revision == 1));

        std::fs::write(wc.join("hello.txt"), "hello world\n").unwrap();
        let diff = core::diff(wc_str, "hello.txt", None, None).await.unwrap();
        assert!(diff.diff.contains("hello world"), "diff: {}", diff.diff);

        let log = core::log(wc_str, Some(10), None, None, None, None, None, None)
            .await
            .unwrap();
        assert!(log.iter().any(|entry| entry.message.contains("add hello")));

        core::revert(wc_str, &["hello.txt".to_string()]).await.unwrap();
        assert_eq!(std::fs::read_to_string(wc.join("hello.txt")).unwrap(), "hello\n");
    });
}