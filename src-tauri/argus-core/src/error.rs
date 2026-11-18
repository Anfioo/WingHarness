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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_serialize_in_kebab_case() {
        for (code, wire) in [
            (ArgusErrorCode::NotFound, "not-found"),
            (ArgusErrorCode::InvalidInput, "invalid-input"),
            (ArgusErrorCode::AccessDenied, "access-denied"),
            (ArgusErrorCode::ServiceUnavailable, "service-unavailable"),
            (ArgusErrorCode::Internal, "internal"),
        ] {
            let error = ArgusError::new(code, "message");
            assert_eq!(
                serde_json::to_value(&error).unwrap(),
                serde_json::json!({ "code": wire, "message": "message" })
            );
        }
    }

    #[test]
    fn detail_is_only_serialized_when_present() {
        let plain = ArgusError::new(ArgusErrorCode::Internal, "plain");
        assert_eq!(
            serde_json::to_value(&plain).unwrap(),
            serde_json::json!({ "code": "internal", "message": "plain" })
        );

        let detailed = ArgusError {
            detail: Some("exit code 5".into()),
            ..ArgusError::new(ArgusErrorCode::Internal, "plain")
        };
        assert_eq!(
            serde_json::to_value(&detailed).unwrap(),
            serde_json::json!({
                "code": "internal",
                "message": "plain",
                "detail": "exit code 5",
            })
        );
    }

    #[test]
    fn constructors_set_their_codes() {
        assert!(matches!(
            ArgusError::invalid_input("bad").code,
            ArgusErrorCode::InvalidInput
        ));
        assert!(matches!(
            ArgusError::internal("boom").code,
            ArgusErrorCode::Internal
        ));
    }

    #[test]
    fn display_is_the_message() {
        let error = ArgusError::new(ArgusErrorCode::NotFound, "The process has already exited.");
        assert_eq!(error.to_string(), "The process has already exited.");
    }
}
