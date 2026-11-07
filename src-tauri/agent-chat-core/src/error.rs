/// Stable error categories that cross the Tauri command boundary.
///
/// The frontend maps these codes onto `agentChat.error.*`; `message` stays
/// English and is only a fallback for the log.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentChatErrorCode {
    NotFound,
    InvalidInput,
    EngineUnavailable,
    NotRunning,
    Conflict,
    Unsupported,
    Internal,
    NotImplemented,
}

/// The single error type every `agent_*` command returns.
#[derive(Debug, Clone, thiserror::Error, serde::Serialize)]
#[error("{message}")]
pub struct AgentChatError {
    pub code: AgentChatErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

pub type AgentChatResult<T> = Result<T, AgentChatError>;

impl AgentChatError {
    pub fn new(code: AgentChatErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// The placeholder every command returns until its lane implements it.
    pub fn not_implemented() -> Self {
        Self::new(
            AgentChatErrorCode::NotImplemented,
            "This Agent chat command is not implemented yet.",
        )
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(AgentChatErrorCode::NotFound, message)
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(AgentChatErrorCode::InvalidInput, message)
    }

    pub fn engine_unavailable(engine: &str) -> Self {
        Self::new(
            AgentChatErrorCode::EngineUnavailable,
            format!("The {engine} command line tool was not found on PATH."),
        )
        .with_detail(format!("engine={engine}"))
    }

    pub fn not_running(run_id: &str) -> Self {
        Self::new(
            AgentChatErrorCode::NotRunning,
            "The run is no longer active.",
        )
        .with_detail(format!("runId={run_id}"))
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(AgentChatErrorCode::Conflict, message)
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(AgentChatErrorCode::Unsupported, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(AgentChatErrorCode::Internal, message)
    }
}
