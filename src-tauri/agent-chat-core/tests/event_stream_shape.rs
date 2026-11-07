//! Wire shape of `agent:event` and the normalized events engines produce.
//!
//! The frontend folds these payloads by `kind`, so the field names and the
//! `kind` values below are a contract, not an implementation detail.

use agent_chat_core::engine::events::EngineEvent;
use agent_chat_core::engine::engine_by_id;
use agent_chat_core::models::AgentRunEvent;

fn run_event(seq: u64, kind: &str, data: serde_json::Value) -> AgentRunEvent {
    AgentRunEvent {
        run_id: "run-1".to_string(),
        session_id: Some("s-1".to_string()),
        engine: "claude".to_string(),
        seq,
        kind: kind.to_string(),
        data,
        ts: 1_700_000_000_000,
    }
}

fn parse_claude(line: &str) -> Vec<EngineEvent> {
    let engine = engine_by_id("claude").expect("claude exists");
    let mut out = Vec::new();
    engine.parse_line(line, &mut out);
    out
}

#[test]
fn a_run_event_serializes_with_camel_case_keys() {
    let event = run_event(
        7,
        "message",
        serde_json::json!({
            "role": "tool",
            "text": "Read",
            "toolCallId": "toolu_1",
            "patch": true,
        }),
    );

    let value = serde_json::to_value(&event).expect("event serializes");
    assert_eq!(value["runId"], "run-1");
    assert_eq!(value["sessionId"], "s-1");
    assert_eq!(value["engine"], "claude");
    assert_eq!(value["seq"], 7);
    assert_eq!(value["kind"], "message");
    assert_eq!(value["data"]["toolCallId"], "toolu_1");
    assert_eq!(value["ts"], 1_700_000_000_000_i64);
    assert!(value.get("run_id").is_none(), "no snake_case on the wire");
}

#[test]
fn a_missing_session_id_is_serialized_as_null() {
    let mut event = run_event(1, "delta", serde_json::Value::String("hi".to_string()));
    event.session_id = None;

    let value = serde_json::to_value(&event).expect("event serializes");
    assert_eq!(value["sessionId"], serde_json::Value::Null);
}

#[test]
fn one_ipc_payload_is_an_array_of_run_events() {
    let batch = vec![
        run_event(1, "delta", serde_json::Value::String("Hel".to_string())),
        run_event(2, "delta", serde_json::Value::String("lo".to_string())),
    ];

    let payload = serde_json::to_value(&batch).expect("batch serializes");
    let items = payload.as_array().expect("the payload is an array");
    assert_eq!(items.len(), 2);
    for item in items {
        assert!(item.get("runId").is_some());
        assert!(item.get("kind").and_then(|kind| kind.as_str()).is_some());
        assert!(item.get("seq").and_then(|seq| seq.as_u64()).is_some());
    }
}

#[test]
fn documented_kind_vocabulary_serializes_verbatim() {
    // plan §6.2: the frontend folds on exactly these values.
    let kinds = [
        "delta",
        "thinking",
        "message",
        "session",
        "usage",
        "model",
        "effort",
        "permission_denied",
        "question",
        "question_settled",
        "warn",
        "retry",
        "compaction",
        "error",
        "done",
        "turn_resumed",
    ];

    let batch: Vec<AgentRunEvent> = kinds
        .iter()
        .enumerate()
        .map(|(index, kind)| run_event(index as u64 + 1, kind, serde_json::Value::Null))
        .collect();
    let payload = serde_json::to_value(&batch).expect("batch serializes");
    let serialized: Vec<&str> = payload
        .as_array()
        .expect("array payload")
        .iter()
        .map(|item| item["kind"].as_str().expect("kind is a string"))
        .collect();

    assert_eq!(serialized, kinds);
}

#[test]
fn claude_init_announces_the_session_and_model() {
    let events = parse_claude(
        r#"{"type":"system","subtype":"init","session_id":"shape-1","model":"claude-demo"}"#,
    );
    assert_eq!(
        events,
        vec![
            EngineEvent::SessionId("shape-1".to_string()),
            EngineEvent::Model("claude-demo".to_string()),
        ]
    );
}

#[test]
fn claude_stream_events_become_text_and_thinking_deltas() {
    let text = parse_claude(
        r#"{"type":"stream_event","session_id":"shape-delta","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}"#,
    );
    assert_eq!(text, vec![EngineEvent::Delta("Hel".to_string())]);

    let thinking = parse_claude(
        r#"{"type":"stream_event","session_id":"shape-delta","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}}"#,
    );
    assert_eq!(thinking, vec![EngineEvent::Thinking("hmm".to_string())]);
}

#[test]
fn claude_tool_calls_carry_id_arguments_and_path() {
    let events = parse_claude(
        r#"{"type":"stream_event","session_id":"shape-tool","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_shape_1","name":"Read","input":{"file_path":"C:\\workspace\\demo\\README.md"}}}}"#,
    );
    assert_eq!(
        events,
        vec![EngineEvent::Message {
            role: "tool".to_string(),
            text: "Read".to_string(),
            path: Some("C:\\workspace\\demo\\README.md".to_string()),
            args: Some(serde_json::json!({ "file_path": "C:\\workspace\\demo\\README.md" })),
            result: None,
            tool_call_id: Some("toolu_shape_1".to_string()),
            patch: false,
        }]
    );
}

#[test]
fn claude_tool_results_are_patches_for_the_matching_call() {
    // The parser learns the tool name from the call, so register it first.
    parse_claude(
        r#"{"type":"stream_event","session_id":"shape-tool-result","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_shape_result","name":"Read","input":{"file_path":"C:\\workspace\\demo\\README.md"}}}}"#,
    );
    let events = parse_claude(
        r#"{"type":"user","session_id":"shape-tool-result","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_shape_result","content":"ok"}]}}"#,
    );
    assert_eq!(
        events,
        vec![EngineEvent::Message {
            role: "tool".to_string(),
            text: "Read".to_string(),
            path: None,
            args: None,
            result: Some(serde_json::Value::String("ok".to_string())),
            tool_call_id: Some("toolu_shape_result".to_string()),
            patch: true,
        }]
    );
}

#[test]
fn claude_result_settles_the_turn() {
    let done = parse_claude(
        r#"{"type":"result","session_id":"shape-done","subtype":"success","usage":{"input_tokens":3}}"#,
    );
    assert_eq!(
        done,
        vec![EngineEvent::Done {
            session_id: Some("shape-done".to_string()),
            usage: Some(serde_json::json!({ "input_tokens": 3 })),
        }]
    );

    let failed = parse_claude(
        r#"{"type":"result","session_id":"shape-error","is_error":true,"result":"boom"}"#,
    );
    assert_eq!(failed, vec![EngineEvent::Error("boom".to_string())]);
}

#[test]
fn malformed_lines_are_ignored() {
    assert!(parse_claude("not json").is_empty());
    assert!(parse_claude(r#"{"type":"unknown_kind"}"#).is_empty());
}

#[test]
fn own_transport_engines_do_not_parse_stdout() {
    for id in ["codex", "qoder"] {
        let engine = engine_by_id(id).expect("engine exists");
        let mut out = Vec::new();
        engine.parse_line(
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":"hi"}}"#,
            &mut out,
        );
        assert!(out.is_empty(), "{id} drives its own transport");
    }
}
