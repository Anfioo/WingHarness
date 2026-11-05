//! Integration tests for the `svn-core` data-directory store: typed and raw
//! value round trips, the "no residual `.tmp` file" guarantee, name/key
//! validation, the recent-working-copy list, and the camelCase wire shape of
//! the shared models. `store::CONFIG_DIR` is a process-wide `OnceLock`, so the
//! tests in this binary redirect it to one shared temp dir and serialize on a
//! mutex, mirroring `api-core`'s workspace tests.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use svn_core::models::{SvnLogEntry, SvnLogPath, SvnStatus};
use svn_core::store;
use tempfile::TempDir;

/// The one shared temp data dir for this test binary.
static CONFIG_DIR: OnceLock<TempDir> = OnceLock::new();

/// Serializes the store tests: they share a single `CONFIG_DIR` and write into
/// each other's directory.
static SERIAL: Mutex<()> = Mutex::new(());

fn setup() -> (MutexGuard<'static, ()>, PathBuf) {
    let guard = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let dir = CONFIG_DIR
        .get_or_init(|| {
            let dir = tempfile::tempdir().unwrap();
            store::CONFIG_DIR
                .set(dir.path().to_path_buf())
                .expect("no other test claims CONFIG_DIR");
            dir
        })
        .path()
        .to_path_buf();
    (guard, dir)
}

fn status(path: &str) -> SvnStatus {
    SvnStatus {
        path: path.to_string(),
        status: "modified".to_string(),
        status_code: "modified".to_string(),
        prop_status: "none".to_string(),
        locked: false,
        history: false,
        switched: false,
    }
}

/// A write stages to a timestamped `.tmp` sibling and renames over the target;
/// nothing may be left behind once it returns.
fn assert_no_temp_files(dir: &Path) {
    let temp: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains(".tmp"))
        .collect();
    assert!(temp.is_empty(), "residual temp files: {temp:?}");
}

#[test]
fn typed_values_round_trip_and_leave_no_temp_files() {
    let (_guard, dir) = setup();

    assert!(store::read_json::<SvnStatus>("typed.json").unwrap().is_none());
    let mut value = status("src/a");
    value.locked = true;
    store::write_json("typed.json", &value).unwrap();
    let loaded = store::read_json::<SvnStatus>("typed.json").unwrap().unwrap();
    assert_eq!(loaded.path, "src/a");
    assert!(loaded.locked);

    // A second write replaces the first rather than leaving both behind.
    value.path = "src/b".to_string();
    store::write_json("typed.json", &value).unwrap();
    assert_eq!(store::read_json::<SvnStatus>("typed.json").unwrap().unwrap().path, "src/b");
    assert_no_temp_files(&dir);

    store::remove_file("typed.json").unwrap();
    assert!(store::read_json::<SvnStatus>("typed.json").unwrap().is_none());
    // Removing a missing file is not an error.
    store::remove_file("typed.json").unwrap();
}

#[test]
fn raw_values_round_trip_and_leave_no_temp_files() {
    let (_guard, dir) = setup();

    assert_eq!(store::read("svn-workspace-views").unwrap(), None);
    store::write("svn-workspace-views", "{\"a\":1}").unwrap();
    assert_eq!(
        store::read("svn-workspace-views").unwrap().as_deref(),
        Some("{\"a\":1}")
    );
    store::write("svn-workspace-views", "{\"a\":2}").unwrap();
    assert_eq!(
        store::read("svn-workspace-views").unwrap().as_deref(),
        Some("{\"a\":2}")
    );
    assert_no_temp_files(&dir);

    store::remove("svn-workspace-views").unwrap();
    assert_eq!(store::read("svn-workspace-views").unwrap(), None);
}

#[test]
fn store_names_and_keys_reject_escapes() {
    let (_guard, _dir) = setup();

    // File-name document names must be flat and stay inside the data directory.
    assert!(store::read_json::<SvnStatus>("../escape.json").is_err());
    assert!(store::read_json::<SvnStatus>("a/b.json").is_err());
    assert!(store::read_json::<SvnStatus>("a\\b.json").is_err());
    assert!(store::read_json::<SvnStatus>("").is_err());
    assert!(store::write_json("../escape.json", &status("x")).is_err());

    // Keys are flat lowercase slugs.
    assert!(store::read("Svn-Stash").is_err());
    assert!(store::read("..").is_err());
    assert!(store::write("a/b", "x").is_err());
    assert!(store::read(&"x".repeat(65)).is_err());
}

#[test]
fn recent_list_remembers_dedupes_forgets_and_caps() {
    let (_guard, _dir) = setup();

    assert!(store::recent().unwrap().is_empty());

    let list = store::remember("C:\\wc\\one", Some(5)).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].path, "C:\\wc\\one");
    assert_eq!(list[0].revision, Some(5));

    store::remember("C:/wc/two", None).unwrap();
    // The same working copy, written with different separators and a trailing
    // slash, moves to the top without creating a duplicate.
    let list = store::remember("c:\\wc\\one/", Some(9)).unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].path, "c:\\wc\\one/");
    assert_eq!(list[0].revision, Some(9));

    assert!(store::remember("   ", None).is_err());

    for index in 0..25 {
        store::remember(&format!("C:\\wc\\{index}"), None).unwrap();
    }
    assert_eq!(store::recent().unwrap().len(), 20);

    let list = store::forget("C:\\wc\\24").unwrap();
    assert_eq!(list.len(), 19);
    assert!(list.iter().all(|entry| entry.path != "C:\\wc\\24"));
}

#[test]
fn export_stash_writes_where_pointed() {
    let (_guard, _dir) = setup();

    let target = std::env::temp_dir().join(format!("svn-core-export-{}.patch", std::process::id()));
    let _ = std::fs::remove_file(&target);

    store::export_stash(target.to_str().unwrap(), "patch contents\n").unwrap();
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "patch contents\n");
    assert!(store::export_stash("   ", "x").is_err());

    let _ = std::fs::remove_file(&target);
}

#[test]
fn models_serialize_camel_case_on_the_wire() {
    let (_guard, dir) = setup();

    store::write_json("wire.json", &status("src/a")).unwrap();
    let raw = std::fs::read_to_string(dir.join("wire.json")).unwrap();
    assert!(raw.contains("\"statusCode\""), "missing camelCase field: {raw}");
    assert!(raw.contains("\"propStatus\""), "missing camelCase field: {raw}");
    assert!(!raw.contains("status_code"), "snake_case leaked: {raw}");

    let log = SvnLogEntry {
        revision: 1,
        author: "author".to_string(),
        date: "2026-01-01T00:00:00Z".to_string(),
        message: "message".to_string(),
        changed_paths: vec![SvnLogPath {
            path: "src/a".to_string(),
            action: "M".to_string(),
        }],
    };
    store::write_json("wire-log.json", &log).unwrap();
    let raw = std::fs::read_to_string(dir.join("wire-log.json")).unwrap();
    assert!(raw.contains("\"changedPaths\""), "missing camelCase field: {raw}");

    store::remove_file("wire.json").unwrap();
    store::remove_file("wire-log.json").unwrap();
}
