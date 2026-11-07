//! Engine abstraction and the send/interrupt orchestration.
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/ccgui-next.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! A0 freezes the public surface here: the `Engine` trait, `Transport`,
//! `SendRequest`, `BuiltCommand`, `engine_by_id`, `engine_infos`, `send`,
//! `interrupt`, `live_runs` and `answer`. The lanes only fill implementations.

pub mod acp;
pub mod claude;
pub mod codex;
pub mod codex_app;
pub mod events;
pub mod qoder;
pub mod reader;
pub mod registry;
pub mod resolve;
pub mod rpc;
pub mod sink;

use crate::error::AgentChatError;
use crate::models::{AgentEngineInfo, AgentSendInput, AgentSendResult};
use crate::AgentChatState;

/// Which transport one send uses. On `Own` the app spawns no engine child:
/// the host driver task owns the process and settles the turn itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transport {
    /// The app spawns the CLI and reads its stdout.
    Child,
    /// The engine drives its own transport (app-server, ACP).
    Own,
}

#[derive(Clone, Debug)]
pub struct SendRequest {
    pub run_id: String,
    pub engine: String,
    pub workspace: std::path::PathBuf,
    pub session_id: Option<String>,
    pub prompt: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission: Option<String>,
    pub additional_dirs: Vec<String>,
}

pub struct BuiltCommand {
    pub command: tokio::process::Command,
    /// Written to stdin after spawn.
    pub stdin_payload: Option<String>,
    /// Keep the child's stdin open after the payload instead of closing it.
    pub keep_stdin_open: bool,
    /// Session id assigned before spawn, when the engine can pick it.
    pub preassigned_session_id: Option<String>,
}

pub trait Engine: Send + Sync {
    fn id(&self) -> &'static str;

    fn build_command(&self, req: &SendRequest, bin: &str) -> Result<BuiltCommand, AgentChatError>;

    /// The command a host-transport driver spawns. Engines without a local
    /// child never touch this.
    fn host_command(
        &self,
        _req: &SendRequest,
        _bin: &str,
    ) -> Result<BuiltCommand, AgentChatError> {
        Err(AgentChatError::unsupported(format!(
            "{} builds no host command",
            self.id()
        )))
    }

    /// Parse one NDJSON stdout line into zero or more normalized events.
    fn parse_line(&self, line: &str, out: &mut Vec<events::EngineEvent>);

    fn drives_own_transport(&self) -> bool {
        false
    }

    fn supports_effort(&self) -> bool {
        false
    }

    fn supported_permissions(&self) -> &'static [&'static str] {
        &["auto"]
    }

    /// Effective mode for one send: the requested mode when this engine
    /// supports it, otherwise the engine's first supported mode.
    fn resolve_permission(&self, requested: Option<&str>) -> &'static str {
        let supported = self.supported_permissions();
        requested
            .and_then(|mode| supported.iter().copied().find(|candidate| *candidate == mode))
            .unwrap_or_else(|| supported.first().copied().unwrap_or("auto"))
    }
}

/// Resolve an engine id to its adapter. All three engines exist from A0 so the
/// lanes only fill implementations.
pub fn engine_by_id(id: &str) -> Option<Box<dyn Engine>> {
    match id {
        "claude" => Some(Box::new(claude::ClaudeEngine)),
        "codex" => Some(Box::new(codex::CodexEngine)),
        "qoder" => Some(Box::new(qoder::QoderEngine)),
        _ => None,
    }
}

/// The three engines as the frontend picker renders them.
pub fn engine_infos() -> Vec<AgentEngineInfo> {
    ["claude", "codex", "qoder"]
        .iter()
        .filter_map(|id| {
            let engine = engine_by_id(id)?;
            let bin = resolve::find_cli_binary(id);
            Some(AgentEngineInfo {
                id: (*id).to_string(),
                label: engine_label(id).to_string(),
                available: bin.is_some(),
                bin: bin.map(|path| path.display().to_string()),
                models: Vec::new(),
                supports_effort: engine.supports_effort(),
                permissions: engine
                    .supported_permissions()
                    .iter()
                    .map(|mode| (*mode).to_string())
                    .collect(),
                transport: if engine.drives_own_transport() {
                    "own"
                } else {
                    "child"
                }
                .to_string(),
            })
        })
        .collect()
}

fn engine_label(id: &str) -> &'static str {
    match id {
        "claude" => "Claude Code",
        "codex" => "Codex",
        "qoder" => "Qoder",
        _ => "",
    }
}

/// Starts one turn. A0 leaves this to B1/B2/B3.
pub async fn send(
    state: &AgentChatState,
    input: AgentSendInput,
) -> Result<AgentSendResult, AgentChatError> {
    let _ = (state, input);
    Err(AgentChatError::not_implemented())
}

/// Kills the run's process tree. Returns false when the run is unknown.
pub fn interrupt(state: &AgentChatState, run_id: &str) -> bool {
    state.processes.kill(run_id)
}

/// Filters `run_ids` down to the ones still alive.
pub fn live_runs(state: &AgentChatState, run_ids: &[String]) -> Vec<String> {
    state.processes.live_run_ids(run_ids)
}

/// Answers a question or permission request parked on the run's transport.
pub async fn answer(
    state: &AgentChatState,
    run_id: &str,
    request_id: &str,
    answers: Option<serde_json::Value>,
) -> Result<(), AgentChatError> {
    let _ = (state, run_id, request_id, answers);
    Err(AgentChatError::not_implemented())
}
