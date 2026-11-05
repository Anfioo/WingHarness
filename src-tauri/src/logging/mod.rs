//! Where the app's log files live.
//!
//! A feature that writes a log hangs its own files off [`dir`], so everything
//! a run produced stays under one directory that moves with the data directory.

use std::path::PathBuf;

const DIR: &str = "logs";

/// Directory holding the log files.
pub fn dir() -> PathBuf {
    crate::config::dir().join(DIR)
}
