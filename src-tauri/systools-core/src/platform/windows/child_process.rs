//! Console child-process spawning for the GUI process.
//!
//! Every console subprocess started from the GUI process must go through
//! `hidden_command`; otherwise a release build flashes a console window.

/// Prevents the child from allocating a console window.
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Builds a command that never allocates a console window.
pub(crate) fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}
