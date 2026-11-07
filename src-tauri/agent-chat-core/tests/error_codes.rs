//! The error contract crossing the Tauri command boundary.
//!
//! The frontend branches on `code`, so the kebab-case spellings are frozen.

use agent_chat_core::error::{AgentChatError, AgentChatErrorCode};

#[test]
fn every_code_serializes_as_kebab_case() {
    let expected = [
        (AgentChatErrorCode::NotFound, "not-found"),
        (AgentChatErrorCode::InvalidInput, "invalid-input"),
        (AgentChatErrorCode::EngineUnavailable, "engine-unavailable"),
        (AgentChatErrorCode::NotRunning, "not-running"),
        (AgentChatErrorCode::Conflict, "conflict"),
        (AgentChatErrorCode::Unsupported, "unsupported"),
        (AgentChatErrorCode::Internal, "internal"),
        (AgentChatErrorCode::NotImplemented, "not-implemented"),
    ];
    for (code, wire) in expected {
        let json = serde_json::to_value(code).expect("code serializes");
        assert_eq!(json, serde_json::Value::String(wire.to_string()));
        let parsed: AgentChatErrorCode =
            serde_json::from_value(json).expect("code deserializes");
        assert_eq!(parsed, code);
    }
}

#[test]
fn error_payload_has_code_message_and_optional_detail() {
    let bare = AgentChatError::not_found("Session s1 was not found.");
    let json = serde_json::to_value(&bare).expect("error serializes");
    assert_eq!(json["code"], "not-found");
    assert_eq!(json["message"], "Session s1 was not found.");
    assert!(json.get("detail").is_none(), "detail is omitted when None");

    let detailed = AgentChatError::new(AgentChatErrorCode::Conflict, "Busy.")
        .with_detail("runId=run-1");
    let json = serde_json::to_value(&detailed).expect("error serializes");
    assert_eq!(json["code"], "conflict");
    assert_eq!(json["detail"], "runId=run-1");
}

#[test]
fn constructors_pick_the_documented_categories() {
    let cases = [
        (AgentChatError::invalid_input("prompt"), "invalid-input"),
        (AgentChatError::engine_unavailable("claude"), "engine-unavailable"),
        (AgentChatError::not_running("run-1"), "not-running"),
        (AgentChatError::conflict("busy"), "conflict"),
        (AgentChatError::unsupported("nope"), "unsupported"),
        (AgentChatError::internal("boom"), "internal"),
        (AgentChatError::not_implemented(), "not-implemented"),
    ];
    for (error, wire) in cases {
        let json = serde_json::to_value(&error).expect("error serializes");
        assert_eq!(json["code"], wire, "{}", error.message);
    }
}

#[test]
fn engine_unavailable_carries_the_engine_in_the_detail() {
    let error = AgentChatError::engine_unavailable("qoder");
    assert_eq!(error.code, AgentChatErrorCode::EngineUnavailable);
    assert_eq!(error.detail.as_deref(), Some("engine=qoder"));
    assert!(error.message.contains("qoder"));
}

#[test]
fn not_running_carries_the_run_id_in_the_detail() {
    let error = AgentChatError::not_running("run-42");
    assert_eq!(error.code, AgentChatErrorCode::NotRunning);
    assert_eq!(error.detail.as_deref(), Some("runId=run-42"));
}
