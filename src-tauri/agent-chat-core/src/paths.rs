use std::path::PathBuf;
use std::sync::OnceLock;

use crate::error::{AgentChatError, AgentChatResult};

/// The Agent chat data directory (`<data dir>/agent-chat`), resolved once by
/// the root crate in `.setup()`.
///
/// Everything this feature persists lives under this single directory, so the
/// whole feature can move with the data directory.
pub static CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Resolve the data directory.
pub fn dir() -> AgentChatResult<&'static PathBuf> {
    CONFIG_DIR.get().ok_or_else(|| {
        AgentChatError::internal("The Agent chat data directory is unavailable.")
    })
}

/// The data directory itself, created on first use.
pub fn ensure_dir() -> AgentChatResult<PathBuf> {
    let directory = dir()?.clone();
    std::fs::create_dir_all(&directory).map_err(|error| {
        eprintln!(
            "agent_chat_config_dir_create_failed path={} error={error}",
            directory.display()
        );
        AgentChatError::internal("The Agent chat data directory could not be created.")
    })?;
    Ok(directory)
}

/// `ui.json` — open tabs, the active tab and per-engine preferences.
pub fn ui_path() -> AgentChatResult<PathBuf> {
    Ok(dir()?.join("ui.json"))
}
