//! Operations that change process state.
//!
//! A0 freezes the types only; B3 ports the Windows calls and the process-tree
//! walk.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum ActionError {
    /// Needs administrator rights (or the target is protected).
    AccessDenied,
    /// The process has already exited (or its PID was reused).
    NotFound,
    /// Terminating it would crash the system; requires explicit confirmation.
    Critical,
    /// Refused: the System process, Idle, or the task manager itself.
    Refused,
    /// Denied to this app's own rights while the privileged service needs an
    /// update: updating the service lets it act again.
    ServiceOutdated,
    Os(String),
}

impl ActionError {
    pub fn diagnostic(&self) -> std::borrow::Cow<'static, str> {
        match self {
            Self::AccessDenied => "access denied".into(),
            Self::NotFound => "target exited or identity changed".into(),
            Self::Critical => "critical process requires confirmation".into(),
            Self::Refused => "operation refused by policy".into(),
            Self::ServiceOutdated => "privileged service protocol incompatible".into(),
            Self::Os(message) => message.clone().into(),
        }
    }
}

/// A process priority class.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Priority {
    Idle,
    BelowNormal,
    Normal,
    AboveNormal,
    High,
    Realtime,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeKillReport {
    pub terminated: u32,
    pub failed: u32,
    /// A descendant was denied while the privileged service needs an update,
    /// so the UI offers it.
    pub service_outdated: bool,
}
