//! Turn state and the event dispatch loop.
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/desktop-cc-gui.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! One [`TurnState`] lives for one child process. [`TurnCore::dispatch_event`]
//! projects the adapter's [`EngineEvent`]s onto the wire event surface, and
//! [`run_child_turn`] owns the child's stdio: it registers the process,
//! writes the prompt payload, drains stderr, parses stdout and settles the
//! turn at EOF.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex as TokioMutex;

use crate::engine::events::EngineEvent;
use crate::engine::registry::{ChildEntry, ProcessRegistry};
use crate::engine::resolve;
use crate::engine::sink::EventSink;
use crate::engine::{BuiltCommand, Engine, SendRequest};
use crate::models::AgentRunEvent;

/// How long to wait for the child to exit once stdout closed.
const EXIT_WAIT_TIMEOUT: Duration = Duration::from_secs(10);
/// Diagnostics kept for the fallback error message.
const STDERR_TAIL_BYTES: usize = 4096;

/// Mutable per-run streaming state. Owned by the reader task, so it needs no
/// lock.
pub struct TurnState {
    /// Native session id, preassigned or adopted from the stream.
    pub native_session_id: Option<String>,
    pub seq: u64,
    pub saw_done: bool,
    pub saw_error: bool,
    /// Questions parked on this run and not yet settled.
    pub pending_question_ids: Vec<String>,
    exit_confirmed: bool,
}

impl TurnState {
    pub fn new(preassigned: Option<String>) -> Self {
        Self {
            native_session_id: preassigned,
            seq: 0,
            saw_done: false,
            saw_error: false,
            pending_question_ids: Vec::new(),
            exit_confirmed: false,
        }
    }

    /// Terminal state is monotonic: once the turn settled, nothing but a late
    /// session announcement may still reach the UI.
    fn accepts(&self, event: &EngineEvent) -> bool {
        !self.saw_done && !self.saw_error || matches!(event, EngineEvent::SessionId(_))
    }

    fn push(&mut self, core: &TurnCore, kind: &str, data: Value) {
        self.seq += 1;
        core.sink.push(AgentRunEvent {
            run_id: core.run_id.clone(),
            session_id: self.native_session_id.clone(),
            engine: core.engine_id.to_string(),
            seq: self.seq,
            kind: kind.to_string(),
            data,
            ts: now_ms(),
        });
    }
}

/// Event-routing core shared by the transport runners.
pub struct TurnCore {
    pub run_id: String,
    pub engine_id: &'static str,
    pub sink: Arc<EventSink>,
    pub registry: Arc<ProcessRegistry>,
}

impl TurnCore {
    /// Adopt a native session id: alias the registry entry under it and
    /// announce it, unless the stream already named the same id.
    fn adopt_session_id(&self, state: &mut TurnState, id: &str, announce: bool) {
        let id = id.trim();
        if id.is_empty() || state.native_session_id.as_deref() == Some(id) {
            return;
        }
        state.native_session_id = Some(id.to_string());
        if let Some(entry) = self.registry.get(&self.run_id) {
            self.registry.insert(id.to_string(), entry);
        }
        if announce {
            state.push(self, "session", Value::String(id.to_string()));
        }
    }

    /// Project one normalized event onto the wire surface and push it.
    pub fn dispatch_event(&self, state: &mut TurnState, event: EngineEvent) {
        if !state.accepts(&event) {
            return;
        }
        match event {
            EngineEvent::Delta(text) => state.push(self, "delta", Value::String(text)),
            EngineEvent::Thinking(text) => state.push(self, "thinking", Value::String(text)),
            EngineEvent::Message {
                role,
                text,
                path,
                args,
                result,
                tool_call_id,
                patch,
            } => {
                let mut payload = serde_json::Map::new();
                payload.insert("role".to_string(), Value::String(role));
                payload.insert("text".to_string(), Value::String(text));
                if let Some(path) = path {
                    payload.insert("path".to_string(), Value::String(path));
                }
                if let Some(args) = args {
                    payload.insert("args".to_string(), args);
                }
                if let Some(result) = result {
                    payload.insert("result".to_string(), result);
                }
                if let Some(tool_call_id) = tool_call_id {
                    payload.insert("toolCallId".to_string(), Value::String(tool_call_id));
                }
                if patch {
                    payload.insert("patch".to_string(), Value::Bool(true));
                }
                state.push(self, "message", Value::Object(payload));
            }
            EngineEvent::SessionId(id) => self.adopt_session_id(state, &id, true),
            EngineEvent::Usage(usage) => state.push(self, "usage", usage),
            EngineEvent::Warn(message) => state.push(self, "warn", Value::String(message)),
            EngineEvent::Retry {
                attempt,
                max,
                message,
            } => state.push(
                self,
                "retry",
                serde_json::json!({ "attempt": attempt, "max": max, "message": message }),
            ),
            EngineEvent::Compaction { active, reason } => state.push(
                self,
                "compaction",
                serde_json::json!({ "active": active, "reason": reason }),
            ),
            EngineEvent::PermissionDenied {
                tool,
                path,
                message,
                tool_use_id,
            } => state.push(
                self,
                "permission_denied",
                serde_json::json!({
                    "tool": tool,
                    "path": path,
                    "message": message,
                    "toolUseId": tool_use_id,
                }),
            ),
            EngineEvent::Question {
                request_id,
                tool_use_id,
                input,
            } => {
                // Park the ask: the answer command rebuilds updatedInput from
                // this exact input.
                if let Some(entry) = self.registry.get(&self.run_id) {
                    if let Ok(mut questions) = entry.questions.lock() {
                        questions.insert(request_id.clone(), input.clone());
                    }
                }
                if !state.pending_question_ids.contains(&request_id) {
                    state.pending_question_ids.push(request_id.clone());
                }
                state.push(
                    self,
                    "question",
                    serde_json::json!({
                        "requestId": request_id,
                        "toolUseId": tool_use_id,
                        "input": input,
                    }),
                );
            }
            EngineEvent::QuestionSettled { request_id } => {
                if let Some(entry) = self.registry.get(&self.run_id) {
                    if let Ok(mut questions) = entry.questions.lock() {
                        questions.remove(&request_id);
                    }
                }
                state
                    .pending_question_ids
                    .retain(|pending| pending != &request_id);
                state.push(
                    self,
                    "question_settled",
                    serde_json::json!({ "requestId": request_id }),
                );
            }
            EngineEvent::Model(model) => state.push(self, "model", Value::String(model)),
            EngineEvent::Effort(effort) => state.push(self, "effort", Value::String(effort)),
            EngineEvent::Error(message) => {
                state.saw_error = true;
                state.push(self, "error", Value::String(message));
                // The turn is settled; a CLI still running would burn tokens
                // invisibly. Kill off this task: the tree walk blocks, and
                // stalling here would also stall the stdout drain.
                let registry = Arc::clone(&self.registry);
                let run_id = self.run_id.clone();
                std::thread::spawn(move || {
                    registry.kill(&run_id);
                });
            }
            EngineEvent::Done { session_id, usage } => {
                if let Some(id) = session_id {
                    self.adopt_session_id(state, &id, false);
                }
                state.saw_done = true;
                // Closing stdin is the only way an interactive CLI exits.
                self.registry.close_stdin(&self.run_id);
                let session_id = state.native_session_id.clone();
                state.push(
                    self,
                    "done",
                    serde_json::json!({
                        "usage": usage,
                        "sessionId": session_id,
                    }),
                );
            }
        }
    }

    /// Settle a turn whose child is gone. Used by `run_child_turn` after the
    /// exit-code based settlement, and as a last resort for a run that never
    /// produced a terminal event.
    pub fn confirm_exit(&self, state: &mut TurnState) {
        if state.exit_confirmed {
            return;
        }
        state.exit_confirmed = true;
        if !state.saw_done && !state.saw_error {
            self.dispatch_event(
                state,
                EngineEvent::Done {
                    session_id: None,
                    usage: None,
                },
            );
        }
    }
}

/// Spawn one child transport run, stream its stdout until EOF and settle the
/// turn. The caller provides `killed` (shared with the registry entry) and a
/// fallback `pid` for engines whose child is only known after spawn.
pub async fn run_child_turn(
    core: TurnCore,
    engine: Box<dyn Engine>,
    req: SendRequest,
    built: BuiltCommand,
    killed: Arc<AtomicBool>,
    pid: u32,
) {
    let BuiltCommand {
        mut command,
        stdin_payload,
        keep_stdin_open,
        preassigned_session_id,
    } = built;
    command
        .current_dir(&req.workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    resolve::apply_no_window(&mut command);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let mut state = TurnState::new(preassigned_session_id);
            core.dispatch_event(
                &mut state,
                EngineEvent::Error(format!(
                    "{} could not start: {error}",
                    core.engine_id
                )),
            );
            core.confirm_exit(&mut state);
            core.sink.flush();
            // `send` reserved this run before handing it over; a failed spawn
            // must release the slot or it stays counted against the
            // concurrency cap forever.
            core.registry.remove(&core.run_id);
            return;
        }
    };
    let pid = child.id().unwrap_or(pid);
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdin = Arc::new(TokioMutex::new(child.stdin.take()));
    let child = Arc::new(TokioMutex::new(child));

    let entry = ChildEntry {
        child: Some(Arc::clone(&child)),
        pid,
        run_id: core.run_id.clone(),
        killed: Arc::clone(&killed),
        stdin: Some(Arc::clone(&stdin)),
        questions: Arc::new(Mutex::new(HashMap::new())),
    };
    core.registry.insert(core.run_id.clone(), entry.clone());
    if let Some(session_id) = preassigned_session_id.clone() {
        core.registry.insert(session_id, entry);
    }

    let stderr_buf = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = stderr {
        let buffer = Arc::clone(&stderr_buf);
        tokio::spawn(async move { drain_stderr(stderr, buffer).await });
    }

    {
        let mut guard = stdin.lock().await;
        if let Some(handle) = guard.as_mut() {
            if let Some(payload) = stdin_payload.as_deref() {
                let _ = handle.write_all(payload.as_bytes()).await;
                let _ = handle.write_all(b"\n").await;
                let _ = handle.flush().await;
            }
            if !keep_stdin_open {
                // Dropping the handle closes the pipe.
                *guard = None;
            }
        }
    }

    let mut state = TurnState::new(preassigned_session_id);
    let mut saw_any_output = false;
    if let Some(stdout) = stdout {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            saw_any_output = true;
            let mut events = Vec::new();
            engine.parse_line(trimmed, &mut events);
            for event in events {
                core.dispatch_event(&mut state, event);
            }
        }
    }

    // Unanswered questions die with the run: settle their cards before the
    // terminal event so the UI never keeps an answerable card for a dead
    // process.
    let pending = std::mem::take(&mut state.pending_question_ids);
    for request_id in pending {
        core.dispatch_event(&mut state, EngineEvent::QuestionSettled { request_id });
    }

    let status = {
        let mut guard = child.lock().await;
        match tokio::time::timeout(EXIT_WAIT_TIMEOUT, guard.wait()).await {
            Ok(Ok(status)) => Some(status),
            Ok(Err(_)) => None,
            Err(_) => {
                let _ = guard.start_kill();
                guard.wait().await.ok()
            }
        }
    };
    let failed = status.map(|status| !status.success()).unwrap_or(true);
    let stderr_tail = match stderr_buf.lock() {
        Ok(buffer) => buffer.trim().to_string(),
        Err(poisoned) => poisoned.into_inner().trim().to_string(),
    };
    let user_stopped = killed.load(Ordering::SeqCst);

    if !state.saw_done && !state.saw_error {
        if user_stopped {
            // A user-initiated stop commits whatever streamed so far.
            core.dispatch_event(
                &mut state,
                EngineEvent::Done {
                    session_id: None,
                    usage: None,
                },
            );
        } else if failed || !saw_any_output {
            let mut message = format!(
                "{} exited with status {}",
                core.engine_id,
                status
                    .map(|status| status.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            );
            if !stderr_tail.is_empty() {
                message.push_str(&format!(": {stderr_tail}"));
            }
            core.dispatch_event(&mut state, EngineEvent::Error(message));
        } else {
            // Clean EOF without an explicit result line.
            core.dispatch_event(
                &mut state,
                EngineEvent::Done {
                    session_id: None,
                    usage: None,
                },
            );
        }
    } else if failed && !state.saw_error && !stderr_tail.is_empty() {
        // Some CLIs report the failure on stderr and still emit a result
        // line; surface it as a non-terminal notice.
        core.dispatch_event(
            &mut state,
            EngineEvent::Warn(format!("engine stderr: {stderr_tail}")),
        );
    }

    core.confirm_exit(&mut state);
    core.registry.remove(&core.run_id);
    core.sink.flush();
}

/// Drain the child's stderr so a full pipe cannot block it. Only the last few
/// KiB are kept, as the fallback text of an exit-status error.
async fn drain_stderr(stderr: tokio::process::ChildStderr, buffer: Arc<Mutex<String>>) {
    let mut reader = BufReader::new(stderr);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => push_stderr_tail(&buffer, &line),
        }
    }
}

fn push_stderr_tail(buffer: &Mutex<String>, text: &str) {
    let mut guard = match buffer.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard.push_str(text);
    if guard.len() > STDERR_TAIL_BYTES {
        let mut keep = guard.len() - STDERR_TAIL_BYTES;
        while !guard.is_char_boundary(keep) {
            keep += 1;
        }
        guard.drain(..keep);
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::process::Child;

    fn core_for_test() -> (TurnCore, Arc<EventSink>, Arc<ProcessRegistry>) {
        let sink = EventSink::new_for_test();
        let registry = Arc::new(ProcessRegistry::new());
        let core = TurnCore {
            run_id: "run-1".to_string(),
            engine_id: "claude",
            sink: Arc::clone(&sink),
            registry: Arc::clone(&registry),
        };
        (core, sink, registry)
    }

    fn entry(run_id: &str, stdin: Option<Arc<TokioMutex<Option<tokio::process::ChildStdin>>>>) -> ChildEntry {
        ChildEntry {
            child: None,
            pid: 0,
            run_id: run_id.to_string(),
            killed: Arc::new(AtomicBool::new(false)),
            stdin,
            questions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn events(sink: &EventSink) -> Vec<AgentRunEvent> {
        sink.flush();
        sink.take_batches().into_iter().flatten().collect()
    }

    #[test]
    fn dispatch_projects_events_with_monotonic_seq() {
        let (core, sink, _) = core_for_test();
        let mut state = TurnState::new(None);

        core.dispatch_event(&mut state, EngineEvent::Delta("a".to_string()));
        core.dispatch_event(&mut state, EngineEvent::Thinking("hmm".to_string()));
        core.dispatch_event(&mut state, EngineEvent::Message {
            role: "tool".to_string(),
            text: "Read".to_string(),
            path: Some("a.txt".to_string()),
            args: Some(serde_json::json!({ "file_path": "a.txt" })),
            result: None,
            tool_call_id: Some("t1".to_string()),
            patch: true,
        });

        let events = events(&sink);
        assert_eq!(events.len(), 3);
        assert_eq!(events.iter().map(|event| event.seq).collect::<Vec<_>>(), [1, 2, 3]);
        assert_eq!(events[0].kind, "delta");
        assert_eq!(events[1].kind, "thinking");
        assert_eq!(events[2].kind, "message");
        assert_eq!(events[2].data["role"], "tool");
        assert_eq!(events[2].data["path"], "a.txt");
        assert_eq!(events[2].data["toolCallId"], "t1");
        assert_eq!(events[2].data["patch"], true);
    }

    #[test]
    fn session_id_aliases_the_registry_entry() {
        let (core, sink, registry) = core_for_test();
        registry.insert("run-1".to_string(), entry("run-1", None));
        let mut state = TurnState::new(None);

        core.dispatch_event(&mut state, EngineEvent::SessionId("s-1".to_string()));

        assert_eq!(state.native_session_id.as_deref(), Some("s-1"));
        assert!(registry.get("s-1").is_some());
        let events = events(&sink);
        assert_eq!(events[0].kind, "session");
        assert_eq!(events[0].session_id.as_deref(), Some("s-1"));
    }

    #[test]
    fn events_after_done_are_dropped_except_session_id() {
        let (core, sink, _) = core_for_test();
        let mut state = TurnState::new(None);

        core.dispatch_event(&mut state, EngineEvent::Delta("a".to_string()));
        core.dispatch_event(
            &mut state,
            EngineEvent::Done {
                session_id: Some("s-1".to_string()),
                usage: None,
            },
        );
        core.dispatch_event(&mut state, EngineEvent::Delta("late".to_string()));
        core.dispatch_event(&mut state, EngineEvent::Warn("late".to_string()));
        core.dispatch_event(&mut state, EngineEvent::SessionId("s-2".to_string()));

        assert!(state.saw_done);
        let events = events(&sink);
        let kinds: Vec<&str> = events.iter().map(|event| event.kind.as_str()).collect();
        assert_eq!(kinds, ["delta", "done", "session"]);
        assert_eq!(events[1].data["sessionId"], "s-1");
        assert_eq!(state.native_session_id.as_deref(), Some("s-2"));
    }

    #[test]
    fn error_settles_the_turn() {
        let (core, sink, _) = core_for_test();
        let mut state = TurnState::new(None);

        core.dispatch_event(&mut state, EngineEvent::Error("boom".to_string()));
        core.dispatch_event(&mut state, EngineEvent::Delta("late".to_string()));

        assert!(state.saw_error);
        let events = events(&sink);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "error");
        assert_eq!(events[0].data, "boom");
    }

    #[test]
    fn questions_are_parked_and_settled_on_the_entry() {
        let (core, sink, registry) = core_for_test();
        registry.insert("run-1".to_string(), entry("run-1", None));
        let mut state = TurnState::new(None);
        let input = serde_json::json!({ "questions": [{ "question": "Q?" }] });

        core.dispatch_event(
            &mut state,
            EngineEvent::Question {
                request_id: "req-1".to_string(),
                tool_use_id: Some("call-1".to_string()),
                input: input.clone(),
            },
        );

        let parked = registry.get("run-1").expect("entry");
        assert_eq!(parked.questions.lock().expect("questions").get("req-1"), Some(&input));
        assert_eq!(state.pending_question_ids, vec!["req-1".to_string()]);
        assert_eq!(events(&sink)[0].kind, "question");

        core.dispatch_event(
            &mut state,
            EngineEvent::QuestionSettled {
                request_id: "req-1".to_string(),
            },
        );
        assert!(parked.questions.lock().expect("questions").get("req-1").is_none());
        assert!(state.pending_question_ids.is_empty());
    }

    #[test]
    fn confirm_exit_settles_an_unterminated_turn() {
        let (core, sink, _) = core_for_test();
        let mut state = TurnState::new(None);

        core.confirm_exit(&mut state);

        assert!(state.saw_done);
        let events = events(&sink);
        assert_eq!(events[0].kind, "done");
    }

    #[tokio::test]
    async fn done_closes_the_interactive_stdin() {
        let (core, _, registry) = core_for_test();
        let (mut child, stdin) = interactive_child();
        let stdin = Arc::new(TokioMutex::new(Some(stdin)));
        registry.insert("run-1".to_string(), entry("run-1", Some(Arc::clone(&stdin))));
        let mut state = TurnState::new(None);

        core.dispatch_event(
            &mut state,
            EngineEvent::Done {
                session_id: None,
                usage: None,
            },
        );

        assert!(stdin.lock().await.is_none());
        let _ = child.kill().await;
    }

    fn interactive_child() -> (Child, tokio::process::ChildStdin) {
        #[cfg(windows)]
        let mut command = {
            let mut command = tokio::process::Command::new("cmd");
            command.args(["/C", "more"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = tokio::process::Command::new("sh");
            command.args(["-c", "sleep 5"]);
            command
        };
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = command.spawn().expect("spawn interactive child");
        let stdin = child.stdin.take().expect("piped stdin");
        (child, stdin)
    }
}
