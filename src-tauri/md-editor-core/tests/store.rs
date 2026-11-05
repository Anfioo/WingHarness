//! JSON persistence: defaults, corruption recovery, atomic writes, and the
//! clamped settings / recent / session shapes.

use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use md_editor_core::models::{
    MdCursor, MdEditorSettings, MdRecentList, MdSession, MdSessionTab, ViewMode,
};
use md_editor_core::paths::CONFIG_DIR;
use md_editor_core::{recent, session, settings, store};

/// The three state files share one data directory, so the tests that touch it
/// take turns instead of racing on the same JSON.
static TEST_LOCK: Mutex<()> = Mutex::new(());

fn serial() -> MutexGuard<'static, ()> {
    TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn scratch_dir(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "md-editor-core-store-{}-{name}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir_all(&directory).unwrap();
    directory
}

fn entry_names(directory: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// The data directory all path-based modules resolve to during this test run.
fn config_dir() -> PathBuf {
    CONFIG_DIR
        .get_or_init(|| {
            std::env::temp_dir().join(format!("md-editor-core-config-{}", std::process::id()))
        })
        .clone()
}

/// Create the data directory and drop whatever a previous test left there.
fn reset_config_dir() -> PathBuf {
    let directory = config_dir();
    fs::create_dir_all(&directory).unwrap();
    for entry in fs::read_dir(&directory).unwrap().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".json") || name.contains(".bak-") {
            let _ = fs::remove_file(entry.path());
        }
    }
    directory
}

fn tab(path: &str) -> MdSessionTab {
    MdSessionTab {
        path: path.to_owned(),
        cursor: MdCursor { line: 3, column: 7 },
        scroll_top: 120.0,
        view_mode: ViewMode::Split,
    }
}

#[test]
fn loads_defaults_when_the_file_is_missing() {
    let directory = scratch_dir("missing");
    let path = directory.join("settings.json");

    let loaded = store::load_json::<MdEditorSettings>(&path);

    assert_eq!(loaded, MdEditorSettings::default());
    assert!(!path.exists());
}

#[test]
fn backs_up_a_corrupt_file_and_falls_back_to_defaults() {
    let directory = scratch_dir("corrupt");
    let path = directory.join("settings.json");
    fs::write(&path, b"{ this is not json").unwrap();

    let loaded = store::load_json::<MdEditorSettings>(&path);

    assert_eq!(loaded, MdEditorSettings::default());
    assert!(!path.exists());
    let backups: Vec<String> = entry_names(&directory)
        .into_iter()
        .filter(|name| name.starts_with("settings.json.bak-"))
        .collect();
    assert_eq!(backups.len(), 1);
}

#[test]
fn round_trips_a_saved_value() {
    let directory = scratch_dir("round-trip");
    let path = directory.join("settings.json");
    let mut expected = MdEditorSettings::default();
    expected.appearance.font_size = 18.0;

    store::save_json(&path, &expected).unwrap();

    assert_eq!(store::load_json::<MdEditorSettings>(&path), expected);
}

#[test]
fn leaves_no_temporary_files_behind() {
    let directory = scratch_dir("atomic");
    let path = directory.join("settings.json");

    store::save_json(&path, &MdEditorSettings::default()).unwrap();

    assert_eq!(entry_names(&directory), vec!["settings.json".to_owned()]);
}

#[test]
fn creates_a_missing_data_directory() {
    let directory = scratch_dir("create-dir");
    let path = directory.join("nested").join("settings.json");

    store::save_json(&path, &MdEditorSettings::default()).unwrap();

    assert!(path.exists());
}

#[test]
fn settings_default_when_no_file_exists() {
    let _guard = serial();
    reset_config_dir();

    assert_eq!(settings::get().unwrap(), MdEditorSettings::default());
}

#[test]
fn settings_clamp_out_of_range_values_and_persist_them() {
    let _guard = serial();
    reset_config_dir();

    let mut requested = MdEditorSettings::default();
    requested.appearance.font_size = 99.0;
    requested.appearance.line_height = 0.1;
    requested.appearance.content_width = 10;
    requested.behavior.tab_size = 0;
    requested.behavior.auto_save_interval_sec = 1;
    requested.view.split_ratio = 0.95;
    requested.view.outline_width = 9_999;
    requested.export.image_scale = 1.6;
    requested.export.pdf_margin_mm = -3.0;
    requested.export.pdf_page = " A4 ".to_owned();

    let stored = settings::set(requested).unwrap();

    assert_eq!(stored.appearance.font_size, 24.0);
    assert_eq!(stored.appearance.line_height, 1.2);
    assert_eq!(stored.appearance.content_width, 480);
    assert_eq!(stored.behavior.tab_size, 1);
    assert_eq!(stored.behavior.auto_save_interval_sec, 5);
    assert_eq!(stored.view.split_ratio, 0.8);
    assert_eq!(stored.view.outline_width, 400);
    assert_eq!(stored.export.image_scale, 1.5);
    assert_eq!(stored.export.pdf_margin_mm, 0.0);
    assert_eq!(stored.export.pdf_page, "a4");
    assert_eq!(settings::get().unwrap(), stored);
}

#[test]
fn settings_round_the_image_scale_to_quarter_steps() {
    let _guard = serial();
    reset_config_dir();

    let mut requested = MdEditorSettings::default();
    requested.export.image_scale = 2.4;

    assert_eq!(settings::set(requested).unwrap().export.image_scale, 2.5);
}

#[test]
fn settings_keep_the_page_sizes_the_export_renders_and_fall_back_otherwise() {
    let _guard = serial();
    reset_config_dir();

    let mut requested = MdEditorSettings::default();
    requested.export.pdf_page = "Letter".to_owned();
    assert_eq!(settings::set(requested).unwrap().export.pdf_page, "letter");

    // The exporter renders A4 and Letter only; every other page name would
    // otherwise be stored as a value the export cannot honour.
    for page in ["tabloid", "a3", "a5", "legal"] {
        let mut requested = MdEditorSettings::default();
        requested.export.pdf_page = page.to_owned();
        assert_eq!(
            settings::set(requested).unwrap().export.pdf_page,
            "a4",
            "page size {page} should fall back to a4"
        );
    }
}

#[test]
fn settings_keep_defaults_for_the_fields_that_were_not_touched() {
    let _guard = serial();
    reset_config_dir();

    let mut requested = MdEditorSettings::default();
    requested.appearance.font_size = 18.0;

    let stored = settings::set(requested).unwrap();

    assert_eq!(stored.appearance.font_size, 18.0);
    assert_eq!(stored.appearance.line_height, 1.7);
    assert_eq!(stored.behavior.tab_size, 2);
    assert_eq!(stored.view.split_ratio, 0.5);
    assert_eq!(stored.export.pdf_page, "a4");
}

#[test]
fn settings_recover_from_a_corrupt_file() {
    let _guard = serial();
    let directory = reset_config_dir();
    fs::write(directory.join("settings.json"), b"not json at all").unwrap();

    assert_eq!(settings::get().unwrap(), MdEditorSettings::default());
    assert!(entry_names(&directory)
        .iter()
        .any(|name| name.starts_with("settings.json.bak-")));
}

#[test]
fn recent_add_deduplicates_and_moves_the_path_to_the_front() {
    let _guard = serial();
    reset_config_dir();

    recent::add("C:\\docs\\a.md").unwrap();
    recent::add("C:\\docs\\b.md").unwrap();
    let list = recent::add("C:\\docs\\a.md").unwrap();

    assert_eq!(list.entries.len(), 2);
    assert_eq!(list.entries[0].path, "C:\\docs\\a.md");
    assert_eq!(list.entries[1].path, "C:\\docs\\b.md");
}

#[test]
fn recent_list_is_capped_at_thirty_entries() {
    let _guard = serial();
    reset_config_dir();

    for index in 0..35 {
        recent::add(&format!("C:\\docs\\doc-{index}.md")).unwrap();
    }

    let list = recent::list().unwrap();

    assert_eq!(list.entries.len(), 30);
    assert_eq!(list.entries[0].path, "C:\\docs\\doc-34.md");
    assert_eq!(list.entries[29].path, "C:\\docs\\doc-5.md");
}

#[test]
fn recent_names_use_the_file_stem() {
    let _guard = serial();
    reset_config_dir();

    let list = recent::add("C:\\docs\\release-notes.markdown").unwrap();

    assert_eq!(list.entries[0].name, "release-notes");
}

#[test]
fn recent_marks_missing_files_without_dropping_them() {
    let _guard = serial();
    let directory = reset_config_dir();
    let existing = directory.join("present.md");
    fs::write(&existing, "hello").unwrap();

    recent::add(&existing.to_string_lossy()).unwrap();
    let list = recent::add("C:\\docs\\absent.md").unwrap();

    assert_eq!(list.entries.len(), 2);
    assert_eq!(list.entries[0].path, "C:\\docs\\absent.md");
    assert!(list.entries[0].missing);
    assert!(!list.entries[1].missing);
}

#[test]
fn recent_remove_is_idempotent() {
    let _guard = serial();
    reset_config_dir();
    recent::add("C:\\docs\\a.md").unwrap();

    let first = recent::remove("C:\\docs\\a.md").unwrap();
    let second = recent::remove("C:\\docs\\a.md").unwrap();

    assert!(first.entries.is_empty());
    assert!(second.entries.is_empty());
}

#[test]
fn session_defaults_to_empty() {
    let _guard = serial();
    reset_config_dir();

    let restored = session::get().unwrap();

    assert!(restored.tabs.is_empty());
    assert_eq!(restored.active_path, None);
}

#[test]
fn session_round_trips_tabs_and_the_active_path() {
    let _guard = serial();
    reset_config_dir();
    let stored = MdSession {
        tabs: vec![tab("C:\\docs\\a.md"), tab("C:\\docs\\b.md")],
        active_path: Some("C:\\docs\\b.md".to_owned()),
    };

    session::set(&stored).unwrap();

    assert_eq!(session::get().unwrap(), stored);
}

#[test]
fn session_drops_tabs_without_a_path() {
    let _guard = serial();
    reset_config_dir();
    let stored = MdSession {
        tabs: vec![tab("C:\\docs\\a.md"), tab(""), tab("   ")],
        active_path: Some(String::new()),
    };

    session::set(&stored).unwrap();
    let restored = session::get().unwrap();

    assert_eq!(restored.tabs.len(), 1);
    assert_eq!(restored.tabs[0].path, "C:\\docs\\a.md");
    assert_eq!(restored.active_path, None);
}

#[test]
fn session_caps_the_tab_list() {
    let _guard = serial();
    reset_config_dir();
    let tabs: Vec<MdSessionTab> = (0..60).map(|index| tab(&format!("C:\\docs\\{index}.md"))).collect();

    session::set(&MdSession {
        tabs,
        active_path: None,
    })
    .unwrap();

    assert_eq!(session::get().unwrap().tabs.len(), 50);
}

#[test]
fn session_ignores_unknown_fields_and_missing_files() {
    let _guard = serial();
    let directory = reset_config_dir();
    fs::write(
        directory.join("session.json"),
        br#"{
            "version": 1,
            "tabs": [{ "path": "C:\\docs\\gone.md", "futureField": true }],
            "activePath": "C:\\docs\\gone.md",
            "unknown": { "nested": 1 }
        }"#,
    )
    .unwrap();

    let restored = session::get().unwrap();

    assert_eq!(restored.tabs.len(), 1);
    assert_eq!(restored.tabs[0].path, "C:\\docs\\gone.md");
    assert_eq!(restored.tabs[0].view_mode, ViewMode::Split);
    assert_eq!(restored.active_path.as_deref(), Some("C:\\docs\\gone.md"));
}

#[test]
fn recent_list_uses_the_default_when_the_file_is_missing() {
    let _guard = serial();
    reset_config_dir();

    let list: MdRecentList = recent::list().unwrap();

    assert!(list.entries.is_empty());
}
