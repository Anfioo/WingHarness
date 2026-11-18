//! The stable error shape every task manager command returns.
//!
//! The frontend branches on `code` and translates it through i18n; `message`
//! is an English fallback for logs and anything the frontend does not know.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgusError {
    pub code: ArgusErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ArgusErrorCode {
    NotFound,
    InvalidInput,
    AccessDenied,
    ServiceUnavailable,
    NotImplemented,
    Internal,
}

impl ArgusError {
    pub fn new(code: ArgusErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            detail: None,
        }
    }

    /// A command that exists on the command surface but has no implementation
    /// yet. The parallel backend tracks replace these one by one.
    pub fn not_implemented() -> Self {
        Self::new(ArgusErrorCode::NotImplemented, "Not implemented yet.")
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(ArgusErrorCode::InvalidInput, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ArgusErrorCode::Internal, message)
    }
}

impl std::fmt::Display for ArgusError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ArgusError {}

pub type ArgusResult<T> = Result<T, ArgusError>;
