//! `ui.json` round-trip against a real temp directory.
//!
//! `CONFIG_DIR` is a process-wide `OnceLock`, so every test in this binary
//! shares one directory and takes the same mutex before touching `ui.json`.

use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, Once};
use std::time::{SystemTime, UNIX_EPOCH};

use agent_chat_core::models::{AgentEnginePrefs, AgentTab, AgentUiState};
use agent_chat_core::store;

static CONFIG_INIT: Once = Once::new();
static SERIAL: Mutex<()> = Mutex::new(());

fn temp_dir(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!(
        "agent-chat-store-{tag}-{}-{nanos}",
        std::process::id()
    ));
    fs::create_dir_all(&path).expect("create temp dir");
    path
}

/// Serializes access and resets `ui.json` so each test starts from no file.
fn with_clean_config() -> MutexGuard<'static, ()> {
    let guard = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    CONFIG_INIT.call_once(|| {
        let root = temp_dir("config");
        let _ = agent_chat_core::paths::CONFIG_DIR.set(root);
    });
    let directory = agent_chat_core::paths::ensure_dir().expect("config dir exists");
    for entry in fs::read_dir(&directory).expect("read config dir").flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("ui.json") {
            fs::remove_file(entry.path()).expect("remove previous ui.json");
        }
    }
    guard
}

fn tab(id: &str, engine: &str) -> AgentTab {
    AgentTab {
        tab_id: id.to_string(),
        engine: engine.to_string(),
        session_id: Some(format!("session-{id}")),
        workspace_path: "C:\\workspace\\demo".to_string(),
    }
}

#[test]
fn missing_file_loads_defaults() {
    let _guard = with_clean_config();

    let state = store::load().expect("missing ui.json falls back to defaults");

    assert_eq!(state.version, 1);
    assert!(state.open_tabs.is_empty());
    assert_eq!(state.last_engine, "claude");
    assert_eq!(state.engines.len(), 3);
}

#[test]
fn save_then_load_preserves_the_page_state() {
    let _guard = with_clean_config();

    let mut state = AgentUiState::default();
    state.open_tabs = vec![tab("t1", "claude"), tab("t2", "codex")];
    state.active_tab_id = Some("t2".to_string());
    state.last_engine = "codex".to_string();
    state.engines.insert(
        "codex".to_string(),
        AgentEnginePrefs {
            model: Some("gpt-demo".to_string()),
            effort: Some("high".to_string()),
            permission: Some("bypass".to_string()),
        },
    );
    state.grants.insert(
        "run-1".to_string(),
        vec!["C:\\workspace\\demo\\docs".to_string()],
    );
    state.recent_workspaces = vec![
        "C:\\workspace\\demo".to_string(),
        "C:\\workspace\\other".to_string(),
    ];

    store::save(&state).expect("save ui.json");
    let loaded = store::load().expect("load ui.json");

    assert_eq!(loaded.version, state.version);
    assert_eq!(loaded.active_tab_id.as_deref(), Some("t2"));
    assert_eq!(loaded.last_engine, "codex");
    assert_eq!(loaded.open_tabs.len(), 2);
    assert_eq!(loaded.open_tabs[1].engine, "codex");
    assert_eq!(loaded.open_tabs[1].session_id.as_deref(), Some("session-t2"));
    assert_eq!(
        loaded.engines["codex"].model.as_deref(),
        Some("gpt-demo")
    );
    assert_eq!(loaded.engines["codex"].effort.as_deref(), Some("high"));
    assert_eq!(
        loaded.engines["codex"].permission.as_deref(),
        Some("bypass")
    );
    assert_eq!(loaded.grants["run-1"], vec!["C:\\workspace\\demo\\docs"]);
    assert_eq!(
        loaded.recent_workspaces,
        vec!["C:\\workspace\\demo", "C:\\workspace\\other"]
    );
}

#[test]
fn save_writes_sanitized_state_to_disk() {
    let _guard = with_clean_config();

    let mut state = AgentUiState::default();
    for index in 0..25 {
        state.open_tabs.push(tab(&format!("t{index}"), "claude"));
    }
    state.active_tab_id = Some("missing-tab".to_string());
    for index in 0..12 {
        state.recent_workspaces.push(format!("C:\\ws\\{index}"));
    }
    state.recent_workspaces.push(String::new());
    state.recent_workspaces.push("C:\\ws\\0".to_string());

    store::save(&state).expect("save ui.json");

    let path = agent_chat_core::paths::ui_path().expect("ui.json path");
    let raw: AgentUiState =
        serde_json::from_slice(&fs::read(&path).expect("read ui.json")).expect("parse ui.json");

    assert_eq!(raw.open_tabs.len(), 20);
    assert_eq!(raw.open_tabs[19].tab_id, "t19");
    assert_eq!(raw.active_tab_id.as_deref(), Some("t0"));
    assert_eq!(raw.recent_workspaces.len(), 10);
    assert_eq!(raw.recent_workspaces[0], "C:\\ws\\0");
    assert!(raw.recent_workspaces.iter().all(|path| !path.is_empty()));
}

#[test]
fn corrupt_file_falls_back_to_defaults_and_keeps_a_backup() {
    let _guard = with_clean_config();

    let path = agent_chat_core::paths::ui_path().expect("ui.json path");
    fs::write(&path, "{ this is not json").expect("write corrupt ui.json");

    let state = store::load().expect("corrupt ui.json falls back to defaults");
    assert!(state.open_tabs.is_empty());
    assert_eq!(state.last_engine, "claude");

    let directory = path.parent().expect("config dir");
    let backups: Vec<PathBuf> = fs::read_dir(directory)
        .expect("read config dir")
        .flatten()
        .map(|entry| entry.path())
        .filter(|entry| {
            entry
                .file_name()
                .map(|name| name.to_string_lossy().starts_with("ui.json.bak-"))
                .unwrap_or(false)
        })
        .collect();
    assert_eq!(backups.len(), 1);
    assert_eq!(
        fs::read_to_string(&backups[0]).expect("read backup"),
        "{ this is not json"
    );
}
