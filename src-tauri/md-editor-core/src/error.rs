use std::fmt;

use serde::{Deserialize, Serialize};

/// Stable error categories that cross the Tauri command boundary.
///
/// The UI localizes these codes on its own; `message` stays English and is
/// meant for the native log, never for display.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MdEditorErrorCode {
    NotFound,
    InvalidInput,
    /// The file changed on disk since it was read; the caller decides whether
    /// to overwrite, discard or save elsewhere.
    ConflictExternalChange,
    /// The bytes are not text (a NUL byte was found early on).
    BinaryFile,
    /// Neither UTF-8 nor GB18030 could decode the file.
    EncodingFailed,
    TooLarge,
    Unsupported,
    Io,
    Internal,
}

/// The single error type every `md_editor_*` command returns.
///
/// Serializes as `{ "code": ..., "message": ..., "detail": null | object }` so
/// the frontend can branch on `code` without parsing prose.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MdEditorError {
    pub code: MdEditorErrorCode,
    pub message: String,
    #[serde(default)]
    pub detail: Option<serde_json::Value>,
}

pub type MdEditorResult<T> = Result<T, MdEditorError>;

impl MdEditorError {
    pub fn new(code: MdEditorErrorCode, message: impl Into<String>) -> Self {
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

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(MdEditorErrorCode::Internal, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(MdEditorErrorCode::NotFound, message)
    }

    /// A field failed validation; `field` names the input field that caused it.
    pub fn invalid_input(field: &str, message: impl Into<String>) -> Self {
        Self::new(MdEditorErrorCode::InvalidInput, message)
            .with_detail(serde_json::json!({ "field": field }))
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(MdEditorErrorCode::ConflictExternalChange, message)
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(MdEditorErrorCode::Unsupported, message)
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new(MdEditorErrorCode::Io, message)
    }
}

impl fmt::Display for MdEditorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for MdEditorError {}
