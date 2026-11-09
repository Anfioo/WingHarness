//! The error every `sp_*` command returns.
//!
//! It serializes as `{ code, message, detail? }`. `code` is the stable,
//! kebab-case category the frontend maps to an i18n string; `message` stays
//! English and is meant for logs and as a last-resort fallback, never for
//! translation.

use std::fmt;

use serde::Serialize;

/// The stable error categories that cross the Tauri command boundary.
pub const CODE_NOT_AUTHORIZED: &str = "not-authorized";
pub const CODE_NOT_FOUND: &str = "not-found";
pub const CODE_TOO_LARGE: &str = "too-large";
pub const CODE_INVALID_INPUT: &str = "invalid-input";
pub const CODE_UNSUPPORTED: &str = "unsupported";
pub const CODE_INTERNAL: &str = "internal";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpacePreviewError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

pub type SpacePreviewResult<T> = Result<T, SpacePreviewError>;

impl SpacePreviewError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// The path was not handed to `sp_inspect_file` first, or it escapes its
    /// allowed directory.
    pub fn not_authorized(message: impl Into<String>) -> Self {
        Self::new(CODE_NOT_AUTHORIZED, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(CODE_NOT_FOUND, message)
    }

    pub fn too_large(message: impl Into<String>) -> Self {
        Self::new(CODE_TOO_LARGE, message)
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(CODE_INVALID_INPUT, message)
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(CODE_UNSUPPORTED, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(CODE_INTERNAL, message)
    }
}

impl fmt::Display for SpacePreviewError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for SpacePreviewError {}
