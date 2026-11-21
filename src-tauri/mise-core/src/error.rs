// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

use serde::{Deserialize, Serialize};

/// Stable error codes returned by every `mise_*` command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MiseErrorCode {
    MiseNotFound,
    NotFound,
    InvalidInput,
    UnsafeCommand,
    Busy,
    Timeout,
    Io,
    Cancelled,
    NotImplemented,
    Internal,
}

/// A rejected command, serialized as `{ code, message, detail }`.
///
/// `message` is English and meant for logs; the frontend localizes by `code`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MiseError {
    pub code: MiseErrorCode,
    pub message: String,
    pub detail: Option<serde_json::Value>,
}

pub type MiseResult<T> = Result<T, MiseError>;

impl MiseError {
    pub fn new(code: MiseErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: serde_json::Value) -> Self {
        self.detail = Some(detail);
        self
    }

    /// Placeholder for a domain function a later lane has not implemented yet.
    pub fn not_implemented() -> Self {
        Self::new(
            MiseErrorCode::NotImplemented,
            "This mise command is not implemented yet.",
        )
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(MiseErrorCode::Internal, message)
    }

    pub fn invalid_input(field: &str, message: impl Into<String>) -> Self {
        Self::new(MiseErrorCode::InvalidInput, message).with_detail(serde_json::json!({ "field": field }))
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(MiseErrorCode::NotFound, message)
    }

    pub fn mise_not_found(message: impl Into<String>) -> Self {
        Self::new(MiseErrorCode::MiseNotFound, message)
    }

    pub fn unsafe_command(message: impl Into<String>) -> Self {
        Self::new(MiseErrorCode::UnsafeCommand, message)
    }

    pub fn busy() -> Self {
        Self::new(
            MiseErrorCode::Busy,
            "Another mise action is already running.",
        )
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(MiseErrorCode::Timeout, message)
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new(MiseErrorCode::Io, message)
    }

    pub fn cancelled() -> Self {
        Self::new(MiseErrorCode::Cancelled, "The mise request was cancelled.")
    }
}

impl std::fmt::Display for MiseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for MiseError {}
