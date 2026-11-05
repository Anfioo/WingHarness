//! Filesystem locations for the MCP Hub module.
//!
//! Adapted from Soflution1/McpHub (MIT). The upstream project hard-codes
//! `~/.McpHub/` via the `dirs` crate. Here the base directory hangs off the
//! app's own data directory (`crate::config::dir()`), which is resolved once
//! at Tauri setup — no `dirs` dependency, no second pointer file.

use std::path::PathBuf;

use crate::config;

/// Root for `config.json`, `schema-cache.json`, `tokens.json`, etc.
///
/// Resolved as `<config::dir()>/.mcphub` and created on first call, so
/// downstream callers can assume it exists.
pub fn base_dir() -> PathBuf {
    let dir = config::dir().join(".mcphub");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// `config.json` — user-editable server list and gateway settings.
pub fn config_path() -> PathBuf {
    base_dir().join("config.json")
}

/// `schema-cache.json` — cached tool schemas so the gateway starts fast.
pub fn cache_path() -> PathBuf {
    base_dir().join("schema-cache.json")
}

/// `logs/` — persistent child-server log files, so the Logs tab keeps history
/// across gateway restarts (the in-memory ring buffer does not survive one).
pub fn logs_dir() -> PathBuf {
    let dir = base_dir().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// `tokens.json` — API tokens for SSE clients (Cursor / Claude Desktop).
pub fn tokens_path() -> PathBuf {
    base_dir().join("tokens.json")
}

/// Legacy single-token file, kept for parity with the upstream project.
pub fn auth_token_path() -> PathBuf {
    base_dir().join("auth-token")
}

/// User home directory, used only to *read* Cursor / Claude Desktop configs
/// during auto-detection. We never write into it.
///
/// Replaces `dirs::home_dir()` without pulling in the `dirs` crate: on Windows
/// that is `%USERPROFILE%`, elsewhere `$HOME`.
pub fn home_dir() -> PathBuf {
    if cfg!(target_os = "windows") {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            return PathBuf::from(profile);
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home);
    }
    PathBuf::from("/")
}
