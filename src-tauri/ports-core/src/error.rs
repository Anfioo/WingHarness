// Ported from Porter (https://github.com/t21dev/porter-app), MIT License.
// See ../UPSTREAM.md for the porting record.

use serde::{Deserialize, Serialize};

/// Stable error codes returned by every `ports_*` command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PortsErrorCode {
    NotFound,
    InvalidInput,
    AccessDenied,
    ElevationCancelled,
    ElevationFailed,
    NotImplemented,
    Internal,
}

/// A rejected command, serialized as `{ code, message, detail }`.
///
/// `message` is English and meant for logs; the frontend localizes by `code`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortsError {
    pub code: PortsErrorCode,
    pub message: String,
    pub detail: Option<serde_json::Value>,
}

pub type PortsResult<T> = Result<T, PortsError>;

impl PortsError {
    pub fn new(code: PortsErrorCode, message: impl Into<String>) -> Self {
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

    /// Placeholder for a command a later lane has not implemented yet.
    pub fn not_implemented() -> Self {
        Self::new(
            PortsErrorCode::NotImplemented,
            "This ports command is not implemented yet.",
        )
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(PortsErrorCode::Internal, message)
    }

    pub fn invalid_input(field: &str, message: impl Into<String>) -> Self {
        Self::new(PortsErrorCode::InvalidInput, message)
            .with_detail(serde_json::json!({ "field": field }))
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(PortsErrorCode::NotFound, message)
    }

    pub fn access_denied(message: impl Into<String>) -> Self {
        Self::new(PortsErrorCode::AccessDenied, message)
    }

    pub fn elevation_cancelled() -> Self {
        Self::new(
            PortsErrorCode::ElevationCancelled,
            "Elevation was cancelled by the user.",
        )
    }

    pub fn elevation_failed(message: impl Into<String>) -> Self {
        Self::new(PortsErrorCode::ElevationFailed, message)
    }
}

impl std::fmt::Display for PortsError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for PortsError {}
