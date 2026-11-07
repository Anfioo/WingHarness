//! The engine registry the picker and `agent_send` rely on.

use std::path::PathBuf;

use agent_chat_core::engine::{engine_by_id, engine_infos, SendRequest};

fn request(engine: &str) -> SendRequest {
    SendRequest {
        run_id: "run-1".to_string(),
        engine: engine.to_string(),
        workspace: PathBuf::from("C:\\workspace\\demo"),
        session_id: None,
        prompt: "hello".to_string(),
        model: None,
        effort: None,
        permission: None,
        additional_dirs: Vec::new(),
    }
}

#[test]
fn factory_resolves_exactly_the_three_supported_engines() {
    assert_eq!(engine_by_id("claude").expect("claude exists").id(), "claude");
    assert_eq!(engine_by_id("codex").expect("codex exists").id(), "codex");
    assert_eq!(engine_by_id("qoder").expect("qoder exists").id(), "qoder");
    assert!(engine_by_id("").is_none());
    assert!(engine_by_id("gemini").is_none());
    assert!(engine_by_id(" Claude ").is_none(), "ids are matched verbatim");
}

#[test]
fn transports_and_permission_modes_match_the_engine_contract() {
    let claude = engine_by_id("claude").expect("claude exists");
    assert!(!claude.drives_own_transport());
    assert!(claude.supports_effort());
    assert_eq!(
        claude.supported_permissions(),
        &["auto", "manual", "plan", "bypass"]
    );

    let codex = engine_by_id("codex").expect("codex exists");
    assert!(codex.drives_own_transport());
    assert!(codex.supports_effort());
    assert_eq!(codex.supported_permissions(), &["auto", "manual", "bypass"]);

    let qoder = engine_by_id("qoder").expect("qoder exists");
    assert!(qoder.drives_own_transport());
    assert!(qoder.supports_effort());
    assert_eq!(qoder.supported_permissions(), &["bypass"]);
}

#[test]
fn unsupported_permission_requests_fall_back_to_the_first_supported_mode() {
    let claude = engine_by_id("claude").expect("claude exists");
    assert_eq!(claude.resolve_permission(Some("plan")), "plan");
    assert_eq!(claude.resolve_permission(None), "auto");
    assert_eq!(claude.resolve_permission(Some("unknown")), "auto");

    let codex = engine_by_id("codex").expect("codex exists");
    assert_eq!(codex.resolve_permission(Some("bypass")), "bypass");
    assert_eq!(
        codex.resolve_permission(Some("plan")),
        "auto",
        "codex has no plan-approval flow"
    );

    let qoder = engine_by_id("qoder").expect("qoder exists");
    assert_eq!(qoder.resolve_permission(Some("manual")), "bypass");
}

#[test]
fn child_engines_reject_the_host_command_entry_point() {
    let claude = engine_by_id("claude").expect("claude exists");
    let error = match claude.host_command(&request("claude"), "claude") {
        Ok(_) => panic!("claude is a child transport and builds no host command"),
        Err(error) => error,
    };
    assert_eq!(error.code, agent_chat_core::AgentChatErrorCode::Unsupported);
}

#[test]
fn engine_infos_returns_the_picker_rows_in_a_stable_order() {
    let infos = engine_infos();
    let ids: Vec<&str> = infos.iter().map(|info| info.id.as_str()).collect();
    assert_eq!(ids, ["claude", "codex", "qoder"]);

    let claude = &infos[0];
    assert_eq!(claude.label, "Claude Code");
    assert_eq!(claude.transport, "child");
    assert_eq!(claude.permissions, ["auto", "manual", "plan", "bypass"]);
    assert_eq!(claude.available, claude.bin.is_some());

    let codex = &infos[1];
    assert_eq!(codex.label, "Codex");
    assert_eq!(codex.transport, "own");
    assert!(codex.supports_effort);

    let qoder = &infos[2];
    assert_eq!(qoder.label, "Qoder");
    assert_eq!(qoder.transport, "own");
    assert_eq!(qoder.permissions, ["bypass"]);

    assert!(
        infos.iter().all(|info| info.models.is_empty()),
        "no engine reports a static model list yet"
    );
}
