//! The engine's single error type.
//!
//! Five variants cover everything the `svn` CLI can do to us: it failed, it is
//! missing, we could not read what it printed, we built bad arguments, or it
//! never came back. Commands stringify this at the Tauri boundary.

use thiserror::Error;

#[derive(Error, Debug)]
pub enum SvnError {
    #[error("svn command failed: {0}")]
    CommandFailed(String),
    #[error("svn is not installed or not on PATH")]
    SvnNotFound,
    #[error("failed to parse svn output: {0}")]
    ParseError(String),
    #[error("invalid svn arguments: {0}")]
    InvalidArguments(String),
    #[error("svn operation timed out")]
    Timeout,
}

impl SvnError {
    /// Placeholder body for a module the port has not filled in yet. Only ever
    /// reachable while the crate is being built up; every shipped command has a
    /// real implementation.
    pub fn not_implemented(what: &str) -> Self {
        SvnError::CommandFailed(format!("{what} is not implemented yet"))
    }
}

/// Filesystem failures (an unreadable `.gitignore`, a stash export target that
/// cannot be written) surface as [`SvnError::CommandFailed`]; they are reported
/// to the user the same way a failing `svn` invocation is.
impl From<std::io::Error> for SvnError {
    fn from(error: std::io::Error) -> Self {
        SvnError::CommandFailed(error.to_string())
    }
}

pub type SvnResult<T> = Result<T, SvnError>;
