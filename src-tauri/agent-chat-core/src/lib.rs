//! Backend for the Agent chat page.
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/ccgui-next.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! Ownership after A0: the `Engine` trait, DTOs, error taxonomy and the page's
//! persisted UI state stay stable here; engine adapters and the history scanner
//! are filled by the B lanes without changing those signatures.

pub mod commands;
pub mod engine;
pub mod error;
pub mod history;
pub mod models;
pub mod paths;
pub mod store;

use std::sync::Arc;

use tauri::AppHandle;

pub use error::{AgentChatError, AgentChatErrorCode, AgentChatResult};
pub use models::{
    AgentEngineInfo, AgentMessage, AgentRunEvent, AgentSendInput, AgentSendResult, AgentSessionMeta,
    AgentSessionPage, AgentTab, AgentUiState,
};

use engine::registry::ProcessRegistry;
use engine::sink::EventSink;

/// Tauri-managed state for every `agent_*` command.
pub struct AgentChatState {
    /// Owns the `agent:event` channel and the per-flush batch.
    pub sink: Arc<EventSink>,
    /// Live runs and their session bindings.
    pub processes: Arc<ProcessRegistry>,
    app: AppHandle,
}

impl AgentChatState {
    pub fn new(app: AppHandle) -> Self {
        Self {
            sink: EventSink::new(app.clone()),
            processes: Arc::new(ProcessRegistry::new()),
            app,
        }
    }

    /// The handle the engine drivers use to spawn and emit.
    pub fn app(&self) -> &AppHandle {
        &self.app
    }

    /// Kills every live run. Called once from `RunEvent::Exit`, so a hard quit
    /// never leaves an engine child behind.
    pub fn shutdown(&self) {
        self.processes.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_serializes_to_kebab_case_codes() {
        let error = AgentChatError::not_found("session");
        let json = serde_json::to_value(&error).expect("error serializes");
        assert_eq!(json["code"], "not-found");
        assert_eq!(json["message"], "session");
    }

    #[test]
    fn default_ui_state_carries_one_version() {
        assert_eq!(AgentUiState::default().version, 1);
    }
}
