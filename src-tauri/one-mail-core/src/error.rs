// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

use serde::{Deserialize, Serialize};

/// Stable error codes returned by every `one_mail_*` command.
///
/// Serialized in kebab-case; the frontend maps the code to `oneMail.errors.*`
/// and treats `message` as a fallback only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OneMailErrorCode {
    NotFound,
    InvalidInput,
    AuthFailed,
    Network,
    Tls,
    Protocol,
    Database,
    Busy,
    NotConfigured,
    NotImplemented,
    Internal,
}

/// A rejected command, serialized as `{ code, message, detail? }`.
///
/// `message` is English and safe to log: it never carries a password, raw MIME
/// or a full recipient list. The frontend localizes by `code`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OneMailError {
    pub code: OneMailErrorCode,
    pub message: String,
    pub detail: Option<serde_json::Value>,
}

pub type OneMailResult<T> = Result<T, OneMailError>;

impl OneMailError {
    pub fn new(code: OneMailErrorCode, message: impl Into<String>) -> Self {
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

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(OneMailErrorCode::NotFound, message)
    }

    pub fn invalid_input(field: &str, message: impl Into<String>) -> Self {
        Self::new(OneMailErrorCode::InvalidInput, message)
            .with_detail(serde_json::json!({ "field": field }))
    }

    pub fn auth_failed(message: impl Into<String>) -> Self {
        Self::new(OneMailErrorCode::AuthFailed, message)
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self::new(OneMailErrorCode::Network, message)
    }

    pub fn tls(message: impl Into<String>) -> Self {
        Self::new(OneMailErrorCode::Tls, message)
    }

    pub fn protocol(message: impl Into<String>) -> Self {
        Self::new(OneMailErrorCode::Protocol, message)
    }

    pub fn database(message: impl Into<String>) -> Self {
        Self::new(OneMailErrorCode::Database, message)
    }

    pub fn busy(message: impl Into<String>) -> Self {
        Self::new(OneMailErrorCode::Busy, message)
    }

    pub fn not_configured(message: impl Into<String>) -> Self {
        Self::new(OneMailErrorCode::NotConfigured, message)
    }

    /// Placeholder for a command a later lane has not implemented yet.
    pub fn not_implemented() -> Self {
        Self::new(
            OneMailErrorCode::NotImplemented,
            "This mail command is not implemented yet.",
        )
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(OneMailErrorCode::Internal, message)
    }
}

impl std::fmt::Display for OneMailError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for OneMailError {}
