//! Console-hiding helper for the spawned `svn` child.
//!
//! On Windows a child process gets a console window unless it is told not to.
//! The constant is the same `CREATE_NO_WINDOW` the root crate declares in
//! `src-tauri/src/proc.rs` and `git-core` declares in `git-core/src/proc.rs`.
//! `svn-core` cannot import either: it is a dependency of the root crate, so the
//! arrow only points one way. The value is identical and the reason identical —
//! one line, duplicated rather than plumbed through a new shared crate.

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Keep the child's console window hidden. A no-op off Windows.
#[cfg(windows)]
pub fn hide_console(command: &mut tokio::process::Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

/// Keep the child's console window hidden. A no-op off Windows.
#[cfg(not(windows))]
pub fn hide_console(_command: &mut tokio::process::Command) {}
