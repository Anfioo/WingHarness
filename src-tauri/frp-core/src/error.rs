use std::fmt;

use serde::{Deserialize, Serialize};

/// Stable error categories that cross the Tauri command boundary.
///
/// The UI localizes these codes on its own; `message` stays English and is
/// meant for the native log, never for display.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FrpErrorCode {
    NotFound,
    InvalidInput,
    Conflict,
    RuntimeMissing,
    RuntimeInUse,
    ConfigInvalid,
    SpawnFailed,
    NotImplemented,
    Internal,
}

/// The single error type every `frp_*` command returns.
///
/// Serializes as `{ "code": ..., "message": ..., "detail": null | object }` so
/// the frontend can branch on `code` without parsing prose.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrpError {
    pub code: FrpErrorCode,
    pub message: String,
    #[serde(default)]
    pub detail: Option<serde_json::Value>,
}

pub type FrpResult<T> = Result<T, FrpError>;

impl FrpError {
    pub fn new(code: FrpErrorCode, message: impl Into<String>) -> Self {
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

    /// The placeholder every command returns until its lane implements it.
    pub fn not_implemented() -> Self {
        Self::new(
            FrpErrorCode::NotImplemented,
            "This FRP command is not implemented yet.",
        )
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(FrpErrorCode::Internal, message)
    }

    pub fn not_found(kind: &str, id: &str) -> Self {
        Self::new(FrpErrorCode::NotFound, "The entry does not exist.")
            .with_detail(serde_json::json!({ "kind": kind, "id": id }))
    }

    /// A field failed validation; `field` names the input field that caused it.
    pub fn invalid_input(field: &str, message: impl Into<String>) -> Self {
        Self::new(FrpErrorCode::InvalidInput, message)
            .with_detail(serde_json::json!({ "field": field }))
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(FrpErrorCode::Conflict, message)
    }

    pub fn runtime_missing(message: impl Into<String>) -> Self {
        Self::new(FrpErrorCode::RuntimeMissing, message)
    }

    pub fn runtime_in_use(runtime_id: &str) -> Self {
        Self::new(
            FrpErrorCode::RuntimeInUse,
            "The runtime is referenced by a profile or in use by a running process.",
        )
        .with_detail(serde_json::json!({ "runtimeId": runtime_id }))
    }

    /// `frpc verify` rejected the generated config; `raw_output` is its output.
    pub fn config_invalid(raw_output: impl Into<String>) -> Self {
        Self::new(
            FrpErrorCode::ConfigInvalid,
            "The generated frpc configuration was rejected.",
        )
        .with_detail(serde_json::json!({ "rawOutput": raw_output.into() }))
    }

    pub fn spawn_failed(message: impl Into<String>) -> Self {
        Self::new(FrpErrorCode::SpawnFailed, message)
    }
}

impl fmt::Display for FrpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for FrpError {}
