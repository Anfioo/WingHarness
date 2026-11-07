//! Claude adapter (Child transport).
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/ccgui-next.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! A0 stub: B1 fills `build_command` (stream-json flags, `--add-dir`) and
//! `parse_line` (system/init, stream_event, assistant, tool_result, result,
//! control_request).

use crate::engine::{events, BuiltCommand, Engine, SendRequest};

pub struct ClaudeEngine;

impl Engine for ClaudeEngine {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn build_command(
        &self,
        _req: &SendRequest,
        _bin: &str,
    ) -> Result<BuiltCommand, crate::error::AgentChatError> {
        Err(crate::error::AgentChatError::not_implemented())
    }

    fn parse_line(&self, _line: &str, _out: &mut Vec<events::EngineEvent>) {}

    fn supports_effort(&self) -> bool {
        true
    }

    fn supported_permissions(&self) -> &'static [&'static str] {
        &["auto", "manual", "plan", "bypass"]
    }
}
