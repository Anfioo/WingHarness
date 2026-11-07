//! JSONL line extraction for Claude and Codex transcripts.
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/ccgui-next.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! One native line can carry several timeline rows (text, thinking, tool calls,
//! tool results), so extraction returns rows and `fold_rows` turns them into
//! `AgentMessage`s: tool results pair by id, usage folds onto the assistant turn
//! it belongs to, and `seq` numbers only the visible rows.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use serde_json::{json, Value};

use super::scanner::{Summary, SummaryCache};
use crate::error::AgentChatError;
use crate::models::AgentMessage;

/// Even a pathological transcript is summarized from its first 64 MiB or
/// 200k lines; sessions above that keep working, just with a bounded count.
const MAX_SUMMARY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SUMMARY_LINES: usize = 200_000;

const USAGE_ROLE: &str = "__usage__";
const TOOL_RESULT_ROLE: &str = "__tool_result__";

/// One extracted row before folding.
#[derive(Debug, Default)]
pub(crate) struct Row {
    pub role: String,
    pub text: String,
    pub ts: Option<String>,
    pub path: Option<String>,
    pub args: Option<Value>,
    pub result: Option<Value>,
    pub tool_call_id: Option<String>,
    pub model: Option<String>,
    pub usage: Option<Value>,
}

impl Row {
    fn new(role: &str, text: impl Into<String>) -> Self {
        Self {
            role: role.to_string(),
            text: text.into(),
            ..Self::default()
        }
    }
}

pub(crate) fn extract_line(engine: &str, value: &Value) -> Vec<Row> {
    match engine {
        "claude" => extract_claude_line(value),
        "codex" => extract_codex_line(value),
        _ => Vec::new(),
    }
}

// ==================== Claude ====================

fn extract_claude_line(value: &Value) -> Vec<Row> {
    let line_type = string_field(value, "type");
    let ts = optional_string(value.get("timestamp"));

    if line_type == "system" {
        if string_field(value, "subtype") == "compact_boundary" {
            let post_tokens = value
                .get("compactMetadata")
                .and_then(|meta| meta.get("postTokens").or_else(|| meta.get("post_tokens")))
                .and_then(Value::as_i64);
            if let Some(tokens) = post_tokens {
                let mut row = Row::new(USAGE_ROLE, "");
                row.ts = ts;
                row.usage = Some(json!({
                    "input_tokens": tokens,
                    "total_tokens": tokens,
                }));
                return vec![row];
            }
        }
        return Vec::new();
    }
    if line_type != "user" && line_type != "assistant" {
        return Vec::new();
    }
    // Slash-command expansions and other CLI-internal turns are logged with
    // `isMeta`; Claude Code itself never renders them in the transcript.
    if value
        .get("isMeta")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Vec::new();
    }
    let Some(message) = value.get("message") else {
        return Vec::new();
    };
    let role = {
        let role = string_field(message, "role");
        if role == "user" || role == "assistant" {
            role
        } else {
            line_type
        }
    };
    let usage = message.get("usage").cloned();
    let model = optional_string(message.get("model"));

    let mut out = Vec::new();
    match message.get("content") {
        Some(Value::Array(blocks)) => {
            // Blocks are walked in order so thinking and tool calls land where
            // they actually happened relative to the surrounding text.
            let mut text = String::new();
            for block in blocks {
                match string_field(block, "type") {
                    "text" => {
                        if let Some(part) = block.get("text").and_then(Value::as_str) {
                            text.push_str(part);
                        }
                    }
                    "thinking" => {
                        flush_text(&mut out, &mut text, role, &ts);
                        let thinking = block
                            .get("thinking")
                            .and_then(Value::as_str)
                            .or_else(|| block.get("text").and_then(Value::as_str))
                            .unwrap_or_default();
                        if !thinking.trim().is_empty() {
                            let mut row = Row::new("thinking", thinking);
                            row.ts = ts.clone();
                            out.push(row);
                        }
                    }
                    "tool_use" => {
                        flush_text(&mut out, &mut text, role, &ts);
                        let name = {
                            let name = string_field(block, "name");
                            if name.is_empty() {
                                "tool"
                            } else {
                                name
                            }
                        };
                        let args = parse_tool_args(block.get("input"));
                        let mut row = Row::new("tool", name);
                        row.ts = ts.clone();
                        row.path = args.as_ref().and_then(tool_path);
                        row.args = args;
                        row.tool_call_id = optional_string(block.get("id"));
                        out.push(row);
                    }
                    "tool_result" => {
                        flush_text(&mut out, &mut text, role, &ts);
                        let mut row = Row::new(TOOL_RESULT_ROLE, "");
                        row.ts = ts.clone();
                        row.tool_call_id = optional_string(
                            block.get("tool_use_id").or_else(|| block.get("toolUseId")),
                        );
                        row.result = block.get("content").cloned();
                        out.push(row);
                    }
                    _ => {}
                }
            }
            if !text.trim().is_empty() {
                let mut row = Row::new(role, text);
                row.ts = ts.clone();
                out.push(row);
            }
        }
        other => {
            let text = super::content_text(other);
            if !text.trim().is_empty() {
                let mut row = Row::new(role, text);
                row.ts = ts.clone();
                out.push(row);
            }
        }
    }

    // Usage and model describe the assistant turn, and ride its last text row.
    if role == "assistant" {
        if let Some(row) = out.iter_mut().rev().find(|row| row.role == "assistant") {
            row.usage = usage;
            row.model = model;
        }
    }
    out
}

fn flush_text(out: &mut Vec<Row>, text: &mut String, role: &str, ts: &Option<String>) {
    if text.trim().is_empty() {
        text.clear();
        return;
    }
    let mut row = Row::new(role, std::mem::take(text));
    row.ts = ts.clone();
    out.push(row);
}

// ==================== Codex ====================

fn extract_codex_line(value: &Value) -> Vec<Row> {
    let ts = optional_string(value.get("timestamp"));
    let Some(payload) = value.get("payload") else {
        return Vec::new();
    };
    match string_field(value, "type") {
        "response_item" => extract_codex_item(payload, &ts),
        "event_msg" => {
            if string_field(payload, "type") == "token_count" {
                if let Some(usage) = codex_token_usage(payload.get("info")) {
                    let mut row = Row::new(USAGE_ROLE, "");
                    row.ts = ts;
                    row.usage = Some(usage);
                    return vec![row];
                }
            }
            Vec::new()
        }
        _ => Vec::new(),
    }
}

fn extract_codex_item(payload: &Value, ts: &Option<String>) -> Vec<Row> {
    match string_field(payload, "type") {
        "reasoning" => {
            let text = match payload.get("summary") {
                Some(Value::Array(parts)) => parts
                    .iter()
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n"),
                _ => String::new(),
            };
            if text.trim().is_empty() {
                Vec::new()
            } else {
                let mut row = Row::new("thinking", text);
                row.ts = ts.clone();
                vec![row]
            }
        }
        "message" => {
            let role = string_field(payload, "role");
            if role != "user" && role != "assistant" {
                return Vec::new();
            }
            let text = match payload.get("content") {
                Some(Value::Array(parts)) => parts
                    .iter()
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join(""),
                other => super::content_text(other),
            };
            let mut row = Row::new(role, text);
            row.ts = ts.clone();
            row.model = optional_string(payload.get("model"));
            vec![row]
        }
        "function_call" | "custom_tool_call" => {
            let name = {
                let name = string_field(payload, "name");
                if name.is_empty() {
                    "tool"
                } else {
                    name
                }
            };
            let args = parse_tool_args(payload.get("arguments").or_else(|| payload.get("input")));
            let mut row = Row::new("tool", name);
            row.ts = ts.clone();
            row.path = args.as_ref().and_then(tool_path);
            row.args = args;
            row.tool_call_id = codex_call_id(payload);
            vec![row]
        }
        "local_shell_call" => {
            let args = payload
                .get("action")
                .cloned()
                .or_else(|| payload.get("command").cloned());
            let mut row = Row::new("tool", "shell");
            row.ts = ts.clone();
            row.path = args.as_ref().and_then(tool_path);
            row.args = args;
            row.tool_call_id = codex_call_id(payload);
            vec![row]
        }
        "function_call_output" | "custom_tool_call_output" | "local_shell_call_output" => {
            let mut row = Row::new(TOOL_RESULT_ROLE, "");
            row.ts = ts.clone();
            row.tool_call_id = codex_call_id(payload);
            row.result = payload
                .get("output")
                .or_else(|| payload.get("result"))
                .cloned();
            vec![row]
        }
        _ => Vec::new(),
    }
}

/// `last_token_usage` is this request; `total_token_usage` is session-billed
/// cumulative and must not fill the context bar.
fn codex_token_usage(info: Option<&Value>) -> Option<Value> {
    let info = info?;
    let mut usage = info
        .get("last_token_usage")
        .or_else(|| info.get("total_token_usage"))?
        .clone();
    if let Some(window) = info.get("model_context_window") {
        if let Some(object) = usage.as_object_mut() {
            object.insert("model_context_window".to_string(), window.clone());
        }
    }
    Some(usage)
}

// ==================== Fold ====================

pub(crate) fn fold_rows(rows: Vec<Row>) -> Vec<AgentMessage> {
    let mut messages = Vec::<AgentMessage>::new();
    // Tool call id -> index in `messages`. Results arrive in completion order,
    // so parallel calls of one tool need the id, not "latest unanswered row".
    let mut call_rows: HashMap<String, usize> = HashMap::new();
    let mut seq = 0i64;

    for row in rows {
        match row.role.as_str() {
            USAGE_ROLE => {
                if let Some(usage) = row.usage {
                    fold_usage(&mut messages, usage);
                }
                continue;
            }
            TOOL_RESULT_ROLE => {
                if let Some(result) = row.result {
                    let index = match row.tool_call_id.as_deref() {
                        Some(id) => call_rows
                            .get(id)
                            .copied()
                            .filter(|index| messages[*index].result.is_none()),
                        None => messages.iter().rposition(|message| {
                            message.role == "tool" && message.result.is_none()
                        }),
                    };
                    if let Some(index) = index {
                        messages[index].result = Some(result);
                    }
                }
                continue;
            }
            _ => {}
        }

        // A user turn with no text carries only injected context or an image
        // placeholder; it is not a visible message.
        if row.role == "user" && row.text.trim().is_empty() {
            continue;
        }

        seq += 1;
        let is_tool = row.role == "tool";
        let call_id = row.tool_call_id.clone();
        messages.push(AgentMessage {
            seq,
            role: row.role,
            text: row.text,
            ts: row.ts,
            path: row.path,
            args: row.args,
            result: None,
            tool_call_id: row.tool_call_id,
            model: row.model,
            usage: row.usage,
        });
        if is_tool {
            if let Some(id) = call_id {
                call_rows.insert(id, messages.len() - 1);
            }
        }
    }
    messages
}

fn fold_usage(messages: &mut [AgentMessage], mut usage: Value) {
    let Some(last) = messages
        .iter_mut()
        .rev()
        .find(|message| message.role == "assistant")
    else {
        return;
    };
    // A later token_count can repeat the context window; keep the earlier one
    // when the new snapshot omits it.
    if let (Some(previous), Some(object)) = (last.usage.as_ref(), usage.as_object_mut()) {
        if let Some(window) = previous.get("model_context_window") {
            object
                .entry("model_context_window")
                .or_insert_with(|| window.clone());
        }
    }
    last.usage = Some(usage);
}

// ==================== Summary ====================

/// One streaming pass over a transcript. Bad lines are skipped one by one; only
/// I/O failures fail the whole file, and the caller drops it from the list.
pub(crate) fn summarize(
    path: &Path,
    engine: &str,
    cache: &SummaryCache,
) -> Result<Summary, AgentChatError> {
    let metadata = std::fs::metadata(path).map_err(|error| {
        AgentChatError::internal(format!("Failed to stat session file: {error}"))
    })?;
    let size = metadata.len() as i64;
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);

    let key = (path.to_path_buf(), size, mtime_ms);
    if let Some(hit) = cache.get(&key) {
        return Ok(hit);
    }

    let file = File::open(path).map_err(|error| {
        AgentChatError::internal(format!("Failed to open session file: {error}"))
    })?;
    let mut reader = BufReader::new(file.take(MAX_SUMMARY_BYTES));
    let mut accumulator = SummaryAcc::default();
    let mut buffer = Vec::new();
    let mut lines = 0usize;

    loop {
        buffer.clear();
        match reader.read_until(b'\n', &mut buffer) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) => {
                return Err(AgentChatError::internal(format!(
                    "Failed to read session file: {error}"
                )))
            }
        }
        lines += 1;
        if lines > MAX_SUMMARY_LINES {
            eprintln!(
                "agent-chat: session summary truncated at {MAX_SUMMARY_LINES} lines: {}",
                path.display()
            );
            break;
        }
        let Ok(text) = std::str::from_utf8(&buffer) else {
            continue;
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(text) else {
            continue;
        };
        for row in extract_line(engine, &value) {
            accumulator.accept(row);
        }
    }

    let summary = accumulator.finish(mtime_ms);
    cache.insert(key, summary.clone());
    Ok(summary)
}

#[derive(Default)]
struct SummaryAcc {
    count: i64,
    first_ts: Option<String>,
    last_ts: Option<String>,
    title: Option<String>,
    first_user_text: Option<String>,
    last_assistant_text: Option<String>,
}

impl SummaryAcc {
    fn accept(&mut self, row: Row) {
        if row.role == USAGE_ROLE || row.role == TOOL_RESULT_ROLE {
            return;
        }
        if row.text.trim().is_empty() {
            return;
        }
        self.count += 1;
        if self.first_ts.is_none() {
            self.first_ts = row.ts.clone();
        }
        if row.ts.is_some() {
            self.last_ts = row.ts;
        }
        match row.role.as_str() {
            "user" => {
                if self.title.is_none() {
                    let body = super::clean_user_turn(&row.text);
                    if !body.trim().is_empty() {
                        self.title = Some(super::truncate_chars(&body, 80));
                    }
                }
                if self.first_user_text.is_none() {
                    self.first_user_text = Some(row.text);
                }
            }
            "assistant" => self.last_assistant_text = Some(row.text),
            _ => {}
        }
    }

    fn finish(self, mtime_ms: i64) -> Summary {
        let title = self
            .title
            .or_else(|| {
                self.first_user_text
                    .map(|text| super::truncate_chars(&text, 80))
            })
            .unwrap_or_default();
        let preview = self
            .last_assistant_text
            .map(|text| super::truncate_chars(&text, 120))
            .unwrap_or_default();
        Summary {
            title,
            preview,
            created_at: self
                .first_ts
                .as_deref()
                .and_then(super::parse_ts_ms_str)
                .or(Some(mtime_ms)),
            updated_at: self
                .last_ts
                .as_deref()
                .and_then(super::parse_ts_ms_str)
                .or(Some(mtime_ms)),
            message_count: self.count,
        }
    }
}

// ==================== Helpers ====================

fn string_field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn codex_call_id(payload: &Value) -> Option<String> {
    optional_string(payload.get("call_id").or_else(|| payload.get("id")))
}

/// Tool arguments are stored as objects by some engines and as JSON-encoded
/// strings by others; keep the original string when it does not parse.
fn parse_tool_args(value: Option<&Value>) -> Option<Value> {
    match value? {
        Value::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(serde_json::from_str(trimmed).unwrap_or_else(|_| Value::String(raw.clone())))
            }
        }
        other => Some(other.clone()),
    }
}

fn tool_path(args: &Value) -> Option<String> {
    for key in ["file_path", "path", "notebook_path"] {
        if let Some(path) = args.get(key).and_then(Value::as_str) {
            if !path.is_empty() {
                return Some(path.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_lines(engine: &str, lines: &[&str]) -> Vec<AgentMessage> {
        let mut rows = Vec::new();
        for line in lines {
            let value: Value = serde_json::from_str(line).expect("fixture line parses");
            rows.extend(extract_line(engine, &value));
        }
        fold_rows(rows)
    }

    #[test]
    fn claude_rows_keep_text_thinking_tools_and_pair_results() {
        let messages = parse_lines(
            "claude",
            &[
                r#"{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hello"}}"#,
                r#"{"type":"user","timestamp":"2026-01-01T00:00:01Z","isMeta":true,"message":{"role":"user","content":"meta"}}"#,
                r#"{"type":"assistant","timestamp":"2026-01-01T00:00:02Z","message":{"role":"assistant","model":"claude-x","usage":{"input_tokens":10},"content":[{"type":"thinking","thinking":"plan"},{"type":"text","text":"reading"},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/a"}},{"type":"tool_use","id":"t2","name":"Read","input":{"path":"/b"}}]}}"#,
                r#"{"type":"user","timestamp":"2026-01-01T00:00:03Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"second"},{"type":"tool_result","tool_use_id":"t1","content":"first"}]}}"#,
                r#"{"type":"system","subtype":"compact_boundary","timestamp":"2026-01-01T00:00:04Z","compactMetadata":{"postTokens":123}}"#,
            ],
        );

        let roles: Vec<&str> = messages
            .iter()
            .map(|message| message.role.as_str())
            .collect();
        assert_eq!(roles, ["user", "thinking", "assistant", "tool", "tool"]);
        assert_eq!(messages[0].text, "hello");
        assert_eq!(messages[1].text, "plan");
        assert_eq!(messages[2].text, "reading");
        assert_eq!(messages[2].model.as_deref(), Some("claude-x"));
        // The compact boundary folds onto the last assistant row.
        assert_eq!(messages[2].usage.as_ref().unwrap()["total_tokens"], 123);
        // Results pair by id even though they arrive in reverse order.
        assert_eq!(messages[3].tool_call_id.as_deref(), Some("t1"));
        assert_eq!(messages[3].result.as_ref().unwrap(), "first");
        assert_eq!(messages[3].path.as_deref(), Some("/a"));
        assert_eq!(messages[4].tool_call_id.as_deref(), Some("t2"));
        assert_eq!(messages[4].result.as_ref().unwrap(), "second");
        assert_eq!(messages[4].path.as_deref(), Some("/b"));
        assert_eq!(
            messages
                .iter()
                .map(|message| message.seq)
                .collect::<Vec<_>>(),
            [1, 2, 3, 4, 5]
        );
    }

    #[test]
    fn codex_rows_project_reasoning_messages_tools_and_usage() {
        let messages = parse_lines(
            "codex",
            &[
                r#"{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"s1","cwd":"C:\\ws"}}"#,
                r#"{"timestamp":"2026-01-01T00:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}"#,
                r#"{"timestamp":"2026-01-01T00:00:02Z","type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"thinking"}]}}"#,
                r#"{"timestamp":"2026-01-01T00:00:03Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":\"ls\"}","call_id":"c1"}}"#,
                r#"{"timestamp":"2026-01-01T00:00:04Z","type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"out"}}"#,
                r#"{"timestamp":"2026-01-01T00:00:05Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}"#,
                r#"{"timestamp":"2026-01-01T00:00:06Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":5},"model_context_window":1000}}}"#,
            ],
        );

        let roles: Vec<&str> = messages
            .iter()
            .map(|message| message.role.as_str())
            .collect();
        assert_eq!(roles, ["user", "thinking", "tool", "assistant"]);
        assert_eq!(messages[0].text, "hello");
        assert_eq!(messages[1].text, "thinking");
        assert_eq!(messages[2].text, "shell");
        assert_eq!(messages[2].result.as_ref().unwrap(), "out");
        assert_eq!(messages[2].args.as_ref().unwrap()["command"], "ls");
        assert_eq!(messages[3].text, "done");
        let usage = messages[3]
            .usage
            .as_ref()
            .expect("usage folds onto assistant");
        assert_eq!(usage["input_tokens"], 5);
        assert_eq!(usage["model_context_window"], 1000);
    }

    #[test]
    fn codex_skips_empty_user_lines_and_meta_like_items() {
        let messages = parse_lines(
            "codex",
            &[
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[]}}"#,
                r#"{"type":"response_item","payload":{"type":"message","role":"system","content":[{"type":"input_text","text":"x"}]}}"#,
                r#"{"type":"turn_context","payload":{"cwd":"C:\\ws"}}"#,
            ],
        );
        assert!(messages.is_empty());
    }

    #[test]
    fn bad_json_lines_do_not_abort_extraction() {
        let mut rows = Vec::new();
        for line in [
            "{not json",
            r#"{"type":"user","message":{"role":"user","content":"ok"}}"#,
        ] {
            if let Ok(value) = serde_json::from_str::<Value>(line) {
                rows.extend(extract_line("claude", &value));
            }
        }
        let messages = fold_rows(rows);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text, "ok");
    }
}
