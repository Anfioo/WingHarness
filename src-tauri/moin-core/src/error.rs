// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `UPSTREAM.md` for the porting record.

use serde::{Deserialize, Serialize};

/// Stable error codes the front end maps to `moin.error.*` translations.
///
/// The `message` is English on purpose: it is only a fallback for logs and for
/// codes the UI has no copy for. Never put user-facing wording in it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MoinErrorCode {
    NotFound,
    InvalidInput,
    Conflict,
    Io,
    BackendUnavailable,
    NotImplemented,
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoinError {
    pub code: MoinErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<serde_json::Value>,
}

pub type MoinResult<T> = Result<T, MoinError>;

impl MoinError {
    pub fn new(code: MoinErrorCode, message: impl Into<String>) -> Self {
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

    pub fn not_found(kind: &str, id: &str) -> Self {
        Self::new(MoinErrorCode::NotFound, format!("{kind} '{id}' was not found."))
    }

    pub fn invalid_input(field: &str, message: impl Into<String>) -> Self {
        Self::new(
            MoinErrorCode::InvalidInput,
            format!("Invalid {field}: {}", message.into()),
        )
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(MoinErrorCode::Conflict, message)
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new(MoinErrorCode::Io, message)
    }

    pub fn backend_unavailable(message: impl Into<String>) -> Self {
        Self::new(MoinErrorCode::BackendUnavailable, message)
    }

    pub fn not_implemented() -> Self {
        Self::new(
            MoinErrorCode::NotImplemented,
            "This download feature is not implemented yet.",
        )
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(MoinErrorCode::Internal, message)
    }
}

impl std::fmt::Display for MoinError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for MoinError {}
