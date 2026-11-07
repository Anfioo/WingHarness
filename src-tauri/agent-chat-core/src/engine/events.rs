//! Normalized engine events.
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/desktop-cc-gui.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! The vocabulary is the subset frozen in plan §6.2. Adapters produce these;
//! `reader::TurnCore::dispatch_event` projects them onto the wire `kind`s.

use serde_json::Value;

/// One normalized event before it is stamped with run/session/seq.
#[derive(Clone, Debug, PartialEq)]
pub enum EngineEvent {
    /// Streaming text delta (append).
    Delta(String),
    /// Reasoning/thinking delta (append).
    Thinking(String),
    /// A complete or patched message/tool row.
    Message {
        role: String,
        text: String,
        /// Target file of a tool call, when the arguments name one.
        path: Option<String>,
        /// Tool-call arguments; `None` when the call reports no payload.
        args: Option<Value>,
        /// Tool result attached to the row identified by `tool_call_id`.
        result: Option<Value>,
        /// The engine's own id for this call.
        tool_call_id: Option<String>,
        /// `true` when this updates an existing row instead of appending one.
        patch: bool,
    },
    /// The native session id became known.
    SessionId(String),
    /// Token usage snapshot from the engine.
    Usage(Value),
    /// Terminal engine error.
    Error(String),
    /// Non-terminal engine notice.
    Warn(String),
    /// The CLI is backing off before retrying.
    Retry {
        attempt: u64,
        max: u64,
        message: String,
    },
    /// Context compaction started or finished.
    Compaction { active: bool, reason: Option<String> },
    /// A tool call was denied by the CLI's permission system.
    PermissionDenied {
        tool: Option<String>,
        path: Option<String>,
        message: String,
        tool_use_id: Option<String>,
    },
    /// The CLI asks the user to choose.
    Question {
        request_id: String,
        tool_use_id: Option<String>,
        input: Value,
    },
    /// A parked question no longer needs an answer.
    QuestionSettled { request_id: String },
    /// Actual model id reported by the engine.
    Model(String),
    /// Actual reasoning effort reported by the engine.
    Effort(String),
    /// Turn finished successfully.
    Done {
        session_id: Option<String>,
        usage: Option<Value>,
    },
}

/// Drop empty / null payloads so the UI does not render a blank args panel.
/// JSON-encoded strings (OpenAI-style `function.arguments`) are parsed first.
pub(crate) fn parse_tool_args_value(value: &Value) -> Option<Value> {
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
                Ok(parsed) => parse_tool_args_value(&parsed)
                    .or_else(|| Some(Value::String(trimmed.to_string()))),
                Err(_) => Some(Value::String(trimmed.to_string())),
            }
        }
        other => Some(other.clone()),
    }
}

/// Engines spell "no id" two ways: an absent field and an empty string. Both
/// mean unpaired, and the frontend only correlates on a non-blank id.
pub(crate) fn tool_call_identity(id: Option<&str>) -> Option<String> {
    id.map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

/// Tool-call start: name plus parsed args.
pub(crate) fn tool_call_message_with_id(
    name: impl Into<String>,
    args: Option<&Value>,
    tool_call_id: Option<&str>,
) -> EngineEvent {
    let name = name.into();
    let args = args.and_then(parse_tool_args_value);
    EngineEvent::Message {
        role: "tool".to_string(),
        text: name,
        path: args.as_ref().and_then(tool_path_arg),
        args,
        result: None,
        patch: false,
        tool_call_id: tool_call_identity(tool_call_id),
    }
}

/// Patches the matching in-flight tool row.
pub(crate) fn tool_call_patch_with_id(
    name: impl Into<String>,
    args: Option<&Value>,
    tool_call_id: Option<&str>,
) -> EngineEvent {
    match tool_call_message_with_id(name, args, tool_call_id) {
        EngineEvent::Message {
            role,
            text,
            path,
            args,
            tool_call_id,
            ..
        } => EngineEvent::Message {
            role,
            text,
            path,
            args,
            result: None,
            patch: true,
            tool_call_id,
        },
        other => other,
    }
}

/// Target path of a tool call, from the argument names the engines use.
pub(crate) fn tool_path_arg(args: &Value) -> Option<String> {
    ["path", "file_path", "filePath"]
        .iter()
        .filter_map(|key| args.get(key).and_then(Value::as_str))
        .map(str::trim)
        .find(|path| !path.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn empty_args_are_dropped() {
        assert_eq!(parse_tool_args_value(&json!(null)), None);
        assert_eq!(parse_tool_args_value(&json!({})), None);
        assert_eq!(parse_tool_args_value(&json!([])), None);
        assert_eq!(parse_tool_args_value(&json!("   ")), None);
    }

    #[test]
    fn json_encoded_strings_are_parsed() {
        let parsed = parse_tool_args_value(&json!("{\"file_path\":\"a.txt\"}"));
        assert_eq!(parsed, Some(json!({ "file_path": "a.txt" })));
    }

    #[test]
    fn tool_call_identity_rejects_blank_ids() {
        assert_eq!(tool_call_identity(None), None);
        assert_eq!(tool_call_identity(Some("  ")), None);
        assert_eq!(tool_call_identity(Some(" t1 ")), Some("t1".to_string()));
    }

    #[test]
    fn tool_messages_carry_the_path_argument() {
        let event = tool_call_message_with_id("Read", Some(&json!({"file_path": "a.txt"})), Some("t1"));
        assert_eq!(
            event,
            EngineEvent::Message {
                role: "tool".to_string(),
                text: "Read".to_string(),
                path: Some("a.txt".to_string()),
                args: Some(json!({ "file_path": "a.txt" })),
                result: None,
                tool_call_id: Some("t1".to_string()),
                patch: false,
            }
        );
    }
}
