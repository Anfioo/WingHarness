use std::collections::BTreeMap;
use std::fmt;

use serde::Serialize;

/// Stable error categories returned across the Tauri command boundary.
///
/// The UI localizes these codes on its own; native diagnostics never cross the
/// process boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SystoolsErrorCode {
    InvalidInput,
    OperationBusy,
    OperationCancelled,
    OperationFailed,
    PermissionDenied,
    PersistenceFailed,
    TaskJoinFailed,
    NotImplemented,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystoolsError {
    pub code: SystoolsErrorCode,
    pub details: BTreeMap<&'static str, &'static str>,
    pub retryable: bool,
}

pub type SystoolsResult<T> = Result<T, SystoolsError>;

impl SystoolsError {
    pub fn new(code: SystoolsErrorCode, operation: Option<&'static str>, retryable: bool) -> Self {
        let mut details = BTreeMap::new();
        if let Some(operation) = operation {
            details.insert("operation", operation);
        }
        Self {
            code,
            details,
            retryable,
        }
    }

    pub fn invalid_input(operation: &'static str) -> Self {
        Self::new(SystoolsErrorCode::InvalidInput, Some(operation), false)
    }

    pub fn operation_failed(operation: &'static str) -> Self {
        Self::new(SystoolsErrorCode::OperationFailed, Some(operation), true)
    }

    pub fn busy(operation: &'static str) -> Self {
        Self::new(SystoolsErrorCode::OperationBusy, Some(operation), true)
    }

    pub fn cancelled() -> Self {
        Self::new(SystoolsErrorCode::OperationCancelled, None, false)
    }

    pub fn permission_denied(operation: &'static str) -> Self {
        Self::new(SystoolsErrorCode::PermissionDenied, Some(operation), false)
    }

    pub fn persistence(operation: &'static str) -> Self {
        Self::new(SystoolsErrorCode::PersistenceFailed, Some(operation), true)
    }

    pub fn task_join_failed(operation: &'static str) -> Self {
        Self::new(SystoolsErrorCode::TaskJoinFailed, Some(operation), true)
    }

    pub fn not_implemented(operation: &'static str) -> Self {
        Self::new(SystoolsErrorCode::NotImplemented, Some(operation), false)
    }
}

impl fmt::Display for SystoolsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.details.get("operation") {
            Some(operation) => write!(formatter, "{:?}: {operation}", self.code),
            None => write!(formatter, "{:?}", self.code),
        }
    }
}

impl std::error::Error for SystoolsError {}

/// Returns the stable placeholder error used by command modules that are not
/// implemented yet.
pub fn not_implemented<T>(operation: &'static str) -> SystoolsResult<T> {
    Err(SystoolsError::not_implemented(operation))
}
