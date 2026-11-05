use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::error::{MdEditorError, MdEditorResult};

/// The Markdown editor data directory (`<data dir>/md-editor`), resolved once
/// at startup by the root crate.
///
/// `settings.json`, `recent.json` and `session.json` live here, so the whole
/// feature moves with the data directory.
pub static CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Resolve the data directory.
pub fn dir() -> MdEditorResult<&'static PathBuf> {
    CONFIG_DIR.get().ok_or_else(|| {
        MdEditorError::internal("The Markdown editor data directory is unavailable.")
    })
}

/// The data directory itself, created on first use.
pub fn ensure_dir() -> MdEditorResult<PathBuf> {
    let directory = dir()?.clone();
    create(&directory)?;
    Ok(directory)
}

/// `settings.json` — fonts, behaviour, default view and export defaults.
pub fn settings_path() -> MdEditorResult<PathBuf> {
    Ok(dir()?.join("settings.json"))
}

/// `recent.json` — the recently opened documents, capped at 30 entries.
pub fn recent_path() -> MdEditorResult<PathBuf> {
    Ok(dir()?.join("recent.json"))
}

/// `session.json` — the tabs, cursors and view modes of the last run.
pub fn session_path() -> MdEditorResult<PathBuf> {
    Ok(dir()?.join("session.json"))
}

fn create(directory: &Path) -> MdEditorResult<()> {
    std::fs::create_dir_all(directory).map_err(|error| {
        log::warn!(
            "md_editor_config_dir_create_failed path={} error={error}",
            directory.display()
        );
        MdEditorError::internal("The Markdown editor data directory could not be created.")
    })
}
