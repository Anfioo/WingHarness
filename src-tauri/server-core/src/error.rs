use std::fmt;

use serde::{Deserialize, Serialize};

/// Stable error categories that cross the Tauri command boundary.
///
/// The UI localizes these codes on its own; `message` stays English and is
/// meant for the native log, never for display.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ServerErrorCode {
    HostKeyUnknown,
    HostKeyMismatch,
    AuthFailed,
    ConnectTimeout,
    NotConnected,
    FileTooLarge,
    PathInvalid,
    NotFound,
    PermissionDenied,
    TransferNotFound,
    ConflictRequiresChoice,
    NotImplemented,
    Internal,
}

/// The single error type every server command returns.
///
/// Serializes as `{ "code": ..., "message": ..., "detail": null | object }` so
/// the frontend can branch on `code` without parsing prose.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerError {
    pub code: ServerErrorCode,
    pub message: String,
    pub detail: Option<serde_json::Value>,
}

pub type ServerResult<T> = Result<T, ServerError>;

impl ServerError {
    pub fn new(code: ServerErrorCode, message: impl Into<String>) -> Self {
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
            ServerErrorCode::NotImplemented,
            "This server command is not implemented yet.",
        )
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ServerErrorCode::Internal, message)
    }

    pub fn not_connected() -> Self {
        Self::new(
            ServerErrorCode::NotConnected,
            "The connection is not ready.",
        )
    }

    pub fn auth_failed() -> Self {
        Self::new(
            ServerErrorCode::AuthFailed,
            "The server rejected the credentials.",
        )
    }

    pub fn connect_timeout() -> Self {
        Self::new(
            ServerErrorCode::ConnectTimeout,
            "The connection timed out.",
        )
    }

    pub fn file_too_large(size: u64, limit: u64) -> Self {
        Self::new(
            ServerErrorCode::FileTooLarge,
            "The file is larger than this command allows.",
        )
        .with_detail(serde_json::json!({ "size": size, "limit": limit }))
    }

    pub fn path_invalid(path: &str) -> Self {
        Self::new(ServerErrorCode::PathInvalid, "The path is not valid.")
            .with_detail(serde_json::json!({ "path": path }))
    }

    pub fn not_found(path: &str) -> Self {
        Self::new(ServerErrorCode::NotFound, "The entry does not exist.")
            .with_detail(serde_json::json!({ "path": path }))
    }

    pub fn permission_denied(path: &str) -> Self {
        Self::new(
            ServerErrorCode::PermissionDenied,
            "The operation is not allowed on this path.",
        )
        .with_detail(serde_json::json!({ "path": path }))
    }

    pub fn transfer_not_found(transfer_id: &str) -> Self {
        Self::new(
            ServerErrorCode::TransferNotFound,
            "The transfer does not exist.",
        )
        .with_detail(serde_json::json!({ "transferId": transfer_id }))
    }

    /// First contact with a host: the frontend has to confirm the fingerprint.
    pub fn host_key_unknown(fingerprint: &str, algorithm: &str) -> Self {
        Self::new(
            ServerErrorCode::HostKeyUnknown,
            "The host key is not trusted yet.",
        )
        .with_detail(serde_json::json!({
            "fingerprint": fingerprint,
            "algorithm": algorithm,
        }))
    }

    /// A known host presented a different key. `trustHostKey` cannot clear this;
    /// the user has to forget the record first.
    pub fn host_key_mismatch(trusted: &str, presented: &str) -> Self {
        Self::new(
            ServerErrorCode::HostKeyMismatch,
            "The host key changed since it was trusted.",
        )
        .with_detail(serde_json::json!({
            "trusted": trusted,
            "presented": presented,
        }))
    }

    pub fn conflict_requires_choice(path: &str) -> Self {
        Self::new(
            ServerErrorCode::ConflictRequiresChoice,
            "The target already exists and the conflict policy is ask.",
        )
        .with_detail(serde_json::json!({ "path": path }))
    }
}

impl fmt::Display for ServerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for ServerError {}
