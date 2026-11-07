//! Codex adapter (Own transport, app-server).
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/desktop-cc-gui.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! Codex runs exclusively through `codex app-server` (decision D11): that is
//! the only transport that carries the model's question tool
//! (`item/tool/requestUserInput`), and the exec fallback was removed rather
//! than kept as a second, test-heavy path. The driver lives in
//! [`super::codex_app`].

use crate::engine::resolve;
use crate::engine::{events, BuiltCommand, Engine, SendRequest};
use crate::AgentChatError;

pub struct CodexEngine;

impl CodexEngine {
    pub fn new() -> Self {
        Self
    }
}

impl Default for CodexEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// TOML basic-string literal for a `-c key=<value>` override. The CLI parses
/// the value as TOML, so a Windows path's backslashes would otherwise read as
/// escape sequences.
fn toml_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

impl Engine for CodexEngine {
    fn id(&self) -> &'static str {
        "codex"
    }

    /// The app-server is the only supported transport; `codex exec` is gone by
    /// decision D11 because it resolves the model's questions itself.
    fn build_command(
        &self,
        _req: &SendRequest,
        _bin: &str,
    ) -> Result<BuiltCommand, AgentChatError> {
        Err(AgentChatError::unsupported(
            "Codex runs on the app-server transport only.",
        ))
    }

    fn host_command(
        &self,
        req: &SendRequest,
        bin: &str,
    ) -> Result<BuiltCommand, AgentChatError> {
        let plan = resolve::spawn_plan(bin);
        let mut command = tokio::process::Command::new(&plan.program);
        command.args(&plan.prefix);
        // Without this switch the model never asks: it emits a plain message
        // instead of a client request the UI can answer.
        command.arg("app-server");
        command.arg("--enable");
        command.arg("default_mode_request_user_input");
        if let Some(effort) = req.effort.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
            command.arg("-c");
            command.arg(format!("model_reasoning_effort={}", toml_string(effort)));
        }
        #[cfg(windows)]
        {
            // The packaged app is a GUI binary; without this every console
            // child flashes a window. Same flag as `resolve`'s spawn path.
            command.creation_flags(0x0800_0000);
        }
        Ok(BuiltCommand {
            command,
            stdin_payload: None,
            // Parked questions are answered on this pipe after the spawn.
            keep_stdin_open: true,
            preassigned_session_id: None,
        })
    }

    /// Own-transport runs never feed stdout to the line parser; the driver
    /// projects app-server notifications itself.
    fn parse_line(&self, _line: &str, _out: &mut Vec<events::EngineEvent>) {}

    fn drives_own_transport(&self) -> bool {
        true
    }

    fn supports_effort(&self) -> bool {
        true
    }

    /// No `plan`: this build has no plan-approval flow (Q7).
    fn supported_permissions(&self) -> &'static [&'static str] {
        &["auto", "manual", "bypass"]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(effort: Option<&str>) -> SendRequest {
        SendRequest {
            run_id: "run-1".to_string(),
            engine: "codex".to_string(),
            workspace: std::path::PathBuf::from("E:\\workspace"),
            session_id: None,
            prompt: "hello".to_string(),
            model: None,
            effort: effort.map(str::to_string),
            permission: None,
            additional_dirs: Vec::new(),
        }
    }

    fn args(built: &BuiltCommand) -> Vec<String> {
        built
            .command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn host_command_requests_the_app_server_and_the_question_tool() {
        let built = CodexEngine::new()
            .host_command(&request(None), "codex")
            .expect("host command");
        let args = args(&built);
        let subcommand = args
            .iter()
            .position(|arg| arg == "app-server")
            .expect("app-server subcommand");
        assert_eq!(
            &args[subcommand..subcommand + 3],
            &["app-server", "--enable", "default_mode_request_user_input"]
        );
        assert!(built.keep_stdin_open);
        assert!(built.stdin_payload.is_none());
    }

    #[test]
    fn host_command_passes_effort_as_a_quoted_toml_value() {
        let built = CodexEngine::new()
            .host_command(&request(Some("high")), "codex")
            .expect("host command");
        let args = args(&built);
        let position = args
            .iter()
            .position(|arg| arg == "-c")
            .expect("config override");
        assert_eq!(args[position + 1], "model_reasoning_effort=\"high\"");
    }

    #[test]
    fn toml_string_escapes_quotes_and_backslashes() {
        assert_eq!(toml_string("a\"b\\c"), "\"a\\\"b\\\\c\"");
        assert_eq!(toml_string("plain"), "\"plain\"");
    }

    #[test]
    fn exec_transport_is_rejected() {
        let error = CodexEngine::new()
            .build_command(&request(None), "codex")
            .err()
            .expect("exec is unsupported");
        assert_eq!(error.code, crate::AgentChatErrorCode::Unsupported);
    }

    #[test]
    fn engine_reports_its_own_transport_and_modes() {
        let engine = CodexEngine::new();
        assert!(engine.drives_own_transport());
        assert!(engine.supports_effort());
        assert_eq!(engine.supported_permissions(), &["auto", "manual", "bypass"]);
        // An unsupported request falls back to the first supported mode.
        assert_eq!(engine.resolve_permission(Some("plan")), "auto");
    }
}
