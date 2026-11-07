//! Claude adapter (Child transport).
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/desktop-cc-gui.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! The CLI speaks NDJSON in both directions. `build_command` starts it in
//! `-p` stream-json mode with the SDK control protocol over stdio;
//! `parse_line` projects one stdout line onto [`EngineEvent`]s.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde_json::Value;

use crate::engine::events::{
    tool_call_message_with_id, tool_call_patch_with_id, tool_path_arg, EngineEvent,
};
use crate::engine::resolve;
use crate::engine::{BuiltCommand, Engine, SendRequest};
use crate::error::AgentChatError;

/// `engine/mod.rs` builds this adapter as a unit value, so the per-session
/// tool state cannot live in the struct; it is kept in a process-wide map
/// keyed by the stream's `session_id` instead.
pub struct ClaudeEngine;

impl Engine for ClaudeEngine {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn build_command(&self, req: &SendRequest, bin: &str) -> Result<BuiltCommand, AgentChatError> {
        let plan = resolve::spawn_plan(bin);
        let mut command = tokio::process::Command::new(&plan.program);
        command.args(&plan.prefix);

        command.arg("-p");
        command.arg("--input-format");
        command.arg("stream-json");
        command.arg("--output-format");
        command.arg("stream-json");
        command.arg("--verbose");
        command.arg("--include-partial-messages");
        // SDK control protocol: permission asks (including AskUserQuestion)
        // arrive as can_use_tool control requests. Without the flag the CLI
        // treats every ask as terminal.
        command.arg("--permission-prompt-tool");
        command.arg("stdio");

        match self.resolve_permission(req.permission.as_deref()) {
            "bypass" => {
                command.arg("--dangerously-skip-permissions");
            }
            mode => {
                command.arg("--permission-mode");
                command.arg(match mode {
                    "manual" => "default",
                    "plan" => "plan",
                    _ => "acceptEdits",
                });
                if mode == "auto" {
                    // acceptEdits only pre-approves edits; headless -p cannot
                    // prompt, so the read-only web tools must be pre-approved
                    // or every call is denied outright.
                    command.arg("--allowedTools");
                    command.arg("WebSearch");
                    command.arg("WebFetch");
                }
            }
        }

        if let Some(model) = req.model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
            command.arg("--model");
            command.arg(model);
        }
        if let Some(effort) = req.effort.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
            command.arg("--effort");
            command.arg(effort);
            command.env("CLAUDE_CODE_EFFORT_LEVEL", effort);
        }

        let workspace = req.workspace.to_string_lossy();
        let mut seen = HashSet::new();
        for dir in &req.additional_dirs {
            let dir = dir.trim();
            if dir.is_empty() || dir == workspace.as_ref() || !seen.insert(dir.to_string()) {
                continue;
            }
            command.arg("--add-dir");
            command.arg(dir);
        }

        if let Some(session_id) = req.session_id.as_deref().map(str::trim).filter(|id| !id.is_empty())
        {
            command.arg("--resume");
            command.arg(session_id);
        }

        let payload = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": req.prompt }],
            },
            "parent_tool_use_id": null,
        })
        .to_string();

        Ok(BuiltCommand {
            command,
            stdin_payload: Some(payload),
            keep_stdin_open: true,
            preassigned_session_id: None,
        })
    }

    fn parse_line(&self, line: &str, out: &mut Vec<EngineEvent>) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return;
        };
        match value.get("type").and_then(Value::as_str).unwrap_or("") {
            "system" => parse_system(&value, out),
            "stream_event" => {
                let mut states = lock_states();
                let state = states.entry(session_key(&value)).or_default();
                parse_stream_event(state, &value, out);
            }
            "assistant" => parse_assistant(&value, out),
            "user" => parse_user(&value, out),
            "result" => parse_result(&value, out),
            "control_request" => parse_control_request(&value, out),
            "control_cancel_request" => {
                if let Some(request_id) = value
                    .get("request_id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                {
                    out.push(EngineEvent::QuestionSettled {
                        request_id: request_id.to_string(),
                    });
                }
            }
            _ => {}
        }
    }

    fn supports_effort(&self) -> bool {
        true
    }

    fn supported_permissions(&self) -> &'static [&'static str] {
        &["auto", "manual", "plan", "bypass"]
    }
}

/// One tool call whose input JSON is still streaming.
struct PendingTool {
    name: String,
    id: Option<String>,
    json: String,
}

#[derive(Default)]
struct SessionParseState {
    pending: HashMap<u64, PendingTool>,
    tool_names: HashMap<String, String>,
    tool_paths: HashMap<String, String>,
    seen_tool_ids: HashSet<String>,
    /// A text delta arrived for the message being assembled, so the following
    /// assistant snapshot must not repeat the text.
    saw_text_delta: bool,
}

fn states() -> &'static Mutex<HashMap<String, SessionParseState>> {
    static STATES: OnceLock<Mutex<HashMap<String, SessionParseState>>> = OnceLock::new();
    STATES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_states() -> MutexGuard<'static, HashMap<String, SessionParseState>> {
    match states().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn session_key(value: &Value) -> String {
    value
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn parse_system(value: &Value, out: &mut Vec<EngineEvent>) {
    push_session_id(value, "session_id", out);
    let subtype = value.get("subtype").and_then(Value::as_str).unwrap_or("");
    match subtype {
        "init" => {
            if let Some(model) = non_empty_str(value.get("model")) {
                out.push(EngineEvent::Model(model));
            }
        }
        "api_retry" => out.push(EngineEvent::Retry {
            attempt: value.get("attempt").and_then(Value::as_u64).unwrap_or(0),
            max: value
                .get("max_retries")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            message: format_api_retry(value),
        }),
        "compact_boundary" => {
            let reason = value
                .get("compactMetadata")
                .and_then(|metadata| metadata.get("trigger"))
                .and_then(Value::as_str)
                .map(str::to_string);
            out.push(EngineEvent::Compaction {
                active: false,
                reason,
            });
        }
        _ => {}
    }
}

fn parse_stream_event(state: &mut SessionParseState, value: &Value, out: &mut Vec<EngineEvent>) {
    let Some(event) = value.get("event") else {
        return;
    };
    match event.get("type").and_then(Value::as_str).unwrap_or("") {
        "message_start" => {
            // Block indexes restart every message.
            state.pending.clear();
            state.saw_text_delta = false;
        }
        "content_block_delta" => parse_content_block_delta(state, event, out),
        "content_block_start" => parse_content_block_start(state, event, out),
        "content_block_stop" => parse_content_block_stop(state, event, out),
        _ => {}
    }
}

fn parse_content_block_delta(
    state: &mut SessionParseState,
    event: &Value,
    out: &mut Vec<EngineEvent>,
) {
    let Some(delta) = event.get("delta") else {
        return;
    };
    match delta.get("type").and_then(Value::as_str).unwrap_or("") {
        "text_delta" => {
            if let Some(text) = delta.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                state.saw_text_delta = true;
                out.push(EngineEvent::Delta(text.to_string()));
            }
        }
        "thinking_delta" => {
            if let Some(text) = delta
                .get("thinking")
                .and_then(Value::as_str)
                .filter(|t| !t.is_empty())
            {
                out.push(EngineEvent::Thinking(text.to_string()));
            }
        }
        "input_json_delta" => {
            let Some(partial) = delta
                .get("partial_json")
                .and_then(Value::as_str)
                .filter(|t| !t.is_empty())
            else {
                return;
            };
            let Some(index) = event.get("index").and_then(Value::as_u64) else {
                return;
            };
            if let Some(tool) = state.pending.get_mut(&index) {
                tool.json.push_str(partial);
            }
        }
        _ => {}
    }
}

fn parse_content_block_start(
    state: &mut SessionParseState,
    event: &Value,
    out: &mut Vec<EngineEvent>,
) {
    let Some(block) = event.get("content_block") else {
        return;
    };
    if block.get("type").and_then(Value::as_str) != Some("tool_use") {
        return;
    }
    let name = block
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("tool")
        .to_string();
    let input = block.get("input");
    let tool_call_id = block.get("id").and_then(Value::as_str).map(str::to_string);

    if let Some(id) = tool_call_id.as_deref() {
        state.tool_names.insert(id.to_string(), name.clone());
        state.seen_tool_ids.insert(id.to_string());
        if let Some(path) = input.and_then(tool_path_arg) {
            state.tool_paths.insert(id.to_string(), path);
        }
    }
    if let Some(index) = event.get("index").and_then(Value::as_u64) {
        state.pending.insert(
            index,
            PendingTool {
                name: name.clone(),
                id: tool_call_id.clone(),
                json: String::new(),
            },
        );
    }
    out.push(tool_call_message_with_id(
        name,
        input,
        tool_call_id.as_deref(),
    ));
}

fn parse_content_block_stop(
    state: &mut SessionParseState,
    event: &Value,
    out: &mut Vec<EngineEvent>,
) {
    let Some(index) = event.get("index").and_then(Value::as_u64) else {
        return;
    };
    let Some(tool) = state.pending.remove(&index) else {
        return;
    };
    let trimmed = tool.json.trim();
    if trimmed.is_empty() {
        return;
    }
    let Ok(args) = serde_json::from_str::<Value>(trimmed) else {
        return;
    };
    if let (Some(id), Some(path)) = (tool.id.as_deref(), tool_path_arg(&args)) {
        state.tool_paths.insert(id.to_string(), path);
    }
    out.push(tool_call_patch_with_id(
        tool.name,
        Some(&args),
        tool.id.as_deref(),
    ));
}

fn parse_assistant(value: &Value, out: &mut Vec<EngineEvent>) {
    push_session_id(value, "session_id", out);
    let message = value.get("message");
    if let Some(model) = non_empty_str(
        message
            .and_then(|message| message.get("model"))
            .or_else(|| value.get("model")),
    ) {
        out.push(EngineEvent::Model(model));
    }
    if let Some(effort) = non_empty_str(
        message
            .and_then(|message| message.get("thinking_effort").or_else(|| message.get("effort")))
            .or_else(|| value.get("thinking_effort"))
            .or_else(|| value.get("effort")),
    ) {
        out.push(EngineEvent::Effort(effort));
    }

    let mut states = lock_states();
    let state = states.entry(session_key(value)).or_default();
    let blocks = message
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array);
    let Some(blocks) = blocks else {
        return;
    };

    // Without partial messages the snapshot is the only source of the text.
    if !state.saw_text_delta {
        let text = blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("");
        if !text.is_empty() {
            out.push(EngineEvent::Message {
                role: "assistant".to_string(),
                text,
                path: None,
                args: None,
                result: None,
                tool_call_id: None,
                patch: false,
            });
        }
    }
    state.saw_text_delta = false;

    for block in blocks {
        if block.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        let id = block.get("id").and_then(Value::as_str).map(str::to_string);
        if id
            .as_deref()
            .map(|id| state.seen_tool_ids.contains(id))
            .unwrap_or(false)
        {
            continue;
        }
        let name = block
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string();
        let input = block.get("input");
        if let Some(id) = id.as_deref() {
            state.tool_names.insert(id.to_string(), name.clone());
            state.seen_tool_ids.insert(id.to_string());
            if let Some(path) = input.and_then(tool_path_arg) {
                state.tool_paths.insert(id.to_string(), path);
            }
        }
        out.push(tool_call_message_with_id(name, input, id.as_deref()));
    }
}

fn parse_user(value: &Value, out: &mut Vec<EngineEvent>) {
    let Some(content) = value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
    else {
        return;
    };

    for block in content {
        if block.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        let tool_call_id = block.get("tool_use_id").and_then(Value::as_str);
        let text = tool_result_block_text(block);
        if block
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            // Headless permission denials arrive as is_error text; surface
            // them so the UI can offer a grant instead of losing the reason.
            if looks_like_permission_denial(&text) {
                let (tool, path) = lookup_tool(tool_call_id);
                out.push(EngineEvent::PermissionDenied {
                    tool,
                    path: path.or_else(|| extract_absolute_path(&text)),
                    message: text.trim().chars().take(500).collect(),
                    tool_use_id: tool_call_id.map(str::to_string),
                });
            }
            continue;
        }
        if looks_like_permission_denial(&text) {
            continue;
        }
        let result = value
            .get("toolUseResult")
            .or_else(|| block.get("content"))
            .cloned();
        let name = lookup_tool(tool_call_id).0.unwrap_or_default();
        out.push(EngineEvent::Message {
            role: "tool".to_string(),
            text: name,
            path: None,
            args: None,
            result,
            tool_call_id: tool_call_id
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_string),
            patch: true,
        });
    }
}

fn parse_result(value: &Value, out: &mut Vec<EngineEvent>) {
    if let Some(denials) = value.get("permission_denials").and_then(Value::as_array) {
        for denial in denials {
            let tool = non_empty_str(denial.get("tool_name"));
            let path = denial.get("tool_input").and_then(tool_path_arg);
            let tool_use_id = non_empty_str(denial.get("tool_use_id"));
            if tool.is_some() || path.is_some() {
                out.push(EngineEvent::PermissionDenied {
                    tool,
                    path,
                    message: String::new(),
                    tool_use_id,
                });
            }
        }
    }

    let session_id = non_empty_str(value.get("session_id"));
    let usage = value.get("usage").cloned();
    let is_error = value
        .get("is_error")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let subtype = value.get("subtype").and_then(Value::as_str).unwrap_or("");
    if is_error || subtype.starts_with("error") {
        let message = value
            .get("result")
            .and_then(Value::as_str)
            .unwrap_or("claude turn failed")
            .to_string();
        out.push(EngineEvent::Error(message));
    } else {
        out.push(EngineEvent::Done { session_id, usage });
    }

    lock_states().remove(&session_key(value));
}

fn parse_control_request(value: &Value, out: &mut Vec<EngineEvent>) {
    let request = value.get("request");
    let subtype = request
        .and_then(|request| request.get("subtype"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let Some(request_id) = value
        .get("request_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
    else {
        return;
    };
    if subtype != "can_use_tool" {
        return;
    }

    let tool_name = request
        .and_then(|request| request.get("tool_name"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let tool_use_id = request
        .and_then(|request| request.get("tool_use_id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let input = request
        .and_then(|request| request.get("input"))
        .cloned()
        .unwrap_or(Value::Null);

    if tool_name == "AskUserQuestion" {
        out.push(EngineEvent::Question {
            request_id: request_id.to_string(),
            tool_use_id,
            input,
        });
    } else {
        // No approval UI and no way to answer a non-question ask from the
        // frozen event surface; report it so the turn's denial is visible.
        out.push(EngineEvent::PermissionDenied {
            tool: Some(tool_name).filter(|name| !name.is_empty()),
            path: tool_path_arg(&input),
            message: String::new(),
            tool_use_id,
        });
    }
}

/// (tool name, structured path) recorded for a tool call.
fn lookup_tool(tool_call_id: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(id) = tool_call_id else {
        return (None, None);
    };
    let states = lock_states();
    let Some(state) = states.values().find(|state| state.tool_names.contains_key(id)) else {
        return (None, None);
    };
    (
        state.tool_names.get(id).cloned(),
        state.tool_paths.get(id).cloned(),
    )
}

fn push_session_id(value: &Value, key: &str, out: &mut Vec<EngineEvent>) {
    if let Some(id) = non_empty_str(value.get(key)) {
        out.push(EngineEvent::SessionId(id));
    }
}

fn non_empty_str(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// Phrases the CLI uses when a tool call is denied by the permission system.
const DENIAL_PHRASES: &[&str] = &[
    "requested permissions",
    "haven't granted it yet",
    "have not granted it yet",
    "requires approval",
    "requires permission",
    "permission denied",
    "blocked for security",
    "blocked. for security",
    "allowed working directories",
    "may only write to files",
    "outside the allowed",
    "outside workspace",
];

fn looks_like_permission_denial(message: &str) -> bool {
    let normalized = message.trim().to_ascii_lowercase();
    !normalized.is_empty() && DENIAL_PHRASES.iter().any(|phrase| normalized.contains(phrase))
}

/// First absolute-path-looking token in free text.
fn extract_absolute_path(text: &str) -> Option<String> {
    for token in text.split_whitespace() {
        let cleaned = token.trim_matches(|character: char| {
            matches!(
                character,
                '"' | '\'' | '`' | ',' | ';' | ')' | '(' | '[' | ']' | '{' | '}' | '.'
            )
        });
        let bytes = cleaned.as_bytes();
        if cleaned.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'\\' || bytes[2] == b'/')
        {
            return Some(cleaned.to_string());
        }
        if cleaned.starts_with('/') && cleaned.len() > 1 {
            return Some(cleaned.to_string());
        }
    }
    None
}

/// Text payload of a tool_result block: plain string or joined text parts.
fn tool_result_block_text(block: &Value) -> String {
    match block.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Human-readable line for a `system/api_retry` event.
fn format_api_retry(value: &Value) -> String {
    let attempt = value.get("attempt").and_then(Value::as_u64).unwrap_or(0);
    let max = value
        .get("max_retries")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let delay_ms = value
        .get("retry_delay_ms")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let detail = value
        .get("error")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|error| !error.is_empty() && *error != "unknown");
    let mut message = match value.get("error_status").and_then(Value::as_u64) {
        Some(code) => format!("API error (HTTP {code})"),
        None => match detail {
            Some(detail) => format!("API error: {detail}"),
            None => "API error".to_string(),
        },
    };
    message.push_str(&format!(
        "; retrying ({attempt}/{max}) in {:.1}s",
        delay_ms as f64 / 1000.0
    ));
    message
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::registry::ProcessRegistry;
    use crate::engine::reader::{run_child_turn, TurnCore};
    use crate::engine::sink::EventSink;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    fn parse(session: &str, line: Value) -> Vec<EngineEvent> {
        let line = line.to_string();
        let line = if session.is_empty() {
            line
        } else {
            let mut value: Value = serde_json::from_str(&line).expect("json");
            value["session_id"] = Value::String(session.to_string());
            value.to_string()
        };
        let mut out = Vec::new();
        ClaudeEngine.parse_line(&line, &mut out);
        out
    }

    fn kinds(events: &[EngineEvent]) -> Vec<&'static str> {
        events
            .iter()
            .map(|event| match event {
                EngineEvent::Delta(_) => "delta",
                EngineEvent::Thinking(_) => "thinking",
                EngineEvent::Message { .. } => "message",
                EngineEvent::SessionId(_) => "session",
                EngineEvent::Usage(_) => "usage",
                EngineEvent::Error(_) => "error",
                EngineEvent::Warn(_) => "warn",
                EngineEvent::Retry { .. } => "retry",
                EngineEvent::Compaction { .. } => "compaction",
                EngineEvent::PermissionDenied { .. } => "permission_denied",
                EngineEvent::Question { .. } => "question",
                EngineEvent::QuestionSettled { .. } => "question_settled",
                EngineEvent::Model(_) => "model",
                EngineEvent::Effort(_) => "effort",
                EngineEvent::Done { .. } => "done",
            })
            .collect()
    }

    #[test]
    fn system_init_reports_session_and_model() {
        let events = parse(
            "init-1",
            serde_json::json!({
                "type": "system",
                "subtype": "init",
                "session_id": "init-1",
                "model": "claude-opus-4",
            }),
        );
        assert_eq!(kinds(&events), ["session", "model"]);
    }

    #[test]
    fn stream_events_project_text_thinking_and_tools() {
        let start = parse(
            "stream-1",
            serde_json::json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {
                        "type": "tool_use",
                        "id": "call-1",
                        "name": "Read",
                        "input": {}
                    }
                }
            }),
        );
        assert_eq!(kinds(&start), ["message"]);
        match &start[0] {
            EngineEvent::Message { role, text, patch, tool_call_id, .. } => {
                assert_eq!(role, "tool");
                assert_eq!(text, "Read");
                assert!(!patch);
                assert_eq!(tool_call_id.as_deref(), Some("call-1"));
            }
            other => panic!("unexpected event: {other:?}"),
        }

        let delta = parse(
            "stream-1",
            serde_json::json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": { "type": "input_json_delta", "partial_json": "{\"file_path\":\"a.txt\"}" }
                }
            }),
        );
        assert!(delta.is_empty());

        let stop = parse(
            "stream-1",
            serde_json::json!({
                "type": "stream_event",
                "event": { "type": "content_block_stop", "index": 0 }
            }),
        );
        assert_eq!(kinds(&stop), ["message"]);
        match &stop[0] {
            EngineEvent::Message { patch, path, args, tool_call_id, .. } => {
                assert!(patch);
                assert_eq!(path.as_deref(), Some("a.txt"));
                assert_eq!(args.as_ref().and_then(|args| args.get("file_path")).and_then(Value::as_str), Some("a.txt"));
                assert_eq!(tool_call_id.as_deref(), Some("call-1"));
            }
            other => panic!("unexpected event: {other:?}"),
        }

        let text = parse(
            "stream-2",
            serde_json::json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": { "type": "text_delta", "text": "hello" }
                }
            }),
        );
        assert_eq!(kinds(&text), ["delta"]);

        let thinking = parse(
            "stream-2",
            serde_json::json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": { "type": "thinking_delta", "thinking": "hmm" }
                }
            }),
        );
        assert_eq!(kinds(&thinking), ["thinking"]);
    }

    #[test]
    fn assistant_reports_model_effort_and_unseen_tools() {
        let events = parse(
            "assistant-1",
            serde_json::json!({
                "type": "assistant",
                "message": {
                    "model": "claude-opus-4",
                    "thinking_effort": "high",
                    "content": [
                        { "type": "text", "text": "done" },
                        { "type": "tool_use", "id": "call-a", "name": "Bash", "input": { "command": "ls" } }
                    ]
                }
            }),
        );
        let kinds = kinds(&events);
        assert!(kinds.contains(&"model"));
        assert!(kinds.contains(&"effort"));
        assert!(kinds.contains(&"message"));
        assert!(events.iter().any(|event| matches!(
            event,
            EngineEvent::Message { role, text, .. } if role == "assistant" && text == "done"
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            EngineEvent::Message { role, text, patch, .. } if role == "tool" && text == "Bash" && !patch
        )));
    }

    #[test]
    fn user_tool_result_pairs_by_tool_call_id() {
        parse(
            "user-1",
            serde_json::json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": { "type": "tool_use", "id": "call-u", "name": "Read", "input": { "file_path": "b.txt" } }
                }
            }),
        );
        let events = parse(
            "user-1",
            serde_json::json!({
                "type": "user",
                "message": {
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "call-u",
                        "content": "file body"
                    }]
                }
            }),
        );
        assert_eq!(kinds(&events), ["message"]);
        match &events[0] {
            EngineEvent::Message { role, text, result, tool_call_id, .. } => {
                assert_eq!(role, "tool");
                assert_eq!(text, "Read");
                assert_eq!(result.as_ref().and_then(Value::as_str), Some("file body"));
                assert_eq!(tool_call_id.as_deref(), Some("call-u"));
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn permission_denials_are_recognized() {
        let denied = parse(
            "deny-1",
            serde_json::json!({
                "type": "user",
                "message": {
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "call-d",
                        "is_error": true,
                        "content": "File access is blocked. You haven't granted it yet: /secret/a.txt"
                    }]
                }
            }),
        );
        assert_eq!(kinds(&denied), ["permission_denied"]);
        match &denied[0] {
            EngineEvent::PermissionDenied { path, tool_use_id, .. } => {
                assert_eq!(path.as_deref(), Some("/secret/a.txt"));
                assert_eq!(tool_use_id.as_deref(), Some("call-d"));
            }
            other => panic!("unexpected event: {other:?}"),
        }

        let structured = parse(
            "deny-2",
            serde_json::json!({
                "type": "result",
                "session_id": "deny-2",
                "is_error": false,
                "permission_denials": [{
                    "tool_name": "Edit",
                    "tool_input": { "file_path": "C:/outside/x.txt" },
                    "tool_use_id": "call-e"
                }]
            }),
        );
        assert_eq!(kinds(&structured), ["permission_denied", "done"]);
        match &structured[0] {
            EngineEvent::PermissionDenied { tool, path, .. } => {
                assert_eq!(tool.as_deref(), Some("Edit"));
                assert_eq!(path.as_deref(), Some("C:/outside/x.txt"));
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn result_settles_the_turn() {
        let done = parse(
            "result-1",
            serde_json::json!({
                "type": "result",
                "subtype": "success",
                "session_id": "result-1",
                "usage": { "input_tokens": 10, "output_tokens": 2 }
            }),
        );
        assert_eq!(kinds(&done), ["done"]);
        match &done[0] {
            EngineEvent::Done { session_id, usage } => {
                assert_eq!(session_id.as_deref(), Some("result-1"));
                assert_eq!(usage.as_ref().and_then(|usage| usage.get("input_tokens")).and_then(Value::as_u64), Some(10));
            }
            other => panic!("unexpected event: {other:?}"),
        }

        let failed = parse(
            "result-2",
            serde_json::json!({
                "type": "result",
                "subtype": "error_max_turns",
                "is_error": true,
                "result": "too many turns"
            }),
        );
        assert_eq!(failed, vec![EngineEvent::Error("too many turns".to_string())]);
    }

    #[test]
    fn control_requests_project_questions_and_settles() {
        let question = parse(
            "control-1",
            serde_json::json!({
                "type": "control_request",
                "request_id": "req-1",
                "request": {
                    "subtype": "can_use_tool",
                    "tool_name": "AskUserQuestion",
                    "tool_use_id": "call-q",
                    "input": { "questions": [{ "question": "Q?" }] }
                }
            }),
        );
        assert_eq!(kinds(&question), ["question"]);
        match &question[0] {
            EngineEvent::Question { request_id, tool_use_id, input } => {
                assert_eq!(request_id, "req-1");
                assert_eq!(tool_use_id.as_deref(), Some("call-q"));
                assert!(input.get("questions").is_some());
            }
            other => panic!("unexpected event: {other:?}"),
        }

        let other = parse(
            "control-2",
            serde_json::json!({
                "type": "control_request",
                "request_id": "req-2",
                "request": {
                    "subtype": "can_use_tool",
                    "tool_name": "Bash",
                    "tool_use_id": "call-b",
                    "input": { "command": "ls" }
                }
            }),
        );
        assert_eq!(kinds(&other), ["permission_denied"]);

        let settled = parse(
            "",
            serde_json::json!({ "type": "control_cancel_request", "request_id": "req-1" }),
        );
        assert_eq!(settled, vec![EngineEvent::QuestionSettled { request_id: "req-1".to_string() }]);
    }

    #[test]
    fn retry_and_compaction_are_non_terminal() {
        let retry = parse(
            "",
            serde_json::json!({
                "type": "system",
                "subtype": "api_retry",
                "attempt": 2,
                "max_retries": 10,
                "retry_delay_ms": 1500
            }),
        );
        assert_eq!(kinds(&retry), ["retry"]);
        match &retry[0] {
            EngineEvent::Retry { attempt, max, message } => {
                assert_eq!((*attempt, *max), (2, 10));
                assert!(message.contains("2/10"));
            }
            other => panic!("unexpected event: {other:?}"),
        }

        let compact = parse(
            "",
            serde_json::json!({
                "type": "system",
                "subtype": "compact_boundary",
                "compactMetadata": { "trigger": "auto" }
            }),
        );
        assert_eq!(kinds(&compact), ["compaction"]);
        match &compact[0] {
            EngineEvent::Compaction { active, reason } => {
                assert!(!active);
                assert_eq!(reason.as_deref(), Some("auto"));
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn build_command_sets_the_streaming_flags() {
        let engine = ClaudeEngine;
        let req = SendRequest {
            run_id: "run".to_string(),
            engine: "claude".to_string(),
            workspace: std::path::PathBuf::from("/work"),
            session_id: Some("s-1".to_string()),
            prompt: "hi".to_string(),
            model: Some("opus".to_string()),
            effort: Some("high".to_string()),
            permission: Some("manual".to_string()),
            additional_dirs: vec![
                "/work".to_string(),
                "/extra".to_string(),
                "/extra".to_string(),
                "  ".to_string(),
            ],
        };
        let built = engine
            .build_command(&req, if cfg!(windows) { "claude.exe" } else { "claude" })
            .expect("build");
        let args: Vec<String> = built
            .command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        for flag in [
            "-p",
            "--input-format",
            "--output-format",
            "--verbose",
            "--include-partial-messages",
            "--permission-prompt-tool",
        ] {
            assert!(args.iter().any(|arg| arg == flag), "missing {flag}: {args:?}");
        }
        assert_eq!(args.iter().filter(|arg| *arg == "stream-json").count(), 2);
        assert!(args.windows(2).any(|pair| pair == ["--permission-mode", "default"]));
        assert!(args.windows(2).any(|pair| pair == ["--model", "opus"]));
        assert!(args.windows(2).any(|pair| pair == ["--effort", "high"]));
        assert!(args.windows(2).any(|pair| pair == ["--resume", "s-1"]));
        assert_eq!(args.iter().filter(|arg| *arg == "--add-dir").count(), 1);
        assert!(args.windows(2).any(|pair| pair == ["--add-dir", "/extra"]));

        let payload: Value = serde_json::from_str(built.stdin_payload.as_deref().expect("payload"))
            .expect("payload json");
        assert_eq!(payload["type"], "user");
        assert_eq!(payload["message"]["role"], "user");
        assert_eq!(payload["message"]["content"][0]["type"], "text");
        assert_eq!(payload["message"]["content"][0]["text"], "hi");
        assert_eq!(payload["parent_tool_use_id"], Value::Null);
        assert!(built.keep_stdin_open);
    }

    #[test]
    fn permission_modes_map_to_cli_values() {
        let engine = ClaudeEngine;
        let base = |permission: &str| SendRequest {
            run_id: "run".to_string(),
            engine: "claude".to_string(),
            workspace: std::path::PathBuf::from("/work"),
            session_id: None,
            prompt: "hi".to_string(),
            model: None,
            effort: None,
            permission: Some(permission.to_string()),
            additional_dirs: Vec::new(),
        };
        let args_for = |permission: &str| {
            let built = engine
                .build_command(&base(permission), if cfg!(windows) { "claude.exe" } else { "claude" })
                .expect("build");
            built
                .command
                .as_std()
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };

        assert!(args_for("plan")
            .windows(2)
            .any(|pair| pair == ["--permission-mode", "plan"]));
        assert!(args_for("bypass")
            .iter()
            .any(|arg| arg == "--dangerously-skip-permissions"));
        let auto = args_for("auto");
        assert!(auto.windows(2).any(|pair| pair == ["--permission-mode", "acceptEdits"]));
        assert!(auto.windows(3).any(|pair| pair == ["--allowedTools", "WebSearch", "WebFetch"]));
    }

    #[tokio::test]
    #[ignore = "requires an installed and logged-in claude CLI"]
    async fn claude_runs_one_turn() {
        let bin = resolve::find_cli_binary("claude").expect("claude CLI not found on PATH");
        let engine = ClaudeEngine;
        let req = SendRequest {
            run_id: "claude-smoke".to_string(),
            engine: "claude".to_string(),
            workspace: std::env::current_dir().expect("cwd"),
            session_id: None,
            prompt: "Reply with the single word: pong".to_string(),
            model: None,
            effort: None,
            permission: Some("manual".to_string()),
            additional_dirs: Vec::new(),
        };
        let built = engine
            .build_command(&req, &bin.to_string_lossy())
            .expect("build command");
        let sink = EventSink::new_for_test();
        let registry = Arc::new(ProcessRegistry::new());
        let core = TurnCore {
            run_id: req.run_id.clone(),
            engine_id: "claude",
            sink: Arc::clone(&sink),
            registry,
        };

        run_child_turn(
            core,
            Box::new(engine),
            req,
            built,
            Arc::new(AtomicBool::new(false)),
            0,
        )
        .await;

        let events: Vec<_> = sink.take_batches().into_iter().flatten().collect();
        assert!(
            events.iter().any(|event| event.kind == "done"),
            "no done event: {events:?}"
        );
        assert!(
            events
                .iter()
                .any(|event| event.kind == "delta" || event.kind == "message"),
            "no assistant output: {events:?}"
        );
    }
}
