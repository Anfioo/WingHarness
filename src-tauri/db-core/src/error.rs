//! The single error type every database command returns.
//!
//! Ported from `ide_core::IdeError` of the reference project (Apache-2.0); the
//! `specta::Type` derive is gone and the error data payload was dropped, since
//! nothing in this port needs it. `code` is what the frontend branches on, so a
//! wrong password can be told apart from a missing table without parsing prose.

use std::fmt;

use serde::{Deserialize, Serialize};

/// Stable categories that cross the Tauri command boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DbErrorCode {
    NotFound,
    /// Bad settings, bad SQL, or a value the driver rejected.
    Invalid,
    /// The server refused the credentials. Kept apart so the UI can say so.
    AuthFailed,
    /// The database could not be reached.
    Unreachable,
    /// The statement was cancelled by the user.
    Cancelled,
    /// The server answered with something unexpected.
    Protocol,
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbError {
    pub code: DbErrorCode,
    /// English, and never contains a password.
    pub message: String,
}

pub type DbResult<T> = Result<T, DbError>;

impl DbError {
    pub fn new(code: DbErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(DbErrorCode::NotFound, message)
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(DbErrorCode::Invalid, message)
    }

    pub fn unreachable(message: impl Into<String>) -> Self {
        Self::new(DbErrorCode::Unreachable, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(DbErrorCode::Internal, message)
    }

    pub fn protocol(message: impl Into<String>) -> Self {
        Self::new(DbErrorCode::Protocol, message)
    }

    pub fn cancelled() -> Self {
        Self::new(DbErrorCode::Cancelled, "Query cancelled")
    }

    pub fn is_cancelled(&self) -> bool {
        self.code == DbErrorCode::Cancelled
    }
}

impl From<std::io::Error> for DbError {
    fn from(error: std::io::Error) -> Self {
        let message = error.to_string();
        match error.kind() {
            std::io::ErrorKind::NotFound => Self::not_found(message),
            std::io::ErrorKind::InvalidInput | std::io::ErrorKind::InvalidData => Self::invalid(message),
            _ => Self::new(DbErrorCode::Internal, message),
        }
    }
}

impl fmt::Display for DbError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for DbError {}
