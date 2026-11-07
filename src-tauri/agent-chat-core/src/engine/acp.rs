//! ACP driver: one send = one `qodercli --acp` child speaking JSON-RPC over
//! stdio.
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/ccgui-next.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! Wire: spawn with `--acp --permission-mode bypass_permissions`, then
//! `initialize` → `session/new` | `session/resume` → optional
//! `session/set_model` → optional `session/set_config_option`
//! (`reasoning_effort`) → `session/set_mode` when the session is not already
//! in bypass → `session/prompt`. The turn streams as `session/update`
//! notifications and settles on the typed prompt response.
//!
//! qodercli interleaves that response into the notification stream (first
//! user chunk → result → thought/tool/final text), so the driver keeps
//! draining after the response until the stream goes idle; otherwise the
//! tail of the turn is lost.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::process::{Child, ChildStderr};
use tokio::sync::{Mutex as TokioMutex, Notify};
use tokio::time::{timeout, Instant};

use crate::engine::events::{self, EngineEvent};
use crate::engine::qoder::is_qoder_ide_launcher_bin;
use crate::engine::reader::{TurnCore, TurnState};
use crate::engine::registry::ChildEntry;
use crate::engine::resolve;
use crate::engine::rpc::LineRpc;
use crate::engine::SendRequest;
use crate::error::AgentChatError;

const ACP_PROTOCOL_VERSION: u32 = 1;
/// Handshake calls other than `session/new` scan nothing, so a plain RPC
/// budget is enough.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
/// `session/new` scans the workspace on first contact; large repositories
/// measured past 30 s upstream, so this call gets far more headroom.
const SESSION_NEW_TIMEOUT: Duration = Duration::from_secs(90);
/// `session/resume` re-attaches without the workspace scan.
const SESSION_RESUME_TIMEOUT: Duration = Duration::from_secs(30);
/// qodercli slips the prompt response between notifications; keep reading
/// until the stream has been idle for this long…
const PROMPT_TRAILING_IDLE: Duration = Duration::from_millis(400);
/// …but never drain for longer than this.
const PROMPT_TRAILING_CAP: Duration = Duration::from_secs(2);
/// Grace for the child to exit after `start_kill`.
const POST_TERMINAL_DRAIN: Duration = Duration::from_millis(250);
/// Killed-flag poll cadence for the interrupt watcher.
const KILL_POLL: Duration = Duration::from_millis(150);
const STDERR_KEEP_BYTES: usize = 4096;

const JSONRPC_METHOD_NOT_FOUND: i64 = -32601;
const JSONRPC_INVALID_PARAMS: i64 = -32602;
const JSONRPC_INTERNAL_ERROR: i64 = -32603;

/// Terminal marker for a kill-interrupted request; the settle path swallows it
/// via the killed flag, so an interrupt commits partial output instead of
/// surfacing an error.
const CANCELLED: &str = "The ACP turn was cancelled.";

/// Start every session in bypass mode through the documented startup flag.
/// Newer CLIs map the ACP `bypassPermissions` mode to their internal `yolo`
/// id, which their own set_permission_mode then rejects, so `session/set_mode`
/// is only a fallback for CLIs that ignore the flag.
const ACP_LAUNCH_ARGS: [&str; 3] = ["--acp", "--permission-mode", "bypass_permissions"];

// ==================== turn driver ====================

/// Per-turn projection state.
#[derive(Default)]
struct TurnView {
    /// `[Error]`-prefixed chunks are held back from the text stream and become
    /// the terminal error message when the turn fails.
    pending_error_chunks: Vec<String>,
    last_usage: Option<Value>,
    /// toolCallId → tool name from `tool_call` starts, so a matching
    /// `tool_call_update` patch can keep the row's name.
    tool_names: HashMap<String, String>,
}

/// Drive one send as a Qoder ACP turn.
///
/// Settle contract matches `reader::run_child_turn`: a transport failure is an
/// `Error` unless the user stopped the run, and a turn that never reported a
/// terminal event is closed with `Done`.
pub async fn run_acp_turn(
    core: TurnCore,
    req: SendRequest,
    bin: String,
    killed: Arc<AtomicBool>,
    virtual_pid: u32,
) {
    let mut state = TurnState::new(req.session_id.clone());
    let mut view = TurnView::default();
    let result = drive_turn(&core, &mut state, &mut view, &req, &bin, &killed, virtual_pid).await;
    settle(&core, &mut state, &view, result, &killed).await;
}

async fn settle(
    core: &TurnCore,
    state: &mut TurnState,
    view: &TurnView,
    result: Result<(), AgentChatError>,
    killed: &Arc<AtomicBool>,
) {
    let was_killed = killed.load(Ordering::SeqCst);
    if let Err(error) = result {
        // A stopped turn is an interruption, not an error.
        if !was_killed {
            core.dispatch_event(state, EngineEvent::Error(error_text(&error)));
        }
    }
    if !state.saw_done && !state.saw_error {
        let usage = if was_killed {
            None
        } else {
            view.last_usage.clone()
        };
        let session_id = state.native_session_id.clone();
        core.dispatch_event(state, EngineEvent::Done { session_id, usage });
    }

    // Kill the tree (the CLI may be a shim with a node child), then drop the
    // bookkeeping. `kill` also raises the shared flag.
    let _ = core.registry.kill(&core.run_id);
    core.registry.remove(&core.run_id);
    core.sink.flush();
}

async fn drive_turn(
    core: &TurnCore,
    state: &mut TurnState,
    view: &mut TurnView,
    req: &SendRequest,
    bin: &str,
    killed: &Arc<AtomicBool>,
    virtual_pid: u32,
) -> Result<(), AgentChatError> {
    if is_qoder_ide_launcher_bin(bin) {
        return Err(AgentChatError::invalid_input(
            "The Qoder IDE launcher (`qoder`) does not speak ACP; point the engine at `qodercli`.",
        ));
    }
    if killed.load(Ordering::SeqCst) {
        // Stopped before the launch finished; nothing to spawn.
        return Ok(());
    }

    let plan = resolve::spawn_plan(bin);
    let mut command = tokio::process::Command::new(&plan.program);
    command
        .args(&plan.prefix)
        .args(ACP_LAUNCH_ARGS)
        .current_dir(&req.workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    resolve::apply_no_window(&mut command);

    let mut child = command.spawn().map_err(|error| {
        AgentChatError::internal(format!("Failed to spawn the Qoder ACP session: {error}"))
    })?;
    let (stdin, stdout, stderr) =
        match (child.stdin.take(), child.stdout.take(), child.stderr.take()) {
            (Some(stdin), Some(stdout), Some(stderr)) => (stdin, stdout, stderr),
            _ => {
                let _ = child.start_kill();
                return Err(AgentChatError::internal(
                    "The Qoder ACP session did not expose its stdio pipes.",
                ));
            }
        };
    let stderr_buf = spawn_stderr_drain(stderr);
    let stdin = Arc::new(TokioMutex::new(Some(stdin)));
    // A `cmd /C` shim leaves its node child alive if only the direct child is
    // signalled, so the registry keeps the real pid for tree kills.
    let pid = child.id().unwrap_or(virtual_pid);
    let child = Arc::new(TokioMutex::new(child));
    core.registry.insert(
        core.run_id.clone(),
        ChildEntry {
            child: Some(Arc::clone(&child)),
            pid,
            run_id: core.run_id.clone(),
            killed: Arc::clone(killed),
            stdin: Some(Arc::clone(&stdin)),
            // ACP permission requests are auto-allowed; nothing is parked.
            questions: Arc::new(Mutex::new(HashMap::new())),
        },
    );

    let mut acp = AcpProcess::new(LineRpc::new(stdin, stdout), Arc::clone(killed));
    let result = handshake_and_prompt(&mut acp, core, state, view, req, killed).await;
    drop(acp);
    teardown(&child).await;
    result.map_err(|error| terminal_message(error, view, &stderr_buf))
}

/// The CLI stays resident after the response (ACP is a session protocol), so
/// every exit path tears the tree down.
async fn teardown(child: &Arc<TokioMutex<Child>>) {
    let mut guard = child.lock().await;
    if let Some(pid) = guard.id() {
        resolve::kill_process_tree(pid);
    }
    let _ = guard.start_kill();
    let _ = timeout(POST_TERMINAL_DRAIN, guard.wait()).await;
}

// ==================== handshake ====================

async fn handshake_and_prompt(
    acp: &mut AcpProcess,
    core: &TurnCore,
    state: &mut TurnState,
    view: &mut TurnView,
    req: &SendRequest,
    killed: &AtomicBool,
) -> Result<(), AgentChatError> {
    acp.request(
        "initialize",
        initialize_params(),
        Some(HANDSHAKE_TIMEOUT),
        killed,
        &mut |_| {},
    )
    .await?;

    let cwd = req.workspace.to_string_lossy().to_string();
    let session_result = match req.session_id.as_deref() {
        Some(session_id) => {
            acp.request(
                "session/resume",
                json!({ "cwd": cwd, "mcpServers": [], "sessionId": session_id }),
                Some(SESSION_RESUME_TIMEOUT),
                killed,
                &mut |_| {},
            )
            .await?
        }
        None => {
            acp.request(
                "session/new",
                json!({ "cwd": cwd, "mcpServers": [] }),
                Some(SESSION_NEW_TIMEOUT),
                killed,
                &mut |_| {},
            )
            .await?
        }
    };
    let session_id = extract_session_id(&session_result)
        .or_else(|| req.session_id.clone())
        .ok_or_else(|| {
            AgentChatError::internal("The Qoder session handshake returned no session id.")
        })?;
    core.dispatch_event(state, EngineEvent::SessionId(session_id.clone()));

    if let Some(model) = non_empty(req.model.as_deref()) {
        acp.request(
            "session/set_model",
            json!({ "sessionId": session_id, "modelId": model }),
            Some(HANDSHAKE_TIMEOUT),
            killed,
            &mut |_| {},
        )
        .await
        .map_err(|error| setting_error("model", model, error))?;
    }
    if let Some(effort) = non_empty(req.effort.as_deref()) {
        acp.request(
            "session/set_config_option",
            json!({ "sessionId": session_id, "configId": "reasoning_effort", "value": effort }),
            Some(HANDSHAKE_TIMEOUT),
            killed,
            &mut |_| {},
        )
        .await
        .map_err(|error| setting_error("reasoning effort", effort, error))?;
    }
    // Only switch when the startup flag did not take; the CLI's own error then
    // surfaces instead of a silently non-bypass turn.
    if !bypass_mode_active(&session_result) {
        acp.request(
            "session/set_mode",
            json!({ "sessionId": session_id, "modeId": "bypassPermissions" }),
            Some(HANDSHAKE_TIMEOUT),
            killed,
            &mut |_| {},
        )
        .await?;
    }

    // A prompt turn has no wall-clock cap: it ends on its own response, the
    // CLI's EOF, or the user's stop.
    let prompt_blocks = json!([{ "type": "text", "text": req.prompt }]);
    let result = acp
        .request(
            "session/prompt",
            json!({ "sessionId": session_id, "prompt": prompt_blocks }),
            None,
            killed,
            &mut |params| handle_session_update(core, state, view, params),
        )
        .await?;
    if let Some(usage) = result.get("usage").filter(|usage| !usage.is_null()) {
        view.last_usage = Some(usage.clone());
        core.dispatch_event(state, EngineEvent::Usage(usage.clone()));
    }
    Ok(())
}

/// ACP client capabilities and identity. The `fs` capability is deliberately
/// not advertised: ACP first version lets qodercli use its own tools instead
/// of serving files from the app.
pub(crate) fn initialize_params() -> Value {
    json!({
        "protocolVersion": ACP_PROTOCOL_VERSION,
        "clientInfo": {
            "name": "wingharness",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "clientCapabilities": {},
    })
}

fn extract_session_id(value: &Value) -> Option<String> {
    value
        .get("sessionId")
        .or_else(|| value.get("session_id"))
        .or_else(|| value.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Whether `session/new|resume` already reports bypass: older CLIs name it
/// `bypassPermissions`, newer ones report the internal `yolo` id.
fn bypass_mode_active(session_result: &Value) -> bool {
    matches!(
        session_result
            .pointer("/modes/currentModeId")
            .and_then(Value::as_str),
        Some("bypassPermissions" | "yolo")
    )
}

fn setting_error(setting: &str, value: &str, error: AgentChatError) -> AgentChatError {
    AgentChatError::internal(format!(
        "Qoder {setting} `{value}` setup failed: {}",
        error.message
    ))
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

// ==================== session/update projection ====================

/// One `session/update` payload projected onto normalized events. `plan` and
/// `available_commands_update` are UI noise for this page and project to
/// nothing.
pub(crate) fn map_session_update(update: &Value) -> Vec<EngineEvent> {
    let kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or("");
    match kind {
        "agent_message_chunk" => non_empty_owned(extract_content_text(update.get("content")))
            .map(EngineEvent::Delta)
            .into_iter()
            .collect(),
        "agent_thought_chunk" => non_empty_owned(extract_content_text(update.get("content")))
            .map(EngineEvent::Thinking)
            .into_iter()
            .collect(),
        "tool_call" => project_tool_call(update),
        "tool_call_update" => project_tool_call_update(update),
        _ => Vec::new(),
    }
}

fn project_tool_call(update: &Value) -> Vec<EngineEvent> {
    let status = update
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("pending");
    let Some(tool_id) = extract_tool_call_id(update) else {
        return Vec::new();
    };
    let name = extract_tool_name(update).unwrap_or_else(|| "tool".to_string());
    let input = update
        .get("rawInput")
        .cloned()
        .or_else(|| update.get("input").cloned());
    match status {
        // A replay compresses a tool into one completed snapshot; it must
        // render as a full row rather than a patch no start event created.
        "completed" | "failed" => {
            let args = input.as_ref().and_then(events::parse_tool_args_value);
            vec![EngineEvent::Message {
                role: "tool".to_string(),
                text: name,
                path: args.as_ref().and_then(events::tool_path_arg),
                args,
                result: tool_completion_result(update, status),
                tool_call_id: Some(tool_id),
                patch: false,
            }]
        }
        "pending" | "in_progress" => vec![events::tool_call_message_with_id(
            name,
            input.as_ref(),
            Some(&tool_id),
        )],
        _ => Vec::new(),
    }
}

fn project_tool_call_update(update: &Value) -> Vec<EngineEvent> {
    let status = update.get("status").and_then(Value::as_str).unwrap_or("");
    if status != "completed" && status != "failed" {
        return Vec::new();
    }
    let Some(tool_id) = extract_tool_call_id(update) else {
        return Vec::new();
    };
    vec![EngineEvent::Message {
        role: "tool".to_string(),
        // Filled from the start event by the driver when the update omits it.
        text: extract_tool_name(update).unwrap_or_default(),
        path: None,
        args: None,
        result: tool_completion_result(update, status),
        tool_call_id: Some(tool_id),
        patch: true,
    }]
}

fn tool_completion_result(update: &Value, status: &str) -> Option<Value> {
    if status == "failed" {
        let text = extract_tool_content_text(update).trim().to_string();
        return Some(if text.is_empty() {
            json!({ "isError": true })
        } else {
            json!({ "text": text, "isError": true })
        });
    }
    update
        .get("rawOutput")
        .cloned()
        .or_else(|| update.get("output").cloned())
        .or_else(|| update.get("content").cloned())
        .filter(|value| !value.is_null())
}

fn extract_content_text(content: Option<&Value>) -> String {
    let Some(content) = content else {
        return String::new();
    };
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    for key in ["text", "thinking"] {
        if let Some(text) = content.get(key).and_then(Value::as_str) {
            return text.to_string();
        }
    }
    let Some(parts) = content.as_array() else {
        return String::new();
    };
    let mut text = String::new();
    for part in parts {
        if let Some(part) = part.as_str() {
            text.push_str(part);
        } else if let Some(part) = part.get("text").and_then(Value::as_str) {
            text.push_str(part);
        } else if let Some(part) = part.get("thinking").and_then(Value::as_str) {
            text.push_str(part);
        } else {
            text.push_str(&extract_content_text(part.get("content")));
        }
    }
    text
}

fn extract_tool_call_id(update: &Value) -> Option<String> {
    update
        .get("toolCallId")
        .or_else(|| update.get("toolCallID"))
        .or_else(|| update.get("tool_call_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn extract_tool_name(update: &Value) -> Option<String> {
    update
        .get("_meta")
        .and_then(|meta| meta.get("qoder"))
        .and_then(|qoder| qoder.get("toolName"))
        .and_then(Value::as_str)
        .or_else(|| update.get("title").and_then(Value::as_str))
        .or_else(|| update.get("kind").and_then(Value::as_str))
        .or_else(|| update.get("name").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn extract_tool_content_text(update: &Value) -> String {
    let from_blocks = extract_content_text(update.get("content"));
    if !from_blocks.trim().is_empty() {
        return from_blocks;
    }
    let from_raw = extract_content_text(update.get("rawOutput"));
    if !from_raw.trim().is_empty() {
        return from_raw;
    }
    extract_content_text(update.get("output"))
}

/// qodercli prefixes model-level failures it could not map to an RPC error
/// into the text stream; the driver holds them back and joins them into the
/// terminal error message instead of rendering them as assistant text.
fn is_error_prefixed_text(text: &str) -> bool {
    text.trim_start().starts_with("[Error]")
}

fn non_empty_owned(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

fn handle_session_update(
    core: &TurnCore,
    state: &mut TurnState,
    view: &mut TurnView,
    params: &Value,
) {
    let update = params.get("update").unwrap_or(params);
    for event in map_session_update(update) {
        let event = adopt_tool_name(event, view);
        if let EngineEvent::Message {
            role,
            text,
            tool_call_id,
            patch: false,
            ..
        } = &event
        {
            if role == "tool" {
                if let Some(id) = tool_call_id.as_deref() {
                    view.tool_names.insert(id.to_string(), text.clone());
                }
            }
        }
        if let EngineEvent::Delta(text) = &event {
            if is_error_prefixed_text(text) {
                view.pending_error_chunks.push(text.clone());
                continue;
            }
        }
        core.dispatch_event(state, event);
    }
}

/// A `tool_call_update` may omit the tool name; reuse the one recorded when
/// the matching `tool_call` started so the patch does not blank the row.
fn adopt_tool_name(event: EngineEvent, view: &TurnView) -> EngineEvent {
    match event {
        EngineEvent::Message {
            role,
            text,
            path,
            args,
            result,
            tool_call_id,
            patch,
        } if role == "tool" && text.trim().is_empty() => {
            let name = tool_call_id
                .as_deref()
                .and_then(|id| view.tool_names.get(id))
                .cloned()
                .unwrap_or_else(|| "tool".to_string());
            EngineEvent::Message {
                role,
                text: name,
                path,
                args,
                result,
                tool_call_id,
                patch,
            }
        }
        other => other,
    }
}

// ==================== JSON-RPC framing ====================

struct AcpProcess {
    rpc: LineRpc,
    kill_signal: Arc<Notify>,
    stopped: Arc<AtomicBool>,
}

impl AcpProcess {
    fn new(rpc: LineRpc, killed: Arc<AtomicBool>) -> Self {
        let kill_signal = Arc::new(Notify::new());
        let stopped = Arc::new(AtomicBool::new(false));
        {
            let kill_signal = Arc::clone(&kill_signal);
            let stopped = Arc::clone(&stopped);
            // Watching the flag in its own task keeps the read future
            // cancel-free; a cancelled `read_line` would drop a partial frame.
            tokio::spawn(async move {
                loop {
                    if stopped.load(Ordering::SeqCst) {
                        return;
                    }
                    if killed.load(Ordering::SeqCst) {
                        kill_signal.notify_waiters();
                        return;
                    }
                    tokio::time::sleep(KILL_POLL).await;
                }
            });
        }
        Self {
            rpc,
            kill_signal,
            stopped,
        }
    }

    /// One JSON-RPC call: writes the request and reads until its response
    /// lands, settling `session/update` notifications through
    /// `on_notification` and answering agent-initiated requests inline.
    ///
    /// `timeout_dur` is `None` for `session/prompt`: the turn ends on its own
    /// response, the peer's EOF, or a user stop.
    async fn request(
        &mut self,
        method: &str,
        params: Value,
        timeout_dur: Option<Duration>,
        killed: &AtomicBool,
        on_notification: &mut dyn FnMut(&Value),
    ) -> Result<Value, AgentChatError> {
        let id = LineRpc::next_id();
        let expected = id.to_string();
        self.rpc.write(&request_frame(id, method, params)).await?;
        let deadline = timeout_dur.map(|limit| Instant::now() + limit);
        let drain_trailing = method == "session/prompt";
        let mut settled: Option<Value> = None;
        let mut drain_deadline: Option<Instant> = None;

        loop {
            if killed.load(Ordering::SeqCst) {
                return match settled.take() {
                    Some(result) => Ok(result),
                    None => Err(AgentChatError::internal(CANCELLED)),
                };
            }

            let frame = if settled.is_some() {
                let remaining = drain_deadline
                    .map(|until| until.saturating_duration_since(Instant::now()))
                    .unwrap_or(PROMPT_TRAILING_IDLE);
                if remaining.is_zero() {
                    return Ok(settled.take().unwrap_or(Value::Null));
                }
                match tokio::select! {
                    biased;
                    _ = self.kill_signal.notified() => {
                        return Ok(settled.take().unwrap_or(Value::Null));
                    }
                    outcome = timeout(PROMPT_TRAILING_IDLE.min(remaining), self.rpc.read_line()) => outcome,
                } {
                    Ok(read) => read?,
                    Err(_) => return Ok(settled.take().unwrap_or(Value::Null)),
                }
            } else if let Some(limit) =
                deadline.map(|until| until.saturating_duration_since(Instant::now()))
            {
                if limit.is_zero() {
                    return Err(timed_out(method));
                }
                match tokio::select! {
                    biased;
                    _ = self.kill_signal.notified() => return Err(AgentChatError::internal(CANCELLED)),
                    outcome = timeout(limit, self.rpc.read_line()) => outcome,
                } {
                    Ok(read) => read?,
                    Err(_) => return Err(timed_out(method)),
                }
            } else {
                tokio::select! {
                    biased;
                    _ = self.kill_signal.notified() => return Err(AgentChatError::internal(CANCELLED)),
                    read = self.rpc.read_line() => read?,
                }
            };

            let Some(frame) = frame else {
                return match settled.take() {
                    Some(result) => Ok(result),
                    None => Err(AgentChatError::internal(format!(
                        "{method} ended before the ACP peer answered (stdout closed)."
                    ))),
                };
            };

            match parse_incoming(&frame) {
                Incoming::Response { id, result, error } => {
                    if rpc_id_key(&id).as_deref() != Some(expected.as_str()) {
                        continue;
                    }
                    if let Some(error) = error {
                        return Err(AgentChatError::internal(format!(
                            "{method} failed (code {}): {}",
                            error.code, error.message
                        )));
                    }
                    let result = result.unwrap_or(Value::Null);
                    if !drain_trailing {
                        return Ok(result);
                    }
                    settled = Some(result);
                    drain_deadline = Some(Instant::now() + PROMPT_TRAILING_CAP);
                }
                Incoming::Notification { method, params } => {
                    if method == "session/update" {
                        on_notification(&params);
                    }
                }
                Incoming::AgentRequest { id, method, params } => {
                    self.rpc
                        .write(&answer_agent_request(&id, &method, &params))
                        .await?;
                }
                Incoming::Ignore => {}
            }
        }
    }
}

impl Drop for AcpProcess {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
    }
}

enum Incoming {
    Response {
        id: Value,
        result: Option<Value>,
        error: Option<RpcError>,
    },
    Notification {
        method: String,
        params: Value,
    },
    AgentRequest {
        id: Value,
        method: String,
        params: Value,
    },
    Ignore,
}

struct RpcError {
    code: i64,
    message: String,
}

fn parse_incoming(value: &Value) -> Incoming {
    let method = value.get("method").and_then(Value::as_str);
    let id = value.get("id").cloned().filter(|id| !id.is_null());
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    if let Some(method) = method {
        return match id {
            Some(id) => Incoming::AgentRequest {
                id,
                method: method.to_string(),
                params,
            },
            None => Incoming::Notification {
                method: method.to_string(),
                params,
            },
        };
    }
    let Some(id) = id else {
        return Incoming::Ignore;
    };
    let error = value.get("error").map(|error| RpcError {
        code: error
            .get("code")
            .and_then(Value::as_i64)
            .unwrap_or(JSONRPC_INTERNAL_ERROR),
        message: error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("JSON-RPC error")
            .to_string(),
    });
    Incoming::Response {
        id,
        result: value.get("result").cloned(),
        error,
    }
}

fn rpc_id_key(id: &Value) -> Option<String> {
    match id {
        Value::Number(number) => Some(number.to_string()),
        Value::String(text) => Some(text.clone()),
        _ => None,
    }
}

fn request_frame(id: u64, method: &str, params: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    })
}

fn result_frame(id: &Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    })
}

fn error_frame(id: &Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}

// ==================== agent-initiated requests ====================

/// ACP first version runs the session in bypass mode; a permission request
/// that still arrives is answered with allow so the turn cannot block
/// forever, and no permission card is created.
fn permission_auto_answer(params: &Value) -> Result<Value, String> {
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .ok_or_else(|| "session/request_permission is missing options".to_string())?;
    let option_id = options
        .iter()
        .find(|option| {
            option
                .get("kind")
                .and_then(Value::as_str)
                .map(|kind| kind.to_ascii_lowercase().starts_with("allow"))
                .unwrap_or(false)
        })
        .and_then(|option| {
            option
                .get("optionId")
                .or_else(|| option.get("option_id"))
                .or_else(|| option.get("id"))
                .and_then(Value::as_str)
        })
        .ok_or_else(|| "session/request_permission has no allow* option".to_string())?;
    Ok(json!({
        "outcome": {
            "outcome": "selected",
            "optionId": option_id,
        }
    }))
}

fn answer_agent_request(id: &Value, method: &str, params: &Value) -> Value {
    match method {
        "session/request_permission" => match permission_auto_answer(params) {
            Ok(result) => result_frame(id, result),
            Err(message) => error_frame(id, JSONRPC_INVALID_PARAMS, &message),
        },
        _ => error_frame(id, JSONRPC_METHOD_NOT_FOUND, "Method not found"),
    }
}

// ==================== stderr / errors ====================

fn spawn_stderr_drain(mut stderr: ChildStderr) -> Arc<Mutex<String>> {
    use tokio::io::AsyncReadExt;

    let buffer = Arc::new(Mutex::new(String::new()));
    let sink = Arc::clone(&buffer);
    tokio::spawn(async move {
        let mut chunk = [0u8; 4096];
        loop {
            match stderr.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if let Ok(mut text) = sink.lock() {
                        text.push_str(&String::from_utf8_lossy(&chunk[..read]));
                        if text.len() > STDERR_KEEP_BYTES {
                            let mut cut = text.len() - STDERR_KEEP_BYTES;
                            while !text.is_char_boundary(cut) {
                                cut += 1;
                            }
                            text.drain(..cut);
                        }
                    }
                }
            }
        }
    });
    buffer
}

/// Terminal message precedence: held-back `[Error]` chunks → the RPC error →
/// the stderr tail.
fn terminal_message(
    error: AgentChatError,
    view: &TurnView,
    stderr_buf: &Arc<Mutex<String>>,
) -> AgentChatError {
    if !view.pending_error_chunks.is_empty() {
        return AgentChatError::internal(view.pending_error_chunks.join("\n"));
    }
    let tail = stderr_buf
        .lock()
        .map(|tail| tail.trim().to_string())
        .unwrap_or_default();
    if tail.is_empty() {
        error
    } else {
        error.with_detail(tail)
    }
}

fn error_text(error: &AgentChatError) -> String {
    match error.detail.as_deref().map(str::trim) {
        Some(detail) if !detail.is_empty() => format!("{} ({detail})", error.message),
        _ => error.message.clone(),
    }
}

fn timed_out(method: &str) -> AgentChatError {
    AgentChatError::internal(format!("{method} timed out waiting for the ACP peer."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::registry::ProcessRegistry;
    use crate::engine::sink::EventSink;

    fn tool_event(events: Vec<EngineEvent>) -> EngineEvent {
        assert_eq!(events.len(), 1, "expected one tool event: {events:?}");
        events.into_iter().next().expect("event")
    }

    #[test]
    fn initialize_params_announce_protocol_one() {
        let params = initialize_params();
        assert_eq!(params["protocolVersion"], 1);
        assert_eq!(params["clientInfo"]["name"], "wingharness");
        assert!(!params["clientInfo"]["version"].as_str().unwrap_or("").is_empty());
        assert_eq!(params["clientCapabilities"], json!({}));
    }

    #[test]
    fn message_chunks_project_to_text_deltas() {
        let update = json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": "hello" },
        });
        assert_eq!(
            map_session_update(&update),
            vec![EngineEvent::Delta("hello".to_string())]
        );
    }

    #[test]
    fn thought_chunks_project_to_thinking() {
        let update = json!({
            "sessionUpdate": "agent_thought_chunk",
            "content": [{ "type": "text", "text": "thinking" }],
        });
        assert_eq!(
            map_session_update(&update),
            vec![EngineEvent::Thinking("thinking".to_string())]
        );
    }

    #[test]
    fn empty_and_unknown_chunks_project_to_nothing() {
        assert!(map_session_update(&json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": "" },
        }))
        .is_empty());
        assert!(map_session_update(&json!({
            "sessionUpdate": "plan",
            "entries": [{ "content": "step" }],
        }))
        .is_empty());
        assert!(map_session_update(&json!({
            "sessionUpdate": "available_commands_update",
            "availableCommands": [],
        }))
        .is_empty());
    }

    #[test]
    fn tool_call_starts_a_tool_row() {
        let update = json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call-1",
            "title": "Read",
            "status": "pending",
            "rawInput": { "file_path": "src/main.rs" },
        });
        assert_eq!(
            tool_event(map_session_update(&update)),
            EngineEvent::Message {
                role: "tool".to_string(),
                text: "Read".to_string(),
                path: Some("src/main.rs".to_string()),
                args: Some(json!({ "file_path": "src/main.rs" })),
                result: None,
                tool_call_id: Some("call-1".to_string()),
                patch: false,
            }
        );
    }

    #[test]
    fn completed_tool_call_snapshot_is_a_full_row() {
        let update = json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call-1",
            "name": "Bash",
            "status": "completed",
            "rawOutput": "ok",
        });
        assert_eq!(
            tool_event(map_session_update(&update)),
            EngineEvent::Message {
                role: "tool".to_string(),
                text: "Bash".to_string(),
                path: None,
                args: None,
                result: Some(json!("ok")),
                tool_call_id: Some("call-1".to_string()),
                patch: false,
            }
        );
    }

    #[test]
    fn tool_call_update_patches_the_result() {
        let update = json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "call-1",
            "status": "completed",
            "rawOutput": { "stdout": "done" },
        });
        assert_eq!(
            tool_event(map_session_update(&update)),
            EngineEvent::Message {
                role: "tool".to_string(),
                text: String::new(),
                path: None,
                args: None,
                result: Some(json!({ "stdout": "done" })),
                tool_call_id: Some("call-1".to_string()),
                patch: true,
            }
        );
    }

    #[test]
    fn failed_tool_call_update_carries_an_error_result() {
        let update = json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "call-1",
            "status": "failed",
            "content": [{ "type": "text", "text": "boom" }],
        });
        let EngineEvent::Message { result, patch, .. } =
            tool_event(map_session_update(&update))
        else {
            panic!("expected a tool message");
        };
        assert!(patch);
        assert_eq!(result, Some(json!({ "text": "boom", "isError": true })));
    }

    #[test]
    fn unstarted_tool_updates_are_ignored() {
        assert!(map_session_update(&json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "call-1",
            "status": "in_progress",
        }))
        .is_empty());
        assert!(map_session_update(&json!({
            "sessionUpdate": "tool_call_update",
            "status": "completed",
        }))
        .is_empty());
        assert!(map_session_update(&json!({
            "sessionUpdate": "tool_call",
            "title": "Read",
            "status": "pending",
        }))
        .is_empty());
    }

    #[test]
    fn tool_names_follow_the_start_event() {
        let mut view = TurnView::default();
        let start = json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call-1",
            "title": "Read",
            "status": "in_progress",
            "rawInput": { "path": "a.txt" },
        });
        let update = json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "call-1",
            "status": "completed",
            "rawOutput": "ok",
        });
        for event in map_session_update(&start) {
            let event = adopt_tool_name(event, &view);
            if let EngineEvent::Message {
                role,
                text,
                tool_call_id,
                patch: false,
                ..
            } = &event
            {
                if role == "tool" {
                    view.tool_names
                        .insert(tool_call_id.clone().unwrap_or_default(), text.clone());
                }
            }
        }
        let patched = adopt_tool_name(tool_event(map_session_update(&update)), &view);
        let EngineEvent::Message { text, patch, .. } = patched else {
            panic!("expected a tool patch");
        };
        assert_eq!(text, "Read");
        assert!(patch);
    }

    #[test]
    fn permission_requests_pick_the_first_allow_option() {
        let params = json!({
            "sessionId": "s-1",
            "options": [
                { "optionId": "deny", "kind": "reject_once" },
                { "optionId": "allow-once", "kind": "allow_once" },
            ],
        });
        assert_eq!(
            permission_auto_answer(&params).expect("allow"),
            json!({ "outcome": { "outcome": "selected", "optionId": "allow-once" } })
        );
    }

    #[test]
    fn permission_requests_without_an_allow_option_are_rejected() {
        let no_options = json!({});
        assert!(permission_auto_answer(&no_options).is_err());
        let no_allow = json!({ "options": [{ "optionId": "deny", "kind": "reject_once" }] });
        assert!(permission_auto_answer(&no_allow).is_err());
    }

    #[test]
    fn agent_requests_are_answered_inline() {
        let permission = json!({
            "id": 9,
            "method": "session/request_permission",
            "params": { "options": [{ "optionId": "allow", "kind": "allow_always" }] },
        });
        let Incoming::AgentRequest { id, method, params } = parse_incoming(&permission) else {
            panic!("expected an agent request");
        };
        let frame = answer_agent_request(&id, &method, &params);
        assert_eq!(frame["id"], 9);
        assert_eq!(frame["result"]["outcome"]["optionId"], "allow");

        let unknown = answer_agent_request(&json!(10), "fs/read_text_file", &json!({}));
        assert_eq!(unknown["error"]["code"], JSONRPC_METHOD_NOT_FOUND);
    }

    #[test]
    fn frames_are_classified_by_shape() {
        assert!(matches!(
            parse_incoming(&json!({ "id": 1, "result": { "ok": true } })),
            Incoming::Response { .. }
        ));
        assert!(matches!(
            parse_incoming(&json!({ "method": "session/update", "params": {} })),
            Incoming::Notification { .. }
        ));
        assert!(matches!(
            parse_incoming(&json!({ "id": 2, "method": "session/request_permission" })),
            Incoming::AgentRequest { .. }
        ));
        assert!(matches!(parse_incoming(&json!("noise")), Incoming::Ignore));
        assert!(matches!(parse_incoming(&json!({ "id": null })), Incoming::Ignore));
    }

    #[test]
    fn responses_only_match_their_request_id() {
        let Incoming::Response { id, result, error } =
            parse_incoming(&json!({ "id": 7, "result": { "sessionId": "s-1" } }))
        else {
            panic!("expected a response");
        };
        assert_eq!(rpc_id_key(&id).as_deref(), Some("7"));
        assert!(error.is_none());
        assert_eq!(result, Some(json!({ "sessionId": "s-1" })));

        let Incoming::Response { id, error, .. } =
            parse_incoming(&json!({ "id": "other", "error": { "code": -32601 } }))
        else {
            panic!("expected a response");
        };
        assert_ne!(rpc_id_key(&id).as_deref(), Some("7"));
        assert_eq!(error.expect("error").code, JSONRPC_METHOD_NOT_FOUND);
    }

    #[test]
    fn session_ids_are_read_from_every_spelling() {
        assert_eq!(
            extract_session_id(&json!({ "sessionId": "a" })).as_deref(),
            Some("a")
        );
        assert_eq!(
            extract_session_id(&json!({ "session_id": "b" })).as_deref(),
            Some("b")
        );
        assert_eq!(extract_session_id(&json!({ "id": "c" })).as_deref(), Some("c"));
        assert_eq!(extract_session_id(&json!({ "sessionId": "  " })), None);
    }

    #[test]
    fn bypass_mode_accepts_both_cli_spellings() {
        assert!(bypass_mode_active(
            &json!({ "modes": { "currentModeId": "bypassPermissions" } })
        ));
        assert!(bypass_mode_active(&json!({ "modes": { "currentModeId": "yolo" } })));
        assert!(!bypass_mode_active(
            &json!({ "modes": { "currentModeId": "default" } })
        ));
        assert!(!bypass_mode_active(&json!({})));
    }

    #[test]
    fn error_prefixed_chunks_are_held_back() {
        assert!(is_error_prefixed_text("[Error] Network attempt failed"));
        assert!(is_error_prefixed_text("  [Error] retry"));
        assert!(!is_error_prefixed_text("normal [Error] mention"));
    }

    #[tokio::test]
    #[ignore = "requires qodercli on PATH and a logged-in Qoder account"]
    async fn qoder_runs_one_turn() {
        let sink = EventSink::new_for_test();
        let registry = Arc::new(ProcessRegistry::new());
        let core = TurnCore {
            run_id: "run-qoder".to_string(),
            engine_id: "qoder",
            sink: Arc::clone(&sink),
            registry: Arc::clone(&registry),
        };
        let req = SendRequest {
            run_id: "run-qoder".to_string(),
            engine: "qoder".to_string(),
            workspace: std::env::current_dir().expect("current directory"),
            session_id: None,
            prompt: "Reply with the single word: pong".to_string(),
            model: None,
            effort: None,
            permission: Some("bypass".to_string()),
            additional_dirs: Vec::new(),
        };
        let killed = Arc::new(AtomicBool::new(false));

        run_acp_turn(core, req, "qodercli".to_string(), killed, 0).await;

        sink.flush();
        let events: Vec<_> = sink.take_batches().into_iter().flatten().collect();
        let kinds: Vec<&str> = events.iter().map(|event| event.kind.as_str()).collect();
        assert!(
            kinds.contains(&"session"),
            "the handshake reported no session id: {kinds:?}"
        );
        assert!(kinds.contains(&"done"), "the turn did not settle: {kinds:?}");
        assert!(registry.live_run_ids(&["run-qoder".to_string()]).is_empty());
    }
}
