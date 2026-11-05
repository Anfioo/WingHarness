//! Integration tests for the workspace store: create / load / save round trips
//! and optimistic-concurrency conflicts. The data directory is redirected to a
//! `tempfile::tempdir()` before the first use, mirroring git-core's tests.

use std::path::Path;
use std::sync::{Mutex, MutexGuard, OnceLock};

use api_core::test_api as core;
use api_core::AppError;
use tempfile::TempDir;

/// The shared temp data dir. `store::CONFIG_DIR` is a process-wide `OnceLock`,
/// so it can only be set once per test binary.
static CONFIG_DIR: OnceLock<TempDir> = OnceLock::new();

/// Serializes the workspace tests: each one does a read-modify-write of the
/// shared `workspaces.json` index, which would otherwise race.
static SERIAL: Mutex<()> = Mutex::new(());

fn setup() -> (MutexGuard<'static, ()>, &'static Path) {
    let guard = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let dir = CONFIG_DIR
        .get_or_init(|| {
            let dir = tempfile::tempdir().unwrap();
            core::CONFIG_DIR
                .set(dir.path().to_path_buf())
                .expect("no other test claims CONFIG_DIR");
            dir
        })
        .path();
    (guard, dir)
}

fn sample_collection() -> core::CollectionNode {
    core::CollectionNode {
        id: "col-1".to_string(),
        name: "Users".to_string(),
        children: vec![core::CollectionNode {
            id: "col-1-1".to_string(),
            name: "Nested".to_string(),
            children: Vec::new(),
            requests: vec![core::RequestDef {
                id: "req-2".to_string(),
                name: "Get one".to_string(),
                method: "GET".to_string(),
                url: "https://example.com/users/1".to_string(),
                ..Default::default()
            }],
        }],
        requests: vec![core::RequestDef {
            id: "req-1".to_string(),
            name: "List".to_string(),
            method: "GET".to_string(),
            url: "https://example.com/users".to_string(),
            ..Default::default()
        }],
    }
}

#[test]
fn create_load_save_roundtrip_and_conflict() {
    let (_guard, dir) = setup();

    let meta = core::create("My API").unwrap();
    assert_eq!(meta.name, "My API");
    assert_eq!(meta.collection_count, 0);
    assert_eq!(meta.request_count, 0);
    assert!(dir.join(format!("{}.json", meta.id)).exists());

    let tree = core::load(&meta.id).unwrap();
    assert_eq!(tree.revision, 0);
    assert_eq!(tree.name, "My API");
    assert!(tree.collections.is_empty());

    let mut edit = tree.clone();
    edit.collections.push(sample_collection());
    let revision = core::save(&meta.id, &edit, Some(0)).unwrap();
    assert_eq!(revision, 1);

    let reloaded = core::load(&meta.id).unwrap();
    assert_eq!(reloaded.revision, 1);
    assert_eq!(reloaded.collections.len(), 1);

    // A stale expected revision is rejected without changing anything.
    let error = core::save(&meta.id, &edit, Some(0)).unwrap_err();
    assert!(matches!(error, AppError::Conflict), "got {error:?}");
    assert_eq!(core::load(&meta.id).unwrap().revision, 1);

    // The index row reflects the counts and the new revision.
    let row = core::list()
        .unwrap()
        .into_iter()
        .find(|row| row.id == meta.id)
        .unwrap();
    assert_eq!(row.collection_count, 2);
    assert_eq!(row.request_count, 2);

    core::rename(&meta.id, "Renamed API").unwrap();
    assert_eq!(core::load(&meta.id).unwrap().name, "Renamed API");

    core::delete(&meta.id).unwrap();
    assert!(matches!(
        core::load(&meta.id).unwrap_err(),
        AppError::NotFound(_)
    ));
    assert!(!dir.join(format!("{}.json", meta.id)).exists());
}

#[test]
fn apply_import_merges_with_prefix_and_bumps_revision() {
    let (_guard, _dir) = setup();

    let meta = core::create("Import Target").unwrap();
    let result = core::ImportResult {
        collections: vec![sample_collection()],
        warnings: Vec::new(),
        base_url: String::new(),
    };
    let options = core::ImportOptions {
        name_prefix: "[P] ".to_string(),
        base_url: String::new(),
    };

    let applied = core::apply_import(&meta.id, result, options, Some(0)).unwrap();
    assert_eq!(applied.revision, 1);
    assert_eq!(applied.added, 2);

    let tree = core::load(&meta.id).unwrap();
    assert_eq!(tree.collections.len(), 1);
    assert_eq!(tree.collections[0].name, "[P] Users");

    // Importing again with a stale revision conflicts.
    let error = core::apply_import(
        &meta.id,
        core::ImportResult::default(),
        core::ImportOptions::default(),
        Some(0),
    )
    .unwrap_err();
    assert!(matches!(error, AppError::Conflict), "got {error:?}");

    core::delete(&meta.id).unwrap();
}

#[test]
fn create_seeds_default_environment_and_import_sets_base_url() {
    let (_guard, _dir) = setup();

    let meta = core::create("Env Target").unwrap();
    let tree = core::load(&meta.id).unwrap();
    assert_eq!(tree.environments.len(), 1);
    assert_eq!(tree.environments[0].name, "Default");
    assert!(tree.environments[0]
        .variables
        .iter()
        .any(|row| row.key == "baseUrl"));

    let result = core::ImportResult {
        collections: vec![sample_collection()],
        warnings: Vec::new(),
        base_url: "https://api.example.com".to_string(),
    };
    let options = core::ImportOptions {
        name_prefix: String::new(),
        base_url: " https://api.example.com ".to_string(),
    };
    core::apply_import(&meta.id, result, options, Some(0)).unwrap();

    let tree = core::load(&meta.id).unwrap();
    let base = tree.environments[0]
        .variables
        .iter()
        .find(|row| row.key == "baseUrl")
        .unwrap();
    assert_eq!(base.value, "https://api.example.com");
    assert!(base.enabled);

    core::delete(&meta.id).unwrap();
}

#[test]
fn load_backfills_default_environment() {
    let (_guard, _dir) = setup();

    let meta = core::create("Backfill Target").unwrap();
    let mut tree = core::load(&meta.id).unwrap();
    tree.environments.clear();
    core::save(&meta.id, &tree, Some(0)).unwrap();

    let reloaded = core::load(&meta.id).unwrap();
    assert_eq!(reloaded.environments.len(), 1);
    assert_eq!(reloaded.environments[0].name, "Default");

    core::delete(&meta.id).unwrap();
}

#[test]
fn names_are_validated_on_create_and_rename() {    let (_guard, _dir) = setup();

    assert!(core::create("").is_err());
    assert!(core::create("a/b").is_err());

    let meta = core::create("Valid").unwrap();
    assert!(core::rename(&meta.id, "nul").is_err());
    assert!(matches!(
        core::rename("does-not-exist", "x").unwrap_err(),
        AppError::NotFound(_)
    ));
    core::delete(&meta.id).unwrap();
}
