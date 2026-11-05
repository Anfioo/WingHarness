//! SSH + SFTP engine for the server manager window.
//!
//! Adapted from XTerm (MIT), https://github.com/Rockytkg/XTerm.
//! Copyright (c) 2026 Rockytkg. See `UPSTREAM.md` for the porting record.
//!
//! The root crate hands in the data directory (`paths::CONFIG_DIR`) and an
//! `AppHandle` (`ServerState`); everything else resolves from there.

pub mod commands;
pub mod error;
pub mod events;
pub mod host_keys;
pub mod legacy_secrets;
pub mod local_fs;
pub mod models;
pub mod monitor;
pub mod paths;
pub mod sftp;
pub mod ssh;
pub mod store;

pub use commands::*;
pub use error::{ServerError, ServerErrorCode, ServerResult};
pub use models::*;

/// State registered by the root crate and injected into every command.
pub struct ServerState {
    pub connections: ssh::ConnectionManager,
    /// Used to emit `server:*` events to the manager window.
    pub app: tauri::AppHandle,
}

impl ServerState {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self {
            connections: ssh::ConnectionManager::new(),
            app,
        }
    }
}
