//! Large-working-copy stress measurement for `svn status`.
//!
//! This builds a real working copy (a `file://` repository created with
//! `svnadmin`) with a large committed tree plus a large set of unversioned
//! files, then times `svn status --xml` end to end through the crate's
//! [`svn_core::operations::status`]. It is `#[ignore]`d because it needs a real
//! `svn`/`svnadmin` on PATH and writes tens of thousands of files.
//!
//! Run it (from `src-tauri`) with:
//!
//! ```text
//! cargo test -p svn-core --test stress -- --ignored --nocapture
//! ```
//!
//! Set `SVN_STRESS_DUMP` to a file path to also write the parsed status entries
//! as JSON (the shape the frontend's `SvnStatus` uses), for reuse by the
//! frontend hot-path harness. The working copy itself is removed on exit.
//!
//! Setup (checkout/add/commit) shells out to `svn` directly: those steps are not
//! what this measures, and `svn add .` on the versioned working-copy root needs
//! `--force`. Only the timed `status` call goes through the crate.

use std::path::Path;
use std::process::Command;
use std::time::Instant;

use svn_core::test_api as core;

/// Committed files across nested directories.
const COMMITTED_FILES: usize = 10_000;
/// Unversioned files created afterwards, so status reports them too.
const UNVERSIONED_FILES: usize = 10_000;
/// A handful of multi-megabyte text files, as the plan calls for.
const BIG_FILES: usize = 3;
const BIG_FILE_BYTES: usize = 4 * 1024 * 1024;

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("failed to build tokio runtime")
}

fn require(executable: &str) {
    Command::new(executable)
        .arg("--version")
        .output()
        .unwrap_or_else(|error| panic!("{executable} is required for this test: {error}"));
}

/// Run an executable with `current_dir`, asserting success.
fn run_in(dir: &Path, executable: &str, args: &[&str]) {
    let status = Command::new(executable)
        .current_dir(dir)
        .args(args)
        .status()
        .unwrap();
    assert!(status.success(), "{executable} {args:?} failed");
}

/// A nested relative path: `g000/sub00/f00000.txt`.
fn nested_path(index: usize) -> String {
    format!("g{:03}/sub{:02}/f{:05}.txt", index % 200, index % 50, index)
}

fn write_file(path: &Path, bytes: usize, seed: usize) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    if bytes == 0 {
        std::fs::write(path, format!("line {seed}\n")).unwrap();
    } else {
        // A multi-megabyte text body with recognizable lines.
        let line = format!("{seed:08} the quick brown fox jumps over the lazy dog\n");
        let mut body = Vec::with_capacity(bytes + line.len());
        while body.len() < bytes {
            body.extend_from_slice(line.as_bytes());
        }
        std::fs::write(path, body).unwrap();
    }
}

#[ignore = "requires a real svn and svnadmin; builds a 20k-file working copy"]
#[test]
fn status_large_working_copy_timing() {
    require("svn");
    require("svnadmin");

    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    run_in(tmp.path(), "svnadmin", &["create", repo.to_str().unwrap()]);
    // A `file://` URL uses forward slashes even on Windows.
    let url = format!("file:///{}", repo.display().to_string().replace('\\', "/"));
    let wc = tmp.path().join("wc");
    let wc_str = wc.to_str().unwrap().to_string();

    // Check out the empty repository first, then grow the tree inside it.
    run_in(tmp.path(), "svn", &["checkout", &url, &wc_str]);

    // --- build the committed tree -------------------------------------------
    let build_start = Instant::now();
    for index in 0..COMMITTED_FILES {
        write_file(&wc.join(nested_path(index)), 0, index);
    }
    for index in 0..BIG_FILES {
        write_file(&wc.join(format!("big/blob{index}.txt")), BIG_FILE_BYTES, index);
    }
    let build_ms = build_start.elapsed().as_millis();

    let add_start = Instant::now();
    run_in(&wc, "svn", &["add", "--force", "."]);
    run_in(&wc, "svn", &["commit", "-m", "large tree"]);
    let add_commit_ms = add_start.elapsed().as_millis();

    // --- dirty it: unversioned files plus edits to committed ones -----------
    for index in COMMITTED_FILES..COMMITTED_FILES + UNVERSIONED_FILES {
        write_file(&wc.join(nested_path(index)), 0, index);
    }
    for index in 0..COMMITTED_FILES {
        let path = wc.join(nested_path(index));
        let mut body = std::fs::read_to_string(&path).unwrap();
        body.push_str("edited\n");
        std::fs::write(&path, body).unwrap();
    }

    // --- measure `svn status --xml` through the crate -----------------------
    let mut best_ms = u128::MAX;
    let mut entries = Vec::new();
    for _ in 0..3 {
        let start = Instant::now();
        entries = runtime().block_on(async { core::svn_status(&wc_str).await.unwrap() });
        best_ms = best_ms.min(start.elapsed().as_millis());
    }

    println!("STRESS build_ms={build_ms} add_commit_ms={add_commit_ms}");
    println!(
        "STRESS status best_of_3_ms={best_ms} entries={}",
        entries.len()
    );
    println!(
        "STRESS on_disk_files={}",
        COMMITTED_FILES + UNVERSIONED_FILES + BIG_FILES
    );

    assert!(entries.len() >= COMMITTED_FILES + UNVERSIONED_FILES - 1);

    if let Ok(dump) = std::env::var("SVN_STRESS_DUMP") {
        std::fs::write(dump, serde_json::to_string(&entries).unwrap()).unwrap();
    }

    // `tmp` drops here and removes the repository and working copy.
}