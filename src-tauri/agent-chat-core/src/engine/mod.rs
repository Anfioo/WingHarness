//! Engine abstraction and the send/interrupt orchestration.
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/desktop-cc-gui.
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

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};

use crate::engine::reader::{run_child_turn, TurnCore};
use crate::engine::registry::{run_id_from_input, ChildEntry};
use crate::error::AgentChatError;
use crate::models::{AgentEngineInfo, AgentSendInput, AgentSendResult};
use crate::AgentChatState;

/// §5.3: a single local CLI host cannot serve more parallel turns than this.
const MAX_CONCURRENT_RUNS: usize = 3;

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

/// Starts one turn. Child engines are spawned here; own-transport engines
/// spawn inside their driver and only need the run registered up front, so a
/// Stop that lands during the launch window still routes to them.
pub async fn send(
    state: &AgentChatState,
    input: AgentSendInput,
) -> Result<AgentSendResult, AgentChatError> {
    let engine = engine_by_id(input.engine.trim()).ok_or_else(|| {
        AgentChatError::invalid_input(format!("Unknown engine {:?}.", input.engine))
    })?;
    let prompt = input.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err(AgentChatError::invalid_input("The prompt is empty."));
    }
    let workspace = PathBuf::from(input.workspace_path.trim());
    if workspace.as_os_str().is_empty() {
        return Err(AgentChatError::invalid_input("The workspace path is empty."));
    }
    if !workspace.is_dir() {
        return Err(AgentChatError::invalid_input(format!(
            "The workspace directory {} does not exist.",
            workspace.display()
        )));
    }
    // Probe before reserving: a missing CLI is the common failure and must not
    // consume a run slot or a run id.
    let bin = resolve::find_cli_binary(engine.id())
        .ok_or_else(|| AgentChatError::engine_unavailable(engine.id()))?
        .to_string_lossy()
        .into_owned();

    let run_id = run_id_from_input(input.run_id);
    if state.processes.get(&run_id).is_some() {
        return Err(AgentChatError::conflict("That run id is already active."));
    }
    if state.processes.active_run_count() >= MAX_CONCURRENT_RUNS {
        return Err(AgentChatError::conflict(format!(
            "At most {MAX_CONCURRENT_RUNS} runs can be active at once; stop one first."
        )));
    }

    let session_id = input
        .session_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    let req = SendRequest {
        run_id: run_id.clone(),
        engine: engine.id().to_string(),
        workspace,
        session_id: session_id.clone(),
        prompt,
        model: non_empty(input.model),
        effort: non_empty(input.effort),
        permission: non_empty(input.permission),
        additional_dirs: input.additional_dirs.unwrap_or_default(),
    };

    // Reservation: the driver replaces this entry once its child exists, and
    // the shared `killed` flag carries a Stop across the whole launch.
    let killed = Arc::new(AtomicBool::new(false));
    let placeholder = ChildEntry {
        child: None,
        pid: 0,
        run_id: run_id.clone(),
        killed,
        stdin: None,
        questions: Arc::new(Mutex::new(HashMap::new())),
    };
    state.processes.insert(run_id.clone(), placeholder.clone());
    if let Some(session_id) = session_id.as_deref() {
        state.processes.insert(session_id.to_string(), placeholder);
    }

    if let Err(error) = start_run(state, engine, req, bin) {
        state.processes.remove(&run_id);
        return Err(error);
    }
    Ok(AgentSendResult {
        run_id,
        session_id,
    })
}

/// Hands the reserved run to the engine's driver. Every driver owns its
/// process and settles the turn itself; this function only picks the driver.
fn start_run(
    state: &AgentChatState,
    engine: Box<dyn Engine>,
    req: SendRequest,
    bin: String,
) -> Result<(), AgentChatError> {
    let run_id = req.run_id.clone();
    let entry = state
        .processes
        .get(&run_id)
        .ok_or_else(|| AgentChatError::not_running(&run_id))?;
    let killed = entry.killed;
    let core = TurnCore {
        run_id: run_id.clone(),
        engine_id: engine.id(),
        sink: Arc::clone(&state.sink),
        registry: Arc::clone(&state.processes),
    };

    if engine.drives_own_transport() {
        match engine.id() {
            "codex" => {
                let built = engine.host_command(&req, &bin)?;
                tauri::async_runtime::spawn(codex_app::run_app_server_turn(
                    core, req, built, killed, 0,
                ));
            }
            "qoder" | "qoder-cn" => {
                tauri::async_runtime::spawn(acp::run_acp_turn(core, req, bin, killed, 0));
            }
            other => {
                return Err(AgentChatError::unsupported(format!(
                    "{other} drives its own transport but has no registered driver."
                )))
            }
        }
    } else {
        let built = engine.build_command(&req, &bin)?;
        tauri::async_runtime::spawn(run_child_turn(core, engine, req, built, killed, 0));
    }
    Ok(())
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
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
///
/// The parked payload says which protocol answers it: Codex's app-server
/// questions carry the request id and the question-text -> id map, so the
/// frame is built by `codex_app`; everything else is a Claude control request
/// whose answer merges into the tool input.
pub async fn answer(
    state: &AgentChatState,
    run_id: &str,
    request_id: &str,
    answers: Option<serde_json::Value>,
) -> Result<(), AgentChatError> {
    let entry = state
        .processes
        .get(run_id)
        .ok_or_else(|| AgentChatError::not_running(run_id))?;
    // Peek, don't remove: a failed write leaves the card answerable.
    let input = entry
        .questions
        .lock()
        .map_err(|_| AgentChatError::internal("The question state is poisoned."))?
        .get(request_id)
        .cloned()
        .ok_or_else(|| AgentChatError::invalid_input("That question is no longer pending."))?;

    let frame = if input.get("codexApp").is_some() {
        codex_app::answer_frame(&input, answers.as_ref())?
    } else {
        claude_answer_frame(&input, request_id, answers.as_ref())
    };
    state
        .processes
        .write_line(&entry.run_id, frame.to_string())
        .await?;
    if let Ok(mut questions) = entry.questions.lock() {
        questions.remove(request_id);
    }
    Ok(())
}

/// Claude's SDK control protocol: the chosen labels ride back inside the
/// original tool input, under `answers`.
fn claude_answer_frame(input: &Value, request_id: &str, answers: Option<&Value>) -> Value {
    let mut updated = match input {
        Value::Object(map) => map.clone(),
        other => {
            let mut map = Map::new();
            map.insert("questions".to_string(), other.clone());
            map
        }
    };
    if let Some(answers) = answers {
        updated.insert("answers".to_string(), answers.clone());
    }
    serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": {
                "behavior": "allow",
                "updatedInput": Value::Object(updated),
            },
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_answers_merge_into_the_tool_input() {
        let input = json!({ "questions": [{ "question": "Which one?" }] });
        let frame = claude_answer_frame(
            &input,
            "req-1",
            Some(&json!({ "Which one?": "A" })),
        );
        assert_eq!(frame["type"], "control_response");
        assert_eq!(frame["response"]["request_id"], "req-1");
        assert_eq!(frame["response"]["response"]["behavior"], "allow");
        assert_eq!(
            frame["response"]["response"]["updatedInput"]["answers"],
            json!({ "Which one?": "A" })
        );
        assert_eq!(
            frame["response"]["response"]["updatedInput"]["questions"],
            input["questions"]
        );
    }

    #[test]
    fn a_dismissed_claude_question_still_answers_the_control_request() {
        let frame = claude_answer_frame(&json!({}), "req-2", None);
        assert_eq!(frame["response"]["subtype"], "success");
        assert!(frame["response"]["response"]["updatedInput"]
            .get("answers")
            .is_none());
    }
}
