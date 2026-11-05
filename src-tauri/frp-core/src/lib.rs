//! FRP console engine.
//!
//! Adapted from Frpilot (MIT), https://github.com/leapfu/frpilot.
//! Copyright (c) 2026 Frpilot contributors. See `UPSTREAM.md` for the porting
//! record.
//!
//! The root crate hands in the data directory (`paths::CONFIG_DIR`) and an
//! `AppHandle` (`FrpState`); everything else resolves from there.

pub mod commands;
pub mod config;
pub mod config_import;
pub mod error;
pub mod events;
pub mod health;
pub mod log_files;
pub mod models;
pub mod orphan;
pub mod paths;
mod proc;
pub mod process;
pub mod profiles;
pub mod runtime_discover;
pub mod runtime_probe;
pub mod runtimes;
pub mod state;
pub mod store;
pub mod tunnels;

pub use error::{FrpError, FrpErrorCode, FrpResult};
pub use models::*;
pub use state::FrpState;
