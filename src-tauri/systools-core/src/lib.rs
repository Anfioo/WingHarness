//! The system tools engine: disk analysis, duplicate and large-file cleanup,
//! startup items, application uninstall and system settings (Windows).
//!
//! Derived from MangoDisk (GPL-3.0-only),
//! https://github.com/harry0703/MangoDisk. See `UPSTREAM.md` for the porting
//! record.

pub mod applications;
pub mod commands;
pub mod error;
pub mod events;
pub(crate) mod filesystem;
pub mod helper;
pub mod models;
pub mod paths;
pub mod platform;
pub mod prefs;
pub(crate) mod reporting;
pub(crate) mod shared;
pub(crate) mod startup;
pub(crate) mod storage;
pub(crate) mod system_settings;
