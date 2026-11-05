//! Console-hiding helper for the children this crate spawns.
//!
//! On Windows a console program started from a GUI process gets a console
//! window of its own unless it is told not to. `frpc` is one, and so are the
//! `tasklist` / `taskkill` probes in `orphan` — each of them flashed a window
//! over the app.
//!
//! The constant is the one the root crate declares in `src-tauri/src/proc.rs`
//! and `git-core` and `svn-core` declare for themselves. `frp-core` sits below
//! the root crate in the dependency graph and cannot import any of them, so the
//! line is duplicated rather than plumbed through a shared crate.

use std::ffi::OsStr;
use std::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Builds a command whose child never allocates a console window.
pub(crate) fn hidden(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}
