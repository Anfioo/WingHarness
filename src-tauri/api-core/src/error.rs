use serde::Serialize;

/// Every command boundary error. It serializes to `{ code, message }` so the
/// frontend can branch on `code` and show `message` verbatim.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Http(#[from] reqwest::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Url(#[from] url::ParseError),
    #[error("{0}")]
    Other(String),
    #[error("the workspace was changed elsewhere; reload it and try again")]
    Conflict,
    #[error("the request was cancelled")]
    Cancelled,
    #[error("not found: {0}")]
    NotFound(String),
}

impl AppError {
    pub fn other(message: impl Into<String>) -> Self {
        AppError::Other(message.into())
    }

    pub fn code(&self) -> &'static str {
        match self {
            AppError::Http(_) => "http",
            AppError::Io(error) => match error.kind() {
                std::io::ErrorKind::NotFound => "not_found",
                _ => "io",
            },
            AppError::Json(_) => "json",
            AppError::Url(_) => "url",
            AppError::Other(_) => "other",
            AppError::Conflict => "conflict",
            AppError::Cancelled => "cancelled",
            AppError::NotFound(_) => "not_found",
        }
    }
}

#[derive(Serialize)]
struct ErrorPayload<'a> {
    code: &'a str,
    message: String,
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        ErrorPayload {
            code: self.code(),
            message: self.to_string(),
        }
        .serialize(serializer)
    }
}

pub type AppResult<T> = Result<T, AppError>;
