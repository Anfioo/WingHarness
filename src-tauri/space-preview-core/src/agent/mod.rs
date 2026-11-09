//! The Windows space agent: the low-level keyboard hook, the Shell COM
//! selection reader, the Everything result reader and the preview window host.
//!
//! B2 fills this in. The root crate calls `start` from its setup hook and
//! `stop` when the process exits, and the preferences store calls
//! `set_enabled`, so those signatures are frozen here.

/// Start the agent. A no-op until B2 lands.
pub fn start(_app: tauri::AppHandle) {}

/// Stop the agent. A no-op until B2 lands.
pub fn stop() {}

/// Turn the space handler on or off without a restart. A no-op until B2 lands.
pub fn set_enabled(_enabled: bool) {}
