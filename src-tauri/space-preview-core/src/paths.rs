//! Where the preview feature writes.
//!
//! The root crate sets `CONFIG_DIR` from `config::dir()/preview` in its setup
//! hook, before any command can run. Everything this feature persists —
//! `preview.json` and the rendered presentation PDFs — stays below it, so the
//! whole feature moves with the data directory.

use std::path::PathBuf;
use std::sync::OnceLock;

/// The preview data directory (`<data dir>/preview`), resolved once at startup
/// by the root crate.
pub static CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// `preview.json` — the persisted preferences.
pub fn preferences_file() -> PathBuf {
    config_dir().join("preview.json")
}

/// `presentations/` — the PDFs PowerPoint conversion produced, created on
/// demand.
pub fn presentation_dir() -> PathBuf {
    let directory = config_dir().join("presentations");
    if let Err(error) = std::fs::create_dir_all(&directory) {
        log::warn!(
            "space_preview_presentation_dir_create_failed path={} error={error}",
            directory.display()
        );
    }
    directory
}

fn config_dir() -> PathBuf {
    CONFIG_DIR.get().cloned().unwrap_or_else(|| {
        // Setup sets this before any command runs, so reaching here means the
        // app's own config directory could not be resolved. Keep the path
        // well-formed instead of panicking a command thread.
        log::error!("space_preview_config_dir_unavailable");
        std::env::temp_dir().join("wingharness-space-preview")
    })
}
