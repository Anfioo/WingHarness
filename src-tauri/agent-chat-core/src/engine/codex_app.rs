//! Codex app-server driver.
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/desktop-cc-gui.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! Wire: `initialize {clientInfo}` -> `initialized` -> `thread/start` (new) or
//! `thread/resume {threadId, excludeTurns}` -> `turn/start {threadId, input}`.
//! `turn/start` acknowledges with `{turn:{id}}` and the work then streams as
//! `item/*` notifications; only `turn/completed` ends the turn. Approval
//! requests from the CLI are declined, never granted: `approvalPolicy` and the
//! sandbox are the boundary this client chose.
//!
//! Scope by plan Q7/D11: no plan approval, no collaboration modes, no
//! decision turns and no provider env.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, ChildStderr};
use tokio::sync::Mutex as TokioMutex;
use tokio::time::timeout;

use crate::engine::events::EngineEvent;
use crate::engine::reader::{TurnCore, TurnState};
use crate::engine::registry::ChildEntry;
use crate::engine::rpc::{LineRpc, JSON_RPC_VERSION};
use crate::engine::{BuiltCommand, SendRequest};
use crate::AgentChatError;

/// `initialize` is a small round-trip; a CLI that does not answer it is not a
/// usable app-server.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(15);
/// `thread/start` builds the thread's context before it can answer.
const THREAD_TIMEOUT: Duration = Duration::from_secs(90);
/// `thread/resume` only re-attaches an existing thread.
const RESUME_TIMEOUT: Duration = Duration::from_secs(30);
/// How much of the child's stderr is kept for an error message.
const STDERR_KEEP_BYTES: usize = 8 * 1024;

/// Per-run projection state: what already streamed, and what to report when
/// the turn settles.
#[derive(Default)]
struct TurnView {
    /// Items whose text already streamed as deltas: the completed item repeats
    /// the full text, and replaying it would print the answer twice.
    streamed_message: Option<String>,
    streamed_reasoning: Option<String>,
    thread_id: Option<String>,
    turn_id: Option<String>,
    last_usage: Option<Value>,
    saw_done: bool,
    saw_error: bool,
}

/// What a pump call is waiting for.
#[derive(Clone, Copy)]
enum Expect {
    /// The reply to the request with this id.
    Reply(u64),
    /// No reply: the turn's terminal notification ends this pump.
    Turn,
}

/// How the pump treats one decoded frame.
enum Handled {
    Ignore,
    /// Answer this server->client request now.
    Answer(Value),
    /// The request was parked for the user; the answer command writes the
    /// response on the same stdin later.
    Parked,
    /// The turn is over.
    Ended,
}

/// A turn's JSON-RPC channel to one `codex app-server` child.
struct AppServer {
    rpc: LineRpc,
}

impl AppServer {
    fn new(rpc: LineRpc) -> Self {
        Self { rpc }
    }

    /// Sends a request and returns the id its reply will carry.
    async fn request(&mut self, method: &str, params: Value) -> Result<u64, AgentChatError> {
        let id = LineRpc::next_id();
        self.rpc
            .write(&json!({
                "jsonrpc": JSON_RPC_VERSION,
                "id": id,
                "method": method,
                "params": params,
            }))
            .await?;
        Ok(id)
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), AgentChatError> {
        self.rpc
            .write(&json!({
                "jsonrpc": JSON_RPC_VERSION,
                "method": method,
                "params": params,
            }))
            .await
    }

    /// Reads until the expectation is met.
    ///
    /// `Ok(Some(result))` is the awaited reply; `Ok(None)` means the turn ended
    /// first (a fast turn can finish before its `turn/start` ack is read).
    /// Frames are classified locally: method + id is a server->client request,
    /// method alone a notification, id alone a reply.
    async fn pump(
        &mut self,
        label: &str,
        expect: Expect,
        deadline: Option<Instant>,
        on_message: &mut (dyn FnMut(&Value) -> Handled + Send),
    ) -> Result<Option<Value>, AgentChatError> {
        loop {
            let frame = match deadline {
                Some(at) => {
                    let remaining = at.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        return Err(timed_out(label));
                    }
                    match timeout(remaining, self.rpc.read_line()).await {
                        Err(_) => return Err(timed_out(label)),
                        Ok(result) => result?,
                    }
                }
                None => self.rpc.read_line().await?,
            };
            let Some(value) = frame else {
                return Err(AgentChatError::internal(format!(
                    "{label}: the codex app-server closed stdout."
                )));
            };

            if value.get("method").is_none() {
                let expected = matches!(
                    expect,
                    Expect::Reply(wanted) if id_matches(value.get("id"), wanted)
                );
                if !expected {
                    // Late reply or a reply this pump does not own.
                    on_message(&value);
                    continue;
                }
                if let Some(error) = value.get("error") {
                    return Err(rpc_failed(label, error));
                }
                return Ok(Some(value.get("result").cloned().unwrap_or(Value::Null)));
            }

            let expects_reply = value.get("id").filter(|id| !id.is_null()).is_some();
            match on_message(&value) {
                Handled::Ended => return Ok(None),
                Handled::Answer(frame) if expects_reply => self.rpc.write(&frame).await?,
                _ => {}
            }
        }
    }
}

/// JSON-RPC ids are numbers in this protocol, but some peers echo them as
/// strings; both shapes name the same request.
fn id_matches(id: Option<&Value>, wanted: u64) -> bool {
    match id {
        Some(Value::Number(number)) => number.as_u64() == Some(wanted),
        Some(Value::String(text)) => text.parse::<u64>().ok() == Some(wanted),
        _ => false,
    }
}

fn timed_out(label: &str) -> AgentChatError {
    AgentChatError::internal(format!("{label} timed out waiting for the codex app-server."))
}

fn rpc_failed(label: &str, error: &Value) -> AgentChatError {
    let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("the codex app-server reported an error");
    AgentChatError::internal(format!("{label} was rejected by codex (code {code}): {message}"))
}

// ==================== turn driver ====================

/// Runs one app-server turn and settles it: parked questions are resolved
/// first, then the turn reports either the engine's error or its own Done.
pub async fn run_app_server_turn(
    core: TurnCore,
    req: SendRequest,
    built: BuiltCommand,
    killed: Arc<AtomicBool>,
    virtual_pid: u32,
) {
    let mut state = TurnState::new(req.session_id.clone());
    let mut view = TurnView::default();
    let questions: Arc<Mutex<HashMap<String, Value>>> = Arc::new(Mutex::new(HashMap::new()));
    let (result, child) = drive(
        &core, &mut state, &mut view, &req, built, &killed, virtual_pid, &questions,
    )
    .await;
    settle(&core, &mut state, &mut view, result, &killed, &questions, child).await;
}

/// Spawns the CLI, registers its pipe so `agent_answer` can write, then drives
/// the handshake and the turn.
async fn drive(
    core: &TurnCore,
    state: &mut TurnState,
    view: &mut TurnView,
    req: &SendRequest,
    built: BuiltCommand,
    killed: &Arc<AtomicBool>,
    virtual_pid: u32,
    questions: &Arc<Mutex<HashMap<String, Value>>>,
) -> (
    Result<(), AgentChatError>,
    Option<Arc<TokioMutex<Child>>>,
) {
    if killed.load(Ordering::SeqCst) {
        // Stopped before the launch finished; nothing to spawn.
        return (Ok(()), None);
    }
    let BuiltCommand { mut command, .. } = built;
    command
        .current_dir(&req.workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return (
                Err(AgentChatError::internal(format!(
                    "Failed to spawn the codex app-server: {error}"
                ))),
                None,
            )
        }
    };
    let (stdin, stdout, stderr) = match (child.stdin.take(), child.stdout.take(), child.stderr.take())
    {
        (Some(stdin), Some(stdout), Some(stderr)) => (stdin, stdout, stderr),
        _ => {
            let _ = child.start_kill();
            return (
                Err(AgentChatError::internal(
                    "The codex app-server did not expose its stdio pipes.",
                )),
                None,
            );
        }
    };
    let stderr_buf = spawn_stderr_drain(stderr);
    let stdin = Arc::new(TokioMutex::new(Some(stdin)));
    // A `cmd /C` shim would leave the node child alive if only the direct
    // child were signalled, so the registry keeps the real pid for tree kills.
    let pid = child.id().unwrap_or(virtual_pid);
    let child = Arc::new(TokioMutex::new(child));
    let entry = ChildEntry {
        child: Some(child.clone()),
        pid,
        run_id: core.run_id.clone(),
        killed: killed.clone(),
        stdin: Some(stdin.clone()),
        questions: questions.clone(),
    };
    core.registry.insert(core.run_id.clone(), entry.clone());
    // A resumed session is keyed up front, so an interrupt by conversation id
    // routes before the protocol re-announces it.
    if let Some(session_id) = req.session_id.as_deref() {
        core.registry.insert(session_id.to_string(), entry);
    }
    let mut server = AppServer::new(LineRpc::new(stdin, stdout));
    let result = handshake_and_turn(&mut server, core, state, view, req).await;
    let result = match result {
        Ok(()) => Ok(()),
        Err(error) => Err(with_stderr(error, &stderr_buf)),
    };
    (result, Some(child))
}

/// `initialize` -> `initialized` -> thread -> `turn/start` -> turn pump.
async fn handshake_and_turn(
    server: &mut AppServer,
    core: &TurnCore,
    state: &mut TurnState,
    view: &mut TurnView,
    req: &SendRequest,
) -> Result<(), AgentChatError> {
    let deadline = Instant::now() + INITIALIZE_TIMEOUT;
    let id = server.request("initialize", initialize_params()).await?;
    // The reply body carries nothing this driver needs; a protocol mismatch has
    // already failed the pump with the CLI's own words.
    server
        .pump("initialize", Expect::Reply(id), Some(deadline), &mut |value| {
            route(core, state, view, value)
        })
        .await?
        .ok_or_else(|| {
            AgentChatError::internal(
                "The codex app-server ended before it answered initialize.",
            )
        })?;
    server.notify("initialized", json!({})).await?;

    let (method, params) = thread_request(req);
    let deadline = Instant::now()
        + if req.session_id.is_some() {
            RESUME_TIMEOUT
        } else {
            THREAD_TIMEOUT
        };
    let id = server.request(method, params).await?;
    let opened = server
        .pump(method, Expect::Reply(id), Some(deadline), &mut |value| {
            route(core, state, view, value)
        })
        .await?
        .ok_or_else(|| {
            AgentChatError::internal(format!(
                "The codex app-server ended before it answered {method}."
            ))
        })?;
    let thread_id = opened
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| req.session_id.clone())
        .ok_or_else(|| {
            AgentChatError::internal(format!("{method} returned no thread id."))
        })?;
    view.thread_id = Some(thread_id.clone());
    core.dispatch_event(state, EngineEvent::SessionId(thread_id.clone()));
    if let Some(model) = opened
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| !model.trim().is_empty())
    {
        core.dispatch_event(state, EngineEvent::Model(model.to_string()));
    }
    if let Some(effort) = req
        .effort
        .as_deref()
        .or_else(|| opened.get("reasoningEffort").and_then(Value::as_str))
    {
        core.dispatch_event(state, EngineEvent::Effort(effort.to_string()));
    }

    let id = server
        .request("turn/start", turn_params(req, &thread_id))
        .await?;
    // A fast turn can be over before its own acknowledgement is read; an ended
    // pump here is a settled turn, not a missing reply.
    let Some(started) = server
        .pump("turn/start", Expect::Reply(id), None, &mut |value| {
            route(core, state, view, value)
        })
        .await?
    else {
        return Ok(());
    };
    view.turn_id = started
        .pointer("/turn/id")
        .and_then(Value::as_str)
        .map(str::to_string);
    server
        .pump("turn", Expect::Turn, None, &mut |value| {
            route(core, state, view, value)
        })
        .await?;
    Ok(())
}

// ==================== wiring ====================

fn initialize_params() -> Value {
    json!({
        "clientInfo": {
            "name": "wingharness",
            "version": env!("CARGO_PKG_VERSION"),
        }
    })
}

fn approval_policy(permission: Option<&str>) -> &'static str {
    match permission {
        Some("bypass") => "never",
        Some("manual") => "untrusted",
        _ => "on-failure",
    }
}

fn sandbox_for(permission: Option<&str>) -> &'static str {
    match permission {
        Some("bypass") => "danger-full-access",
        Some("manual") => "read-only",
        _ => "workspace-write",
    }
}

fn thread_request(req: &SendRequest) -> (&'static str, Value) {
    let (method, mut params) = match req.session_id.as_deref() {
        Some(thread_id) => (
            "thread/resume",
            json!({ "threadId": thread_id, "excludeTurns": true }),
        ),
        None => ("thread/start", json!({})),
    };
    params["cwd"] = json!(req.workspace.to_string_lossy());
    params["approvalPolicy"] = json!(approval_policy(req.permission.as_deref()));
    params["sandbox"] = json!(sandbox_for(req.permission.as_deref()));
    if let Some(model) = req
        .model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
    {
        params["model"] = json!(model);
    }
    if let Some(effort) = req
        .effort
        .as_deref()
        .map(str::trim)
        .filter(|effort| !effort.is_empty())
    {
        params["config"] = json!({ "model_reasoning_effort": effort });
    }
    (method, params)
}

fn turn_params(req: &SendRequest, thread_id: &str) -> Value {
    let mut params = Map::new();
    params.insert("threadId".to_string(), json!(thread_id));
    params.insert(
        "input".to_string(),
        json!([{ "type": "text", "text": req.prompt }]),
    );
    params.insert(
        "approvalPolicy".to_string(),
        json!(approval_policy(req.permission.as_deref())),
    );
    params.insert(
        "sandbox".to_string(),
        json!(sandbox_for(req.permission.as_deref())),
    );
    if let Some(model) = req
        .model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
    {
        params.insert("model".to_string(), json!(model));
    }
    if let Some(effort) = req
        .effort
        .as_deref()
        .map(str::trim)
        .filter(|effort| !effort.is_empty())
    {
        params.insert("effort".to_string(), json!(effort));
    }
    Value::Object(params)
}

fn spawn_stderr_drain(mut stderr: ChildStderr) -> Arc<Mutex<String>> {
    let buffer = Arc::new(Mutex::new(String::new()));
    let sink = buffer.clone();
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

fn with_stderr(error: AgentChatError, stderr: &Arc<Mutex<String>>) -> AgentChatError {
    let tail = stderr
        .lock()
        .map(|text| text.trim().to_string())
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

// ==================== settle ====================

#[allow(clippy::too_many_arguments)]
async fn settle(
    core: &TurnCore,
    state: &mut TurnState,
    view: &mut TurnView,
    result: Result<(), AgentChatError>,
    killed: &Arc<AtomicBool>,
    questions: &Arc<Mutex<HashMap<String, Value>>>,
    child: Option<Arc<TokioMutex<Child>>>,
) {
    // Parked questions die with the turn: settle their cards before any
    // terminal event, or the monotonic terminal guard would drop them.
    let parked: Vec<String> = questions
        .lock()
        .map(|mut map| map.drain().map(|(key, _)| key).collect())
        .unwrap_or_default();
    for request_id in parked {
        core.dispatch_event(state, EngineEvent::QuestionSettled { request_id });
    }

    let was_killed = killed.load(Ordering::SeqCst);
    if let Err(error) = result {
        // A killed turn is an interruption, not an error.
        if !was_killed {
            core.dispatch_event(state, EngineEvent::Error(error_text(&error)));
            view.saw_error = true;
        }
    }
    if !view.saw_done && !view.saw_error {
        let usage = if was_killed {
            None
        } else {
            view.last_usage.clone()
        };
        core.dispatch_event(
            state,
            EngineEvent::Done {
                session_id: view.thread_id.clone(),
                usage,
            },
        );
    }

    // Kill the tree (the CLI may be a .cmd shim with a node child), then drop
    // the bookkeeping. `kill` also sets the shared flag.
    let _ = core.registry.kill(&core.run_id);
    if let Some(child) = child {
        let mut guard = child.lock().await;
        let _ = guard.start_kill();
        let _ = timeout(Duration::from_secs(2), guard.wait()).await;
    }
    core.registry.remove(&core.run_id);
    core.sink.flush();
}

// ==================== projection ====================

/// Classifies and projects one decoded frame.
fn route(core: &TurnCore, state: &mut TurnState, view: &mut TurnView, value: &Value) -> Handled {
    let Some(method) = value.get("method").and_then(Value::as_str) else {
        // A reply to an out-of-band request (the question answer has no
        // reply); nothing to project.
        return Handled::Ignore;
    };
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    match value.get("id").filter(|id| !id.is_null()) {
        Some(id) => handle_server_request(core, state, method, id, &params),
        None => handle_notification(core, state, view, method, &params),
    }
}

/// A server->client request: the CLI is blocked until it is answered.
fn handle_server_request(
    core: &TurnCore,
    state: &mut TurnState,
    method: &str,
    id: &Value,
    params: &Value,
) -> Handled {
    match method {
        // The reason this transport exists: the model's own multiple-choice
        // question becomes a card and the turn stays parked until the user
        // picks; `answer_frame` writes the response later on the same pipe.
        "item/tool/requestUserInput" => {
            let (cards, ids) = question_cards(params);
            if cards.is_empty() {
                // A question the card cannot render must not wedge the turn.
                return Handled::Answer(result_frame(id, json!({ "answers": {} })));
            }
            park_question(core, state, id, params, cards, ids);
            Handled::Parked
        }
        // Always declined: the approval policy and the sandbox are the
        // boundary this client chose, so granting here would escalate.
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            Handled::Answer(result_frame(id, json!({ "decision": "decline" })))
        }
        "item/permissions/requestApproval" => {
            Handled::Answer(result_frame(id, json!({ "permissions": {} })))
        }
        "mcpServer/elicitation/request" => {
            Handled::Answer(result_frame(id, json!({ "action": "decline" })))
        }
        // Unknown ask: an empty result still settles the request; silence is
        // what would deadlock the turn.
        _ => Handled::Answer(result_frame(id, json!({}))),
    }
}

fn result_frame(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": JSON_RPC_VERSION, "id": id, "result": result })
}

/// A notification: no reply is expected, so unknown methods are ignorable.
fn handle_notification(
    core: &TurnCore,
    state: &mut TurnState,
    view: &mut TurnView,
    method: &str,
    params: &Value,
) -> Handled {
    match method {
        "item/agentMessage/delta" => {
            if let Some(delta) = params
                .get("delta")
                .and_then(Value::as_str)
                .filter(|delta| !delta.is_empty())
            {
                if let Some(item_id) = params.get("itemId").and_then(Value::as_str) {
                    view.streamed_message = Some(item_id.to_string());
                }
                core.dispatch_event(state, EngineEvent::Delta(delta.to_string()));
            }
        }
        "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta" => {
            if let Some(delta) = params
                .get("delta")
                .and_then(Value::as_str)
                .filter(|delta| !delta.is_empty())
            {
                if let Some(item_id) = params.get("itemId").and_then(Value::as_str) {
                    view.streamed_reasoning = Some(item_id.to_string());
                }
                core.dispatch_event(state, EngineEvent::Thinking(delta.to_string()));
            }
        }
        "item/started" | "item/completed" => {
            if let Some(item) = params.get("item") {
                for event in project_item(item, method == "item/completed", view) {
                    core.dispatch_event(state, event);
                }
            }
        }
        "thread/started" => {
            if view.thread_id.is_none() {
                if let Some(thread_id) = params
                    .pointer("/thread/id")
                    .and_then(Value::as_str)
                    .filter(|thread_id| !thread_id.is_empty())
                {
                    view.thread_id = Some(thread_id.to_string());
                    core.dispatch_event(state, EngineEvent::SessionId(thread_id.to_string()));
                }
            }
        }
        "thread/tokenUsage/updated" => {
            if let Some(usage) = params.get("tokenUsage").filter(|usage| !usage.is_null()) {
                view.last_usage = Some(usage.clone());
            }
        }
        // Terminal. A failed turn arrives as a completion whose status is
        // `failed` with an explanatory message; `turn/failed` is handled
        // defensively in case a newer CLI emits it as its own notification.
        "turn/completed" | "turn/failed" => {
            let turn = params.get("turn");
            let failed = turn
                .and_then(|turn| turn.get("status"))
                .and_then(Value::as_str)
                == Some("failed");
            let message = turn
                .and_then(|turn| turn.pointer("/error/message"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if failed || !message.is_empty() {
                core.dispatch_event(
                    state,
                    EngineEvent::Error(if message.is_empty() {
                        "codex reported a failed turn".to_string()
                    } else {
                        message.to_string()
                    }),
                );
                view.saw_error = true;
            } else {
                view.saw_done = true;
            }
            return Handled::Ended;
        }
        // Non-terminal by contract (`willRetry`): the CLI is retrying an
        // upstream call, so the turn keeps running.
        "error" => {
            let message = params
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("codex reported an error");
            core.dispatch_event(state, EngineEvent::Warn(message.to_string()));
        }
        _ => {}
    }
    Handled::Ignore
}

/// Projects one item lifecycle event. Tool work opens a row on start and the
/// same row is patched with its result on completion; assistant and reasoning
/// text comes from deltas, with the completed item as a fallback for a CLI
/// that streams none.
fn project_item(item: &Value, completed: bool, view: &mut TurnView) -> Vec<EngineEvent> {
    let Some(kind) = item.get("type").and_then(Value::as_str) else {
        return Vec::new();
    };
    let item_id = item.get("id").and_then(Value::as_str);
    let mut out = Vec::new();
    match kind {
        "agentMessage" => {
            if !completed {
                return out;
            }
            if view.streamed_message.as_deref() != item_id {
                let text = item.get("text").and_then(Value::as_str).unwrap_or("");
                if !text.trim().is_empty() {
                    out.push(assistant_message(text.to_string()));
                }
            }
        }
        "reasoning" => {
            if !completed || view.streamed_reasoning.as_deref() == item_id {
                return out;
            }
            // Both arrays are optional and often only one is populated.
            let mut parts: Vec<String> = Vec::new();
            for key in ["summary", "content"] {
                if let Some(entries) = item.get(key).and_then(Value::as_array) {
                    parts.extend(
                        entries
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .filter(|part| !part.trim().is_empty()),
                    );
                }
            }
            let text = parts.join("\n");
            if !text.is_empty() {
                out.push(EngineEvent::Thinking(text));
            }
        }
        "commandExecution" => {
            if completed {
                out.push(tool_result(
                    "bash",
                    pick(item, &["aggregatedOutput", "exitCode"]),
                ));
            } else {
                out.push(tool_call(
                    "bash",
                    pick(item, &["command", "cwd"]),
                    item_id.map(str::to_string),
                ));
            }
        }
        "fileChange" => {
            if completed {
                out.push(tool_result("apply_patch", pick(item, &["status"])));
            } else if let Some(changes) = item.get("changes").and_then(Value::as_array) {
                // One row per file: the UI resolves `path` out of the args for
                // its file chip, and the diff gets an expandable panel.
                for change in changes {
                    out.push(tool_call(
                        "apply_patch",
                        pick(change, &["path", "kind", "diff"]),
                        item_id.map(str::to_string),
                    ));
                }
            }
        }
        "mcpToolCall" => {
            let name = item
                .get("tool")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| "mcp".to_string());
            if completed {
                out.push(tool_result(name, pick(item, &["result", "error", "status"])));
            } else {
                // The arguments are the tool row's payload; `server` and
                // `tool` only repeat what the name already says.
                out.push(tool_call(
                    name,
                    item.get("arguments").cloned(),
                    item_id.map(str::to_string),
                ));
            }
        }
        _ => {}
    }
    out
}

fn assistant_message(text: String) -> EngineEvent {
    EngineEvent::Message {
        role: "assistant".to_string(),
        text,
        path: None,
        args: None,
        result: None,
        tool_call_id: None,
        patch: false,
    }
}

fn tool_call(name: impl Into<String>, args: Option<Value>, tool_call_id: Option<String>) -> EngineEvent {
    let args = args.and_then(parse_tool_args);
    EngineEvent::Message {
        role: "tool".to_string(),
        text: name.into(),
        path: args.as_ref().and_then(tool_path),
        args,
        result: None,
        tool_call_id: tool_call_id.filter(|id| !id.trim().is_empty()),
        patch: false,
    }
}

fn tool_result(name: impl Into<String>, result: Option<Value>) -> EngineEvent {
    EngineEvent::Message {
        role: "tool".to_string(),
        text: name.into(),
        path: None,
        args: None,
        result,
        tool_call_id: None,
        patch: true,
    }
}

/// Drop empty / null payloads so the UI does not render a blank args panel.
/// JSON-encoded strings are parsed first, exactly as the CLI may send them.
fn parse_tool_args(value: Value) -> Option<Value> {
    match value {
        Value::Null => None,
        Value::Object(map) if map.is_empty() => None,
        Value::Array(items) if items.is_empty() => None,
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return None;
            }
            match serde_json::from_str::<Value>(trimmed) {
                Ok(parsed) => parse_tool_args(parsed).or(Some(Value::String(trimmed.to_string()))),
                Err(_) => Some(Value::String(trimmed.to_string())),
            }
        }
        other => Some(other),
    }
}

fn tool_path(args: &Value) -> Option<String> {
    ["path", "file_path", "filePath"]
        .iter()
        .filter_map(|key| args.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .find(|path| !path.is_empty())
        .map(str::to_string)
}

/// Collects the listed keys that carry a non-null value.
fn pick(item: &Value, keys: &[&str]) -> Option<Value> {
    let mut map = Map::new();
    for key in keys {
        if let Some(value) = item.get(*key).filter(|value| !value.is_null()) {
            map.insert((*key).to_string(), value.clone());
        }
    }
    if map.is_empty() {
        None
    } else {
        Some(Value::Object(map))
    }
}

// ==================== questions ====================

/// Parks a user-input request. `dispatch_event` stores the whole `input`
/// under the request id, so the payload carries both what the UI renders
/// (`questions`) and what the answer frame needs (`codexApp`).
fn park_question(
    core: &TurnCore,
    state: &mut TurnState,
    id: &Value,
    params: &Value,
    cards: Vec<Value>,
    ids: Value,
) {
    let request_id = id.to_string();
    let tool_use_id = params
        .get("itemId")
        .and_then(Value::as_str)
        .map(str::to_string);
    core.dispatch_event(
        state,
        EngineEvent::Question {
            request_id,
            tool_use_id,
            input: json!({
                "questions": cards,
                "codexApp": { "rpcId": id, "ids": ids },
            }),
        },
    );
}

/// Projects the protocol's `questions` onto the card spec and builds the
/// question-text -> question-id map in the same pass, so the two cannot drift.
fn question_cards(params: &Value) -> (Vec<Value>, Value) {
    let mut cards = Vec::new();
    let mut ids = Map::new();
    let Some(questions) = params.get("questions").and_then(Value::as_array) else {
        return (cards, Value::Object(ids));
    };
    for (index, question) in questions.iter().enumerate() {
        let (Some(id), Some(text)) = (
            question.get("id").and_then(Value::as_str),
            question.get("question").and_then(Value::as_str),
        ) else {
            continue;
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let header = question
            .get("header")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|header| !header.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("Q{}", index + 1));
        let options: Vec<Value> = question
            .get("options")
            .and_then(Value::as_array)
            .map(|options| {
                options
                    .iter()
                    .filter_map(|option| {
                        let label = option.get("label").and_then(Value::as_str)?;
                        let mut card = Map::new();
                        card.insert("label".to_string(), json!(label));
                        if let Some(description) = option
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|description| !description.is_empty())
                        {
                            card.insert("description".to_string(), json!(description));
                        }
                        Some(Value::Object(card))
                    })
                    .collect()
            })
            .unwrap_or_default();
        cards.push(json!({ "question": text, "header": header, "options": options }));
        ids.insert(text.to_string(), json!(id));
    }
    (cards, Value::Object(ids))
}

/// Builds the CLI's response to a parked question.
///
/// `parked` is the context stored by `park_question`; `answers` is the raw
/// frontend map (question text -> chosen label, or a list of labels for a
/// multi-select). `None` means the user dismissed the card: the CLI's request
/// must be settled with an empty answer, never an error, so the model can
/// carry on. A mismatch between the answer and the asked questions is an
/// error, because silently dropping it would park the turn forever.
pub(super) fn answer_frame(
    parked: &Value,
    answers: Option<&Value>,
) -> Result<Value, AgentChatError> {
    // Accept both the wrapper stored by `park_question` and the bare context.
    let parked = parked.get("codexApp").unwrap_or(parked);
    let id = parked.get("rpcId").ok_or_else(|| {
        AgentChatError::invalid_input("The parked Codex question lost its request id.")
    })?;
    let ids = parked.get("ids").and_then(Value::as_object);
    let mut out = Map::new();
    if let Some(answers) = answers {
        let answers = answers.as_object().ok_or_else(|| {
            AgentChatError::invalid_input("Codex answers must be an object keyed by question text.")
        })?;
        for (text, choice) in answers {
            let question_id = ids
                .and_then(|ids| ids.get(text))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AgentChatError::invalid_input(format!(
                        "Codex did not ask a question titled {text:?}."
                    ))
                })?;
            // A single select arrives as a bare label; the wire only has the
            // list form, so both are normalized into it.
            let labels = match choice {
                Value::String(label) => vec![Value::String(label.clone())],
                Value::Array(labels) => labels.clone(),
                Value::Null => Vec::new(),
                other => {
                    return Err(AgentChatError::invalid_input(format!(
                        "Unsupported Codex answer for {text:?}: {other}"
                    )))
                }
            };
            out.insert(question_id.to_string(), json!({ "answers": labels }));
        }
    }
    Ok(result_frame(id, json!({ "answers": out })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parked(ids: Value) -> Value {
        json!({ "codexApp": { "rpcId": 9, "ids": ids } })
    }

    #[test]
    fn answer_frame_keys_a_single_choice_by_the_servers_question_id() {
        let frame = answer_frame(
            &parked(json!({ "Which one?": "q1" })),
            Some(&json!({ "Which one?": "A" })),
        )
        .expect("frame");
        assert_eq!(frame["jsonrpc"], JSON_RPC_VERSION);
        assert_eq!(frame["id"], 9);
        assert_eq!(frame["result"]["answers"]["q1"]["answers"], json!(["A"]));
    }

    #[test]
    fn answer_frame_keeps_every_label_of_a_multi_select() {
        let frame = answer_frame(
            &parked(json!({ "Which ones?": "q2" })),
            Some(&json!({ "Which ones?": ["A", "B"] })),
        )
        .expect("frame");
        assert_eq!(
            frame["result"]["answers"]["q2"]["answers"],
            json!(["A", "B"])
        );
    }

    #[test]
    fn answer_frame_settles_a_dismissed_card_with_an_empty_answer() {
        let frame =
            answer_frame(&parked(json!({ "Which one?": "q1" })), None).expect("frame");
        assert_eq!(frame["result"]["answers"], json!({}));
    }

    #[test]
    fn answer_frame_rejects_an_answer_to_a_question_that_was_never_asked() {
        let error = answer_frame(
            &parked(json!({ "Which one?": "q1" })),
            Some(&json!({ "Other?": "A" })),
        )
        .expect_err("unknown question");
        assert_eq!(error.code, crate::AgentChatErrorCode::InvalidInput);
    }

    #[test]
    fn answer_frame_rejects_a_non_object_answer_map() {
        let error = answer_frame(&parked(json!({ "Which one?": "q1" })), Some(&json!(["A"])))
            .expect_err("array answers");
        assert_eq!(error.code, crate::AgentChatErrorCode::InvalidInput);
    }

    #[test]
    fn question_cards_synthesise_missing_headers_and_skip_unaskable_questions() {
        let params = json!({
            "questions": [
                { "id": "q1", "question": "  Pick one  ", "options": [{ "label": "A", "description": " first " }] },
                { "id": "q2", "question": "   " },
                { "question": "no id" }
            ]
        });
        let (cards, ids) = question_cards(&params);
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0]["header"], "Q1");
        // The card is keyed by the trimmed text the UI shows.
        assert_eq!(cards[0]["question"], "Pick one");
        assert_eq!(cards[0]["options"][0]["description"], "first");
        assert_eq!(ids["Pick one"], "q1");
    }

    #[test]
    fn permission_modes_map_to_the_codex_policy_and_sandbox() {
        assert_eq!(approval_policy(Some("auto")), "on-failure");
        assert_eq!(sandbox_for(Some("auto")), "workspace-write");
        assert_eq!(approval_policy(Some("manual")), "untrusted");
        assert_eq!(sandbox_for(Some("manual")), "read-only");
        assert_eq!(approval_policy(Some("bypass")), "never");
        assert_eq!(sandbox_for(Some("bypass")), "danger-full-access");
        // An unsupported mode behaves like the first supported one.
        assert_eq!(approval_policy(Some("plan")), "on-failure");
        assert_eq!(sandbox_for(None), "workspace-write");
    }

    fn request(session: Option<&str>, effort: Option<&str>) -> SendRequest {
        SendRequest {
            run_id: "run-1".to_string(),
            engine: "codex".to_string(),
            workspace: std::path::PathBuf::from("E:\\workspace"),
            session_id: session.map(str::to_string),
            prompt: "hello".to_string(),
            model: Some("gpt-5".to_string()),
            effort: effort.map(str::to_string),
            permission: Some("auto".to_string()),
            additional_dirs: Vec::new(),
        }
    }

    #[test]
    fn a_new_thread_starts_and_carries_the_workspace_and_policy() {
        let (method, params) = thread_request(&request(None, Some("high")));
        assert_eq!(method, "thread/start");
        assert_eq!(params["cwd"], "E:\\workspace");
        assert_eq!(params["approvalPolicy"], "on-failure");
        assert_eq!(params["sandbox"], "workspace-write");
        assert_eq!(params["model"], "gpt-5");
        assert_eq!(params["config"]["model_reasoning_effort"], "high");
    }

    #[test]
    fn an_existing_thread_resumes_without_replaying_its_turns() {
        let (method, params) = thread_request(&request(Some("thread-7"), None));
        assert_eq!(method, "thread/resume");
        assert_eq!(params["threadId"], "thread-7");
        assert_eq!(params["excludeTurns"], true);
    }

    #[test]
    fn turn_params_carry_the_prompt_and_the_requested_overrides() {
        let params = turn_params(&request(None, Some("medium")), "thread-7");
        assert_eq!(params["threadId"], "thread-7");
        assert_eq!(params["input"][0]["type"], "text");
        assert_eq!(params["input"][0]["text"], "hello");
        assert_eq!(params["model"], "gpt-5");
        assert_eq!(params["effort"], "medium");
        assert_eq!(params["approvalPolicy"], "on-failure");
        assert_eq!(params["sandbox"], "workspace-write");
    }

    #[test]
    fn a_streamed_agent_message_is_not_replayed_on_completion() {
        let mut view = TurnView::default();
        view.streamed_message = Some("item-1".to_string());
        let item = json!({ "id": "item-1", "type": "agentMessage", "text": "hello" });
        assert!(project_item(&item, true, &mut view).is_empty());
    }

    #[test]
    fn a_completed_agent_message_without_deltas_becomes_a_message_row() {
        let mut view = TurnView::default();
        let item = json!({ "id": "item-1", "type": "agentMessage", "text": "hello" });
        let events = project_item(&item, true, &mut view);
        assert_eq!(events.len(), 1);
        match &events[0] {
            EngineEvent::Message {
                role,
                text,
                patch,
                ..
            } => {
                assert_eq!(role, "assistant");
                assert_eq!(text, "hello");
                assert!(!patch);
            }
            _ => panic!("expected an assistant message"),
        }
        // The start notification of the same item projects nothing.
        assert!(project_item(&item, false, &mut view).is_empty());
    }

    #[test]
    fn command_execution_opens_a_row_and_patches_its_result() {
        let mut view = TurnView::default();
        let item = json!({
            "id": "cmd-1",
            "type": "commandExecution",
            "command": "npm test",
            "cwd": "E:\\workspace",
        });
        let events = project_item(&item, false, &mut view);
        match &events[0] {
            EngineEvent::Message {
                role, text, args, patch, ..
            } => {
                assert_eq!(role, "tool");
                assert_eq!(text, "bash");
                assert_eq!(args.as_ref().unwrap()["command"], "npm test");
                assert!(!patch);
            }
            _ => panic!("expected a tool call"),
        }

        let done = json!({ "id": "cmd-1", "type": "commandExecution", "aggregatedOutput": "ok", "exitCode": 0 });
        let events = project_item(&done, true, &mut view);
        match &events[0] {
            EngineEvent::Message {
                text, result, patch, ..
            } => {
                assert_eq!(text, "bash");
                assert!(patch);
                assert_eq!(result.as_ref().unwrap()["aggregatedOutput"], "ok");
            }
            _ => panic!("expected a tool result"),
        }
    }

    #[test]
    fn file_changes_open_one_row_per_file_and_patch_on_completion() {
        let mut view = TurnView::default();
        let item = json!({
            "id": "patch-1",
            "type": "fileChange",
            "changes": [
                { "path": "src/a.ts", "kind": "update", "diff": "@@" },
                { "path": "src/b.ts", "kind": "add", "diff": "@@" }
            ]
        });
        let events = project_item(&item, false, &mut view);
        assert_eq!(events.len(), 2);
        match &events[0] {
            EngineEvent::Message { text, path, .. } => {
                assert_eq!(text, "apply_patch");
                assert_eq!(path.as_deref(), Some("src/a.ts"));
            }
            _ => panic!("expected a file row"),
        }

        let done = json!({ "id": "patch-1", "type": "fileChange", "status": "success" });
        let events = project_item(&done, true, &mut view);
        match &events[0] {
            EngineEvent::Message {
                text, result, patch, ..
            } => {
                assert_eq!(text, "apply_patch");
                assert!(patch);
                assert_eq!(result.as_ref().unwrap()["status"], "success");
            }
            _ => panic!("expected a file result"),
        }
    }

    #[test]
    fn mcp_tool_calls_project_their_name_and_payload() {
        let mut view = TurnView::default();
        let item = json!({
            "id": "mcp-1",
            "type": "mcpToolCall",
            "server": "fs",
            "tool": "read_file",
            "arguments": { "path": "a.txt" }
        });
        let events = project_item(&item, false, &mut view);
        match &events[0] {
            EngineEvent::Message {
                text, path, args, ..
            } => {
                assert_eq!(text, "read_file");
                assert_eq!(path.as_deref(), Some("a.txt"));
                assert_eq!(args.as_ref().unwrap()["path"], "a.txt");
            }
            _ => panic!("expected an mcp tool row"),
        }
    }
}
